import { expect, test } from "bun:test"
import { assertPortableBundle } from "../packages/server/src/plugin-manager/capabilities"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { installPackage, parsePackage } from "../packages/server/src/plugin-manager/package-installer"
import { makeCloudPluginsHandler } from "../packages/server/src/plugin-manager/http"
import { makePluginStore } from "../packages/server/src/plugin-manager/store"
import { makeTuiRegistryHandler } from "../packages/server/src/tui-registry"
import { makeQuickJSPlugin, validatePluginSetup } from "../packages/server/src/plugin-manager/quickjs"

const storage = () => {
  const values = new Map<string, unknown>()
  const api = {
    async get(key: string | string[]) { return Array.isArray(key) ? new Map(key.filter(k => values.has(k)).map(k => [k, values.get(k)])) : values.get(key) },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)) },
    async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) values.delete(k) },
    async list(options: {prefix?: string; start?: string; end?: string} = {}) { return new Map([...values].filter(([k]) => (!options.prefix || k.startsWith(options.prefix)) && (!options.start || k >= options.start) && (!options.end || k < options.end))) },
    async transaction<T>(run: (tx: unknown) => Promise<T>) { return run(api) },
  }
  return api as unknown as DurableObjectStorage
}

test("installs an ordinary package and dependencies, persists bundles, manages state and filters TUI by project", async () => {
  const worker = spawn("node", ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "test/fixtures/cloud-plugins.wrangler.json", "--port", "18943"], { stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  worker.stdout.on("data", d => { logs += d }); worker.stderr.on("data", d => { logs += d })
  try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { ready = (await fetch("http://localhost:18943/ready")).ok; if (ready) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (!ready) throw new Error(logs)
  const durable = storage()
  const store = makePluginStore(durable)
  const result = await fetch("http://localhost:18943/install")
  const body = await result.json()
  if (!result.ok) throw new Error(JSON.stringify(body))
  const plugin = body as Awaited<ReturnType<typeof installPackage>>
  expect(plugin.package?.version).toBe("1.2.3")
  expect(plugin.runtimeID).toBe("ordinary")
  expect(plugin.serverBundle).toContain("42")
  expect(plugin.tuiBundle).toContain(plugin.id)
  const registered: any[] = []
  let sessionHook: any
  const pluginStorage = new Map<string, unknown>()
  const context: any = {
    storage: { set: (key: string, value: unknown) => Effect.sync(() => { pluginStorage.set(key,value) }), get: (key: string) => Effect.sync(() => pluginStorage.get(key)) },
    tool: { transform: (f: any) => Effect.sync(() => f({get: () => undefined, add: (tool: any) => registered.push(tool)})), reload: () => Effect.void },
    session: { hook: (_: string, callback: any) => Effect.sync(() => { sessionHook = callback }), get: () => Effect.succeed({location:{directory:"other"}}) },
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* makeQuickJSPlugin(plugin, undefined, async id => id === "yes" ? "repo-one" : "repo-two").effect(context)
    const tool = registered[0]!
    expect(tool.options.namespace).toBe("pkg_" + plugin.id.slice(4, 28))
    const success = yield* tool.execute({}, {sessionID:"yes"})
    expect(success.content).toBe("42")
    const denied = yield* Effect.result(tool.execute({}, {sessionID:"no"}))
    expect(denied._tag).toBe("Failure")
    const tools = { [tool.options.namespace + "_" + tool.name]: tool }
    yield* sessionHook({sessionID:"no",tools})
    expect(Object.keys(tools)).toHaveLength(0)
  })))
  await Effect.runPromise(store.put(plugin))
  // Recreate all service objects from the durable storage, without another registry fetch.
  const restored = makePluginStore(durable)
  const tui = makeTuiRegistryHandler(restored)
  const request = (path: string, method = "GET") => new Request(`https://ocx.test${path}`, { method })
  expect((await (await Effect.runPromise(tui(request("/api/generated-plugins/tui"))))!.json()).plugins).toHaveLength(0)
  expect((await (await Effect.runPromise(tui(request("/api/generated-plugins/tui?projectID=repo-one"))))!.json()).plugins).toHaveLength(1)
  let changes = 0
  const handler = makeCloudPluginsHandler(restored, undefined, Effect.sync(() => { changes++ }))
  const base = `/api/ocx/plugins/${plugin.id}`
  expect((await Effect.runPromise(handler(request(base + "/disable", "POST"))))!.status).toBe(200)
  expect((await Effect.runPromise(restored.get(plugin.id)))!.enabled).toBe(false)
  expect((await Effect.runPromise(handler(request(base + "/enable", "POST"))))!.status).toBe(200)
  expect((await Effect.runPromise(handler(request(base, "DELETE"))))!.status).toBe(200)
  expect(await Effect.runPromise(restored.get(plugin.id))).toBeUndefined()
  expect(changes).toBe(3)
  } finally { worker.kill("SIGTERM") }
}, 90_000)

test("validates setup without exposing remote side effects and rejects Effect contract", async () => {
  await expect(Effect.runPromise(validatePluginSetup(`export default {id:'bad',setup(ctx){return ctx.shell.run('curl bad')}}`))).rejects.toThrow()
  await expect(Effect.runPromise(validatePluginSetup(`export default {id:'bad',effect(){}}`))).rejects.toThrow("Effect plugins are not supported")
  await expect(Effect.runPromise(validatePluginSetup(`export default {id:'bad',setup(){return fetch('https://bad.test')}}`))).rejects.toThrow()
  await expect(Effect.runPromise(validatePluginSetup(`export default {id:'bad',setup(ctx){return ctx.tool.reload()}}`))).rejects.toThrow("tool.reload")
  await Effect.runPromise(validatePluginSetup(`export default {id:'storage',async setup(ctx){
    await ctx.storage.set('key', 'value');
    if (await ctx.storage.get('missing') !== undefined) throw new Error('missing must be undefined');
    if ((await ctx.storage.scan({prefix:''})).entries.length) throw new Error('validation must use empty storage');
  }}`))
  expect(() => parsePackage("https://bad.test/plugin.tgz")).toThrow()
})

test("real npm registry fetch and resolution", async () => {
  if (!process.env.OCX_TEST_NPM) return
  const { InMemoryFileSystem, installDependencies } = await import("../packages/server/node_modules/@cloudflare/worker-bundler/dist/index.js")
  const fs = new InMemoryFileSystem({ "package.json": JSON.stringify({dependencies:{"is-number":"7.0.0"}}) })
  const result = await installDependencies(fs)
  expect(result.warnings).toEqual([])
  expect(JSON.parse(fs.read("node_modules/is-number/package.json")!).version).toBe("7.0.0")
}, 60_000)

test("rejects lazy unsupported server capabilities and unresolved TUI imports before enabling", () => {
  for (const source of [
    `export default {id:'x',setup(c){c.tool.transform(t=>t.add({execute(){return import('node:fs')}}))}}`,
    `export default {id:'x',setup(c){c.tool.transform(t=>t.add({execute(){return c.shell.run('ls')}}))}}`,
    `export default {id:'x',setup(c){c.tool.transform(t=>t.add({execute(){return fetch('https://bad.test')}}))}}`,
    `export default {id:'x',setup(c){c.tool.transform(t=>t.add({execute(i,ctx){return ctx.signal.aborted}}))}}`,
    `export default {id:'x',setup(c){c.tool.transform(t=>t.add({execute(){return c.tool.reload()}}))}}`,
  ]) expect(() => assertPortableBundle(source, "server")).toThrow("Unsupported")
  expect(() => assertPortableBundle(`import fs from "node:fs"`, "tui")).toThrow("Unsupported")
  expect(() => assertPortableBundle(`import {Plugin} from "@opencode/plugin/tui"`, "tui")).not.toThrow()
})

test("package tools keep bounded names, publish progress, and reject post-setup mutations explicitly", async () => {
  const name = "search_codebase_and_report_all_matching_locations_with_diagnostics"
  const source = `export default {id:'ordinary',setup(ctx){ ctx.tool.transform(tools => {
    tools.add({name:${JSON.stringify(name)},description:'Long tool',input:{type:'object'},options:{namespace:'long.namespace'},async execute(i,context){await context.progress({step:'searching'});return {content:'done'}}});
    tools.add({name:'change',description:'Unsupported mutation',input:{type:'object'},async execute(){await ctx.tool.transform(t=>t.remove('change'));return {content:'changed'}}});
  })}}`
  const registered: any[] = [], updates: unknown[] = []
  const context: any = {
    storage: {}, session: {},
    tool: { transform: (f: any) => Effect.sync(() => f({get: () => undefined,add: (t: any) => registered.push(t)})),reload: () => Effect.void },
  }
  const plugin = {
    id:'pkg-' + 'a'.repeat(48), runtimeID:'ordinary',files:{},serverBundle:source,enabled:true,updatedAt:0,
    package:{name:'test-plugin',version:'1.0.0',requested:'test-plugin',scope:'cloud' as const,runtime:'quickjs-promise' as const},
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* makeQuickJSPlugin(plugin).effect(context)
    expect(registered).toHaveLength(2)
    const tool = registered[0]
    expect(`${tool.options.namespace}_${tool.name}`.length).toBeLessThanOrEqual(64)
    expect(tool.name).toStartWith("long_namespace_")
    const result = yield* tool.execute({}, {sessionID:'yes',progress: (update: unknown) => Effect.sync(() => { updates.push(update) })})
    expect(result.content).toBe('done')
    expect(updates).toEqual([{step:'searching'}])
    const change = yield* Effect.result(registered[1].execute({}, {sessionID:'yes'}))
    expect(change._tag).toBe('Failure')
    if (change._tag === 'Failure') expect(String(change.failure)).toContain('changing tools after setup')
  })))
})
