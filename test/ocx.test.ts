import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArguments, refreshPlugins, syncPlugins } from "../bin/ocx"
import { ocxLoaderSource } from "../bin/ocx-loader-source"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "ocx-test-"))
  temporaryDirectories.push(path)
  return path
}

describe("ocx", () => {
  test("emits a syntactically valid local hot-loader plugin", () => {
    const transpiler = new Bun.Transpiler({ loader: "tsx", target: "bun" })
    expect(() => transpiler.transformSync(ocxLoaderSource)).not.toThrow()
  })

  test("the local loader replaces a running plugin and calls its cleanup", async () => {
    const root = await mkdtemp(join(resolve("."), ".ocx-loader-test-"))
    temporaryDirectories.push(root)
    const control = join(root, "control")
    await mkdir(control)
    const loaderPath = join(root, "loader.ts")
    const firstPath = join(root, "first.ts")
    const secondPath = join(root, "second.ts")
    await writeFile(loaderPath, ocxLoaderSource)
    await writeFile(firstPath, `export default { id: "demo", setup() {
      globalThis.__ocxLoaderTest = "first"
      return () => { globalThis.__ocxLoaderCleanup = true }
    } }`)
    await writeFile(secondPath, `export default { id: "demo", setup() {
      globalThis.__ocxLoaderTest = "second"
    } }`)
    await writeFile(join(control, "active.json"), JSON.stringify({
      generation: "one",
      plugins: [{ id: "demo", sha256: "one", path: firstPath }],
    }))
    const previousControl = process.env.OCX_CONTROL_DIR
    process.env.OCX_CONTROL_DIR = control
    const globalState = globalThis as typeof globalThis & {
      __ocxLoaderTest?: string
      __ocxLoaderCleanup?: boolean
    }
    delete globalState.__ocxLoaderTest
    delete globalState.__ocxLoaderCleanup
    try {
      const definition = (await import(`${loaderPath}?test=${crypto.randomUUID()}`)).default
      const cleanup = await definition.setup({
        ui: {
          dialog: { confirm: async () => true },
          toast: { show: () => undefined },
        },
      })
      for (let attempt = 0; attempt < 20 && globalState.__ocxLoaderTest !== "first"; attempt++) {
        await Bun.sleep(25)
      }
      expect(globalState.__ocxLoaderTest).toBe("first")
      await writeFile(join(control, "active.json"), JSON.stringify({
        generation: "two",
        plugins: [{ id: "demo", sha256: "two", path: secondPath }],
      }))
      for (let attempt = 0; attempt < 20 && globalState.__ocxLoaderTest !== "second"; attempt++) {
        await Bun.sleep(25)
      }
      expect(globalState.__ocxLoaderTest).toBe("second")
      expect(globalState.__ocxLoaderCleanup).toBe(true)
      await cleanup?.()
    } finally {
      if (previousControl === undefined) delete process.env.OCX_CONTROL_DIR
      else process.env.OCX_CONTROL_DIR = previousControl
      delete globalState.__ocxLoaderTest
      delete globalState.__ocxLoaderCleanup
    }
  })

  test("normalizes a server origin and keeps child arguments separate", () => {
    const options = parseArguments([
      "--binary", "/opt/opencode2",
      "https://example.test",
      "--", "--log-level", "DEBUG",
    ], {})
    expect(options.origin).toBe("https://example.test")
    expect(options.binary).toBe("/opt/opencode2")
    expect(options.childArgs).toEqual(["--log-level", "DEBUG"])
  })

  test("downloads, verifies, approves, caches, and configures a plugin", async () => {
    const root = await temporaryDirectory()
    let source = "import { Plugin } from '@opencode-ai/plugin/tui'\nexport default Plugin.define({ id: 'demo', setup() {} })\n"
    let hash = createHash("sha256").update(source).digest("hex")
    let authorization: string | undefined
    const server = createServer((request, response) => {
      authorization = request.headers.authorization
      if (request.url === "/api/generated-plugins/tui") {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({
          schemaVersion: 1,
          plugins: [{
            id: "demo",
            version: hash,
            sha256: hash,
            entrypoint: "tui.tsx",
            contentType: "application/typescript",
            opencode: { minimumVersion: "0.0.0-beta-18371" },
            permissions: {
              serverOrigins: ["self"],
              filesystem: false,
              process: false,
              network: false,
            },
            notes: "test plugin",
          }],
        }))
        return
      }
      if (request.url === `/api/generated-plugins/tui/demo/${hash}`) {
        response.end(source)
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing test server address")
      const configHome = join(root, "config")
      await mkdir(join(configHome, "opencode"), { recursive: true })
      await writeFile(join(configHome, "opencode", "tui.jsonc"), `{
        // This comment verifies JSONC input.
        "theme": "smoke",
        "plugin": ["existing-plugin"]
      }`)
      const options = parseArguments([
        "--yes",
        "--data-dir", join(root, "data"),
        `http://127.0.0.1:${address.port}`,
      ], {})
      const result = await syncPlugins(options, {
        XDG_CONFIG_HOME: configHome,
        OPENCODE_PASSWORD: "secret",
      })
      expect(result.installed).toHaveLength(1)
      expect(await readFile(result.installed[0]!, "utf8")).toBe(source)
      const config = JSON.parse(await readFile(result.tuiConfig, "utf8"))
      expect(config.theme).toBe("smoke")
      expect(config.plugin).toEqual([
        "existing-plugin",
        join(result.configDir, "ocx-hot-loader.ts"),
      ])
      const active = JSON.parse(await readFile(join(result.controlDir, "active.json"), "utf8"))
      expect(active.plugins).toEqual([{ id: "demo", sha256: hash, path: result.installed[0] }])
      expect(authorization).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)

      const approvals = JSON.parse(await readFile(join(
        root,
        "data",
        "servers",
        createHash("sha256").update(options.origin).digest("hex").slice(0, 32),
        "approvals.json",
      ), "utf8"))
      expect(approvals.plugins.demo.sha256).toBe(hash)

      source = source.replace("setup() {}", "setup(ctx) { return ctx.ui.slot({ append: 'home.footer', render: () => <text>live</text> }) }")
      hash = createHash("sha256").update(source).digest("hex")
      await refreshPlugins(options, result, new AbortController().signal, {
        XDG_CONFIG_HOME: configHome,
        OPENCODE_PASSWORD: "secret",
      })
      const refreshed = JSON.parse(await readFile(join(result.controlDir, "active.json"), "utf8"))
      expect(refreshed.plugins[0].sha256).toBe(hash)
      expect(await readFile(refreshed.plugins[0].path, "utf8")).toBe(source)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
