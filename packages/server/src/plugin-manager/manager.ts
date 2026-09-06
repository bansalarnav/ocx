import {
  normalizePath,
  validateID,
  inspectPluginWorkspace,
  globPattern,
  type PluginWorkspace,
} from "./workspace"
export { globPattern, type PluginWorkspace } from "./workspace"
import { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Location } from "@opencode-ai/schema/location"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Deferred, Result, Cause, Schema } from "effect"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { evaluate, OperationError } from "@ocx/protocol/errors"
import type { PluginStoreService } from "./store"
import { bundlePluginFiles } from "./bundler"
import { pluginDocs } from "./docs"
import { inspectPluginSource, makeQuickJSPlugin } from "./quickjs"
import type { LivePluginRegistry } from "./registry"
import type { StoredPlugin } from "./types"
const workspaceToolNames = new Set(["read", "write", "edit", "remove", "glob", "grep"])
const authorAllowedTools = new Set([...workspaceToolNames, "webfetch", "websearch", "question"])
export type SessionModel = Model.Ref
export const selectedSessionModel = (session: { model?: SessionModel }): SessionModel => {
  if (session.model === undefined) {
    throw new Error("The current chat has no selected model")
  }
  return session.model
}
const text = (content: unknown) => ({
  content: typeof content === "string" ? content : JSON.stringify(content, null, 2),
})
const authorSystem = `You are the plugin-author agent. You work in a private virtual filesystem containing one ordinary OpenCode plugin project. Use read, write, edit, remove, glob, and grep exactly as you would in a local repository. Never emit a file map or plugin JSON payload. The caller automatically validates, bundles, stores, and activates the workspace after you finish. If an automated check fails, you will receive the error and must fix the files.

${pluginDocs}

Keep your final response short. State what you changed and the tools or TUI elements the plugin contributes.`
const validateWorkspace = Effect.fn("PluginManager")(function* (workspace: PluginWorkspace) {
  const inspected = yield* evaluate("Inspect plugin workspace", () =>
    inspectPluginWorkspace(workspace),
  )
  const bundles = yield* bundlePluginFiles(workspace.files)
  if (bundles.serverBundle !== undefined) {
    const bundled = yield* inspectPluginSource(bundles.serverBundle)
    if (bundled.id !== inspected.id) {
      return yield* Effect.fail(
        new OperationError({
          operation: "Validate plugin",
          cause: new Error(
            `Bundled server plugin declares ${bundled.id}, expected ${inspected.id}`,
          ),
        }),
      )
    }
  }
  return { ...inspected, ...bundles }
})
const pluginView = (plugin: StoredPlugin, serverActive: boolean) => ({
  id: plugin.id,
  enabled: plugin.enabled,
  files: Object.keys(plugin.files),
  dependencies: plugin.dependencies ?? {},
  updatedAt: plugin.updatedAt,
  serverActive,
  tuiStatus: plugin.tuiBundle === undefined ? "absent" : "available-to-clients",
  bundleWarnings: plugin.bundleWarnings ?? [],
})
const activatePlugin = Effect.fn("PluginManager")(function* (
  registry: LivePluginRegistry,
  plugin: StoredPlugin,
) {
  if (plugin.serverBundle === undefined) {
    yield* registry.remove(plugin.id)
    return
  }
  const activated = Deferred.makeUnsafe<void, OperationError>()
  yield* registry.upsert(
    makeQuickJSPlugin(plugin, {
      resolve: () => Effect.runSync(Deferred.succeed(activated, undefined)),
      reject: (cause) =>
        Effect.runSync(
          Deferred.fail(activated, new OperationError({ operation: "Activate plugin", cause })),
        ),
    }),
  )
  yield* Deferred.await(activated).pipe(Effect.timeout("10 seconds"))
})
const assistantText = (messages: readonly SessionMessage.Info[]): string => {
  const message = [...messages].reverse().find((message) => message.type === "assistant")
  return (
    message?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") || "Plugin author completed without a text summary."
  )
}
const assistantFailure = (messages: readonly SessionMessage.Info[]): string | undefined => {
  const message = [...messages].reverse().find((message) => message.type === "assistant")
  return message?.error?.message
}
const toolEffect =
  <A extends unknown[], B, E>(body: (...args: A) => Effect.fn.Return<B, E>) =>
  (...args: A): Effect.Effect<B, Tool.Error> =>
    Effect.gen(() => body(...args)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              Tool.Error.make({ message: Cause.pretty(cause), error: Cause.pretty(cause) }),
            ),
      ),
    )

export const makePluginManager = (store: PluginStoreService, registry: LivePluginRegistry) =>
  define({
    id: "plugin-manager",
    effect: Effect.fn("effect")(function* (context) {
      const workspaces = new Map<string, PluginWorkspace>()
      const workspaceFor = (sessionID: string) => {
        const workspace = workspaces.get(sessionID)
        if (workspace === undefined)
          throw new Error("No plugin workspace is attached to this author session")
        return workspace
      }
      yield* context.agent.transform((agents) => {
        agents.update("plugin-author", (agent) => {
          agent.name = Agent.Name.make("Plugin author")
          agent.description = "Edits a normal plugin project in a private virtual filesystem"
          agent.mode = "subagent"
          agent.hidden = true
          agent.system = authorSystem
          agent.steps = 40
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        })
      })
      yield* context.session.hook("context", (event) =>
        Effect.sync(() => {
          if (event.agent === "plugin-author") {
            for (const name of Object.keys(event.tools)) {
              if (!authorAllowedTools.has(name)) delete event.tools[name]
            }
            return
          }
          for (const name of workspaceToolNames) delete event.tools[name]
        }),
      )
      const saveWorkspace = Effect.fn("PluginManager")(function* (
        workspace: PluginWorkspace,
        creating: boolean,
      ) {
        const built = yield* validateWorkspace(workspace)
        if (built.id === "plugin-manager" || built.id === "device-tools-only") {
          return yield* Effect.fail(
            new OperationError({
              operation: "Save plugin",
              cause: new Error(`Plugin id is reserved: ${built.id}`),
            }),
          )
        }
        const previous = yield* store.get(built.id)
        if (creating && previous !== undefined)
          return yield* Effect.fail(
            new OperationError({
              operation: "Save plugin",
              cause: new Error(`Plugin already exists: ${built.id}`),
            }),
          )
        if (registry.has(built.id) && previous === undefined) {
          return yield* Effect.fail(
            new OperationError({
              operation: "Save plugin",
              cause: new Error(`Plugin id collides with a built-in or SDK plugin: ${built.id}`),
            }),
          )
        }
        const plugin: StoredPlugin = {
          id: built.id,
          files: { ...workspace.files },
          serverBundle: built.serverBundle,
          tuiBundle: built.tuiBundle,
          dependencies: built.dependencies,
          bundleWarnings: built.warnings,
          enabled: true,
          updatedAt: Date.now(),
        }
        yield* store.put(plugin)
        yield* activatePlugin(registry, plugin).pipe(
          Effect.andThen(context.tool.reload()),
          Effect.onError(() =>
            Effect.gen(function* () {
              if (previous === undefined) {
                yield* store.remove(plugin.id)
                yield* registry.remove(plugin.id)
              } else {
                yield* store.put(previous)
                if (previous.enabled) yield* activatePlugin(registry, previous)
                else yield* registry.remove(previous.id)
              }
            }).pipe(Effect.orDie),
          ),
        )
        return plugin
      })
      const runAuthor = Effect.fn("PluginManager")(function* (input: {
        prompt: string
        title: string
        workspace: PluginWorkspace
        location?: Location.Ref
        creating: boolean
        model: SessionModel
      }) {
        const session = yield* context.session.create({
          title: input.title,
          agent: Agent.ID.make("plugin-author"),
          model: input.model,
          location: input.location,
        })
        yield* context.session.switchModel({ sessionID: session.id, model: input.model })
        workspaces.set(session.id, input.workspace)
        let prompt = input.prompt
        let summary = ""
        return yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 4; attempt++) {
            yield* context.session.prompt({
              sessionID: session.id,
              text: prompt,
              resume: true,
            })
            yield* context.session.wait({ sessionID: session.id })
            const sessionContext = yield* context.session.context({
              sessionID: session.id,
            })
            const failure = assistantFailure(sessionContext)
            if (failure !== undefined)
              return yield* Effect.fail(
                new OperationError({ operation: "Plugin author", cause: new Error(failure) }),
              )
            summary = assistantText(sessionContext)
            const result = yield* Effect.result(saveWorkspace(input.workspace, input.creating))
            if (Result.isSuccess(result)) return { plugin: result.success, summary }
            if (attempt === 3) return yield* Effect.fail(result.failure)
            prompt = `The automatic plugin check failed:\n\n${String(result.failure)}\n\nInspect the workspace and fix the files.`
          }
          return yield* Effect.fail(
            new OperationError({
              operation: "Plugin author",
              cause: new Error("Repair attempts exhausted"),
            }),
          )
        }).pipe(Effect.ensuring(Effect.sync(() => workspaces.delete(session.id))))
      })
      yield* context.tool.transform((tools) => {
        tools.add({
          name: "read",
          description: "Read a text file from the current plugin workspace.",
          input: Schema.Struct({ path: Schema.String }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const path = normalizePath(input.path)
            const content = workspaceFor(toolContext.sessionID).files[path]
            if (content === undefined) throw new Error(`File not found: ${path}`)
            return text(content)
          }),
        })
        tools.add({
          name: "write",
          description:
            "Create or completely overwrite a text file in the current plugin workspace.",
          input: Schema.Struct({ path: Schema.String, content: Schema.String }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const path = normalizePath(input.path)
            workspaceFor(toolContext.sessionID).files[path] = input.content
            return text(`Wrote ${path}`)
          }),
        })
        tools.add({
          name: "edit",
          description: "Replace exact text in a plugin workspace file.",
          input: Schema.Struct({
            path: Schema.String,
            old_text: Schema.String,
            new_text: Schema.String,
            replace_all: Schema.optional(Schema.Boolean),
          }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const path = normalizePath(input.path)
            const workspace = workspaceFor(toolContext.sessionID)
            const current = workspace.files[path]
            if (current === undefined) throw new Error(`File not found: ${path}`)
            if (input.old_text === "") throw new Error("old_text must not be empty")
            const count = current.split(input.old_text).length - 1
            if (count === 0) throw new Error(`Text not found in ${path}`)
            if (count > 1 && !input.replace_all)
              throw new Error(
                `Text occurs ${count} times in ${path}; set replace_all or use a larger match`,
              )
            workspace.files[path] = input.replace_all
              ? current.split(input.old_text).join(input.new_text)
              : current.replace(input.old_text, input.new_text)
            return text(`Edited ${path}`)
          }),
        })
        tools.add({
          name: "remove",
          description: "Remove a file from the current plugin workspace.",
          input: Schema.Struct({ path: Schema.String }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const path = normalizePath(input.path)
            const files = workspaceFor(toolContext.sessionID).files
            if (!(path in files)) throw new Error(`File not found: ${path}`)
            delete files[path]
            return text(`Removed ${path}`)
          }),
        })
        tools.add({
          name: "glob",
          description: "List plugin workspace files matching a glob pattern such as **/*.ts.",
          input: Schema.Struct({ pattern: Schema.optional(Schema.String) }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const pattern = typeof input.pattern === "string" ? input.pattern : "**"
            const expression = globPattern(pattern)
            return text(
              Object.keys(workspaceFor(toolContext.sessionID).files)
                .filter((path) => expression.test(path))
                .sort(),
            )
          }),
        })
        tools.add({
          name: "grep",
          description: "Search plugin workspace files with a JavaScript regular expression.",
          input: Schema.Struct({ pattern: Schema.String, path: Schema.optional(Schema.String) }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const expression = new RegExp(input.pattern)
            const prefix = input.path === undefined ? "" : normalizePath(input.path)
            const matches: string[] = []
            for (const [path, content] of Object.entries(
              workspaceFor(toolContext.sessionID).files,
            )) {
              if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`)) continue
              content.split("\n").forEach((line, index) => {
                expression.lastIndex = 0
                if (expression.test(line)) matches.push(`${path}:${index + 1}:${line}`)
              })
            }
            return text(matches)
          }),
        })
        tools.add({
          name: "create_plugin",
          description:
            "Have the private plugin-author create, validate, bundle, and activate a new plugin project.",
          input: Schema.Struct({ prompt: Schema.String }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const current = yield* context.session.get({ sessionID: toolContext.sessionID })
            const result = yield* runAuthor({
              prompt: input.prompt,
              title: `Create plugin: ${input.prompt.slice(0, 80)}`,
              workspace: { files: {} },
              location: current.location,
              creating: true,
              model: selectedSessionModel(current),
            })
            return text({
              ok: true,
              plugin: pluginView(result.plugin, registry.has(result.plugin.id)),
              author: result.summary,
            })
          }),
        })
        tools.add({
          name: "edit_plugin",
          description:
            "Load an existing plugin into a private workspace, have the author edit it, then automatically validate and reactivate it.",
          input: Schema.Struct({ id: Schema.String, prompt: Schema.String }),
          options: { codemode: false },
          execute: toolEffect(function* (input, toolContext) {
            const existing = yield* store.get(validateID(input.id))
            if (existing === undefined) throw new Error(`Plugin not found: ${input.id}`)
            const current = yield* context.session.get({ sessionID: toolContext.sessionID })
            const result = yield* runAuthor({
              prompt: input.prompt,
              title: `Edit plugin ${existing.id}: ${input.prompt.slice(0, 70)}`,
              workspace: { files: { ...existing.files }, expectedID: existing.id },
              location: current.location,
              creating: false,
              model: selectedSessionModel(current),
            })
            return text({
              ok: true,
              plugin: pluginView(result.plugin, registry.has(result.plugin.id)),
              author: result.summary,
            })
          }),
        })
        tools.add({
          name: "list_plugins",
          description: "List agent-authored plugins, their files, dependencies, and active state.",
          input: Schema.Struct({}),
          options: { codemode: false },
          execute: toolEffect(function* () {
            return text(
              (yield* store.list).map((plugin) => pluginView(plugin, registry.has(plugin.id))),
            )
          }),
        })
        tools.add({
          name: "plugin_deactivate",
          description:
            "Deactivate an agent-authored plugin while retaining its source for later editing.",
          input: Schema.Struct({ id: Schema.String }),
          options: { codemode: false },
          execute: toolEffect(function* (input) {
            const id = validateID(input.id)
            const plugin = yield* store.get(id)
            if (plugin === undefined) throw new Error(`Plugin not found: ${id}`)
            yield* store.put({ ...plugin, enabled: false, updatedAt: Date.now() })
            yield* registry.remove(id)
            yield* context.tool.reload()
            return text({ ok: true, id, active: false })
          }),
        })
      })
    }),
  })
