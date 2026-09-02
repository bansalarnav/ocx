#!/usr/bin/env bun

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser"
import type { TuiPluginManifest, TuiPluginManifestEntry } from "../src/tui-registry"

interface Approval {
  version: string
  sha256: string
  permissions: TuiPluginManifestEntry["permissions"]
}

interface ApprovalFile {
  schemaVersion: 1
  plugins: Record<string, Approval>
}

interface Options {
  origin: string
  binary: string
  dataRoot: string
  yes: boolean
  childArgs: string[]
}

const usage = `Usage: ocx [options] <server-url> [-- opencode2 arguments]

Options:
  --server <url>       OpenCode server URL (alternative to the positional URL)
  --binary <path>      CLI to launch (default: opencode2)
  --data-dir <path>    Cache root (default: $XDG_DATA_HOME/ocx or ~/.local/share/ocx)
  --yes                Approve new or changed plugin bytes without prompting
  -h, --help           Show this help

Authentication uses OPENCODE_PASSWORD, matching the launched OpenCode client.`

const fail = (message: string): never => {
  throw new Error(message)
}

const normalizeOrigin = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(`Invalid server URL: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("Server URL must use http or https")
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return fail("Server URL must be an origin without credentials, path, query, or fragment")
  }
  return url.origin
}

export const parseArguments = (args: string[], env = process.env): Options => {
  let server: string | undefined
  let binary = env.OCX_OPENCODE_BINARY || "opencode2"
  let dataRoot = env.OCX_DATA_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "ocx")
  let yes = false
  const childArgs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      childArgs.push(...args.slice(index + 1))
      break
    }
    if (arg === "-h" || arg === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--server" || arg === "--binary" || arg === "--data-dir") {
      const value = args[++index]
      if (!value) fail(`${arg} requires a value`)
      if (arg === "--server") server = value
      else if (arg === "--binary") binary = value
      else dataRoot = resolve(value)
      continue
    }
    if (arg.startsWith("-")) fail(`Unknown ocx option: ${arg}. Put OpenCode options after --.`)
    if (server !== undefined) fail(`Unexpected argument: ${arg}. Put OpenCode arguments after --.`)
    server = arg
  }

  if (!server) throw new Error("Missing server URL\n\n" + usage)
  return { origin: normalizeOrigin(server), binary, dataRoot, yes, childArgs }
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

const validateManifest = (value: unknown): TuiPluginManifest => {
  if (!value || typeof value !== "object") fail("Server returned an invalid TUI plugin manifest")
  const manifest = value as Partial<TuiPluginManifest>
  const plugins = manifest.plugins
  if (manifest.schemaVersion !== 1 || !Array.isArray(plugins)) {
    throw new Error("Server returned an unsupported TUI plugin manifest")
  }
  const ids = new Set<string>()
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object" ||
      typeof plugin.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(plugin.id) ||
      typeof plugin.version !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(plugin.version) ||
      typeof plugin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(plugin.sha256) ||
      plugin.entrypoint !== "tui.tsx" || plugin.contentType !== "application/typescript" ||
      !plugin.permissions || typeof plugin.permissions !== "object") {
      fail("Server returned an invalid TUI plugin entry")
    }
    if (ids.has(plugin.id)) fail(`Server manifest contains duplicate plugin id: ${plugin.id}`)
    ids.add(plugin.id)
  }
  return manifest as TuiPluginManifest
}

const authHeaders = (password?: string): HeadersInit => password
  ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  : {}

const fetchChecked = async (url: string, password?: string): Promise<Response> => {
  const response = await fetch(url, { headers: authHeaders(password), redirect: "error" })
  if (response.status === 401) fail("The server rejected OPENCODE_PASSWORD")
  if (!response.ok) fail(`Request failed with HTTP ${response.status}: ${url}`)
  return response
}

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw error
  }
}

const atomicWrite = async (path: string, content: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

const approve = async (
  origin: string,
  plugin: TuiPluginManifestEntry,
  changed: boolean,
  yes: boolean,
): Promise<void> => {
  const action = changed ? "update" : "install"
  console.error(`\n${plugin.id} from ${origin} wants to ${action} local TUI code.`)
  console.error(`SHA-256: ${plugin.sha256}`)
  console.error("This code runs with your user account's full operating-system permissions.")
  if (yes) return
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail("Approval requires an interactive terminal. Re-run with --yes only if you trust these exact manifest bytes.")
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(`Approve ${action}? [y/N] `)
    if (!/^y(?:es)?$/i.test(answer.trim())) fail(`Declined ${plugin.id}`)
  } finally {
    prompt.close()
  }
}

const userTuiConfigPath = async (env = process.env): Promise<string | undefined> => {
  if (env.OPENCODE_TUI_CONFIG) return resolve(env.OPENCODE_TUI_CONFIG)
  const configDir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  for (const name of ["tui.jsonc", "tui.json"]) {
    const path = join(configDir, name)
    try {
      await access(path, constants.R_OK)
      return path
    } catch {
      // Try the next standard name.
    }
  }
  return undefined
}

const readTuiConfig = async (env = process.env): Promise<Record<string, unknown>> => {
  const path = await userTuiConfigPath(env)
  if (!path) return { $schema: "https://opencode.ai/tui.json" }
  const errors: ParseError[] = []
  const value = parseJsonc(await readFile(path, "utf8"), errors, { allowTrailingComma: true })
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    const detail = errors[0] ? printParseErrorCode(errors[0].error) : "expected an object"
    fail(`Could not parse ${path}: ${detail}`)
  }
  return value as Record<string, unknown>
}

const mergedTuiConfig = (
  userConfig: Record<string, unknown>,
  pluginPaths: string[],
): Record<string, unknown> => {
  const configured = Array.isArray(userConfig.plugin) ? userConfig.plugin : []
  const managed = new Set(pluginPaths)
  const retained = configured.filter((entry) => {
    const spec = Array.isArray(entry) ? entry[0] : entry
    return typeof spec !== "string" || !managed.has(spec)
  })
  return {
    ...userConfig,
    $schema: typeof userConfig.$schema === "string" ? userConfig.$schema : "https://opencode.ai/tui.json",
    plugin: [...retained, ...pluginPaths],
  }
}

export const syncPlugins = async (options: Options, env = process.env): Promise<{
  configDir: string
  tuiConfig: string
  installed: string[]
}> => {
  const serverID = sha256(options.origin).slice(0, 32)
  const serverDir = join(options.dataRoot, "servers", serverID)
  const approvalPath = join(serverDir, "approvals.json")
  const trustPath = join(serverDir, "trust.json")
  const approvals = await readJson<ApprovalFile>(approvalPath, { schemaVersion: 1, plugins: {} })
  if (approvals.schemaVersion !== 1 || !approvals.plugins || typeof approvals.plugins !== "object") {
    fail(`Invalid approval file: ${approvalPath}`)
  }
  const trust = await readJson<{ schemaVersion: 1; origin: string } | undefined>(trustPath, undefined)
  if (trust && (trust.schemaVersion !== 1 || trust.origin !== options.origin)) {
    fail(`Server identity mismatch in ${trustPath}`)
  }

  const manifestURL = `${options.origin}/api/generated-plugins/tui`
  const manifest = validateManifest(await (await fetchChecked(manifestURL, env.OPENCODE_PASSWORD)).json())
  const installed: string[] = []

  for (const plugin of manifest.plugins) {
    const artifactPath = join(serverDir, "plugins", plugin.id, plugin.sha256, plugin.entrypoint)
    const previous = approvals.plugins[plugin.id]
    const alreadyApproved = previous?.sha256 === plugin.sha256
    if (!alreadyApproved) await approve(options.origin, plugin, previous !== undefined, options.yes)

    let artifact: Uint8Array
    try {
      artifact = new Uint8Array(await readFile(artifactPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const encodedID = encodeURIComponent(plugin.id)
      const encodedVersion = encodeURIComponent(plugin.version)
      artifact = new Uint8Array(await (await fetchChecked(
        `${manifestURL}/${encodedID}/${encodedVersion}`,
        env.OPENCODE_PASSWORD,
      )).arrayBuffer())
    }
    const actualHash = sha256(artifact)
    if (actualHash !== plugin.sha256) {
      fail(`Hash mismatch for ${plugin.id}: expected ${plugin.sha256}, received ${actualHash}`)
    }
    await atomicWrite(artifactPath, artifact)
    approvals.plugins[plugin.id] = {
      version: plugin.version,
      sha256: plugin.sha256,
      permissions: plugin.permissions,
    }
    installed.push(resolve(artifactPath))
  }

  await atomicWrite(trustPath, JSON.stringify({ schemaVersion: 1, origin: options.origin }, null, 2) + "\n")
  await atomicWrite(approvalPath, JSON.stringify(approvals, null, 2) + "\n")
  const configDir = join(serverDir, "generated-config")
  const tuiConfig = join(configDir, "tui.json")
  await atomicWrite(tuiConfig, JSON.stringify(mergedTuiConfig(await readTuiConfig(env), installed), null, 2) + "\n")
  return { configDir, tuiConfig, installed }
}

const launch = async (options: Options, env = process.env): Promise<number> => {
  const synced = await syncPlugins(options, env)
  const child = spawn(options.binary, ["--server", options.origin, ...options.childArgs], {
    stdio: "inherit",
    env: {
      ...env,
      OPENCODE_CONFIG_DIR: synced.configDir,
      OPENCODE_TUI_CONFIG: synced.tuiConfig,
    },
  })
  return await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${options.binary} exited after signal ${signal}`))
      else resolveExit(code ?? 1)
    })
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = await launch(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(`ocx: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
