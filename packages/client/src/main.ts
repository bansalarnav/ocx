#!/usr/bin/env bun
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { attempt, evaluate } from "@ocx/protocol/errors"
import { parseArguments, usage } from "./options"
import { parseRemoteArguments, remoteUsage, runRemoteCommand, type RemoteLaunch } from "./remote"
import { runLauncher } from "./launcher"

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  let initial: RemoteLaunch | undefined
  if (args[0] === "remote") {
    if (args.slice(1).some(arg => arg === "--help" || arg === "-h") || args.length === 1) {
      yield* Effect.sync(() => console.log(remoteUsage))
      return
    }
    const command = yield* evaluate("Read remote arguments", () => parseRemoteArguments(args.slice(1)))
    initial = yield* attempt("Remote workspace", () => runRemoteCommand(command))
    if (!initial) return
    args.splice(0, args.length, "--binary", initial.binary, "--data-dir", command.dataRoot,
      ...(!initial.local ? ["--server", initial.server, ...(initial.password ? ["--password", initial.password] : [])] : []))
  }
  const separator = args.indexOf("--")
  if (args.slice(0, separator === -1 ? args.length : separator).some(arg => arg === "-h" || arg === "--help")) {
    yield* Effect.sync(() => console.log(usage))
    return
  }
  const options = yield* evaluate("Read arguments", () => parseArguments(args))
  const controller = new AbortController()
  let running: Promise<number> | undefined
  const cleanup = () => Effect.promise(async () => {
    controller.abort()
    try { await running } catch { /* Cleanup already runs inside the launcher. */ }
  })
  // Wait for owned backend, bridge, tunnel, TUI and config cleanup on Ctrl-C.
  yield* Effect.addFinalizer(cleanup)
  running = runLauncher(options, controller.signal, initial)
  process.exitCode = yield* attempt("OpenCode launcher", () => running!)
}).pipe(Effect.scoped)

if (import.meta.main) NodeRuntime.runMain(main)
