import type { Handoff } from "@ocx/protocol/workspaces"
import { validID } from "@ocx/protocol/workspaces"
import { exportSessionFamily, relocateSessions, type SessionBundle } from "@ocx/protocol/session-transfer"
import type { WorkspaceManager } from "./manager"
import type { Workspace } from "@ocx/protocol/workspaces"

const key = (id: string) => `ocx/handoffs/${validID(id)}`
type StoredHandoff = Omit<Handoff, "session"> & { sessionChunks?: number }
export class Handoffs {
  constructor(private readonly manager: WorkspaceManager) {}
  async get(id: string) {
    const transfer = await this.manager.storage.get<StoredHandoff>(key(id))
    if (!transfer) throw new Error("Handoff not found")
    if (transfer.sessionChunks === undefined) return transfer as Handoff
    const chunks: Uint8Array[] = []
    let size = 0
    for (let index = 0; index < transfer.sessionChunks; index++) {
      const chunk = await this.manager.storage.get<Uint8Array>(`ocx/handoff-data/${id}/${index}`)
      if (!chunk) throw new Error("Handoff transcript is incomplete")
      chunks.push(chunk); size += chunk.byteLength
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const { sessionChunks: _, ...info } = transfer
    return { ...info, session: JSON.parse(new TextDecoder().decode(bytes)) } as Handoff
  }
  private async save(handoff: Handoff, storage = this.manager.storage) {
    const previous = await storage.get<StoredHandoff>(key(handoff.id))
    let sessionChunks = previous?.sessionChunks
    if (sessionChunks === undefined && handoff.session !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(handoff.session))
      if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("Handoff transcript exceeds 32 MiB")
      sessionChunks = Math.ceil(bytes.length / 60000)
      for (let index = 0; index < sessionChunks; index++)
        await storage.put(`ocx/handoff-data/${handoff.id}/${index}`, bytes.slice(index * 60000, (index + 1) * 60000))
    }
    const { session: _, ...info } = handoff
    await storage.put(key(handoff.id), { ...info, sessionChunks })
  }
  private async saveOwnership(workspace: Workspace, handoff: Handoff) {
    const persist = async (storage: typeof this.manager.storage) => {
      const workspaceKey = `ocx/workspaces/${workspace.id}`
      const latest = await storage.get<Workspace>(workspaceKey)
      if (!latest) throw new Error("Workspace not found")
      // Concurrent idle checkpoints and session discovery may update metadata.
      // This transaction owns only execution state and the ownership generation.
      await storage.put(workspaceKey, { ...latest, state: workspace.state, generation: workspace.generation,
        handoffID: workspace.handoffID, updatedAt: Date.now() })
      await this.save(handoff, storage)
    }
    if (this.manager.storage.transaction) await this.manager.storage.transaction(persist)
    else await persist(this.manager.storage)
  }
  async prepareRemote(workspaceID: string, sessionID: string, id = crypto.randomUUID()) {
    validID(workspaceID)
    validID(sessionID)
    validID(id)
    return this.manager.exclusive(workspaceID, async () => {
      const existing = await this.manager.storage.get<Handoff>(key(id))
      if (existing) {
        if (existing.workspaceID !== workspaceID || existing.sessionID !== sessionID || existing.direction !== "remote-to-local") throw new Error("Handoff identity already used")
        if (existing.state !== "preparing") return this.get(id)
      }
      let workspace = await this.manager.get(workspaceID)
      if (!workspace.sessionIDs.includes(sessionID)) {
        const registered = await this.manager.forSession(sessionID)
        if (registered?.id !== workspaceID) throw new Error("Session does not belong to this workspace")
        workspace = await this.manager.get(workspaceID)
      }
      const handoff: Handoff = existing ?? {
        id, workspaceID, sessionID, direction: "remote-to-local", state: "preparing",
        generation: workspace.generation, createdAt: Date.now(),
      }
      if (existing) {
        if (workspace.state !== "transferring" || workspace.handoffID !== id || workspace.generation !== handoff.generation)
          throw new Error("Workspace ownership changed during preparation")
      } else {
        if (!["ready", "paused"].includes(workspace.state) || workspace.handoffID) throw new Error("Workspace is not ready")
        workspace.state = "transferring"
        workspace.handoffID = id
        // A restart after this point always leaves an addressable operation.
        await this.saveOwnership(workspace, handoff)
      }
        // Include conversations created through OpenCode's own New Session UI,
        // which may not have passed through our checkout creation endpoint.
        await this.manager.sessions(workspaceID)
        workspace = await this.manager.get(workspaceID)
        // Stop every session using the checkout before capturing it.
        const bundle = await exportSessionFamily(sessionID, this.manager.api)
        for (const id of workspace.sessionIDs) {
          if (bundle.sessions.some(s => s.info.id === id)) continue
          const family = await exportSessionFamily(id, this.manager.api)
          bundle.sessions.push(...family.sessions.filter(s => !bundle.sessions.some(p => p.info.id === s.info.id)))
        }
        handoff.checkpointRef = await this.manager.checkpoint(workspaceID)
        handoff.session = bundle
        handoff.state = "ready"
        await this.save(handoff)
        return handoff
    })
  }

  async receiveLocal(workspaceID: string, bundle: SessionBundle, checkpointRef: string, id = crypto.randomUUID()) {
    validID(workspaceID)
    validID(id)
    // Use a distinct lock because provisioning and import settlement acquire
    // the workspace lock themselves. The receive lock spans receipt creation,
    // provisioning and importing, so simultaneous retries share fresh IDs.
    return this.manager.exclusive(`receive:${workspaceID}`, () => this.receive(workspaceID, bundle, checkpointRef, id))
  }

  private async receive(workspaceID: string, bundle: SessionBundle, checkpointRef: string, id: string) {
    if (!/^refs\/ocx\/checkpoints\/[a-zA-Z0-9_-]+$/.test(checkpointRef)) throw new Error("Invalid checkpoint ref")
    // Persist the identities before importing, making retry after lost replies safe.
    const workspace = await this.manager.get(workspaceID)
    const identity = await this.manager.storage.get<Handoff>(key(id))
    if (identity && (identity.workspaceID !== workspaceID || identity.direction !== "local-to-remote" || identity.checkpointRef !== checkpointRef || identity.sessionID !== bundle.rootID))
      throw new Error("Handoff identity already used")
    let handoff = identity ? await this.get(identity.id) : undefined
    if (!handoff) {
      if (workspace.handoffID || workspace.sessionIDs.length || !["preparing", "failed", "ready"].includes(workspace.state))
        throw new Error("Workspace ownership prevents receiving a new handoff")
      const relocated = relocateSessions(bundle, workspace.root)
      handoff = { id, workspaceID, sessionID: bundle.rootID, destinationSessionID: relocated.rootID,
        direction: "local-to-remote", state: "preparing", generation: workspace.generation,
        checkpointRef, session: relocated, createdAt: Date.now() }
      workspace.handoffID = handoff.id
      await this.saveOwnership(workspace, handoff)
    }
    if (handoff.state === "committed" || handoff.state === "ready") return handoff
    if (handoff.state === "aborted") throw new Error("Handoff was aborted; start a new transfer")
    // An interrupted import already has its checkout. Replaying provisioning
    // would try to restore over it and prevent recovery of the remaining sessions.
    if (workspace.state !== "transferring") await this.manager.provision(workspaceID, checkpointRef)
    return this.manager.exclusive(workspaceID, async () => {
      const current = await this.manager.get(workspaceID)
      handoff = await this.get(handoff!.id)
      if (handoff.state !== "preparing" || current.handoffID !== handoff.id || current.generation !== handoff.generation)
        throw new Error("Workspace ownership changed during import")
      current.state = "transferring"
      await this.manager.storage.put(`ocx/workspaces/${workspaceID}`, current)
      for (const session of (handoff!.session as SessionBundle).sessions) {
        if (!current.sessionIDs.includes(session.info.id)) {
          // GET distinguishes a previous successful import from a failed attempt.
          let exists = false
          try { await this.manager.api(`/api/session/${session.info.id}`); exists = true } catch {}
          if (!exists) await this.manager.api("/api/experimental/session/import", "POST", { ...session, location: { directory: current.root } })
          current.sessionIDs.push(session.info.id)
          await this.manager.storage.put(`ocx/workspaces/${workspaceID}`, current)
        }
      }
      handoff!.state = "ready"
      await this.save(handoff!)
      return handoff!
    })
  }

  async settle(id: string, action: "commit" | "abort", destinationSessionID?: string, resume = true) {
    const handoff = await this.get(id)
    return this.manager.exclusive(handoff.workspaceID, async () => {
      const current = await this.get(id)
      if (current.state === "committed" && action === "commit") {
        if (resume) await this.resume(current)
        return current
      }
      if (current.state === "aborted" && action === "abort") return current
      if (current.state !== "ready" && !(action === "abort" && current.state === "preparing")) throw new Error("Handoff cannot be settled in its current state")
      const workspace = await this.manager.get(current.workspaceID)
      if (workspace.generation !== current.generation || workspace.handoffID !== current.id) throw new Error("Workspace ownership changed")
      if (action === "commit" && workspace.state !== "transferring") throw new Error("Workspace is not ready for commit")
      if (action === "commit") {
        current.state = "committed"
        current.destinationSessionID = destinationSessionID ?? current.destinationSessionID
        workspace.generation++
        workspace.state = current.direction === "remote-to-local" ? "local" : "ready"
        current.resumeRequested = false
      } else {
        current.state = "aborted"
        workspace.state = current.direction === "remote-to-local" ? "ready" : "local"
      }
      delete workspace.handoffID
      await this.saveOwnership(workspace, current)
      if (action === "commit" && resume) await this.resume(current)
      return current
    })
  }

  private async resume(handoff: Handoff) {
    if (handoff.direction !== "local-to-remote" || !handoff.destinationSessionID || handoff.resumeRequested) return
    const workspace = await this.manager.get(handoff.workspaceID)
    if (workspace.generation !== handoff.generation + 1 || !["ready", "paused"].includes(workspace.state) || workspace.handoffID)
      throw new Error("Workspace ownership changed before continuation was admitted")
    const messageID = `msg_handoff_${handoff.id.replaceAll("-", "")}`
    let admitted = false
    const inbox = await this.manager.api(`/api/session/${handoff.destinationSessionID}/inbox`)
    admitted = inbox.data.some((input: { id: string }) => input.id === messageID)
    if (!admitted) {
      try { await this.manager.api(`/api/session/${handoff.destinationSessionID}/message/${messageID}`); admitted = true } catch {}
    }
    // Fixed input ID makes recovery safe if the admission response was lost.
    if (!admitted) await this.manager.api(`/api/session/${handoff.destinationSessionID}/prompt`, "POST", {
      id: messageID,
      text: "This thread has continued on a remote workspace. Previous absolute paths refer to the source machine; use the current location for all operations. Continue the task from the handoff checkpoint.",
    })
    handoff.resumeRequested = true
    await this.save(handoff)
  }
}
