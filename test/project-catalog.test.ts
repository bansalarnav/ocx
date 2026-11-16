import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { ProjectCatalog } from "../packages/client/src/project-catalog"
import { repositoryIdentity } from "../packages/protocol/src/projects"

const exec = promisify(execFile)
test("directory discovery groups worktrees and different transports without exposing Git credentials, and remembers ordinary directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocx-projects-"))
  const source = join(root, "source"), worktree = join(root, "worktree"), plain = join(root, "plain")
  await mkdir(source); await mkdir(plain)
  const git = async (...args: string[]) => (await exec("git", ["-C", source, ...args])).stdout.trim()
  try {
    await git("init", "-b", "main")
    await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid")
    await mkdir(join(source, "nested")); await writeFile(join(source, "nested", "file.txt"), "base")
    await git("add", "."); await git("commit", "-m", "base")
    await git("remote", "add", "origin", "https://secret-token@github.com/Acme/App.git")
    await git("worktree", "add", "-b", "feature", worktree)
    const data = join(root, "data")
    const [catalog, otherWindow] = await Promise.all([ProjectCatalog.open(data), ProjectCatalog.open(data)])
    expect(catalog.deviceID).toBe(otherWindow.deviceID)
    const a = await catalog.discover(join(source, "nested")), b = await catalog.discover(worktree)
    expect(a.directory).toBe(source)
    expect(a.id).not.toBe(b.id)
    expect(a.projectID).toBe(b.projectID)
    expect(a.branch).toBe("main"); expect(b.branch).toBe("feature")
    expect(a.source).toBe("https://github.com/acme/app.git")
    expect(repositoryIdentity("git@github.com:Acme/App.git")?.id).toBe(a.projectID)
    expect(repositoryIdentity("ssh://git@github.com/Acme/App.git")?.id).toBe(a.projectID)
    expect(await readFile(join(data, "checkouts.json"), "utf8")).not.toContain("secret-token")
    const [scratch] = await Promise.all([catalog.discover(plain), otherWindow.discover(worktree)])
    expect(scratch.source).toBeUndefined()
    expect(scratch.projectID).not.toBe(a.projectID)
    const reopened = await ProjectCatalog.open(data)
    expect(reopened.deviceID).toBe(catalog.deviceID)
    expect((await reopened.discover(source)).id).toBe(a.id)
    expect(reopened.list()).toHaveLength(3)
    expect(() => reopened.get("another-device")).toThrow("another device")
    expect(repositoryIdentity("file:///home/me/repo")).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
