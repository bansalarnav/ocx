import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { PreviewManager } from "../packages/device/src/preview"

const managers: PreviewManager[] = []
const directories: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stopAll()
  process.env.PATH = originalPath
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "ocx-tunnel-test-"))
  directories.push(directory)
  await writeFile(join(directory, "cloudflared"), `#!/bin/sh\n${script}\n`)
  await chmod(join(directory, "cloudflared"), 0o755)
  process.env.PATH = `${directory}:${originalPath}`
  const manager = new PreviewManager()
  managers.push(manager)
  return { directory, manager }
}

async function withPort(run: (port: number) => Promise<void>) {
  const server = createServer(socket => socket.end())
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    await run((server.address() as { port: number }).port)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test("uses cloudflared's stderr URL and stops the tunnel", async () => {
  const { directory, manager } = await fixture(`printf '%s\\n' "$@" > args
printf '%s' "$$" > pid
printf '%s\\n' 'INF | https://example-test.trycloudflare.com |' >&2
exec sleep 60`)
  await withPort(async port => {
    const preview = await manager.start({ port, name: "local-label", workdir: directory, startupTimeout: 1000 })
    expect(preview.url).toBe("https://example-test.trycloudflare.com")
    expect((await readFile(join(directory, "args"), "utf8")).trim().split("\n")).toEqual([
      "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`,
    ])
    const pid = Number(await readFile(join(directory, "pid"), "utf8"))
    manager.stop(preview.id)
    expect(manager.list()).toEqual([])
    await Bun.sleep(100)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

test("reports cloudflared startup errors without retaining a preview", async () => {
  const { directory, manager } = await fixture("echo 'tunnel unavailable' >&2\nexit 1")
  await withPort(async port => {
    await expect(manager.start({ port, workdir: directory, startupTimeout: 1000 })).rejects.toThrow("tunnel unavailable")
    expect(manager.list()).toEqual([])
  })
})

test("times out and cleans up a tunnel that never publishes a URL", async () => {
  const { directory, manager } = await fixture(`printf '%s' "$$" > pid\nexec sleep 60`)
  await withPort(async port => {
    await expect(manager.start({ port, workdir: directory, startupTimeout: 200 })).rejects.toThrow("Timed out waiting for cloudflared")
    const pid = Number(await readFile(join(directory, "pid"), "utf8"))
    await Bun.sleep(100)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(manager.list()).toEqual([])
  })
})
