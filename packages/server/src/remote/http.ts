import { handoffPrefix, workspacePrefix, validID, type CreateWorkspace } from "@ocx/protocol/workspaces"
import { Handoffs } from "./handoffs"
import type { WorkspaceManager } from "./manager"
import { projectPrefix } from "@ocx/protocol/projects"

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
async function body(request: Request): Promise<any> {
  if (Number(request.headers.get("content-length")) > 32 * 1024 * 1024) throw new Error("Transfer exceeds 32 MiB")
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("Transfer exceeds 32 MiB") }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes) || "{}")
}

export function workspaceHandler(manager: WorkspaceManager) {
  const handoffs = new Handoffs(manager)
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const isWorkspace = url.pathname === workspacePrefix || url.pathname.startsWith(workspacePrefix + "/")
    const isHandoff = url.pathname === handoffPrefix || url.pathname.startsWith(handoffPrefix + "/")
    const isProject = url.pathname === projectPrefix || url.pathname === projectPrefix + "/checkouts"
    if (!isWorkspace && !isHandoff && !isProject) return
    try {
      if (isProject) {
        if (url.pathname === projectPrefix && request.method === "GET") return json({ projects: await manager.projects() })
        if (url.pathname.endsWith("/checkouts") && request.method === "POST") return json({ checkout: await manager.registerCheckout(await body(request)) })
        return json({ error: "Unknown project operation" }, 404)
      }
      const parts = url.pathname.slice((isWorkspace ? workspacePrefix : handoffPrefix).length).split("/").filter(Boolean)
      const input = request.method === "POST" ? await body(request) : {}
      if (isWorkspace && !parts.length) {
        if (request.method === "GET") return json({ workspaces: await manager.list() })
        if (request.method === "POST") {
          const result = await manager.allocate(input as CreateWorkspace)
          if (input.provision) result.workspace = await manager.provision(result.workspace.id, undefined, input.newBranch)
          return json(result, 201)
        }
      }
      if (isWorkspace && parts[0]) {
        const id = validID(parts[0]); const action = parts[1]
        if (parts.length === 1 && request.method === "DELETE") return json(await manager.remove(id))
        if (!action && request.method === "GET") return json({ workspace: await manager.get(id) })
        if (action === "sessions" && request.method === "GET") return json({ sessions: await manager.sessions(id) })
        if (request.method === "POST") {
          if (action === "access") return json(await manager.access(id, input.scope === "read" ? "read" : "write"))
          if (action === "provision") return json({ workspace: await manager.provision(id, input.checkpointRef, input.newBranch) })
          if (action === "sessions") return json({ session: await manager.createSession(id, input) }, 201)
          if (action === "checkpoint") return json({ checkpointRef: await manager.checkpoint(id) })
          if (action === "pause") return json({ workspace: await manager.pause(id) })
          if (action === "preview") return json({ url: await manager.preview(id, input.port) })
          if (action === "pull-request") return json(await manager.pullRequest(id, input))
        }
      }
      if (isHandoff && request.method === "POST") {
        if (!parts.length) return json({ handoff: await handoffs.prepareRemote(input.workspaceID, input.sessionID, input.id) })
        if (parts[0] === "receive") return json({ handoff: await handoffs.receiveLocal(input.workspaceID, input.bundle, input.checkpointRef, input.id) })
        if (parts[1] === "commit" || parts[1] === "abort") return json({ handoff: await handoffs.settle(parts[0], parts[1], input.destinationSessionID, input.resume !== false) })
      }
      if (isHandoff && parts.length === 1 && request.method === "GET") return json({ handoff: await handoffs.get(parts[0]) })
      return json({ error: "Unknown workspace operation" }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workspace operation failed"
      return json({ error: message }, /not found/i.test(message) ? 404 : /ownership|not ready|not available|cannot be settled|cannot delete/i.test(message) ? 409 : 400)
    }
  }
}

/** The gateway rejects execution after handoff. History stays readable. */
export async function workspaceExecutionGuard(manager: WorkspaceManager, request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/api\/(?:experimental\/)?session\/([^/]+)\/(prompt|shell|command|resume|background|move|synthetic)/)
  if (!match) return
  const workspace = await manager.forSession(decodeURIComponent(match[1]))
  if (workspace && !["ready", "paused"].includes(workspace.state))
    return json({ error: `Workspace is ${workspace.state}; execution belongs to its handoff destination` }, 409)
}
