import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ApiError, RemoteAPI } from "./remote-api"
import { parseRemoteArguments, runRemoteCommand, type RemoteLaunch } from "./remote"
import { validID, workspacePrefix, type Workspace } from "@ocx/protocol/workspaces"

interface Connection { server: string; password?: string }
export interface ControlBridgeOptions {
  dataRoot: string
  binary: string
  local: Connection
  initialRemote?: Connection
  initialMode?: "local" | "remote"
  onSwitch: (launch: RemoteLaunch) => void | Promise<void>
  fetch?: typeof fetch
}
interface Journal {
  version: number; id: string; server: string; localServer: string
  direction: string; stage: string; workspaceID?: string; sourceSessionID?: string; directory?: string
}

/** The TUI receives only this short-lived loopback capability. Provider and
 * OpenCode passwords stay in its parent launcher and private connection file. */
export async function createControlBridge(options: ControlBridgeOptions) {
  const directory = resolve(options.dataRoot)
  const connectionFile = join(directory, "connection.json")
  const local = new RemoteAPI(options.local.server, options.local.password, options.fetch)
  const token = randomBytes(32).toString("hex")
  const expectedToken = Buffer.from(`Bearer ${token}`)
  const abort = new AbortController()
  const baseFetch = options.fetch ?? globalThis.fetch
  const requestFetch: typeof fetch = (input, init = {}) => baseFetch(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal,
  })
  let remote: Connection | undefined
  let mode = options.initialMode ?? "local"
  let connected = false
  let progress: string | undefined
  let error: string | undefined
  let pending: RemoteLaunch | undefined
  let mutation: Promise<unknown> = Promise.resolve()
  let stopped = false
  let activeTransfer: string | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  type Summary = Pick<Journal, "id" | "direction" | "stage" | "workspaceID" | "sourceSessionID" | "directory">
  const summaryCache = new Map<string, { stamp: string; summary: Summary }>()

  const redact = (message: string) => {
    for (const password of [remote?.password, options.local.password]) {
      if (password) message = message.replaceAll(password, "[redacted]").replaceAll(Buffer.from(`opencode:${password}`).toString("base64"), "[redacted]")
    }
    return message
  }
  const api = () => {
    if (!remote) throw new Error("Connect your remote OpenCode server first")
    return new RemoteAPI(remote.server, remote.password, requestFetch)
  }
  const persist = async (connection: Connection) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${connectionFile}.${randomUUID()}.tmp`
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify({ version: 1, remote: connection }) + "\n")
      await file.sync()
      await file.close()
      await rename(temporary, connectionFile)
    } finally { await file.close(); await rm(temporary, { force: true }) }
  }
  const validateConnection = (value: unknown): Connection => {
    if (!value || typeof value !== "object" || typeof (value as Connection).server !== "string") throw new Error("A remote server URL is required")
    const connection = value as Connection
    if (connection.password !== undefined && typeof connection.password !== "string") throw new Error("Server password must be text")
    const validated = new RemoteAPI(connection.server, connection.password, requestFetch)
    return { server: validated.origin, password: connection.password }
  }
  const probe = async (connection: Connection) => {
    const probeFetch: typeof fetch = (input, init = {}) => requestFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
    const result = await new RemoteAPI(connection.server, connection.password, probeFetch).request<{ workspaces: Workspace[] }>(workspacePrefix)
    if (!result || !Array.isArray(result.workspaces)) throw new Error("This server does not support remote workspaces")
  }
  try {
    if (options.initialRemote) remote = validateConnection(options.initialRemote)
    else {
      let saved: { version?: number; remote?: unknown } | undefined
      try { saved = JSON.parse(await readFile(connectionFile, "utf8")) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause }
      if (saved) {
        if (saved.version !== 1) throw new Error("Unsupported saved connection format")
        remote = validateConnection(saved.remote)
      }
    }
    if (remote) {
      const connection = remote
      // A remembered remote must never delay ordinary local OpenCode startup.
      void probe(connection).then(async () => {
        if (stopped || remote !== connection) return
        connected = true
        if (options.initialRemote) await persist(connection)
      }).catch(cause => { if (!stopped && remote === connection) error = redact(cause instanceof Error ? cause.message : String(cause)) })
    }
  } catch (cause) { error = redact(cause instanceof Error ? cause.message : String(cause)) }

  const receiptDirectory = () => remote && join(directory, "transfers", createHash("sha256").update(remote.server).digest("hex").slice(0, 16))
  const journal = async (id: string): Promise<Journal> => {
    const root = receiptDirectory()
    if (!root || !remote) throw new Error("Connect your remote OpenCode server first")
    const value = JSON.parse(await readFile(join(root, `${validID(id)}.json`), "utf8")) as Journal
    if (value.version !== 1 || value.id !== id || value.server !== remote.server) throw new Error("Transfer receipt belongs to another server")
    new RemoteAPI(value.localServer)
    return value
  }
  const transfers = async () => {
    const root = receiptDirectory()
    if (!root) return []
    let files: string[]
    try { files = await readdir(root) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause }
    const summaries = []
    for (const file of files.sort()) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(file)) continue
      try {
        const path = join(root, file)
        const metadata = await lstat(path)
        if (!metadata.isFile()) continue
        const stamp = `${metadata.ino}:${metadata.mtimeMs}:${metadata.size}`
        const previous = summaryCache.get(path)
        if (previous?.stamp === stamp) { summaries.push(previous.summary); continue }
        const receipt = await journal(file.slice(0, -5))
        const summary = { id: receipt.id, direction: receipt.direction, stage: receipt.stage, workspaceID: receipt.workspaceID, sourceSessionID: receipt.sourceSessionID, directory: receipt.directory }
        summaryCache.set(path, { stamp, summary })
        summaries.push(summary)
      } catch { /* A truncated journal must not hide other recoverable transfers. */ }
    }
    return summaries
  }
  const text = (input: Record<string, unknown>, name: string, required = false) => {
    const value = input[name]
    if (value === undefined || value === "") {
      if (required) throw new Error(`${name} is required`)
      return undefined
    }
    if (typeof value !== "string") throw new Error(`${name} must be text`)
    return value
  }
  const sanitizedLaunch = (launch: RemoteLaunch) => ({ sessionID: launch.sessionID, local: launch.local === true, server: launch.local ? local.origin : remote?.server, directory: launch.directory })
  const ready = (launch: RemoteLaunch | undefined, messages: string[] = []) => {
    if (launch) pending = launch
    return { ...(launch ? { launch: sanitizedLaunch(launch) } : {}), messages }
  }
  const execute = async (command: string, input: Record<string, unknown>) => {
    const connection = api()
    const settings = parseRemoteArguments([command, "--server", connection.origin, "--data-dir", directory, "--binary", options.binary, "--attach"], {})
    Object.assign(settings, {
      password: connection.password, localServer: local.origin, localPassword: options.local.password,
      workspace: text(input, "workspaceID"), session: text(input, "sessionID"), transfer: text(input, "transferID"),
      directory: text(input, "directory"), source: text(input, "source"), branch: text(input, "branch"), newBranch: text(input, "newBranch"),
      prompt: text(input, "prompt"), name: text(input, "name"), title: text(input, "title"), body: text(input, "body"), base: text(input, "base"),
      abort: input.abort === true,
    })
    if (input.model !== undefined) {
      if (typeof input.model === "string") {
        const separator = input.model.indexOf("/")
        if (separator < 1 || separator === input.model.length - 1) throw new Error("Model must be provider/model")
        settings.model = { providerID: input.model.slice(0, separator), id: input.model.slice(separator + 1) }
      } else if (input.model && typeof input.model === "object") {
        const model = input.model as Record<string, unknown>
        settings.model = { providerID: text(model, "providerID", true)!, id: text(model, model.id === undefined ? "modelID" : "id", true)! }
      } else throw new Error("Invalid model selection")
    }
    let fetcher = requestFetch
    if (command === "recover") {
      const receipt = await journal(text(input, "transferID", true)!)
      const original = new RemoteAPI(receipt.localServer).origin
      if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(original).hostname) || original === connection.origin)
        throw new Error("This transfer belongs to a different local backend")
      settings.localServer = original
      // The managed backend may get a different loopback port on restart. Never
      // contact an old journal's port; route its local requests to this backend.
      fetcher = (request, init) => {
        const incoming = new Request(request, init)
        if (new URL(incoming.url).origin !== original) return requestFetch(request, init)
        const url = new URL(incoming.url)
        return requestFetch(new Request(new URL(url.pathname + url.search, local.origin), incoming))
      }
    }
    const messages: string[] = []
    const launch = await runRemoteCommand(settings, { fetch: fetcher, log: message => {
      const preparing = message.match(/^Preparing transfer ([a-zA-Z0-9_-]+)\./)
      if (preparing) activeTransfer = preparing[1]
      const visible = preparing ? "Saving your conversation and checkout…"
        : message.startsWith("Thread continued remotely") ? "Your thread is ready remotely."
        : message.startsWith("Thread restored locally") ? "Your thread is ready locally."
        : message.startsWith("Created remote workspace") ? "Your remote thread is ready."
        : message.startsWith("Aborted transfer") ? "Transfer canceled. Your source thread is available."
        : undefined
      if (visible) { progress = visible; messages.push(visible) }
    } })
    activeTransfer = undefined
    if (launch?.local) { launch.server = local.origin; launch.password = options.local.password }
    connected = true
    return ready(launch, messages)
  }

  const action = async (input: Record<string, unknown>) => {
    const name = text(input, "action", true)!
    if (name === "configure") {
      const connection = validateConnection(input)
      await probe(connection)
      await persist(connection)
      remote = connection; connected = true; error = undefined; pending = undefined
      // An attached TUI still belongs to the old server. Return it to local
      // before allowing workspace actions against the new connection.
      const changed = mode === "remote" ? ready({ server: local.origin, password: options.local.password,
        sessionID: "", binary: options.binary, local: true }) : {}
      return { connected: true, remote: { server: connection.server }, ...changed }
    }
    if (name === "reconnect") {
      if (!remote) throw new Error("Connect your remote OpenCode server first")
      await probe(remote)
      connected = true; error = undefined
      return { connected: true }
    }
    if (name === "workspaces") return api().request(workspacePrefix)
    if (name === "sessions") {
      const id = validID(text(input, "workspaceID", true)!)
      const { workspace } = await api().request<{ workspace: Workspace }>(`${workspacePrefix}/${id}`)
      const sessions = await Promise.all(workspace.sessionIDs.map(async id => (await api().request(`/api/session/${validID(id)}`)).data))
      return { sessions }
    }
    if (name === "repositories") return api().request("/api/ocx/github/repos")
    if (name === "branches") {
      const repository = text(input, "repository", true)!
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Repository must be owner/repo")
      return api().request(`/api/ocx/github/branches?repo=${encodeURIComponent(repository)}`)
    }
    if (name === "githubStatus") return api().request("/api/ocx/github/status")
    if (name === "githubLoginStart") return api().request("/api/ocx/github/login", "POST", {})
    if (name === "githubLoginPoll") return api().request("/api/ocx/github/poll", "POST", { device_code: text(input, "device_code", true) })
    if (["new", "send", "receive", "recover"].includes(name)) return execute(name, input)
    if (name === "switch") return execute("attach", input)
    if (name === "switchLocal") {
      const sessionID = text(input, "sessionID")
      if (!sessionID) return ready({ server: local.origin, password: options.local.password, sessionID: "", directory: text(input, "directory"), binary: options.binary, local: true })
      const session = (await local.request(`/api/session/${validID(sessionID)}`)).data
      return ready({ server: local.origin, password: options.local.password, sessionID, directory: text(input, "directory") ?? session.location?.directory, binary: options.binary, local: true })
    }
    if (name === "activate") {
      if (!pending) throw new Error("No prepared thread to open")
      const launch = pending
      pending = undefined
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (stopped) return
        mode = launch.local ? "local" : "remote"
        void Promise.resolve().then(() => options.onSwitch(launch)).catch(cause => { error = redact(String(cause)) })
      }, 100)
      timers.add(timer)
      return { activating: true, launch: sanitizedLaunch(launch) }
    }
    if (!["pause", "preview", "pr"].includes(name)) throw new Error(`Unknown action: ${name}`)
    const workspaceID = validID(text(input, "workspaceID", true)!)
    if (name === "pause") return api().request(`${workspacePrefix}/${workspaceID}/pause`, "POST", {})
    if (name === "preview") {
      const port = Number(input.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port")
      return api().request(`${workspacePrefix}/${workspaceID}/preview`, "POST", { port })
    }
    if (name === "pr") return api().request(`${workspacePrefix}/${workspaceID}/pull-request`, "POST", { title: text(input, "title", true), body: text(input, "body"), base: text(input, "base") })
    throw new Error(`Unknown action: ${name}`)
  }
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
  // Keep the dependency surface small: this file is bundled by Bun for the
  // launcher, while the rest of the client also typechecks against Node types.
  const bun = (globalThis as unknown as { Bun: { serve(options: { hostname: string; port: number; maxRequestBodySize: number; fetch(request: Request): Promise<Response> }): { port: number; stop(closeActiveConnections?: boolean): Promise<void> | void } } }).Bun
  let origin = ""
  const server = bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.headers.get("host") !== new URL(origin).host || (request.headers.has("origin") && request.headers.get("origin") !== origin)) return json({ error: "Forbidden origin" }, 403)
      const supplied = Buffer.from(request.headers.get("authorization") ?? "")
      if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) return json({ error: "Unauthorized" }, 401)
      if (request.method === "GET" && url.pathname === "/state") {
        const receipts = await transfers()
        const current = activeTransfer && receipts.find(receipt => receipt.id === activeTransfer)
        const stages: Record<string, string> = {
          started: "Saving your conversation…", captured: "Uploading your checkout…", uploaded: "Preparing the remote workspace…",
          preparing: "Preparing your workspace…", ready: "Preparing the thread handoff…", "source-archived": "Starting the remote continuation…",
          "awaiting-resume": "Starting the remote continuation…", restoring: "Downloading your checkout…", restored: "Restoring your conversation…", importing: "Restoring your conversation…", "opening-local": "Opening your local conversation…",
        }
        return json({
          mode, connected, remote: remote ? { server: remote.server } : undefined, local: { server: local.origin },
          progress: current && stages[current.stage] || progress, error, transfers: receipts, pending: pending ? sanitizedLaunch(pending) : undefined,
        })
      }
      if (request.method !== "POST" || url.pathname !== "/action") return json({ error: "Not found" }, 404)
      try {
        const content = await request.text()
        if (new TextEncoder().encode(content).byteLength > 256 * 1024) throw new Error("Action is too large")
        const input = JSON.parse(content)
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an action object")
        const name = text(input, "action", true)!
        const readonly = ["workspaces", "sessions", "repositories", "branches", "githubStatus"].includes(name)
        const perform = async () => {
          if (stopped) throw new Error("Launcher is stopping")
          if (!readonly) {
            const labels: Record<string, string> = {
              configure: "Connecting to your server…", new: "Preparing your remote thread…", send: "Saving your conversation and checkout…",
              receive: "Preparing your local checkout…", recover: "Recovering your transfer…", switch: "Opening your remote thread…",
              switchLocal: "Opening local OpenCode…", pause: "Saving and pausing the workspace…", preview: "Opening the preview…",
              pr: "Preparing your pull request…", githubLoginStart: "Starting GitHub sign-in…", githubLoginPoll: "Waiting for GitHub sign-in…", activate: "Opening your thread…",
            }
            progress = labels[name] ?? "Preparing your request…"; error = undefined; activeTransfer = undefined
            if (["new", "send", "receive", "recover", "switch", "switchLocal"].includes(name)) pending = undefined
          }
          const data = await action(input)
          if (!readonly && !["new", "send", "receive", "recover"].includes(name)) progress = name === "activate" ? "Opening your thread…" : "Ready."
          return data
        }
        const operation = readonly ? perform() : mutation.catch(() => {}).then(perform)
        if (!readonly) mutation = operation
        return json({ data: await operation })
      } catch (cause) {
        const message = redact(cause instanceof Error ? cause.message : String(cause))
        error = message
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) connected = false
        const recoverable = (await transfers()).some(transfer => !["committed", "aborted"].includes(transfer.stage))
        return json({ error: message, recoverable }, cause instanceof ApiError && cause.status === 409 ? 409 : 400)
      }
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return { origin, token, async stop() {
    stopped = true
    abort.abort()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    await server.stop(true)
  } }
}
