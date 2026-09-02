const serverPluginVirtualModule = `export const Plugin = { define(plugin) { return plugin } }`

export interface PluginBundles {
  serverBundle?: string
  tuiBundle?: string
  dependencies: Record<string, string>
  warnings: string[]
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i

const dependenciesFrom = (files: Record<string, string>): Record<string, string> => {
  const source = files["package.json"]
  if (source === undefined) return {}
  let manifest: unknown
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = manifest as { dependencies?: unknown }
  if (value.dependencies === undefined) return {}
  if (!value.dependencies || typeof value.dependencies !== "object" || Array.isArray(value.dependencies)) {
    throw new Error("package.json dependencies must be an object")
  }
  const entries = Object.entries(value.dependencies as Record<string, unknown>)
  if (entries.length > 32) throw new Error("A plugin may declare at most 32 direct dependencies")
  const dependencies: Record<string, string> = {}
  for (const [name, specifier] of entries) {
    if (!packageNamePattern.test(name)) throw new Error(`Invalid npm package name: ${name}`)
    if (typeof specifier !== "string" || specifier.length === 0 || specifier.length > 100) {
      throw new Error(`Invalid npm dependency specifier for ${name}`)
    }
    if (/^(?:https?|git|file|workspace|link|npm):/i.test(specifier)) {
      throw new Error(`Only npm registry versions, ranges, and tags are supported: ${name}`)
    }
    dependencies[name] = specifier
  }
  return dependencies
}

const moduleSource = (
  mainModule: string,
  modules: Record<string, string | { js?: string }>,
): string => {
  const output = modules[mainModule]
  if (typeof output === "string") return output
  if (output?.js !== undefined) return output.js
  throw new Error(`Worker bundler did not emit JavaScript for ${mainModule}`)
}

const checkBundleSize = (name: string, source: string) => {
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > 8 * 1024 * 1024) throw new Error(`${name} bundle exceeds 8 MiB`)
}

const bundleCache = new Map<string, Promise<PluginBundles>>()

const cacheKey = async (files: Record<string, string>) => {
  const serialized = JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const bundle = async (
  files: Record<string, string>,
): Promise<PluginBundles> => {
  const dependencies = dependenciesFrom(files)
  const syntheticFiles = {
    ...files,
    "package.json": JSON.stringify({ private: true, dependencies }),
  }
  const { createWorker } = await import("@cloudflare/worker-bundler")
  const warnings: string[] = []
  let serverBundle: string | undefined
  let tuiBundle: string | undefined
  const serverEntry = files["server.ts"] !== undefined ? "server.ts"
    : files["server.js"] !== undefined ? "server.js"
    : undefined

  if (serverEntry !== undefined) {
    const result = await createWorker({
      files: syntheticFiles,
      entryPoint: serverEntry,
      bundle: true,
      minify: false,
      sourcemap: false,
      target: "es2022",
      conditions: ["workerd", "worker", "browser", "import", "default"],
      virtualModules: { "@opencode-ai/plugin": serverPluginVirtualModule },
      define: { "process.env.NODE_ENV": '"production"' },
    })
    serverBundle = moduleSource(result.mainModule, result.modules)
    checkBundleSize(serverEntry, serverBundle)
    warnings.push(...(result.warnings ?? []).map((warning) => `${serverEntry}: ${warning}`))
  }

  if (files["tui.tsx"] !== undefined) {
    const result = await createWorker({
      files: syntheticFiles,
      entryPoint: "tui.tsx",
      bundle: true,
      minify: false,
      sourcemap: false,
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "@opentui/solid",
      conditions: ["browser", "import", "default"],
      externals: [
        "@opencode-ai/plugin/tui",
        "@opentui/core",
        "@opentui/solid",
        "@opentui/solid/*",
        "solid-js",
        "solid-js/*",
      ],
      define: { "process.env.NODE_ENV": '"production"' },
    })
    tuiBundle = moduleSource(result.mainModule, result.modules)
    checkBundleSize("tui.tsx", tuiBundle)
    warnings.push(...(result.warnings ?? []).map((warning) => `tui.tsx: ${warning}`))
  }

  return { serverBundle, tuiBundle, dependencies, warnings }
}

export const bundlePluginFiles = async (
  files: Record<string, string>,
): Promise<PluginBundles> => {
  const key = await cacheKey(files)
  const cached = bundleCache.get(key)
  if (cached !== undefined) return cached
  const pending = bundle(files)
  bundleCache.set(key, pending)
  if (bundleCache.size > 16) bundleCache.delete(bundleCache.keys().next().value!)
  try {
    return await pending
  } catch (error) {
    bundleCache.delete(key)
    throw error
  }
}
