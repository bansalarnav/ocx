import { expect, test } from "bun:test"
import type { Context } from "../packages/client/node_modules/@opencode/plugin/dist/tui/context"
import { setupWorkspaceUI, workspaceBridge, type WorkspaceUIBridge, type WorkspaceUIState } from "../packages/client/src/workspace-tui"

function fixture(mode: "local" | "remote" = "local", connected = true) {
  const calls: { action: string; input?: Record<string, unknown> }[] = []
  const prompts: string[] = [], selections: any[] = [], alerts: string[] = []
  const state: WorkspaceUIState = { mode, connected, transfers: [] }
  const workspace = { id: "workspace", name: "My app", root: "/repo", state: "ready", sessionIDs: ["ses_remote"] }
  const responses: Record<string, any> = {
    workspaces: { workspaces: [workspace] }, sessions: { sessions: [{ id: "ses_remote", title: "Fix login" }] },
    githubStatus: { connected: true }, repositories: [{ full_name: "acme/app", default_branch: "main" }],
    branches: [{ name: "main" }, { name: "release" }],
  }
  const bridge: WorkspaceUIBridge = {
    state: async () => structuredClone(state),
    action: async (action, input) => {
      calls.push({ action, input })
      if (action === "configure") state.connected = true
      return responses[action] ?? (["new", "send", "receive", "switch", "recover"].includes(action) ? { launch: { sessionID: "ses_destination" } } : {})
    },
  }
  let commands: { id?: string; run: () => Promise<void> }[] = []
  const ctx = {
    options: {}, app: { version: "2.3.0" },
    data: { session: { get: () => ({ id: "ses_current", title: "Current task", location: { directory: "/repo" } }) } },
    keymap: { layer(factory: () => any) { commands = factory().commands } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_current" }) }, model: { current: () => ({ providerID: "acme", modelID: "coder" }) },
      slot() { return () => {} }, toast: { show() {} },
      dialog: {
        async prompt() { return prompts.shift() },
        async select(input: any) {
          const selected = selections.shift()
          if (selected === undefined) return undefined
          const option = input.options.find((option: any) => option.value === selected || option.value?.id === selected)
          if (!option) throw new Error(`Selection ${selected} absent in ${input.title}`)
          return option.value
        },
        async alert(input: any) { alerts.push(input.message) }, clear() {}, show() {},
      },
    },
  } as unknown as Context
  const stop = setupWorkspaceUI(ctx, bridge)
  const run = async (id: string) => {
    const command = commands.find(command => command.id === id)
    if (!command) throw new Error(`Command ${id} missing`)
    await command.run()
  }
  return { calls, prompts, selections, alerts, state, responses, run, stop }
}

test("Continue remotely connects inside OpenCode, discovers the current thread, and activates its destination", async () => {
  const f = fixture("local", false)
  try {
    f.prompts.push("https://remote.test", "private-password")
    await f.run("ocx.send")
    expect(f.calls.map(call => call.action)).toEqual(["configure", "send", "activate"])
    expect(f.calls[1].input).toEqual({ sessionID: "ses_current", directory: "/repo" })
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("Continue locally defaults to a managed checkout and opens the imported conversation", async () => {
  const f = fixture("remote")
  try {
    f.selections.push("managed")
    await f.run("ocx.receive")
    expect(f.calls.find(call => call.action === "receive")?.input).toEqual({ workspaceID: "workspace", sessionID: "ses_current", directory: undefined })
    expect(f.calls.at(-1)?.action).toBe("activate")
    expect(f.alerts).toEqual([])
    expect(f.prompts).toEqual([])
  } finally { f.stop() }
})

test("workspace browsing selects a named thread and switches without an attach command", async () => {
  const f = fixture()
  try {
    f.selections.push("workspace", "ses_remote")
    await f.run("ocx.workspaces")
    expect(f.calls.map(call => call.action)).toEqual(["workspaces", "sessions", "switch", "activate"])
    expect(f.calls[2].input).toEqual({ workspaceID: "workspace", sessionID: "ses_remote" })
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("new remote thread uses repository and branch pickers and opens the thread automatically", async () => {
  const f = fixture()
  try {
    f.selections.push("acme/app", "new", "main")
    f.prompts.push("agent/login", "Fix login")
    await f.run("ocx.new")
    expect(f.calls.find(call => call.action === "new")?.input).toEqual({ source: "acme/app", branch: "main", newBranch: "agent/login", prompt: "Fix login", model: { providerID: "acme", id: "coder" } })
    expect(f.calls.at(-1)?.action).toBe("activate")
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("unfinished transfer recovery is selectable and resumes inside the application", async () => {
  const f = fixture()
  try {
    f.state.transfers.push({ id: "transfer", stage: "prepared", direction: "local-to-remote" })
    f.selections.push("transfer", "resume")
    await f.run("ocx.recover")
    expect(f.calls.map(call => call.action)).toEqual(["recover", "activate"])
    expect(f.calls[0].input).toEqual({ transferID: "transfer", abort: false })
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("the UI bridge sends the capability only to its loopback endpoint and surfaces errors", async () => {
  const requests: { url: string; authorization: string | null; body?: any }[] = []
  const request: typeof fetch = (async (input: any, init: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined })
    return requests.length === 1 ? Response.json({ mode: "local", connected: false, transfers: [] }) : Response.json({ error: "Connection unavailable" }, { status: 400 })
  }) as typeof fetch
  const bridge = workspaceBridge("http://127.0.0.1:1234", "capability", request)
  expect((await bridge.state()).mode).toBe("local")
  await expect(bridge.action("workspaces")).rejects.toThrow("Connection unavailable")
  expect(requests.map(request => request.authorization)).toEqual(["Bearer capability", "Bearer capability"])
  expect(requests[1].body).toEqual({ action: "workspaces" })
})
