import { describe, expect, test } from "bun:test"
import { effectiveInstanceConfig, parseInstanceConfig } from "../packages/server/src/instance-config"

describe("instance OpenCode config", () => {
  test("accepts a current custom provider config", () => {
    const parsed = parseInstanceConfig(JSON.stringify({
      providers: {
        acme: {
          name: "Acme Models",
          package: "@ai-sdk/openai-compatible",
          settings: { baseURL: "https://models.example/v1" },
          models: { coder: { name: "Coder", modelID: "coder-v1" } },
        },
      },
      model: "acme/coder",
    }))
    expect(parsed.content.providers).toBeDefined()
  })

  test("accepts JSONC in the current schema", () => {
    const parsed = parseInstanceConfig(`{
      // OpenAI-compatible custom provider
      "providers": {
        "acme": {
          "package": "@ai-sdk/openai-compatible",
          "settings": { "baseURL": "https://models.example/v1" },
          "models": { "coder": { "name": "Coder" } },
        },
      },
    }`)
    expect(parsed.content.providers).toBeDefined()
  })

  test("rejects v1 provider keys", () => {
    expect(() => parseInstanceConfig(`{
      "provider": {
        "acme": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "https://models.example/v1" },
          "models": { "coder": { "name": "Coder" } }
        }
      }
    }`)).toThrow("provider")
  })

  test("preserves configured MCP servers and reserves injected device names", () => {
    const effective = JSON.parse(effectiveInstanceConfig(
      `{ "mcp": { "servers": { "docs": { "type": "remote", "url": "https://docs.example/mcp" }, "device": { "type": "remote", "url": "https://wrong.example/mcp" } } } }`,
      {
        device: {
          type: "remote",
          url: "https://device.example/mcp",
          headers: { Authorization: "Bearer secret" },
          oauth: false,
          codemode: false,
          timeout: { startup: 15_000, catalog: 15_000, execution: 1_800_000 },
        },
      },
    ))
    expect(effective.mcp.servers.docs.url).toBe("https://docs.example/mcp")
    expect(effective.mcp.servers.device.url).toBe("https://device.example/mcp")
  })

  test("rejects malformed and schema-invalid config", () => {
    expect(() => parseInstanceConfig("{")).toThrow("at offset")
    expect(() => parseInstanceConfig(`{ "providers": { "acme": { "env": 42 } } }`)).toThrow("env")
  })
})
