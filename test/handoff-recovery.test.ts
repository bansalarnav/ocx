import { expect, test } from "bun:test"
import { Handoffs } from "../packages/server/src/remote/handoffs"
import type { WorkspaceManager, WorkspaceStorage } from "../packages/server/src/remote/manager"
import type { Workspace } from "../packages/protocol/src/workspaces"

/** Inject failures at external-call boundaries, then recreate the coordinator
 * against the same durable records to model a Worker restart. */
function fixture(direction: "outbound" | "inbound" = "outbound") {
  const records = new Map<string, unknown>()
  const workspace: Workspace = { id: "workspace", root: "/workspaces/workspace/repo", name: "Test", repository: "repo", remote: "https://git.invalid/repo", generation: 0, state: "ready", sessionIDs: direction === "outbound" ? ["ses_source"] : [], createdAt: 0, updatedAt: 0 }
  records.set("ocx/workspaces/workspace", workspace)
  const storage: WorkspaceStorage = {
    async get<T>(key: string) { return structuredClone(records.get(key)) as T | undefined },
    async put(key, value) { records.set(key, structuredClone(value)) },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...records].filter(([key]) => key.startsWith(prefix))) as Map<string, T> },
    async transaction(action) {
      const previous = structuredClone(records)
      try { return await action(storage) } catch (error) { records.clear(); for (const [key, value] of previous) records.set(key, value); throw error }
    },
  }
  const state = { failCheckpoint: false, failProvision: false, failAdmission: false, loseAdmissionReply: false, admissions: 0 }
  const inbox: { id: string }[] = []
  const locks = new Map<string, Promise<unknown>>()
  const getWorkspace = async () => (await storage.get<Workspace>("ocx/workspaces/workspace"))!
  const transcript = { info: { id: "ses_source", location: { directory: "/local/repo" } }, messages: [] }
  const api = async (path: string, method = "GET", body?: any): Promise<any> => {
    if (path.endsWith("/inbox")) return { data: [...inbox] }
    if (path.includes("/message/")) throw new Error("not found")
    if (path.endsWith("/export")) return { data: transcript }
    if (path.startsWith("/api/session?")) return { data: [], cursor: {} }
    if (path.endsWith("/import")) return { data: { id: body.info.id } }
    if (method === "POST" && path.endsWith("/prompt")) {
      if (state.failAdmission) { state.failAdmission = false; throw new Error("admission unavailable") }
      if (!inbox.some(input => input.id === body.id)) { inbox.push({ id: body.id }); state.admissions++ }
      if (state.loseAdmissionReply) { state.loseAdmissionReply = false; throw new Error("admission reply lost") }
      return { data: { id: body.id } }
    }
    if (path.endsWith("/interrupt") || path.endsWith("/wait")) return
    throw new Error("not found")
  }
  const manager = {
    storage, api, get: getWorkspace, sessions: async () => [],
    async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
      const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
      locks.set(id, next)
      try { return await next } finally { if (locks.get(id) === next) locks.delete(id) }
    },
    async checkpoint() {
      if (state.failCheckpoint) { state.failCheckpoint = false; throw new Error("checkpoint unavailable") }
      return "refs/ocx/checkpoints/checkpoint"
    },
    async provision() {
      if (state.failProvision) { state.failProvision = false; throw new Error("provision unavailable") }
      const current = await getWorkspace(); current.state = "ready"
      await storage.put("ocx/workspaces/workspace", current)
      return current
    },
  } as unknown as WorkspaceManager
  const bundle = { rootID: "ses_source", sessions: [transcript] }
  return { manager, state, storage, getWorkspace, bundle, coordinator: () => new Handoffs(manager) }
}

test("outbound preparation survives a restart after freeze and can resume or abort", async () => {
  const f = fixture()
  f.state.failCheckpoint = true
  await expect(f.coordinator().prepareRemote("workspace", "ses_source", "outbound")).rejects.toThrow("checkpoint unavailable")
  expect((await f.getWorkspace()).state).toBe("transferring")
  expect((await f.coordinator().get("outbound")).state).toBe("preparing")
  const recovered = await f.coordinator().prepareRemote("workspace", "ses_source", "outbound")
  expect(recovered.state).toBe("ready")
  await f.coordinator().settle("outbound", "abort")
  expect((await f.getWorkspace()).state).toBe("ready")
  expect((await f.getWorkspace()).handoffID).toBeUndefined()

  f.state.failCheckpoint = true
  await expect(f.coordinator().prepareRemote("workspace", "ses_source", "abort-preparing")).rejects.toThrow()
  expect((await f.coordinator().settle("abort-preparing", "abort")).state).toBe("aborted")
  expect((await f.getWorkspace()).state).toBe("ready")
})

test("an incomplete inbound provisioning can be aborted without committing the destination", async () => {
  const f = fixture("inbound")
  f.state.failProvision = true
  await expect(f.coordinator().receiveLocal("workspace", f.bundle, "refs/ocx/checkpoints/local", "inbound")).rejects.toThrow("provision unavailable")
  expect((await f.coordinator().get("inbound")).state).toBe("preparing")
  const aborted = await f.coordinator().settle("inbound", "abort")
  expect(aborted.state).toBe("aborted")
  expect((await f.getWorkspace()).state).toBe("local")
  expect(f.state.admissions).toBe(0)
})

test("committed ownership retries failed continuation admission and lost admission replies exactly once", async () => {
  for (const failure of ["failAdmission", "loseAdmissionReply"] as const) {
    const f = fixture("inbound")
    await f.coordinator().receiveLocal("workspace", f.bundle, "refs/ocx/checkpoints/local", "inbound")
    f.state[failure] = true
    await expect(f.coordinator().settle("inbound", "commit")).rejects.toThrow()
    expect((await f.coordinator().get("inbound")).state).toBe("committed")
    expect((await f.coordinator().get("inbound")).resumeRequested).toBe(false)
    const recovered = await f.coordinator().settle("inbound", "commit")
    expect(recovered.resumeRequested).toBe(true)
    await f.coordinator().settle("inbound", "commit")
    expect(f.state.admissions).toBe(1)
  }
})

test("a stale committed receipt cannot restart work after ownership changed", async () => {
  const f = fixture("inbound")
  await f.coordinator().receiveLocal("workspace", f.bundle, "refs/ocx/checkpoints/local", "inbound")
  await f.coordinator().settle("inbound", "commit", undefined, false)
  const workspace = await f.getWorkspace()
  workspace.state = "local"; workspace.generation++
  await f.storage.put("ocx/workspaces/workspace", workspace)
  await expect(f.coordinator().settle("inbound", "commit")).rejects.toThrow("ownership changed")
  expect(f.state.admissions).toBe(0)
})
