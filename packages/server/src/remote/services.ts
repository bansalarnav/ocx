import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { Vcs } from "@opencode-ai/core/vcs"
import { Shell } from "@opencode-ai/core/shell"
import { Shell as ShellSchema } from "@opencode-ai/schema/shell"
import { RelativePath } from "@opencode-ai/schema/schema"
import { AppProcessError } from "@opencode-ai/util/process"
import { Effect, Layer } from "effect"
import { remotePath, type RemoteRun } from "@ocx/protocol/workspaces"
import type { RemoteComputer } from "./computer"

type Computer = DurableObjectStub<RemoteComputer>
interface StoredShell { info: ShellSchema.Info; runID: string }
export function remoteServices(getComputer: () => Computer, storage: DurableObjectStorage, attached: () => boolean) {
  const find: FileSystem.Interface["find"] = input => Effect.promise(async () => {
    if (!attached()) return []
    const entries = await getComputer().findFiles(input.query, input.type, input.limit)
    return entries.map(entry => ({ ...entry, path: RelativePath.make(entry.path) }))
  })
  const filesystem = Layer.succeed(FileSystem.Service, FileSystem.Service.of({
    read: input => Effect.promise(async () => ({ content: await getComputer().readBytes(input.path), mime: "application/octet-stream" })),
    list: input => Effect.promise(async () => !attached() ? [] : (await getComputer().listFiles(input?.path ?? ".")).map(entry => ({ ...entry, path: RelativePath.make(entry.path) }))),
    find,
  }))
  const vcs = Layer.succeed(Vcs.Service, Vcs.Service.of({
    transform: () => Effect.succeed({ dispose: Effect.void }), reload: () => Effect.void,
    info: () => !attached() ? Effect.succeed({ branch: {} }) : Effect.promise(() => getComputer().vcsInfo()),
    base: () => Effect.succeed(null),
    branches: options => Effect.promise(async () => (await getComputer().branches()).filter(branch => !options?.search || branch.includes(options.search)).slice(0, options?.limit ?? 100)),
    status: () => !attached() ? Effect.succeed([]) : Effect.promise(() => getComputer().changes(false)),
    diff: (mode, options) => mode === "working"
      ? Effect.tryPromise({ try: () => getComputer().changes(true), catch: error => new Vcs.DiffError({ message: String(error) }) })
      : Effect.fail(new Vcs.DiffError({ message: "Remote review currently supports working-tree diffs. Use the remote shell for branch/committed comparisons." })),
  }))
  const saved = (id: ShellSchema.ID) => Effect.gen(function* () {
    const row = yield* Effect.promise(() => storage.get<StoredShell>(`remote:shell:${id}`))
    if (!row) return yield* Effect.fail(new Shell.NotFoundError({ id }))
    return row
  })
  const update = (row: StoredShell, run: RemoteRun) => {
    row.info = { ...row.info, status: run.status === "running" ? "running" : run.status === "cancelled" ? "killed" : "exited", exit: run.exitCode,
      time: { ...row.info.time, ...(run.status === "running" ? {} : { completed: row.info.time.completed ?? Date.now() }) } }
    return row
  }
  const get: Shell.Interface["get"] = id => Effect.gen(function* () {
    const row = yield* saved(id)
    update(row, yield* Effect.promise(() => getComputer().run(row.runID)))
    yield* Effect.promise(() => storage.put(`remote:shell:${id}`, row))
    return row.info
  })
  const wait: Shell.Interface["wait"] = id => Effect.gen(function* () {
    while (true) {
      const info = yield* get(id)
      if (info.status !== "running") return info
      yield* Effect.sleep("300 millis")
    }
  })
  const shell: Shell.Interface = {
    create: (input, before) => Effect.gen(function* () {
      const command = { command: input.command, cwd: "/workspace/repo", timeout: input.timeout, shell: "just-bash", env: {} as Record<string,string|undefined> }
      if (before) yield* before(command)
      const run = yield* Effect.tryPromise({
        try: () => getComputer().start(command.command, remotePath(command.cwd), command.timeout, undefined, Object.fromEntries(Object.entries(command.env).filter((entry): entry is [string,string] => entry[1] !== undefined))),
        catch: cause => new AppProcessError({ command: command.command, cause }),
      })
      const info: ShellSchema.Info = { id: ShellSchema.ID.create(), command: command.command, cwd: command.cwd, shell: command.shell, status: "running", file: `remote-exec:${run.id}`, metadata: input.metadata ?? {}, time: { started: Date.now() } }
      yield* Effect.promise(() => storage.put(`remote:shell:${info.id}`, { info, runID: run.id } satisfies StoredShell))
      return info
    }),
    list: () => Effect.gen(function* () {
      const rows = yield* Effect.promise(() => storage.list<StoredShell>({ prefix: "remote:shell:" }))
      const infos = yield* Effect.forEach([...rows.values()], row => get(row.info.id).pipe(Effect.orDie))
      return infos.filter(info => info.status === "running")
    }),
    get, wait,
    result: started => Effect.gen(function* () {
      const info = yield* wait(started.id).pipe(Effect.orDie)
      const row = yield* saved(started.id).pipe(Effect.orDie)
      const run = yield* Effect.promise(() => getComputer().run(row.runID))
      return { info, capture: { output: (run.output ?? run.stdout + run.stderr) + (run.error ? `\n${run.error}` : ""), truncated: run.truncated ?? false } }
    }),
    output: (id, input) => Effect.gen(function* () {
      const row = yield* saved(id)
      const run = yield* Effect.promise(() => getComputer().run(row.runID))
      const bytes = new TextEncoder().encode((run.output ?? run.stdout + run.stderr))
      const start = Math.min(input?.cursor ?? 0, bytes.length)
      const end = Math.min(start + (input?.limit ?? 64000), bytes.length)
      return { output: new TextDecoder().decode(bytes.slice(start, end)), cursor: end, size: bytes.length, truncated: run.truncated ?? false }
    }),
    timeout: (id, duration) => Effect.gen(function* () {
      const row = yield* saved(id)
      yield* Effect.promise(() => getComputer().timeout(row.runID, duration))
      return yield* get(id)
    }),
    remove: id => Effect.gen(function* () {
      const row = yield* saved(id)
      yield* Effect.promise(async () => {
        const run = await getComputer().run(row.runID)
        if (run.status === "running") await getComputer().stop(row.runID)
        await storage.delete(`remote:shell:${id}`)
      })
    }),
  }
  return [
    FileSystem.node.replace(filesystem),
    FileSystemSearch.node.replace(Layer.succeed(FileSystemSearch.Service, { find })),
    Vcs.node.replace(vcs),
    Shell.node.replace(Layer.succeed(Shell.Service, shell)),
  ]
}
