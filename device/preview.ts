import { randomBytes } from "node:crypto"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import { connect } from "node:net"
import type { Readable } from "node:stream"

const MAX_LOG_BYTES = 128 * 1024

type ProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  error?: string
}

type ManagedProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>
  closed: Promise<ProcessExit>
  output: () => string
}

export type PreviewInfo = {
  id: string
  name: string
  port: number
  url: string
  command?: string
  workdir: string
  createdAt: string
  status: "running" | "stopping" | "failed"
  error?: string
}

type Preview = PreviewInfo & {
  server?: ManagedProcess
  tunnel: ManagedProcess
}

export type StartPreviewInput = {
  port: number
  command?: string
  workdir: string
  name?: string
  startupTimeout: number
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.OPENCODE_DEVICE_TOKEN
  return environment
}

function startProcess(command: string, args: string[], cwd: string): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    env: childEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""

  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8")
    if (Buffer.byteLength(output) > MAX_LOG_BYTES) {
      output = output.slice(-MAX_LOG_BYTES)
    }
  }
  child.stdout.on("data", append)
  child.stderr.on("data", append)

  const closed = new Promise<ProcessExit>((resolve) => {
    let settled = false
    const finish = (exit: ProcessExit) => {
      if (settled) return
      settled = true
      resolve(exit)
    }
    child.once("error", (error) => finish({ code: null, signal: null, error: error.message }))
    child.once("close", (code, signal) => finish({ code, signal }))
  })

  return { child, closed, output: () => output }
}

function terminateProcess(process: ManagedProcess | undefined): void {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return
  if (process.child.pid && globalThis.process.platform !== "win32") {
    try {
      globalThis.process.kill(-process.child.pid, "SIGTERM")
      return
    } catch {
      // Fall through and terminate only the direct child.
    }
  }
  process.child.kill("SIGTERM")
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    socket.setTimeout(500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    const unavailable = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once("error", unavailable)
    socket.once("timeout", unavailable)
  })
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForPort(port: number, timeout: number, server?: ManagedProcess): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return
    if (server) {
      const exit = await Promise.race([server.closed, delay(100).then(() => undefined)])
      if (exit) {
        throw new Error(`Preview command exited before opening port ${port}: ${server.output().trim() || JSON.stringify(exit)}`)
      }
    } else {
      await delay(100)
    }
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`)
}

async function waitForTunnel(tunnel: ManagedProcess, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const match = tunnel.output().match(/Forwarding\s+(https:\/\/\S+)/)
    if (match?.[1]) return match[1]
    const exit = await Promise.race([tunnel.closed, delay(100).then(() => undefined)])
    if (exit) {
      throw new Error(`tnlc exited before publishing a URL: ${tunnel.output().trim() || JSON.stringify(exit)}`)
    }
  }
  throw new Error(`Timed out waiting for tnlc: ${tunnel.output().trim()}`)
}

function exitMessage(label: string, exit: ProcessExit, output: string): string {
  const reason = exit.error ?? exit.signal ?? `code ${exit.code ?? "unknown"}`
  const logs = output.trim()
  return `${label} exited with ${reason}${logs ? `\n${logs}` : ""}`
}

export class PreviewManager {
  private readonly previews = new Map<string, Preview>()

  async start(input: StartPreviewInput): Promise<PreviewInfo> {
    const id = randomBytes(8).toString("hex")
    const name = input.name ?? process.env.OPENCODE_PREVIEW_NAME ?? "opencode-preview"
    const conflict = Array.from(this.previews.values()).find((preview) => preview.status === "running" && preview.name === name)
    if (conflict) {
      throw new Error(`Preview hostname ${name} is already in use by preview ${conflict.id}; stop it first or provide another name`)
    }
    let server: ManagedProcess | undefined
    let tunnel: ManagedProcess | undefined

    try {
      if (input.command) {
        server = startProcess(process.env.SHELL ?? "/bin/sh", ["-lc", input.command], input.workdir)
      }
      await waitForPort(input.port, input.startupTimeout, server)

      tunnel = startProcess("tnlc", ["expose", String(input.port), "--name", name], input.workdir)
      const url = await waitForTunnel(tunnel, input.startupTimeout)
      const preview: Preview = {
        id,
        name,
        port: input.port,
        url,
        command: input.command,
        workdir: input.workdir,
        createdAt: new Date().toISOString(),
        status: "running",
        server,
        tunnel,
      }
      this.previews.set(id, preview)
      this.watch(preview)
      return this.info(preview)
    } catch (error) {
      terminateProcess(tunnel)
      terminateProcess(server)
      throw error
    }
  }

  list(): PreviewInfo[] {
    return Array.from(this.previews.values(), (preview) => this.info(preview))
  }

  stop(id: string): PreviewInfo {
    const preview = this.previews.get(id)
    if (!preview) throw new Error(`Preview not found: ${id}`)
    preview.status = "stopping"
    terminateProcess(preview.tunnel)
    terminateProcess(preview.server)
    this.previews.delete(id)
    return this.info(preview)
  }

  stopAll(): void {
    for (const preview of this.previews.values()) {
      preview.status = "stopping"
      terminateProcess(preview.tunnel)
      terminateProcess(preview.server)
    }
    this.previews.clear()
  }

  private info(preview: Preview): PreviewInfo {
    const { server: _server, tunnel: _tunnel, ...info } = preview
    return { ...info }
  }

  private watch(preview: Preview): void {
    void preview.tunnel.closed.then((exit) => {
      if (preview.status !== "running") return
      preview.status = "failed"
      preview.error = exitMessage("tnlc", exit, preview.tunnel.output())
      terminateProcess(preview.server)
    })
    if (preview.server) {
      void preview.server.closed.then((exit) => {
        if (preview.status !== "running") return
        preview.status = "failed"
        preview.error = exitMessage("Preview command", exit, preview.server?.output() ?? "")
        terminateProcess(preview.tunnel)
      })
    }
  }
}
