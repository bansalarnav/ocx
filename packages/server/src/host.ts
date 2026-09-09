import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Bus } from "@opencode-ai/core/bus"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { ServerFetch } from "@opencode-ai/server/fetch"
import { ServerWorkerd } from "@opencode-ai/server/workerd"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Context, Effect, Exit, Layer, RcRef, Scope } from "effect"
import { attempt, evaluate, type OperationError } from "@ocx/protocol/errors"
import { deviceMcpServers, type DeviceMcpEnv } from "./device-mcps"
import { makePluginManager } from "./plugin-manager/manager"
import { PluginStore } from "./plugin-manager/store"
import { makeLivePluginRegistry } from "./plugin-manager/registry"
import { makeQuickJSPlugin } from "./plugin-manager/quickjs"
import type { RemoteComputer } from "./remote/computer"
import { remoteServices } from "./remote/services"
import { remoteTools } from "./remote/tools"
import { finalizeWithResponse } from "./response-lifecycle"

export interface HostEnv extends DeviceMcpEnv {
  OPENCODE_PASSWORD?: string
}
export class Host extends Context.Service<
  Host,
  {
    readonly fetch: (request: Request) => Effect.Effect<Response, Error | OperationError>
  }
>()("ocx/Host") {}

const deviceToolsOnly = define({
  id: "device-tools-only",
  effect: (context) =>
    context.tool.transform((tools) => {
      for (const id of ["read", "write", "edit", "patch", "glob", "grep", "shell"]) tools.remove(id)
    }),
})

export interface RemoteHost {
  computer: () => DurableObjectStub<RemoteComputer>
  attached: () => boolean
  git: (operation: "fetch" | "push", branch?: string) => Promise<unknown>
}

export const hostLayer = (storage: DurableObjectStorage, env: HostEnv, observe: Bus.Subscriber, remote?: RemoteHost) =>
  Layer.effect(
    Host,
    Effect.gen(function* () {
      const store = yield* PluginStore
      const acquire = Effect.gen(function* () {
        let execution: SessionExecution.Interface | undefined
        const executionNode = SessionExecution.node.mapLayer((layer) =>
          Layer.tap(layer, (context) =>
            Effect.sync(() => {
              execution = Context.get(context, SessionExecution.Service)
            }),
          ),
        )
        const registry = makeLivePluginRegistry([deviceToolsOnly, ...(remote ? [remoteTools(remote.computer, remote.git)] : [])])
        yield* registry.upsert(makePluginManager(store, registry))
        for (const plugin of yield* store.list) {
          if (
            plugin.enabled &&
            (plugin.serverBundle !== undefined ||
              plugin.files["server.ts"] !== undefined ||
              plugin.files["server.js"] !== undefined)
          ) {
            yield* registry.upsert(makeQuickJSPlugin(plugin))
          }
        }
        const mcp = yield* evaluate("Read device configuration", () => deviceMcpServers(env))
        const options = {
          storage,
          password: env.OPENCODE_PASSWORD,
          models: { fetch: false },
          config: { content: JSON.stringify({ mcp: { servers: mcp } }) },
        }
        const sdk = makeGlobalNode({
          service: SdkPlugins.Service,
          deps: [Bus.node],
          layer: Layer.effect(
            SdkPlugins.Service,
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const unsubscribe = yield* bus.listen(observe)
              yield* Effect.addFinalizer(() => unsubscribe)
              return yield* SdkPlugins.Service.pipe(Effect.provide(registry.layer))
            }),
          ),
        })
        yield* Effect.logDebug("Starting OpenCode host")
        yield* Effect.addFinalizer(() => Effect.logDebug("Stopped OpenCode host"))
        const handler = yield* ServerFetch.make(ServerWorkerd.serverOptions(options), {
          overrides: [
            ...ServerWorkerd.replacements(options),
            ...(remote ? remoteServices(remote.computer, storage, remote.attached) : []),
            SdkPlugins.node.replace(sdk),
            SessionExecution.node.replace(executionNode),
          ],
        })
        if (!execution) return yield* Effect.die("OpenCode execution service was not initialized")
        const runs = execution
        const awaitIdle: Effect.Effect<void> = Effect.suspend(() =>
          runs.active.pipe(
            Effect.flatMap((active) =>
              active.size === 0
                ? Effect.void
                : Effect.forEach(active, runs.awaitIdle, {
                    concurrency: "unbounded",
                    discard: true,
                  }).pipe(Effect.andThen(awaitIdle)),
            ),
          ),
        )
        return { handler, awaitIdle }
      })
      const ref = yield* RcRef.make({ acquire })
      return Host.of({
        fetch: Effect.fn("Host.fetch")(function* (request: Request) {
          const scope = yield* Scope.make()
          let closed: Promise<void> | undefined
          let awaitIdle: Effect.Effect<void> = Effect.void
          const close = () =>
            (closed ??= Effect.runPromise(
              awaitIdle.pipe(Effect.andThen(Scope.close(scope, Exit.void))),
            ))
          return yield* Effect.gen(function* () {
            // The upstream host must finish booting even if its first caller disconnects.
            const host = yield* RcRef.get(ref).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.uninterruptible,
            )
            awaitIdle = host.awaitIdle
            const response = yield* attempt("OpenCode HTTP handler", () => host.handler(request))
            return yield* attempt("Own response lifetime", () =>
              finalizeWithResponse(response, close),
            )
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.promise(close) : Effect.void)),
          )
        }),
      })
    }),
  )
