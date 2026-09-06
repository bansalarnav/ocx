import { Context, Effect, Layer } from "effect"
import { attempt, evaluate, OperationError } from "@ocx/protocol/errors"
import type { StoredPlugin } from "./types"

const prefix = "plugin-manager/plugin/"
const blobPrefix = "plugin-manager/blob/"
const chunkCharacters = 400_000
const chunkKey = (id: string, index: number) =>
  `${blobPrefix}${id}/${index.toString().padStart(6, "0")}`
type LegacyStoredPlugin = Omit<StoredPlugin, "files"> & {
  files?: Record<string, string>
  source?: string
}
interface ChunkHeader {
  format: "chunks-v1"
  chunks: number
}
const isChunkHeader = (value: unknown): value is ChunkHeader =>
  !!value &&
  typeof value === "object" &&
  (value as ChunkHeader).format === "chunks-v1" &&
  Number.isInteger((value as ChunkHeader).chunks) &&
  (value as ChunkHeader).chunks > 0
const normalize = (plugin: LegacyStoredPlugin): StoredPlugin => ({
  ...plugin,
  files: plugin.files ?? (plugin.source === undefined ? {} : { "server.js": plugin.source }),
})

export interface PluginStoreService {
  readonly list: Effect.Effect<StoredPlugin[], OperationError>
  readonly get: (id: string) => Effect.Effect<StoredPlugin | undefined, OperationError>
  readonly put: (plugin: StoredPlugin) => Effect.Effect<void, OperationError>
  readonly remove: (id: string) => Effect.Effect<void, OperationError>
}
export class PluginStore extends Context.Service<PluginStore, PluginStoreService>()(
  "ocx/PluginStore",
) {}

export const makePluginStore = (
  storage: DurableObjectStorage,
  changed: () => void = () => {},
): PluginStoreService => {
  const read = Effect.fn("PluginStore.read")(function* (id: string, value: unknown) {
    if (value === undefined) return undefined
    if (!isChunkHeader(value))
      return yield* evaluate("Decode plugin", () => normalize(value as LegacyStoredPlugin))
    const keys = Array.from({ length: value.chunks }, (_, index) => chunkKey(id, index))
    const chunks = yield* attempt("Read plugin chunks", () => storage.get<string>(keys))
    return yield* evaluate("Decode plugin chunks", () =>
      normalize(
        JSON.parse(
          keys
            .map((key) => {
              const chunk = chunks.get(key)
              if (chunk === undefined) throw new Error(`Missing plugin chunk: ${key}`)
              return chunk
            })
            .join(""),
        ),
      ),
    )
  })
  return {
    list: attempt("List plugins", () => storage.list<unknown>({ prefix })).pipe(
      Effect.flatMap((values) =>
        Effect.forEach(
          Array.from(values),
          ([key, value]) =>
            read(key.slice(prefix.length), value).pipe(
              Effect.flatMap((plugin) =>
                plugin
                  ? Effect.succeed(plugin)
                  : Effect.fail(
                      new OperationError({
                        operation: "Read plugin",
                        cause: new Error(`Missing ${key}`),
                      }),
                    ),
              ),
            ),
          { concurrency: 4 },
        ),
      ),
    ),
    get: (id) =>
      attempt("Read plugin", () => storage.get<unknown>(`${prefix}${id}`)).pipe(
        Effect.flatMap((value) => read(id, value)),
      ),
    put: (plugin) =>
      attempt("Store plugin", () =>
        storage.transaction(async (transaction) => {
          const serialized = JSON.stringify(plugin)
          const chunks = Array.from(
            { length: Math.ceil(serialized.length / chunkCharacters) },
            (_, index) => serialized.slice(index * chunkCharacters, (index + 1) * chunkCharacters),
          )
          for (let index = 0; index < chunks.length; index++)
            await transaction.put(chunkKey(plugin.id, index), chunks[index])
          await transaction.put(`${prefix}${plugin.id}`, {
            format: "chunks-v1",
            chunks: chunks.length,
          } satisfies ChunkHeader)
          const stale = await transaction.list({
            start: chunkKey(plugin.id, chunks.length),
            end: `${blobPrefix}${plugin.id}0`,
          })
          if (stale.size) await transaction.delete(Array.from(stale.keys()))
        }),
      ).pipe(Effect.tap(() => Effect.sync(changed))),
    remove: (id) =>
      attempt("Remove plugin", () =>
        storage.transaction(async (transaction) => {
          const chunks = await transaction.list({ prefix: `${blobPrefix}${id}/` })
          if (chunks.size) await transaction.delete(Array.from(chunks.keys()))
          await transaction.delete(`${prefix}${id}`)
        }),
      ).pipe(Effect.tap(() => Effect.sync(changed))),
  }
}
export const pluginStoreLayer = (storage: DurableObjectStorage, changed: () => void) =>
  Layer.succeed(PluginStore, makePluginStore(storage, changed))
