import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createControlBridge } from "../packages/client/src/control-bridge"
import type { RemoteLaunch } from "../packages/client/src/remote"

const exec = promisify(execFile)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "ocx-control-test-"))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
const response = (value: unknown, status = 200) => Response.json(value, { status })
const auth = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
test("a saved offline remote never blocks local OpenCode startup", async () => {
  const dataRoot = await directory()
  await writeFile(join(dataRoot, "connection.json"), JSON.stringify({ version: 1, remote: { server: "https://offline.test", password: "saved" } }))
  let started = false
  const fakeFetch: typeof fetch = (async (_input, init) => {
    started = true
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
  }) as typeof fetch
  const running = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:4096" }, fetch: fakeFetch, onSwitch() {} })
  expect(started).toBe(true)
  expect((await running.state()).mode).toBe("local")
  expect((await running.state()).connected).toBe(false)
  await running.stop()
})
async function bridge(options: Parameters<typeof createControlBridge>[0]) {
  const result = await createControlBridge(options)
  cleanup.push(() => result.stop())
  const state = () => fetch(result.origin + "/state", { headers: { authorization: `Bearer ${result.token}` } }).then(result => result.json()) as Promise<any>
  const action = async (input: unknown) => {
    const reply = await fetch(result.origin + "/action", { method: "POST", headers: { authorization: `Bearer ${result.token}`, "content-type": "application/json" }, body: JSON.stringify(input) })
    return { status: reply.status, value: await reply.json() as any }
  }
  return { ...result, state, action }
}

test("loopback bridge authenticates every request and saves only a successfully probed private connection", async () => {
  const dataRoot = await directory()
  const calls: Request[] = []
  const fakeFetch = (async (input, init) => {
    const request = new Request(input, init); calls.push(request)
    return request.headers.get("authorization") === auth("remote-secret") ? response({ workspaces: [] }) : response({ error: "Invalid credentials" }, 401)
  }) as typeof fetch
  const first = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:4096", password: "local-secret" }, fetch: fakeFetch, onSwitch() {} })
  expect((await fetch(first.origin + "/state")).status).toBe(401)
  expect((await fetch(first.origin + "/state", { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
  expect((await fetch(first.origin + "/state", { headers: { authorization: `Bearer ${first.token}`, origin: "https://unrelated.example" } })).status).toBe(403)
  expect((await fetch(first.origin + "/state", { headers: { authorization: `Bearer ${first.token}`, host: "rebound.example" } })).status).toBe(403)
  expect((await first.action({ action: "configure", server: "https://remote.test/path", password: "remote-secret" })).status).toBe(400)
  expect(calls).toHaveLength(0)
  expect((await first.action({ action: "configure", server: "https://remote.test", password: "wrong" })).status).toBe(400)
  await expect(readFile(join(dataRoot, "connection.json"))).rejects.toThrow()
  const configured = await first.action({ action: "configure", server: "https://remote.test", password: "remote-secret" })
  expect(configured.status).toBe(200)
  expect(configured.value.data).toEqual({ connected: true, remote: { server: "https://remote.test" } })
  const saved = JSON.parse(await readFile(join(dataRoot, "connection.json"), "utf8"))
  expect(saved.remote.password).toBe("remote-secret")
  expect((await stat(join(dataRoot, "connection.json"))).mode & 0o077).toBe(0)
  const visible = JSON.stringify(await first.state())
  expect(visible).not.toContain("remote-secret")
  expect(visible).not.toContain("local-secret")
  expect(visible).not.toContain(first.token)
  await first.stop()
  const restarted = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:4097" }, fetch: fakeFetch, onSwitch() {} })
  expect((await restarted.state()).connected).toBe(true)
  expect((await restarted.state()).remote).toEqual({ server: "https://remote.test" })
})

test("new, picker, GitHub and activation actions run inside the bridge without exposing remote credentials", async () => {
  const dataRoot = await directory()
  const launches: RemoteLaunch[] = []
  const workspace = { id: "ws_one", name: "Example", state: "ready", sessionIDs: ["ses_one"] }
  const calls: { path: string; body?: any }[] = []
  const fakeFetch = (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    expect(request.headers.get("authorization")).toBe(auth("remote-password"))
    const body = request.method === "POST" ? await request.json() : undefined
    calls.push({ path: url.pathname + url.search, body })
    if (url.pathname === "/api/ocx/workspaces") return request.method === "POST" ? response({ workspace }) : response({ workspaces: [workspace] })
    if (url.pathname === "/api/ocx/workspaces/ws_one") return response({ workspace })
    if (url.pathname.endsWith("/sessions")) return response({ session: { id: "ses_created" } })
    if (url.pathname === "/api/session/ses_one") return response({ data: { id: "ses_one", title: "Existing conversation" } })
    if (url.pathname.endsWith("/repos")) return response([{ full_name: "acme/repo", default_branch: "main" }])
    if (url.pathname.endsWith("/branches")) return response([{ name: "main" }])
    if (url.pathname.endsWith("/status")) return response({ connected: true, deviceLoginAvailable: true })
    if (url.pathname.endsWith("/login")) return response({ user_code: "ABCD", verification_uri: "https://github.com/login/device", device_code: "device-code", expires_in: 60 })
    if (url.pathname.endsWith("/poll")) return response({ connected: true })
    if (url.pathname.endsWith("/preview")) return response({ url: "https://preview.test" })
    if (url.pathname.endsWith("/pull-request")) return response({ url: "https://github.com/acme/repo/pull/1" })
    return response({ error: "not found" }, 404)
  }) as typeof fetch
  const control = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:4096", password: "local-password" }, initialRemote: { server: "https://remote.test", password: "remote-password" }, fetch: fakeFetch, onSwitch(launch) { launches.push(launch) } })
  expect((await control.action({ action: "workspaces" })).value.data.workspaces).toEqual([workspace])
  expect((await control.action({ action: "sessions", workspaceID: "ws_one" })).value.data.sessions[0].title).toBe("Existing conversation")
  expect((await control.action({ action: "repositories" })).value.data[0].full_name).toBe("acme/repo")
  expect((await control.action({ action: "branches", repository: "acme/repo" })).value.data).toEqual([{ name: "main" }])
  expect((await control.action({ action: "githubStatus" })).value.data.connected).toBe(true)
  expect((await control.action({ action: "githubLoginStart" })).value.data.user_code).toBe("ABCD")
  expect((await control.action({ action: "githubLoginPoll", device_code: "device-code" })).value.data.connected).toBe(true)
  const created = await control.action({ action: "new", source: "acme/repo", branch: "main", newBranch: "agent/task", prompt: "Fix it", model: { providerID: "acme", modelID: "coder" } })
  expect(created.status).toBe(200)
  expect(created.value.data.launch).toEqual({ sessionID: "ses_created", local: false, server: "https://remote.test" })
  expect(calls.find(call => call.path.endsWith("/sessions"))?.body).toMatchObject({ prompt: "Fix it", model: { providerID: "acme", id: "coder" } })
  expect(JSON.stringify(created)).not.toContain("remote-password")
  expect(launches).toHaveLength(0)
  const activated = await control.action({ action: "activate" })
  expect(activated.status).toBe(200)
  expect(launches).toHaveLength(0)
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(launches).toHaveLength(1)
  expect(launches[0]?.password).toBe("remote-password")
  expect((await control.state()).mode).toBe("remote")
  expect((await control.action({ action: "preview", workspaceID: "ws_one", port: 3000 })).value.data.url).toBe("https://preview.test")
  expect((await control.action({ action: "pr", workspaceID: "ws_one", title: "Fix it" })).value.data.url).toContain("/pull/1")
  expect((await control.action({ action: "switch", workspaceID: "ws_one", sessionID: "ses_one" })).value.data.launch.sessionID).toBe("ses_one")
  const home = await control.action({ action: "switchLocal" })
  expect(home.value.data.launch.local).toBe(true)
  expect(home.value.data.launch.sessionID).toBe("")
  const reconfigured = await control.action({ action: "configure", server: "https://replacement.test", password: "remote-password" })
  expect(reconfigured.value.data.launch.local).toBe(true)
  expect(reconfigured.value.data.launch.sessionID).toBe("")
  expect(reconfigured.value.data.remote.server).toBe("https://replacement.test")
})

test("send uses its managed local backend and exposes recoverable journal summaries after a restart", async () => {
  const root = await directory(), dataRoot = join(root, "data"), source = join(root, "source"), artifact = join(root, "artifact.git")
  await mkdir(source)
  const git = async (...args: string[]) => (await exec("git", args, { cwd: source })).stdout.trim()
  await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid")
  await writeFile(join(source, "file.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base")
  await writeFile(join(source, "file.txt"), "unfinished\n"); await git("init", "--bare", artifact)
  const transcript = { info: { id: "ses_local", location: { directory: source }, metadata: {}, time: { created: 1, updated: 1 } }, messages: [{ id: "msg_context", type: "synthetic", text: "transcript-only-secret", time: { created: 1 } }] }
  let workspaceID = "", handoff: any, interruptReceive = true, localPort = "4096", localPassword = "first-local-password"
  const localPorts: string[] = []
  const fakeFetch = (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), path = url.pathname
    const content = request.method === "POST" || request.method === "PATCH" ? await request.text() : ""
    const body: any = content ? JSON.parse(content) : undefined
    if (url.hostname === "127.0.0.1") {
      localPorts.push(url.port)
      expect(url.port).toBe(localPort)
      expect(request.headers.get("authorization")).toBe(auth(localPassword))
      if (path.endsWith("/interrupt") || path.endsWith("/wait")) return new Response(null, { status: 204 })
      if (path.endsWith("/inbox")) return response({ data: [] })
      if (path.endsWith("/export")) return response({ data: transcript })
      if (path === "/api/session") return response({ data: [], cursor: {} })
      if (request.method === "PATCH") return new Response(null, { status: 204 })
      return response({ data: transcript.info })
    }
    expect(url.origin).toBe("https://remote.test")
    expect(request.headers.get("authorization")).toBe(auth("remote-password"))
    if (path === "/api/ocx/workspaces") {
      if (request.method === "GET") return response({ workspaces: [] })
      workspaceID = body.id
      return response({ workspace: { id: workspaceID }, access: { url: artifact, token: "" } })
    }
    if (path === "/api/ocx/handoffs/receive") {
      if (interruptReceive) { interruptReceive = false; throw new Error("Connection dropped during import") }
      handoff = { id: body.id, workspaceID, sessionID: "ses_local", direction: "local-to-remote", state: "ready", generation: 0, createdAt: 1, destinationSessionID: "ses_remote" }
      return response({ handoff })
    }
    if (path.endsWith("/commit")) { handoff.state = "committed"; handoff.resumeRequested = true; return response({ handoff }) }
    return handoff ? response({ handoff }) : response({ error: "missing" }, 404)
  }) as typeof fetch
  const first = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:4096", password: localPassword }, initialRemote: { server: "https://remote.test", password: "remote-password" }, fetch: fakeFetch, onSwitch() {} })
  const failure = await first.action({ action: "send", sessionID: "ses_local", directory: source, localServer: "https://untrusted.test" })
  expect(failure.status).toBe(400)
  expect(failure.value.recoverable).toBe(true)
  const state = await first.state()
  expect(state.transfers).toHaveLength(1)
  expect(state.transfers[0]).toMatchObject({ direction: "local-to-remote", stage: "uploaded", sourceSessionID: "ses_local", directory: source })
  expect(JSON.stringify(state)).not.toContain("transcript-only-secret")
  expect(JSON.stringify(state)).not.toContain("bundle")
  const transferID = state.transfers[0].id
  // A receipt in a different server namespace is never mixed into this list.
  const otherHash = createHash("sha256").update("https://other.test").digest("hex").slice(0, 16)
  await mkdir(join(dataRoot, "transfers", otherHash), { recursive: true })
  await writeFile(join(dataRoot, "transfers", otherHash, "other.json"), JSON.stringify({ version: 1, id: "other", server: "https://other.test", stage: "private" }))
  await first.stop()
  localPort = "49999"; localPassword = "replacement-local-password"; localPorts.length = 0
  const restarted = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:49999", password: localPassword }, fetch: fakeFetch, onSwitch() {} })
  expect((await restarted.state()).transfers).toHaveLength(1)
  const recovered = await restarted.action({ action: "recover", transferID })
  expect(recovered.status).toBe(200)
  expect(recovered.value.data.launch.sessionID).toBe("ses_remote")
  expect(localPorts.length).toBeGreaterThan(0)
  expect(localPorts.every(port => port === "49999")).toBe(true)
  expect((await restarted.state()).transfers[0].stage).toBe("committed")
  expect(await readFile(join(source, "file.txt"), "utf8")).toBe("unfinished\n")
  const journals = await readdir(join(dataRoot, "transfers", createHash("sha256").update("https://remote.test").digest("hex").slice(0, 16)))
  expect(journals).toContain(transferID + ".json")
})

test("workspace mutations serialize while status stays available with user-facing progress", async () => {
  const dataRoot = await directory()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  let paused = false
  const fakeFetch = (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname === "/api/ocx/workspaces" && request.method === "GET") return response({ workspaces: [] })
    if (url.pathname === "/api/ocx/workspaces") {
      enter(); await released
      return response({ workspace: { id: "ws_serial" } })
    }
    if (url.pathname.endsWith("/sessions")) return response({ session: { id: "ses_serial" } })
    if (url.pathname.endsWith("/pause")) { paused = true; return response({ workspace: { id: "ws_serial", state: "paused" } }) }
    return response({}, 404)
  }) as typeof fetch
  const control = await bridge({ dataRoot, binary: "opencode", local: { server: "http://127.0.0.1:4096" }, initialRemote: { server: "https://remote.test" }, fetch: fakeFetch, onSwitch() {} })
  const creating = control.action({ action: "new", source: "acme/repo" })
  await entered
  const pausing = control.action({ action: "pause", workspaceID: "ws_serial" })
  const during = await control.state()
  expect(during.progress).toBe("Preparing your remote thread…")
  expect(paused).toBe(false)
  release()
  const created = await creating
  expect(created.value.data.messages).toEqual(["Your remote thread is ready."])
  expect(JSON.stringify(created.value.data.messages)).not.toContain("Attach:")
  expect(JSON.stringify(created.value.data.messages)).not.toContain("ses_serial")
  expect((await pausing).status).toBe(200)
  expect(paused).toBe(true)
})
