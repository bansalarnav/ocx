export interface StoredPlugin {
  package?: { name: string; version: string; requested: string; scope: "cloud" | "project"; projectID?: string; runtime: "quickjs-promise" }
  runtimeID?: string
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
