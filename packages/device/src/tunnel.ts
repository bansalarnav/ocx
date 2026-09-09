import { fileURLToPath } from "node:url"
import { startProcess, stopProcess, type ManagedProcess } from "./process.js"

export const tunnelStartupTimeout = 300_000

export function launchTunnel(port: number, cwd = process.cwd()): ManagedProcess {
  return startProcess(process.execPath, [fileURLToPath(new URL("./tunnel-worker.ts", import.meta.url)), String(port)], cwd)
}

export async function waitForTunnel(tunnel: ManagedProcess, timeout = tunnelStartupTimeout, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    for (const line of tunnel.output().split("\n")) {
      try {
        const value = JSON.parse(line)
        if (value.type !== "ready") continue
        const url = new URL(value.url)
        if (url.protocol === "https:" && url.hostname.endsWith(".opentunnel.xyz") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url.origin
      } catch { /* SDK progress lines are not readiness messages. */ }
    }
    const exit = await Promise.race([tunnel.closed, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 100))])
    if (exit) throw new Error(`OpenTunnel exited before connecting: ${tunnel.output().trim() || exit.error || exit.code}`)
  }
  throw new Error(`Timed out waiting for OpenTunnel certificate and connection: ${tunnel.output().trim()}`)
}

export const stopTunnel = (tunnel?: ManagedProcess) => stopProcess(tunnel, 3000)
