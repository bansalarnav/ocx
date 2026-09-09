import { create, OpenTunnelStorage } from "@opentunnel/client"

// Run the embedded SDK in an owned child so process shutdown also closes its TLS sockets.
const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid tunnel port")
const client = create({ store: OpenTunnelStorage.memory() })
let stopping = false

async function stop(code: number) {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(code), 1500)
  try {
    await client.tunnel.remove().catch(() => {})
    await client.dispose()
  } finally {
    clearTimeout(deadline)
    process.exit(code)
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop(0) })

try {
  let stage = ""
  await client.tunnel.create({ onProgress: next => {
    if (next !== stage) console.error(`OpenTunnel: ${next}`)
    stage = next
  } })
  const route = await client.route.add({ name: "device", target: `127.0.0.1:${port}` })
  const connection = await client.tunnel.connect()
  console.log(JSON.stringify({ type: "ready", url: `https://${route.hostname}` }))
  await connection.closed
  if (!stopping) {
    console.error("OpenTunnel connection closed")
    await stop(1)
  }
} catch (error) {
  // SDK causes can contain HTTP requests with credentials. Only print the operation message.
  console.error(error instanceof Error ? error.message : "OpenTunnel failed")
  await stop(1)
}
