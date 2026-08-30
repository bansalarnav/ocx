import type { PluginStore, StoredPlugin } from "./types"

const prefix = "plugin-manager/plugin/"
const blobPrefix = "plugin-manager/blob/"
const chunkCharacters = 400_000

type LegacyStoredPlugin = Omit<StoredPlugin, "files"> & {
  files?: Record<string, string>
  source?: string
}

interface ChunkHeader {
  format: "chunks-v1"
  chunks: number
}

const isChunkHeader = (value: unknown): value is ChunkHeader =>
  !!value && typeof value === "object" &&
  (value as { format?: unknown }).format === "chunks-v1" &&
  Number.isInteger((value as { chunks?: unknown }).chunks)

const normalize = (plugin: LegacyStoredPlugin): StoredPlugin => ({
  id: plugin.id,
  files: plugin.files ?? (plugin.source === undefined ? {} : { "server.js": plugin.source }),
  ...(plugin.serverBundle === undefined ? {} : { serverBundle: plugin.serverBundle }),
  ...(plugin.tuiBundle === undefined ? {} : { tuiBundle: plugin.tuiBundle }),
  ...(plugin.dependencies === undefined ? {} : { dependencies: plugin.dependencies }),
  ...(plugin.bundleWarnings === undefined ? {} : { bundleWarnings: plugin.bundleWarnings }),
  enabled: plugin.enabled,
  updatedAt: plugin.updatedAt,
  ...(plugin.error === undefined ? {} : { error: plugin.error }),
})

const chunkKey = (id: string, index: number) =>
  `${blobPrefix}${id}/${index.toString().padStart(6, "0")}`

const read = async (
  storage: DurableObjectStorage,
  id: string,
  value: unknown,
): Promise<StoredPlugin | undefined> => {
  if (value === undefined) return undefined
  if (!isChunkHeader(value)) return normalize(value as LegacyStoredPlugin)
  const keys = Array.from({ length: value.chunks }, (_, index) => chunkKey(id, index))
  const chunks = await storage.get<string>(keys)
  const serialized = keys.map((key) => {
    const chunk = chunks.get(key)
    if (chunk === undefined) throw new Error(`Missing stored plugin chunk: ${key}`)
    return chunk
  }).join("")
  return normalize(JSON.parse(serialized) as LegacyStoredPlugin)
}

export const makePluginStore = (storage: DurableObjectStorage): PluginStore => ({
  async list() {
    const values = await storage.list<unknown>({ prefix })
    return Promise.all(Array.from(values.entries(), ([key, value]) => {
      const id = key.slice(prefix.length)
      return read(storage, id, value).then((plugin) => {
        if (plugin === undefined) throw new Error(`Missing plugin manifest: ${id}`)
        return plugin
      })
    }))
  },
  async get(id) {
    return read(storage, id, await storage.get<unknown>(`${prefix}${id}`))
  },
  async put(plugin) {
    const serialized = JSON.stringify(plugin)
    const chunks = Array.from(
      { length: Math.ceil(serialized.length / chunkCharacters) },
      (_, index) => serialized.slice(index * chunkCharacters, (index + 1) * chunkCharacters),
    )
    await Promise.all(chunks.map((chunk, index) => storage.put(chunkKey(plugin.id, index), chunk)))
    await storage.put(`${prefix}${plugin.id}`, {
      format: "chunks-v1",
      chunks: chunks.length,
    } satisfies ChunkHeader)
    const stale = await storage.list({
      start: chunkKey(plugin.id, chunks.length),
      end: `${blobPrefix}${plugin.id}0`,
    })
    if (stale.size > 0) await storage.delete(Array.from(stale.keys()))
  },
  async remove(id) {
    const chunks = await storage.list({ prefix: `${blobPrefix}${id}/` })
    if (chunks.size > 0) await storage.delete(Array.from(chunks.keys()))
    await storage.delete(`${prefix}${id}`)
  },
})
