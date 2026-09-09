import { define } from "@opencode-ai/plugin/effect/plugin"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Schema } from "effect"
import { remotePath, type ExecutionBackend } from "@ocx/protocol/workspaces"
import type { RemoteComputer } from "./computer"

type Computer = DurableObjectStub<RemoteComputer>
export const remoteTools = (getComputer: () => Computer, git: (operation: "fetch" | "push", branch?: string) => Promise<unknown>) => define({
  id: "remote-workspace",
  effect: Effect.fn(function* (context) {
    yield* context.session.hook("context", event => Effect.sync(() => {
      if (event.agent === "plugin-author") return
      event.system.push({ type: "text", text: "Repository work runs entirely remotely in /workspace/repo. Use remote_read, remote_files, remote_grep, remote_write, remote_edit, and remote_shell. Read AGENTS.md and project instructions before editing. The shell is just-bash in a V8 Worker, not Linux. Use its built-in commands, pipes, scripts, curl, jq, yq, xan, and Git to inspect and transform files. Native binaries, npm/bun installs, Node/Bun CLIs, gh, Python, browsers, and background servers are unavailable. Use remote_javascript for ES modules, relative JS imports, assertions, fetch, and async node:fs/promises against the checkout. It is not a full Node runtime or a package installer. Run checks compatible with these runtimes and report unsupported checks explicitly. Git uses Computer's JavaScript implementation; supported subcommands include status, diff, add, commit, branch, checkout, log, and merge. Use remote_git for authenticated fetch/push; account credentials are not in the shell. Do not use local device tools. A remote shell tool interrupted by the user must stop its command." })
    }))
    const execute = <T>(work: (signal: AbortSignal) => Promise<T>) => Effect.tryPromise({
      try: work,
      catch: error => Tool.Error.make({ message: String(error) }),
    }).pipe(Effect.map(result => ({ content: typeof result === "string" ? result : JSON.stringify(result, null, 2) })))
    yield* context.tool.transform(tools => {
      tools.add({ name: "remote_git", description: "Fetch or push the attached GitHub repository with the connected account. Commit with remote_shell first. Does not force-push. Only push when the user asks to publish changes.", input: Schema.Struct({ operation: Schema.Literals(["fetch", "push"]), branch: Schema.optional(Schema.String) }), options: { codemode: false, permission: "shell" }, execute: input => execute(() => git(input.operation, input.branch)) })
      tools.add({ name: "remote_read", description: "Read a remote checkout file, with byte pagination.", input: Schema.Struct({ path: Schema.String, offset: Schema.optional(Schema.Number) }), options: { codemode: false, permission: "read" }, execute: input => execute(() => getComputer().read(input.path, input.offset)) })
      tools.add({ name: "remote_files", description: "Find files in the remote checkout. Results are paginated, 200 entries per page.", input: Schema.Struct({ path: Schema.optional(Schema.String), pattern: Schema.optional(Schema.String), offset: Schema.optional(Schema.Number) }), options: { codemode: false, permission: "read" }, execute: input => execute(() => getComputer().files(input.path ?? ".", input.pattern, input.offset)) })
      tools.add({ name: "remote_grep", description: "Find literal text in remote files. Results are paginated, 200 matches per page.", input: Schema.Struct({ pattern: Schema.String, path: Schema.optional(Schema.String), offset: Schema.optional(Schema.Number) }), options: { codemode: false, permission: "read" }, execute: input => execute(() => getComputer().grep(input.pattern, input.path, input.offset)) })
      tools.add({ name: "remote_write", description: "Write a UTF-8 file in the remote checkout.", input: Schema.Struct({ path: Schema.String, content: Schema.String }), options: { codemode: false, permission: "edit" }, execute: input => execute(() => getComputer().write(input.path, input.content)) })
      tools.add({ name: "remote_edit", description: "Replace exactly one occurrence of oldText in a remote file. Read first; ambiguous matches fail.", input: Schema.Struct({ path: Schema.String, oldText: Schema.String, newText: Schema.String }), options: { codemode: false, permission: "edit" }, execute: input => execute(() => getComputer().edit(input.path, input.oldText, input.newText)) })
      for (const runtime of [
        { name: "remote_shell", backend: "worker-shell", description: "Run just-bash against the durable checkout. Supports text/file commands, pipes, scripts, curl, jq, yq, xan, and Computer Git. No native processes, npm installs, Node/Bun CLI, Python, gh, or dev servers. Output arrives at completion. command is shell source; cwd defaults to /workspace/repo." },
        { name: "remote_javascript", backend: "worker-javascript", description: "Run an ES module in a V8 Worker against the durable checkout. command is JavaScript module source. Supports relative JS imports, fetch, async node:fs/promises, and local ws:git operations. Put I/O and timers inside an async default-exported function, not module top level. It is invoked with no input; its return value is captured in resultJSON. Use console.log for output and throw to fail assertions. No arbitrary npm imports or native Node processes. cwd defaults to /workspace/repo." },
      ] satisfies { name: string; backend: ExecutionBackend; description: string }[]) tools.add({ name: runtime.name, description: runtime.description, input: Schema.Struct({ command: Schema.String, cwd: Schema.optional(Schema.String), timeoutMs: Schema.optional(Schema.Number) }), options: { codemode: false, permission: "shell" }, execute: (input, tool) => Effect.gen(function* () {
        const instance = getComputer()
        const started = yield* Effect.tryPromise({ try: () => instance.start(input.command, remotePath(input.cwd), input.timeoutMs, undefined, undefined, runtime.backend), catch: error => Tool.Error.make({ message: String(error) }) })
        return yield* Effect.gen(function* () {
          while (true) {
            const run = yield* Effect.tryPromise({ try: () => instance.run(started.id), catch: error => Tool.Error.make({ message: String(error) }) })
            yield* tool.progress({ output: run.output ?? run.stdout + run.stderr, executionID: run.id })
            if (run.status !== "running") return { content: JSON.stringify(run), metadata: { exitCode: run.exitCode } }
            yield* Effect.sleep("500 millis")
          }
        }).pipe(Effect.onInterrupt(() => Effect.promise(() => instance.stop(started.id).catch(() => undefined))))
      }) })
    })
  }),
})
