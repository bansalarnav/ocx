import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

export interface CheckpointManifest {
  version: 1
  workspaceID: string
  head: string
  branch: string | null
  source?: string
  createdAt: string
  indexTree: string
  worktreeTree: string
  untrackedTree: string
}

export interface GitCheckpoint {
  id: string
  ref: string
  commit: string
  manifest: CheckpointManifest
}

export interface CheckpointRemote {
  url: string
  /** Artifacts Git bearer token. Never stored in the repository configuration. */
  token?: string
}

export function validateCheckpointID(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid checkpoint ID")
  return id
}

/** Only a credential-free HTTPS origin is portable to another machine. */
export async function repositoryOrigin(directory: string): Promise<string | undefined> {
  let remote: string
  try { remote = await output(directory, ["remote", "get-url", "origin"]) } catch { return }
  const githubSSH = remote.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/)
  if (githubSSH) remote = `https://github.com/${githubSSH[1]}`
  try {
    const url = new URL(remote)
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url.toString()
  } catch {}
}

function checkpointRef(ref: string): string {
  const prefix = "refs/ocx/checkpoints/"
  if (!ref.startsWith(prefix)) throw new Error("Invalid checkpoint ref")
  validateCheckpointID(ref.slice(prefix.length))
  return ref
}

interface GitOptions {
  env?: NodeJS.ProcessEnv
  input?: string | Uint8Array
  token?: string
}

async function git(directory: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd: directory,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.stdin.on("error", () => {})
    child.once("close", code => {
      if (code === 0) return resolveResult(Buffer.concat(stdout))
      let message = Buffer.concat(stderr).toString("utf8").trim()
      if (options.token) message = message.replaceAll(options.token, "[redacted]")
      reject(new Error(`Git ${args[0]} failed (${code}): ${message}`))
    })
    child.stdin.end(options.input)
  })
}

const output = async (directory: string, args: string[], options?: GitOptions) =>
  (await git(directory, args, options)).toString("utf8").trim()

function remoteOptions(remote: CheckpointRemote): GitOptions {
  if (!remote.url || remote.url.startsWith("-")) throw new Error("Invalid Git remote")
  if (!remote.token) return {}
  let url: URL
  try { url = new URL(remote.url) } catch { throw new Error("Invalid Git remote URL") }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Authenticated checkpoint remotes must use HTTPS without URL credentials")
  if (/[\r\n\0]/.test(remote.token)) throw new Error("Invalid Git bearer token")
  return {
    token: remote.token,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${remote.token}`,
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function temporaryIndex<A>(body: (env: NodeJS.ProcessEnv, path: string) => Promise<A>): Promise<A> {
  const directory = await mkdtemp(join(tmpdir(), "ocx-checkpoint-"))
  const index = join(directory, "index")
  try { return await body({ GIT_INDEX_FILE: index }, index) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

/** Capture without changing the source branch, index, or working files. */
export async function captureCheckpoint(input: {
  directory: string
  workspaceID: string
  id?: string
}): Promise<GitCheckpoint> {
  if (!input.workspaceID || input.workspaceID.length > 200) throw new Error("Invalid workspace ID")
  const directory = await output(input.directory, ["rev-parse", "--show-toplevel"])
  const id = validateCheckpointID(input.id ?? randomUUID())
  const ref = checkpointRef(`refs/ocx/checkpoints/${id}`)
  const head = await output(directory, ["rev-parse", "--verify", "HEAD^{commit}"])
  const name = await output(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
  const branch = name === "HEAD" ? null : name
  for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = resolve(directory, await output(directory, ["rev-parse", "--git-path", operation]))
    if (await exists(path)) throw new Error(`Finish the in-progress Git operation before transfer: ${operation}`)
  }
  return temporaryIndex(async (env, index) => {
    const sourceIndex = resolve(directory, await output(directory, ["rev-parse", "--git-path", "index"]))
    const originalIndex = await exists(sourceIndex) ? await readFile(sourceIndex) : undefined
    if (originalIndex) await copyFile(sourceIndex, index)
    else await git(directory, ["read-tree", head], { env })
    if ((await git(directory, ["ls-files", "--unmerged", "-z"], { env })).length)
      throw new Error("Resolve index conflicts before transferring the workspace")
    const indexTree = await output(directory, ["write-tree"], { env })
    await treeEntries(directory, indexTree)
    await git(directory, ["add", "--update", "--", "."], { env })
    const worktreeTree = await output(directory, ["write-tree"], { env })
    const untracked = await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"])
    await git(directory, ["read-tree", "--empty"], { env })
    if (untracked.length) await git(directory, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: untracked })
    const untrackedTree = await output(directory, ["write-tree"], { env })
    await treeEntries(directory, untrackedTree)
    const currentHead = await output(directory, ["rev-parse", "HEAD"])
    const currentIndex = await exists(sourceIndex) ? await readFile(sourceIndex) : undefined
    if (currentHead !== head || !equalBytes(originalIndex, currentIndex))
      throw new Error("The repository HEAD or index changed during capture; retry the transfer")
    const manifest: CheckpointManifest = {
      version: 1, workspaceID: input.workspaceID, head, branch, createdAt: new Date().toISOString(),
      indexTree, worktreeTree, untrackedTree,
      source: await repositoryOrigin(directory),
    }
    const manifestBlob = await output(directory, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(manifest) })
    const tree = await output(directory, ["mktree"], { input: [
      `100644 blob ${manifestBlob}\tmanifest.json`,
      `040000 tree ${indexTree}\tindex`,
      `040000 tree ${worktreeTree}\tworktree`,
      `040000 tree ${untrackedTree}\tuntracked`,
      "",
    ].join("\n") })
    const commit = await output(directory, ["commit-tree", tree, "-p", head], {
      input: "OpenCode workspace checkpoint\n",
      env: {
        GIT_AUTHOR_NAME: "OpenCode", GIT_AUTHOR_EMAIL: "checkpoint@opencode.local",
        GIT_COMMITTER_NAME: "OpenCode", GIT_COMMITTER_EMAIL: "checkpoint@opencode.local",
      },
    })
    // An immutable ref avoids silently replacing an earlier transfer's checkpoint.
    await git(directory, ["update-ref", ref, commit, "0".repeat(head.length)])
    return { id, ref, commit, manifest }
  })
}

function equalBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.equals(b)
}

export async function pushCheckpoint(directory: string, checkpoint: Pick<GitCheckpoint, "ref" | "commit">, remote: CheckpointRemote): Promise<void> {
  checkpointRef(checkpoint.ref)
  if (!/^[a-f0-9]{40,64}$/.test(checkpoint.commit)) throw new Error("Invalid checkpoint commit")
  await git(directory, ["push", "--", remote.url, `${checkpoint.commit}:${checkpoint.ref}`], remoteOptions(remote))
}

export async function fetchCheckpoint(directory: string, remote: CheckpointRemote, ref: string): Promise<GitCheckpoint> {
  checkpointRef(ref)
  await git(directory, ["fetch", "--no-tags", "--", remote.url, ref], remoteOptions(remote))
  const commit = await output(directory, ["rev-parse", "FETCH_HEAD^{commit}"])
  return loadCheckpoint(directory, commit, ref)
}

/** Recover a completed capture if the client exited before saving its receipt. */
export async function findLocalCheckpoint(directory: string, id: string): Promise<GitCheckpoint | undefined> {
  const ref = checkpointRef(`refs/ocx/checkpoints/${validateCheckpointID(id)}`)
  const refs = await output(directory, ["for-each-ref", "--format=%(refname) %(objectname)", ref])
  const commit = refs.split("\n").find(line => line.startsWith(ref + " "))?.slice(ref.length + 1)
  return commit ? loadCheckpoint(directory, commit, ref) : undefined
}

interface TreeEntry { mode: string; path: string }
async function treeEntries(directory: string, tree: string): Promise<TreeEntry[]> {
  const raw = await git(directory, ["ls-tree", "-r", "-z", tree])
  if (!Buffer.from(raw.toString("utf8")).equals(raw)) throw new Error("Checkpoint paths must use UTF-8")
  return raw.toString("utf8").split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t")
    const mode = line.slice(0, line.indexOf(" "))
    const path = line.slice(tab + 1)
    if (!["100644", "100755", "120000"].includes(mode))
      throw new Error(`Unsupported Git entry ${path}; submodules must be transferred separately`)
    if (!path || isAbsolute(path) || path.split("/").some(part => ["", ".", "..", ".git"].includes(part.toLowerCase())) || path.includes("\\"))
      throw new Error("Unsafe checkpoint path")
    return { mode, path }
  })
}

export async function loadCheckpoint(directory: string, commit: string, ref: string): Promise<GitCheckpoint> {
  checkpointRef(ref)
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid checkpoint commit")
  const bytes = await git(directory, ["show", `${commit}:manifest.json`])
  if (bytes.length > 1024 * 1024) throw new Error("Checkpoint manifest is too large")
  const manifest = JSON.parse(bytes.toString("utf8")) as CheckpointManifest
  if (manifest.version !== 1 || typeof manifest.workspaceID !== "string" || !manifest.workspaceID ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      (manifest.branch !== null && typeof manifest.branch !== "string")) throw new Error("Invalid checkpoint manifest")
  for (const hash of [manifest.head, manifest.indexTree, manifest.worktreeTree, manifest.untrackedTree])
    if (typeof hash !== "string" || !/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("Invalid checkpoint object")
  if (manifest.branch !== null) await git(directory, ["check-ref-format", `refs/heads/${manifest.branch}`])
  if (manifest.source !== undefined) {
    const source = new URL(manifest.source)
    if (source.protocol !== "https:" || source.username || source.password || source.search || source.hash)
      throw new Error("Checkpoint source must be credential-free HTTPS")
  }
  if (await output(directory, ["rev-parse", `${commit}^`]) !== manifest.head)
    throw new Error("Checkpoint parent does not match the original HEAD")
  for (const [name, tree] of [["index", manifest.indexTree], ["worktree", manifest.worktreeTree], ["untracked", manifest.untrackedTree]]) {
    if (await output(directory, ["rev-parse", `${commit}:${name}`]) !== tree)
      throw new Error("Checkpoint tree does not match its manifest")
    await treeEntries(directory, tree!)
  }
  const working = await treeEntries(directory, manifest.worktreeTree)
  const untracked = await treeEntries(directory, manifest.untrackedTree)
  const workingPaths = new Set(working.map(entry => entry.path))
  const untrackedPaths = new Set(untracked.map(entry => entry.path))
  for (const entry of untracked) {
    const parts = entry.path.split("/")
    if (workingPaths.has(entry.path) || parts.slice(0, -1).some((_, i) => workingPaths.has(parts.slice(0, i + 1).join("/"))))
      throw new Error("Checkpoint untracked files overlap tracked files")
  }
  for (const entry of working) {
    const parts = entry.path.split("/")
    if (parts.slice(0, -1).some((_, i) => untrackedPaths.has(parts.slice(0, i + 1).join("/"))))
      throw new Error("Checkpoint tracked files overlap untracked files")
  }
  return { id: ref.slice("refs/ocx/checkpoints/".length), ref, commit, manifest }
}

/** Restore into an empty destination. Never changes an existing checkout. */
export async function restoreCheckpoint(input: { directory: string; remote: CheckpointRemote; ref: string }): Promise<GitCheckpoint> {
  const target = resolve(input.directory)
  checkpointRef(input.ref)
  if (await exists(target)) {
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(target)).length)
      throw new Error("Checkpoint destination must be an empty directory")
  }
  await mkdir(dirname(target), { recursive: true })
  // Prepare beside the target so a failed fetch or checkout leaves it untouched,
  // and publishing the complete checkout is a same-filesystem atomic rename.
  const directory = await mkdtemp(join(dirname(target), `.${basename(target)}.ocx-restore-`))
  try {
    await git(directory, ["init", "--quiet"])
    const checkpoint = await fetchCheckpoint(directory, input.remote, input.ref)
    const { manifest } = checkpoint
    if (manifest.branch === null) await git(directory, ["update-ref", "--no-deref", "HEAD", manifest.head])
    else {
      await git(directory, ["symbolic-ref", "HEAD", `refs/heads/${manifest.branch}`])
      await git(directory, ["update-ref", `refs/heads/${manifest.branch}`, manifest.head])
    }
    await git(directory, ["read-tree", "--reset", "-u", manifest.worktreeTree])
    // The index represents different bytes than the restored working tree.
    // Discard checkout stat caches before installing staged blobs so equal-size
    // edits cannot be mistaken for clean files on coarse timestamp filesystems.
    await git(directory, ["read-tree", "--empty"])
    await git(directory, ["read-tree", manifest.indexTree])
    await temporaryIndex(async env => {
      await git(directory, ["read-tree", manifest.untrackedTree], { env })
      await git(directory, ["checkout-index", "--all", `--prefix=${directory}/`], { env })
    })
    await git(directory, ["update-ref", input.ref, checkpoint.commit])
    if (manifest.source) await git(directory, ["remote", "add", "origin", manifest.source])
    await writeFile(join(directory, ".git", "ocx-restored-checkpoint.json"), JSON.stringify(checkpoint) + "\n", { mode: 0o600 })
    await rename(directory, target)
    return checkpoint
  } finally { await rm(directory, { recursive: true, force: true }) }
}
