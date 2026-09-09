import { type ChildProcessByStdio, spawn } from "node:child_process"
import type { Readable } from "node:stream"

const MAX_LOG_BYTES = 128 * 1024

export type ProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  error?: string
}

export type ManagedProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>
  closed: Promise<ProcessExit>
  output: () => string
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.OPENCODE_DEVICE_TOKEN
  delete environment.OPENCODE_PASSWORD
  delete environment.DEVICE_MCP_TOKEN
  delete environment.DEVICE_MCP_SERVERS
  return environment
}

export function startProcess(command: string, args: string[], cwd: string, env = childEnvironment()): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    env,
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

export function terminateProcess(process: ManagedProcess | undefined, signal: NodeJS.Signals = "SIGTERM", graceMs = 1000): void {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return
  if (signal === "SIGTERM") {
    const timer = setTimeout(() => terminateProcess(process, "SIGKILL"), graceMs)
    timer.unref()
    void process.closed.then(() => clearTimeout(timer))
  }
  if (process.child.pid && globalThis.process.platform !== "win32") {
    try {
      globalThis.process.kill(-process.child.pid, signal)
      return
    } catch {
      // Fall through and terminate only the direct child.
    }
  }
  process.child.kill(signal)
}

export async function stopProcess(process: ManagedProcess | undefined, graceMs = 2000): Promise<void> {
  if (!process) return
  terminateProcess(process, "SIGTERM", graceMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = await Promise.race([process.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), graceMs) })])
  clearTimeout(timer)
  if (!stopped) {
    terminateProcess(process, "SIGKILL")
    await process.closed
  }
}
