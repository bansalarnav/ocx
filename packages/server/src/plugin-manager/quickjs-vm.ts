import quickjsVariant from "@jitl/quickjs-wasmfile-release-sync"
import quickjsWasm from "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm"
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from "quickjs-emscripten-core"
import {
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from "quickjs-emscripten-core"

const pluginModule = `export const Plugin = { define(plugin) { return plugin } }`
const getQuickJS = memoizePromiseFactory(() =>
  newQuickJSWASMModuleFromVariant(
    newVariant(
      quickjsVariant,
      typeof quickjsWasm === "string"
        ? { wasmLocation: quickjsWasm }
        : { wasmModule: quickjsWasm as WebAssembly.Module },
    ),
  ),
)
const deadlines = new WeakMap<QuickJSRuntime, number>()
export const armRuntime = (runtime: QuickJSRuntime) => deadlines.set(runtime, Date.now() + 2_000)

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

export const unwrap = (vm: QuickJSContext, result: ReturnType<QuickJSContext["evalCode"]>) => {
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

export const waitForPromise = async (
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  handle: QuickJSHandle,
  signal?: AbortSignal,
): Promise<QuickJSHandle> => {
  let settled = false
  const result = vm.resolvePromise(handle).then((value) => {
    settled = true
    return value
  })
  for (let turns = 0; !settled; turns++) {
    signal?.throwIfAborted()
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

export const loadModule = async (source: string): Promise<LoadedModule> => {
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
