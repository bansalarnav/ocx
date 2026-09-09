export const workspaceAPI = "/api/remote"
export const workspaceHeader = "x-ocx-workspace"
export type ExecutionBackend = "worker-shell" | "worker-javascript"
export function executionBackend(value: unknown = "worker-shell"): ExecutionBackend {
  if (value !== "worker-shell" && value !== "worker-javascript") throw new Error("Use worker-shell or worker-javascript; native processes are unavailable")
  return value
}
export interface RemoteWorkspace {
  id: string
  repository: string
  branch?: string
  directory: string
  status: "cloning" | "ready" | "failed"
  error?: string
  createdAt: number
}
export interface RemoteRun {
  id: string
  backend?: ExecutionBackend
  resultJSON?: string
  status: "running" | "completed" | "failed" | "cancelled"
  stdout: string
  stderr: string
  output?: string
  exitCode?: number
  truncated?: boolean
  error?: string
}
export function workspaceID(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new Error("Invalid workspace ID")
  return value
}
export function repositoryName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Repository must be owner/name")
  const name = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) || [".", ".."].includes(name.split("/")[1]!))
    throw new Error("Use a GitHub repository in owner/name format")
  return name
}
export function branchName(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".") || value.split("/").some(x => x.endsWith(".lock") || x.startsWith(".")))
    throw new Error("Invalid branch name")
  return value
}
export function remotePath(value = "."): string {
  if (value.includes("\0") || value.includes("\\")) throw new Error("Invalid remote path")
  const path = value.startsWith("/") ? value : `/workspace/repo/${value}`
  const segments: string[] = []
  for (const part of path.split("/")) {
    if (part === "..") segments.pop()
    else if (part && part !== ".") segments.push(part)
  }
  const result = "/" + segments.join("/")
  if (result !== "/workspace/repo" && !result.startsWith("/workspace/repo/")) throw new Error("Path escapes the remote checkout")
  return result
}
