import { timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Patch } from "@opencode-ai/util/patch"
import express, { type Request, type Response } from "express"
import { Result } from "effect"
import { z } from "zod/v4"
import { PreviewManager } from "./preview.js"

const root = await fs.realpath(path.resolve(process.env.OPENCODE_DEVICE_ROOT ?? process.cwd()))
const host = process.env.OPENCODE_DEVICE_HOST ?? "127.0.0.1"
const port = Number.parseInt(process.env.OPENCODE_DEVICE_PORT ?? "7331", 10)
const configuredToken = process.env.OPENCODE_DEVICE_TOKEN

if (!configuredToken) {
  throw new Error("OPENCODE_DEVICE_TOKEN is required")
}
const token = configuredToken
const previews = new PreviewManager()

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid OPENCODE_DEVICE_PORT: ${process.env.OPENCODE_DEVICE_PORT}`)
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] })

function isWithinRoot(candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function resolvePath(input = "."): string {
  if (input.includes("\0")) throw new Error("Paths may not contain NUL bytes")
  const candidate = path.resolve(root, input)
  if (!isWithinRoot(candidate)) throw new Error(`Path escapes the workspace: ${input}`)
  return candidate
}

async function assertExistingPath(input: string): Promise<string> {
  const candidate = resolvePath(input)
  const real = await fs.realpath(candidate)
  if (!isWithinRoot(real)) throw new Error(`Symlink escapes the workspace: ${input}`)
  return real
}

async function assertWritablePath(input: string): Promise<string> {
  const candidate = resolvePath(input)
  let current = path.dirname(candidate)

  while (true) {
    try {
      const real = await fs.realpath(current)
      if (!isWithinRoot(real)) throw new Error(`Parent symlink escapes the workspace: ${input}`)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

function relative(candidate: string): string {
  const value = path.relative(root, candidate)
  return value === "" ? "." : value
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env }
    delete childEnvironment.OPENCODE_DEVICE_TOKEN
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: childEnvironment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const maxBytes = options.maxBytes ?? 1024 * 1024
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let truncated = false

    const collect = (target: Buffer[], chunk: Buffer) => {
      if (size >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - size
      target.push(chunk.subarray(0, remaining))
      size += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) truncated = true
    }

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk))
    child.once("error", reject)

    const terminate = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM")
          return
        } catch {
          // Fall through to killing the child itself.
        }
      }
      child.kill("SIGTERM")
    }

    const timer = options.timeout && options.timeout > 0
      ? setTimeout(terminate, options.timeout)
      : undefined
    const abort = () => terminate()
    options.signal?.addEventListener("abort", abort, { once: true })

    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8") + (truncated ? "\n[output truncated]" : ""),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
      })
    })
  })
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "opencode-device", version: "0.1.0" },
    {
      instructions: `Tools operate on the local workspace rooted at ${root}. Paths are relative to that root.`,
    },
  )

  server.registerTool(
    "read",
    {
      description: "Read a file or directory in the local workspace. Text lines are prefixed with 1-based line numbers.",
      inputSchema: {
        path: z.string().describe("File or directory to read"),
        offset: z.number().int().positive().optional().describe("First line or entry to read, starting at 1"),
        limit: z.number().int().positive().max(10_000).optional().describe("Maximum lines or entries, default 2000"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: input, offset = 1, limit = 2000 }) => {
      const target = await assertExistingPath(input)
      const stat = await fs.stat(target)

      if (stat.isDirectory()) {
        const entries = (await fs.readdir(target, { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        const page = entries.slice(offset - 1, offset - 1 + limit)
        return textResult(page.map((entry, index) => `${offset + index}: ${entry}`).join("\n"))
      }

      if (!stat.isFile()) throw new Error(`Not a regular file: ${input}`)
      const bytes = await fs.readFile(target)
      if (bytes.includes(0)) throw new Error(`Binary files are not supported by device_read yet: ${input}`)
      const lines = bytes.toString("utf8").split(/\r?\n/)
      const page = lines.slice(offset - 1, offset - 1 + limit)
      const suffix = offset - 1 + page.length < lines.length ? "\n\n(Output truncated. Read again with a larger offset.)" : ""
      return textResult(page.map((line, index) => `${offset + index}: ${line}`).join("\n") + suffix)
    },
  )

  server.registerTool(
    "glob",
    {
      description: "Search paths in the local workspace with a glob pattern.",
      inputSchema: {
        pattern: z.string().min(1).describe("Glob pattern, for example **/*.ts"),
        path: z.string().optional().describe("Directory to search, relative to the workspace"),
        limit: z.number().int().positive().max(10_000).optional().describe("Maximum results, default 100"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pattern, path: input = ".", limit = 100 }, extra) => {
      const target = await assertExistingPath(input)
      const result = await run("rg", ["--files", "--hidden", "--glob", "!.git", "--glob", pattern], {
        cwd: target,
        timeout: 30_000,
        signal: extra.signal,
      })
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `rg exited with ${result.code}`)
      const entries = result.stdout.trim().split("\n").filter(Boolean).slice(0, limit)
      return textResult(entries.map((entry) => relative(path.join(target, entry))).join("\n"))
    },
  )

  server.registerTool(
    "grep",
    {
      description: "Search local file contents with a ripgrep regular expression.",
      inputSchema: {
        pattern: z.string().describe("Regular expression in ripgrep syntax"),
        path: z.string().optional().describe("File or directory to search"),
        include: z.string().optional().describe("Optional glob used to filter files"),
        limit: z.number().int().positive().max(10_000).optional().describe("Maximum matching lines, default 100"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pattern, path: input = ".", include, limit = 100 }, extra) => {
      const target = await assertExistingPath(input)
      const args = ["--line-number", "--column", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git"]
      if (include) args.push("--glob", include)
      args.push("--", pattern, target)
      const result = await run("rg", args, { timeout: 30_000, signal: extra.signal })
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `rg exited with ${result.code}`)
      const lines = result.stdout.trim().split("\n").filter(Boolean).slice(0, limit)
      return textResult(lines.map((line) => line.startsWith(root) ? line.slice(root.length + 1) : line).join("\n"))
    },
  )

  server.registerTool(
    "write",
    {
      description: "Write a UTF-8 file in the local workspace, overwriting it if it exists.",
      inputSchema: {
        path: z.string().describe("Path to write"),
        content: z.string().describe("Complete file contents"),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path: input, content }) => {
      const target = await assertWritablePath(input)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, "utf8")
      return textResult(`Wrote ${relative(target)}`)
    },
  )

  server.registerTool(
    "edit",
    {
      description: "Edit a UTF-8 file by replacing exact text. The match must be unique unless replaceAll is true.",
      inputSchema: {
        path: z.string().describe("File to edit"),
        oldString: z.string().describe("Exact text to find"),
        newString: z.string().describe("Replacement text"),
        replaceAll: z.boolean().optional().describe("Replace every occurrence, default false"),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path: input, oldString, newString, replaceAll = false }) => {
      if (oldString === "") throw new Error("oldString must not be empty; use write instead")
      if (oldString === newString) throw new Error("oldString and newString are identical")
      const target = await assertExistingPath(input)
      const original = await fs.readFile(target, "utf8")
      const occurrences = original.split(oldString).length - 1
      if (occurrences === 0) throw new Error(`Could not find oldString in ${input}`)
      if (occurrences > 1 && !replaceAll) throw new Error(`Found ${occurrences} matches; provide more context or set replaceAll`)
      const updated = replaceAll ? original.replaceAll(oldString, newString) : original.replace(oldString, newString)
      await fs.writeFile(target, updated, "utf8")
      return textResult(`Edited ${relative(target)} (${replaceAll ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"})`)
    },
  )

  server.registerTool(
    "patch",
    {
      description: "Apply OpenCode's *** Begin Patch format to files in the local workspace.",
      inputSchema: {
        patchText: z.string().min(1).describe("Full OpenCode patch text"),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ patchText }) => {
      const parsed = Patch.parse(patchText)
      if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)

      const prepared: Array<
        | { type: "add"; target: string; content: string }
        | { type: "delete"; target: string }
        | { type: "update"; target: string; moveTarget?: string; content: string }
      > = []

      for (const hunk of parsed.success) {
        const target = hunk.type === "add"
          ? await assertWritablePath(hunk.path)
          : await assertExistingPath(hunk.path)
        if (hunk.type === "add") {
          prepared.push({ type: "add", target, content: hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n` })
        } else if (hunk.type === "delete") {
          prepared.push({ type: "delete", target })
        } else {
          const original = await fs.readFile(target, "utf8")
          const update = Patch.derive(hunk.path, hunk.chunks, original)
          prepared.push({
            type: "update",
            target,
            moveTarget: hunk.movePath ? await assertWritablePath(hunk.movePath) : undefined,
            content: Patch.joinBom(update.content, update.bom),
          })
        }
      }

      for (const change of prepared) {
        if (change.type === "delete") {
          await fs.unlink(change.target)
          continue
        }
        const destination = change.type === "update" && change.moveTarget ? change.moveTarget : change.target
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, change.content, "utf8")
        if (change.type === "update" && change.moveTarget) await fs.unlink(change.target)
      }

      return textResult([
        "Success. Updated the following files:",
        ...prepared.map((change) => {
          const target = change.type === "update" && change.moveTarget ? change.moveTarget : change.target
          return `${change.type === "add" ? "A" : change.type === "delete" ? "D" : "M"} ${relative(target)}`
        }),
      ].join("\n"))
    },
  )

  server.registerTool(
    "shell",
    {
      description: "Run a shell command on the device. The process starts in the local workspace.",
      inputSchema: {
        command: z.string().min(1).describe("Shell command"),
        workdir: z.string().optional().describe("Working directory inside the workspace"),
        timeout: z.number().int().min(0).max(1_800_000).optional().describe("Timeout in milliseconds, default 120000"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ command, workdir = ".", timeout = 120_000 }, extra) => {
      const cwd = await assertExistingPath(workdir)
      const result = await run(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
        cwd,
        timeout,
        signal: extra.signal,
      })
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd()
      return textResult(`${output}${output ? "\n\n" : ""}Process exited with code ${result.code ?? result.signal ?? "unknown"}.`)
    },
  )

  server.registerTool(
    "preview_start",
    {
      description: "Start or attach to a local web server and expose it at a PUBLIC HTTPS preview URL through tnl. The URL has no preview-level authentication; never expose secrets or privileged development endpoints.",
      inputSchema: {
        port: z.number().int().min(1).max(65_535).describe("Local TCP port the web server listens on"),
        command: z.string().min(1).optional().describe("Optional shell command to start the web server. Omit it to expose a server already listening on the port"),
        workdir: z.string().optional().describe("Working directory inside the workspace, default workspace root"),
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional().describe("Optional tnl subdomain name. Defaults to the reusable opencode-preview hostname"),
        startupTimeout: z.number().int().min(1_000).max(120_000).optional().describe("Milliseconds to wait for the port and tunnel, default 30000"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ port, command, workdir = ".", name, startupTimeout = 30_000 }) => {
      const cwd = await assertExistingPath(workdir)
      const preview = await previews.start({ port, command, workdir: cwd, name, startupTimeout })
      return textResult([
        `Preview: ${preview.url}`,
        `ID: ${preview.id}`,
        `Local port: ${preview.port}`,
        "Warning: this URL is public and has no preview-level authentication.",
      ].join("\n"))
    },
  )

  server.registerTool(
    "preview_list",
    {
      description: "List web previews started by this device MCP process.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const active = previews.list()
      return textResult(active.length ? JSON.stringify(active, null, 2) : "No previews are active.")
    },
  )

  server.registerTool(
    "preview_stop",
    {
      description: "Stop a public preview tunnel and the web server command that preview_start launched for it.",
      inputSchema: {
        id: z.string().min(1).describe("Preview ID returned by preview_start or preview_list"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const preview = previews.stop(id)
      return textResult(`Stopped preview ${id} (${preview.url}).`)
    },
  )

  return server
}

function authorized(request: Request): boolean {
  const value = request.header("authorization")
  if (!value?.startsWith("Bearer ")) return false
  const supplied = Buffer.from(value.slice("Bearer ".length))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "2mb" }))
app.get("/health", (_request, response) => response.json({ ok: true }))
app.use("/mcp", (request, response, next) => {
  if (!authorized(request)) {
    response.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" })
    return
  }
  next()
})

app.post("/mcp", async (request: Request, response: Response) => {
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(request, response, request.body)
  } catch (error) {
    console.error(error)
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      })
    }
  } finally {
    response.once("close", () => {
      void transport.close()
      void server.close()
    })
  }
})

app.all("/mcp", (_request, response) => {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  })
})

const http = createServer(app)
http.listen(port, host, () => {
  console.log(`OpenCode device MCP listening on http://${host}:${port}/mcp`)
  console.log(`Workspace root: ${root}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    previews.stopAll()
    http.close(() => process.exit(0))
  })
}
