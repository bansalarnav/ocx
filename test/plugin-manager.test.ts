import { describe, expect, test } from "bun:test"
import { inspectPluginSource, makeQuickJSPromisePlugin } from "../src/plugin-manager/quickjs"
import { searchPluginDocs } from "../src/plugin-manager/docs"
import { inspectPluginWorkspace } from "../src/plugin-manager/manager"
import { makePluginStore } from "../src/plugin-manager/store"

const validSource = `
import { Plugin } from "@opencode-ai/plugin"
export default Plugin.define({
  id: "hello",
  async setup(ctx) {
    await ctx.tool.transform((tools) => tools.add({
      name: "hello",
      description: "Say hello",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      async execute() { return { content: "hello" } },
    }))
  },
})
`

const validTuiSource = `
import { Plugin } from "@opencode-ai/plugin/tui"
export default Plugin.define({
  id: "hello",
  setup(ctx) {
    ctx.ui.toast.show({ message: "hello" })
  },
})
`

describe("server plugin runtime", () => {
  test("reads a normal OpenCode Promise plugin module", async () => {
    await expect(inspectPluginSource(validSource)).resolves.toEqual({ id: "hello" })
  })

  test("runs setup and registers a directly named executable tool", async () => {
    const added: any[] = []
    let reloaded = 0
    let activated = 0
    const plugin = makeQuickJSPromisePlugin({
      id: "hello",
      files: { "server.js": validSource },
      enabled: true,
      updatedAt: Date.now(),
    }, {
      resolve: () => { activated++ },
      reject: (error) => { throw error },
    })
    const cleanup = await plugin.setup({
      tool: {
        transform: async (transform: (tools: any) => void) => {
          transform({ get: () => undefined, add: (tool: any) => added.push(tool) })
          return { dispose: async () => undefined }
        },
        reload: async () => { reloaded++ },
      },
      storage: {
        get: async () => undefined,
        set: async () => undefined,
        remove: async () => undefined,
        scan: async () => ({ items: [], cursor: undefined }),
      },
    } as any)

    expect(added).toHaveLength(1)
    expect(added[0].name).toBe("hello")
    await expect(added[0].execute({}, {
      sessionID: "session",
      agent: "build",
      messageID: "message",
      id: "call",
    })).resolves.toEqual({ content: "hello" })
    expect(reloaded).toBe(1)
    expect(activated).toBe(1)
    await cleanup?.()
  })

  test("validates one workspace with server and TUI entrypoints", () => {
    const result = inspectPluginWorkspace({ files: {
      "server.ts": validSource,
      "tui.tsx": validTuiSource,
      "README.md": "plugin notes",
    } })
    expect(result).toEqual({ id: "hello", serverEntry: "server.ts", tuiEntry: "tui.tsx" })
  })

  test("keeps the plugin ID while editing", () => {
    expect(() => inspectPluginWorkspace({
      expectedID: "different",
      files: { "tui.tsx": validTuiSource },
    })).toThrow("Edited plugin must keep id different; workspace declares hello")
  })

  test("chunks large resolved bundles in Durable Object storage", async () => {
    const values = new Map<string, unknown>()
    const storage = {
      async get(key: string | string[]) {
        if (Array.isArray(key)) return new Map(key.flatMap((item) => values.has(item) ? [[item, values.get(item)]] : []))
        return values.get(key)
      },
      async put(key: string, value: unknown) { values.set(key, value) },
      async delete(key: string | string[]) {
        for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
        return true
      },
      async list(options: { prefix?: string; start?: string; end?: string } = {}) {
        return new Map(Array.from(values.entries()).filter(([key]) =>
          (options.prefix === undefined || key.startsWith(options.prefix)) &&
          (options.start === undefined || key >= options.start) &&
          (options.end === undefined || key < options.end)))
      },
    } as any
    const store = makePluginStore(storage)
    const plugin = {
      id: "large",
      files: { "server.js": validSource.replace('id: "hello"', 'id: "large"') },
      serverBundle: "x".repeat(900_000),
      enabled: true,
      updatedAt: 1,
    }
    await store.put(plugin)
    expect((await store.get("large"))?.serverBundle).toHaveLength(900_000)
    expect(await store.list()).toEqual([plugin])
    expect(Array.from(values.keys()).filter((key) => key.includes("/blob/")).length).toBeGreaterThan(1)
    await store.remove("large")
    expect(values.size).toBe(0)
  })

  test("rejects unsupported imports", async () => {
    await expect(inspectPluginSource(`
      import thing from "left-pad"
      export default { id: "bad", setup() { return thing } }
    `)).rejects.toThrow("Unsupported import: left-pad")
  })

  test("rejects invalid plugin IDs", async () => {
    await expect(inspectPluginSource(`
      export default { id: "bad id", setup() {} }
    `)).rejects.toThrow("Plugin id must match")
  })

  test("bundled docs describe direct tool naming and automatic activation", () => {
    expect(searchPluginDocs("appear beside")).toContain("main agent calls them directly")
    expect(searchPluginDocs("hot-activate")).toContain("reload the tool catalog")
  })
})
