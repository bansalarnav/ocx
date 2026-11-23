import { expect, test } from "bun:test"
import { WorkspaceManager, type WorkspaceStorage } from "../packages/server/src/remote/manager"
import { workspaceExecutionGuard, workspaceHandler } from "../packages/server/src/remote/http"
import type { Workspace } from "../packages/protocol/src/workspaces"

function fixture() {
  const workspace: Workspace = {
    id: "demo", name: "Demo", root: "/tmp/demo", repository: "ocx-demo", remote: "https://example.invalid/demo",
    sandboxID: "sandbox-demo", sessionIDs: ["session-demo"], state: "paused", generation: 0, createdAt: 0, updatedAt: 0,
  }
  const values = new Map<string, unknown>([
    ["ocx/workspaces/demo", workspace],
    ["ocx/workspaces/other", { ...workspace, id: "other", root: "/tmp/other", sessionIDs: [] }],
  ])
  const events: string[] = []
  const storage: WorkspaceStorage = {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined },
    async put(key, value) { values.set(key, structuredClone(value)) },
    async delete(key) { events.push(`delete:${key}`); return values.delete(key) },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<string, T> },
  }
  let active = false, queued = false, fail = false
  const api = async (path: string, method = "GET", body?: any) => {
    if (path === "/api/session/active") return { data: active ? { "session-demo": {} } : {} }
    if (path.startsWith("/api/session?")) return { data: [{ id: "session-demo" }] }
    if (path.endsWith("/inbox")) return { data: queued ? [{ id: "prompt" }] : [] }
    if (method === "PATCH") { expect(body).toEqual({ archived: true }); events.push(`archive:${path}`); return {} }
    throw new Error(`Unexpected API call: ${path}`)
  }
  const manager = new WorkspaceManager(storage, {}, api, {
    compute: {
      async create() { throw new Error("Unexpected create") },
      async run() { throw new Error("Unexpected run") },
      async pause() {}, async url() { return "" },
      async destroy(id) { events.push(`destroy:${id}`); if (fail) throw new Error("Transport failure") },
    },
    repositories: {
      async create() { throw new Error("Unexpected create") },
      async access() { throw new Error("Unexpected access") },
      async remove(name) { events.push(`remove:${name}`) },
    },
  })
  return { manager, events, values, active(value: boolean) { active = value }, queued(value: boolean) { queued = value }, fail(value: boolean) { fail = value } }
}

test("DELETE removes only the selected checkout and archives its conversation", async () => {
  const f = fixture()
  const response = await workspaceHandler(f.manager)(new Request("https://worker/api/ocx/workspaces/demo", { method: "DELETE" }))
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ ok: true, id: "demo" })
  expect(f.events).toEqual(["archive:/api/session/session-demo", "destroy:sandbox-demo", "remove:ocx-demo", "delete:ocx/workspaces/demo"])
  expect((await f.manager.list()).map(w => w.id)).toEqual(["other"])
})

test("active and queued conversations prevent deletion without removing resources", async () => {
  for (const busy of ["active", "queued"] as const) {
    const f = fixture()
    f[busy](true)
    const response = await workspaceHandler(f.manager)(new Request("https://worker/api/ocx/workspaces/demo", { method: "DELETE" }))
    expect(response?.status).toBe(409)
    expect((await f.manager.get("demo")).state).toBe("paused")
    expect(f.events).toEqual([])
  }
})

test("failed cleanup remains frozen and can be retried", async () => {
  const f = fixture()
  f.fail(true)
  await expect(f.manager.remove("demo")).rejects.toThrow("Transport failure")
  expect((await f.manager.get("demo")).state).toBe("deleting")
  const denied = await workspaceExecutionGuard(f.manager, new Request("https://worker/api/session/session-demo/prompt", { method: "POST" }))
  expect(denied?.status).toBe(409)
  await expect(f.manager.run("demo", "echo test")).rejects.toThrow("not available")
  expect(f.events.some(e => e.startsWith("remove:"))).toBe(false)
  f.fail(false)
  await f.manager.remove("demo")
  expect(f.values.has("ocx/workspaces/demo")).toBe(false)
})

test("a handoff-owned checkout cannot be deleted", async () => {
  const f = fixture()
  const workspace = await f.manager.get("demo")
  f.values.set("ocx/workspaces/demo", { ...workspace, state: "transferring" })
  await expect(f.manager.remove("demo")).rejects.toThrow("ownership")
  expect(f.events).toEqual([])
})
