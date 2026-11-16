import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { repositoryIdentity, type ProjectCheckout } from "@ocx/protocol/projects"
import { deviceName } from "./device-name"
import { Flock } from "@opencode/util/flock"

const exec = promisify(execFile)
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32)

/** A device remembers directories it has actually opened, never remote paths. */
export class ProjectCatalog {
  private constructor(readonly path: string, readonly deviceID: string, private checkouts: ProjectCheckout[]) {}
  static async open(dataRoot: string) {
    const path = join(dataRoot, "checkouts.json")
    await mkdir(dataRoot, { recursive: true, mode: 0o700 })
    return Flock.withLock(path, async () => {
      try {
        const saved = JSON.parse(await readFile(path, "utf8"))
        if (saved.version !== 1 || typeof saved.deviceID !== "string" || !Array.isArray(saved.checkouts)) throw new Error("Invalid checkout catalog")
        return new ProjectCatalog(path, saved.deviceID, saved.checkouts)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        const catalog = new ProjectCatalog(path, randomUUID(), [])
        await catalog.save()
        return catalog
      }
    }, { dir: join(dataRoot, "locks"), timeoutMs: 5000 })
  }
  async refresh() {
    const saved = JSON.parse(await readFile(this.path, "utf8"))
    if (saved.version !== 1 || saved.deviceID !== this.deviceID || !Array.isArray(saved.checkouts)) throw new Error("Checkout catalog identity changed")
    this.checkouts = saved.checkouts
  }
  private async save() {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, deviceID: this.deviceID, checkouts: this.checkouts }) + "\n", { mode: 0o600 })
    await rename(temporary, this.path)
  }
  list() { return structuredClone(this.checkouts) }
  get(id: string) {
    const checkout = this.checkouts.find(c => c.id === id)
    if (!checkout) throw new Error("This checkout belongs to another device; open OpenCode there to use it")
    return checkout
  }
  async discover(directory: string) {
    directory = await realpath(directory)
    const git = async (...args: string[]) => (await exec("git", ["-C", directory, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim()
    let source: string | undefined, branch: string | undefined, rootCommit: string | undefined
    try {
      const root = await git("rev-parse", "--show-toplevel")
      directory = await realpath(root)
      try { source = (await git("remote", "get-url", "origin")) || undefined } catch {}
      try { branch = (await git("symbolic-ref", "--short", "HEAD")) || undefined } catch {}
      if (!source) try { rootCommit = (await git("rev-list", "--max-parents=0", "HEAD")).split("\n").sort()[0] } catch {}
    } catch { /* A plain directory is a valid checkout too. */ }
    const repo = source ? repositoryIdentity(source) : undefined
    const checkout: ProjectCheckout = {
      id: `device-${this.deviceID}-${hash(directory)}`,
      projectID: repo?.id ?? (rootCommit ? `git:${rootCommit}` : `directory:${this.deviceID}:${hash(directory)}`),
      projectName: repo?.name ?? basename(directory), name: basename(directory), source: repo?.source,
      location: "device", deviceID: this.deviceID, hostname: deviceName, directory, branch,
      state: "available", updatedAt: Date.now(),
    }
    await Flock.withLock(this.path, async () => {
      await this.refresh()
      this.checkouts = [...this.checkouts.filter(c => c.id !== checkout.id), checkout]
      await this.save()
    }, { dir: join(dirname(this.path), "locks"), timeoutMs: 5000 })
    return checkout
  }
}
