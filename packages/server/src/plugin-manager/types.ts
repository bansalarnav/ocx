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
