/** Only ocx's authenticated WebSocket handshake carries these credentials. */
export const deviceHeader = "x-ocx-device"
export const deviceProtocol = "ocx.v1.device"
export const devicePrefix = "ocx_device_"

export interface SharedDevice {
  id: string
  url: string
  token: string
}

export function parseSharedDevice(value: string): SharedDevice {
  const invalid = () => new Error("Invalid shared device registration")
  if (value.length > 512) throw invalid()
  let input: SharedDevice
  try { input = JSON.parse(value) } catch { throw invalid() }
  if (!input || typeof input.id !== "string" || typeof input.token !== "string" || typeof input.url !== "string" || !/^[a-f0-9]{16}$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.token)) throw invalid()
  let url: URL
  try { url = new URL(input.url) } catch { throw invalid() }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw invalid()
  return { id: input.id, url: url.href, token: input.token }
}

export const deviceName = (device: SharedDevice) => devicePrefix + device.id
