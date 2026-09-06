import { Bus } from "@opencode-ai/core/bus"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import type { Plugin } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Layer } from "effect"

export interface LivePluginRegistry {
  readonly layer: Layer.Layer<SdkPlugins.Service, never, Bus.Service>
  readonly upsert: (plugin: Plugin) => Effect.Effect<void>
  readonly remove: (id: string) => Effect.Effect<void>
  readonly has: (id: string) => boolean
}

export const makeLivePluginRegistry = (initial: readonly Plugin[]): LivePluginRegistry => {
  let generation = 0
  const plugins = new Map(
    initial.map((plugin) => [
      plugin.id,
      { ...plugin, revision: String(++generation), source: { type: "sdk" as const } },
    ]),
  )
  let publish: Effect.Effect<void> = Effect.void
  const upsert = (plugin: Plugin) =>
    Effect.sync(() => {
      plugins.set(plugin.id, {
        ...plugin,
        revision: String(++generation),
        source: { type: "sdk" as const },
      })
    }).pipe(Effect.andThen(Effect.suspend(() => publish)))
  return {
    layer: Layer.effect(
      SdkPlugins.Service,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        publish = bus.publish(SdkPlugins.Updated, {}, { global: true }).pipe(Effect.asVoid)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            publish = Effect.void
          }),
        )
        return SdkPlugins.Service.of({ register: upsert, all: () => Array.from(plugins.values()) })
      }),
    ),
    upsert,
    remove: (id) =>
      Effect.sync(() => plugins.delete(id)).pipe(
        Effect.flatMap((removed) => (removed ? publish : Effect.void)),
      ),
    has: (id) => plugins.has(id),
  }
}
