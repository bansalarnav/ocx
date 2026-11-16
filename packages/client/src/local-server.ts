import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { startProcess, stopProcess, type ManagedProcess, type ProcessExit } from "../../device/src/process"

export interface OwnedLocalServer {
  server: string
  password: string
  closed: Promise<ProcessExit>
  stop(): Promise<void>
}

interface ServiceRegistration { url: string; pid: number; password?: string; version?: string }
const processRunning = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    return false
  }
}

/** Reuse the process that owns normal OpenCode sessions. Never start a second
 * executor on its SQLite database or terminate an existing user service. */
export async function discoverLocalServer(env: NodeJS.ProcessEnv, signal: AbortSignal, request: typeof fetch = fetch): Promise<OwnedLocalServer | undefined> {
  const state = join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode")
  for (const name of ["service.json", "server.json"]) {
    let registration: ServiceRegistration
    try { registration = JSON.parse(await readFile(join(state, name), "utf8")) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new Error(`Cannot read OpenCode service registration ${name}`)
    }
    if (!Number.isSafeInteger(registration.pid) || registration.pid < 1) throw new Error("Invalid OpenCode service process identity")
    if (!processRunning(registration.pid)) continue
    let url: URL
    try { url = new URL(registration.url) } catch { throw new Error("Invalid registered OpenCode server URL") }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("The running OpenCode service must advertise a loopback HTTP address")
    let password = registration.password
    if (!password && name === "server.json") {
      try { password = await readFile(join(state, "password"), "utf8") } catch { /* Verified below. */ }
    }
    if (typeof password !== "string" || !password) throw new Error("The running OpenCode service has no usable credential")
    try {
      const response = await request(new URL("/api/info", url), {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: "error",
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error("health request failed") }
      const info = await response.json() as { version?: string; pid?: number }
      if (!info.version?.startsWith("2.") || info.pid !== registration.pid) throw new Error("service identity mismatch")
    } catch (error) {
      signal.throwIfAborted()
      throw new Error("A registered OpenCode process is running but could not be authenticated. Resolve its service state before starting another server.", { cause: error })
    }
    let timer: ReturnType<typeof setInterval>
    const closed = new Promise<ProcessExit>(resolve => {
      timer = setInterval(() => {
        if (!processRunning(registration.pid)) { clearInterval(timer); resolve({ code: null, signal: null, error: "Existing OpenCode service stopped" }) }
      }, 1000)
      timer.unref()
    })
    return { server: url.origin, password, closed, stop: async () => { clearInterval(timer) } }
  }
}

async function availablePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", resolve)
  })
  const address = listener.address()
  const port = address && typeof address === "object" ? address.port : undefined
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  if (!port) throw new Error("Could not allocate a local OpenCode port")
  return port
}

/** Own the local backend independently of whichever TUI is currently attached. */
export async function startLocalServer(input: {
  binary: string
  config?: string | null
  signal: AbortSignal
  env?: NodeJS.ProcessEnv
  startupTimeout?: number
}, dependencies: {
  start?: typeof startProcess
  stop?: typeof stopProcess
  fetch?: typeof fetch
  port?: () => Promise<number>
  discover?: typeof discoverLocalServer
} = {}): Promise<OwnedLocalServer> {
  input.signal.throwIfAborted()
  const existing = await (dependencies.discover ?? discoverLocalServer)(input.env ?? process.env, input.signal, dependencies.fetch)
  if (existing) return existing
  const port = await (dependencies.port ?? availablePort)()
  const password = randomBytes(32).toString("hex")
  const server = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env), OPENCODE_PASSWORD: password }
  // A TUI's disposable config must never replace the backend's normal config.
  delete env.OCX_CONTROL_ORIGIN
  delete env.OCX_CONTROL_TOKEN
  delete env.OCX_MODE
  delete env.OCX_PROXY_ORIGIN
  if (input.config) env.OPENCODE_CONFIG = input.config
  const child: ManagedProcess = (dependencies.start ?? startProcess)(input.binary,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)], process.cwd(), env)
  const stop = () => (dependencies.stop ?? stopProcess)(child)
  const expires = Date.now() + (input.startupTimeout ?? 30_000)
  try {
    while (Date.now() < expires) {
      input.signal.throwIfAborted()
      const exited = child.child.exitCode !== null || child.child.signalCode !== null
      if (exited) {
        const result = await child.closed
        throw new Error(`Local OpenCode server stopped during startup: ${result.error ?? child.output()}`)
      }
      try {
        const response = await (dependencies.fetch ?? fetch)(`${server}/api/info`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(1000)]), redirect: "error",
        })
        if (response.ok) {
          const info = await response.json() as { version?: string }
          if (info.version) return { server, password, closed: child.closed, stop }
        } else await response.body?.cancel()
      } catch { input.signal.throwIfAborted() }
      const exit = await Promise.race([
        child.closed,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 100)),
      ])
      if (exit) throw new Error(`Local OpenCode server failed to start: ${exit.error ?? child.output()}`)
    }
    throw new Error("Timed out starting local OpenCode. Install a compatible stable OpenCode CLI and retry.")
  } catch (error) { await stop(); throw error }
}
