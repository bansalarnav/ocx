import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Host, hostLayer } from "../packages/server/src/host"
import { PluginStore } from "../packages/server/src/plugin-manager/store"
import { makeInstanceConfigStore } from "../packages/server/src/instance-config"
import { WorkspaceManager } from "../packages/server/src/remote/manager"
import { workspaceHandler, workspaceExecutionGuard } from "../packages/server/src/remote/http"
import { exportSessionFamily, relocateSessions, type SessionBundle } from "../packages/protocol/src/session-transfer"
import { captureCheckpoint, pushCheckpoint, restoreCheckpoint } from "../packages/client/src/checkpoint"
import type { Workspace } from "../packages/protocol/src/workspaces"

const exec = promisify(execFile)
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
async function git(directory: string, ...args: string[]) {
  return (await exec("git", args, { cwd: directory, env: gitEnvironment })).stdout.trim()
}

/** This runs the production HTTP handlers, OpenCode graph, Git checkpoint code,
 * and sandbox programs. Only the cloud transports are replaced with local Git
 * repositories and real child processes. No model or provider account is used. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ocx-workflow-"))
  const source = join(root, "source")
  await mkdir(source)
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.name", "Integration test")
  await git(source, "config", "user.email", "test@example.invalid")
  await writeFile(join(source, "hello.txt"), "base\n")
  await writeFile(join(source, ".gitignore"), ".env\n")
  await git(source, "add", ".")
  await git(source, "commit", "-m", "initial")
  const database = new Database(":memory:")
  const values = new Map<string, unknown>()
  const storage = {
    sql: { exec(query: string, ...params: any[]) {
      const statement = database.query(query)
      const rows = statement.values(...params) ?? []
      const names = statement.columnNames ?? []
      return { columnNames: names, raw: () => rows.values(), toArray: () => rows.map(row => Object.fromEntries(names.map((name, index) => [name, row[index]]))) }
    } },
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined },
    async put<T>(key: string, value: T) {
      const size = value instanceof Uint8Array ? value.byteLength : new TextEncoder().encode(JSON.stringify(value)).byteLength
      if (size > 128 * 1024) throw new Error("Durable Object value exceeds 128 KiB")
      values.set(key, structuredClone(value))
    },
    async list<T>(options: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => [key, structuredClone(value) as T])) },
    async transaction<T>(body: (transaction: any) => Promise<T>) {
      const before = structuredClone(values)
      database.exec("BEGIN")
      try { const result = await body({ ...storage, rollback() { throw new Error("rolled back") } }); database.exec("COMMIT"); return result }
      catch (error) { database.exec("ROLLBACK"); values.clear(); for (const [key, value] of before) values.set(key, value); throw error }
    },
    transactionSync<T>(body: () => T) { return database.transaction(body)() },
  }
  let runtime: ManagedRuntime.ManagedRuntime<Host, never>
  let loseImportReply = false
  const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await runtime.runPromise(Host.use(host => host.fetch(new Request("http://opencode.internal" + path, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }))))
    const text = await response.text()
    if (!response.ok) throw new Error(`OpenCode ${response.status}: ${text}`)
    const result = text ? JSON.parse(text) : undefined
    if (loseImportReply && path === "/api/experimental/session/import") {
      loseImportReply = false
      throw new Error("Simulated lost successful import reply")
    }
    return result
  }
  let created = 0
  let fault: ((command: string, stdin?: string) => "before" | "after" | undefined) | undefined
  let captureGate: { started: () => void; released: Promise<void> } | undefined
  const repositories = new Map<string, string>()
  const manager = new WorkspaceManager(storage, {}, api, {
    repositories: {
      async create(name) {
        const url = join(root, name + ".git")
        await git(root, "init", "--bare", url)
        repositories.set(name, url)
        return { url, token: "" }
      },
      async access(name) {
        const url = repositories.get(name)
        if (!url) throw new Error("Repository not found")
        return { url, token: "" }
      },
    },
    compute: {
      async create() { return `local-${++created}` },
      async run(_id, command, options) {
        const fail = fault?.(command, options?.stdin)
        if (fail) fault = undefined
        if (fail === "before") return { stdout: "", stderr: "Injected command failure", exitCode: 1 }
        if (captureGate && command.includes('"action":"capture"')) {
          const gate = captureGate
          captureGate = undefined
          gate.started()
          await gate.released
        }
        const execution = exec("/bin/sh", ["-c", command], {
          env: { ...gitEnvironment, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${source}.insteadOf`, GIT_CONFIG_VALUE_0: "https://source.invalid/repo.git" }, signal: options?.signal, timeout: (options?.timeoutSeconds ?? 120) * 1000,
          maxBuffer: 16 * 1024 * 1024,
        })
        execution.child.stdin?.end(options?.stdin)
        const result = await execution.then(result => ({ ...result, exitCode: 0 }), error => {
          if (options?.signal?.aborted) throw error
          return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, exitCode: typeof error.code === "number" ? error.code : 1 }
        })
        return fail === "after" ? { ...result, stderr: "Injected lost command response", exitCode: 1 } : result
      },
      async pause() {}, async url(_id, port) { return `https://preview.invalid/${port}` },
    },
  })
  runtime = ManagedRuntime.make(hostLayer(storage as never, {}, makeInstanceConfigStore(storage as never), () => Effect.void, undefined, manager).pipe(
    Layer.provide(Layer.succeed(PluginStore, { list: Effect.succeed([]), get: () => Effect.succeed(undefined), put: () => Effect.void, remove: () => Effect.void })),
  ))
  const routes = workspaceHandler(manager)
  const request = async (path: string, method = "GET", body?: unknown) => {
    const binary = body instanceof Uint8Array
    const request = new Request("http://opencode.internal" + path, { method, headers: { "content-type": binary ? "application/octet-stream" : "application/json" }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) })
    const response = await routes(request) ?? await workspaceExecutionGuard(manager, request) ?? await runtime.runPromise(Host.use(host => host.fetch(request)))
    const text = await response.text()
    let value: any
    try { value = text ? JSON.parse(text) : undefined } catch { value = text }
    return { status: response.status, value, text }
  }
  const ok = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, method, body)
    expect(response.status, response.text).toBeGreaterThanOrEqual(200)
    expect(response.status, response.text).toBeLessThan(300)
    return response.value
  }
  const allocate = async (id: string, newBranch?: string) => {
    const result = await ok("/api/ocx/workspaces", "POST", { id, source: "https://source.invalid/repo.git", newBranch })
    const workspace = result.workspace as Workspace
    // Preserve the actual workflow while placing physical checkout directories
    // under a unique test-owned root rather than writing to /workspaces.
    workspace.root = join(root, id, "repo")
    await storage.put(`ocx/workspaces/${id}`, workspace)
    return workspace
  }
  return {
    root, source, manager, storage, api, request, ok, allocate, computeStarts: () => created,
    loseNextImportReply() { loseImportReply = true },
    failCommandOnce(predicate: (command: string, stdin?: string) => boolean, when: "before" | "after" = "before") {
      fault = (command, stdin) => predicate(command, stdin) ? when : undefined
    },
    delayNextCapture() {
      let started!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      captureGate = { started, released }
      return { entered, release }
    },
    close: async () => { await runtime.dispose(); database.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test("a project has independent cloud checkouts with multiple conversations and allocates compute only on first conversation", async () => {
  const f = await fixture()
  try {
    const a = await f.allocate("checkout-a", "agent/implementation"), b = await f.allocate("checkout-b")
    expect(f.computeStarts()).toBe(0)
    const before = await f.ok("/api/ocx/projects")
    expect(before.projects).toHaveLength(1)
    expect(before.projects[0].checkouts.map((c: any) => c.id).sort()).toEqual([a.id, b.id])
    expect((await f.ok(`/api/ocx/workspaces/${a.id}/sessions`)).sessions).toEqual([])
    expect(f.computeStarts()).toBe(0)
    const first = (await f.ok(`/api/ocx/workspaces/${a.id}/sessions`, "POST", { title: "Implementation" })).session
    const second = (await f.ok(`/api/ocx/workspaces/${a.id}/sessions`, "POST", { title: "Debugging" })).session
    expect(f.computeStarts()).toBe(1)
    expect(await git(a.root, "branch", "--show-current")).toBe("agent/implementation")
    expect(first.id).not.toBe(second.id)
    expect(first.location.directory).toBe(second.location.directory)
    await writeFile(join(a.root, "shared.txt"), "Visible in both conversations\n")
    expect((await f.ok(`/api/ocx/workspaces/${a.id}/sessions`)).sessions.map((s: any) => s.id).sort()).toEqual([first.id, second.id].sort())
    await f.ok(`/api/ocx/workspaces/${b.id}/sessions`, "POST", { title: "Independent task" })
    expect(f.computeStarts()).toBe(2)
    await expect(readFile(join(b.root, "shared.txt"))).rejects.toThrow()
    const after = await f.ok("/api/ocx/projects")
    expect(after.projects[0].checkouts.find((c: any) => c.id === a.id).sessionCount).toBe(2)
    const native = (await f.api("/api/session", "POST", { title: "Created in native OpenCode", location: { directory: a.root } })).data
    const handoff = (await f.ok("/api/ocx/handoffs", "POST", { id: "checkout-family", workspaceID: a.id, sessionID: first.id })).handoff
    expect(handoff.session.sessions.map((s: any) => s.info.id).sort()).toEqual([first.id, second.id, native.id].sort())
    expect((await f.request(`/api/session/${second.id}/prompt`, "POST", { text: "must stay frozen" })).status).toBe(409)
    expect((await f.request(`/api/ocx/workspaces/${a.id}/sessions`, "POST", {})).status).toBe(409)
    await f.ok(`/api/ocx/handoffs/${handoff.id}/abort`, "POST", {})
  } finally { await f.close() }
}, 30000)

test("remote workspaces create native OpenCode threads and isolate file operations", async () => {
  const f = await fixture()
  try {
    const workspace = await f.allocate("remote-create")
    const prepared = await f.ok(`/api/ocx/workspaces/${workspace.id}/provision`, "POST", { newBranch: "agent/task" })
    expect(prepared.workspace.state).toBe("ready")
    expect(await git(workspace.root, "branch", "--show-current")).toBe("agent/task")
    const session = (await f.ok(`/api/ocx/workspaces/${workspace.id}/sessions`, "POST", { title: "Remote task" })).session
    expect(session.location.directory).toBe(workspace.root)
    expect(session.title).toBe("Remote task")
    const query = "?location[directory]=" + encodeURIComponent(workspace.root)
    expect((await f.ok("/api/fs/list" + query)).data).toContainEqual({ path: "hello.txt", type: "file" })
    expect((await f.request("/api/fs/read/hello.txt" + query)).value).toBe("base\n")
    const beforeWrite = (await f.manager.get(workspace.id)).checkpointRef
    await f.ok("/api/experimental/fs/write" + query + "&path=browser.txt", "POST", Buffer.from("written through native API\n"))
    expect(await readFile(join(workspace.root, "browser.txt"), "utf8")).toBe("written through native API\n")
    expect((await f.manager.get(workspace.id)).checkpointRef).not.toBe(beforeWrite)
    expect((await f.ok("/api/vcs" + query)).data.branch.current).toBe("agent/task")
    const other = await f.allocate("other-workspace")
    await f.ok(`/api/ocx/workspaces/${other.id}/provision`, "POST", {})
    await expect(f.manager.tool(workspace.id, "read", { path: other.root + "/hello.txt" })).rejects.toThrow()
    const missing = await f.request("/api/fs/read/..%2F..%2Fother-workspace%2Frepo%2Fhello.txt" + query)
    expect(missing.status).toBe(404)
    const again = await f.ok("/api/ocx/workspaces", "POST", { id: workspace.id })
    expect(again.workspace.id).toBe(workspace.id)
    expect((await f.manager.list()).length).toBe(2)
  } finally { await f.close() }
}, 60000)

test("full session-family and staged/untracked checkout roundtrip survives handoff retries and abort", async () => {
  const f = await fixture()
  try {
    // Source and destination deliberately share a server database. Fresh imported
    // identities must avoid the recoverable originals and preserve child links.
    let local = (await f.api("/api/session", "POST", { title: "Local conversation", location: { directory: f.source } })).data
    let child = (await f.api("/api/session", "POST", { parentID: local.id, title: "Child", location: { directory: f.source } })).data
    const seed = relocateSessions(await exportSessionFamily(local.id, f.api), f.source)
    const largeContext = "Preserve unpublished local work." + " Conversation history. ".repeat(10000)
    seed.sessions[0]!.messages.push({ id: "msg_original_context", type: "synthetic", time: { created: Date.now() }, text: largeContext })
    seed.sessions[1]!.messages.push({ id: "msg_original_child_context", type: "synthetic", time: { created: Date.now() }, text: "Investigated the child task." })
    for (const transcript of seed.sessions) await f.api("/api/experimental/session/import", "POST", { ...transcript, location: { directory: f.source } })
    local = (await f.api(`/api/session/${seed.rootID}`)).data
    child = (await f.api(`/api/session/${seed.sessions[1]!.info.id}`)).data
    const family = await exportSessionFamily(local.id, f.api)
    expect(family.sessions.map(session => session.info.id)).toContain(child.id)
    await writeFile(join(f.source, "hello.txt"), "staged\n")
    await git(f.source, "add", "hello.txt")
    await writeFile(join(f.source, "hello.txt"), "staged\nunstaged\n")
    await writeFile(join(f.source, "new.txt"), "untracked\n")
    await writeFile(join(f.source, ".env"), "LOCAL_SECRET=not-transferred\n")
    const workspace = await f.allocate("roundtrip")
    const checkpoint = await captureCheckpoint({ directory: f.source, workspaceID: workspace.id, id: "source-checkpoint" })
    await pushCheckpoint(f.source, checkpoint, await f.manager.access(workspace.id))
    const receive = { workspaceID: workspace.id, bundle: family, checkpointRef: checkpoint.ref, id: "receive-once" }
    f.loseNextImportReply()
    const lostReply = await f.request("/api/ocx/handoffs/receive", "POST", receive)
    expect(lostReply.status).toBe(400)
    expect(lostReply.text).toContain("Simulated lost successful import reply")
    const incoming = (await f.ok("/api/ocx/handoffs/receive", "POST", receive)).handoff
    expect(incoming.state).toBe("ready")
    expect(incoming.destinationSessionID).not.toBe(local.id)
    const imported = incoming.session as SessionBundle
    expect(imported.sessions).toHaveLength(2)
    const importedChild = imported.sessions.find(session => session.info.parentID)
    expect(importedChild?.info.parentID).toBe(incoming.destinationSessionID)
    expect((await f.api(`/api/session/${child.id}`)).data.parentID).toBe(local.id)
    expect((await f.api(`/api/session/${incoming.destinationSessionID}`)).data.location.directory).toBe(workspace.root)
    const remoteTranscript = (await f.api(`/api/experimental/session/${incoming.destinationSessionID}/export`)).data
    expect(remoteTranscript.messages.some((message: any) => message.text === largeContext)).toBe(true)
    expect((await f.storage.list({ prefix: `ocx/handoff-data/${incoming.id}/` })).size).toBeGreaterThan(2)
    expect(remoteTranscript.messages.some((message: any) => message.id === "msg_original_context")).toBe(false)
    expect(await git(workspace.root, "diff", "--cached")).toBe(await git(f.source, "diff", "--cached"))
    expect(await git(workspace.root, "diff")).toBe(await git(f.source, "diff"))
    expect(await readFile(join(workspace.root, "new.txt"), "utf8")).toBe("untracked\n")
    await expect(readFile(join(workspace.root, ".env"))).rejects.toThrow()
    const retry = (await f.ok("/api/ocx/handoffs/receive", "POST", receive)).handoff
    expect(retry.destinationSessionID).toBe(incoming.destinationSessionID)
    expect((await f.manager.get(workspace.id)).sessionIDs).toHaveLength(2)
    expect((await f.request(`/api/session/${incoming.destinationSessionID}/prompt`, "POST", { text: "must stay frozen", resume: false })).status).toBe(409)
    const committed = (await f.ok(`/api/ocx/handoffs/${incoming.id}/commit`, "POST", { resume: false })).handoff
    expect(committed.state).toBe("committed")
    expect((await f.manager.get(workspace.id)).state).toBe("ready")
    expect((await f.ok(`/api/ocx/handoffs/${incoming.id}/commit`, "POST", { resume: false })).handoff.state).toBe("committed")
    const handoffBody = { workspaceID: workspace.id, sessionID: incoming.destinationSessionID, id: "outbound-once" }
    const outgoing = (await f.ok("/api/ocx/handoffs", "POST", handoffBody)).handoff
    expect(outgoing.state).toBe("ready")
    expect((await f.request(`/api/session/${incoming.destinationSessionID}/prompt`, "POST", { text: "still frozen", resume: false })).status).toBe(409)
    const frozenWrite = await f.request("/api/experimental/fs/write?location[directory]=" + encodeURIComponent(workspace.root) + "&path=hello.txt", "POST", Buffer.from("must not overwrite transferred files"))
    expect(frozenWrite.status).toBeGreaterThanOrEqual(400)
    expect(await readFile(join(workspace.root, "hello.txt"), "utf8")).toBe("staged\nunstaged\n")
    expect((await f.ok("/api/ocx/handoffs", "POST", handoffBody)).handoff.checkpointRef).toBe(outgoing.checkpointRef)
    const destination = join(f.root, "returned-local")
    await restoreCheckpoint({ directory: destination, remote: await f.manager.access(workspace.id, "read"), ref: outgoing.checkpointRef })
    expect(await git(destination, "diff", "--cached")).toBe(await git(f.source, "diff", "--cached"))
    expect(await git(destination, "diff")).toBe(await git(f.source, "diff"))
    expect(await readFile(join(destination, "new.txt"), "utf8")).toBe("untracked\n")
    const returned = relocateSessions(outgoing.session, destination)
    for (const session of returned.sessions) await f.api("/api/experimental/session/import", "POST", { ...session, location: { directory: destination } })
    expect((await f.api(`/api/session/${returned.rootID}`)).data.location.directory).toBe(destination)
    await f.ok(`/api/ocx/handoffs/${outgoing.id}/commit`, "POST", { destinationSessionID: returned.rootID, resume: false })
    expect((await f.manager.get(workspace.id)).state).toBe("local")
    expect((await f.request(`/api/session/${incoming.destinationSessionID}/prompt`, "POST", { text: "stale remote", resume: false })).status).toBe(409)
    // A separate outbound handoff can be aborted without losing the original.
    const abortWorkspace = await f.allocate("abort-case")
    await f.ok(`/api/ocx/workspaces/${abortWorkspace.id}/provision`, "POST", {})
    const abortSession = (await f.ok(`/api/ocx/workspaces/${abortWorkspace.id}/sessions`, "POST", {})).session
    const abort = (await f.ok("/api/ocx/handoffs", "POST", { workspaceID: abortWorkspace.id, sessionID: abortSession.id, id: "abort-once" })).handoff
    expect((await f.ok(`/api/ocx/handoffs/${abort.id}/abort`, "POST", {})).handoff.state).toBe("aborted")
    expect((await f.ok(`/api/ocx/handoffs/${abort.id}/abort`, "POST", {})).handoff.state).toBe("aborted")
    expect((await f.manager.get(abortWorkspace.id)).state).toBe("ready")
  } finally { await f.close() }
}, 120000)

test("queued prompts prevent transfer and canceling the inbox safely allows retry", async () => {
  const f = await fixture()
  try {
    const workspace = await f.allocate("queued-input")
    await f.ok(`/api/ocx/workspaces/${workspace.id}/provision`, "POST", {})
    const session = (await f.ok(`/api/ocx/workspaces/${workspace.id}/sessions`, "POST", {})).session
    const admitted = await f.ok(`/api/session/${session.id}/prompt`, "POST", { text: "Queued work must not disappear", resume: false })
    const pending = await f.request("/api/ocx/handoffs", "POST", { workspaceID: workspace.id, sessionID: session.id, id: "inbox-check" })
    expect(pending.status).toBe(400)
    expect(pending.text).toContain("queued prompts")
    expect((await f.manager.get(workspace.id)).state).toBe("transferring")
    expect((await f.manager.get(workspace.id)).handoffID).toBe("inbox-check")
    expect((await f.ok("/api/ocx/handoffs/inbox-check")).handoff.state).toBe("preparing")
    await f.ok(`/api/session/${session.id}/inbox/${admitted.data.id}`, "DELETE")
    const ready = (await f.ok("/api/ocx/handoffs", "POST", { workspaceID: workspace.id, sessionID: session.id, id: "inbox-check" })).handoff
    expect(ready.state).toBe("ready")
    await f.ok(`/api/ocx/handoffs/${ready.id}/abort`, "POST", {})
    expect((await f.manager.get(workspace.id)).state).toBe("ready")
  } finally { await f.close() }
}, 60000)

test("concurrent retries of the first receive share one imported identity", async () => {
  const f = await fixture()
  try {
    const source = (await f.api("/api/session", "POST", { title: "Concurrent source", location: { directory: f.source } })).data
    const family = await exportSessionFamily(source.id, f.api)
    const workspace = await f.allocate("concurrent-receive")
    const checkpoint = await captureCheckpoint({ directory: f.source, workspaceID: workspace.id })
    await pushCheckpoint(f.source, checkpoint, await f.manager.access(workspace.id))
    const body = { workspaceID: workspace.id, bundle: family, checkpointRef: checkpoint.ref, id: "concurrent-once" }
    const [first, second] = await Promise.all([
      f.request("/api/ocx/handoffs/receive", "POST", body),
      f.request("/api/ocx/handoffs/receive", "POST", body),
    ])
    expect(first.status, first.text).toBe(200)
    expect(second.status, second.text).toBe(200)
    expect(first.value.handoff.destinationSessionID).toBe(second.value.handoff.destinationSessionID)
    expect((await f.manager.get(workspace.id)).sessionIDs).toHaveLength(1)
  } finally { await f.close() }
}, 60000)

test("an in-flight checkpoint merges its ref without reverting handoff ownership", async () => {
  const f = await fixture()
  try {
    const workspace = await f.allocate("checkpoint-race")
    await f.manager.provision(workspace.id)
    const gate = f.delayNextCapture()
    const checkpoint = f.manager.checkpoint(workspace.id)
    await gate.entered
    const transferred = await f.manager.get(workspace.id)
    transferred.state = "local"
    transferred.generation = 1
    transferred.handoffID = "durable-owner-receipt"
    transferred.sessionIDs.push("ses_registered_during_checkpoint")
    await f.storage.put(`ocx/workspaces/${workspace.id}`, transferred)
    gate.release()
    const ref = await checkpoint
    const current = await f.manager.get(workspace.id)
    expect(current.checkpointRef).toBe(ref)
    expect(current.state).toBe("local")
    expect(current.generation).toBe(1)
    expect(current.handoffID).toBe("durable-owner-receipt")
    expect(current.sessionIDs).toContain("ses_registered_during_checkpoint")
  } finally { await f.close() }
}, 60000)

test("provisioning retries reuse a completed clone after branch or first-checkpoint failure", async () => {
  const f = await fixture()
  try {
    for (const failure of ["clone-after", "branch-before", "branch-after", "checkpoint"] as const) {
      const workspace = await f.allocate("retry-" + failure)
      f.failCommandOnce(command => failure === "checkpoint" ? command.includes('"action":"capture"') : failure === "clone-after" ? command.includes(" clone ") : command.includes(" switch -c "), failure === "branch-after" || failure === "clone-after" ? "after" : "before")
      await expect(f.manager.provision(workspace.id, undefined, "agent/retry")).rejects.toThrow("Injected")
      expect((await f.manager.get(workspace.id)).state).toBe("failed")
      const head = await git(workspace.root, "rev-parse", "HEAD")
      await writeFile(join(workspace.root, "keep-my-work.txt"), `written after ${failure}\n`)
      // No repeated branch argument is needed: provisioning settings are durable.
      const recovered = await f.manager.provision(workspace.id)
      expect(recovered.state).toBe("ready")
      expect(recovered.branch).toBe("agent/retry")
      expect(recovered.provisioning?.checkoutReady).toBe(true)
      expect(await git(workspace.root, "branch", "--show-current")).toBe("agent/retry")
      expect(await git(workspace.root, "rev-parse", "HEAD")).toBe(head)
      expect(await readFile(join(workspace.root, "keep-my-work.txt"), "utf8")).toBe(`written after ${failure}\n`)
      expect(await git(workspace.root, "remote", "get-url", "origin")).toBe("https://source.invalid/repo.git")
    }
  } finally { await f.close() }
}, 60000)
