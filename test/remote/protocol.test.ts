import { describe, expect, test } from "bun:test"
import { repositoryName, branchName, remotePath, workspaceID, executionBackend } from "../../packages/protocol/src/workspaces"
import { parseArguments } from "../../packages/client/src/options"

describe("remote workspace boundaries", () => {
  test("only selects Worker execution backends", () => {
    expect(executionBackend()).toBe("worker-shell")
    expect(executionBackend("worker-javascript")).toBe("worker-javascript")
    for (const value of ["container-shell", "sandbox", "node", null, {}]) expect(() => executionBackend(value)).toThrow()
  })
  test("normalizes GitHub repositories without accepting credential URLs or commands", () => {
    expect(repositoryName("https://github.com/cloudflare/computer.git")).toBe("cloudflare/computer")
    for (const input of ["https://token@github.com/a/b", "a/b;env", "a/..", "file:///etc/passwd", "a/b/c", "a/b?token=secret", "a/b#main"]) expect(() => repositoryName(input)).toThrow()
  })
  test("keeps paths inside the remote checkout", () => {
    expect(remotePath("src/../README.md")).toBe("/workspace/repo/README.md")
    expect(remotePath()).toBe("/workspace/repo")
    for (const input of ["../secret", "/etc/passwd", "/workspace/repo-other/file", "../../repo/file", "src\0file", "..\\secret"]) expect(() => remotePath(input)).toThrow()
  })
  test("validates branch refs before cloning", () => {
    expect(branchName("feature/remote-work")).toBe("feature/remote-work")
    expect(branchName("")).toBeUndefined()
    for (const input of ["--upload-pack=env", "a..b", "a//b", "a/.hidden", "main.lock", "a/", "a b"]) expect(() => branchName(input)).toThrow()
  })
  test("workspace selection is explicit and cannot change the server origin", () => {
    const id = crypto.randomUUID()
    expect(workspaceID(id)).toBe(id)
    expect(() => workspaceID("github-auth")).toThrow()
    expect(() => workspaceID("../default")).toThrow()
    const options = parseArguments(["--workspace", id, "https://example.test", "--", "--log-level", "DEBUG"], {})
    expect(options.workspace).toBe(id)
    expect(options.origin).toBe("https://example.test")
    expect(options.childArgs).toEqual(["--log-level", "DEBUG"])
  })
})
