import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { nativeWorkspaceScript } from "../packages/server/src/remote/adapter"

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const git = (root: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "ocx-native-")); directories.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid")
  await writeFile(join(root, "tracked.txt"), "before\n")
  git(root, "add", "."); git(root, "commit", "-m", "base")
  return root
}
function native(root: string, op: string, input = {}) {
  const payload = JSON.stringify({ root, op, input })
  const result = spawnSync("python3", ["-c", nativeWorkspaceScript], { encoding: "utf8", input: payload })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout)
}

test("native remote browser reads binary bytes and blocks paths and symlinks outside its workspace", async () => {
  const root = await repository()
  const bytes = Buffer.from([0, 255, 10, 13, 80])
  await writeFile(join(root, "binary.dat"), bytes)
  expect(Buffer.from(native(root, "read", { path: "binary.dat" }).data, "base64")).toEqual(bytes)
  expect(() => native(root, "read", { path: "../outside" })).toThrow("Path escapes workspace")
  await symlink(tmpdir(), join(root, "escape"))
  expect(() => native(root, "write", { path: "escape/no-write", data: "" })).toThrow("Path escapes workspace")
  await mkdir(join(root, "src"))
  native(root, "write", { path: "src/hello.txt", data: Buffer.from("hello 世界\n").toString("base64") })
  expect(native(root, "find", { query: "hello" })).toEqual([{ path: "src/hello.txt", type: "file" }])
})

test("native remote VCS reports tracked edits, deletions and untracked files with usable diffs", async () => {
  const root = await repository()
  await writeFile(join(root, "tracked.txt"), "after\nsecond\n")
  await writeFile(join(root, "new file.txt"), "new\n")
  expect(native(root, "info").branch.current).toBe("main")
  expect(native(root, "branches")).toContain("main")
  const status = native(root, "status")
  expect(status).toContainEqual({ file: "tracked.txt", additions: 2, deletions: 1, status: "modified" })
  expect(status).toContainEqual({ file: "new file.txt", additions: 1, deletions: 0, status: "added" })
  const diffs = native(root, "diff", { mode: "working" })
  expect(diffs.find((value: { file: string }) => value.file === "tracked.txt").patch).toContain("+after")
  expect(diffs.find((value: { file: string }) => value.file === "new file.txt").patch).toContain("+new")
  await rm(join(root, "tracked.txt"))
  expect(native(root, "status")).toContainEqual({ file: "tracked.txt", additions: 0, deletions: 1, status: "deleted" })
})
