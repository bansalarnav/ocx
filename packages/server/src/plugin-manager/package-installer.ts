import { InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler"
import { Effect } from "effect"
import { bundlePluginFiles } from "./bundler"
import { inspectPluginSource, validatePluginSetup } from "./quickjs"
import type { InstallCloudPlugin } from "@ocx/protocol/cloud-plugins"
import type { StoredPlugin } from "./types"

export const parsePackage = (input: string) => {
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^\s/:]+))?$/i.exec(input)
  if (!match || input.length > 214) throw new Error("Use an npm package name with an optional version, range, or tag")
  return { name: match[1]!, version: match[2] ?? "latest" }
}

// Match stable 2.3 Host.resolve: server subpath first, then root; TUI is a separate subpath.
const target = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [condition, entry] of Object.entries(value)) {
      if (["workerd", "worker", "browser", "import", "default"].includes(condition)) {
        const found = target(entry)
        if (found) return found
      }
    }
  }
}
export const installPackage = async (input: InstallCloudPlugin): Promise<StoredPlugin> => {
  if (input.scope !== "cloud" && input.scope !== "project") throw new Error("Invalid plugin scope")
  if (input.scope === "project" && (typeof input.projectID !== "string" || !input.projectID || input.projectID.length > 4096)) throw new Error("Project scope requires projectID")
  const { name, version } = parsePackage(input.package)
  const fs = new InMemoryFileSystem({ "package.json": JSON.stringify({ dependencies: { [name]: version } }) })
  // The host supplies Plugin.define; do not pull its Node host implementation and platform peers.
  for (const sdk of ["@opencode/plugin", "@opencode-ai/plugin"]) fs.write(`node_modules/${sdk}/package.json`, JSON.stringify({name:sdk,version:"2.3.0"}))
  // This installer fetches registry tarballs into a virtual filesystem. It never runs lifecycle scripts.
  const installed = await installDependencies(fs)
  if (installed.warnings.length) throw new Error(`Dependency installation failed: ${installed.warnings.join("; ")}`)
  const root = `node_modules/${name}/`
  const manifest = JSON.parse(fs.read(`${root}package.json`) ?? "null")
  if (!manifest || manifest.name !== name || typeof manifest.version !== "string") throw new Error("Registry did not return the requested package")
  const entry = (subpath: "server" | "tui") => {
    const exports = manifest.exports
    let path: string | undefined
    if (exports !== undefined) {
      path = target(exports?.[`./${subpath}`])
      if (!path && subpath === "server") path = target(exports?.["."] ?? (typeof exports === "string" || !Object.keys(exports ?? {}).some(key => key.startsWith(".")) ? exports : undefined))
    } else {
      path = [subpath + ".ts", subpath + ".js", subpath + ".tsx", ...(subpath === "server" ? [manifest.module, manifest.main, "index.js", "index.ts"] : [])].find(path => typeof path === "string" && fs.read(root + path.replace(/^\.\//, "")) !== null)
    }
    if (!path) return undefined
    path = path.replace(/^\.\//, "")
    if (path.split("/").includes("..") || path.startsWith("/")) throw new Error("Invalid package export path")
    if (fs.read(root + path) === null) throw new Error(`Missing ${subpath} export: ${path}`)
    return root + path
  }
  const server = entry("server"), tui = entry("tui")
  if (!server && !tui) throw new Error("Package has no supported server or TUI entrypoint")
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([name, input.scope, input.scope === "project" ? input.projectID : null])))
  const id = "pkg-" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("").slice(0, 48)
  const files: Record<string, string> = {}
  let bytes = 0
  if (fs.list().length > 10000) throw new Error("Package dependency tree exceeds 10000 files")
  for (const path of fs.list()) {
    const content = fs.read(path)
    if (content !== null) {
      bytes += new TextEncoder().encode(content).byteLength
      if (bytes > 32 * 1024 * 1024) throw new Error("Package dependency tree exceeds 32 MiB")
      files[path] = content
    }
  }
  // Dependencies are already materialized. Bundling and restart never need the registry again.
  files["package.json"] = JSON.stringify({ private: true })
  if (server) files["server.js"] = `export { default } from "./${server}"`
  if (tui) files["tui.tsx"] = `import plugin from "./${tui}"; export default { ...plugin, id: ${JSON.stringify(id)} }`
  const bundles = await Effect.runPromise(bundlePluginFiles(files))
  let runtimeID: string | undefined
  if (bundles.serverBundle) {
    runtimeID = (await Effect.runPromise(inspectPluginSource(bundles.serverBundle))).id
    await Effect.runPromise(validatePluginSetup(bundles.serverBundle))
  }
  return {
    id, runtimeID, files: { "package.json": JSON.stringify(manifest) },
    serverBundle: bundles.serverBundle, tuiBundle: bundles.tuiBundle,
    dependencies: { [name]: manifest.version }, bundleWarnings: [...installed.warnings, ...bundles.warnings],
    enabled: true, updatedAt: Date.now(),
    package: { name, version: manifest.version, requested: input.package, scope: input.scope, projectID: input.scope === "project" ? input.projectID : undefined, runtime: "quickjs-promise" },
  }
}
