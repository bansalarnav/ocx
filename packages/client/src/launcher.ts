import { spawn } from "node:child_process"
import { Effect, Layer, Schedule } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ChildProcess } from "effect/process"
import { DeviceSharing } from "../../device/src/launcher"
import type { SharedDevice } from "@ocx/protocol/device"
import { Files } from "./files"
import { Plugins, pluginsLayer } from "./plugins"
import { Proxy } from "./proxy"
import { Transport, transportLayer } from "./transport"
import { attempt } from "@ocx/protocol/errors"
import { cloudCheckout } from "@ocx/protocol/projects"
import { workspacePrefix, type Workspace } from "@ocx/protocol/workspaces"
import { syncInstanceConfig } from "./instance-config"
import type { Options } from "./options"
import type { RemoteLaunch } from "./remote"
import { createControlBridge } from "./control-bridge"
import { startLocalServer, type OwnedLocalServer } from "./local-server"
import { createLocalTuiConfig, type LocalTuiConfig } from "./local-config"
import { createLocalTuiProxy } from "./tui-proxy"

export interface LauncherTarget {
  server: string
  password?: string
  sessionID?: string
  directory?: string
  binary: string
  local: boolean
  draftID?: string
}
export interface TuiLaunch {
  target: LauncherTarget
  env: NodeJS.ProcessEnv
  childArgs: string[]
  signal: AbortSignal
  config: LocalTuiConfig
  device?: SharedDevice
  interceptSubmission?: (request: Request) => Promise<Response | undefined>
}

interface LauncherDependencies {
  localServer?: (input: Parameters<typeof startLocalServer>[0]) => Promise<OwnedLocalServer>
  localConfig?: typeof createLocalTuiConfig
  bridge?: typeof createControlBridge
  localTui?: (input: TuiLaunch) => Promise<number>
  remoteTui?: (input: TuiLaunch, options: Options) => Promise<number>
}

async function runLocalTui(input: TuiLaunch): Promise<number> {
  input.signal.throwIfAborted()
  const proxy = input.interceptSubmission ? createLocalTuiProxy(input.target.server, input.target.password, input.interceptSubmission) : undefined
  const args = ["--server", proxy?.origin ?? input.target.server,
    ...(input.target.sessionID ? ["--session", input.target.sessionID] : []), ...input.childArgs]
  try { return await new Promise<number>((resolve, reject) => {
    const child = spawn(input.target.binary, args, {
      cwd: input.target.directory,
      env: { ...process.env, ...input.env, OPENCODE_PASSWORD: proxy?.password ?? input.target.password ?? "", OPENCODE_CONFIG_DIR: input.config.configDir, OPENCODE_TUI_CONFIG: input.config.tuiConfig,
        ...(input.config.cliContent ? { OPENCODE_CLI_CONFIG_CONTENT: input.config.cliContent } : {}) },
      stdio: "inherit",
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      child.kill("SIGTERM")
      timer = setTimeout(() => child.kill("SIGKILL"), 2000)
      timer.unref()
    }
    input.signal.addEventListener("abort", abort, { once: true })
    const cleanup = () => { input.signal.removeEventListener("abort", abort); clearTimeout(timer) }
    child.once("error", error => { cleanup(); reject(error) })
    child.once("close", code => { cleanup(); resolve(code ?? 1) })
    if (input.signal.aborted) abort()
  }) } finally { await proxy?.stop() }
}

/** Resolve scope from the session's actual checkout, never from the local cwd. */
export const remotePluginProject = (target: Pick<LauncherTarget, "server" | "sessionID" | "directory">, childArgs: readonly string[] = []) =>
  Effect.gen(function* () {
    const transport = yield* Transport
    const request = (path: string) => Effect.gen(function* () {
      const response = yield* transport.fetch(new Request(new URL(path, target.server)))
      if (!response.ok) return yield* Effect.fail(new Error(`Could not resolve cloud plugin project: HTTP ${response.status}`))
      return yield* attempt("Read cloud plugin project", () => response.json())
    })
    const index = childArgs.findIndex(arg => arg === "--session" || arg === "-s")
    const sessionID = target.sessionID || (index === -1 ? undefined : childArgs[index + 1]) || childArgs.find(arg => arg.startsWith("--session="))?.slice("--session=".length)
    if (!sessionID && !target.directory) return undefined
    const sessionInfo = sessionID ? (yield* request(`/api/session/${encodeURIComponent(sessionID)}`)) : undefined
    const session = (sessionInfo as { data?: { location?: { directory?: string } } } | undefined)?.data
    const directory = session?.location?.directory ?? target.directory
    const { workspaces } = (yield* request(workspacePrefix)) as { workspaces: Workspace[] }
    const workspace = workspaces.find(workspace => workspace.root === directory || (sessionID && workspace.sessionIDs.includes(sessionID)))
    return workspace ? cloudCheckout(workspace).projectID : directory
  })

function runRemoteTui(input: TuiLaunch, options: Options): Promise<number> {
  const remoteOptions: Options = {
    ...options, origin: input.target.server, password: input.target.password,
    // A local backend's config is never implicitly uploaded on handoff.
    config: options.origin === input.target.server ? options.config : undefined,
  }
  const transport = transportLayer(remoteOptions.origin, remoteOptions.password, input.device)
  return Effect.runPromise(Effect.gen(function* () {
    const projectID = yield* remotePluginProject(input.target, input.childArgs)
    const services = Layer.mergeAll(Proxy.withInterceptor(input.interceptSubmission), pluginsLayer(remoteOptions, process.env, { deferInitialApprovals: true, projectID }).pipe(Layer.provide(Files.layer)))
    return yield* Effect.gen(function* () {
      const proxy = yield* Proxy
      const plugins = yield* Plugins
      yield* syncInstanceConfig(remoteOptions)
      const files = yield* plugins.prepare
      const child = yield* ChildProcess.make(input.target.binary,
        ["--server", proxy.origin, ...(input.target.sessionID ? ["--session", input.target.sessionID] : []), ...input.childArgs], {
          stdin: "inherit", stdout: "inherit", stderr: "inherit", extendEnv: true,
          ...(input.target.directory ? { cwd: input.target.directory } : {}),
          env: {
            ...input.env, OPENCODE_PASSWORD: proxy.password, OPENCODE_CONFIG_DIR: files.configDir,
            OPENCODE_TUI_CONFIG: files.tuiConfig, OCX_CONTROL_DIR: files.controlDir,
            ...(files.cliContent ? { OPENCODE_CLI_CONFIG_CONTENT: files.cliContent } : {}),
            OCX_SERVER_URL: remoteOptions.origin, OCX_PROXY_ORIGIN: proxy.origin,
            OCX_PROJECT_ID: projectID ?? "",
          },
        })
      yield* plugins.watch(files).pipe(
        Effect.tapError(error => Effect.logWarning("Plugin updates disconnected", error)),
        Effect.retry(Schedule.spaced("1 second")), Effect.forkScoped,
      )
      return yield* child.exitCode
    }).pipe(Effect.provide(services))
  }).pipe(Effect.scoped, Effect.provide(transport), Effect.provide(NodeServices.layer)), { signal: input.signal })
}

/** One owned local backend and bridge survive every TUI attachment switch. */
export async function runLauncher(options: Options, signal: AbortSignal, initial?: RemoteLaunch,
  dependencies: LauncherDependencies = {}): Promise<number> {
  const local = await (dependencies.localServer ?? startLocalServer)({
    binary: options.binary, config: options.origin ? undefined : options.config, signal,
  })
  let config: LocalTuiConfig | undefined
  let bridge: Awaited<ReturnType<typeof createControlBridge>> | undefined
  let sharing: DeviceSharing | undefined
  let device: SharedDevice | undefined
  let currentUI: AbortController | undefined
  let pending: LauncherTarget | undefined
  let backendFailure: Error | undefined
  let stopping = false
  const originalRawMode = process.stdin.isRaw
  const interrupt = () => currentUI?.abort(signal.reason)
  signal.addEventListener("abort", interrupt)
  void local.closed.then(exit => {
    if (stopping) return
    backendFailure = new Error(`Local OpenCode backend stopped unexpectedly: ${exit.error ?? exit.code ?? exit.signal}`)
    currentUI?.abort(backendFailure)
  })
  try {
    config = await (dependencies.localConfig ?? createLocalTuiConfig)(options.dataRoot)
    bridge = await (dependencies.bridge ?? createControlBridge)({
      dataRoot: options.dataRoot, binary: options.binary,
      local: { server: local.server, password: local.password },
      initialRemote: initial && !initial.local ? { server: initial.server, password: initial.password } :
        options.origin ? { server: options.origin, password: options.password } : undefined,
      initialMode: initial ? initial.local ? "local" : "remote" : options.origin ? "remote" : "local",
      onSwitch: launch => {
        pending = {
          ...launch, binary: launch.binary || options.binary, local: launch.local === true,
          ...(launch.local ? { server: local.server, password: local.password } : {}),
        }
        // The plugin receives its successful action response before the bridge
        // invokes this callback. Only the UI is interrupted, never its backend.
        currentUI?.abort(new Error("Switch OpenCode attachment"))
      },
    })
    if (options.shareDevice) {
      sharing = new DeviceSharing()
      device = await sharing.start(options.deviceRoot, signal)
      void sharing.watch(signal).catch(error => {
        if (!stopping && !signal.aborted) { backendFailure = error; currentUI?.abort(error) }
      })
    }
    let target: LauncherTarget = initial ? { ...initial, local: initial.local === true } : options.origin ?
      { server: options.origin, password: options.password, binary: options.binary, local: false } :
      { server: local.server, password: local.password, binary: options.binary, local: true }
    if (target.local) target = { ...target, server: local.server, password: local.password }
    let first = true
    while (true) {
      signal.throwIfAborted()
      if (backendFailure) throw backendFailure
      if (pending) { target = pending; pending = undefined }
      currentUI = new AbortController()
      if (signal.aborted) currentUI.abort(signal.reason)
      const cursor = target.draftID ? await bridge.prepareDraft?.(target.draftID, target) : undefined
      const input: TuiLaunch = {
        target, childArgs: first ? options.childArgs : [], signal: currentUI.signal, config, device,
        env: { OCX_CONTROL_ORIGIN: bridge.origin, OCX_CONTROL_TOKEN: bridge.token, OCX_MODE: target.local ? "local" : "remote",
          OCX_DRAFT_ID: target.draftID ?? "", OCX_DRAFT_CURSOR: cursor === undefined ? "" : String(cursor), OCX_DRAFT_SESSION_ID: target.sessionID ?? "" },
        interceptSubmission: bridge.interceptSubmission,
      }
      target = { ...target, draftID: undefined }
      first = false
      try {
        const code = await (target.local ? (dependencies.localTui ?? runLocalTui)(input) : (dependencies.remoteTui ?? runRemoteTui)(input, options))
        if (backendFailure) throw backendFailure
        signal.throwIfAborted()
        if (!pending) return code
      } catch (error) {
        if (backendFailure) throw backendFailure
        signal.throwIfAborted()
        if (!pending) throw error
      } finally { currentUI = undefined }
    }
  } finally {
    stopping = true
    signal.removeEventListener("abort", interrupt)
    currentUI?.abort()
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(originalRawMode ?? false)
    await Promise.all([bridge?.stop(), config?.stop(), sharing?.stop(), local.stop()])
  }
}
