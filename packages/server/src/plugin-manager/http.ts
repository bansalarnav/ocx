import { Cause, Effect } from "effect"
import { authenticated } from "../tui-registry"
import type { PluginStoreService } from "./store"
import type { StoredPlugin } from "./types"
import type { CloudPluginInfo, InstallCloudPlugin } from "@ocx/protocol/cloud-plugins"
import { installPackage } from "./package-installer"
import { attempt } from "@ocx/protocol/errors"

export const packageView = (p: StoredPlugin): CloudPluginInfo => ({
  id: p.id, package: p.package!.name, version: p.package!.version,
  scope: p.package!.scope, projectID: p.package!.projectID, enabled: p.enabled,
  updatedAt: p.updatedAt, runtime: "quickjs-promise",
  serverStatus: !p.serverBundle ? "absent" : p.enabled ? "enabled" : "disabled",
  tuiStatus: !p.tuiBundle ? "absent" : p.enabled ? "available-to-clients" : "disabled",
  warnings: p.bundleWarnings ?? [],
})
export const makeCloudPluginsHandler = (store: PluginStoreService, password?: string, invalidate: Effect.Effect<void> = Effect.void) => {
  // Serialize package mutations across async registry fetches and host invalidation.
  let pending = Promise.resolve()
  return (request: Request) => Effect.gen(function* () {
    const url = new URL(request.url)
    if (url.pathname !== "/api/ocx/plugins" && !url.pathname.startsWith("/api/ocx/plugins/")) return undefined
    if (!authenticated(request, password)) return Response.json({ error: "Authentication required" }, { status: 401 })
    const run = Effect.gen(function* () {
      const parts = url.pathname.slice("/api/ocx/plugins".length).split("/").filter(Boolean)
      if (!parts.length && request.method === "GET") return Response.json({ plugins: (yield* store.list).filter(p => p.package).map(packageView) })
      if (!parts.length && request.method === "POST") {
        const input = yield* attempt("Read install request", () => request.json() as Promise<InstallCloudPlugin>)
        if (!input || typeof input.package !== "string") return Response.json({ error: "package is required" }, { status: 400 })
        const plugin = yield* attempt("Install package", () => installPackage(input))
        if (yield* store.get(plugin.id)) return Response.json({ error: "Package already installed in this scope; remove it before installing another version" }, { status: 409 })
        yield* store.put(plugin)
        yield* invalidate
        return Response.json({ plugin: packageView(plugin) }, { status: 201 })
      }
      if (parts.length < 1 || parts.length > 2 || !/^pkg-[a-f0-9]{48}$/.test(parts[0]!)) return Response.json({ error: "Not found" }, { status: 404 })
      const plugin = yield* store.get(parts[0]!)
      if (!plugin?.package) return Response.json({ error: "Plugin not found" }, { status: 404 })
      if (parts.length === 1 && request.method === "DELETE") {
        yield* store.remove(plugin.id)
        yield* invalidate
        return Response.json({ ok: true, id: plugin.id })
      }
      if (parts.length === 2 && request.method === "POST" && ["enable", "disable"].includes(parts[1]!)) {
        const updated = { ...plugin, enabled: parts[1] === "enable", updatedAt: Date.now() }
        yield* store.put(updated)
        yield* invalidate
        return Response.json({ plugin: packageView(updated) })
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 })
    }).pipe(Effect.catchCause(cause => Effect.succeed(Response.json({ error: Cause.pretty(cause) }, { status: 422 }))))
    const response = pending.then(() => Effect.runPromise(run))
    pending = response.then(() => undefined, () => undefined)
    return yield* attempt("Manage packages", () => response)
  })
}
