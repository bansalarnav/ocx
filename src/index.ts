import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { define as definePlugin } from "@opencode-ai/plugin/effect/plugin"
import { ServerFetch } from "@opencode-ai/server/fetch"
import { ServerWorkerd } from "@opencode-ai/server/workerd"
import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, Layer, RcRef, Scope, type Context } from "effect"
import { deviceMcpServers } from "./device-mcps"
import { finalizeWithResponse } from "./response-lifecycle"

interface Env {
  OPENCODE: DurableObjectNamespace<OpenCodeDO>
  OPENCODE_PASSWORD?: string
  DEVICE_MCP_SERVERS?: string
  DEVICE_MCP_URL?: string
  DEVICE_MCP_TOKEN?: string
}

type OpenCodeHandler = (
  request: Request,
  context?: Context.Context<never>,
) => Promise<Response>

type HandlerRef = RcRef.RcRef<OpenCodeHandler, Error>

const disabledBuiltinTools = [
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "shell",
]

const deviceToolsOnly = definePlugin({
  id: "device-tools-only",
  effect: (context) =>
    context.tool.transform((tools) => {
      for (const id of disabledBuiltinTools) tools.remove(id)
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

const serverConfig = (env: Env): string => {
  const servers = deviceMcpServers(env)
  return JSON.stringify(Object.keys(servers).length === 0 ? {} : { mcp: { servers } })
}

const makeHandler = (state: DurableObjectState, env: Env) => {
  const workerdOptions = {
    storage: state.storage,
    password: env.OPENCODE_PASSWORD,
    models: { fetch: false },
    config: { content: serverConfig(env) },
  }

  return ServerFetch.make(ServerWorkerd.serverOptions(workerdOptions), {
    overrides: [
      ...ServerWorkerd.replacements(workerdOptions),
      [SdkPlugins.node, sdkPluginsLayer],
    ],
  })
}

const makeHandlerRef = (
  state: DurableObjectState,
  env: Env,
): Promise<HandlerRef> =>
  Effect.gen(function*() {
    // The owner scope keeps the RcRef usable for the lifetime of this object.
    // Request scopes control the lifetime of the server it contains.
    const ownerScope = yield* Scope.make()
    return yield* RcRef.make({ acquire: makeHandler(state, env) }).pipe(
      Effect.provideService(Scope.Scope, ownerScope),
    )
  }).pipe(Effect.runPromise)

const closeScope = (scope: Scope.Closeable): Promise<void> =>
  Effect.runPromise(Scope.close(scope, Exit.void))

export class OpenCodeDO extends DurableObject<Env> {
  private readonly handlerRef: Promise<HandlerRef>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.handlerRef = state.blockConcurrencyWhile(() => makeHandlerRef(state, env))
  }

  async fetch(request: Request): Promise<Response> {
    const scope = await Effect.runPromise(Scope.make())
    let closing: Promise<void> | undefined
    const close = () => (closing ??= closeScope(scope))

    try {
      const handler = await Effect.runPromise(
        RcRef.get(await this.handlerRef).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      )
      const response = await handler(request)
      return await finalizeWithResponse(response, close)
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
