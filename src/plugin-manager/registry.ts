import { Bus } from "@opencode-ai/core/bus"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import type { Plugin } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Layer } from "effect"

export interface LivePluginRegistry {
  readonly layer: Layer.Layer<SdkPlugins.Service, never, Bus.Service>
  upsert(plugin: Plugin): Promise<void>
  remove(id: string): Promise<void>
  has(id: string): boolean
}

export const makeLivePluginRegistry = (
  initial: readonly Plugin[],
): LivePluginRegistry => {
  let generation = 0
  const plugins = new Map(
    initial.map((plugin) => [plugin.id, {
      ...plugin,
      revision: String(++generation),
      source: { type: "sdk" as const },
    }]),
  )
  let publish: (() => Promise<void>) | undefined

  const layer = Layer.effect(
    SdkPlugins.Service,
    Effect.gen(function*() {
      const bus = yield* Bus.Service
      const notify = () => bus.publish(SdkPlugins.Updated, {}, { global: true })
      publish = () => Effect.runPromise(notify() as Effect.Effect<unknown, never, never>).then(() => undefined)

      return SdkPlugins.Service.of({
        register: (plugin) => Effect.sync(() => {
          plugins.set(plugin.id, {
            ...plugin,
            revision: String(++generation),
            source: { type: "sdk" as const },
          })
        }).pipe(Effect.andThen(notify()), Effect.asVoid),
        all: () => Array.from(plugins.values()),
      })
    }),
  )

  return {
    layer,
    has: (id) => plugins.has(id),
    async upsert(plugin) {
      plugins.set(plugin.id, {
        ...plugin,
        revision: String(++generation),
        source: { type: "sdk" as const },
      })
      await publish?.()
    },
    async remove(id) {
      if (!plugins.delete(id)) return
      generation++
      await publish?.()
    },
  }
}
