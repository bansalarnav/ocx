/** Public workspace state. Provider credentials never belong in this record. */
export interface Workspace {
  id: string
  name: string
  root: string
  repository: string
  remote: string
  branch?: string
  source?: string
  projectID?: string
  sandboxID?: string
  checkpointRef?: string
  sessionIDs: string[]
  /** Cached visible root conversations; sessionIDs also tracks subagents. */
  conversationCount?: number
  state: "preparing" | "ready" | "paused" | "transferring" | "local" | "failed"
  generation: number
  /** Durable identity of the operation currently holding execution ownership. */
  handoffID?: string
  createdAt: number
  updatedAt: number
  error?: string
}

export interface RepositoryAccess {
  url: string
  token: string
  expiresAt?: string
}

export interface CreateWorkspace {
  id?: string
  name?: string
  source?: string
  branch?: string
  newBranch?: string
  projectID?: string
}

export interface Handoff {
  id: string
  workspaceID: string
  sessionID: string
  direction: "local-to-remote" | "remote-to-local"
  state: "preparing" | "ready" | "committed" | "aborted"
  generation: number
  checkpointRef?: string
  /** SessionTransfer.Export, validated by the pinned OpenCode server. */
  session?: unknown
  destinationSessionID?: string
  resumeRequested?: boolean
  createdAt: number
}

export const workspacePrefix = "/api/ocx/workspaces"
export const handoffPrefix = "/api/ocx/handoffs"

export function validID(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("Invalid identifier")
  return value
}

export function httpsRepository(value: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}.git`
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Repository must be an HTTPS URL without embedded credentials")
  return url.toString()
}
