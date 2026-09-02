import { describe, expect, test } from "bun:test"
import type { PluginStore, StoredPlugin } from "../src/plugin-manager/types"
import { makeTuiRegistryHandler, type TuiPluginManifest } from "../src/tui-registry"

const plugin = (overrides: Partial<StoredPlugin> = {}): StoredPlugin => ({
  id: "dashboard",
  files: { "tui.tsx": "source" },
  tuiBundle: "export default { id: 'dashboard' }",
  enabled: true,
  updatedAt: 1,
  ...overrides,
})

const memoryStore = (initial: StoredPlugin[]): PluginStore => {
  const plugins = new Map(initial.map((item) => [item.id, item]))
  return {
    list: async () => Array.from(plugins.values()),
    get: async (id) => plugins.get(id),
    put: async (item) => { plugins.set(item.id, item) },
    remove: async (id) => { plugins.delete(id) },
  }
}

describe("TUI registry", () => {
  test("lists enabled TUI plugins and serves the content-addressed artifact", async () => {
    const handler = makeTuiRegistryHandler(memoryStore([
      plugin(),
      plugin({ id: "server-only", tuiBundle: undefined }),
      plugin({ id: "disabled", enabled: false }),
    ]))
    const response = await handler(new Request("https://example.test/api/generated-plugins/tui"))
    expect(response?.status).toBe(200)
    const manifest = await response!.json() as TuiPluginManifest
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.plugins.map((entry) => entry.id)).toEqual(["dashboard"])
    expect(manifest.plugins[0]!.version).toBe(manifest.plugins[0]!.sha256)

    const entry = manifest.plugins[0]!
    const artifact = await handler(new Request(
      `https://example.test/api/generated-plugins/tui/${entry.id}/${entry.version}`,
    ))
    expect(artifact?.status).toBe(200)
    expect(await artifact!.text()).toBe(plugin().tuiBundle!)
    expect(artifact?.headers.get("cache-control")).toContain("immutable")
  })

  test("uses the same Basic authentication as the OpenCode server", async () => {
    const handler = makeTuiRegistryHandler(memoryStore([plugin()]), "pässword")
    const url = "https://example.test/api/generated-plugins/tui"
    expect((await handler(new Request(url)))?.status).toBe(401)
    const authorization = `Basic ${Buffer.from("opencode:pässword").toString("base64")}`
    expect((await handler(new Request(url, { headers: { authorization } })))?.status).toBe(200)
  })

  test("does not claim neighboring routes", async () => {
    const handler = makeTuiRegistryHandler(memoryStore([]))
    expect(await handler(new Request("https://example.test/api/generated-plugins/tuix"))).toBeUndefined()
  })
})
