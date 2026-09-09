import { launchTunnel, stopTunnel, waitForTunnel } from "./tunnel.js"

const port = Number(process.env.OPENCODE_DEVICE_PORT ?? "7331")
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid OPENCODE_DEVICE_PORT")
const tunnel = launchTunnel(port)
const controller = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort())
console.error("Starting OpenTunnel. Certificate issuance can take a few minutes...")
try {
  const url = await waitForTunnel(tunnel, undefined, controller.signal)
  console.log(`Device MCP: ${url}/mcp`)
  const exit = await Promise.race([
    tunnel.closed,
    new Promise<undefined>(resolve => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
  ])
  if (exit && !controller.signal.aborted) process.exitCode = exit.code || 1
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error ? error.message : "OpenTunnel failed")
    process.exitCode = 1
  }
} finally {
  await stopTunnel(tunnel)
}
