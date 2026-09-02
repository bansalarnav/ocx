export const ocxLoaderSource = `import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
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

const tui: TuiPlugin = async (api) => {
  const directory = process.env.OCX_CONTROL_DIR
  if (!directory) return
  let stopped = false
  let busy = false
  let pendingNonce
  let activeGeneration
  const loaded = new Map()
  const reportedFailures = new Set()

  const activate = async (item, state) => {
    const module = await import(pathToFileURL(item.path).href + "?ocx=" + item.sha256)
    const definition = module.default
    if (!definition || definition.id !== item.id || typeof definition.tui !== "function") {
      throw new Error("Invalid TUI plugin module: " + item.id)
    }

    const controller = new AbortController()
    const disposers = []
    const gates = []
    const scoped = {
      ...api,
      slots: {
        register(plugin) {
          const gate = { enabled: true }
          const slots = {}
          for (const [name, render] of Object.entries(plugin?.slots ?? {})) {
            if (typeof render !== "function") continue
            slots[name] = (...args) => gate.enabled ? render(...args) : null
          }
          gates.push(gate)
          return api.slots.register({ ...plugin, slots })
        },
      },
      lifecycle: {
        signal: controller.signal,
        onDispose(dispose) {
          disposers.push(dispose)
          return () => {
            const index = disposers.indexOf(dispose)
            if (index !== -1) disposers.splice(index, 1)
          }
        },
      },
    }
    const now = Date.now()
    await definition.tui(scoped, undefined, {
      id: item.id,
      source: "file",
      spec: item.path,
      target: item.path,
      first_time: now,
      last_time: now,
      time_changed: now,
      load_count: 1,
      fingerprint: item.sha256,
      state,
    })
    let enabled = true
    return {
      enable() {
        enabled = true
        for (const gate of gates) gate.enabled = true
      },
      async cleanup() {
        if (!enabled) return
        enabled = false
        controller.abort()
        for (const gate of gates) gate.enabled = false
        for (const dispose of disposers.reverse()) await dispose()
      },
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
      if (current) await current.cleanup()
      try {
        const activated = await activate(item, current ? "updated" : "first")
        loaded.set(item.id, { sha256: item.sha256, ...activated })
        reportedFailures.delete(item.sha256)
        api.ui.toast({
          variant: "success",
          message: (current ? "Reloaded " : "Loaded ") + "TUI plugin " + item.id,
        })
      } catch (error) {
        failed = true
        current?.enable()
        if (current) loaded.set(item.id, current)
        if (!reportedFailures.has(item.sha256)) {
          reportedFailures.add(item.sha256)
          api.ui.toast({
            variant: "error",
            message: "Could not load " + item.id + ": " + String(error),
          })
        }
      }
    }
    if (!failed) activeGeneration = active.generation
  }

  const confirm = (title, message) => new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      api.ui.dialog.clear()
      resolve(value)
    }
    api.ui.dialog.replace(
      () => api.ui.DialogConfirm({
        title,
        message,
        onConfirm: () => finish(true),
        onCancel: () => finish(false),
      }),
      () => finish(false),
    )
  })

  const decide = async (pending) => {
    if (!pending || pending.nonce === pendingNonce || !Array.isArray(pending.plugins)) return
    pendingNonce = pending.nonce
    const approved = []
    for (const item of pending.plugins) {
      const action = item.changed ? "update" : "install"
      const accepted = await confirm(
        "TUI plugin " + action,
        item.id + " from " + pending.origin + " will run as local code with your user account's permissions.\\n\\nSHA-256: " + item.sha256,
      )
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
      api.ui.toast({ variant: "error", message: "ocx hot reload failed: " + String(error) })
    } finally {
      busy = false
    }
  }

  const timer = setInterval(tick, 250)
  void tick()
  api.lifecycle.onDispose(async () => {
    stopped = true
    clearInterval(timer)
    for (const current of Array.from(loaded.values()).reverse()) await current.cleanup()
    loaded.clear()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "ocx-hot-loader",
  tui,
}

export default plugin
`
