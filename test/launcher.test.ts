import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runLauncher, type TuiLaunch } from "../packages/client/src/launcher"
import { discoverLocalServer, startLocalServer } from "../packages/client/src/local-server"
import { createLocalTuiConfig } from "../packages/client/src/local-config"
import { parseArguments } from "../packages/client/src/options"
import type { RemoteLaunch } from "../packages/client/src/remote"
import type { ManagedProcess, ProcessExit } from "../packages/device/src/process"

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), "ocx-launcher-test-")); temporary.push(path); return path }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

describe("owned local OpenCode and TUI switches", () => {
  test("local startup injects the builtin plugin, switches both ways, and keeps one backend until final exit", async () => {
    const directory = await root()
    const options = parseArguments(["--data-dir", directory, "--", "--session", "ses_original"], {})
    const closed = deferred<ProcessExit>()
    let backendStarts = 0, backendStops = 0, bridgeStops = 0
    let switchTo!: (launch: RemoteLaunch) => void | Promise<void>
    let configDir = ""
    const attached: string[] = []
    const localTui = async (input: TuiLaunch) => {
      expect(backendStops).toBe(0)
      expect(input.env.OCX_MODE).toBe("local")
      expect(input.env.OCX_CONTROL_ORIGIN).toBe("http://127.0.0.1:4567")
      expect(input.env.OCX_CONTROL_TOKEN).toBe("control-token")
      expect(input.target.server).toBe("http://127.0.0.1:5678")
      configDir = input.config.configDir
      const plugin = await readFile(join(configDir, "plugins", "ocx-workspaces", "tui.ts"), "utf8")
      expect(plugin).toContain("workspace-tui.ts")
      attached.push(input.target.sessionID ?? "initial")
      if (attached.length === 1) {
        expect(input.childArgs).toEqual(["--session", "ses_original"])
        const stopped = new Promise<number>(resolve => input.signal.addEventListener("abort", () => resolve(143), { once: true }))
        await switchTo({ server: "https://remote.test", password: "remote-secret", sessionID: "ses_remote", binary: options.binary })
        return stopped
      }
      expect(input.target.sessionID).toBe("ses_back")
      expect(input.childArgs).toEqual([])
      return 0
    }
    const result = await runLauncher(options, new AbortController().signal, undefined, {
      localServer: async () => {
        backendStarts++
        return { server: "http://127.0.0.1:5678", password: "local-secret", closed: closed.promise, stop: async () => { backendStops++ } }
      },
      localConfig: dataRoot => createLocalTuiConfig(dataRoot, { XDG_CONFIG_HOME: join(directory, "empty-config") }),
      bridge: async input => {
        expect(input.local).toEqual({ server: "http://127.0.0.1:5678", password: "local-secret" })
        switchTo = input.onSwitch
        return { origin: "http://127.0.0.1:4567", token: "control-token", stop: async () => { bridgeStops++ } }
      },
      localTui,
      remoteTui: async input => {
        expect(backendStarts).toBe(1); expect(backendStops).toBe(0)
        expect(input.env.OCX_MODE).toBe("remote")
        expect(input.target.sessionID).toBe("ses_remote")
        attached.push(input.target.sessionID!)
        const stopped = new Promise<number>(resolve => input.signal.addEventListener("abort", () => resolve(143), { once: true }))
        await switchTo({ local: true, server: "ignored", sessionID: "ses_back", binary: options.binary, directory })
        return stopped
      },
    })
    expect(result).toBe(0)
    expect(attached).toEqual(["initial", "ses_remote", "ses_back"])
    expect(backendStarts).toBe(1); expect(backendStops).toBe(1); expect(bridgeStops).toBe(1)
    await expect(readFile(join(configDir, "cli.json"))).rejects.toThrow()
  })

  test("interruption cleans the UI, bridge, local backend and generated config", async () => {
    const directory = await root()
    const controller = new AbortController()
    const started = deferred<void>()
    const stopped: string[] = []
    const running = runLauncher(parseArguments(["--data-dir", directory], {}), controller.signal, undefined, {
      localServer: async () => ({ server: "http://127.0.0.1:5678", password: "secret", closed: new Promise(() => {}), stop: async () => { stopped.push("backend") } }),
      localConfig: async () => ({ configDir: directory, tuiConfig: join(directory, "tui.json"), stop: async () => { stopped.push("config") } }),
      bridge: async () => ({ origin: "http://127.0.0.1:4567", token: "token", stop: async () => { stopped.push("bridge") } }),
      localTui: input => new Promise(resolve => {
        input.signal.addEventListener("abort", () => { stopped.push("tui"); resolve(143) }, { once: true })
        started.resolve()
      }),
    })
    await started.promise
    controller.abort(new Error("test interrupt"))
    await expect(running).rejects.toThrow("test interrupt")
    expect(stopped.sort()).toEqual(["backend", "bridge", "config", "tui"])
  })

  test("unexpected backend exit interrupts its attached TUI and releases owned resources", async () => {
    const directory = await root()
    const closed = deferred<ProcessExit>()
    const stopped: string[] = []
    const running = runLauncher(parseArguments(["--data-dir", directory], {}), new AbortController().signal, undefined, {
      localServer: async () => ({ server: "http://127.0.0.1:5678", password: "secret", closed: closed.promise, stop: async () => { stopped.push("backend") } }),
      localConfig: async () => ({ configDir: directory, tuiConfig: join(directory, "tui.json"), stop: async () => { stopped.push("config") } }),
      bridge: async () => ({ origin: "http://127.0.0.1:4567", token: "token", stop: async () => { stopped.push("bridge") } }),
      localTui: input => new Promise(resolve => {
        input.signal.addEventListener("abort", () => { stopped.push("tui"); resolve(1) }, { once: true })
        closed.resolve({ code: 1, signal: null })
      }),
    })
    await expect(running).rejects.toThrow("backend stopped unexpectedly")
    expect(stopped.sort()).toEqual(["backend", "bridge", "config", "tui"])
  })

  test("local TUI config copies JSONC settings and never edits the user's file", async () => {
    const directory = await root()
    const original = join(directory, "config", "opencode")
    await mkdir(original, { recursive: true })
    const config = '{ // user settings\n "theme":"custom", "keybinds":{"leader":"ctrl+x"},\n}\n'
    await writeFile(join(original, "tui.jsonc"), config)
    const generated = await createLocalTuiConfig(join(directory, "data"), { XDG_CONFIG_HOME: join(directory, "config") })
    expect(JSON.parse(await readFile(generated.tuiConfig, "utf8"))).toEqual({ theme: "custom", keybinds: { leader: "ctrl+x" }, plugins: [join(generated.configDir, "plugins", "ocx-workspaces")] })
    expect(await readFile(join(original, "tui.jsonc"), "utf8")).toBe(config)
    expect(await readdir(join(generated.configDir, "plugins"))).toEqual(["ocx-workspaces"])
    await generated.stop()
    expect(await readFile(join(original, "tui.jsonc"), "utf8")).toBe(config)
  })

  test("custom config directories preserve theme assets and existing plugins without writing through to them", async () => {
    const directory = await root()
    const global = join(directory, "global", "opencode"), custom = join(directory, "custom")
    await mkdir(join(global, "plugins", "global-plugin"), { recursive: true })
    await writeFile(join(global, "plugins", "global-plugin", "tui.ts"), "export default {}\n")
    await mkdir(join(custom, "themes"), { recursive: true })
    await writeFile(join(custom, "themes", "mine.json"), '{"theme":"mine"}')
    await mkdir(join(custom, "plugins", "local-plugin"), { recursive: true })
    await writeFile(join(custom, "plugins", "local-plugin", "tui.ts"), "export default {}\n")
    await writeFile(join(custom, "cli.json"), '{"theme":{"name":"mine"},"plugins":["../shared-plugin"]}\n')
    const generated = await createLocalTuiConfig(join(directory, "data"), { XDG_CONFIG_HOME: join(directory, "global"), OPENCODE_CONFIG_DIR: custom })
    expect(JSON.parse(await readFile(generated.tuiConfig, "utf8"))).toEqual({ theme: { name: "mine" }, plugins: [join(directory, "shared-plugin"), join(generated.configDir, "plugins", "ocx-workspaces")] })
    expect(await readFile(join(generated.configDir, "themes", "mine.json"), "utf8")).toBe('{"theme":"mine"}')
    expect((await readdir(join(generated.configDir, "plugins"))).sort()).toEqual(["global-plugin", "local-plugin", "ocx-workspaces"])
    expect(await readdir(join(custom, "plugins"))).toEqual(["local-plugin"])
    await generated.stop()
    expect(await readFile(join(custom, "themes", "mine.json"), "utf8")).toBe('{"theme":"mine"}')
    expect(await readFile(join(custom, "plugins", "local-plugin", "tui.ts"), "utf8")).toBe("export default {}\n")
  })

  test("backend startup uses a random loopback port and fresh auth while retaining ordinary config", async () => {
    let invocation: any
    let auth = "", stops = 0
    const process = { child: { exitCode: null, signalCode: null }, closed: new Promise<ProcessExit>(() => {}), output: () => "" } as ManagedProcess
    const owned = await startLocalServer({ binary: "custom-opencode", signal: new AbortController().signal,
      env: { OPENCODE_PASSWORD: "old-secret", OPENCODE_CONFIG_DIR: "/original/config", OCX_CONTROL_TOKEN: "never-pass" },
    }, {
      discover: async () => undefined,
      port: async () => 45678,
      start: (...args) => { invocation = args; return process },
      stop: async () => { stops++ },
      fetch: (async (_url, input) => { auth = String((input?.headers as any).authorization); return Response.json({ version: "2.3.0" }) }) as typeof fetch,
    })
    expect(invocation[0]).toBe("custom-opencode")
    expect(invocation[1]).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "45678"])
    expect(invocation[3].OPENCODE_CONFIG_DIR).toBe("/original/config")
    expect(invocation[3].OCX_CONTROL_TOKEN).toBeUndefined()
    expect(owned.password).not.toBe("old-secret")
    expect(auth).toBe(`Basic ${Buffer.from(`opencode:${owned.password}`).toString("base64")}`)
    expect(owned.server).toBe("http://127.0.0.1:45678")
    await owned.stop(); expect(stops).toBe(1)
  })

  test("reuses an authenticated registered daemon without spawning or stopping the user's process", async () => {
    const directory = await root()
    const state = join(directory, "opencode")
    await mkdir(state)
    await writeFile(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:43333", pid: process.pid, password: "registered-secret", version: "2.3.0" }))
    const server = await startLocalServer({ binary: "must-not-spawn", signal: new AbortController().signal, env: { XDG_STATE_HOME: directory } }, {
      start: () => { throw new Error("must not spawn a second executor") },
      stop: async () => { throw new Error("must not stop the user's service") },
      fetch: (async (url, input) => {
        expect(String(url)).toBe("http://127.0.0.1:43333/api/info")
        expect((input?.headers as any).authorization).toBe(`Basic ${Buffer.from("opencode:registered-secret").toString("base64")}`)
        return Response.json({ version: "2.3.0", pid: process.pid })
      }) as typeof fetch,
    })
    expect(server.server).toBe("http://127.0.0.1:43333")
    expect(server.password).toBe("registered-secret")
    await server.stop()
    expect(await readFile(join(state, "service.json"), "utf8")).toContain("registered-secret")
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  })

  test("a live registered process with failed authentication blocks a second server", async () => {
    const directory = await root()
    await mkdir(join(directory, "opencode"))
    await writeFile(join(directory, "opencode", "service.json"), JSON.stringify({ url: "http://127.0.0.1:43333", pid: process.pid, password: "secret" }))
    await expect(discoverLocalServer({ XDG_STATE_HOME: directory }, new AbortController().signal,
      (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch)).rejects.toThrow("registered OpenCode process is running")
    await writeFile(join(directory, "opencode", "service.json"), JSON.stringify({ url: "https://external.test", pid: process.pid, password: "secret" }))
    await expect(discoverLocalServer({ XDG_STATE_HOME: directory }, new AbortController().signal)).rejects.toThrow("loopback")
  })
})
