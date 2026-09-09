#!/usr/bin/env bun
import { DeviceSharing } from "../../device/src/launcher"
import { Effect, Layer, Schedule } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ChildProcess } from "effect/unstable/process"
import { attempt, evaluate } from "@ocx/protocol/errors"
import { parseArguments, usage } from "./options"
import { Files } from "./files"
import { Plugins, pluginsLayer } from "./plugins"
import { Proxy } from "./proxy"
import { transportLayer } from "./transport"

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const separator = args.indexOf("--")
  if (
    args
      .slice(0, separator === -1 ? args.length : separator)
      .some((arg) => arg === "-h" || arg === "--help")
  ) {
    yield* Effect.sync(() => console.log(usage))
    return
  }
  const options = yield* evaluate("Read arguments", () => parseArguments(args))
  const sharing = options.shareDevice ? yield* Effect.acquireRelease(
    Effect.sync(() => new DeviceSharing()),
    sharing => Effect.promise(() => sharing.stop()),
  ) : undefined
  if (sharing) yield* Effect.sync(() => console.error(`Sharing local files and shell from ${options.deviceRoot} through OpenTunnel...`))
  const device = sharing ? yield* attempt("Start shared device", signal => sharing.start(options.deviceRoot, signal)) : undefined
  if (device) yield* Effect.sync(() => console.error("Device ready. Access lasts while ocx is connected."))
  const connect = Effect.gen(function* () {
    const transport = transportLayer(options.origin, process.env.OPENCODE_PASSWORD, device)
    const services = Layer.mergeAll(
      Proxy.layer.pipe(Layer.provide(transport)),
      pluginsLayer(options).pipe(Layer.provide(Layer.merge(transport, Files.layer))),
    ).pipe(Layer.provideMerge(NodeServices.layer))
    yield* Effect.gen(function* () {
      const proxy = yield* Proxy
      const plugins = yield* Plugins
      const files = yield* plugins.prepare
      const child = yield* ChildProcess.make(
        options.binary,
        ["--server", proxy.origin, ...options.childArgs],
        {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          extendEnv: true,
          env: {
            OPENCODE_PASSWORD: proxy.password,
            OPENCODE_CONFIG_DIR: files.configDir,
            OPENCODE_TUI_CONFIG: files.tuiConfig,
            OCX_CONTROL_DIR: files.controlDir,
          },
        },
      )
      yield* plugins.watch(files).pipe(
        Effect.tapError((error) => Effect.logWarning("Plugin updates disconnected", error)),
        Effect.retry(Schedule.spaced("1 second")),
        Effect.forkScoped,
      )
      const code = yield* child.exitCode
      process.exitCode = code
    }).pipe(Effect.scoped, Effect.provide(services))
  })
  yield* sharing ? Effect.raceFirst(connect, attempt("Shared device stopped", signal => sharing.watch(signal))) : connect
}).pipe(Effect.scoped)

NodeRuntime.runMain(main)
