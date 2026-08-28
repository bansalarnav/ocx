import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { define as definePlugin } from "@opencode-ai/plugin/effect/plugin"
import { ServerFetch } from "@opencode-ai/server/fetch"
import { ServerWorkerd } from "@opencode-ai/server/workerd"
import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, Layer, RcRef, Scope } from "effect"
import { deviceMcpServers } from "./device-mcps"

interface Env {
  OPENCODE: DurableObjectNamespace<OpenCodeDO>
  OPENCODE_PASSWORD?: string
  DEVICE_MCP_SERVERS?: string
  DEVICE_MCP_URL?: string
  DEVICE_MCP_TOKEN?: string
}

type OpenCodeHandler = (
  request: Request,
  context?: import("effect").Context.Context<never>,
) => Promise<Response>

const removedBuiltinTools = ["read", "write", "edit", "patch", "glob", "grep", "shell"]

const deviceToolsOnly = definePlugin({
  id: "device-tools-only",
  effect: (context) =>
    context.tool.transform((tools) => {
      for (const id of removedBuiltinTools) tools.remove(id)
    }),
})

const sdkPluginsLayer = Layer.succeed(
  SdkPlugins.Service,
  SdkPlugins.Service.of({
    register: () => Effect.void,
    all: () => [
      {
        ...deviceToolsOnly,
        version: "1",
        source: { type: "sdk" as const },
      },
    ],
  }),
)

export class OpenCodeDO extends DurableObject<Env> {
  private readonly handler: Promise<RcRef.RcRef<OpenCodeHandler, Error>>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.handler = state.blockConcurrencyWhile(async () => {
      const deviceServers = deviceMcpServers(env)
      // The owner scope contains only the RcRef while the object is idle. Each
      // response gets its own borrower scope below.
      const owner = await Effect.runPromise(Scope.make())
      return Effect.runPromise(
        RcRef.make({
          acquire: ServerFetch.make(ServerWorkerd.serverOptions({
            storage: state.storage,
            password: env.OPENCODE_PASSWORD,
            models: { fetch: false },
            config: {
              content: JSON.stringify({
                ...(Object.keys(deviceServers).length
                  ? {
                      mcp: {
                        servers: deviceServers,
                      },
                    }
                  : {}),
              }),
            },
          }), {
            overrides: [
              ...ServerWorkerd.replacements({ storage: state.storage }),
              [SdkPlugins.node, sdkPluginsLayer],
            ],
          }),
        }).pipe(Effect.provideService(Scope.Scope, owner)),
      )
    })
  }

  async fetch(request: Request): Promise<Response> {
    const scope = await Effect.runPromise(Scope.make())
    const close = () => Effect.runPromise(Scope.close(scope, Exit.void))

    try {
      const handler = await Effect.runPromise(
        RcRef.get(await this.handler).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      const response = await handler(request)

      if (!response.body) {
        await close()
        return response
      }

      const reader = response.body.getReader()
      let released = false
      const release = async () => {
        if (released) return
        released = true
        await close()
      }

      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read()
            if (result.done) {
              controller.close()
              await release()
              return
            }
            controller.enqueue(result.value)
          } catch (error) {
            controller.error(error)
            await release()
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } finally {
            await release()
          }
        },
      })

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      await close()
      throw error
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const id = env.OPENCODE.idFromName("default")
    return env.OPENCODE.get(id).fetch(request)
  },
} satisfies ExportedHandler<Env>
