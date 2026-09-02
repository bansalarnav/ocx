export const ocxLoaderSource = `import { Plugin } from "@opencode-ai/plugin/tui"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const readJSON = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

const writeJSON = async (path, value) => {
  const temporary = path + ".tmp-" + process.pid + "-" + crypto.randomUUID()
  await writeFile(temporary, JSON.stringify(value) + "\\n", { mode: 0o600 })
  await rename(temporary, path)
}

export default Plugin.define({
  id: "ocx-hot-loader",
  setup(ctx) {
    const directory = process.env.OCX_CONTROL_DIR
    if (!directory) return
    let stopped = false
    let busy = false
    let pendingNonce
    let activeGeneration
    const loaded = new Map()
    const reportedFailures = new Set()

    const activate = async (item) => {
      const module = await import(pathToFileURL(item.path).href + "?ocx=" + item.sha256)
      const definition = module.default
      if (!definition || definition.id !== item.id || typeof definition.setup !== "function") {
        throw new Error("Invalid TUI plugin module: " + item.id)
      }
      const cleanup = await definition.setup(ctx)
      return async () => {
        if (typeof cleanup === "function") await cleanup()
      }
    }

    const applyActive = async (active) => {
      if (!active || active.generation === activeGeneration || !Array.isArray(active.plugins)) return
      let failed = false
      const wanted = new Set(active.plugins.map((item) => item.id))
      for (const [id, current] of loaded) {
        if (wanted.has(id)) continue
        await current.cleanup()
        loaded.delete(id)
      }
      for (const item of active.plugins) {
        const current = loaded.get(item.id)
        if (current?.sha256 === item.sha256) continue
        try {
          const cleanup = await activate(item)
          try {
            if (current) await current.cleanup()
          } catch (error) {
            await cleanup()
            throw error
          }
          loaded.set(item.id, { sha256: item.sha256, cleanup })
          reportedFailures.delete(item.sha256)
          if (current) ctx.ui.toast.show({
            variant: "success",
            message: "Reloaded TUI plugin " + item.id,
          })
        } catch (error) {
          failed = true
          if (!reportedFailures.has(item.sha256)) {
            reportedFailures.add(item.sha256)
            ctx.ui.toast.show({
              variant: "error",
              message: "Could not load " + item.id + ": " + String(error),
            })
          }
        }
      }
      if (!failed) activeGeneration = active.generation
    }

    const decide = async (pending) => {
      if (!pending || pending.nonce === pendingNonce || !Array.isArray(pending.plugins)) return
      pendingNonce = pending.nonce
      const approved = []
      for (const item of pending.plugins) {
        const action = item.changed ? "update" : "install"
        const accepted = await ctx.ui.dialog.confirm({
          title: "TUI plugin " + action,
          message: item.id + " from " + pending.origin + " will run as local code with your user account's permissions.\\n\\nSHA-256: " + item.sha256,
          label: { confirm: "Approve", cancel: "Decline" },
        })
        if (accepted) approved.push(item.sha256)
      }
      await writeJSON(join(directory, "decision.json"), {
        nonce: pending.nonce,
        approved,
      })
    }

    const tick = async () => {
      if (stopped || busy) return
      busy = true
      try {
        await decide(await readJSON(join(directory, "pending.json")))
        await applyActive(await readJSON(join(directory, "active.json")))
      } catch (error) {
        ctx.ui.toast.show({ variant: "error", message: "ocx hot reload failed: " + String(error) })
      } finally {
        busy = false
      }
    }

    const timer = setInterval(tick, 250)
    void tick()
    return async () => {
      stopped = true
      clearInterval(timer)
      for (const current of Array.from(loaded.values()).reverse()) await current.cleanup()
      loaded.clear()
    }
  },
})
`
