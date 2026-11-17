import { Cause, Effect, FiberSet, Semaphore } from "effect"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { attempt, evaluate } from "@ocx/protocol/errors"
import { armRuntime, loadModule, unwrap, waitForPromise } from "./quickjs-vm"
import type { StoredPlugin } from "./types"

type LoadedModule = Awaited<ReturnType<typeof loadModule>>
const dispose = (loaded: LoadedModule) =>
  Effect.sync(() => {
    loaded.plugin.dispose()
    loaded.vm.dispose()
    loaded.runtime.dispose()
  })
const guestCall = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const abort = new AbortController()
      return { abort, pending: run(abort.signal) }
    }),
    ({ pending }) => attempt(operation, () => pending),
    ({ abort, pending }) =>
      Effect.sync(() => abort.abort()).pipe(
        Effect.andThen(
          Effect.promise(() =>
            pending.then(
              () => undefined,
              () => undefined,
            ),
          ),
        ),
      ),
  )
const acquire = (source: string) =>
  Effect.acquireRelease(
    attempt("Load QuickJS module", () => loadModule(source)),
    dispose,
  )
// Setup validation uses disposable storage and cannot perform network calls or durable writes.
export const validatePluginSetup = (source: string) => Effect.scoped(acquire(source).pipe(
  Effect.flatMap(({ vm, runtime, plugin }) => guestCall("Validate plugin capabilities", async (signal) => {
    using offline = unwrap(vm, vm.evalCode(`globalThis.__oc_host_call = async (method, input) => {
      if (method === "storage.get") return "{}";
      if (method === "storage.scan") return JSON.stringify({ value: { entries: [] } });
      if (method === "storage.set" || method === "storage.remove") return "{}";
      throw new Error("Unsupported validation host call: " + method);
    }`, "offline-validation.js"))
    using setup = vm.getProp(plugin, "setup")
    using context = vm.getProp(vm.global, "__oc_context")
    armRuntime(runtime)
    using result = vm.callFunction(setup, plugin, context).unwrap()
    using settled = await waitForPromise(vm, runtime, result, signal)
    using definitions = vm.getProp(vm.global, "__oc_tool_definitions")
    using checked = vm.callFunction(definitions, vm.undefined).unwrap()
  })),
))
export const inspectPluginSource = (source: string) =>
  Effect.scoped(acquire(source).pipe(Effect.map(({ id }) => ({ id }))))

const callHost = (
  context: Context,
  method: string,
  input: unknown,
): Effect.Effect<unknown, unknown> => {
  const value = input as { key?: string; value?: unknown }
  switch (method) {
    case "storage.get":
      return context.storage.get(String(value.key))
    case "storage.set":
      return context.storage.set(String(value.key), value.value as never).pipe(Effect.as(null))
    case "storage.remove":
      return context.storage.remove(String(value.key)).pipe(Effect.as(null))
    case "storage.scan":
      return context.storage.scan(input as never)
    default:
      return Effect.fail(new Error(`Unsupported host call: ${method}`))
  }
}
export interface ActivationSignal {
  resolve(): void
  reject(error: unknown): void
}
interface Definition {
  name: string
  description: string
  input: Record<string, unknown>
  output?: Record<string, unknown>
  options?: { namespace?: string; codemode?: boolean }
}
const toolID = (definition: Definition) =>
  definition.options?.namespace
    ? `${definition.options.namespace.replaceAll(".", "_")}_${definition.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : definition.name.replace(/[^a-zA-Z0-9_-]/g, "_")

// Keep package names within provider function-name limits without narrowing the
// durable installation identity or dropping the original guest tool identity.
const packageToolDefinitions = async (stored: StoredPlugin, definitions: Definition[]) => {
  if (!stored.package) return definitions
  const namespace = "pkg_" + stored.id.slice(4, 28)
  return Promise.all(definitions.map(async definition => {
    const original = toolID(definition)
    const room = 64 - namespace.length - 1
    let name = original
    if (name.length > room) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original))
      const suffix = Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2, "0")).join("")
      name = name.slice(0, room - suffix.length - 1) + "_" + suffix
    }
    return { ...definition, name, options: { ...definition.options, namespace } }
  }))
}

export const makeQuickJSPlugin = (stored: StoredPlugin, activation?: ActivationSignal, projectForSession?: (id: string) => Promise<string | undefined>) =>
  define({
    id: stored.id,
    effect: (context) =>
      Effect.gen(function* () {
        const source = stored.serverBundle ?? stored.files["server.ts"] ?? stored.files["server.js"]
        if (source === undefined)
          return yield* Effect.fail(new Error(`Plugin ${stored.id} has no server entrypoint`))
        const loaded = yield* acquire(source)
        const { runtime, vm, plugin } = loaded
        if (loaded.id !== (stored.runtimeID ?? stored.id))
          return yield* Effect.fail(new Error(`Stored id ${stored.id} does not match ${loaded.id}`))
        const allowed = (sessionID: string) => Effect.gen(function* () {
          if (stored.package?.scope !== "project") return true
          const project = projectForSession ? yield* attempt("Resolve plugin project", () => projectForSession(sessionID)) : undefined
          if (project !== undefined) return project === stored.package.projectID
          const session = yield* context.session.get({ sessionID: sessionID as never })
          return session.location.directory === stored.package.projectID
        })
        let hostDefinitions: Definition[] = []
        if (stored.package?.scope === "project") yield* context.session.hook("context", event => allowed(event.sessionID).pipe(Effect.map(ok => {
          if (!ok) for (const definition of hostDefinitions) delete event.tools[toolID(definition)]
        })).pipe(Effect.orDie))
        const serial = yield* Semaphore.make(1)
        let activeToolContext: Tool.Context | undefined
        // Foreign guest callbacks enter this scoped fiber set; all host calls stop before VM disposal.
        const fork = yield* FiberSet.makeRuntime<never>()
        yield* evaluate("Install QuickJS host bridge", () => {
          using hostCall = vm.newFunction("__oc_host_call", (methodHandle, inputHandle) => {
            const method = vm.getString(methodHandle)
            const input: unknown = JSON.parse(vm.getString(inputHandle))
            const deferred = vm.newPromise()
            const operation = method === "tool.progress"
              ? activeToolContext ? activeToolContext.progress(input as Tool.Metadata).pipe(Effect.as(null)) : Effect.fail(new Error("No active tool for progress update"))
              : callHost(context, method, input)
            fork(
              operation.pipe(
                Effect.matchCauseEffect({
                  onSuccess: (result) =>
                    Effect.sync(() => {
                      if (!vm.alive) return
                      using value = vm.newString(JSON.stringify({ value: result }))
                      deferred.resolve(value)
                    }),
                  onFailure: (cause) =>
                    Effect.sync(() => {
                      if (!vm.alive) return
                      using value = vm.newError(Cause.pretty(cause))
                      deferred.reject(value)
                    }),
                }),
              ),
            )
            return deferred.handle
          })
          vm.setProp(vm.global, "__oc_host_call", hostCall)
        })
        yield* guestCall("Set up guest plugin", async (signal) => {
          using setup = vm.getProp(plugin, "setup")
          using guestContext = vm.getProp(vm.global, "__oc_context")
          armRuntime(runtime)
          using result = vm.callFunction(setup, plugin, guestContext).unwrap()
          using settled = await waitForPromise(vm, runtime, result, signal)
        })
        const definitions = yield* evaluate("Read guest tools", () => {
          using fn = vm.getProp(vm.global, "__oc_tool_definitions")
          using result = vm.callFunction(fn, vm.undefined).unwrap()
          return JSON.parse(vm.getString(result)) as Definition[]
        })
        hostDefinitions = yield* attempt("Name package tools", () => packageToolDefinitions(stored, definitions))
        yield* context.tool.transform((tools) => {
          for (const [index, definition] of definitions.entries()) {
            const id = toolID(definition)
            const hostDefinition = hostDefinitions[index]!
            if (tools.get(toolID(hostDefinition))) throw new Error(`Plugin tool collides with existing tool: ${id}`)
            tools.add({
              ...hostDefinition,
              execute: (input, toolContext) =>
                allowed(toolContext.sessionID).pipe(Effect.flatMap(ok => ok ? serial
                  .withPermit(
                    guestCall("Execute guest tool", async (signal) => {
                      activeToolContext = toolContext
                      try {
                      using invoke = vm.getProp(vm.global, "__oc_invoke")
                      using idHandle = vm.newString(id)
                      using inputHandle = vm.newString(JSON.stringify(input))
                      using contextHandle = vm.newString(
                        JSON.stringify({
                          sessionID: toolContext.sessionID,
                          agent: toolContext.agent,
                          messageID: toolContext.messageID,
                          id: toolContext.id,
                        }),
                      )
                      using parse = unwrap(vm, vm.evalCode("JSON.parse", "bridge-call.js"))
                      using guestInput = vm.callFunction(parse, vm.undefined, inputHandle).unwrap()
                      using guestToolContext = vm
                        .callFunction(parse, vm.undefined, contextHandle)
                        .unwrap()
                      armRuntime(runtime)
                      using call = vm
                        .callFunction(invoke, vm.undefined, idHandle, guestInput, guestToolContext)
                        .unwrap()
                      using result = await waitForPromise(vm, runtime, call, signal)
                      return vm.dump(result) as Tool.Result
                      } finally { activeToolContext = undefined }
                    }),
                  )
                  : Effect.fail(new Error("Plugin is not enabled for this project"))),
                    Effect.mapError((error) => Tool.Error.make({ message: String(error) }))),
            })
          }
        })
        yield* context.tool.reload()
        yield* Effect.sync(() => activation?.resolve())
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => activation?.reject(Cause.squash(cause))).pipe(
            Effect.andThen(Effect.logError(`Failed to activate plugin ${stored.id}`, cause)),
          ),
        ),
      ),
  })
