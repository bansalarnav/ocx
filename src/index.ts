import { ServerWorkerd } from "@opencode-ai/server/workerd"
import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, RcRef, Scope } from "effect"

interface Env {
  OPENCODE: DurableObjectNamespace<OpenCodeDO>
  OPENCODE_PASSWORD?: string
  DEVICE_MCP_URL?: string
  DEVICE_MCP_TOKEN?: string
}

type OpenCodeHandler = (
  request: Request,
  context?: import("effect").Context.Context<never>,
) => Promise<Response>

export class OpenCodeDO extends DurableObject<Env> {
  private readonly handler: Promise<RcRef.RcRef<OpenCodeHandler, Error>>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.handler = state.blockConcurrencyWhile(async () => {
      // The owner scope contains only the RcRef while the object is idle. Each
      // response gets its own borrower scope below.
      const owner = await Effect.runPromise(Scope.make())
      return Effect.runPromise(
        RcRef.make({
          acquire: ServerWorkerd.create({
            storage: state.storage,
            password: env.OPENCODE_PASSWORD,
            models: { fetch: false },
            config: {
              content: JSON.stringify({
                permissions: [
                  { action: "read", resource: "*", effect: "deny" },
                  { action: "glob", resource: "*", effect: "deny" },
                  { action: "grep", resource: "*", effect: "deny" },
                  { action: "edit", resource: "*", effect: "deny" },
                  { action: "shell", resource: "*", effect: "deny" },
                ],
                ...(env.DEVICE_MCP_URL && env.DEVICE_MCP_TOKEN
                  ? {
                      mcp: {
                        servers: {
                          device: {
                            type: "remote",
                            url: env.DEVICE_MCP_URL,
                            headers: { Authorization: `Bearer ${env.DEVICE_MCP_TOKEN}` },
                            oauth: false,
                            codemode: false,
                            timeout: {
                              startup: 15_000,
                              catalog: 15_000,
                              execution: 1_800_000,
                            },
                          },
                        },
                      },
                    }
                  : {}),
              }),
            },
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
