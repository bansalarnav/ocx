export interface DeviceMcpEnv {
  DEVICE_MCP_SERVERS?: string
  DEVICE_MCP_URL?: string
  DEVICE_MCP_TOKEN?: string
}

interface DeviceDefinition {
  url: string
  token: string
}

export interface RemoteMcpServer {
  type: "remote"
  url: string
  headers: { Authorization: string }
  oauth: false
  codemode: false
  timeout: {
    startup: number
    catalog: number
    execution: number
  }
}

const validDeviceName = /^[a-z][a-z0-9_]{0,31}$/

function parseDefinition(name: string, input: unknown): DeviceDefinition {
  if (!validDeviceName.test(name)) {
    throw new Error(
      `Invalid device name ${JSON.stringify(name)}. Use 1-32 lowercase letters, numbers, or underscores.`,
    )
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Device ${JSON.stringify(name)} must contain a url and token`)
  }

  const value = input as Record<string, unknown>
  if (typeof value.url !== "string" || typeof value.token !== "string" || !value.token) {
    throw new Error(`Device ${JSON.stringify(name)} must contain a non-empty url and token`)
  }

  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    throw new Error(`Device ${JSON.stringify(name)} has an invalid URL`)
  }
  if (url.protocol !== "https:") {
    throw new Error(`Device ${JSON.stringify(name)} must use an HTTPS URL`)
  }

  return { url: url.toString(), token: value.token }
}

function remoteServer(device: DeviceDefinition): RemoteMcpServer {
  return {
    type: "remote",
    url: device.url,
    headers: { Authorization: `Bearer ${device.token}` },
    oauth: false,
    codemode: false,
    timeout: {
      startup: 15_000,
      catalog: 15_000,
      execution: 1_800_000,
    },
  }
}

export function deviceMcpServers(env: DeviceMcpEnv): Record<string, RemoteMcpServer> {
  const devices: Record<string, DeviceDefinition> = {}

  if (env.DEVICE_MCP_URL || env.DEVICE_MCP_TOKEN) {
    if (!env.DEVICE_MCP_URL || !env.DEVICE_MCP_TOKEN) {
      throw new Error("DEVICE_MCP_URL and DEVICE_MCP_TOKEN must be configured together")
    }
    devices.device = parseDefinition("device", {
      url: env.DEVICE_MCP_URL,
      token: env.DEVICE_MCP_TOKEN,
    })
  }

  if (env.DEVICE_MCP_SERVERS) {
    let parsed: unknown
    try {
      parsed = JSON.parse(env.DEVICE_MCP_SERVERS)
    } catch {
      throw new Error("DEVICE_MCP_SERVERS must be valid JSON")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DEVICE_MCP_SERVERS must be an object keyed by device name")
    }
    for (const [name, definition] of Object.entries(parsed)) {
      devices[name] = parseDefinition(name, definition)
    }
  }

  return Object.fromEntries(
    Object.entries(devices).map(([name, device]) => [name, remoteServer(device)]),
  )
}
