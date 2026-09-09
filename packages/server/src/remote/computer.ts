import { DurableObject } from "cloudflare:workers"
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer"
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell"
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript"
import curl from "@cloudflare/computer/shell/curl"
import jq from "@cloudflare/computer/shell/jq"
import file from "@cloudflare/computer/shell/file"
import xan from "@cloudflare/computer/shell/xan"
import htmlToMarkdown from "@cloudflare/computer/shell/html-to-markdown"
import { createGitClient } from "@cloudflare/computer/git"
import { shellLoader, workerYq } from "./shell-loader"
import { remotePath, executionBackend, type RemoteRun, type ExecutionBackend } from "@ocx/protocol/workspaces"
export { WorkspaceServiceProxy } from "@cloudflare/computer"

interface ComputerEnv { LOADER: WorkerLoader }
// Keep persisted command output bounded independently of command runtime.
const maxOutput = 128 * 1024
export class RemoteComputer extends DurableObject<ComputerEnv> {
  private readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        loader: shellLoader(this.env.LOADER),
        workspace: { binding: "COMPUTERS", id: this.ctx.id.toString() },
        ctx: this.ctx,
        commands: [curl, jq, workerYq, file, xan, htmlToMarkdown],
        egress: { mode: "direct" },
      }),
      new WorkerJavaScriptBackend({
        loader: this.env.LOADER,
        root: "/workspace/repo",
        access: "read-write",
        defaultTimeoutMs: 120000,
        maxTimeoutMs: 180000,
        maxStdioBytes: maxOutput,
        egress: { mode: "direct" },
      }),
    ],
    git: createGitClient(),
  })
  async __getWorkspaceStub() { return this.workspace.stub() }
  private cancelled = new Set<string>()
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private jobs = new Map<string, Promise<void>>()
  private starting = 0
  private writes: Promise<unknown> = Promise.resolve()

  async clone(repository: string, branch: string | undefined, token?: string) {
    const ws = this.workspace
    const previous = await this.ctx.storage.get<string>("repository")
    if (previous) {
      if (previous !== repository) throw new Error("Workspace already owns another repository")
      return
    }
    await ws.fs.mkdir("/workspace", { recursive: true })
    // A failed clone is never exposed as a ready workspace. Retry only its partial checkout.
    await ws.fs.rm("/workspace/repo", { recursive: true, force: true })
    await ws.git.clone({ url: `https://github.com/${repository}.git`, dir: "/workspace/repo", ref: branch,
      headers: token ? { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } : undefined })
    await this.ctx.storage.put("repository", repository)
  }

  async gitNetwork(repository: string, operation: "fetch" | "push", branch: string | undefined, token: string) {
    if (await this.ctx.storage.get<string>("repository") !== repository) throw new Error("Repository mismatch")
    const options = { dir: "/workspace/repo", url: `https://github.com/${repository}.git`, ref: branch, headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } }
    if (operation === "fetch") return this.workspace.git.fetch(options)
    return this.workspace.git.push(options)
  }
  async readBytes(path: string) {
    const target = remotePath(path)
    const stat = await this.workspace.fs.stat(target)
    if (stat.size > 4 * 1024 * 1024) throw new Error("File exceeds the 4 MiB viewer limit")
    return new Uint8Array(await new Response(await this.workspace.fs.readFile(target)).arrayBuffer())
  }
  async listFiles(path: string) {
    const directory = remotePath(path)
    return (await this.workspace.fs.readdir(directory, { limit: 1000 })).map(entry => ({ path: `${directory}/${entry.name}`.slice("/workspace/repo/".length), type: entry.isDirectory ? "directory" as const : "file" as const }))
  }
  async findFiles(query: string, type?: "file" | "directory", limit = 100) {
    const entries = await this.workspace.fs.find("/workspace/repo", "**/*", { limit: 20000 })
    return entries.filter(entry => !entry.path.includes("/.git/") && !entry.path.includes("/node_modules/") && (!type || (entry.type === "dir" ? "directory" : "file") === type) && entry.path.toLowerCase().includes(query.toLowerCase()))
      .slice(0, Math.min(limit, 1000)).map(entry => ({ path: entry.path.replace(/^\/workspace\/repo\//, ""), type: entry.type === "dir" ? "directory" as const : "file" as const }))
  }
  async vcsInfo() {
    return { branch: { current: await this.workspace.git.currentBranch({ dir: "/workspace/repo" }) } }
  }
  async branches() { return this.workspace.git.branchList({ dir: "/workspace/repo" }) }
  async changes(withPatch: boolean) {
    const options = { dir: "/workspace/repo" }
    const entries = await this.workspace.git.diffSummary(options)
    if (entries.length > 200) throw new Error("More than 200 changed files; inspect the diff with remote_shell")
    return Promise.all(entries.map(async entry => ({
      file: entry.path, additions: entry.insertions, deletions: entry.deletions,
      status: entry.status === "A" ? "added" as const : entry.status === "D" ? "deleted" as const : "modified" as const,
      patch: withPatch ? await this.workspace.git.diff({ ...options, paths: [entry.path] }) : "",
    })))
  }
  async read(path: string, offset = 0, limit = 64 * 1024) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid byte offset")
    const target = remotePath(path)
    const size = (await this.workspace.fs.stat(target)).size
    const count = Math.min(Math.max(1, limit), 128 * 1024)
    const content = await this.workspace.fs.readFile(target, { encoding: "utf8", byteOffset: offset, byteLength: count })
    return { content, size, offset, nextOffset: offset + count < size ? offset + count : null }
  }
  async files(path: string, pattern = "**/*", offset = 0) {
    return this.workspace.fs.find(remotePath(path), pattern, { limit: 200, offset: Math.max(0, offset) })
  }
  async grep(pattern: string, path = ".", offset = 0) {
    return this.workspace.fs.grep(pattern, remotePath(path), { limit: 200, offset: Math.max(0, offset) })
  }
  async write(path: string, content: string) {
    if (new TextEncoder().encode(content).length > 1024 * 1024) throw new Error("File exceeds 1 MiB")
    const target = remotePath(path)
    return this.serialize(async () => {
      await this.workspace.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true })
      await this.workspace.fs.writeFile(target, content)
      return { path: target }
    })
  }
  async edit(path: string, before: string, after: string) {
    if (!before) throw new Error("oldText must not be empty")
    return this.serialize(async () => {
      const target = remotePath(path)
      const source = await this.workspace.fs.readFile(target, "utf8")
      if (source.length > 1024 * 1024) throw new Error("File exceeds 1 MiB")
      if (!source.includes(before)) throw new Error("oldText was not found; read the file again")
      if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("oldText is ambiguous; include more context")
      await this.workspace.fs.writeFile(target, source.replace(before, () => after))
      return { path: target }
    })
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation)
    this.writes = next.catch(() => undefined)
    return next
  }
  async start(command: string, cwd = "/workspace/repo", timeoutMs = 120000, stdin?: string, env?: Record<string, string>, backend: ExecutionBackend = "worker-shell") {
    if (typeof command !== "string" || !command.trim() || command.length > 64000) throw new Error("Invalid command")
    if (!Number.isFinite(timeoutMs)) throw new Error("Invalid timeout")
    backend = executionBackend(backend)
    cwd = remotePath(cwd)
    if (this.jobs.size + this.starting >= 4) throw new Error("Four executions are already running in this workspace")
    const id = crypto.randomUUID()
    const run: RemoteRun = { id, backend, status: "running", stdout: "", stderr: "", output: "" }
    this.starting++
    try {
      await this.ctx.storage.put(`run:${id}`, run)
      const work = this.execute(run, command, cwd, Math.min(Math.max(timeoutMs || 180000, 1000), 180000), stdin, env)
      this.jobs.set(id, work)
      this.ctx.waitUntil(work.finally(() => this.jobs.delete(id)))
      return run
    } finally { this.starting-- }
  }
  private async execute(run: RemoteRun, command: string, cwd: string, timeoutMs: number, stdin?: string, env?: Record<string,string>) {
    let savedAt = 0
    try {
      using handle = await this.workspace.runtime.exec(command, { id: run.id, backend: run.backend, cwd, timeoutMs, stdin, env, encoding: "utf8" })
      if (this.cancelled.has(run.id)) await handle.kill("SIGINT")
      const reader = handle.getReader()
      while (true) {
        const item = await reader.read()
        if (item.done) break
        const event = item.value
        if (event.name === "stdout" || event.name === "stderr") {
          const room = maxOutput - run.stdout.length - run.stderr.length
          const chunk = event.value.slice(0, Math.max(0, room))
          run[event.name] += chunk
          run.output = (run.output ?? "") + chunk
          if (event.value.length > room) run.truncated = true
        }
        if (event.name === "exit") { run.exitCode = event.code; run.resultJSON = JSON.stringify(event.result) }
        if (Date.now() - savedAt > 300) {
          await this.ctx.storage.put(`run:${run.id}`, run)
          savedAt = Date.now()
        }
      }
      run.status = run.exitCode === 0 ? "completed" : this.cancelled.has(run.id) || [130,137,143].includes(run.exitCode ?? -1) ? "cancelled" : "failed"
      if (run.exitCode === undefined) run.error = "Execution ended without an exit status"
    } catch (error) {
      run.status = "failed"
      run.error = String(error)
    }
    const deadline = this.deadlines.get(run.id)
    if (deadline) clearTimeout(deadline)
    this.deadlines.delete(run.id)
    this.cancelled.delete(run.id)
    await this.ctx.storage.put(`run:${run.id}`, run)
  }
  async run(id: string): Promise<RemoteRun> {
    const run = await this.ctx.storage.get<RemoteRun>(`run:${id}`)
    if (!run) throw new Error("Execution not found")
    if (run.status === "running" && !this.jobs.has(id)) {
      run.status = "failed"
      run.error = "Execution observer restarted. Inspect the checkout before retrying; the command may have run."
      await this.ctx.storage.put(`run:${id}`, run)
    }
    return run
  }
  async stop(id: string) {
    const run = await this.run(id)
    if (run.status !== "running") return
    this.cancelled.add(id)
    await this.workspace.runtime.killExec(id, { backend: run.backend, signal: "SIGINT" }).catch(() => undefined)
    this.ctx.waitUntil(new Promise<void>(resolve => setTimeout(async () => {
      try { if ((await this.run(id)).status === "running") await this.workspace.runtime.killExec(id, { backend: run.backend, signal: "SIGKILL" }) }
      catch {} finally { resolve() }
    }, 3000)))
  }
  async timeout(id: string, duration: number) {
    if (!Number.isFinite(duration) || duration < 0) throw new Error("Invalid timeout")
    const old = this.deadlines.get(id)
    if (old) clearTimeout(old)
    this.deadlines.delete(id)
    if (duration > 0) this.deadlines.set(id, setTimeout(() => { this.ctx.waitUntil(this.stop(id)) }, Math.min(duration, 180000)))
  }
  async forget(id: string) {
    const run = await this.run(id)
    if (run.status === "running") throw new Error("Stop execution and wait for completion before removing it")
    await this.workspace.runtime.disposeExec(id, { backend: run.backend }).catch(() => undefined)
    await this.ctx.storage.delete(`run:${id}`)
  }
}
