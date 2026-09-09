import { beforeAll, describe, expect, test } from "bun:test"
import type { RemoteRun, RemoteWorkspace, ExecutionBackend } from "../../packages/protocol/src/workspaces"
const origin = process.env.OCX_TEST_ORIGIN
const password = process.env.OCX_TEST_PASSWORD
const suite = origin && password ? describe : describe.skip
suite("remote Worker execution", () => {
  let workspace: string
  const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${origin}/api/remote${path}${workspace ? `?workspace=${workspace}` : ""}`, { headers, method, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const finish = async (id: string): Promise<RemoteRun> => {
    for (let n = 0; n < 120; n++) {
      const result = await call(`/exec/${id}`) as RemoteRun
      if (result.status !== "running") return result
      await Bun.sleep(250)
    }
    throw new Error("Execution did not finish")
  }
  const run = async (command: string, backend: ExecutionBackend = "worker-shell") => finish((await call("/exec", { command, backend })).id)
  beforeAll(async () => {
    const id = crypto.randomUUID()
    await call("/workspaces", { id, repository: "octocat/Hello-World" })
    for (let n = 0; n < 120; n++) {
      const rows = await call("/workspaces") as RemoteWorkspace[]
      const row = rows.find(row => row.id === id)!
      if (row.status === "failed") throw new Error(row.error)
      if (row.status === "ready") { workspace = id; return }
      await Bun.sleep(250)
    }
    throw new Error("Clone did not finish")
  }, 45000)
  test("runs shell pipelines and Git against persisted files", async () => {
    const result = await run("pwd && printf 'pear\\napple\\npear\\n' > fruit.txt && sort fruit.txt | uniq && git status --short")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("/workspace/repo")
    expect(result.stdout).toContain("apple\npear")
    expect(result.stdout).toContain("fruit.txt")
    expect((await run("cat fruit.txt")).stdout).toBe("pear\napple\npear\n")
  }, 30000)
  test("supports optional JSON, YAML, and CSV commands", async () => {
    const json = await run("printf '{\"n\":21}' | jq '.n * 2'")
    expect(json.exitCode).toBe(0)
    expect(json.stdout.trim()).toBe("42")
    const yaml = await run("printf 'name: ocx\\n' | yq '.name'")
    expect(yaml.exitCode).toBe(0)
    expect(yaml.stdout).toContain("ocx")
    const csv = await run("printf 'name,score\\na,2\\nb,3\\n' | xan count")
    expect(csv.exitCode).toBe(0)
    expect(csv.stdout.trim()).toBe("2")
  }, 30000)
  test("commits and reviews changes with JavaScript Git", async () => {
    const result = await run("git config user.name 'OCX Test' && git config user.email 'ocx@example.test' && printf 'before\\n' > tracked.txt && git add tracked.txt && git commit -m 'Add test file' && printf 'after\\n' > tracked.txt && git diff --stat && git diff")
    expect(result.exitCode, result.stderr + (result.error ?? "")).toBe(0)
    expect(result.stdout).toContain("tracked.txt")
    expect(result.stdout).toContain("+after")
    expect(result.stdout).toContain("-before")
  }, 30000)
  test("fetches HTTPS content and converts HTML", async () => {
    const result = await run("curl -s https://raw.githubusercontent.com/octocat/Hello-World/master/README")
    expect(result.exitCode, result.stderr + (result.error ?? "")).toBe(0)
    expect(result.stdout).toContain("Hello World")
    const html = await run("printf '<h1>Hello</h1><p>World</p>' | html-to-markdown")
    expect(html.exitCode, html.stderr).toBe(0)
    expect(html.stdout).toContain("# Hello")
    const detected = await run("file tracked.txt")
    expect(detected.exitCode, detected.stderr).toBe(0)
  }, 30000)
  test("runs JavaScript with durable relative imports and captures return values", async () => {
    const result = await run(`
      import fs from 'node:fs/promises';
      export default async () => {
        await fs.writeFile('/workspace/repo/double.js', 'export const double = n => n * 2');
        return { prepared: true };
      };
    `, "worker-javascript")
    expect(result.status).toBe("completed")
    expect(JSON.parse(result.resultJSON!)).toEqual({ prepared: true })
    const check = await run(`
      import { double } from './double.js';
      import fs from 'node:fs/promises';
      export default async () => {
        if (double(21) !== 42) throw new Error('assertion failed');
        await fs.writeFile('/workspace/repo/answer.txt', String(double(21)));
        console.log('assertions passed');
        return { answer: double(21) };
      };
    `, "worker-javascript")
    expect(check.status).toBe("completed")
    expect(check.stdout).toContain("assertions passed")
    expect(JSON.parse(check.resultJSON!)).toEqual({ answer: 42 })
    expect((await run("cat answer.txt")).stdout).toBe("42")
  }, 30000)
  test("preserves failures and rejects unavailable native commands", async () => {
    const failure = await run("printf 'test failed\\n' >&2; exit 7")
    expect(failure.exitCode).toBe(7)
    expect(failure.stderr).toContain("test failed")
    for (const command of ["node --version", "npm install", "gh --version", "python3 --version"]) {
      expect((await run(command)).exitCode).not.toBe(0)
    }
    const js = await run("throw new Error('failed assertion')", "worker-javascript")
    expect(js.status).toBe("failed")
    expect(js.stderr + (js.error ?? "")).toContain("failed assertion")
  }, 30000)
  test("cancels each backend before subsequent writes", async () => {
    for (const backend of ["worker-shell", "worker-javascript"] as const) {
      const marker = `${backend}-cancelled.txt`
      const command = backend === "worker-shell"
        ? `sleep 30; echo late > ${marker}`
        : `import fs from 'node:fs/promises'; export default async () => { await new Promise(r => setTimeout(r, 30000)); await fs.writeFile('/workspace/repo/${marker}', 'late'); };`
      const started = await call("/exec", { command, backend })
      await Bun.sleep(500)
      await call(`/exec/${started.id}`, undefined, "DELETE")
      const result = await finish(started.id)
      expect(result.status).toBe("cancelled")
      expect((await run(`test ! -e ${marker}`)).exitCode).toBe(0)
    }
  }, 45000)
  test("enforces execution deadlines", async () => {
    const started = await call("/exec", { command: "sleep 30; echo late > timed-out.txt", timeoutMs: 1000 })
    const result = await finish(started.id)
    expect(result.status).toBe("failed")
    expect(result.exitCode).toBe(124)
    expect((await run("test ! -e timed-out.txt")).exitCode).toBe(0)
  }, 10000)
  test("limits concurrent starts and handles cancellation immediately after submission", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => call("/exec", { command: "sleep 30; echo late", timeoutMs: 5000 })))
    const admitted = results.filter((result): result is PromiseFulfilledResult<RemoteRun> => result.status === "fulfilled")
    expect(admitted).toHaveLength(4)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    await Promise.all(admitted.map(async ({ value }) => {
      await call(`/exec/${value.id}`, undefined, "DELETE")
      const result = await finish(value.id)
      expect(result.status).toBe("cancelled")
      expect(result.stdout).not.toContain("late")
    }))
  }, 12000)
  test("bounds large command output while retaining its exit status", async () => {
    const result = await run("export default () => { console.log('x'.repeat(200000)); }", "worker-javascript")
    expect(result.status).not.toBe("running")
    expect(result.stdout.length).toBeLessThanOrEqual(128 * 1024)
    expect(result.exitCode).toBeDefined()
    const shell = await run("printf '%200000s' x")
    expect(shell.exitCode).toBe(0)
    expect(shell.truncated).toBe(true)
    expect(shell.stdout.length).toBe(128 * 1024)
  }, 12000)
})
