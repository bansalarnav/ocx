import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { watch } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { NodeServices } from "../packages/client/node_modules/@effect/platform-node/dist/index.js"
import { Files } from "../packages/client/src/files"
import { ocxLoaderSource } from "../packages/client/src/approval-plugin"
import { Plugins, pluginsLayer } from "../packages/client/src/plugins"
import { Transport } from "../packages/client/src/transport"
import { parseArguments } from "../packages/client/src/options"
import type { TuiPluginManifest, TuiPluginManifestEntry } from "../packages/protocol/src/plugins"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const exec = promisify(execFile)
const entry = (id: string, source: string): TuiPluginManifestEntry => ({
  id, version: hash(source), sha256: hash(source), entrypoint: "tui.tsx", contentType: "application/typescript",
  opencode: { minimumVersion: "2.3.0" }, permissions: { serverOrigins: ["self"], filesystem: false, process: false, network: false }, notes: "test",
})

test("in-app initial approval adds a discoverable stable plugin, then updates and removes it without static config pinning", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocx-plugin-reload-"))
  const custom = join(root, "custom-config")
  await mkdir(join(custom, "themes"), { recursive: true })
  await writeFile(join(custom, "themes", "mine.json"), '{"name":"mine"}')
  const userConfig = JSON.stringify({ theme: { name: "mine" }, plugins: ["./user-plugin", { package: "../sibling-plugin", options: { unchanged: true } }] })
  await writeFile(join(custom, "cli.json"), userConfig)
  const firstSource = 'export default { id: "generated-demo", setup() { return () => {} }, version: "first" }\n'
  const secondSource = firstSource.replace('"first"', '"second"')
  let current: TuiPluginManifest = { schemaVersion: 1, plugins: [entry("generated-demo", firstSource)] }
  const sources = new Map([[hash(firstSource), firstSource], [hash(secondSource), secondSource]])
  const options = parseArguments(["--server", "https://plugins.test", "--data-dir", root], {})
  const transport = Layer.succeed(Transport, { fetch: request => Effect.sync(() => {
    const url = new URL(request.url)
    if (url.pathname === "/api/generated-plugins/tui") return Response.json(current)
    const source = sources.get(url.pathname.split("/").at(-1)!)
    return source === undefined ? new Response("missing", { status: 404 }) : new Response(source)
  }) })
  const services = pluginsLayer(options, { XDG_CONFIG_HOME: join(root, "empty"), OPENCODE_CONFIG_DIR: custom }, { deferInitialApprovals: true }).pipe(
    Layer.provide(Files.layer), Layer.provide(transport), Layer.provide(NodeServices.layer),
  )
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const plugins = yield* Plugins
      const client = yield* plugins.prepare
      yield* Effect.promise(async () => {
        const generated = join(client.configDir, "plugins", "generated-demo")
        expect(await readdir(join(client.configDir, "plugins"))).not.toContain("generated-demo")
        const immutableConfig = client.cliContent!
        expect(JSON.parse(immutableConfig).plugins).toContain(join(custom, "user-plugin"))
        expect(JSON.parse(immutableConfig).plugins).toContainEqual({ package: join(root, "sibling-plugin"), options: { unchanged: true } })
        expect(await readFile(join(client.configDir, "themes", "mine.json"), "utf8")).toBe('{"name":"mine"}')
        expect(await readFile(join(custom, "cli.json"), "utf8")).toBe(userConfig)
        expect(JSON.parse(immutableConfig).plugins).not.toContain(generated)
        expect(await readFile(client.tuiConfig, "utf8")).not.toContain(generated)
        const notifications: string[] = []
        const watcher = watch(join(client.configDir, "plugins"), (_event, name) => { if (name) notifications.push(String(name)) })
        const prompts: string[] = []
        // Exercise the same approval plugin source that stable OpenCode loads.
        // Use its actual pinned Plugin.define module via an absolute file URL.
        const definitionURL = new URL("../packages/client/node_modules/@opencode/plugin/dist/tui/index.js", import.meta.url).href
        const approvalPath = join(client.controlDir, "approval-test.mjs")
        await writeFile(approvalPath, ocxLoaderSource.replace("@opencode/plugin/tui", definitionURL))
        const module = await import(approvalPath)
        const original = process.env.OCX_CONTROL_DIR
        process.env.OCX_CONTROL_DIR = client.controlDir
        const cleanup = await module.default.setup({ ui: { dialog: { confirm: async (input: { message: string }) => { prompts.push(input.message); return true } }, toast: { show() {} } } })
        if (original === undefined) delete process.env.OCX_CONTROL_DIR
        else process.env.OCX_CONTROL_DIR = original
        try {
          await Effect.runPromise(plugins.refresh(client))
          expect(prompts).toHaveLength(1)
          expect(prompts[0]).toContain(hash(firstSource))
          expect(await readFile(join(generated, "tui.tsx"), "utf8")).toBe(firstSource)
          // Resolve through the stable host's actual Node package resolver.
          // These fixtures are bundled JS in a .tsx container, so the test
          // loader only supplies the module format, not a JSX transformer.
          const inspect = async () => {
            const hostURL = new URL("../packages/client/node_modules/@opencode/plugin/dist/host.js", import.meta.url).href
            const inspector = join(client.controlDir, "inspect-plugin.mjs")
            await writeFile(inspector, `import {Host} from ${JSON.stringify(hostURL)}; import {registerHooks} from "node:module"; import {readFileSync} from "node:fs"; const target=Host.resolve({directory:process.argv[2]}).tui; registerHooks({load(url,context,next){return url.endsWith(".tsx")?{format:"module",source:readFileSync(new URL(url),"utf8"),shortCircuit:true}:next(url,context)}}); const loaded=await Host.load(target); console.log(JSON.stringify({target,id:loaded.default.id,version:loaded.default.version}))`)
            const result = await exec("node", [inspector, generated])
            return JSON.parse(result.stdout)
          }
          const loaded = await inspect()
          expect(fileURLToPath(loaded.target)).toBe(join(generated, "tui.tsx"))
          expect(loaded.id).toBe("generated-demo")
          expect(loaded.version).toBe("first")
          expect(notifications).toContain("generated-demo")
          current = { schemaVersion: 1, plugins: [entry("generated-demo", secondSource)] }
          await Effect.runPromise(plugins.refresh(client))
          expect(prompts).toHaveLength(2)
          expect(await readFile(join(generated, "tui.tsx"), "utf8")).toBe(secondSource)
          expect((await inspect()).version).toBe("second")
          current = { schemaVersion: 1, plugins: [] }
          await Effect.runPromise(plugins.refresh(client))
          expect(await readdir(join(client.configDir, "plugins"))).not.toContain("generated-demo")
          expect(client.cliContent).toBe(immutableConfig)
          expect(await readFile(client.tuiConfig, "utf8")).not.toContain(generated)
          expect(notifications.filter(name => name === "generated-demo").length).toBeGreaterThanOrEqual(2)
        } finally { await cleanup?.(); watcher.close() }
      })
    })).pipe(Effect.provide(services)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)
