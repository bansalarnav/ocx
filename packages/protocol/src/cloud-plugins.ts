/** Durable package installations. Project identity is the workspace projectID, or session directory. */
export type CloudPluginScope = "cloud" | "project"
export interface InstallCloudPlugin {
  package: string
  scope: CloudPluginScope
  projectID?: string
}
export interface CloudPluginInfo {
  id: string
  package: string
  version: string
  scope: CloudPluginScope
  projectID?: string
  enabled: boolean
  updatedAt: number
  runtime: "quickjs-promise"
  serverStatus: "enabled" | "disabled" | "absent"
  tuiStatus: "available-to-clients" | "disabled" | "absent"
  warnings: string[]
}
export interface CloudPluginList { plugins: CloudPluginInfo[] }
export interface CloudPluginResult { plugin: CloudPluginInfo }
