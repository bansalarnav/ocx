import { afterEach, describe, expect, test } from "bun:test"
import { execFile, spawn } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { captureCheckpoint, fetchCheckpoint, pushCheckpoint, restoreCheckpoint, validateCheckpointID } from "../packages/client/src/checkpoint"
import { buildCheckpointRuntime } from "../scripts/build-checkpoint"

const exec = promisify(execFile)
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim()
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ocx-checkpoint-test-"))
  temporary.push(root)
  const source = join(root, "source repo")
  const remote = join(root, "remote.git")
  const destination = join(root, "restored repo")
  await mkdir(source)
  await git(source, "init", "--initial-branch=topic")
  await git(source, "config", "user.name", "Test")
  await git(source, "config", "user.email", "test@example.com")
  await writeFile(join(source, "text.txt"), "first\nsecond\nthird\n")
  await writeFile(join(source, "deleted.txt"), "delete me\n")
  await writeFile(join(source, "removed-later.txt"), "remove from worktree\n")
  await writeFile(join(source, "binary.bin"), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(source, "run.sh"), "#!/bin/sh\nexit 0\n")
  await writeFile(join(source, ".gitignore"), "ignored/\n")
  await git(source, "add", ".")
  await git(source, "commit", "-m", "base")
  await git(root, "init", "--bare", remote)
  return { root, source, remote, destination }
}

describe("Git workspace checkpoints", () => {
  test("the exact remote bundle captures and restores under Node without Bun", async () => {
    const { source, remote, destination } = await setup()
    await writeFile(join(source, "text.txt"), "remote runtime edit\n")
    const runtime = await readFile(await buildCheckpointRuntime(), "utf8")
    const invoke = (input: unknown) => new Promise<any>((resolveResult, reject) => {
      const child = spawn("node", ["--input-type=module", "-e", runtime], { stdio: ["pipe", "pipe", "pipe"] })
      let stdout = "", stderr = ""
      child.stdout.on("data", chunk => stdout += chunk)
      child.stderr.on("data", chunk => stderr += chunk)
      child.once("error", reject)
      child.once("close", code => {
        if (code !== 0) return reject(new Error(stderr))
        try { resolveResult(JSON.parse(stdout)) } catch (error) { reject(error) }
      })
      child.stdin.end(JSON.stringify(input))
    })
    const checkpoint = await invoke({ action: "capture", directory: source, workspaceID: "ws_node", remote: { url: remote } })
    const restored = await invoke({ action: "restore", directory: destination, remote: { url: remote }, ref: checkpoint.ref })
    expect(restored.commit).toBe(checkpoint.commit)
    expect(await readFile(join(destination, "text.txt"), "utf8")).toBe("remote runtime edit\n")
    expect(await git(destination, "status", "--porcelain")).toBe("M text.txt")
  })

  test("round-trips history, staged/unstaged binary changes, modes, symlinks, deletes and untracked files", async () => {
    const { source, remote, destination } = await setup()
    await writeFile(join(source, "unpublished.txt"), "local commit only\n")
    await git(source, "add", "unpublished.txt")
    await git(source, "commit", "-m", "not pushed upstream")
    await git(source, "remote", "add", "origin", "git@github.com:acme/private-app.git")
    const head = await git(source, "rev-parse", "HEAD")
    await writeFile(join(source, "text.txt"), "staged\nsecond\nthird\n")
    await writeFile(join(source, "binary.bin"), Buffer.from([0, 8, 7, 6]))
    await chmod(join(source, "run.sh"), 0o755)
    await symlink("text.txt", join(source, "link"))
    await git(source, "rm", "deleted.txt")
    await git(source, "add", "text.txt", "binary.bin", "run.sh", "link")
    await writeFile(join(source, "text.txt"), "staged\nunstaged\nthird\n")
    await writeFile(join(source, "binary.bin"), Buffer.from([0, 5, 4, 3]))
    await unlink(join(source, "removed-later.txt"))
    await mkdir(join(source, "untracked dir"))
    await writeFile(join(source, "untracked dir", "[literal]\nfile.txt"), Buffer.from([0, 77, 55]))
    await symlink("../text.txt", join(source, "untracked dir", "link"))
    await mkdir(join(source, "ignored"))
    await writeFile(join(source, "ignored", "secret"), "not transferred")
    const sourceIndex = await readFile(join(source, ".git", "index"))
    const staged = await git(source, "diff", "--cached", "--binary", "--no-ext-diff")
    const unstaged = await git(source, "diff", "--binary", "--no-ext-diff")
    const beforeCaptureIndex = await readFile(join(source, ".git", "index"))
    const checkpoint = await captureCheckpoint({ directory: source, workspaceID: "ws_test", id: "transfer-1" })
    expect(await readFile(join(source, ".git", "index"))).toEqual(beforeCaptureIndex)
    expect(await git(source, "rev-parse", "HEAD")).toBe(head)
    expect(checkpoint.manifest.branch).toBe("topic")
    expect(checkpoint.manifest.workspaceID).toBe("ws_test")
    expect(checkpoint.manifest.source).toBe("https://github.com/acme/private-app.git")
    await pushCheckpoint(source, checkpoint, { url: remote })
    const restored = await restoreCheckpoint({ directory: destination, remote: { url: remote }, ref: checkpoint.ref })
    expect(restored.commit).toBe(checkpoint.commit)
    expect(await git(destination, "rev-parse", "HEAD")).toBe(head)
    expect(await git(destination, "branch", "--show-current")).toBe("topic")
    expect(await git(destination, "log", "-1", "--format=%s")).toBe("not pushed upstream")
    expect(await git(destination, "remote", "get-url", "origin")).toBe("https://github.com/acme/private-app.git")
    expect(await readFile(join(destination, "binary.bin"))).toEqual(Buffer.from([0, 5, 4, 3]))
    expect(await git(destination, "diff", "--cached", "--binary", "--no-ext-diff")).toBe(staged)
    expect(await git(destination, "diff", "--binary", "--no-ext-diff")).toBe(unstaged)
    expect(await readFile(join(destination, "untracked dir", "[literal]\nfile.txt"))).toEqual(Buffer.from([0, 77, 55]))
    expect(await readlink(join(destination, "link"))).toBe("text.txt")
    expect(await readlink(join(destination, "untracked dir", "link"))).toBe("../text.txt")
    expect((await lstat(join(destination, "run.sh"))).mode & 0o111).toBe(0o111)
    expect(await git(destination, "ls-files", "--others", "--exclude-standard", "-z"))
      .toBe(await git(source, "ls-files", "--others", "--exclude-standard", "-z"))
    await expect(lstat(join(destination, "ignored"))).rejects.toThrow()
    expect(sourceIndex.length).toBeGreaterThan(0)
  })

  test("captures edits hidden by assume-unchanged without altering the source index", async () => {
    const { source, remote, destination } = await setup()
    await git(source, "update-index", "--assume-unchanged", "binary.bin")
    await writeFile(join(source, "binary.bin"), Buffer.from([0, 5, 4, 3]))
    await writeFile(join(source, "intent.txt"), "not yet staged\n")
    await git(source, "add", "--intent-to-add", "intent.txt")
    const index = await readFile(join(source, ".git", "index"))
    const checkpoint = await captureCheckpoint({ directory: source, workspaceID: "stat-cache" })
    expect(await readFile(join(source, ".git", "index"))).toEqual(index)
    await pushCheckpoint(source, checkpoint, { url: remote })
    await restoreCheckpoint({ directory: destination, remote: { url: remote }, ref: checkpoint.ref })
    expect(await readFile(join(destination, "binary.bin"))).toEqual(Buffer.from([0, 5, 4, 3]))
    expect(await readFile(join(destination, "intent.txt"), "utf8")).toBe("not yet staged\n")
  })

  test("restores detached HEAD and refuses a populated destination", async () => {
    const { source, remote, destination } = await setup()
    await git(source, "checkout", "--detach")
    const checkpoint = await captureCheckpoint({ directory: source, workspaceID: "ws_detached" })
    expect(checkpoint.manifest.branch).toBeNull()
    await pushCheckpoint(source, checkpoint, { url: remote })
    await mkdir(destination)
    await writeFile(join(destination, "mine.txt"), "keep")
    await expect(restoreCheckpoint({ directory: destination, remote: { url: remote }, ref: checkpoint.ref })).rejects.toThrow("empty directory")
    expect(await readFile(join(destination, "mine.txt"), "utf8")).toBe("keep")
    const fresh = destination + "-fresh"
    await restoreCheckpoint({ directory: fresh, remote: { url: remote }, ref: checkpoint.ref })
    expect(await git(fresh, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
  })

  test("a failed restore leaves the destination available for retry", async () => {
    const { source, remote, destination } = await setup()
    const checkpoint = await captureCheckpoint({ directory: source, workspaceID: "ws_retry" })
    await pushCheckpoint(source, checkpoint, { url: remote })
    await expect(restoreCheckpoint({ directory: destination, remote: { url: remote }, ref: "refs/ocx/checkpoints/missing" })).rejects.toThrow("fetch")
    await expect(lstat(destination)).rejects.toThrow()
    await restoreCheckpoint({ directory: destination, remote: { url: remote }, ref: checkpoint.ref })
    expect(await readFile(join(destination, "text.txt"), "utf8")).toBe("first\nsecond\nthird\n")
  })

  test("rejects conflicting index entries without changing the source", async () => {
    const { source } = await setup()
    await git(source, "checkout", "-b", "other")
    await writeFile(join(source, "text.txt"), "other\n")
    await git(source, "commit", "-am", "other")
    await git(source, "checkout", "topic")
    await writeFile(join(source, "text.txt"), "topic\n")
    await git(source, "commit", "-am", "topic")
    try { await git(source, "merge", "other") } catch {}
    const index = await readFile(join(source, ".git", "index"))
    await expect(captureCheckpoint({ directory: source, workspaceID: "ws_conflict" })).rejects.toThrow("in-progress Git operation")
    expect(await readFile(join(source, ".git", "index"))).toEqual(index)
  })

  test("checkpoint IDs are safe refs and are immutable", async () => {
    const { source, remote } = await setup()
    for (const id of ["../bad", "bad/ref", "-", "a.lock", ""]) expect(() => validateCheckpointID(id)).toThrow()
    const checkpoint = await captureCheckpoint({ directory: source, workspaceID: "ws_immutable", id: "fixed" })
    await expect(captureCheckpoint({ directory: source, workspaceID: "ws_immutable", id: "fixed" })).rejects.toThrow("update-ref")
    await expect(pushCheckpoint(source, checkpoint, { url: remote, token: "secret" })).rejects.toThrow("Invalid Git remote URL")
    await expect(fetchCheckpoint(source, { url: remote }, "refs/heads/main")).rejects.toThrow("checkpoint ref")
  })
})
