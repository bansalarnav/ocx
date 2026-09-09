import { afterEach, describe, expect, mock, test } from "bun:test"
mock.module("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: any, public env: any) {} } }))
const { WorkspaceCatalog } = await import("../../packages/server/src/remote/catalog")
class Storage {
  values = new Map<string, any>()
  chain = Promise.resolve()
  async get(key: string) { return structuredClone(this.values.get(key)) }
  async put(key: string | Record<string, any>, value?: any) {
    for (const [name, item] of typeof key === "string" ? [[key, value]] : Object.entries(key)) this.values.set(name, structuredClone(item))
  }
  async delete(key: string) { return this.values.delete(key) }
  async list({ prefix }: { prefix: string }) { return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => [key, structuredClone(value)])) }
  transaction<T>(fn: (storage: Storage) => Promise<T>) {
    const result = this.chain.then(() => fn(this))
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
function fixture(clone: (...args: any[]) => Promise<void> = async () => {}) {
  const storage = new Storage()
  const pending: Promise<unknown>[] = []
  const remote = { clone }
  const env = { COMPUTERS: { idFromName: (id: string) => id, get: () => remote } }
  const catalog = new WorkspaceCatalog({ storage, waitUntil: (work: Promise<unknown>) => pending.push(work) } as any, env as any)
  const request = (path: string, body?: unknown) => catalog.fetch(new Request(`https://test/api/remote${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }))
  return { storage, request, settle: () => Promise.all(pending), remote }
}
describe("workspace catalog", () => {
  test("deduplicates concurrent clone requests but allows independent checkouts of the same repo", async () => {
    let count = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = fixture(async () => { count++; await gate })
    const input = { id: crypto.randomUUID(), repository: "owner/repo" }
    await Promise.all([f.request("/workspaces", input), f.request("/workspaces", input)])
    expect(count).toBe(1)
    await f.request("/workspaces", { ...input, id: crypto.randomUUID() })
    expect(count).toBe(2)
    release(); await f.settle()
    const rows = await (await f.request("/workspaces")).json()
    expect(rows.length).toBe(2)
    expect(rows.every((row: any) => row.status === "ready")).toBe(true)
    expect((await f.request("/workspaces", { ...input, repository: "other/repo" })).status).toBe(400)
  })
  test("keeps a failed clone recoverable under the same workspace ID", async () => {
    let count = 0
    const f = fixture(async () => { if (++count === 1) throw new Error("Network disconnected") })
    const id = crypto.randomUUID()
    await f.request("/workspaces", { id, repository: "owner/repo" }); await f.settle()
    expect((await (await f.request("/workspaces")).json())[0].status).toBe("failed")
    await f.request(`/workspaces/${id}/retry`, {}); await f.settle()
    const rows = await (await f.request("/workspaces")).json()
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe("ready")
    expect(rows[0].error).toBeUndefined()
  })
  test("validates a GitHub token before storing it, and returns only the account name", async () => {
    const f = fixture()
    globalThis.fetch = mock(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-private-token")
      return Response.json({ login: "octocat" })
    }) as any
    const response = await f.request("/github", { token: "test-private-token" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ user: "octocat" })
    expect(await f.storage.get("github:token")).toBe("test-private-token")
    expect(await (await f.request("/github")).json()).toEqual({ user: "octocat" })
  })
  test("keeps existing credentials when replacement is rejected and does not echo secrets", async () => {
    const f = fixture()
    await f.storage.put({ "github:user": "previous", "github:token": "previous-token" })
    globalThis.fetch = mock(async () => new Response("echo-private-token", { status: 403 })) as any
    const response = await f.request("/github", { token: "echo-private-token" })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("echo-private-token")
    expect(await f.storage.get("github:token")).toBe("previous-token")
    expect(await f.storage.get("github:user")).toBe("previous")
  })
  test("rejects malformed credentials and invalid GitHub identity responses", async () => {
    const f = fixture()
    const fetcher = mock(async () => Response.json({ message: "Missing identity" }))
    globalThis.fetch = fetcher as any
    for (const token of [null, "", "abc def", "a".repeat(1025)]) {
      expect((await f.request("/github", { token })).status).toBe(400)
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect((await f.request("/github", { token: "valid-shape" })).status).toBe(400)
    expect(await f.storage.get("github:token")).toBeUndefined()
  })
})
