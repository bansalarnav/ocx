import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Scope, Stream } from "effect"
import { ChildProcess } from "effect/process"
import {
  defaultRemoteLimits,
  makeRemoteEnvironment,
  makeRemoteSpawner,
  remoteEnvironmentLayer,
  type RemoteExecutor,
  type RemoteLimits,
} from "../packages/server/src/remote/environment"
import { Environment } from "../packages/server/node_modules/@opencode/core/dist/environment/index.js"
import { Location } from "../packages/server/node_modules/@opencode/core/dist/location.js"

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function workspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "ocx-env-"))
  directories.push(root)
  return root
}

/**
 * Stands in for WorkspaceManager with the Maritime transport replaced by a real
 * local `/bin/sh -c`: stdin is delivered as text, stdout is capped at 1 MiB
 * like Maritime's capture, and abort sends SIGTERM to the command then rejects.
 */
function localExecutor(root: string, state: { value: string } = { value: "ready" }, path = process.env.PATH) {
  const runs: string[] = []
  const executor: RemoteExecutor = {
    async resolve(directory) {
      return directory === root || directory.startsWith(root + "/") ? { id: "workspace", root, state: state.value } : undefined
    },
    run(workspaceID, command, options) {
      runs.push(workspaceID)
      return new Promise((resolve, reject) => {
        options.signal?.throwIfAborted()
        // The sandbox has its own environment; only what the plan forwards may differ.
        const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: path } })
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
        child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
        const abort = () => child.kill("SIGTERM")
        options.signal?.addEventListener("abort", abort, { once: true })
        child.on("error", reject)
        child.on("close", code => {
          options.signal?.removeEventListener("abort", abort)
          if (options.signal?.aborted) reject(options.signal.reason)
          else resolve({ stdout: stdout.slice(0, 1024 * 1024), stderr, exitCode: code })
        })
        child.stdin.on("error", () => {})
        child.stdin.end(options.stdin ?? "")
      })
    },
  }
  return { executor, runs, state }
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.runCollect(stream).pipe(Effect.map(chunks => Buffer.concat(Array.from(chunks))))

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))
const runExit = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromiseExit(Effect.scoped(effect))
const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  const error = exit.cause.reasons.find(reason => reason._tag === "Fail")
  if (!error || error._tag !== "Fail") throw new Error("expected a typed failure, got " + String(exit.cause))
  return error.error as any
}
const waitFor = async (check: () => boolean, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test("runs argv in the sandbox with cwd, separate output streams, exit codes and no host environment", async () => {
  const root = await workspaceRoot()
  await mkdir(join(root, "sub"))
  const { executor } = localExecutor(root)
  const spawner = makeRemoteSpawner(executor, { id: "workspace", root })
  process.env.OCX_HOST_SECRET = "host-only"
  try {
    const result = await run(Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("sh", [
        "-c", `printf '%s|' "$@"; pwd; printf '%s/%s' "\${OCX_HOST_SECRET-unset}" "$OCX_INTENT" >&2; exit 3`,
        "sh", "a b", "it's", "ü $HOME",
      ], { cwd: "sub", env: { ...process.env, OCX_INTENT: "chosen" } }))
      const [stdout, stderr, code] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), handle.exitCode], { concurrency: "unbounded" })
      return { stdout: stdout.toString(), stderr: stderr.toString(), code }
    }))
    expect(result.stdout).toBe(`a b|it's|ü $HOME|${join(root, "sub")}\n`)
    expect(result.stderr).toBe("unset/chosen")
    expect(result.code).toBe(3)
  } finally {
    delete process.env.OCX_HOST_SECRET
  }
}, 20000)

test("delivers binary stdin bytes exactly and refuses stdin over the limit", async () => {
  const root = await workspaceRoot()
  const { executor } = localExecutor(root)
  const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256)
  const spawner = makeRemoteSpawner(executor, { id: "workspace", root })
  const echoed = await run(Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make("cat", [], { stdin: Stream.make(bytes.subarray(0, 1000), bytes.subarray(1000)) }))
    return yield* collect(handle.stdout)
  }))
  expect(new Uint8Array(echoed)).toEqual(bytes)

  const small = makeRemoteSpawner(executor, { id: "workspace", root }, { ...defaultRemoteLimits, stdin: 1000 })
  const refused = await runExit(small.spawn(ChildProcess.make("cat", [], { stdin: Stream.make(bytes) })))
  expect(failure(refused).reason._tag).toBe("BadArgument")

  const interactive = await runExit(Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make("cat", []))
    yield* Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.stdin))
  }))
  expect(failure(interactive).reason._tag).toBe("BadArgument")
}, 20000)

test("reports missing programs, missing directories and signals as typed process failures", async () => {
  const root = await workspaceRoot()
  const { executor } = localExecutor(root)
  const spawner = makeRemoteSpawner(executor, { id: "workspace", root })
  const exitOf = (command: ChildProcess.Command) => runExit(Effect.flatMap(spawner.spawn(command), handle => handle.exitCode))
  expect(failure(await exitOf(ChildProcess.make("ocx-definitely-missing", []))).reason._tag).toBe("NotFound")
  expect(failure(await exitOf(ChildProcess.make("true", [], { cwd: join(root, "missing") }))).reason._tag).toBe("NotFound")
  expect(failure(await exitOf(ChildProcess.make("sh", ["-c", "kill -KILL $$"]))).message).toContain("SIGKILL")
}, 20000)

test("kill and scope close stop the remote process group, including background children", async () => {
  const root = await workspaceRoot()
  const { executor } = localExecutor(root)
  const spawner = makeRemoteSpawner(executor, { id: "workspace", root })
  const pidFile = join(root, "pid")
  const command = ChildProcess.make("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`])

  const killed = await run(Effect.gen(function* () {
    const handle = yield* spawner.spawn(command)
    yield* Effect.promise(() => waitFor(() => existsSync(pidFile)))
    const pid = Number(yield* Effect.promise(() => readFile(pidFile, "utf8")))
    expect(yield* handle.isRunning).toBe(true)
    yield* handle.kill()
    const exit = yield* Effect.exit(handle.exitCode)
    expect(yield* handle.isRunning).toBe(false)
    expect(yield* collect(handle.all)).toHaveLength(0)
    return { pid, exit }
  }))
  expect(failure(killed.exit).message).toContain("killed")
  await waitFor(() => !alive(killed.pid))

  await rm(pidFile)
  const scoped = await run(Effect.gen(function* () {
    yield* spawner.spawn(command)
    yield* Effect.promise(() => waitFor(() => existsSync(pidFile)))
    return Number(yield* Effect.promise(() => readFile(pidFile, "utf8")))
  }))
  await waitFor(() => !alive(scoped))
}, 20000)

test("fails output past the capture limit instead of returning silently truncated bytes", async () => {
  const root = await workspaceRoot()
  const { executor } = localExecutor(root)
  const spawner = makeRemoteSpawner(executor, { id: "workspace", root }, { ...defaultRemoteLimits, stdout: 1000 })
  const seen: number[] = []
  const exit = await runExit(Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make("head", ["-c", "5000", "/dev/zero"]))
    yield* Stream.runForEach(handle.stdout, chunk => Effect.sync(() => seen.push(chunk.length)))
  }))
  expect(seen).toEqual([1000])
  expect(failure(exit).message).toContain("truncated")
}, 20000)

test("refuses every process while the workspace is not executable", async () => {
  const root = await workspaceRoot()
  const { executor, runs, state } = localExecutor(root, { value: "transferring" })
  const spawner = makeRemoteSpawner(executor, { id: "workspace", root })
  for (const value of ["transferring", "local", "failed", "preparing"]) {
    state.value = value
    expect(failure(await runExit(spawner.spawn(ChildProcess.make("true", [])))).reason._tag).toBe("Busy")
  }
  expect(runs).toHaveLength(0)
  state.value = "paused"
  expect(await run(Effect.flatMap(spawner.spawn(ChildProcess.make("true", [])), handle => handle.exitCode))).toBe(0)
}, 20000)

test("Files contract reads and writes large binary files in bounded chunks with typed errors", async () => {
  const root = await workspaceRoot()
  const { executor, runs } = localExecutor(root)
  const limits: RemoteLimits = { ...defaultRemoteLimits, readChunk: 1000, writeChunk: 1500, stdin: 2000 }
  const { files } = makeRemoteEnvironment(executor, { id: "workspace", root }, limits)
  const target = join(root, "nested", "data.bin")
  const bytes = Uint8Array.from({ length: 5003 }, (_, index) => (index * 7 + 3) % 256)

  await Effect.runPromise(files.write(target, bytes))
  expect(new Uint8Array(await readFile(target))).toEqual(bytes)
  expect(runs.length).toBe(4)

  const whole = await Effect.runPromise(files.read(target))
  expect(whole.bytes).toEqual(bytes)
  expect(whole.info).toMatchObject({ type: "file", size: 5003 })
  expect((await Effect.runPromise(files.read(target, { offset: 1200, length: 2500 }))).bytes).toEqual(bytes.subarray(1200, 3700))
  expect((await Effect.runPromise(files.read(target, { offset: 4900, length: 1000 }))).bytes).toEqual(bytes.subarray(4900))

  await writeFile(join(root, "nested", "other.txt"), "x")
  expect([...await Effect.runPromise(files.list(join(root, "nested")))].sort((a, b) => a.name.localeCompare(b.name)))
    .toEqual([{ name: "data.bin", type: "file" }, { name: "other.txt", type: "file" }])
  expect((await Effect.runPromise(files.stat(join(root, "nested")))).type).toBe("directory")

  const missing = await Effect.runPromiseExit(files.read(join(root, "missing.txt")))
  expect(failure(missing)._tag).toBe("Environment.NotFound")
  const wrongKind = await Effect.runPromiseExit(files.read(join(root, "nested")))
  expect(failure(wrongKind)._tag).toBe("Environment.WrongKind")

  await Effect.runPromise(files.remove(target))
  expect(existsSync(target)).toBe(false)
}, 30000)

test("binds only remote workspace directories and leaves other locations on the original layer", async () => {
  const root = await workspaceRoot()
  const { executor } = localExecutor(root)
  const original = Layer.succeed(Environment.Service, Environment.Service.of({
    files: {} as Environment.Files,
    spawner: makeRemoteSpawner({ ...executor, run: () => Promise.reject(new Error("original layer")) }, { id: "workspace", root }),
  }))
  const environmentAt = (directory: string, workspaceID?: string) =>
    Effect.runPromise(Effect.scoped(Layer.build(remoteEnvironmentLayer(executor, original).pipe(
      Layer.provide(Layer.succeed(Location.Service, { directory, workspaceID } as unknown as Location.Interface)),
    ))).pipe(Effect.map(context => context.mapUnsafe.get(Environment.Service.key) as Environment.Interface)))

  const remote = await environmentAt(root)
  expect(await run(Effect.flatMap(remote.spawner.spawn(ChildProcess.make("pwd", [])), handle => collect(handle.stdout))).then(String)).toBe(root + "\n")
  for (const local of [await environmentAt("/somewhere/else"), await environmentAt(root, "upstream-workspace")]) {
    const exit = await runExit(Effect.flatMap(local.spawner.spawn(ChildProcess.make("pwd", [])), handle => handle.exitCode))
    expect(failure(exit).message).toContain("original layer")
  }
}, 20000)

// Uses a real ripgrep binary when this machine has one; grep/glob steps are skipped otherwise.
const ripgrep = [
  "/usr/bin/rg",
  "/usr/local/bin/rg",
  join(process.env.HOME ?? "", ".bun/install/global/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path/rg"),
].find(existsSync)

/**
 * Upstream workerd server, upstream native tools, a scripted OpenAI-compatible
 * model, and a real local process standing in for the Maritime sandbox.
 */
test("workerd native write, edit, read, shell, grep and glob run in the remote workspace and checkpoint at idle", async () => {
  const { Database } = await import("bun:sqlite")
  const { Bus } = await import("../packages/server/node_modules/@opencode/core/dist/bus.js")
  const { SdkPlugins } = await import("../packages/server/node_modules/@opencode/core/dist/plugin/sdk.js")
  const { ServerFetch } = await import("../packages/server/node_modules/@opencode/server/dist/fetch.js")
  const { ServerWorkerd } = await import("../packages/server/node_modules/@opencode/server/dist/workerd.js")
  const { makeGlobalNode } = await import("../packages/server/node_modules/@opencode/util/dist/effect/app-node.js")
  const { remoteReplacements } = await import("../packages/server/src/remote/adapter")
  const { remoteCheckpointPlugin, remoteEnvironmentReplacements } = await import("../packages/server/src/remote/environment")
  const { makeLivePluginRegistry } = await import("../packages/server/src/plugin-manager/registry")

  const root = await workspaceRoot()
  await writeFile(join(root, "hello.txt"), "remote contents\n")
  const { executor } = localExecutor(root, { value: "ready" }, ripgrep ? `${join(ripgrep, "..")}:${process.env.PATH}` : process.env.PATH)
  let sessionID: string | undefined
  const checkpoints: string[] = []
  const manager = {
    ...executor,
    async forSession(id: string) { return id === sessionID ? { id: "workspace", root } : undefined },
    async checkpoint(id: string) { checkpoints.push(id) },
  }

  const steps: Array<{ name: string; input: Record<string, unknown> }> = [
    { name: "write", input: { path: "notes.txt", content: "alpha\nbeta\n" } },
    { name: "edit", input: { path: "notes.txt", oldString: "beta", newString: "gamma" } },
    { name: "read", input: { path: "notes.txt" } },
    { name: "shell", input: { command: "cat notes.txt hello.txt; printf done > shell.txt; pwd" } },
    ...(ripgrep ? [{ name: "grep", input: { pattern: "gamma" } }, { name: "glob", input: { pattern: "*.txt" } }] : []),
  ]
  const results: string[] = []
  let finished = false
  const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })
  const model = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }
      const tools = body.messages.filter(message => message.role === "tool")
      if (!body.tools?.length) return sse([chunk({ role: "assistant", content: "Remote title" }, null), chunk({}, "stop")])
      results.splice(0, results.length, ...tools.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      const step = steps[tools.length]
      if (!step) {
        finished = true
        return sse([chunk({ role: "assistant", content: "finished" }, null), chunk({}, "stop")])
      }
      return sse([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${tools.length}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } }] }, null),
        chunk({}, "tool_calls"),
      ])
    },
  })

  const database = new Database(":memory:")
  const values = new Map<string, unknown>()
  const storage = {
    sql: { exec(query: string, ...params: any[]) {
      const statement = database.query(query)
      const rows = statement.values(...params) ?? []
      const names = statement.columnNames ?? []
      return { columnNames: names, raw: () => rows.values(), toArray: () => rows.map(row => Object.fromEntries(names.map((name, index) => [name, row[index]]))) }
    } },
    async transaction<T>(body: (transaction: any) => Promise<T>) {
      database.exec("BEGIN")
      try { const result = await body({ rollback() { throw new Error("rolled back") } }); database.exec("COMMIT"); return result }
      catch (error) { database.exec("ROLLBACK"); throw error }
    },
    transactionSync<T>(body: () => T) { return database.transaction(body)() },
    async get(key: string) { return values.get(key) }, async put(key: string, value: unknown) { values.set(key, value) },
  }
  const options = {
    storage: storage as never,
    models: { fetch: false },
    config: { content: JSON.stringify({
      providers: { fake: { package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "test" }, models: { m: { name: "Fake" } } } },
    }) },
  }
  const registry = makeLivePluginRegistry([remoteCheckpointPlugin(manager)])
  const scope = Effect.runSync(Scope.make())
  try {
    const handler = await Effect.runPromise(ServerFetch.make(ServerWorkerd.serverOptions(options), {
      overrides: [
        ...ServerWorkerd.replacements(options),
        SdkPlugins.node.replace(makeGlobalNode({ service: SdkPlugins.Service, deps: [Bus.node], layer: registry.layer })),
        ...remoteReplacements(manager as never),
        ...remoteEnvironmentReplacements(manager),
      ],
    }).pipe(Effect.provideService(Scope.Scope, scope)))
    const request = async (path: string, body?: unknown) => {
      const response = await handler(new Request("http://localhost" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
      const text = await response.text()
      expect(response.status, text).toBeLessThan(300)
      return text ? JSON.parse(text) : undefined
    }
    const created = await request("/api/session", {
      location: { directory: root },
      model: { id: "m", providerID: "fake" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    sessionID = created.data.id
    await request(`/api/session/${sessionID}/prompt`, { text: "Use the native tools." })
    await waitFor(() => finished && checkpoints.length > 0, 20000)

    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("alpha\ngamma\n")
    expect(await readFile(join(root, "shell.txt"), "utf8")).toBe("done")
    expect(results[2]).toContain("gamma")
    expect(results[3]).toContain("alpha\ngamma\nremote contents")
    expect(results[3]).toContain(root)
    if (ripgrep) {
      expect(results[4]).toContain("notes.txt")
      expect(results[5]).toContain("hello.txt")
      expect(results[5]).toContain("shell.txt")
    }
    expect(checkpoints).toEqual(["workspace"])
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    model.stop(true)
    database.close()
  }
}, 60000)
