import { bundlePluginFiles } from "../src/plugin-manager/bundler"
import { inspectPluginSource, makeQuickJSPromisePlugin } from "../src/plugin-manager/quickjs"

export default {
  async fetch(): Promise<Response> {
    const result = await bundlePluginFiles({
      "server.js": `
        import { Plugin } from "@opencode-ai/plugin"
        import camelCase from "camelcase"
        export default Plugin.define({
          id: "package-smoke",
          async setup(ctx) {
            await ctx.tool.transform((tools) => tools.add({
              name: "package_smoke",
              description: "Exercise a bundled npm package",
              input: { type: "object", properties: {}, additionalProperties: false },
              options: { codemode: false },
              async execute() { return { content: camelCase("package smoke") } }
            }))
          }
        })
      `,
      "tui.tsx": `
        import { Plugin } from "@opencode-ai/plugin/tui"
        import camelCase from "camelcase"
        export default Plugin.define({
          id: "package-smoke",
          setup(ctx) {
            return ctx.ui.slot({
              append: "sidebar.footer",
              render() { return <text>{camelCase("package smoke")}</text> }
            })
          }
        })
      `,
      "package.json": JSON.stringify({
        dependencies: { camelcase: "latest" },
      }),
    })
    const inspected = await inspectPluginSource(result.serverBundle ?? "")
    const tools: any[] = []
    const plugin = makeQuickJSPromisePlugin({
      id: "package-smoke",
      files: { "server.js": "bundled by smoke test" },
      serverBundle: result.serverBundle,
      dependencies: result.dependencies,
      enabled: true,
      updatedAt: Date.now(),
    })
    const cleanup = await plugin.setup({
      tool: {
        transform: async (transform: (draft: any) => void) => {
          transform({ get: () => undefined, add: (tool: any) => tools.push(tool) })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      },
      storage: {
        get: async () => undefined,
        set: async () => undefined,
        remove: async () => undefined,
        scan: async () => ({ items: [] }),
      },
    } as any)
    const execution = await tools[0].execute({}, {
      sessionID: "session",
      agent: "build",
      messageID: "message",
      id: "call",
    })
    await cleanup?.()
    return Response.json({
      dependencies: result.dependencies,
      warnings: result.warnings,
      hasBundle: result.serverBundle?.includes("package-smoke") ?? false,
      id: inspected.id,
      execution,
      bytes: result.serverBundle?.length ?? 0,
      tuiBytes: result.tuiBundle?.length ?? 0,
      hasTuiBundle: result.tuiBundle !== undefined,
    })
  },
}
