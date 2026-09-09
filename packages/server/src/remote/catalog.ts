import { DurableObject } from "cloudflare:workers"
import { branchName, repositoryName, workspaceID, workspaceAPI, type RemoteWorkspace } from "@ocx/protocol/workspaces"
import type { RemoteComputer } from "./computer"

export interface RemoteEnv {
  COMPUTERS: DurableObjectNamespace<RemoteComputer>
  WORKSPACES: DurableObjectNamespace<WorkspaceCatalog>
}
export const catalog = (env: RemoteEnv) => env.WORKSPACES.get(env.WORKSPACES.idFromName("catalog"))
export const computer = (env: RemoteEnv, id: string) => env.COMPUTERS.get(env.COMPUTERS.idFromName(id))
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
export class WorkspaceCatalog extends DurableObject<RemoteEnv> {
  private cloning = new Set<string>()
  private loginLock: Promise<unknown> = Promise.resolve()
  async get(id: string) { return this.ctx.storage.get<RemoteWorkspace>(`workspace:${workspaceID(id)}`) }
  async git(id: string, operation: "fetch" | "push", branch?: string) {
    if (operation !== "fetch" && operation !== "push") throw new Error("Unsupported Git operation")
    const row = await this.get(id)
    if (!row || row.status !== "ready") throw new Error("Workspace is not ready")
    const token = await this.ctx.storage.get<string>("github:token")
    if (!token) throw new Error("Connect GitHub using /github first")
    return computer(this.env, id).gitNetwork(row.repository, operation, branchName(branch), token)
  }
  private async github(path: string, suppliedToken?: string) {
    const token = suppliedToken ?? await this.ctx.storage.get<string>("github:token")
    if (!token) throw new Error("Connect GitHub first using /github")
    const response = await fetch(`https://api.github.com${path}`, { headers: {
      Authorization: `Bearer ${token}`, "User-Agent": "ocx-remote", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    } })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub returned HTTP ${response.status}; check access or reconnect GitHub`) }
    return response.json() as Promise<any>
  }
  private async beginClone(row: RemoteWorkspace) {
    if (this.cloning.has(row.id)) return
    this.cloning.add(row.id)
    this.ctx.waitUntil((async () => {
      try {
        const token = await this.ctx.storage.get<string>("github:token")
        await computer(this.env, row.id).clone(row.repository, row.branch, token)
        row.status = "ready"
        delete row.error
      } catch (error) { row.status = "failed"; row.error = String(error) }
      await this.ctx.storage.put(`workspace:${row.id}`, row)
    })().finally(() => this.cloning.delete(row.id)))
  }
  private async connectGithub(token: unknown) {
    if (typeof token !== "string" || !token.trim() || token.length > 1024 || /\s/.test(token.trim()))
      throw new Error("Provide a GitHub token without whitespace")
    const supplied = token.trim()
    // Serialize credential replacement so concurrent submissions have a defined order.
    const work = this.loginLock.then(async () => {
      const user = await this.github("/user", supplied)
      if (typeof user.login !== "string" || !user.login) throw new Error("GitHub did not return an account identity")
      await this.ctx.storage.put({ "github:user": user.login, "github:token": supplied })
      return { user: user.login }
    })
    this.loginLock = work.catch(() => undefined)
    return work
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.slice(workspaceAPI.length)
    try {
      if (path === "/github" && request.method === "GET")
        return json({ user: await this.ctx.storage.get("github:user") ?? null })
      if (path === "/github" && request.method === "POST") {
        const input = await request.json() as { token?: unknown }
        return json(await this.connectGithub(input.token))
      }
      if (path === "/repositories" && request.method === "GET") {
        const page = Math.max(1, Math.min(100, Number(url.searchParams.get("page")) || 1))
        const repos = await this.github(`/user/repos?per_page=100&sort=pushed&page=${page}`)
        return json(repos.map((repo: any) => ({ repository: repo.full_name, branch: repo.default_branch, private: repo.private })))
      }
      if (path === "/workspaces" && request.method === "GET") {
        const rows = [...(await this.ctx.storage.list<RemoteWorkspace>({ prefix: "workspace:" })).values()]
        for (const row of rows) if (row.status === "cloning" && !this.cloning.has(row.id)) {
          row.status = "failed"
          row.error = "Clone observer restarted. Retry to recover this workspace."
          await this.ctx.storage.put(`workspace:${row.id}`, row)
        }
        return json(rows.sort((a,b) => b.createdAt - a.createdAt))
      }
      if (path === "/workspaces" && request.method === "POST") {
        const input = await request.json() as Record<string,unknown>
        const id = workspaceID(input.id)
        const repository = repositoryName(input.repository)
        const branch = branchName(input.branch)
        const row = await this.ctx.storage.transaction(async txn => {
          const previous = await txn.get<RemoteWorkspace>(`workspace:${id}`)
          if (previous) {
            if (previous.repository !== repository || previous.branch !== branch) throw new Error("Workspace ID belongs to a different clone request")
            return previous
          }
          const row: RemoteWorkspace = { id, repository, branch, directory: "/workspace/repo", status: "cloning", createdAt: Date.now() }
          await txn.put(`workspace:${id}`, row)
          return row
        })
        if (row.status === "cloning") await this.beginClone(row)
        return json(row, 202)
      }
      const retry = /^\/workspaces\/([^/]+)\/retry$/.exec(path)
      if (retry && request.method === "POST") {
        const row = await this.get(retry[1]!)
        if (!row) return json({ error: "Workspace not found" }, 404)
        if (row.status === "failed") {
          row.status = "cloning"; delete row.error
          await this.ctx.storage.put(`workspace:${row.id}`, row)
          await this.beginClone(row)
        }
        return json(row, 202)
      }
      return json({ error: "Remote endpoint not found" }, 404)
    } catch (error) { return json({ error: String(error) }, 400) }
  }
}
