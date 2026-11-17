import type { RemoteLaunch } from "./remote"

export interface ComposerTarget {
  location: "device" | "cloud"
  checkoutID?: string
  workspaceID?: string
  newCheckout?: { id: string; source: string; branch?: string }
  machine: string
  checkout: string
  projectID: string
}
interface Destination { session: any; launch: RemoteLaunch }
export interface ComposerRouterOptions {
  create(target: ComposerTarget, input: Record<string, any>): Promise<Destination>
  forward(launch: RemoteLaunch, request: Request, path: string): Promise<Response>
  admitted(launch: RemoteLaunch): void
}

/** Retarget the native protocol, retaining its full prompt and attachment body.
 * Merely selecting a target performs no session creation or sandbox work. */
export class ComposerRouter {
  selection?: ComposerTarget
  private readonly destinations = new Map<string, Promise<Destination>>()
  private inFlight = 0
  private awaitingAttachment = false
  constructor(private readonly options: ComposerRouterOptions) {}
  select(target: ComposerTarget | undefined) {
    if (this.inFlight || this.awaitingAttachment) throw new Error("Wait for the current submission to finish before changing its location")
    // A rejected admission must not trap the composer on that destination.
    // Keep the mapping for retries until the user explicitly chooses again.
    this.destinations.clear()
    this.selection = target
  }
  clear() { this.selection = undefined; this.destinations.clear(); this.awaitingAttachment = false }
  private prepare(id: string, input: Record<string, any>, newSession = false) {
    let pending = this.destinations.get(id)
    if (!pending) {
      if (!this.selection) throw new Error("No composer target selected")
      // The home composer has already minted an optimistic session ID. A
      // checkout change inside an existing conversation starts a new one,
      // including when both checkouts use the same OpenCode database.
      const destinationID = newSession ? id : `ses_${crypto.randomUUID().replaceAll("-", "")}`
      pending = this.options.create(this.selection, { ...input, id: destinationID }).catch(error => { this.destinations.delete(id); throw error })
      this.destinations.set(id, pending)
    }
    return pending
  }
  async intercept(request: Request): Promise<Response | undefined> {
    if (!this.selection) return
    const url = new URL(request.url), path = url.pathname
    const creating = request.method === "POST" && path === "/api/session"
    const match = path.match(/^\/api\/(experimental\/)?session\/([^/]+)(\/.*)?$/)
    if (!creating && !match) return
    const id = match ? decodeURIComponent(match[2]) : ""
    const operation = match?.[3]?.slice(1) ?? ""
    // A source terminal's environment must not be uploaded to another executor.
    if (operation === "environment" && ["POST", "PUT"].includes(request.method)) return new Response(null, { status: 204 })
    // A new conversation has no staged revert. Native submit may commit the
    // original conversation's revert before it commits the selected model.
    if (operation === "revert/commit" && request.method === "POST") return new Response(null, { status: 204 })
    const prepares = request.method === "POST" && ["agent", "model", "synthetic", "prompt", "command", "shell"].includes(operation)
    if (!creating && !prepares && !this.destinations.has(id)) return
    this.inFlight++
    try {
      if (creating) {
        const input = await request.clone().json() as Record<string, any>
        const createdID = typeof input.id === "string" ? input.id : `ses_${crypto.randomUUID().replaceAll("-", "")}`
        const result = await this.prepare(createdID, input, true)
        return Response.json({ data: { ...result.session, id: createdID } }, { status: 200 })
      }
      const input = prepares ? await request.clone().json() as Record<string, any> : {}
      const destination = await this.prepare(id, { model: input.model, agent: input.agent })
      const destinationPath = `/api/${match![1] ?? ""}session/${encodeURIComponent(destination.session.id)}${match![3] ?? ""}${url.search}`
      const response = await this.options.forward(destination.launch, request, destinationPath)
      if (response.ok && ["prompt", "command", "shell"].includes(operation)) {
        this.awaitingAttachment = true
        this.options.admitted(destination.launch)
      }
      return response
    } finally { this.inFlight-- }
  }
}
