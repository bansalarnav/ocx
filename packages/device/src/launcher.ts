import { launchTunnel, waitForTunnel, stopTunnel, tunnelStartupTimeout } from "./tunnel.js"
import { randomBytes } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { startProcess, stopProcess, type ManagedProcess } from "./process.js"

/** Owns every child from spawn through startup failure, interruption, and normal exit. */
export class DeviceSharing {
  private server?: ManagedProcess
  private tunnel?: ManagedProcess
  private stopping = false
  private stopped?: Promise<void>

  async start(root: string, signal: AbortSignal) {
    root = await realpath(root)
    if (!(await stat(root)).isDirectory()) throw new Error("Device root must be a directory")
    signal.throwIfAborted()
    const token = randomBytes(32).toString("hex")
    const env = { ...process.env }
    delete env.OPENCODE_PASSWORD
    delete env.DEVICE_MCP_TOKEN
    delete env.DEVICE_MCP_SERVERS
    this.server = startProcess(process.execPath, [fileURLToPath(new URL("./server.ts", import.meta.url))], root, {
      ...env,
      OPENCODE_DEVICE_ROOT: root,
      OPENCODE_DEVICE_HOST: "127.0.0.1",
      OPENCODE_DEVICE_PORT: "0",
      OPENCODE_DEVICE_TOKEN: token,
    })
    try {
      const deadline = Date.now() + 15_000
      let port: string | undefined
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        port = this.server.output().match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/)?.[1]
        if (port) break
        const exit = await Promise.race([this.server.closed, delay(100).then(() => undefined)])
        if (exit) throw new Error(`Device MCP failed to start: ${exit.error ?? this.server.output()}`)
      }
      if (!port) throw new Error("Timed out starting device MCP")
      signal.throwIfAborted()
      this.tunnel = launchTunnel(Number(port), root)
      const url = await waitForTunnel(this.tunnel, tunnelStartupTimeout, signal)
      // Confirm public routing before sending the endpoint to the Worker.
      const reachableDeadline = Date.now() + 30_000
      while (true) {
        signal.throwIfAborted()
        try {
          const response = await fetch(url + "/health", { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: "error" })
          if (response.ok && (await response.json() as { ok?: boolean }).ok === true) break
        } catch { signal.throwIfAborted() }
        if (Date.now() > reachableDeadline) throw new Error("OpenTunnel did not become reachable")
        await this.checkRunning()
        await delay(250)
      }
      return { id: randomBytes(8).toString("hex"), url: url + "/mcp", token }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  private async checkRunning() {
    for (const child of [this.server, this.tunnel]) {
      if (child && (child.child.exitCode !== null || child.child.signalCode !== null)) {
        throw new Error("Device MCP or OpenTunnel stopped unexpectedly")
      }
    }
  }

  async watch(signal: AbortSignal): Promise<never> {
    while (true) {
      signal.throwIfAborted()
      if (!this.stopping) await this.checkRunning()
      await delay(250)
    }
  }

  stop(): Promise<void> {
    this.stopping = true
    return this.stopped ??= Promise.all([stopTunnel(this.tunnel), stopProcess(this.server, 3000)]).then(() => {})
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
