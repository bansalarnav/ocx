#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { workspaceID } from "@ocx/protocol/workspaces"
import { Effect, Layer, Schedule } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ChildProcess } from "effect/unstable/process"
import { evaluate } from "@ocx/protocol/errors"
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
  let workspace = options.workspace
  while (true) {
  const transport = transportLayer(options.origin, process.env.OPENCODE_PASSWORD, workspace)
  const services = Layer.mergeAll(
    Proxy.layer.pipe(Layer.provide(transport)),
    pluginsLayer(options).pipe(Layer.provide(Layer.merge(transport, Files.layer))),
  ).pipe(Layer.provideMerge(NodeServices.layer))
  const result = yield* Effect.gen(function* () {
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
          OCX_PROXY_ORIGIN: proxy.origin,
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
    const next = yield* Effect.promise(async () => {
      try { return workspaceID(JSON.parse(await readFile(join(files.controlDir, "workspace.json"), "utf8")).id) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    })
    return { code, next }
  }).pipe(Effect.scoped, Effect.provide(services))
  if (!result.next) { process.exitCode = result.code; break }
  workspace = result.next
  }
})

NodeRuntime.runMain(main)
