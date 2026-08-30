export interface StoredPlugin {
  id: string
  files: Record<string, string>
  serverBundle?: string
  tuiBundle?: string
  dependencies?: Record<string, string>
  bundleWarnings?: string[]
  enabled: boolean
  updatedAt: number
  error?: string
}

export interface PluginStore {
  list(): Promise<StoredPlugin[]>
  get(id: string): Promise<StoredPlugin | undefined>
  put(plugin: StoredPlugin): Promise<void>
  remove(id: string): Promise<void>
}
