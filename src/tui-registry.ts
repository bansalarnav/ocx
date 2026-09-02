import type { PluginStore, StoredPlugin } from "./plugin-manager/types"

export interface TuiPluginManifestEntry {
  id: string
  version: string
  sha256: string
  entrypoint: "tui.tsx"
  contentType: "application/typescript"
  opencode: {
    minimumVersion: string
  }
  permissions: {
    serverOrigins: ["self"]
    filesystem: false
    process: false
    network: false
  }
  notes: string
}

export interface TuiPluginManifest {
  schemaVersion: 1
  plugins: TuiPluginManifestEntry[]
}

const minimumOpenCodeVersion = "0.0.0-beta-18371"

const sha256 = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const entryFor = async (plugin: StoredPlugin): Promise<TuiPluginManifestEntry> => {
  const hash = await sha256(plugin.tuiBundle!)
  return {
    id: plugin.id,
    version: hash,
    sha256: hash,
    entrypoint: "tui.tsx",
    contentType: "application/typescript",
    opencode: { minimumVersion: minimumOpenCodeVersion },
    permissions: {
      serverOrigins: ["self"],
      filesystem: false,
      process: false,
      network: false,
    },
    notes: "Agent-authored TUI plugin",
  }
}

const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(
  JSON.stringify(body),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  },
)

const unauthorized = () => json(
  { error: "Authentication required" },
  401,
  { "www-authenticate": 'Basic realm="Secure Area"' },
)

const authenticated = (request: Request, password?: string): boolean => {
  if (!password) return true
  const match = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")
  if (!match) return false
  try {
    const bytes = Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)
    const separator = decoded.indexOf(":")
    return separator !== -1 &&
      decoded.slice(0, separator) === "opencode" &&
      decoded.slice(separator + 1) === password
  } catch {
    return false
  }
}

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

export const makeTuiRegistryHandler = (
  store: PluginStore,
  password?: string,
) => async (request: Request): Promise<Response | undefined> => {
  const parts = routeParts(new URL(request.url))
  if (parts === undefined) return undefined
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" })
  if (!authenticated(request, password)) return unauthorized()

  if (parts.length === 0) {
    const plugins = (await store.list())
      .filter((plugin) => plugin.enabled && plugin.tuiBundle !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id))
    const entries = await Promise.all(plugins.map(entryFor))
    return json(
      { schemaVersion: 1, plugins: entries } satisfies TuiPluginManifest,
      200,
      { "cache-control": "no-store" },
    )
  }

  if (parts.length !== 2) return json({ error: "Not found" }, 404)
  const [id, version] = parts
  if (!id || !version || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json({ error: "Not found" }, 404)
  const plugin = await store.get(id)
  if (!plugin?.enabled || plugin.tuiBundle === undefined) {
    return json({ error: "Plugin artifact not found" }, 404)
  }
  const hash = await sha256(plugin.tuiBundle)
  if (hash !== version) return json({ error: "Plugin artifact not found" }, 404)
  return new Response(plugin.tuiBundle, {
    headers: {
      "content-type": "application/typescript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"sha256-${hash}"`,
      "x-content-type-options": "nosniff",
    },
  })
}
