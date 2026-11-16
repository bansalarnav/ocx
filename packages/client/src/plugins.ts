import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { symlink } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser"
import { attempt, evaluate, OperationError } from "@ocx/protocol/errors"
import {
  PluginManifestSchema,
  type TuiPluginManifest,
  type TuiPluginManifestEntry,
} from "@ocx/protocol/plugins"
import { Transport } from "./transport"
import { Files } from "./files"
import type { Options } from "./options"
import { ocxLoaderSource } from "./approval-plugin"

interface Approval {
  version: string
  sha256: string
  permissions: TuiPluginManifestEntry["permissions"]
}
interface ApprovalFile {
  schemaVersion: 1
  plugins: Record<string, Approval>
}
interface ActivePlugin {
  id: string
  sha256: string
  path: string
}
export interface ClientFiles {
  configDir: string
  tuiConfig: string
  controlDir: string
  cliContent?: string
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const approvalDirectory = "ocx-plugin-approvals"
const workspaceDirectory = "ocx-workspaces"
const problem = (message: string) =>
  new OperationError({ operation: "Plugin sync", cause: new Error(message) })

type SyncError =
  | OperationError
  | import("effect/PlatformError").PlatformError
  | import("@ocx/protocol/transport").TransportError
export class Plugins extends Context.Service<
  Plugins,
  {
    readonly prepare: Effect.Effect<ClientFiles, SyncError, import("effect/Scope").Scope>
    readonly refresh: (files: ClientFiles) => Effect.Effect<void, SyncError>
    readonly watch: (files: ClientFiles) => Effect.Effect<void, SyncError>
  }
>()("ocx/Plugins") {}

export const pluginsLayer = (options: Options, env = process.env, behavior: { deferInitialApprovals?: boolean } = {}) =>
  Layer.effect(
    Plugins,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const files = yield* Files
      const transport = yield* Transport
      const serverDir = join(options.dataRoot, "servers", hash(options.origin).slice(0, 32))
      const approvalPath = join(serverDir, "approvals.json")
      const manifestPath = "/api/generated-plugins/tui"
      const artifactPath = (id: string, sha256: string) =>
        join(serverDir, "plugins", id, sha256, "tui.tsx")
      const fetch = Effect.fn("Plugins.fetch")(function* (path: string) {
        const response = yield* transport.fetch(new Request(new URL(path, options.origin)))
        if (!response.ok) {
          yield* attempt("Discard error body", () => response.body?.cancel() ?? Promise.resolve())
          return yield* Effect.fail(problem(`HTTP ${response.status} fetching ${path}`))
        }
        return response
      })
      const manifest = Effect.gen(function* () {
        const response = yield* fetch(manifestPath)
        const json = yield* attempt("Read plugin manifest", () => response.json())
        const value = yield* Schema.decodeUnknownEffect(PluginManifestSchema)(json).pipe(
          Effect.mapError((cause) => problem(String(cause))),
        )
        const ids = new Set(value.plugins.map((plugin) => plugin.id))
        if (ids.size !== value.plugins.length || ids.has(approvalDirectory) || ids.has(workspaceDirectory))
          return yield* Effect.fail(problem("Duplicate or reserved plugin id"))
        return value
      })
      const approvals = files
        .json<ApprovalFile>(approvalPath, { schemaVersion: 1, plugins: {} })
        .pipe(
          Effect.flatMap((value) =>
            value.schemaVersion === 1 &&
            value.plugins &&
            typeof value.plugins === "object" &&
            !Array.isArray(value.plugins)
              ? Effect.succeed(value)
              : Effect.fail(problem(`Invalid approval file: ${approvalPath}`)),
          ),
        )

      const install = Effect.fn("Plugins.install")(function* (
        manifest: TuiPluginManifest,
        approved: ApprovalFile,
        allow: (
          plugin: TuiPluginManifestEntry,
          changed: boolean,
        ) => Effect.Effect<boolean, SyncError>,
      ) {
        const active: ActivePlugin[] = []
        for (const plugin of manifest.plugins) {
          const previous = approved.plugins[plugin.id]
          if (
            previous?.sha256 !== plugin.sha256 &&
            !(yield* allow(plugin, previous !== undefined))
          ) {
            if (previous && /^[a-f0-9]{64}$/.test(previous.sha256)) {
              const path = artifactPath(plugin.id, previous.sha256)
              if (yield* fs.exists(path)) {
                const bytes = yield* fs.readFile(path)
                if (hash(bytes) === previous.sha256)
                  active.push({ id: plugin.id, sha256: previous.sha256, path })
              }
            }
            continue
          }
          const path = artifactPath(plugin.id, plugin.sha256)
          const bytes = (yield* fs.exists(path))
            ? yield* fs.readFile(path)
            : yield* fetch(
                `${manifestPath}/${encodeURIComponent(plugin.id)}/${encodeURIComponent(plugin.version)}`,
              ).pipe(
                Effect.flatMap((response) =>
                  attempt("Download plugin", () => response.arrayBuffer()),
                ),
                Effect.map((buffer) => new Uint8Array(buffer)),
              )
          if (hash(bytes) !== plugin.sha256)
            return yield* Effect.fail(problem(`Hash mismatch for ${plugin.id}`))
          yield* files.write(path, bytes)
          approved.plugins[plugin.id] = {
            version: plugin.version,
            sha256: plugin.sha256,
            permissions: plugin.permissions,
          }
          active.push({ id: plugin.id, sha256: plugin.sha256, path })
        }
        return active
      })
      const materialize = Effect.fn("Plugins.materialize")(function* (
        client: ClientFiles,
        active: ActivePlugin[],
      ) {
        const root = join(client.configDir, "plugins")
        yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
        const ids = new Set(active.map((plugin) => plugin.id))
        for (const name of yield* fs.readDirectory(root)) {
          if (name !== approvalDirectory && name !== workspaceDirectory && !ids.has(name))
            yield* fs.remove(join(root, name), { recursive: true, force: true })
        }
        const native: ActivePlugin[] = []
        for (const plugin of active) {
          const directory = join(root, plugin.id)
          const path = join(directory, "tui.tsx")
          yield* files.write(join(directory, "package.json"), JSON.stringify({ name: plugin.id, private: true, type: "module", exports: { ".": "./index.ts", "./tui": "./tui.tsx" } }) + "\n")
          if (!(yield* fs.exists(join(directory, "index.ts"))))
            yield* files.write(join(directory, "index.ts"), "export {}\n")
          const unchanged =
            (yield* fs.exists(path)) && hash(yield* fs.readFile(path)) === plugin.sha256
          if (!unchanged) yield* files.write(path, yield* fs.readFile(plugin.path))
          native.push({ ...plugin, path: resolve(path) })
        }
        yield* files.write(
          join(client.controlDir, "active.json"),
          JSON.stringify({ generation: crypto.randomUUID(), plugins: native }) + "\n",
        )
      })
      const approve = Effect.fn("Plugins.approve")(function* (
        plugin: TuiPluginManifestEntry,
        changed: boolean,
      ) {
        const action = changed ? "update" : "install"
        yield* Effect.sync(() => {
          console.error(
            `\n${plugin.id} from ${options.origin} wants to ${action} local TUI code.\nSHA-256: ${plugin.sha256}\nThis code runs with your user account's full operating-system permissions.`,
          )
        })
        if (options.yes) return true
        if (!process.stdin.isTTY || !process.stderr.isTTY)
          return yield* Effect.fail(
            problem("Approval requires a terminal. Use --yes only if you trust this code."),
          )
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const prompt = yield* Effect.acquireRelease(
              Effect.sync(() => createInterface({ input: process.stdin, output: process.stderr })),
              (prompt) => Effect.sync(() => prompt.close()),
            )
            const answer = yield* attempt("Read approval", (signal) =>
              prompt.question(`Approve ${action}? [y/N] `, { signal }),
            )
            if (!/^y(?:es)?$/i.test(answer.trim()))
              return yield* Effect.fail(problem(`Declined ${plugin.id}`))
            return true
          }),
        )
      })
      const readTuiConfig = Effect.gen(function* () {
        const global = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
        const directories = [...new Set([...(env.OPENCODE_CONFIG_DIR ? [resolve(env.OPENCODE_CONFIG_DIR)] : []), global])]
        const candidates = env.OPENCODE_TUI_CONFIG
          ? [resolve(env.OPENCODE_TUI_CONFIG)]
          : directories.flatMap(directory => [join(directory, "cli.json"), join(directory, "tui.jsonc"), join(directory, "tui.json")])
        for (const path of candidates) {
          if (!(yield* fs.exists(path))) continue
          const content = yield* fs.readFileString(path)
          return yield* evaluate(`Read ${path}`, () => {
            const errors: ParseError[] = []
            const value = parseJsonc(content, errors, { allowTrailingComma: true })
            if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
              throw new Error(
                errors[0] ? printParseErrorCode(errors[0].error) : "Expected an object",
              )
            const settings = value as Record<string, unknown>
            const localEntry = (entry: string) => entry.startsWith("./") || entry.startsWith("../") ? resolve(path, "..", entry) : entry
            return {
              ...settings,
              ...(Array.isArray(settings.plugins) ? { plugins: settings.plugins.map(entry => typeof entry === "string" ? localEntry(entry) :
                entry && typeof entry === "object" && typeof entry.package === "string" ? { ...entry, package: localEntry(entry.package) } : entry) } : {}),
            } as Record<string, unknown>
          })
        }
        return { $schema: "https://opencode.ai/v2/cli.json" } as Record<string, unknown>
      })
      const prepare = Effect.gen(function* () {
        const trustPath = join(serverDir, "trust.json")
        const trust = yield* files.json<{ schemaVersion: number; origin: string } | undefined>(
          trustPath,
          undefined,
        )
        if (trust && (trust.schemaVersion !== 1 || trust.origin !== options.origin))
          return yield* Effect.fail(problem("Server identity mismatch"))
        const approved = yield* approvals
        const active = yield* install(yield* manifest, approved,
          behavior.deferInitialApprovals && !options.yes ? () => Effect.succeed(false) : approve)
        const controlDir = join(serverDir, "clients", crypto.randomUUID())
        // Each process owns its generated config, so approvals and hot reloads cannot cross clients.
        const configDir = join(controlDir, "config")
        const client: ClientFiles = { controlDir, configDir, tuiConfig: join(configDir, "cli.json") }
        yield* Effect.addFinalizer(() =>
          fs.remove(controlDir, { recursive: true, force: true }).pipe(Effect.orDie),
        )
        yield* files.write(
          trustPath,
          JSON.stringify({ schemaVersion: 1, origin: options.origin }) + "\n",
        )
        yield* files.write(approvalPath, JSON.stringify(approved, null, 2) + "\n")
        yield* files.write(
          join(configDir, "package.json"),
          JSON.stringify({
            private: true,
            dependencies: {
              "@opencode/plugin": "2.3.0",
              "@opencode-ai/plugin": "npm:@opencode/plugin@2.3.0",
              "@opentui/core": "0.8.4",
              "@opentui/solid": "0.8.4",
              "solid-js": "1.9.17",
            },
          }) + "\n",
        )
        yield* files.write(join(configDir, "plugins", approvalDirectory, "index.ts"), "export {}\n")
        for (const id of [approvalDirectory, workspaceDirectory])
          yield* files.write(join(configDir, "plugins", id, "package.json"), JSON.stringify({ name: id, private: true, type: "module", exports: { ".": "./index.ts", "./tui": "./tui.ts" } }) + "\n")
        yield* files.write(join(configDir, "plugins", approvalDirectory, "tui.ts"), ocxLoaderSource)
        yield* files.write(join(configDir, "plugins", workspaceDirectory, "index.ts"), "export {}\n")
        yield* files.write(join(configDir, "plugins", workspaceDirectory, "tui.ts"), `export { default } from ${JSON.stringify(fileURLToPath(new URL("./workspace-tui.ts", import.meta.url)))}\n`)
        const originalDirectories = [...new Set([...(env.OPENCODE_CONFIG_DIR ? [resolve(env.OPENCODE_CONFIG_DIR)] : []), join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")])]
        for (const asset of ["themes", "sounds"]) {
          for (const original of originalDirectories) {
            const source = join(original, asset)
            if (!(yield* fs.exists(source))) continue
            yield* attempt("Preserve TUI assets", () => symlink(source, join(configDir, asset), process.platform === "win32" ? "junction" : undefined))
            break
          }
        }
        const settings = yield* readTuiConfig
        // Stable OpenCode merges this inline config on every reload, so its
        // plugin list is immutable for the lifetime of the child process.
        // Only builtins belong here. Native directory discovery watches the
        // generated plugin directories and adds/removes them after approval.
        const entrypoints = [approvalDirectory, workspaceDirectory]
          .map(id => join(configDir, "plugins", id))
        client.cliContent = JSON.stringify({ ...settings, plugins: [...(Array.isArray(settings.plugins) ? settings.plugins : []), ...entrypoints] })
        yield* files.write(client.tuiConfig, client.cliContent + "\n")
        yield* materialize(client, active)
        return client
      })
      const refresh = Effect.fn("Plugins.refresh")(function* (client: ClientFiles) {
        const approved = yield* approvals
        const current = yield* manifest
        const changes = current.plugins.filter(
          (plugin) => approved.plugins[plugin.id]?.sha256 !== plugin.sha256,
        )
        let allowed = new Set(changes.map((plugin) => plugin.sha256))
        if (!options.yes && changes.length) {
          const nonce = crypto.randomUUID()
          yield* files.write(
            join(client.controlDir, "pending.json"),
            JSON.stringify({
              nonce,
              origin: options.origin,
              plugins: changes.map((plugin) => ({
                id: plugin.id,
                sha256: plugin.sha256,
                changed: approved.plugins[plugin.id] !== undefined,
              })),
            }) + "\n",
          )
          while (true) {
            const decision = yield* files.json<{ nonce?: string; approved?: string[] } | undefined>(
              join(client.controlDir, "decision.json"),
              undefined,
            )
            if (decision?.nonce === nonce && Array.isArray(decision.approved)) {
              allowed = new Set(decision.approved)
              break
            }
            yield* Effect.sleep("200 millis")
          }
        }
        const active = yield* install(current, approved, (plugin) =>
          Effect.succeed(allowed.has(plugin.sha256)),
        )
        yield* files.write(approvalPath, JSON.stringify(approved, null, 2) + "\n")
        yield* materialize(client, active)
      })
      const watch = (client: ClientFiles) =>
        Effect.scoped(
          Effect.gen(function* () {
            const response = yield* fetch(`${manifestPath}/events`)
            if (!response.body) return yield* Effect.fail(problem("Missing registry event body"))
            const reader = yield* Effect.acquireRelease(
              Effect.sync(() => response.body!.getReader()),
              (reader) =>
                attempt("Cancel registry stream", () => reader.cancel()).pipe(Effect.ignore),
            )
            const decoder = new TextDecoder()
            let buffer = ""
            while (true) {
              const next = yield* attempt("Read registry stream", () => reader.read())
              if (next.done) return yield* Effect.fail(problem("Registry stream ended"))
              buffer += decoder.decode(next.value, { stream: true })
              let boundary: number
              while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const event = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                // Refresh on reconnect too: the registry may have changed while disconnected.
                if (/^event: (changed|ready)/.test(event)) yield* refresh(client)
              }
            }
          }),
        )
      return Plugins.of({ prepare, refresh, watch })
    }),
  )
