import { Mcp } from "@opencode/core/mcp/index"
import type { SharedDevices } from "./shared-devices"
import { SessionExecution } from "@opencode/core/session/execution"
import { Bus } from "@opencode/core/bus"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { define } from "@opencode/plugin/effect/plugin"
import { ServerFetch } from "@opencode/server/fetch"
import { ServerWorkerd } from "@opencode/server/workerd"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Exit, Layer, RcRef, Scope } from "effect"
import { attempt, evaluate, type OperationError } from "@ocx/protocol/errors"
import { cloudCheckout } from "@ocx/protocol/projects"
import { deviceMcpServers, type DeviceMcpEnv } from "./device-mcps"
import { makePluginManager } from "./plugin-manager/manager"
import { PluginStore } from "./plugin-manager/store"
import { makeLivePluginRegistry } from "./plugin-manager/registry"
import { makeQuickJSPlugin } from "./plugin-manager/quickjs"
import { finalizeWithResponse } from "./response-lifecycle"
import type { InstanceConfigStore } from "./instance-config"
import type { WorkspaceManager } from "./remote/manager"
import { remoteReplacements, remoteWorkspacePlugin } from "./remote/adapter"
import { remoteEnvironmentReplacements, remoteCheckpointPlugin } from "./remote/environment"

export interface HostEnv extends DeviceMcpEnv {
  OPENCODE_PASSWORD?: string
}
export class Host extends Context.Service<
  Host,
  {
    readonly fetch: (request: Request) => Effect.Effect<Response, Error | OperationError>
    readonly invalidate: Effect.Effect<void>
  }
>()("ocx/Host") {}

const deviceToolsOnly = (workspaces?: WorkspaceManager) => define({
  id: "device-tools-only",
  effect: (context) => context.session.hook("context", event => Effect.promise(async () => {
    if (workspaces && await workspaces.forSession(event.sessionID)) return
    for (const id of ["read", "write", "edit", "patch", "glob", "grep", "shell"]) delete event.tools[id]
  })),
})

export const hostLayer = (
  storage: DurableObjectStorage,
  env: HostEnv,
  instanceConfig: InstanceConfigStore,
  observe: Bus.Subscriber,
  devices?: SharedDevices,
  workspaces?: WorkspaceManager,
) =>
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
        const registry = makeLivePluginRegistry([deviceToolsOnly(workspaces)])
        yield* registry.upsert(makePluginManager(store, registry))
        if (workspaces) {
          yield* registry.upsert(remoteWorkspacePlugin(workspaces))
          yield* registry.upsert(remoteCheckpointPlugin(workspaces))
        }
        for (const plugin of yield* store.list) {
          if (
            plugin.enabled &&
            (plugin.serverBundle !== undefined ||
              plugin.files["server.ts"] !== undefined ||
              plugin.files["server.js"] !== undefined)
          ) {
            yield* registry.upsert(makeQuickJSPlugin(plugin, undefined, workspaces ? async id => {
              const workspace = await workspaces.forSession(id)
              return workspace ? cloudCheckout(workspace).projectID : undefined
            } : undefined))
          }
        }
        const mcp = yield* evaluate("Read device configuration", () => deviceMcpServers(env))
        const config = yield* instanceConfig.effective(mcp)
        const options = {
          storage,
          password: env.OPENCODE_PASSWORD,
          models: { fetch: false },
          config: { content: config },
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
            SdkPlugins.node.replace(sdk),
            SessionExecution.node.replace(executionNode),
            ...(devices ? [Mcp.node.replace(devices.node)] : []),
            ...(workspaces ? remoteReplacements(workspaces) : []),
            ...(workspaces ? remoteEnvironmentReplacements(workspaces) : []),
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
        invalidate: RcRef.invalidate(ref),
      })
    }),
  )
