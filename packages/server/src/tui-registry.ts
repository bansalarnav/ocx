import { authenticated } from "./auth"
export { authenticated } from "./auth"
import type { StoredPlugin } from "./plugin-manager/types"
import type { PluginStoreService } from "./plugin-manager/store"
import { Effect } from "effect"
import { attempt } from "@ocx/protocol/errors"

import type { TuiPluginManifest, TuiPluginManifestEntry } from "@ocx/protocol/plugins"
export type { TuiPluginManifest, TuiPluginManifestEntry } from "@ocx/protocol/plugins"

export interface TuiRegistryEvents {
  publish(): void
  response(request: Request): Response
}

export const makeTuiRegistryEvents = (onPublish?: () => void): TuiRegistryEvents => {
  const encoder = new TextEncoder()
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let generation = 0

  return {
    publish() {
      onPublish?.()
      generation++
      const message = encoder.encode(`event: changed\ndata: ${generation}\n\n`)
      for (const client of clients) {
        try {
          client.enqueue(message)
        } catch {
          clients.delete(client)
        }
      }
    },
    response(request) {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      let keepalive: ReturnType<typeof setInterval> | undefined
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        if (keepalive !== undefined) clearInterval(keepalive)
        if (controller !== undefined) {
          clients.delete(controller)
          try {
            controller.close()
          } catch {}
        }
        request.signal.removeEventListener("abort", close)
      }
      const stream = new ReadableStream<Uint8Array>({
        start(next) {
          controller = next
          clients.add(next)
          next.enqueue(encoder.encode(`event: ready\ndata: ${generation}\n\n`))
          keepalive = setInterval(() => {
            try {
              next.enqueue(encoder.encode(": keepalive\n\n"))
            } catch {
              close()
            }
          }, 20_000)
          request.signal.addEventListener("abort", close, { once: true })
          if (request.signal.aborted) close()
        },
        cancel: close,
      })
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      })
    },
  }
}

const minimumOpenCodeVersion = "2.3.0"

const sha256 = (content: string) =>
  attempt("Hash plugin", () =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  )
const entryFor = (plugin: StoredPlugin) =>
  sha256(plugin.tuiBundle!).pipe(
    Effect.map((hash): TuiPluginManifestEntry => ({
      id: plugin.id,
      version: hash,
      sha256: hash,
      entrypoint: "tui.tsx",
      contentType: "application/typescript",
      opencode: { minimumVersion: minimumOpenCodeVersion },
      permissions: { serverOrigins: ["self"], filesystem: false, process: false, network: false },
      notes: plugin.package ? `npm ${plugin.package.name}@${plugin.package.version}` : "Agent-authored TUI plugin",
    })),
  )

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  })

const unauthorized = () =>
  json({ error: "Authentication required" }, 401, {
    "www-authenticate": 'Basic realm="Secure Area"',
  })

const routeParts = (url: URL): string[] | undefined => {
  if (!url.pathname.startsWith("/api/generated-plugins/tui")) return undefined
  const suffix = url.pathname.slice("/api/generated-plugins/tui".length)
  if (suffix === "" || suffix === "/") return []
  if (!suffix.startsWith("/")) return undefined
  try {
    return suffix.slice(1).split("/").map(decodeURIComponent)
  } catch {
    return [""]
  }
}

export const makeTuiRegistryHandler =
  (store: PluginStoreService, password?: string, events = makeTuiRegistryEvents()) =>
  (request: Request) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      const projectID = url.searchParams.get("projectID") ?? request.headers.get("x-ocx-project-id")
      const visible = (plugin: StoredPlugin) => plugin.package?.scope !== "project" || plugin.package.projectID === projectID
      const parts = routeParts(url)
      if (parts === undefined) return undefined
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405, { allow: "GET" })
      if (!authenticated(request, password)) return unauthorized()

      if (parts.length === 1 && parts[0] === "events") return events.response(request)

      if (parts.length === 0) {
        const plugins = (yield* store.list)
          .filter((plugin) => visible(plugin) && plugin.enabled && plugin.tuiBundle !== undefined)
          .sort((left, right) => left.id.localeCompare(right.id))
        const entries = yield* Effect.forEach(plugins, entryFor, { concurrency: 4 })
        return json({ schemaVersion: 1, plugins: entries } satisfies TuiPluginManifest, 200, {
          "cache-control": "no-store",
        })
      }

      if (parts.length !== 2) return json({ error: "Not found" }, 404)
      const [id, version] = parts
      if (!id || !version || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
        return json({ error: "Not found" }, 404)
      const plugin = yield* store.get(id)
      if (!plugin?.enabled || !visible(plugin) || plugin.tuiBundle === undefined) {
        return json({ error: "Plugin artifact not found" }, 404)
      }
      const hash = yield* sha256(plugin.tuiBundle)
      if (hash !== version) return json({ error: "Plugin artifact not found" }, 404)
      return new Response(plugin.tuiBundle, {
        headers: {
          "content-type": "application/typescript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"sha256-${hash}"`,
          "x-content-type-options": "nosniff",
        },
      })
    })
