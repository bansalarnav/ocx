import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Host, hostLayer } from "../packages/server/src/host"
import { PluginStore } from "../packages/server/src/plugin-manager/store"
import { makeInstanceConfigStore } from "../packages/server/src/instance-config"
import type { WorkspaceManager } from "../packages/server/src/remote/manager"

test("workerd host creates and reloads a remote session and serves its native file browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocx-host-"))
  const database = new Database(":memory:")
  const values = new Map<string, unknown>()
  const storage = {
    sql: { exec(query: string, ...params: any[]) {
      const statement = database.query(query)
      const rows = statement.values(...params) ?? []
      const names = statement.columnNames ?? []
      return { columnNames: names, raw: () => rows.values(), toArray: () => rows.map(row => Object.fromEntries(names.map((name, index) => [name, row[index]]))) }
    } },
    async transaction<T>(body: (transaction: any) => Promise<T>) {
      database.exec("BEGIN")
      try { const result = await body({ rollback() { throw new Error("rolled back") } }); database.exec("COMMIT"); return result }
      catch (error) { database.exec("ROLLBACK"); throw error }
    },
    transactionSync<T>(body: () => T) { return database.transaction(body)() },
    async get(key: string) { return values.get(key) }, async put(key: string, value: unknown) { values.set(key, value) },
  }
  const virtual = "/workspaces/test-host/repo"
  let remoteSession: string | undefined
  const manager = {
    async resolve(directory: string) { return directory === virtual ? { id: "test-host", root: virtual } : undefined },
    async forSession(id: string) { return id === remoteSession ? { id: "test-host", root: virtual } : undefined },
    async checkpoint() {},
    async run(_id: string, command: string, options: { stdin?: string } = {}) {
      // Use a real local process as the sandbox transport. Only its physical
      // directory differs from the location registered in the server.
      let input = options.stdin
      if (input) {
        const payload = JSON.parse(input)
        payload.root = root
        input = JSON.stringify(payload)
      }
      const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", input })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 }
    },
  } as unknown as WorkspaceManager
  const runtime = ManagedRuntime.make(hostLayer(storage as never, {}, makeInstanceConfigStore(storage as never), () => Effect.void, undefined, manager).pipe(
    Layer.provide(Layer.succeed(PluginStore, {
      list: Effect.succeed([]), get: () => Effect.succeed(undefined), put: () => Effect.void, remove: () => Effect.void,
    })),
  ))
  const request = async (path: string, body?: unknown) => {
    const response = await runtime.runPromise(Host.use(host => host.fetch(new Request("http://localhost" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))))
    const text = await response.text()
    expect(response.status, text).toBe(200)
    return text
  }
  try {
    await writeFile(join(root, "hello.txt"), "remote contents\n")
    const created = JSON.parse(await request("/api/session", { location: { directory: virtual }, title: "Remote host test" }))
    remoteSession = created.data.id
    expect(created.data.location.directory).toBe(virtual)
    const session = JSON.parse(await request(`/api/session/${remoteSession}`))
    expect(session.data.location.directory).toBe(virtual)
    const query = "?location[directory]=" + encodeURIComponent(virtual)
    const listed = JSON.parse(await request("/api/fs/list" + query))
    expect(listed.data).toContainEqual({ path: "hello.txt", type: "file" })
    expect(await request("/api/fs/read/hello.txt" + query)).toBe("remote contents\n")
  } finally {
    await runtime.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
