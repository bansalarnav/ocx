import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { captureCheckpoint, pushCheckpoint } from "../packages/client/src/checkpoint"
import { parseArguments } from "../packages/client/src/options"
import { parseRemoteArguments, runRemoteCommand } from "../packages/client/src/remote"
import { relocateSessions, type SessionBundle, type Transcript } from "../packages/protocol/src/session-transfer"
import type { Handoff } from "../packages/protocol/src/workspaces"

const exec = promisify(execFile)
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const json = (body: unknown, status = 200) => Response.json(body, { status })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ocx-remote-client-")); temporary.push(root)
  const source = join(root, "source"), remote = join(root, "remote.git")
  await mkdir(source)
  const git = async (...args: string[]) => (await exec("git", args, { cwd: source })).stdout.trim()
  await git("init", "--initial-branch=topic")
  await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.com")
  await writeFile(join(source, "code.txt"), "original\n")
  await git("add", "."); await git("commit", "-m", "base")
  await writeFile(join(source, "code.txt"), "unfinished work\n")
  await git("init", "--bare", remote)
  const options = parseRemoteArguments(["send", "--server", "https://remote.test", "--local-server", "http://localhost:4096", "--session", "ses_root", "--data-dir", join(root, "receipts")], {})
  options.opencodeDataRoot = join(root, "opencode")
  const transcript = (id: string, parentID?: string): Transcript => ({
    info: { id, parentID, location: { directory: source }, time: { created: 1, updated: 2 }, metadata: { original: true } },
    messages: [{ id: `msg_${id}`, type: "user", content: [{ type: "text", text: "keep transcript" }] }],
  })
  const bundle: SessionBundle = { rootID: "ses_root", sessions: [transcript("ses_root"), transcript("ses_child", "ses_root")] }
  return { root, source, remote, options, bundle }
}

describe("remote client transfers", () => {
  test("local OpenCode is the default and remote model syntax matches stable OpenCode", () => {
    expect(parseArguments([], {}).origin).toBe("")
    expect(parseArguments(["--", "--session", "ses_test"], {}).childArgs).toEqual(["--session", "ses_test"])
    expect(parseRemoteArguments(["new", "--model", "acme/code/model"], {}).model).toEqual({ providerID: "acme", id: "code/model" })
    expect(() => parseArguments(["--share-device"], {})).toThrow("requires --server")
  })

  test("send checkpoints real Git state, exports descendants, archives source before commit, and recovers a lost commit reply", async () => {
    const { source, remote, options, bundle } = await fixture()
    const archived = new Set<string>()
    let handoff: Handoff | undefined, checkpointRef = "", failReply = true, workspaceID = "", receives = 0, admissions = 0, commits = 0
    const fetcher = (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input)), path = url.pathname
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      if (url.hostname === "localhost") {
        const id = path.split("/")[3]!
        if (path.endsWith("/interrupt")) return json({ interrupted: true })
        if (path.endsWith("/wait")) return new Response(null, { status: 204 })
        if (path.endsWith("/inbox")) return json({ data: [] })
        if (path.endsWith("/export")) return json({ data: bundle.sessions.find(s => s.info.id === path.split("/")[4]) })
        if (path === "/api/session") return json({ data: url.searchParams.get("parentID") === "ses_root" ? [{ id: "ses_child" }] : [], cursor: {} })
        if (init.method === "PATCH") { archived.add(id); expect(body.archived).toBe(true); return new Response(null, { status: 204 }) }
        return json({ data: bundle.sessions.find(s => s.info.id === id)?.info })
      }
      if (path === "/api/ocx/workspaces") {
        workspaceID = body.id
        return json({ workspace: { id: workspaceID }, access: { url: remote, token: "" } })
      }
      if (path === "/api/ocx/handoffs/receive") {
        receives++
        checkpointRef = body.checkpointRef
        expect(body.bundle.sessions.map((s: Transcript) => s.info.id)).toEqual(["ses_root", "ses_child"])
        handoff = { id: body.id, workspaceID, sessionID: "ses_root", direction: "local-to-remote", state: "ready", generation: 1, destinationSessionID: "ses_destination", createdAt: 1 }
        return json({ handoff })
      }
      if (path.endsWith("/commit")) {
        commits++
        expect([...archived].sort()).toEqual(["ses_child", "ses_root"])
        handoff!.state = "committed"
        if (failReply) { failReply = false; throw new Error("Reply lost") }
        if (!handoff!.resumeRequested) { admissions++; handoff!.resumeRequested = true }
        return json({ handoff })
      }
      return handoff ? json({ handoff }) : json({ error: "missing" }, 404)
    }) as typeof fetch
    const lines: string[] = []
    await expect(runRemoteCommand(options, { fetch: fetcher, log: line => lines.push(line) })).rejects.toThrow("Reply lost")
    expect(checkpointRef.startsWith("refs/ocx/checkpoints/")).toBe(true)
    const transfer = handoff!.id
    expect(handoff!.resumeRequested).toBeUndefined()
    await runRemoteCommand({ ...options, command: "recover", transfer }, { fetch: fetcher, log: line => lines.push(line) })
    expect(lines.some(line => line.includes("Thread continued remotely"))).toBe(true)
    expect(await readFile(join(source, "code.txt"), "utf8")).toBe("unfinished work\n")
    const receipts = await readdir(join(options.dataRoot, "transfers"))
    const saved = JSON.parse(await readFile(join(options.dataRoot, "transfers", receipts[0]!, `${transfer}.json`), "utf8"))
    expect(saved.stage).toBe("committed")
    expect(saved.checkpoint.manifest.head).toMatch(/^[a-f0-9]{40}$/)
    expect(saved.bundle.sessions).toHaveLength(2)
    await runRemoteCommand({ ...options, command: "recover", transfer }, { fetch: fetcher, log: () => {} })
    expect(receives).toBe(1)
    expect(admissions).toBe(1)
    expect(commits).toBe(3)
  })

  test("recovery retries a preparing remote import before archiving the local source", async () => {
    const { source, remote, options, bundle } = await fixture()
    const archived = new Set<string>()
    let handoff: Handoff | undefined, workspaceID = "", receives = 0, imported = 0, admissions = 0
    const fetcher = (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input)), path = url.pathname
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      if (url.hostname === "localhost") {
        const id = path.split("/")[3]!
        if (path.endsWith("/interrupt")) return json({ interrupted: true })
        if (path.endsWith("/wait")) return new Response(null, { status: 204 })
        if (path.endsWith("/inbox")) return json({ data: [] })
        if (path.endsWith("/export")) return json({ data: bundle.sessions.find(s => s.info.id === path.split("/")[4]) })
        if (path === "/api/session") return json({ data: url.searchParams.get("parentID") === "ses_root" ? [{ id: "ses_child" }] : [], cursor: {} })
        if (init.method === "PATCH") {
          expect(handoff?.state).toBe("ready")
          archived.add(id); return new Response(null, { status: 204 })
        }
        return json({ data: bundle.sessions.find(s => s.info.id === id)?.info })
      }
      if (path === "/api/ocx/workspaces") {
        workspaceID = body.id
        return json({ workspace: { id: workspaceID }, access: { url: remote, token: "" } })
      }
      if (path === "/api/ocx/handoffs/receive") {
        receives++
        if (!handoff) {
          handoff = { id: body.id, workspaceID, sessionID: "ses_root", direction: "local-to-remote", state: "preparing", generation: 1, destinationSessionID: "ses_imported_once", createdAt: 1 }
          return json({ error: "Remote import failed" }, 502)
        }
        expect(body.id).toBe(handoff.id)
        expect(body.bundle.sessions).toEqual(bundle.sessions)
        expect(body.checkpointRef).toMatch(/^refs\/ocx\/checkpoints\//)
        if (receives === 2) return json({ handoff })
        handoff.state = "ready"; imported++
        return json({ handoff })
      }
      if (path.endsWith("/commit")) {
        expect([...archived].sort()).toEqual(["ses_child", "ses_root"])
        handoff!.state = "committed"; handoff!.resumeRequested = true; admissions++
        return json({ handoff })
      }
      return handoff ? json({ handoff }) : json({ error: "missing" }, 404)
    }) as typeof fetch
    await expect(runRemoteCommand(options, { fetch: fetcher, log: () => {} })).rejects.toThrow("Remote import failed")
    expect(archived.size).toBe(0)
    expect(handoff!.state).toBe("preparing")
    await expect(runRemoteCommand({ ...options, command: "recover", transfer: handoff!.id }, { fetch: fetcher, log: () => {} })).rejects.toThrow("not ready")
    expect(archived.size).toBe(0)
    await runRemoteCommand({ ...options, command: "recover", transfer: handoff!.id }, { fetch: fetcher, log: () => {} })
    expect(receives).toBe(3)
    expect(imported).toBe(1)
    expect(admissions).toBe(1)
    expect(handoff!.destinationSessionID).toBe("ses_imported_once")
    expect(await readFile(join(source, "code.txt"), "utf8")).toBe("unfinished work\n")
  })

  test("receive retries failed preparation with the same ID, restores real files, and recovers a lost import reply", async () => {
    const { root, source, remote, options, bundle } = await fixture()
    const checkpoint = await captureCheckpoint({ directory: source, workspaceID: "ws_test" })
    await pushCheckpoint(source, checkpoint, { url: remote })
    const imported = new Map<string, any>()
    let handoff: Handoff | undefined, failReply = true, failUnarchive = true, commitCount = 0, preparations = 0
    const fetcher = (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input)), path = url.pathname
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      if (url.hostname === "localhost") {
        if (path.endsWith("/import")) {
          if (body.info.parentID) expect(imported.has(body.info.parentID)).toBe(true)
          expect(imported.has(body.info.id)).toBe(false)
          expect(body.info.time.archived).toBeGreaterThan(0)
          imported.set(body.info.id, body.info)
          if (failReply) { failReply = false; throw new Error("Import reply lost") }
          return json({ data: body.info })
        }
        const id = path.split("/")[3]!
        if (init.method === "PATCH") {
          expect(handoff?.state).toBe("committed")
          if (failUnarchive) { failUnarchive = false; throw new Error("Local unarchive unavailable") }
          imported.get(id).archived = body.archived
          return new Response(null, { status: 204 })
        }
        return imported.has(id) ? json({ data: imported.get(id) }) : json({ error: "missing" }, 404)
      }
      if (path.endsWith("/access")) return json({ url: remote, token: "" })
      if (path === "/api/ocx/handoffs" && init.method === "POST") {
        preparations++
        if (!handoff) {
          handoff = { id: body.id, workspaceID: "ws_test", sessionID: "ses_root", direction: "remote-to-local", state: "preparing", generation: 1, createdAt: 1 }
          return json({ error: "Remote preparation failed" }, 502)
        }
        expect(body.id).toBe(handoff.id)
        expect(body.workspaceID).toBe(handoff.workspaceID)
        expect(body.sessionID).toBe(handoff.sessionID)
        handoff.state = "ready"; handoff.checkpointRef = checkpoint.ref; handoff.session = bundle
        return json({ handoff })
      }
      if (path.endsWith("/commit")) {
        commitCount++
        handoff!.state = "committed"; handoff!.destinationSessionID = body.destinationSessionID
        return json({ handoff })
      }
      return handoff ? json({ handoff }) : json({ error: "missing" }, 404)
    }) as typeof fetch
    const receive = { ...options, command: "receive", workspace: "ws_test", directory: undefined }
    await expect(runRemoteCommand(receive, { fetch: fetcher, log: () => {} })).rejects.toThrow("Remote preparation failed")
    const transfer = handoff!.id
    expect(imported.size).toBe(0)
    await expect(runRemoteCommand({ ...receive, command: "recover", transfer }, { fetch: fetcher, log: () => {} })).rejects.toThrow("Import reply lost")
    await expect(runRemoteCommand({ ...receive, command: "recover", transfer }, { fetch: fetcher, log: () => {} })).rejects.toThrow("Local unarchive unavailable")
    const savedReceipt = JSON.parse(await readFile(join(options.dataRoot, "transfers", (await import("node:crypto")).createHash("sha256").update("https://remote.test").digest("hex").slice(0, 16), `${transfer}.json`), "utf8"))
    expect(savedReceipt.stage).toBe("opening-local")
    const launch = await runRemoteCommand({ ...receive, command: "recover", transfer, attach: true }, { fetch: fetcher, log: () => {} })
    expect(imported.size).toBe(2)
    expect(commitCount).toBe(1)
    expect([...imported.values()].every(info => info.archived === false)).toBe(true)
    expect([...imported.keys()].every(id => !bundle.sessions.some(s => s.info.id === id))).toBe(true)
    expect(launch?.directory).toBe(join(root, "opencode", "workspaces", "ws_test", transfer))
    expect(await readFile(join(launch!.directory!, "code.txt"), "utf8")).toBe("unfinished work\n")
    expect(launch?.sessionID).toBe(handoff!.destinationSessionID)
    await runRemoteCommand({ ...receive, command: "recover", transfer }, { fetch: fetcher, log: () => {} })
    expect(preparations).toBe(2)
    expect(commitCount).toBe(1)
    expect(imported.size).toBe(2)
  })

  test("aborting a preparing send keeps its source thread and checkout available", async () => {
    const { source, remote, options, bundle } = await fixture()
    let handoff: Handoff | undefined, workspaceID = "", restoredSource = false
    const fetcher = (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input)), path = url.pathname
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      if (url.hostname === "localhost") {
        if (path.endsWith("/interrupt")) return json({ interrupted: true })
        if (path.endsWith("/wait")) return new Response(null, { status: 204 })
        if (path.endsWith("/inbox")) return json({ data: [] })
        if (path.endsWith("/export")) return json({ data: bundle.sessions[0] })
        if (path === "/api/session") return json({ data: [], cursor: {} })
        if (init.method === "PATCH") {
          expect(handoff?.state).toBe("aborted")
          expect(body).toEqual({ archived: false, metadata: { original: true } })
          restoredSource = true
          return new Response(null, { status: 204 })
        }
        return json({ data: bundle.sessions[0]!.info })
      }
      if (path === "/api/ocx/workspaces") {
        workspaceID = body.id
        return json({ workspace: { id: workspaceID }, access: { url: remote, token: "" } })
      }
      if (path === "/api/ocx/handoffs/receive") {
        handoff = { id: body.id, workspaceID, sessionID: "ses_root", direction: "local-to-remote", state: "preparing", generation: 1, createdAt: 1 }
        return json({ error: "Remote import failed" }, 502)
      }
      if (path.endsWith("/abort")) { handoff!.state = "aborted"; return json({ handoff }) }
      if (path.endsWith("/commit")) throw new Error("Abort must not commit")
      return handoff ? json({ handoff }) : json({ error: "missing" }, 404)
    }) as typeof fetch
    await expect(runRemoteCommand(options, { fetch: fetcher, log: () => {} })).rejects.toThrow("Remote import failed")
    expect(restoredSource).toBe(false)
    await runRemoteCommand({ ...options, command: "recover", transfer: handoff!.id, abort: true }, { fetch: fetcher, log: () => {} })
    expect(restoredSource).toBe(true)
    expect(await readFile(join(source, "code.txt"), "utf8")).toBe("unfinished work\n")
  })

  test("queued inputs stop a handoff before any workspace allocation or source archiving", async () => {
    const { options, source } = await fixture()
    const mutations: string[] = []
    const fetcher = (async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (init.method && init.method !== "GET") mutations.push(`${init.method} ${url.pathname}`)
      if (url.pathname.endsWith("/inbox")) return json({ data: [{ id: "queued" }] })
      if (url.pathname.endsWith("/interrupt")) return json({ interrupted: false })
      if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
      if (url.hostname === "localhost") return json({ data: { location: { directory: source } } })
      return json({ error: "missing" }, 404)
    }) as typeof fetch
    await expect(runRemoteCommand(options, { fetch: fetcher, log: () => {} })).rejects.toThrow("queued work")
    expect(mutations).toEqual(["POST /api/session/ses_root/interrupt", "POST /api/experimental/session/ses_root/wait"])
  })
})
