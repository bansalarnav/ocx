import { describe, expect, test } from "bun:test"
import type { RemoteWorkspace } from "../../packages/protocol/src/workspaces"
const origin = process.env.OCX_TEST_ORIGIN
const password = process.env.OCX_TEST_PASSWORD
const suite = origin && password ? describe : describe.skip
suite("remote Worker HTTP integration", () => {
  const authorization = `Basic ${btoa(`opencode:${password}`)}`
  async function request(path: string, input?: unknown, id?: string) {
    const url = new URL(path, origin)
    if (id) url.searchParams.set("workspace", id)
    return fetch(url, { method: input ? "POST" : "GET", headers: { authorization, "content-type": "application/json" }, body: input ? JSON.stringify(input) : undefined })
  }
  test("requires authentication and rejects the private auth computer as a workspace", async () => {
    expect((await fetch(`${origin}/api/remote/workspaces`)).status).toBe(401)
    expect((await request("/api/remote/current", undefined, "github-auth")).status).toBe(400)
    expect((await request("/api/remote/current", undefined, crypto.randomUUID())).status).toBe(409)
  })
  test("clones two repositories, isolates their files, and reattaches to saved metadata", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    const repositories = ["octocat/Hello-World", "octocat/Spoon-Knife"]
    for (let index = 0; index < ids.length; index++) {
      const input = { id: ids[index], repository: repositories[index] }
      expect((await request("/api/remote/workspaces", input)).status).toBe(202)
      expect((await request("/api/remote/workspaces", input)).status).toBe(202)
    }
    let ready = false
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await (await request("/api/remote/workspaces")).json() as RemoteWorkspace[]
      const selected = rows.filter(row => ids.includes(row.id))
      for (const row of selected) if (row.status === "failed") throw new Error(row.error)
      if (selected.length === 2 && selected.every(row => row.status === "ready")) { ready = true; break }
      await Bun.sleep(500)
    }
    expect(ready).toBe(true)
    for (let index = 0; index < ids.length; index++) {
      const row = await (await request("/api/remote/current", undefined, ids[index])).json() as RemoteWorkspace
      expect(row.repository).toBe(repositories[index])
      const response = await request("/api/fs/list", undefined, ids[index])
      expect(response.status).toBe(200)
      const listing = await response.json() as { data: { path: string }[] }
      if (index === 0) expect(listing.data.some(entry => entry.path === "README")).toBe(true)
      else expect(listing.data.some(entry => entry.path === "index.html")).toBe(true)
    }
    expect(await (await request("/api/remote/current")).json()).toBeNull()
    expect((await request("/api/remote/workspaces", { id: ids[0], repository: "other/repository" })).status).toBe(400)
    const first = await request("/api/fs/read/README", undefined, ids[0])
    expect(first.status).toBe(200)
    expect((await first.text()).length).toBeGreaterThan(0)
  }, 90000)
})
