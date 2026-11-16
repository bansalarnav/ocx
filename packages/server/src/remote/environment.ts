import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"
import { ShellSelect } from "@opencode/core/shell/select"
import { State } from "@opencode/core/state"
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Redacted, Sink, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner, ExitCode, make, makeHandle, type ProcessId } from "effect/process/ChildProcessSpawner"

/**
 * The slice of WorkspaceManager this module needs. `stdin` is forwarded by
 * `manager.run` to Maritime's run `stdin` field, so arbitrarily large inputs
 * never travel on the command line (Linux caps one argument at 128 KiB).
 */
export interface RemoteRunOptions {
  readonly timeoutSeconds?: number
  readonly signal?: AbortSignal
  readonly stdin?: string
}
/** Execution is allowed only while the sandbox owns the tree. */
export const executableStates: ReadonlySet<string> = new Set(["ready", "paused"])
export interface RemoteExecutor {
  resolve(directory: string): Promise<{ readonly id: string; readonly root: string; readonly state?: string } | undefined>
  run(workspaceID: string, command: string, options: RemoteRunOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
}
export interface RemoteWorkspace {
  readonly id: string
  readonly root: string
}

export interface RemoteLimits {
  /** Bytes a process may receive on stdin. Larger file writes are split by the Files override. */
  readonly stdin: number
  /** Captured bytes per stream. Base64 of both must fit Maritime's 1 MiB stdout capture. */
  readonly stdout: number
  readonly stderr: number
  /** Range size the Files override uses so whole-file reads never exceed `stdout`. */
  readonly readChunk: number
  /** Payload size per write command. */
  readonly writeChunk: number
  /** Whole-file read ceiling, matching upstream's process-backed default. */
  readonly wholeRead: number
  /** Maritime's maximum command lifetime. Callers stop commands earlier through `kill`. */
  readonly timeoutSeconds: number
}
export const defaultRemoteLimits: RemoteLimits = {
  stdin: 4 * 1024 * 1024,
  stdout: 704 * 1024,
  stderr: 48 * 1024,
  readChunk: 512 * 1024,
  writeChunk: 2 * 1024 * 1024,
  wholeRead: 64 * 1024 * 1024,
  timeoutSeconds: 3600,
}

/**
 * Runs one argv inside the sandbox. The plan arrives on stdin as JSON; the
 * result leaves as one JSON object with base64 output, so binary bytes and
 * stdout/stderr separation survive Maritime's text capture. The child gets its
 * own session and the wrapper forwards termination signals to that group, so
 * killing the Maritime command also stops background descendants.
 */
export const remoteExecScript = String.raw`
import base64,json,os,signal,subprocess,sys,tempfile
plan=json.loads(sys.stdin.buffer.read().decode())
limit=plan['limit']
def finish(value):
 sys.stdout.write(json.dumps(value,separators=(',',':'))); sys.stdout.flush(); os._exit(0)
def refuse(kind,message): finish({'status':'spawn','kind':kind,'message':message})
cwd=plan['cwd']
if not os.path.isdir(cwd): refuse('NotFound','Working directory does not exist: '+cwd)
env=dict(os.environ); env.update(plan['env'])
data=None if plan['stdin'] is None else base64.b64decode(plan['stdin'])
def capture(f,n):
 size=os.fstat(f.fileno()).st_size; f.seek(0); return base64.b64encode(f.read(n)).decode(),size
with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
 try: child=subprocess.Popen(plan['argv'],cwd=cwd,env=env,stdin=subprocess.DEVNULL if data is None else subprocess.PIPE,stdout=out,stderr=err,start_new_session=True)
 except FileNotFoundError as e: refuse('NotFound',str(e))
 except PermissionError as e: refuse('PermissionDenied',str(e))
 except OSError as e: refuse('Unknown',str(e))
 def stop(signum,frame):
  try: os.killpg(child.pid,signum)
  except OSError: pass
 for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(s,stop)
 if data is not None:
  try: child.stdin.write(data)
  except BrokenPipeError: pass
  try: child.stdin.close()
  except BrokenPipeError: pass
 code=child.wait()
 name=None
 if code<0:
  try: name=signal.Signals(-code).name
  except ValueError: name='SIG'+str(-code)
 o,osize=capture(out,limit['stdout']); e,esize=capture(err,limit['stderr'])
 finish({'status':'exit','code':code if code>=0 else None,'signal':name,'stdout':o,'stdoutSize':osize,'stderr':e,'stderrSize':esize})
`

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const remoteCommand = `exec python3 -c ${quote(remoteExecScript)}`

const toBase64 = (bytes: Uint8Array) => {
  let text = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(text)
}
const fromBase64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}
const normalize = (path: string) => {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return "/" + parts.join("/")
}

const badArgument = (method: string, description: string) =>
  PlatformError.badArgument({ module: "RemoteEnvironment", method, description })
const systemError = (method: string, tag: PlatformError.SystemErrorTag, description: string, cause?: unknown) =>
  PlatformError.systemError({ _tag: tag, module: "RemoteEnvironment", method, description, cause })

// The host's own variables (and in Workers, secrets bound into process.env)
// must never reach the sandbox. Callers such as the shell service merge the
// host environment into `env`; only values that differ from it are intentional.
const hostOnly = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TMPDIR", "HOSTNAME", "SHLVL", "_"])
const hostEnvironment = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const ENV_LIMIT = 64 * 1024

const forwardedEnvironment = (env: ChildProcess.CommandOptions["env"]) => {
  const host = hostEnvironment()
  const forwarded: Record<string, string> = {}
  let size = 0
  for (const [key, raw] of Object.entries(env ?? {})) {
    if (raw === undefined || hostOnly.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw
    if (host[key] === value || value.includes("\0")) continue
    size += key.length + value.length + 2
    forwarded[key] = value
  }
  return size > ENV_LIMIT ? undefined : forwarded
}

type Completed =
  | { readonly kind: "killed" }
  | {
      readonly kind: "exit"
      readonly code: number | null
      readonly signal: string | null
      readonly stdout: Uint8Array
      readonly stderr: Uint8Array
      readonly stdoutTruncated: boolean
      readonly stderrTruncated: boolean
    }

interface Frame {
  status: "exit" | "spawn"
  kind?: PlatformError.SystemErrorTag
  message?: string
  code?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  stdoutSize?: number
  stderrSize?: number
}

const decodeFrame = (command: string, result: { stdout: string; stderr: string; exitCode: number | null }) =>
  Effect.gen(function* () {
    let frame: Frame
    try {
      frame = JSON.parse(result.stdout) as Frame
    } catch (cause) {
      const detail = result.stderr.trim() || `wrapper exited with ${result.exitCode}`
      return yield* systemError("spawn", "Unknown", `Remote workspace could not run ${command}: ${detail}`, cause)
    }
    if (frame.status === "spawn") {
      const tag = frame.kind === "NotFound" || frame.kind === "PermissionDenied" ? frame.kind : "Unknown"
      return yield* systemError("spawn", tag, frame.message ?? `Remote workspace could not run ${command}`)
    }
    const stdout = fromBase64(frame.stdout ?? "")
    const stderr = fromBase64(frame.stderr ?? "")
    return {
      kind: "exit",
      code: frame.code ?? null,
      signal: frame.signal ?? null,
      stdout,
      stderr,
      stdoutTruncated: (frame.stdoutSize ?? 0) > stdout.length,
      stderrTruncated: (frame.stderrSize ?? 0) > stderr.length,
    } satisfies Completed
  })

const inputFor = (stdin: ChildProcess.CommandOptions["stdin"]) =>
  typeof stdin === "object" && stdin !== null && "stream" in stdin ? stdin.stream : stdin

/**
 * A ChildProcessSpawner whose processes run in one Maritime sandbox. Nothing
 * runs on the Durable Object host. Output is delivered when the remote command
 * ends (Maritime's background handle has no live stream); `all` is stdout
 * followed by stderr rather than interleaved. Interactive stdin ("pipe") is
 * refused instead of silently ignored: pass stdin as a Stream.
 */
export const makeRemoteSpawner = (
  executor: RemoteExecutor,
  workspace: RemoteWorkspace,
  limits: RemoteLimits = defaultRemoteLimits,
) => {
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* badArgument("spawn", "Piped commands are not supported in a remote workspace")
      const options = command.options
      if (options.additionalFds && Object.keys(options.additionalFds).length > 0) {
        return yield* badArgument("spawn", "Additional file descriptors are not supported in a remote workspace")
      }
      for (const output of [options.stdout, options.stderr]) {
        const stream = typeof output === "object" && output !== null && "stream" in output ? output.stream : output
        if (typeof stream === "object" && stream !== null) return yield* badArgument("spawn", "Output sinks are not supported in a remote workspace")
      }
      const words = [command.command, ...command.args].map(word => (Redacted.isRedacted(word) ? Redacted.value(word) : word))
      if (words.some(word => word.includes("\0"))) return yield* badArgument("spawn", "Arguments must not contain NUL bytes")
      const argv = options.shell
        ? [typeof options.shell === "string" ? options.shell : "/bin/sh", "-c", words.join(" ")]
        : words
      const requested = options.cwd ?? workspace.root
      if (requested.includes("\0")) return yield* badArgument("spawn", "Working directory must not contain NUL bytes")
      // Relative directories resolve inside the workspace. The sandbox itself is
      // the isolation boundary; native tools ask permission for external paths.
      const cwd = normalize(requested.startsWith("/") ? requested : `${workspace.root}/${requested}`)
      const env = forwardedEnvironment(options.env)
      if (!env) return yield* badArgument("spawn", "Environment exceeds the remote workspace limit")

      const input = inputFor(options.stdin)
      let stdin: Uint8Array | undefined
      if (typeof input === "object" && input !== null) {
        const chunks: Uint8Array[] = []
        let size = 0
        yield* Stream.runForEach(input, chunk => {
          size += chunk.length
          if (size > limits.stdin) return Effect.fail(badArgument("spawn", `Remote stdin exceeds ${limits.stdin} bytes`))
          chunks.push(chunk)
          return Effect.void
        })
        stdin = concat(chunks)
      }
      const plan = JSON.stringify({
        argv, cwd, env,
        stdin: stdin === undefined ? null : toBase64(stdin),
        limit: { stdout: limits.stdout, stderr: limits.stderr },
      })

      // State is read per process: a transfer can start after the location was bound,
      // and a tree that moved to a local checkout must not change underneath it.
      const current = yield* Effect.tryPromise({
        try: () => executor.resolve(workspace.root),
        catch: cause => systemError("spawn", "Unknown", "Could not read remote workspace state", cause),
      })
      if (current?.id !== workspace.id) return yield* systemError("spawn", "NotFound", "The remote workspace for this location no longer exists")
      if (current.state !== undefined && !executableStates.has(current.state)) {
        return yield* systemError("spawn", "Busy", `Remote workspace is ${current.state}; files and commands are unavailable until it is ready`)
      }

      const done = yield* Deferred.make<Completed, PlatformError.PlatformError>()
      const fiber = yield* Effect.tryPromise({
        try: signal => executor.run(workspace.id, remoteCommand, { stdin: plan, signal, timeoutSeconds: limits.timeoutSeconds }),
        catch: cause => systemError("spawn", "Unknown", `Remote workspace command failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
      }).pipe(
        Effect.flatMap(result => decodeFrame(command.command, result)),
        Effect.onExit(exit =>
          Deferred.done(done, Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Exit.succeed({ kind: "killed" } as const) : exit),
        ),
        // Closing the spawn scope interrupts this fiber, which aborts the
        // signal and makes the manager kill the Maritime command.
        Effect.forkScoped,
      )

      const outcome = Deferred.await(done)
      const output = (pick: "stdout" | "stderr") =>
        Stream.unwrap(
          outcome.pipe(
            Effect.map(result => {
              if (result.kind === "killed") return Stream.empty
              const bytes = result[pick].length > 0 ? Stream.succeed(result[pick]) : Stream.empty
              const truncated = pick === "stdout" ? result.stdoutTruncated : result.stderrTruncated
              const limit = pick === "stdout" ? limits.stdout : limits.stderr
              return truncated
                ? Stream.concat(bytes, Stream.fail(systemError(pick, "WriteZero", `Remote ${pick} exceeded ${limit} bytes and was truncated`)))
                : bytes
            }),
          ),
        )
      const stdout = output("stdout")
      const stderr = output("stderr")
      return makeHandle({
        // There is no host process. Upstream treats an absent pid as unknown.
        pid: undefined as unknown as ProcessId,
        exitCode: outcome.pipe(
          Effect.flatMap(result => {
            if (result.kind === "killed") return Effect.fail(systemError("exitCode", "Unknown", "Remote process was killed"))
            if (result.code === null) {
              return Effect.fail(systemError("exitCode", "Unknown", `Remote process was terminated by ${result.signal ?? "a signal"}`))
            }
            return Effect.succeed(ExitCode(result.code))
          }),
        ),
        isRunning: Deferred.isDone(done).pipe(Effect.map(isDone => !isDone)),
        kill: () => Fiber.interrupt(fiber).pipe(Effect.asVoid),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          chunk.length === 0
            ? Effect.void
            : Effect.fail(badArgument("stdin", "Remote workspace processes do not accept interactive stdin; pass stdin as a Stream")),
        ),
        stdout,
        stderr,
        all: Stream.concat(stdout, stderr),
        getInputFd: () => Sink.fail(badArgument("getInputFd", "Additional file descriptors are not supported in a remote workspace")),
        getOutputFd: () => Stream.fail(badArgument("getOutputFd", "Additional file descriptors are not supported in a remote workspace")),
        unref: Effect.succeed(Effect.void),
      })
    })
  return make(spawn)
}

// Small helper shared by the Files overrides; mirrors upstream's process
// classification so callers keep seeing typed Environment errors.
const runScript = (
  spawner: ChildProcessSpawner["Service"],
  path: string,
  script: string,
  args: ReadonlyArray<string>,
  stdin: Uint8Array,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", script, "sh", path, ...args], { env: { LC_ALL: "C" }, stdin: Stream.succeed(stdin) }),
      )
      const [stderr, exitCode] = yield* Effect.all([Stream.runCollect(handle.stderr), handle.exitCode], { concurrency: "unbounded" })
      if (exitCode !== 0) {
        const message = new TextDecoder().decode(concat(stderr)).trim() || `Process exited with code ${exitCode}`
        return yield* new Environment.Failed({ path, cause: new Error(message) })
      }
    }),
  ).pipe(Effect.catchTag("PlatformError", cause => Effect.fail(new Environment.Failed({ path, cause }))))

/**
 * Upstream's process-backed Files contract over the remote spawner, with reads
 * and writes split so no single command exceeds the stdin or capture limits.
 */
export const makeRemoteFiles = (spawner: ChildProcessSpawner["Service"], limits: RemoteLimits = defaultRemoteLimits): Environment.Files => {
  const base = Environment.execDefaults(spawner)
  const read: Environment.FilesImpl["read"] = (path, range) =>
    Effect.gen(function* () {
      const offset = range?.offset ?? 0
      let requested = range ? Math.min(range.length, limits.readChunk) : limits.readChunk
      const first = yield* base.read(path, { offset, length: requested })
      const total = range ? range.length : Math.max(0, first.info.size - offset)
      if (!range && total > limits.wholeRead) {
        return yield* new Environment.Failed({ path, cause: new Error("Process output exceeded its collection limit") })
      }
      const parts = [first.bytes]
      let received = first.bytes.length
      while (received < total && parts[parts.length - 1]!.length === requested) {
        requested = Math.min(limits.readChunk, total - received)
        const next = yield* base.read(path, { offset: offset + received, length: requested })
        if (next.info.size !== first.info.size || next.info.mtimeMs !== first.info.mtimeMs) {
          return yield* new Environment.Failed({ path, cause: new Error("File changed while it was being read") })
        }
        parts.push(next.bytes)
        received += next.bytes.length
      }
      return { info: first.info, bytes: parts.length === 1 ? first.bytes : concat(parts) }
    })
  const write: Environment.FilesImpl["write"] = (path, bytes) =>
    bytes.length <= limits.writeChunk
      ? base.write(path, bytes)
      : Effect.gen(function* () {
          yield* base.write(path, bytes.subarray(0, limits.writeChunk))
          for (let offset = limits.writeChunk; offset < bytes.length; offset += limits.writeChunk) {
            yield* runScript(spawner, path, `cat >> "$1"`, [], bytes.subarray(offset, offset + limits.writeChunk))
          }
        })
  return { ...base, read, write }
}

export const makeRemoteEnvironment = (
  executor: RemoteExecutor,
  workspace: RemoteWorkspace,
  limits: RemoteLimits = defaultRemoteLimits,
): Environment.Interface => {
  const spawner = makeRemoteSpawner(executor, workspace, limits)
  return { spawner, files: makeRemoteFiles(spawner, limits) }
}

/**
 * Binds a location to its sandbox when its directory lies in a remote
 * workspace. Every other location keeps the upstream layer, which in workerd
 * has no execution plane. Locations bound through upstream workspace drivers
 * (`workspaceID`) are left to upstream.
 */
export const remoteEnvironmentLayer = <R>(
  executor: RemoteExecutor,
  original: Layer.Layer<Environment.Service, never, R>,
  limits: RemoteLimits = defaultRemoteLimits,
): Layer.Layer<Environment.Service, never, R | Location.Service> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const location = yield* Location.Service
      if (location.workspaceID !== undefined) return original
      const workspace = yield* Effect.promise(() => executor.resolve(location.directory))
      // Bind every workspace directory, whatever its state, so a remote tree never
      // falls back to the host. The spawner refuses work while it is not executable.
      if (!workspace) return original
      return Layer.succeed(Environment.Service, Environment.Service.of(makeRemoteEnvironment(executor, workspace, limits)))
    }),
  )

/** Sandbox shells are bash. A configured shell still wins. */
export const remoteShellSelect = makeLocationNode({
  service: ShellSelect.Service,
  deps: [],
  layer: Layer.sync(ShellSelect.Service, () => {
    const state = State.create<{ shell?: string }, ShellSelect.Editor>({
      name: "remote-shell-select",
      initial: () => ({}),
      editor: draft => ({ configure: shell => { draft.shell = shell } }),
    })
    const compatible = new Set(["bash", "sh", "zsh", "dash", "ksh"])
    return ShellSelect.Service.of({
      transform: state.transform,
      reload: state.reload,
      resolve: input =>
        Effect.sync(() => {
          const configured = state.get().shell
          if (!configured) return "/bin/bash"
          return input.priority === "compat" && !compatible.has(configured.split("/").pop() ?? "") ? "/bin/bash" : configured
        }),
    })
  }),
})

/**
 * Replacements that run OpenCode's native read/edit/patch/glob/grep/shell
 * tools in a location's Maritime sandbox. Ripgrep resolves to the sandbox's
 * `rg` (provisioning checks it exists); the host never downloads a binary.
 */
export function remoteEnvironmentReplacements(executor: RemoteExecutor, limits: RemoteLimits = defaultRemoteLimits): LayerNode.Replacements {
  return [
    Environment.node.replace(
      Environment.node.mapLayer(
        layer => remoteEnvironmentLayer(executor, layer, limits) as unknown as typeof layer,
      ),
    ),
    RipgrepBinary.node.replace(Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed("rg") }))),
    ShellSelect.node.replace(remoteShellSelect),
  ]
}

/** Native tools that can change the tree. Remote workspace_* tools checkpoint themselves. */
export const mutatingTools: ReadonlySet<string> = new Set(["write", "edit", "patch", "shell"])
export interface CheckpointTarget {
  forSession(sessionID: string): Promise<{ readonly id: string } | undefined>
  checkpoint(workspaceID: string): Promise<unknown>
  claimEditing?(sessionID: string, signal: AbortSignal): Promise<void>
  releaseEditing?(sessionID: string): Promise<void>
}

/**
 * Captures a checkpoint once per turn, when a Session that used a mutating
 * native tool goes idle. A failed or interrupted turn stays dirty and is
 * captured at the next idle.
 */
export const remoteCheckpointPlugin = (target: CheckpointTarget) => define({
  id: "remote-workspace-checkpoint",
  effect: Effect.fn(function* (context) {
    const dirty = new Map<string, string>()
    yield* context.tool.hook("execute.before", event => {
      if (!target.claimEditing || (!mutatingTools.has(event.tool) && !/workspace_(write|edit|patch|shell)$/.test(event.tool))) return Effect.void
      return Effect.tryPromise({
        try: signal => target.claimEditing!(event.sessionID, signal),
        catch: error => Tool.Error.make({ message: String(error) }),
      })
    })
    yield* context.tool.hook("execute.after", event => {
      if (!mutatingTools.has(event.tool)) return Effect.void
      return Effect.promise(() => target.forSession(event.sessionID)).pipe(
        Effect.tap(workspace => Effect.sync(() => { if (workspace) dirty.set(event.sessionID, workspace.id) })),
        Effect.catchCause(cause => Effect.logWarning("Could not resolve the remote workspace for a checkpoint", cause)),
        Effect.asVoid,
      )
    })
    yield* context.session.hook("experimental.idle", event => {
      const workspaceID = dirty.get(event.sessionID)
      if (!workspaceID) return Effect.promise(() => target.releaseEditing?.(event.sessionID) ?? Promise.resolve())
      dirty.delete(event.sessionID)
      return Effect.tryPromise(() => target.checkpoint(workspaceID)).pipe(
        Effect.catchCause(cause => Effect.sync(() => { if (!dirty.has(event.sessionID)) dirty.set(event.sessionID, workspaceID) }).pipe(
          Effect.andThen(Effect.logWarning("Remote workspace checkpoint failed", cause)),
        )),
        Effect.asVoid,
        Effect.ensuring(Effect.promise(() => target.releaseEditing?.(event.sessionID) ?? Promise.resolve())),
      )
    })
  }),
})
