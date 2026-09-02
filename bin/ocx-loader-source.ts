export const ocxLoaderSource = `import { Plugin } from "@opencode-ai/plugin/tui"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

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
  id: "ocx-plugin-approvals",
  setup(ctx) {
    const directory = process.env.OCX_CONTROL_DIR
    if (!directory) return
    let stopped = false
    let busy = false
    let pendingNonce

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
      } catch (error) {
        ctx.ui.toast.show({ variant: "error", message: "ocx plugin approval failed: " + String(error) })
      } finally {
        busy = false
      }
    }

    const timer = setInterval(tick, 250)
    void tick()
    return async () => {
      stopped = true
      clearInterval(timer)
    }
  },
})
`
