import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { captureCheckpoint, findLocalCheckpoint, pushCheckpoint, restoreCheckpoint, type GitCheckpoint } from "./checkpoint"
import { ApiError, RemoteAPI } from "./remote-api"
import { relocateSessions, type SessionBundle, type Transcript } from "@ocx/protocol/session-transfer"
import { handoffPrefix, validID, workspacePrefix, type Handoff, type RepositoryAccess, type Workspace } from "@ocx/protocol/workspaces"

export const remoteUsage = `Usage: ocx remote <command> --server <url> [options]

Commands:
  list                 List remote workspaces
  new                  Create a workspace and thread (--repo owner/repo [--branch main] [--new-branch topic] [--prompt text])
  attach               Open a remote thread (--workspace ID [--session ID])
  send                 Continue a local thread remotely (--session ID --local-server URL [--directory path])
  receive              Continue a remote thread locally (--workspace ID --session ID --local-server URL [--directory path])
  recover              Finish an interrupted transfer (--transfer ID [--abort])
  pause                Checkpoint and pause a workspace (--workspace ID)
  preview              Get a preview URL (--workspace ID --port 3000)
  pr                   Push the branch and open a PR (--workspace ID --title text [--base main] [--body text])
  github               Connect GitHub (--login) or list repositories (--repos)

Options:
  --password VALUE     Remote password (default OPENCODE_PASSWORD)
  --local-password V   Local password (default OPENCODE_LOCAL_PASSWORD)
  --name NAME          Workspace name
  --model PROVIDER/ID  Model for a new remote thread
  --data-dir PATH      Transfer receipts (default $XDG_DATA_HOME/ocx)
  --binary PATH        CLI to launch (default opencode)
  --attach             Open the transferred or created thread after completion

With no --server, ordinary ocx starts local OpenCode. Remote transfers keep both copies.
Receive defaults to $XDG_DATA_HOME/opencode/workspaces/<workspace>/<transfer>.`

export interface RemoteOptions {
  command: string
  server: string
  password?: string
  localServer?: string
  localPassword?: string
  directory?: string
  workspace?: string
  session?: string
  transfer?: string
  source?: string
  projectID?: string
  branch?: string
  newBranch?: string
  name?: string
  prompt?: string
  model?: { providerID: string; id: string }
  port?: number
  dataRoot: string
  opencodeDataRoot: string
  binary: string
  attach: boolean
  abort: boolean
  githubLogin?: boolean
  githubRepos?: boolean
  title?: string
  body?: string
  base?: string
}

export function parseRemoteArguments(args: string[], env = process.env): RemoteOptions {
  const command = args[0] ?? "help"
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const result: RemoteOptions = {
    command, server: env.OCX_SERVER_URL ?? "", password: env.OPENCODE_PASSWORD,
    localPassword: env.OPENCODE_LOCAL_PASSWORD, dataRoot: env.OCX_DATA_HOME ?? join(dataHome, "ocx"),
    opencodeDataRoot: join(dataHome, "opencode"), binary: env.OCX_OPENCODE_BINARY ?? "opencode", attach: false, abort: false,
  }
  const values: Record<string, keyof RemoteOptions> = {
    "--server": "server", "--password": "password", "--local-server": "localServer", "--local-password": "localPassword",
    "--directory": "directory", "--workspace": "workspace", "--session": "session", "--transfer": "transfer",
    "--repo": "source", "--branch": "branch", "--new-branch": "newBranch", "--name": "name", "--prompt": "prompt",
    "--data-dir": "dataRoot", "--binary": "binary",
    "--title": "title", "--body": "body", "--base": "base",
  }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (["--help", "-h"].includes(arg)) { result.command = "help"; continue }
    if (arg === "--attach") { result.attach = true; continue }
    if (arg === "--abort") { result.abort = true; continue }
    if (arg === "--login") { result.githubLogin = true; continue }
    if (arg === "--repos") { result.githubRepos = true; continue }
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
    if (arg === "--port") {
      result.port = Number(value)
      if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error("Invalid preview port")
    } else if (arg === "--model") {
      const separator = value.indexOf("/")
      if (separator < 1 || separator === value.length - 1) throw new Error("Model must be provider/model")
      result.model = { providerID: value.slice(0, separator), id: value.slice(separator + 1) }
    } else if (values[arg]) Object.assign(result, { [values[arg]!]: value })
    else throw new Error(`Unknown remote option: ${arg}`)
  }
  return result
}

interface Receipt {
  version: 1
  id: string
  direction: "local-to-remote" | "remote-to-local"
  server: string
  localServer: string
  directory: string
  workspaceID: string
  projectID?: string
  sourceSessionID: string
  stage: string
  bundle?: SessionBundle
  relocated?: SessionBundle
  checkpoint?: GitCheckpoint
  imported?: string[]
  handoff?: Handoff
}

export interface RemoteLaunch { server: string; password?: string; sessionID: string; directory?: string; binary: string; local?: boolean }
interface Dependencies { fetch?: typeof fetch; log?: (text: string) => void }

export async function runRemoteCommand(options: RemoteOptions, dependencies: Dependencies = {}): Promise<RemoteLaunch | undefined> {
  const log = dependencies.log ?? console.log
  if (options.command === "help") { log(remoteUsage); return }
  if (!options.server) throw new Error("Remote commands require --server or OCX_SERVER_URL")
  const remote = new RemoteAPI(options.server, options.password, dependencies.fetch)
  const required = (key: "workspace" | "session" | "localServer" | "transfer") => {
    const value = options[key]
    if (!value) throw new Error(`--${key === "localServer" ? "local-server" : key} is required`)
    if (key !== "localServer") validID(value)
    return value
  }
  const launch = (sessionID: string, directory?: string): RemoteLaunch => ({ server: remote.origin, password: options.password, sessionID, binary: options.binary, directory })
  const receiptDirectory = join(resolve(options.dataRoot), "transfers", createHash("sha256").update(remote.origin).digest("hex").slice(0, 16))
  const save = async (receipt: Receipt) => {
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
    const path = join(receiptDirectory, `${validID(receipt.id)}.json`)
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(receipt, null, 2) + "\n")
      await file.sync()
      await file.close()
      await rename(temporary, path)
      // On POSIX, persist the rename before changing source ownership.
      if (process.platform !== "win32") {
        const directory = await open(receiptDirectory, "r")
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await file.close(); await rm(temporary, { force: true }) }
  }
  const handoffPath = (id: string) => `${handoffPrefix}/${validID(id)}`

  async function finish(receipt: Receipt): Promise<RemoteLaunch | undefined> {
    const local = new RemoteAPI(receipt.localServer, options.localPassword, dependencies.fetch)
    let handoff: Handoff | undefined
    try { handoff = (await remote.request<{ handoff: Handoff }>(handoffPath(receipt.id))).handoff } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
    }
    if (options.abort) {
      if (handoff?.state === "committed") throw new Error("Transfer is already committed; continue from its destination")
      if (handoff) await remote.request(`${handoffPath(receipt.id)}/abort`, "POST", {})
      if (receipt.direction === "local-to-remote") {
        for (const session of receipt.bundle?.sessions ?? []) await local.request(`/api/session/${validID(session.info.id)}`, "PATCH", {
          archived: Boolean(session.info.time?.archived), metadata: session.info.metadata ?? {},
        })
      } else {
        for (const id of receipt.relocated?.sessions.map(session => session.info.id) ?? []) {
          try { await local.request(`/api/session/${validID(id)}`, "PATCH", { archived: true }) }
          catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error }
        }
      }
      receipt.stage = "aborted"; await save(receipt)
      log(`Aborted transfer ${receipt.id}. Source is available; saved checkout and transcripts were retained.`)
      return
    }
    if (handoff?.state === "aborted") throw new Error("Transfer was aborted; start a new transfer")
    if (receipt.direction === "local-to-remote") {
      if (!receipt.bundle) { receipt.bundle = await exportSessionTree(local, receipt.sourceSessionID); await save(receipt) }
      if (!receipt.checkpoint) {
        receipt.checkpoint = await findLocalCheckpoint(receipt.directory, receipt.id) ??
          await captureCheckpoint({ directory: receipt.directory, workspaceID: receipt.workspaceID, id: receipt.id })
        if (receipt.checkpoint.manifest.workspaceID !== receipt.workspaceID) throw new Error("Local checkpoint belongs to another workspace")
        receipt.stage = "captured"; await save(receipt)
      }
      if (!handoff) {
        const { access } = await remote.request<{ workspace: Workspace; access: RepositoryAccess }>(workspacePrefix, "POST", {
          id: receipt.workspaceID, name: options.name, source: options.source ?? receipt.checkpoint.manifest.source, branch: receipt.checkpoint.manifest.branch ?? undefined, projectID: receipt.projectID,
        })
        await pushCheckpoint(receipt.directory, receipt.checkpoint, access)
        receipt.stage = "uploaded"; await save(receipt)
      }
      if (!handoff || handoff.state === "preparing") handoff = (await remote.request<{ handoff: Handoff }>(`${handoffPrefix}/receive`, "POST", {
        id: receipt.id, workspaceID: receipt.workspaceID, bundle: receipt.bundle, checkpointRef: receipt.checkpoint.ref,
      })).handoff
      receipt.handoff = handoff; receipt.stage = handoff.state === "committed" ? "awaiting-resume" : handoff.state; await save(receipt)
      if (handoff.state !== "ready" && handoff.state !== "committed")
        throw new Error("Remote transfer is not ready. Source remains available; run recover to retry preparation.")
      if (!handoff.destinationSessionID) throw new Error("Remote handoff has no destination session ID")
      validID(handoff.destinationSessionID)
      if (handoff.state !== "committed") {
        for (const session of receipt.bundle.sessions) await local.request(`/api/session/${validID(session.info.id)}`, "PATCH", {
          archived: true, metadata: { ...session.info.metadata, ocxHandoff: { id: receipt.id, direction: receipt.direction, server: receipt.server, workspaceID: receipt.workspaceID, destinationSessionID: handoff.destinationSessionID } },
        })
        receipt.stage = "source-archived"; await save(receipt)
      }
      // Ownership can commit before task admission succeeds. Re-committing is
      // idempotent and asks the server to repair that gap using its fixed input ID.
      handoff = (await remote.request<{ handoff: Handoff }>(`${handoffPath(receipt.id)}/commit`, "POST", { resume: true })).handoff
      if (handoff.state !== "committed" || handoff.resumeRequested !== true) {
        receipt.handoff = handoff; receipt.stage = "awaiting-resume"; await save(receipt)
        throw new Error("Remote continuation has not been admitted. Run recover to finish the transfer.")
      }
      receipt.handoff = handoff; receipt.stage = "committed"; await save(receipt)
      const id = handoff.destinationSessionID
      if (!id) throw new Error("Committed handoff has no destination session ID")
      log(`Thread continued remotely. Workspace ${receipt.workspaceID}; session ${id}. Transfer receipt ${receipt.id}.`)
      log(`Attach: ocx remote attach --server ${remote.origin} --workspace ${receipt.workspaceID} --session ${id}`)
      return options.attach ? launch(id) : undefined
    }
    if (!handoff || handoff.state === "preparing") handoff = (await remote.request<{ handoff: Handoff }>(handoffPrefix, "POST", {
      id: receipt.id, workspaceID: receipt.workspaceID, sessionID: receipt.sourceSessionID,
    })).handoff
    receipt.handoff = handoff; await save(receipt)
    if ((handoff.state !== "ready" && handoff.state !== "committed") || !handoff.checkpointRef || !handoff.session)
      throw new Error("Remote transfer is not ready; run recover after preparation finishes")
    if (!receipt.checkpoint) {
      let restored: GitCheckpoint | undefined
      try { restored = JSON.parse(await readFile(join(receipt.directory, ".git", "ocx-restored-checkpoint.json"), "utf8")) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (restored) {
        if (restored.ref !== handoff.checkpointRef || restored.manifest.workspaceID !== receipt.workspaceID) throw new Error("Destination contains another workspace checkpoint")
        receipt.checkpoint = restored
      } else {
        const { url, token } = await remote.request<RepositoryAccess>(`${workspacePrefix}/${validID(receipt.workspaceID)}/access`, "POST", { scope: "read" })
        receipt.stage = "restoring"; await save(receipt)
        receipt.checkpoint = await restoreCheckpoint({ directory: receipt.directory, remote: { url, token }, ref: handoff.checkpointRef })
      }
      receipt.stage = "restored"; await save(receipt)
    }
    if (!receipt.relocated) {
      receipt.relocated = relocateSessions(handoff.session as SessionBundle, receipt.directory)
      receipt.imported = []
      await save(receipt)
    }
    for (const session of receipt.relocated.sessions) {
      if (receipt.imported?.includes(session.info.id)) continue
      let existing: any
      try { existing = (await local.request(`/api/session/${validID(session.info.id)}`)).data } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error
      }
      if (existing) {
        if (existing.metadata?.ocxSourceSession !== session.info.metadata?.ocxSourceSession) throw new Error("Destination session ID belongs to another thread")
      } else await local.request("/api/experimental/session/import", "POST", {
        info: { ...session.info, time: { ...session.info.time, archived: Date.now() } },
        messages: session.messages, location: { directory: receipt.directory },
      })
      receipt.imported = [...receipt.imported ?? [], session.info.id]
      receipt.stage = "importing"; await save(receipt)
    }
    if (handoff.state !== "committed") handoff = (await remote.request<{ handoff: Handoff }>(`${handoffPath(receipt.id)}/commit`, "POST", { destinationSessionID: receipt.relocated.rootID })).handoff
    if (handoff.state !== "committed" || handoff.destinationSessionID !== receipt.relocated.rootID)
      throw new Error("Remote ownership has not committed to this local thread. Run recover before continuing locally.")
    receipt.handoff = handoff; receipt.stage = "opening-local"; await save(receipt)
    for (const session of receipt.relocated.sessions) await local.request(`/api/session/${validID(session.info.id)}`, "PATCH", { archived: false })
    receipt.stage = "committed"; await save(receipt)
    log(`Thread restored locally at ${receipt.directory}. Session ${receipt.relocated.rootID}. Transfer receipt ${receipt.id}.`)
    log(`Attach: opencode --server ${local.origin} --session ${receipt.relocated.rootID}`)
    return options.attach ? { server: local.origin, password: options.localPassword, sessionID: receipt.relocated.rootID, directory: receipt.directory, binary: options.binary, local: true } : undefined
  }

  if (options.command === "list") {
    const { workspaces } = await remote.request<{ workspaces: Workspace[] }>(workspacePrefix)
    log(workspaces.length ? workspaces.map(workspace => `${workspace.id}\t${workspace.state}\t${workspace.name}\t${workspace.branch ?? ""}`).join("\n") : "No remote workspaces. Use ocx remote new or ocx remote send.")
    return
  }
  if (options.command === "new") {
    if (!options.source) throw new Error("--repo is required")
    const { workspace } = await remote.request<{ workspace: Workspace }>(workspacePrefix, "POST", {
      id: randomUUID(), name: options.name, source: options.source, branch: options.branch, newBranch: options.newBranch, provision: true,
    })
    const { session } = await remote.request<{ session: { id: string } }>(`${workspacePrefix}/${validID(workspace.id)}/sessions`, "POST", { title: options.name, prompt: options.prompt, model: options.model })
    log(`Created remote workspace ${workspace.id}; session ${session.id}.`)
    log(`Attach: ocx remote attach --server ${remote.origin} --workspace ${workspace.id} --session ${session.id}`)
    return options.attach ? launch(session.id) : undefined
  }
  if (options.command === "attach") {
    const workspaceID = required("workspace")
    const { workspaces } = await remote.request<{ workspaces: Workspace[] }>(workspacePrefix)
    const workspace = workspaces.find(item => item.id === workspaceID)
    if (!workspace) throw new Error("Workspace was not found")
    const id = options.session ?? workspace.sessionIDs[0]
    if (!id || !workspace.sessionIDs.includes(id)) throw new Error("Select a session belonging to this workspace with --session")
    return launch(id)
  }
  if (options.command === "send") {
    const local = new RemoteAPI(required("localServer"), options.localPassword, dependencies.fetch)
    const sessionID = required("session")
    const source = (await local.request<{ data: { location?: { directory?: string }; metadata?: Record<string, any> } }>(`/api/session/${sessionID}`)).data
    if (source.metadata?.ocxHandoff) throw new Error("This source thread has already been handed off. Continue its destination or explicitly fork the source first.")
    const receipt: Receipt = {
      version: 1, id: randomUUID(), direction: "local-to-remote", server: remote.origin, localServer: local.origin,
      directory: resolve(options.directory ?? source.location?.directory ?? process.cwd()), workspaceID: randomUUID(), projectID: options.projectID, sourceSessionID: sessionID, stage: "started",
    }
    await save(receipt)
    log(`Preparing transfer ${receipt.id}. Recover with ocx remote recover --server ${remote.origin} --transfer ${receipt.id}.`)
    return finish(receipt)
  }
  if (options.command === "receive") {
    const local = new RemoteAPI(required("localServer"), options.localPassword, dependencies.fetch)
    const id = randomUUID()
    const workspaceID = required("workspace")
    const receipt: Receipt = {
      version: 1, id, direction: "remote-to-local", server: remote.origin, localServer: local.origin,
      directory: resolve(options.directory ?? join(options.opencodeDataRoot, "workspaces", workspaceID, id)),
      workspaceID, sourceSessionID: required("session"), stage: "started",
    }
    await save(receipt)
    log(`Preparing transfer ${id}. Recover with ocx remote recover --server ${remote.origin} --transfer ${id}.`)
    return finish(receipt)
  }
  if (options.command === "recover") {
    const id = required("transfer")
    const receipt = JSON.parse(await readFile(join(receiptDirectory, `${id}.json`), "utf8")) as Receipt
    if (receipt.version !== 1 || receipt.id !== id || receipt.server !== remote.origin) throw new Error("Invalid transfer receipt")
    if (receipt.stage === "aborted") throw new Error("Transfer was already aborted")
    if (options.localServer && options.localServer !== receipt.localServer) throw new Error("Transfer belongs to another local server")
    return finish(receipt)
  }
  if (options.command === "pause") {
    const { workspace } = await remote.request<{ workspace: Workspace }>(`${workspacePrefix}/${required("workspace")}/pause`, "POST", {})
    log(`Workspace ${workspace.id} is ${workspace.state}.`); return
  }
  if (options.command === "preview") {
    if (!options.port) throw new Error("--port is required")
    const { url } = await remote.request<{ url: string }>(`${workspacePrefix}/${required("workspace")}/preview`, "POST", { port: options.port })
    log(url); return
  }
  if (options.command === "pr") {
    if (!options.title) throw new Error("--title is required")
    const { url } = await remote.request<{ url: string }>(`${workspacePrefix}/${required("workspace")}/pull-request`, "POST", {
      title: options.title, body: options.body, base: options.base,
    })
    log(url); return
  }
  if (options.command === "github") {
    if (options.githubLogin) {
      const login = await remote.request<{ verification_uri: string; user_code: string; device_code: string; expires_in: number; interval?: number }>("/api/ocx/github/login", "POST", {})
      log(`Open ${login.verification_uri} and enter ${login.user_code}.`)
      const expires = Date.now() + login.expires_in * 1000
      let interval = Math.max(1, login.interval ?? 5)
      while (Date.now() < expires) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000))
        const result = await remote.request<{ connected?: boolean; pending?: boolean; error?: string; interval?: number }>("/api/ocx/github/poll", "POST", { device_code: login.device_code })
        if (result.connected) { log("GitHub connected."); return }
        if (!result.pending) throw new Error(result.error ?? "GitHub login failed")
        interval = Math.max(interval, result.interval ?? interval)
      }
      throw new Error("GitHub login expired; run the login command again")
    }
    if (options.githubRepos) {
      const repos = await remote.request<{ full_name: string; private: boolean }[]>("/api/ocx/github/repos")
      log(repos.map(repo => `${repo.full_name}${repo.private ? " (private)" : ""}`).join("\n")); return
    }
    const status = await remote.request<{ connected: boolean; deviceLoginAvailable: boolean }>("/api/ocx/github/status")
    log(status.connected ? "GitHub is connected." : status.deviceLoginAvailable ? "GitHub is not connected. Use ocx remote github --login." : "GitHub is not configured. Set GITHUB_CLIENT_ID or GITHUB_TOKEN on the Worker.")
    return
  }
  throw new Error(`Unknown remote command: ${options.command}\n\n${remoteUsage}`)
}

export async function exportSessionTree(api: RemoteAPI, rootID: string): Promise<SessionBundle> {
  const sessions: Transcript[] = []
  const seen = new Set<string>()
  const visit = async (id: string) => {
    validID(id)
    if (seen.has(id)) throw new Error("Session descendants contain a cycle")
    if (seen.size >= 100) throw new Error("Transfer exceeds 100 sessions; split the session tree")
    seen.add(id)
    await api.request(`/api/session/${id}/interrupt`, "POST")
    await api.request(`/api/experimental/session/${id}/wait`, "POST")
    const inbox = await api.request<{ data: unknown[] }>(`/api/session/${id}/inbox`)
    if (inbox.data.length) throw new Error(`Session ${id} has queued work. Drain or cancel its pending prompts before transferring.`)
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ parentID: id, limit: "100" })
      if (cursor) query.set("cursor", cursor)
      const page = await api.request<{ data: { id: string }[]; cursor?: { next?: string } }>(`/api/session?${query}`)
      for (const child of page.data) await visit(child.id)
      cursor = page.cursor?.next
    } while (cursor)
  }
  await visit(rootID)
  for (const id of seen) {
    await api.request(`/api/session/${id}/interrupt`, "POST")
    await api.request(`/api/experimental/session/${id}/wait`, "POST")
    const inbox = await api.request<{ data: unknown[] }>(`/api/session/${id}/inbox`)
    if (inbox.data.length) throw new Error(`Session ${id} has queued work. Drain or cancel its pending prompts before transferring.`)
  }
  for (const id of seen) sessions.push((await api.request<{ data: Transcript }>(`/api/experimental/session/${id}/export`)).data)
  return { rootID, sessions }
}
