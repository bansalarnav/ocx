import type { Context as PromisePluginContext } from "@opencode-ai/plugin/promise/plugin"
import type { Plugin as PromisePlugin } from "@opencode-ai/plugin/promise/plugin"
import { fromPromise } from "@opencode-ai/plugin/promise/adapter"
import quickjsVariant from "@jitl/quickjs-wasmfile-release-sync"
import quickjsWasm from "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm"
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
} from "quickjs-emscripten-core"
import {
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from "quickjs-emscripten-core"
import type { StoredPlugin } from "./types"

const pluginModule = `export const Plugin = { define(plugin) { return plugin } }`
const getQuickJS = memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(
  newVariant(
    quickjsVariant,
    typeof quickjsWasm === "string"
      ? { wasmLocation: quickjsWasm }
      : { wasmModule: quickjsWasm as WebAssembly.Module },
  ),
))
const deadlines = new WeakMap<QuickJSRuntime, number>()
const armRuntime = (runtime: QuickJSRuntime) => deadlines.set(runtime, Date.now() + 2_000)

const bridgeSource = `
const __tools = new Map()
const __executors = new Map()
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const publicTool = (tool) => {
  const { execute, ...definition } = tool
  return clone(definition)
}
const draft = {
  list() { return Array.from(__tools.values()).map(publicTool) },
  get(id) { const tool = __tools.get(id); return tool && publicTool(tool) },
  add(tool) {
    if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
      throw new TypeError("tools.add requires a tool with name and execute")
    }
    const id = tool.options && tool.options.namespace
      ? tool.options.namespace.replaceAll(".", "_") + "_" + tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      : tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
    if (__tools.has(id)) throw new Error("Duplicate plugin tool: " + id)
    __tools.set(id, tool)
    __executors.set(id, tool.execute)
  },
  update(id, update) {
    const tool = __tools.get(id)
    if (!tool) return
    update(tool)
    __executors.set(id, tool.execute)
  },
  remove(id) { __tools.delete(id); __executors.delete(id) },
}
const host = (method, value) => __oc_host_call(method, JSON.stringify(value)).then(JSON.parse)
globalThis.__oc_context = {
  tool: {
    transform(callback) { callback(draft); return Promise.resolve({ dispose() {} }) },
    reload() { return Promise.resolve() },
  },
  storage: {
    get(key) { return host("storage.get", { key }) },
    set(key, value) { return host("storage.set", { key, value }) },
    remove(key) { return host("storage.remove", { key }) },
    scan(options) { return host("storage.scan", options || {}) },
  },
}
globalThis.__oc_tool_definitions = () => JSON.stringify(Array.from(__tools.values()).map(publicTool))
globalThis.__oc_invoke = (id, input, context) => {
  const execute = __executors.get(id)
  if (!execute) throw new Error("Unknown plugin tool: " + id)
  return Promise.resolve(execute(input, context)).then((result) => {
    if (typeof result === "string") return { content: result }
    if (!result || typeof result !== "object") return { output: result }
    return result
  })
}
`

const errorText = (vm: QuickJSContext, handle: QuickJSHandle): string => {
  const value = vm.dump(handle) as { name?: string; message?: string; stack?: string }
  if (value && typeof value === "object") {
    return value.stack ?? [value.name, value.message].filter(Boolean).join(": ")
  }
  return String(value)
}

const unwrap = (vm: QuickJSContext, result: ReturnType<QuickJSContext["evalCode"]>) => {
  if (result.error) {
    const message = errorText(vm, result.error)
    result.error.dispose()
    throw new Error(message)
  }
  return result.value
}

const pump = (runtime: QuickJSRuntime) => {
  armRuntime(runtime)
  const result = runtime.executePendingJobs()
  if (result.error) {
    const message = errorText(result.error.context, result.error)
    result.error.dispose()
    throw new Error(message)
  }
}

const waitForPromise = async (
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  handle: QuickJSHandle,
): Promise<QuickJSHandle> => {
  let settled = false
  const result = vm.resolvePromise(handle).then((value) => {
    settled = true
    return value
  })
  for (let turns = 0; !settled; turns++) {
    if (turns > 10_000) throw new Error("QuickJS promise did not settle")
    pump(runtime)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const resolved = await result
  if (resolved.error) {
    const message = errorText(vm, resolved.error)
    resolved.error.dispose()
    throw new Error(message)
  }
  return resolved.value
}

interface LoadedModule {
  id: string
  runtime: QuickJSRuntime
  vm: QuickJSContext
  plugin: QuickJSHandle
}

const loadModule = async (source: string): Promise<LoadedModule> => {
  const quickjs = await getQuickJS()
  const runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(64 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(() => Date.now() > (deadlines.get(runtime) ?? 0))
  runtime.setModuleLoader((name) => {
    if (name === "@opencode-ai/plugin") return pluginModule
    return { error: new Error(`Unsupported import: ${name}`) }
  })
  const vm = runtime.newContext()

  try {
    armRuntime(runtime)
    using bridge = unwrap(vm, vm.evalCode(bridgeSource, "opencode-bridge.js"))
    armRuntime(runtime)
    let namespace = unwrap(vm, vm.evalCode(source, "plugin.mjs", { type: "module" }))
    const state = vm.getPromiseState(namespace)
    if (state.type === "pending") {
      const pending = namespace
      namespace = await waitForPromise(vm, runtime, pending)
      pending.dispose()
    }
    using plugin = vm.getProp(namespace, "default")
    namespace.dispose()
    if (vm.typeof(plugin) !== "object") throw new Error("Plugin must have a default object export")
    using idHandle = vm.getProp(plugin, "id")
    const id = vm.getString(idHandle)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error("Plugin id must match [A-Za-z0-9_-]{1,64}")
    }
    using setup = vm.getProp(plugin, "setup")
    if (vm.typeof(setup) !== "function") throw new Error("Plugin setup must be a function")
    return { id, runtime, vm, plugin: plugin.dup() }
  } catch (error) {
    vm.dispose()
    runtime.dispose()
    throw error
  }
}

export const inspectPluginSource = async (source: string): Promise<{ id: string }> => {
  const loaded = await loadModule(source)
  loaded.plugin.dispose()
  loaded.vm.dispose()
  loaded.runtime.dispose()
  return { id: loaded.id }
}

const callHost = async (
  context: PromisePluginContext,
  method: string,
  input: unknown,
): Promise<unknown> => {
  const value = input as { key?: string; value?: unknown }
  switch (method) {
    case "storage.get": return context.storage.get(String(value.key))
    case "storage.set":
      await context.storage.set(String(value.key), value.value as never)
      return null
    case "storage.remove":
      await context.storage.remove(String(value.key))
      return null
    case "storage.scan": return context.storage.scan(input as never)
    default: throw new Error(`Unsupported host call: ${method}`)
  }
}

export interface ActivationSignal {
  resolve(): void
  reject(error: unknown): void
}

export const makeQuickJSPromisePlugin = (
  stored: StoredPlugin,
  activation?: ActivationSignal,
): PromisePlugin => ({
  id: stored.id,
  async setup(context) {
    const source = stored.serverBundle ?? stored.files["server.ts"] ?? stored.files["server.js"]
    if (source === undefined) throw new Error(`Plugin ${stored.id} has no server entrypoint`)
    const loaded = await loadModule(source)
    const { runtime, vm, plugin } = loaded
    if (loaded.id !== stored.id) {
      plugin.dispose()
      vm.dispose()
      runtime.dispose()
      const error = new Error(`Stored plugin id ${stored.id} does not match source id ${loaded.id}`)
      activation?.reject(error)
      throw error
    }

    let queue = Promise.resolve<unknown>(undefined)
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = queue.then(operation, operation)
      queue = next.catch(() => undefined)
      return next
    }

    const hostCall = vm.newFunction("__oc_host_call", (methodHandle, inputHandle) => {
      const method = vm.getString(methodHandle)
      const input = JSON.parse(vm.getString(inputHandle)) as unknown
      const deferred = vm.newPromise()
      void callHost(context, method, input).then(
        (result) => {
          const value = vm.newString(JSON.stringify(result ?? null))
          deferred.resolve(value)
          value.dispose()
        },
        (error) => {
          const value = vm.newError(error instanceof Error ? error.message : String(error))
          deferred.reject(value)
          value.dispose()
        },
      )
      return deferred.handle
    })
    vm.setProp(vm.global, "__oc_host_call", hostCall)
    hostCall.dispose()

    try {
      using setup = vm.getProp(plugin, "setup")
      using guestContext = vm.getProp(vm.global, "__oc_context")
      armRuntime(runtime)
      using setupResult = vm.callFunction(setup, plugin, guestContext).unwrap()
      using settledSetup = await waitForPromise(vm, runtime, setupResult)

      using definitionsFn = vm.getProp(vm.global, "__oc_tool_definitions")
      using definitionsResult = vm.callFunction(definitionsFn, vm.undefined).unwrap()
      const definitions = JSON.parse(vm.getString(definitionsResult)) as Array<{
        name: string
        description: string
        input: Record<string, unknown>
        output?: Record<string, unknown>
        options?: { namespace?: string; codemode?: boolean }
      }>

      const registration = await context.tool.transform((tools) => {
        for (const definition of definitions) {
          const id = definition.options?.namespace
            ? `${definition.options.namespace.replaceAll(".", "_")}_${definition.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`
            : definition.name.replace(/[^a-zA-Z0-9_-]/g, "_")
          if (tools.get(id)) throw new Error(`Plugin tool collides with an existing tool: ${id}`)
          tools.add({
            ...definition,
            execute: (input, toolContext) => serialize(async () => {
              using invoke = vm.getProp(vm.global, "__oc_invoke")
              using idHandle = vm.newString(id)
              using inputHandle = vm.newString(JSON.stringify(input))
              using contextHandle = vm.newString(JSON.stringify({
                sessionID: toolContext.sessionID,
                agent: toolContext.agent,
                messageID: toolContext.messageID,
                id: toolContext.id,
              }))
              using parsed = unwrap(vm, vm.evalCode("JSON.parse", "bridge-call.js"))
              using guestInput = vm.callFunction(parsed, vm.undefined, inputHandle).unwrap()
              using guestToolContext = vm.callFunction(parsed, vm.undefined, contextHandle).unwrap()
              armRuntime(runtime)
              using call = vm.callFunction(invoke, vm.undefined, idHandle, guestInput, guestToolContext).unwrap()
              using result = await waitForPromise(vm, runtime, call)
              return vm.dump(result) as never
            }),
          })
        }
      })
      await context.tool.reload()
      activation?.resolve()

      return async () => {
        await registration.dispose()
        await queue.catch(() => undefined)
        plugin.dispose()
        vm.dispose()
        runtime.dispose()
      }
    } catch (error) {
      activation?.reject(error)
      plugin.dispose()
      vm.dispose()
      runtime.dispose()
      throw error
    }
  },
})

export const makeQuickJSPlugin = (
  stored: StoredPlugin,
  activation?: ActivationSignal,
) => fromPromise(makeQuickJSPromisePlugin(stored, activation))
