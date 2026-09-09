import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Transport, transportLayer } from "../../packages/client/src/transport"
import type { RemoteWorkspace } from "../../packages/protocol/src/workspaces"
const origin = process.env.OCX_TEST_ORIGIN
const password = process.env.OCX_TEST_PASSWORD
const suite = origin && password ? describe : describe.skip
suite("remote WebSocket transport", () => {
  test("pins requests to the selected repository and does not trust frame workspace headers", async () => {
    const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    for (const id of ids) {
      const response = await fetch(`${origin}/api/remote/workspaces`, { headers, method: "POST", body: JSON.stringify({ id, repository: "octocat/Hello-World" }) })
      expect(response.status).toBe(202)
    }
    let ready: RemoteWorkspace[] = []
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await (await fetch(`${origin}/api/remote/workspaces`, { headers })).json() as RemoteWorkspace[]
      const selected = rows.filter(row => ids.includes(row.id))
      for (const row of selected) if (row.status === "failed") throw new Error(row.error)
      ready = selected.filter(row => row.status === "ready")
      if (ready.length === 2) break
      await Bun.sleep(250)
    }
    expect(ready.length).toBeGreaterThanOrEqual(2)
    const selected = ready[0]!
    const other = ready[1]!
    const check = Effect.gen(function* () {
      const transport = yield* Transport
      const response = yield* transport.fetch(new Request(`${origin}/api/remote/current`, { headers: { "x-ocx-workspace": other.id } }))
      const value = yield* Effect.promise(() => response.json())
      expect(value.id).toBe(selected.id)
      const list = yield* transport.fetch(new Request(`${origin}/api/fs/list`))
      expect(list.status).toBe(200)
      const files = yield* Effect.promise(() => list.json())
      expect(files.location.directory).toBe("/workspace/repo")
      expect(files.data.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(transportLayer(origin!, password, selected.id)), Effect.scoped)
    await Effect.runPromise(check)
    // A fresh connection reaches the same saved workspace.
    await Effect.runPromise(check)
  }, 30000)
})
