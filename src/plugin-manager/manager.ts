import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { fromPromise } from "@opencode-ai/plugin/promise/adapter"
import { bundlePluginFiles } from "./bundler"
import { pluginDocs } from "./docs"
import { inspectPluginSource, makeQuickJSPlugin } from "./quickjs"
import type { LivePluginRegistry } from "./registry"
import type { PluginStore, StoredPlugin } from "./types"

export interface PluginWorkspace {
  files: Record<string, string>
  expectedID?: string
}

const workspaceToolNames = new Set([
  "read",
  "write",
  "edit",
  "remove",
  "glob",
  "grep",
])

const authorAllowedTools = new Set([
  ...workspaceToolNames,
  "webfetch",
  "websearch",
  "question",
])

const authorModel = {
  providerID: "opencode",
  id: "big-pickle",
} as never

const objectInput = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})

const text = (content: unknown) => ({
  content: typeof content === "string" ? content : JSON.stringify(content, null, 2),
})

const authorSystem = `You are the plugin-author agent. You work in a private virtual filesystem containing one ordinary OpenCode plugin project. Use read, write, edit, remove, glob, and grep exactly as you would in a local repository. Never emit a file map or plugin JSON payload. The caller automatically validates, bundles, stores, and activates the workspace after you finish. If an automated check fails, you will receive the error and must fix the files.

${pluginDocs}

Keep your final response short. State what you changed and the tools or TUI elements the plugin contributes.`

const normalizePath = (input: unknown): string => {
  if (typeof input !== "string") throw new Error("path must be a string")
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "")
  if (path === "" || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid workspace path: ${input}`)
  }
  if (!/^[A-Za-z0-9._/-]{1,160}$/.test(path)) throw new Error(`Invalid workspace path: ${input}`)
  return path
}

export const globPattern = (pattern: string): RegExp => {
  let expression = "^"
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?"
          index += 2
        } else {
          expression += ".*"
          index++
        }
      } else expression += "[^/]*"
    } else if (character === "?") expression += "[^/]"
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`${expression}$`)
}

const literalPluginID = (source: string, file: string): string => {
  const match = /\bid\s*:\s*(["'])([A-Za-z0-9_-]{1,64})\1/.exec(source)
  if (!match?.[2]) throw new Error(`Could not find a valid literal plugin id in ${file}`)
  return match[2]
}

const validateID = (id: unknown): string => {
  if (typeof id !== "string") throw new Error("Plugin id must be a string")
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error("Plugin id must match [A-Za-z0-9_-]{1,64}")
  }
  return id
}

const inspectPluginWorkspace = (workspace: PluginWorkspace) => {
  const files = workspace.files
  const serverEntry = files["server.ts"] !== undefined ? "server.ts"
    : files["server.js"] !== undefined ? "server.js"
    : undefined
  const tuiEntry = files["tui.tsx"] !== undefined ? "tui.tsx" : undefined
  if (serverEntry === undefined && tuiEntry === undefined) {
    throw new Error("Workspace must contain server.ts, server.js, or tui.tsx")
  }

  let bytes = 0
  for (const [name, content] of Object.entries(files)) {
    normalizePath(name)
    bytes += new TextEncoder().encode(content).byteLength
  }
  if (bytes > 1024 * 1024) throw new Error("Plugin source files exceed 1 MiB")

  const ids = [
    ...(serverEntry === undefined ? [] : [literalPluginID(files[serverEntry]!, serverEntry)]),
    ...(tuiEntry === undefined ? [] : [literalPluginID(files[tuiEntry]!, tuiEntry)]),
  ]
  const id = validateID(ids[0]!)
  if (ids.some((candidate) => candidate !== id)) {
    throw new Error(`Server and TUI entrypoints must declare the same plugin id: ${ids.join(", ")}`)
  }
  if (workspace.expectedID !== undefined && id !== workspace.expectedID) {
    throw new Error(`Edited plugin must keep id ${workspace.expectedID}; workspace declares ${id}`)
  }
  if (tuiEntry !== undefined) {
    const source = files[tuiEntry]!
    if (!source.includes("@opencode-ai/plugin/tui")) throw new Error("tui.tsx must import @opencode-ai/plugin/tui")
    if (!/import\s*\{[^}]*\bPlugin\b[^}]*\}\s*from\s*["']@opencode-ai\/plugin\/tui["']/.test(source)) {
      throw new Error("tui.tsx must use the named Plugin export from @opencode-ai/plugin/tui")
    }
    if (!/\bPlugin\.define\s*\(/.test(source) || !/\bsetup\s*\(/.test(source) || !/export\s+default\s+/.test(source)) {
      throw new Error("tui.tsx must default-export Plugin.define with an id and setup function")
    }
  }

  return { id, serverEntry, tuiEntry }
}

const validateWorkspace = async (workspace: PluginWorkspace) => {
  const inspected = inspectPluginWorkspace(workspace)
  const bundles = await bundlePluginFiles(workspace.files)
  if (bundles.serverBundle !== undefined) {
    const bundled = await inspectPluginSource(bundles.serverBundle)
    if (bundled.id !== inspected.id) {
      throw new Error(`Bundled server plugin declares ${bundled.id}, expected ${inspected.id}`)
    }
  }
  return { ...inspected, ...bundles }
}

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

const activatePlugin = async (
  registry: LivePluginRegistry,
  plugin: StoredPlugin,
) => {
  if (plugin.serverBundle === undefined) {
    await registry.remove(plugin.id)
    return
  }
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const activated = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  await registry.upsert(makeQuickJSPlugin(plugin, { resolve, reject }))
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      activated,
      new Promise<never>((_, fail) => {
        timeout = setTimeout(() => fail(new Error(`Timed out activating plugin ${plugin.id}`)), 10_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const assistantText = (parts: unknown): string => {
  if (!Array.isArray(parts)) return "Plugin author completed without a text summary."
  for (const part of [...parts].reverse()) {
    if (!part || typeof part !== "object" || (part as { type?: string }).type !== "assistant") continue
    const content = (part as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const output = content
      .filter((item): item is { type: "text"; text: string } =>
        !!item && typeof item === "object" &&
        (item as { type?: string }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string")
      .map((item) => item.text)
      .join("\n")
    if (output) return output
  }
  return "Plugin author completed without a text summary."
}

const assistantFailure = (parts: unknown): string | undefined => {
  if (!Array.isArray(parts)) return undefined
  for (const part of [...parts].reverse()) {
    if (!part || typeof part !== "object" || (part as { type?: string }).type !== "assistant") continue
    const error = (part as { error?: unknown }).error
    if (!error || typeof error !== "object") return undefined
    const message = (error as { message?: unknown }).message
    const status = (error as { status?: unknown }).status
    const detail = typeof message === "string" ? message : "Unknown model error"
    return typeof status === "number" ? `Plugin author model failed (${status}): ${detail}` : `Plugin author model failed: ${detail}`
  }
  return undefined
}

export const makePluginManager = (
  store: PluginStore,
  registry: LivePluginRegistry,
) => fromPromise({
  id: "plugin-manager",
  async setup(context) {
    const workspaces = new Map<string, PluginWorkspace>()
    const workspaceFor = (sessionID: string) => {
      const workspace = workspaces.get(sessionID)
      if (workspace === undefined) throw new Error("No plugin workspace is attached to this author session")
      return workspace
    }

    await context.agent.transform((agents) => {
      agents.update("plugin-author", (agent) => {
        agent.name = "Plugin author" as never
        agent.description = "Edits a normal plugin project in a private virtual filesystem"
        agent.mode = "subagent"
        agent.hidden = true
        agent.model = authorModel
        agent.system = authorSystem
        agent.steps = 40
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      })
    })

    await context.session.hook("context", (event) => {
      if (event.agent === "plugin-author") {
        for (const name of Object.keys(event.tools)) {
          if (!authorAllowedTools.has(name)) delete event.tools[name]
        }
        return
      }
      for (const name of workspaceToolNames) delete event.tools[name]
    })

    const saveWorkspace = async (workspace: PluginWorkspace, creating: boolean) => {
      const built = await validateWorkspace(workspace)
      if (built.id === "plugin-manager" || built.id === "device-tools-only") {
        throw new Error(`Plugin id is reserved: ${built.id}`)
      }
      const previous = await store.get(built.id)
      if (creating && previous !== undefined) throw new Error(`Plugin already exists: ${built.id}`)
      if (registry.has(built.id) && previous === undefined) {
        throw new Error(`Plugin id collides with a built-in or SDK plugin: ${built.id}`)
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
      await store.put(plugin)
      try {
        await activatePlugin(registry, plugin)
        await context.tool.reload()
      } catch (error) {
        if (previous === undefined) {
          await store.remove(plugin.id)
          await registry.remove(plugin.id)
        } else {
          await store.put(previous)
          if (previous.enabled) await activatePlugin(registry, previous)
          else await registry.remove(previous.id)
        }
        throw error
      }
      return plugin
    }

    const runAuthor = async (input: {
      prompt: string
      title: string
      workspace: PluginWorkspace
      location?: unknown
      creating: boolean
    }) => {
      const session = await context.session.create({
        title: input.title,
        agent: "plugin-author",
        model: authorModel,
        location: input.location,
      } as never) as unknown as { id: string }
      await context.session.switchModel({ sessionID: session.id, model: authorModel } as never)
      workspaces.set(session.id, input.workspace)
      let prompt = input.prompt
      let summary = ""
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          await context.session.prompt({ sessionID: session.id, text: prompt, resume: true } as never)
          await context.session.wait({ sessionID: session.id } as never)
          const sessionContext = await context.session.context({ sessionID: session.id } as never)
          const failure = assistantFailure(sessionContext)
          if (failure !== undefined) throw new Error(failure)
          summary = assistantText(sessionContext)
          try {
            const plugin = await saveWorkspace(input.workspace, input.creating)
            return { plugin, summary }
          } catch (error) {
            if (attempt === 3) throw error
            prompt = `The automatic plugin check failed:\n\n${error instanceof Error ? error.message : String(error)}\n\nInspect the workspace, fix the files, and finish again. Do not merely explain the error.`
          }
        }
        throw new Error("Plugin author exhausted repair attempts")
      } finally {
        workspaces.delete(session.id)
      }
    }

    await context.tool.transform((tools) => {
      tools.add({
        name: "read",
        description: "Read a text file from the current plugin workspace.",
        input: objectInput({ path: { type: "string" } }, ["path"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const path = normalizePath(input.path)
          const content = workspaceFor(toolContext.sessionID).files[path]
          if (content === undefined) throw new Error(`File not found: ${path}`)
          return text(content)
        },
      })
      tools.add({
        name: "write",
        description: "Create or completely overwrite a text file in the current plugin workspace.",
        input: objectInput({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const path = normalizePath(input.path)
          workspaceFor(toolContext.sessionID).files[path] = input.content
          return text(`Wrote ${path}`)
        },
      })
      tools.add({
        name: "edit",
        description: "Replace exact text in a plugin workspace file.",
        input: objectInput({
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        }, ["path", "old_text", "new_text"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const path = normalizePath(input.path)
          const workspace = workspaceFor(toolContext.sessionID)
          const current = workspace.files[path]
          if (current === undefined) throw new Error(`File not found: ${path}`)
          if (input.old_text === "") throw new Error("old_text must not be empty")
          const count = current.split(input.old_text).length - 1
          if (count === 0) throw new Error(`Text not found in ${path}`)
          if (count > 1 && !input.replace_all) throw new Error(`Text occurs ${count} times in ${path}; set replace_all or use a larger match`)
          workspace.files[path] = input.replace_all
            ? current.split(input.old_text).join(input.new_text)
            : current.replace(input.old_text, input.new_text)
          return text(`Edited ${path}`)
        },
      })
      tools.add({
        name: "remove",
        description: "Remove a file from the current plugin workspace.",
        input: objectInput({ path: { type: "string" } }, ["path"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const path = normalizePath(input.path)
          const files = workspaceFor(toolContext.sessionID).files
          if (!(path in files)) throw new Error(`File not found: ${path}`)
          delete files[path]
          return text(`Removed ${path}`)
        },
      })
      tools.add({
        name: "glob",
        description: "List plugin workspace files matching a glob pattern such as **/*.ts.",
        input: objectInput({ pattern: { type: "string" } }),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const pattern = typeof input.pattern === "string" ? input.pattern : "**"
          const expression = globPattern(pattern)
          return text(Object.keys(workspaceFor(toolContext.sessionID).files).filter((path) => expression.test(path)).sort())
        },
      })
      tools.add({
        name: "grep",
        description: "Search plugin workspace files with a JavaScript regular expression.",
        input: objectInput({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const expression = new RegExp(input.pattern)
          const prefix = input.path === undefined ? "" : normalizePath(input.path)
          const matches: string[] = []
          for (const [path, content] of Object.entries(workspaceFor(toolContext.sessionID).files)) {
            if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`)) continue
            content.split("\n").forEach((line, index) => {
              expression.lastIndex = 0
              if (expression.test(line)) matches.push(`${path}:${index + 1}:${line}`)
            })
          }
          return text(matches)
        },
      })

      tools.add({
        name: "create_plugin",
        description: "Have the private plugin-author create, validate, bundle, and activate a new plugin project.",
        input: objectInput({ prompt: { type: "string", description: "What the plugin should do" } }, ["prompt"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const current = await context.session.get({ sessionID: toolContext.sessionID }) as unknown as { location?: unknown }
          const result = await runAuthor({
            prompt: input.prompt,
            title: `Create plugin: ${input.prompt.slice(0, 80)}`,
            workspace: { files: {} },
            location: current.location,
            creating: true,
          })
          return text({ ok: true, plugin: pluginView(result.plugin, registry.has(result.plugin.id)), author: result.summary })
        },
      })
      tools.add({
        name: "edit_plugin",
        description: "Load an existing plugin into a private workspace, have the author edit it, then automatically validate and reactivate it.",
        input: objectInput({ id: { type: "string" }, prompt: { type: "string" } }, ["id", "prompt"]),
        options: { codemode: false },
        async execute(input: any, toolContext) {
          const existing = await store.get(validateID(input.id))
          if (existing === undefined) throw new Error(`Plugin not found: ${input.id}`)
          const current = await context.session.get({ sessionID: toolContext.sessionID }) as unknown as { location?: unknown }
          const result = await runAuthor({
            prompt: input.prompt,
            title: `Edit plugin ${existing.id}: ${input.prompt.slice(0, 70)}`,
            workspace: { files: { ...existing.files }, expectedID: existing.id },
            location: current.location,
            creating: false,
          })
          return text({ ok: true, plugin: pluginView(result.plugin, registry.has(result.plugin.id)), author: result.summary })
        },
      })
      tools.add({
        name: "list_plugins",
        description: "List agent-authored plugins, their files, dependencies, and active state.",
        input: objectInput({}),
        options: { codemode: false },
        async execute() {
          return text((await store.list()).map((plugin) => pluginView(plugin, registry.has(plugin.id))))
        },
      })
      tools.add({
        name: "plugin_deactivate",
        description: "Deactivate an agent-authored plugin while retaining its source for later editing.",
        input: objectInput({ id: { type: "string" } }, ["id"]),
        options: { codemode: false },
        async execute(input: any) {
          const id = validateID(input.id)
          const plugin = await store.get(id)
          if (plugin === undefined) throw new Error(`Plugin not found: ${id}`)
          await store.put({ ...plugin, enabled: false, updatedAt: Date.now() })
          await registry.remove(id)
          await context.tool.reload()
          return text({ ok: true, id, active: false })
        },
      })
    })
  },
})
