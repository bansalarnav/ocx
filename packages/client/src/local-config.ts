import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"

export interface LocalTuiConfig {
  configDir: string
  tuiConfig: string
  cliContent?: string
  stop(): Promise<void>
}

/** The backend retains the original config. Only the attached TUI gets this copy. */
export async function createLocalTuiConfig(dataRoot: string, env = process.env): Promise<LocalTuiConfig> {
  const globalDirectory = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
  const directories = [...new Set([globalDirectory, ...(env.OPENCODE_CONFIG_DIR ? [resolve(env.OPENCODE_CONFIG_DIR)] : [])])]
  const candidates = env.OPENCODE_TUI_CONFIG ? [resolve(env.OPENCODE_TUI_CONFIG)] :
    [...directories].reverse().flatMap(directory => [join(directory, "cli.json"), join(directory, "tui.jsonc"), join(directory, "tui.json")])
  let settings: Record<string, unknown> = { $schema: "https://opencode.ai/v2/cli.json" }
  let settingsDirectory = directories.at(-1)!
  for (const path of candidates) {
    let text: string
    try { text = await readFile(path, "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    const errors: ParseError[] = []
    const value = parse(text, errors, { allowTrailingComma: true })
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid TUI config ${path}: ${errors[0] ? printParseErrorCode(errors[0].error) : "expected an object"}`)
    settings = value
    settingsDirectory = dirname(path)
    break
  }
  if (env.OPENCODE_CLI_CONFIG_CONTENT) {
    const errors: ParseError[] = []
    const overlay = parse(env.OPENCODE_CLI_CONFIG_CONTENT, errors, { allowTrailingComma: true })
    if (errors.length || !overlay || typeof overlay !== "object" || Array.isArray(overlay)) throw new Error("Invalid OPENCODE_CLI_CONFIG_CONTENT")
    const merge = (base: Record<string, unknown>, additions: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(additions)])].map(key => {
        const next = additions[key]
        return [key, next && typeof next === "object" && !Array.isArray(next) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key]) ?
          merge(base[key] as Record<string, unknown>, next as Record<string, unknown>) : key in additions ? next : base[key]]
      }),
    )
    settings = merge(settings, overlay)
  }
  if (Array.isArray(settings.plugins)) settings.plugins = settings.plugins.map(entry => {
    const absolute = (value: string) => value.startsWith("./") || value.startsWith("../") ? resolve(settingsDirectory, value) : value
    return typeof entry === "string" ? absolute(entry) : entry && typeof entry === "object" && typeof entry.package === "string" ?
      { ...entry, package: absolute(entry.package) } : entry
  })
  const root = join(resolve(dataRoot), "clients")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const configDir = await mkdtemp(join(root, "local-"))
  const stop = () => rm(configDir, { recursive: true, force: true })
  try {
    // Asset directories keep their original identity. The plugin directory
    // itself stays private so adding our builtin cannot edit the user's config.
    for (const directory of directories) {
      let entries: string[]
      try { entries = await readdir(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      for (const entry of entries) {
        if (["opencode.json", "opencode.jsonc", "cli.json", "tui.json", "tui.jsonc", "package.json", "plugins"].includes(entry)) continue
        const destination = join(configDir, entry)
        await rm(destination, { force: true })
        const source = join(directory, entry)
        await symlink(source, destination, process.platform === "win32" && (await stat(source)).isDirectory() ? "junction" : undefined)
      }
      let plugins: string[]
      try { plugins = await readdir(join(directory, "plugins")) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      await mkdir(join(configDir, "plugins"), { recursive: true, mode: 0o700 })
      for (const name of plugins) {
        if (name === "ocx-workspaces") continue
        const destination = join(configDir, "plugins", name)
        await rm(destination, { force: true })
        const source = join(directory, "plugins", name)
        await symlink(source, destination, process.platform === "win32" && (await stat(source)).isDirectory() ? "junction" : undefined)
      }
    }
    const plugin = join(configDir, "plugins", "ocx-workspaces")
    await mkdir(plugin, { recursive: true, mode: 0o700 })
    await writeFile(join(plugin, "index.ts"), "export {}\n", { mode: 0o600 })
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "ocx-workspaces", type: "module", exports: { ".": "./index.ts", "./tui": "./tui.ts" } }) + "\n", { mode: 0o600 })
    await writeFile(join(plugin, "tui.ts"), `export { default } from ${JSON.stringify(fileURLToPath(new URL("./workspace-tui.ts", import.meta.url)))}\n`, { mode: 0o600 })
    settings = { ...settings, plugins: [...(Array.isArray(settings.plugins) ? settings.plugins : []), plugin] }
    const tuiConfig = join(configDir, "cli.json")
    await writeFile(tuiConfig, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
    // Plugin dependencies resolve from its source in this checkout, never by
    // changing the user's global OpenCode installation or config files.
    await writeFile(join(configDir, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n", { mode: 0o600 })
    return { configDir, tuiConfig, cliContent: JSON.stringify(settings), stop }
  } catch (error) { await stop(); throw error }
}
