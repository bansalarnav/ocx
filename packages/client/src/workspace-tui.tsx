import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { ExecutionBackend, RemoteRun, RemoteWorkspace } from "@ocx/protocol/workspaces"

export default Plugin.define({
  id: "ocx-remote-workspaces",
  setup(ctx) {
    const [current, setCurrent] = createSignal<RemoteWorkspace | null>(null)
    const controller = new AbortController()
    let busy = false
    async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
      const response = await fetch(`${process.env.OCX_PROXY_ORIGIN}/api/remote${path}`, {
        method, signal: controller.signal,
        headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(await response.text())
      if (response.status === 204) return undefined as T
      return response.json() as Promise<T>
    }
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 700))
    const guarded = (work: () => Promise<void>) => async () => {
      if (busy) return
      busy = true
      try { await work() } catch (error) {
        if (!controller.signal.aborted) ctx.ui.toast.show({ variant: "error", message: String(error), duration: 10000 })
      } finally { busy = false }
    }
    async function attach(id: string) {
      await writeFile(join(process.env.OCX_CONTROL_DIR!, "workspace.json"), JSON.stringify({ id }), { mode: 0o600 })
      ctx.ui.dialog.clear()
      ctx.keymap.dispatch("app.exit")
    }
    async function login() {
      const account = await api<{ user: string | null }>("/github")
      const path = await ctx.ui.dialog.prompt({
        title: account.user ? `GitHub · ${account.user}` : "Connect GitHub",
        description: "Enter the local path to a file containing your GitHub token. The token is sent to this server and kept outside chat and repository files.",
        placeholder: "~/.config/ocx/github-token",
      })
      if (!path?.trim()) return
      const filename = path.trim().replace(/^~\//, homedir() + "/")
      if ((await stat(filename)).size > 4096) throw new Error("Token file exceeds 4 KiB")
      const token = (await readFile(filename, "utf8")).trim()
      const result = await api<{ user: string }>("/github", { token })
      ctx.ui.toast.show({ variant: "success", message: `Connected GitHub as ${result.user}` })
    }
    async function clone() {
      const repository = await ctx.ui.dialog.prompt({ title: "Clone remote repository", placeholder: "owner/repo or https://github.com/owner/repo", description: "Use /github first for private repositories." })
      if (!repository) return
      const branch = await ctx.ui.dialog.prompt({ title: "Base branch", placeholder: "Leave empty for the repository default" })
      if (branch === undefined) return
      const row = await api<RemoteWorkspace>("/workspaces", { id: crypto.randomUUID(), repository, branch })
      await waitForClone(row.id)
    }
    async function waitForClone(id: string) {
      let open = true
      const [status, setStatus] = createSignal("Cloning repository remotely…")
      ctx.ui.dialog.show(() => <box flexDirection="column" padding={2} gap={1}>
        <text fg={ctx.theme.text}>{status()}</text>
        <text fg={ctx.theme.textMuted}>Esc leaves cloning in progress. Resume it from /workspaces.</text>
      </box>, () => { open = false })
      while (open && !controller.signal.aborted) {
        const rows = await api<RemoteWorkspace[]>("/workspaces")
        const row = rows.find(row => row.id === id)
        if (!row) throw new Error("Workspace disappeared")
        setStatus(`${row.repository} · ${row.status}`)
        if (row.status === "ready") { await attach(id); return }
        if (row.status === "failed") { ctx.ui.dialog.clear(); throw new Error(row.error || "Clone failed") }
        await delay()
      }
    }
    async function workspaces() {
      const rows = await api<RemoteWorkspace[]>("/workspaces")
      const selected = await ctx.ui.dialog.select({ title: "Remote workspaces", options: [
        { title: "Clone repository", value: "new", description: "Create another remote checkout on this server" },
        ...rows.map(row => ({ title: row.repository, value: row.id, description: `${row.branch || "default branch"} · ${row.status} · ${row.id.slice(0,8)}` })),
      ] })
      if (!selected) return
      if (selected === "new") return clone()
      const row = rows.find(row => row.id === selected)!
      if (row.status === "ready") return attach(row.id)
      if (row.status === "failed") {
        const retry = await ctx.ui.dialog.confirm({ title: "Retry clone", message: row.error || "Clone failed" })
        if (!retry) return
        await api(`/workspaces/${row.id}/retry`, {})
      }
      await waitForClone(row.id)
    }
    async function shell(command?: string, backend: ExecutionBackend = "worker-shell") {
      if (!current()) throw new Error("Attach a repository using /workspaces first")
      const javascript = backend === "worker-javascript"
      command ??= await ctx.ui.dialog.prompt(javascript
        ? { title: "Remote JavaScript", description: "ES module in V8. Put I/O inside an async default export. Relative imports use /workspace/repo.", placeholder: "export default () => ({ answer: 6 * 7 })" }
        : { title: "Remote shell", description: "just-bash in a Worker, using /workspace/repo. Native programs and package installs are unavailable.", placeholder: "git status --short" })
      if (!command?.trim()) return
      const run = await api<RemoteRun>("/exec", { command, backend })
      const [output, setOutput] = createSignal(javascript ? "Running JavaScript in a Worker…" : "Running in a Worker. Shell output appears when the command finishes…")
      let open = true
      let running = true
      ctx.ui.dialog.show(() => <box flexDirection="column" padding={2} gap={1}>
        <text fg={ctx.theme.text}>Remote · {command}</text>
        <text fg={ctx.theme.textMuted}>{output()}</text>
        <text fg={ctx.theme.textMuted}>Esc closes and interrupts a running command.</text>
      </box>, () => {
        open = false
        if (running) void api(`/exec/${run.id}`, undefined, "DELETE").catch(() => {})
      })
      while (open && !controller.signal.aborted) {
        const result = await api<RemoteRun>(`/exec/${run.id}`)
        running = result.status === "running"
        setOutput((result.output ?? result.stdout + result.stderr).slice(-12000) + (running ? "" : `${result.resultJSON ? "\n" + result.resultJSON.slice(0,12000) : ""}\nExit ${result.exitCode ?? "unknown"}${result.error ? "\n" + result.error : ""}`))
        if (!running) return
        await delay()
      }
    }
    const commands = [
      { id: "ocx.workspaces", title: "Remote workspaces", slash: { name: "workspaces" }, run: guarded(workspaces) },
      { id: "ocx.github", title: "Connect GitHub remotely", slash: { name: "github" }, run: guarded(login) },
      { id: "ocx.shell", title: "Run remote shell command", slash: { name: "remote-shell" }, run: guarded(() => shell()) },
      { id: "ocx.javascript", title: "Run remote JavaScript", slash: { name: "remote-js" }, run: guarded(() => shell(undefined, "worker-javascript")) },
      { id: "ocx.changes", title: "Review remote changes", slash: { name: "remote-changes" }, run: guarded(() => shell("git status --short && git diff --stat && git diff")) },
    ]
    const cleanup = ctx.ui.slot({ append: "prompt.footer.status", render: () => {
      ctx.keymap.layer(() => ({ mode: "global", commands: commands.map(command => ({ ...command, palette: true as const, group: "Remote" })) }))
      return <text fg={ctx.theme.textMuted}>{current() ? `remote · ${current()!.repository}` : "remote · /workspaces"}</text>
    } })
    void api<RemoteWorkspace | null>("/current").then(setCurrent).catch(() => {})
    return () => { controller.abort(); cleanup() }
  },
})
