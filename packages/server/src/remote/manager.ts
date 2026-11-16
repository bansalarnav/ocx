import type { CreateWorkspace, Workspace } from "@ocx/protocol/workspaces"
import { httpsRepository, validID } from "@ocx/protocol/workspaces"
import { RepositoryStore, type ArtifactBinding } from "./artifacts"
import { Compute, quote, type ComputeEnv } from "./maritime"
import { filesystemProgram } from "./tools"
import checkpointRuntime from "./checkpoint-runtime.generated.txt"
import { Patch } from "@opencode/util/patch"
import { Result } from "effect"
import { githubToken, type GitHubEnv } from "./github"

export interface WorkspaceEnv extends ComputeEnv, GitHubEnv {
  ARTIFACTS?: ArtifactBinding
  GITHUB_TOKEN?: string
}

export interface WorkspaceStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<unknown>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
  transaction?<T>(action: (storage: WorkspaceStorage) => Promise<T>): Promise<T>
}
type OpenCodeAPI = (path: string, method?: string, body?: unknown) => Promise<any>
export interface WorkspaceDependencies {
  compute?: Pick<Compute, "create" | "run" | "pause" | "url">
  repositories?: Pick<RepositoryStore, "create" | "access">
}
const key = (id: string) => `ocx/workspaces/${validID(id)}`
interface ManagedWorkspace extends Workspace {
  provisioning?: { source?: string; sourceBranch?: string; checkpointRef?: string; newBranch?: string; checkoutReady?: boolean }
}

const inspectCheckout = String.raw`
import json,os,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]).absolute()
if os.path.realpath(p)!=str(p): raise ValueError('Workspace path contains a symlink')
if not p.exists(): result={'state':'absent'}
elif not p.is_dir(): raise ValueError('Workspace path is not a directory')
elif not any(p.iterdir()): result={'state':'empty'}
else:
 def git(*args):
  r=subprocess.run(['git','-C',str(p),*args],capture_output=True,text=True)
  return r.stdout.strip() if r.returncode==0 else None
 if (p/'.git').is_symlink() or git('rev-parse','--show-toplevel')!=str(p) or git('rev-parse','--is-bare-repository')!='false': raise ValueError('Existing workspace is not its own safe Git checkout')
 marker=p/'.git'/'ocx-restored-checkpoint.json'
 result={'state':'checkout','origin':git('config','--get','remote.origin.url'),'branch':git('symbolic-ref','--short','HEAD'),'restored':json.loads(marker.read_text()) if marker.is_file() else None}
print(json.dumps(result))
`

export class WorkspaceManager {
  private readonly locks = new Map<string, Promise<unknown>>()
  private compute?: Pick<Compute, "create" | "run" | "pause" | "url">
  constructor(readonly storage: WorkspaceStorage, readonly env: WorkspaceEnv, readonly api: OpenCodeAPI, private readonly dependencies: WorkspaceDependencies = {}) {}

  private repositories() {
    if (this.dependencies.repositories) return this.dependencies.repositories
    if (!this.env.ARTIFACTS) throw new Error("Configure the ARTIFACTS binding to enable remote workspaces")
    return new RepositoryStore(this.env.ARTIFACTS)
  }
  private machine() { return this.compute ??= this.dependencies.compute ?? new Compute(this.env) }
  async list() { return [...(await this.storage.list<ManagedWorkspace>({ prefix: "ocx/workspaces/" })).values()] }
  async get(id: string) {
    const workspace = await this.storage.get<ManagedWorkspace>(key(id))
    if (!workspace) throw new Error("Workspace not found")
    return workspace
  }
  async resolve(directory: string) {
    return (await this.list()).find(w => directory === w.root || directory.startsWith(w.root + "/"))
  }
  async forSession(id: string) {
    const known = (await this.list()).find(w => w.sessionIDs.includes(id))
    if (known) return known
    try {
      const workspace = await this.resolve((await this.api(`/api/session/${validID(id)}`)).data.location.directory)
      if (workspace && !workspace.sessionIDs.includes(id)) {
        return this.update(workspace.id, current => {
          if (!current.sessionIDs.includes(id)) current.sessionIDs.push(id)
        })
      }
      return workspace
    } catch { return undefined }
  }
  private save(workspace: Workspace) {
    workspace.updatedAt = Date.now()
    return this.storage.put(key(workspace.id), workspace)
  }
  /** Network operations must never write back a snapshot of ownership metadata. */
  private async update(id: string, change: (current: ManagedWorkspace) => void) {
    const mutate = async (storage: WorkspaceStorage) => {
      const current = await storage.get<ManagedWorkspace>(key(id))
      if (!current) throw new Error("Workspace not found")
      change(current)
      current.updatedAt = Date.now()
      await storage.put(key(id), current)
      return current
    }
    return this.storage.transaction
      ? this.storage.transaction(mutate)
      : this.exclusive(`metadata:${id}`, () => mutate(this.storage))
  }
  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    this.locks.set(id, current)
    try { return await current } finally { if (this.locks.get(id) === current) this.locks.delete(id) }
  }

  /** Allocate before uploading a local checkpoint. No compute is started yet. */
  async allocate(input: CreateWorkspace) {
    const id = input.id ? validID(input.id) : crypto.randomUUID()
    return this.exclusive(`allocate:${id}`, async () => {
    const existing = await this.storage.get<Workspace>(key(id))
    if (existing) return { workspace: existing, access: await this.access(id) }
    const source = input.source ? httpsRepository(input.source) : undefined
    const repository = `ocx-${id}`
    let access
    try { access = await this.repositories().create(repository) }
    catch (error) {
      if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error
      // Artifacts creation can succeed before the Worker saves its metadata.
      access = await this.repositories().access(repository)
    }
    const workspace: Workspace = {
      id, repository, remote: access.url, root: `/tmp/ocx-workspaces/${id}/repo`,
      name: input.name ?? input.source ?? "Remote workspace", branch: input.branch,
      source,
      state: "preparing", generation: 0, sessionIDs: [], createdAt: Date.now(), updatedAt: Date.now(),
    }
    await this.save(workspace)
    return { workspace, access }
    })
  }

  async access(id: string, scope: "read" | "write" = "write") {
    return this.repositories().access((await this.get(id)).repository, scope)
  }

  async run(id: string, command: string, options: { timeoutSeconds?: number; signal?: AbortSignal; stdin?: string } = {}) {
    let workspace = await this.get(id)
    if (!workspace.sandboxID) throw new Error("Workspace has no sandbox")
    if (workspace.state === "paused") workspace = await this.update(id, current => {
      if (current.state === "paused") current.state = "ready"
    })
    if (!workspace.sandboxID) throw new Error("Workspace has no sandbox")
    return this.machine().run(workspace.sandboxID, command, options)
  }
  private async checked(id: string, command: string, timeoutSeconds = 120) {
    const result = await this.run(id, command, { timeoutSeconds })
    if (result.exitCode !== 0) throw new Error(`Workspace command failed: ${result.stderr || result.stdout}`)
    return result.stdout.trim()
  }
  private async checkpointCommand(id: string, options: Record<string, unknown>) {
    return this.checked(id, `printf %s ${quote(JSON.stringify(options))} | node --input-type=module -e ${quote(checkpointRuntime)}`, 300)
  }

  async provision(id: string, checkpointRef?: string, newBranch?: string) {
    return this.exclusive(id, async () => {
      let workspace = await this.get(id)
      if (workspace.state === "ready" || workspace.state === "paused") return workspace
      if (!["preparing", "failed"].includes(workspace.state)) throw new Error("Workspace ownership prevents provisioning")
      const generation = workspace.generation
      try {
        const started = workspace.provisioning
        if (started && ((checkpointRef !== undefined && checkpointRef !== started.checkpointRef) || (newBranch !== undefined && newBranch !== started.newBranch)))
          throw new Error("Provisioning already started with different checkout settings")
        workspace = await this.update(id, current => {
          current.provisioning ??= { source: current.source, sourceBranch: current.branch, checkpointRef, newBranch }
          current.state = "preparing"
          current.error = undefined
        })
        const plan = workspace.provisioning!
        if (!workspace.sandboxID) {
          const sandboxID = await this.machine().create(id)
          workspace = await this.update(id, current => { current.sandboxID ??= sandboxID })
        }
        await this.checked(id, "command -v git && command -v node && command -v python3 && command -v rg && command -v bash && command -v stat && command -v dd && command -v find")
        const access = await this.access(id)
        const checkout = JSON.parse(await this.checked(id, `python3 -c ${quote(inspectCheckout)} ${quote(workspace.root)}`)) as {
          state: "absent" | "empty" | "checkout"; origin?: string; branch?: string;
          restored?: { ref?: string; manifest?: { workspaceID?: string } };
        }
        if (checkout.state === "checkout") {
          if (plan.checkpointRef ? checkout.restored?.ref !== plan.checkpointRef || checkout.restored.manifest?.workspaceID !== id : checkout.origin !== plan.source)
            throw new Error("Existing checkout does not match this workspace's provisioning source")
        } else if (plan.checkpointRef) {
          await this.checkpointCommand(id, { action: "restore", directory: workspace.root, remote: access, ref: plan.checkpointRef })
        } else {
          if (!plan.source) throw new Error("A repository or uploaded checkpoint is required")
          const token = await githubToken(this.storage, this.env)
          const credential = token ? `-c ${quote(`http.https://github.com/.extraHeader=Authorization: Basic ${btoa(`x-access-token:${token}`)}`)}` : ""
          const branch = plan.sourceBranch ? `--branch ${quote(plan.sourceBranch)}` : ""
          await this.checked(id, `mkdir -p ${quote(workspace.root.substring(0, workspace.root.lastIndexOf("/")))} && git ${credential} clone ${branch} -- ${quote(plan.source)} ${quote(workspace.root)}`, 600)
        }
        await this.update(id, current => { current.provisioning!.checkoutReady = true })
        if (plan.newBranch) {
          const branch = await this.checked(id, `git -C ${quote(workspace.root)} symbolic-ref --short HEAD`)
          if (branch !== plan.newBranch) await this.checked(id, `git -C ${quote(workspace.root)} switch -c ${quote(plan.newBranch)}`)
          await this.update(id, current => { current.branch = plan.newBranch })
        }
        await this.checkpoint(id)
        return this.update(id, current => {
          if (current.generation !== generation || current.state !== "preparing") throw new Error("Workspace ownership changed during provisioning")
          current.state = "ready"
          current.error = undefined
        })
      } catch (error) {
        await this.update(id, current => {
          if (current.generation === generation && ["preparing", "failed"].includes(current.state)) {
            current.state = "failed"
            current.error = error instanceof Error ? error.message : "Workspace provisioning failed"
          }
        })
        throw error
      }
    })
  }

  async checkpoint(id: string) {
    return this.exclusive(`checkpoint:${id}`, async () => {
      const workspace = await this.get(id)
      const access = await this.access(id)
      const result = JSON.parse(await this.checkpointCommand(id, { action: "capture", directory: workspace.root, workspaceID: id, remote: access })) as { ref: string }
      await this.update(id, current => { current.checkpointRef = result.ref })
      return result.ref
    })
  }

  async createSession(id: string, input: { title?: string; prompt?: string; model?: unknown } = {}) {
    return this.exclusive(id, async () => {
    const workspace = await this.get(id)
    if (workspace.state !== "ready" && workspace.state !== "paused") throw new Error("Workspace is not ready")
    const result = await this.api("/api/session", "POST", { title: input.title, model: input.model, location: { directory: workspace.root } })
    await this.update(id, current => {
      if (!current.sessionIDs.includes(result.data.id)) current.sessionIDs.push(result.data.id)
    })
    if (input.prompt) await this.api(`/api/session/${result.data.id}/prompt`, "POST", { text: input.prompt })
    return result.data
    })
  }

  async tool(id: string, name: string, input: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const workspace = await this.get(id)
    if (!["ready", "paused"].includes(workspace.state)) throw new Error("Workspace is not available for execution")
    if (name === "shell") {
      const workdir = String(input.workdir ?? workspace.root)
      // File helpers check real paths. Shell itself executes inside the sandbox.
      const result = await this.run(id, `cd ${quote(workdir.startsWith("/") ? workdir : workspace.root + "/" + workdir)} && ${String(input.command)}`, { timeoutSeconds: Math.ceil((input.timeout ?? 120000) / 1000), signal })
      await this.checkpoint(id)
      return `${result.stdout}${result.stderr}\nExit code: ${result.exitCode}`
    }
    if (name === "patch") {
      const parsed = Patch.parse(String(input.patchText))
      if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
      for (const hunk of parsed.success) {
        if (hunk.type === "delete") {
          await this.checked(id, `python3 -c ${quote("import pathlib,sys; r=pathlib.Path(sys.argv[1]).resolve(); p=(r/sys.argv[2]).resolve(); assert p.is_relative_to(r); p.unlink()")} ${quote(workspace.root)} ${quote(hunk.path)}`)
        } else {
          const original = hunk.type === "update" ? await this.run(id, `python3 -c ${quote("import pathlib,sys; r=pathlib.Path(sys.argv[1]).resolve(); p=(r/sys.argv[2]).resolve(); assert p.is_relative_to(r); print(p.read_text(),end='')")} ${quote(workspace.root)} ${quote(hunk.path)}`) : undefined
          if (original && original.exitCode !== 0) throw new Error(original.stderr)
          const content = hunk.type === "add" ? hunk.contents : original!.stdout
          const updated = hunk.type === "update" ? Patch.derive(hunk.path, hunk.chunks, content) : undefined
          await this.tool(id, "write", { path: hunk.type === "update" ? hunk.movePath ?? hunk.path : hunk.path, content: updated ? Patch.joinBom(updated.content, updated.bom) : content }, signal)
          if (hunk.type === "update" && hunk.movePath) await this.checked(id, `python3 -c ${quote("import pathlib,sys; r=pathlib.Path(sys.argv[1]).resolve(); p=(r/sys.argv[2]).resolve(); assert p.is_relative_to(r); p.unlink()")} ${quote(workspace.root)} ${quote(hunk.path)}`)
        }
      }
      await this.checkpoint(id)
      return "Patch applied"
    }
    const result = await this.run(id, `python3 -c ${quote(filesystemProgram)} ${quote(workspace.root)} ${quote(name)} ${quote(JSON.stringify(input))}`, { signal })
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    if (["write", "edit"].includes(name)) await this.checkpoint(id)
    return result.stdout
  }

  async pause(id: string) {
    return this.exclusive(id, async () => {
      const workspace = await this.get(id)
      if (!["ready", "paused"].includes(workspace.state)) throw new Error("Workspace ownership prevents pausing")
      await this.checkpoint(id)
      await this.machine().pause(workspace.sandboxID!)
      return this.update(id, current => {
        if (current.generation !== workspace.generation || !["ready", "paused"].includes(current.state)) throw new Error("Workspace ownership changed while pausing")
        current.state = "paused"
      })
    })
  }
  async preview(id: string, port: number) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port")
    const workspace = await this.get(id)
    if (!["ready", "paused"].includes(workspace.state)) throw new Error("Workspace is not available for previews")
    return this.machine().url(workspace.sandboxID!, port)
  }

  async pullRequest(id: string, input: { title: string; body?: string; base?: string }) {
    return this.exclusive(id, async () => {
      if (!input.title?.trim()) throw new Error("A pull request title is required")
      const workspace = await this.get(id)
      if (!["ready", "paused"].includes(workspace.state)) throw new Error("Workspace is not ready")
      const source = workspace.source && new URL(workspace.source)
      if (!source || source.hostname !== "github.com") throw new Error("Workspace needs a GitHub source repository")
      const repository = source.pathname.replace(/^\//, "").replace(/\.git$/, "")
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository")
      const token = await githubToken(this.storage, this.env)
      if (!token) throw new Error("Connect GitHub before creating a pull request")
      const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "ocx", "x-github-api-version": "2022-11-28" }
      const metadata = await fetch(`https://api.github.com/repos/${repository}`, { headers })
      if (!metadata.ok) throw new Error(`GitHub repository access failed (${metadata.status})`)
      const base = input.base ?? (await metadata.json() as { default_branch: string }).default_branch
      const git = `git -C ${quote(workspace.root)}`
      let branch = await this.checked(id, `${git} symbolic-ref --short HEAD`)
      if (branch === base) {
        branch = `ocx/${id}`
        await this.checked(id, `${git} switch -c ${quote(branch)}`)
      }
      const dirty = await this.checked(id, `${git} status --porcelain`)
      if (dirty) await this.checked(id, `${git} add -A && ${git} -c user.name=OpenCode -c user.email=opencode@localhost commit -m ${quote(input.title)}`)
      const header = `http.https://github.com/.extraHeader=Authorization: Basic ${btoa(`x-access-token:${token}`)}`
      await this.checked(id, `${git} -c ${quote(header)} push -- ${quote(workspace.source!)} ${quote(`HEAD:refs/heads/${branch}`)}`, 300)
      await this.checkpoint(id)
      const owner = repository.split("/")[0]
      const existing = await fetch(`https://api.github.com/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`, { headers })
      if (!existing.ok) throw new Error(`GitHub PR lookup failed (${existing.status})`)
      const open = await existing.json() as { html_url: string }[]
      if (open[0]) return { url: open[0].html_url, branch }
      const response = await fetch(`https://api.github.com/repos/${repository}/pulls`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title: input.title, body: input.body ?? "", head: branch, base }),
      })
      if (!response.ok) throw new Error(`GitHub PR creation failed (${response.status})`)
      return { url: (await response.json() as { html_url: string }).html_url, branch }
    })
  }
}
