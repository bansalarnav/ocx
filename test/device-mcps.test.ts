import { describe, expect, test } from "bun:test"
import { deviceMcpServers } from "../src/device-mcps"

describe("deviceMcpServers", () => {
  test("keeps the legacy device variables working", () => {
    const servers = deviceMcpServers({
      DEVICE_MCP_URL: "https://device.example/mcp",
      DEVICE_MCP_TOKEN: "legacy-token",
    })

    expect(servers.device?.url).toBe("https://device.example/mcp")
    expect(servers.device?.headers.Authorization).toBe("Bearer legacy-token")
  })

  test("creates one namespaced MCP server per device", () => {
    const servers = deviceMcpServers({
      DEVICE_MCP_SERVERS: JSON.stringify({
        laptop: { url: "https://laptop.example/mcp", token: "laptop-token" },
        desktop: { url: "https://desktop.example/mcp", token: "desktop-token" },
      }),
    })

    expect(Object.keys(servers)).toEqual(["laptop", "desktop"])
    expect(servers.laptop?.headers.Authorization).toBe("Bearer laptop-token")
    expect(servers.desktop?.headers.Authorization).toBe("Bearer desktop-token")
  })

  test("lets the named registry replace the legacy device slot", () => {
    const servers = deviceMcpServers({
      DEVICE_MCP_URL: "https://old.example/mcp",
      DEVICE_MCP_TOKEN: "old-token",
      DEVICE_MCP_SERVERS: JSON.stringify({
        device: { url: "https://new.example/mcp", token: "new-token" },
      }),
    })

    expect(servers.device?.url).toBe("https://new.example/mcp")
  })

  test("rejects names that cannot safely prefix tool IDs", () => {
    expect(() => deviceMcpServers({
      DEVICE_MCP_SERVERS: JSON.stringify({
        "My Laptop": { url: "https://laptop.example/mcp", token: "token" },
      }),
    })).toThrow("Invalid device name")
  })
})
