import { expect, test } from "bun:test"
import type { Context } from "../packages/client/node_modules/@opencode/plugin/dist/tui/context"
import { setupWorkspaceUI, workspaceBridge, type WorkspaceUIBridge, type WorkspaceUIState } from "../packages/client/src/workspace-tui"

function fixture(mode: "local" | "remote" = "local", connected = true) {
  const calls: { action: string; input?: Record<string, unknown> }[] = []
  const prompts: string[] = [], selections: any[] = [], alerts: string[] = []
  const state: WorkspaceUIState = { mode, connected, transfers: [] }
  const workspace = { id: "workspace", name: "My app", root: "/repo", state: "ready", sessionIDs: ["ses_remote"] }
  const checkout = { id: "workspace", projectID: "repo:github.com/acme/app", projectName: "acme/app", name: "My app", location: "cloud", directory: "/repo", state: "ready", source: "https://github.com/acme/app.git" }
  const deviceCheckout = { ...checkout, id: "device-checkout", location: "device", deviceID: "this-device", hostname: "device-host", branch: "main", state: "available" }
  const project = { id: checkout.projectID, name: checkout.projectName, source: checkout.source, checkouts: [checkout, deviceCheckout] }
  const responses: Record<string, any> = {
    workspaces: { workspaces: [workspace] }, sessions: { sessions: [{ id: "ses_remote", title: "Fix login" }] },
    projects: { projects: [project], deviceID: "this-device", currentCheckoutID: "device-checkout" }, checkoutSessions: { sessions: [{ id: "ses_remote", title: "Fix login" }] },
    createCheckout: { checkout: { ...checkout, id: "new-checkout", name: "Login" } },
    githubStatus: { connected: true }, repositories: [{ full_name: "acme/app", default_branch: "main" }],
    branches: [{ name: "main" }, { name: "release" }],
  }
  const bridge: WorkspaceUIBridge = {
    state: async () => structuredClone(state),
    action: async (action, input) => {
      calls.push({ action, input })
      if (action === "configure") state.connected = true
      if (action === "selectComposerTarget") {
        state.composerTarget = input?.target as any
        return { target: state.composerTarget }
      }
      return responses[action] ?? (["new", "createConversation", "openConversation", "send", "receive", "switch", "recover"].includes(action) ? { launch: { sessionID: "ses_destination" } } : {})
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
    f.selections.push("repo:github.com/acme/app", "workspace", "ses_remote")
    await f.run("ocx.workspaces")
    expect(f.calls.map(call => call.action)).toEqual(["projects", "checkoutSessions", "openConversation", "activate"])
    expect(f.calls[2].input).toEqual({ workspaceID: "workspace", sessionID: "ses_remote" })
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("new cloud checkout selects the native composer without asking for task text or starting a conversation", async () => {
  const f = fixture()
  try {
    f.selections.push("repo:github.com/acme/app", "__new", "new", "main")
    f.prompts.push("agent/login", "Login")
    await f.run("ocx.new")
    expect(f.calls.find(call => call.action === "createCheckout")?.input).toEqual({ source: "https://github.com/acme/app.git", branch: "main", newBranch: "agent/login", name: "Login" })
    expect(f.calls.at(-1)).toEqual({ action: "selectComposerTarget", input: { target: { location: "cloud", workspaceID: "new-checkout" }, directory: "/repo" } })
    expect(f.calls.some(call => ["createConversation", "activate"].includes(call.action))).toBe(false)
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("another conversation reuses an existing cloud checkout without asking for a repository or branch", async () => {
  const f = fixture("remote")
  try {
    f.selections.push("repo:github.com/acme/app", "workspace")
    await f.run("ocx.new")
    expect(f.calls.map(c => c.action)).toEqual(["projects", "selectComposerTarget"])
    expect(f.calls[1].input?.target).toEqual({ location: "cloud", workspaceID: "workspace" })
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("a new conversation in the current checkout inherits the remote checkout", async () => {
  const f = fixture("remote")
  try {
    await f.run("ocx.here")
    expect(f.calls.map(c => c.action)).toEqual(["projects", "selectComposerTarget"])
    expect(f.calls[1].input?.target).toEqual({ location: "cloud", workspaceID: "workspace" })
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("machine and checkout controls select a deferred cloud destination; cancel does not change it", async () => {
  const f = fixture()
  try {
    f.selections.push("cloud", "workspace")
    await f.run("ocx.machine")
    expect(f.calls.map(c => c.action)).toEqual(["projects", "selectComposerTarget"])
    expect(f.calls.at(-1)?.input?.target).toEqual({ location: "cloud", workspaceID: "workspace" })
    const count = f.calls.length
    await f.run("ocx.machine")
    expect(f.calls).toHaveLength(count)
    expect(f.alerts).toEqual([])
  } finally { f.stop() }
})

test("cloud plugin manager installs a package for the selected project inside OpenCode", async () => {
  const f = fixture()
  try {
    f.responses.cloudPlugins = { plugins: [] }
    f.responses.installCloudPlugin = { plugin: { warnings: [] } }
    f.selections.push("__install", "project")
    f.prompts.push("@acme/plugin@1.2.3")
    await f.run("ocx.plugins")
    expect(f.calls.find(c => c.action === "installCloudPlugin")?.input).toEqual({ package: "@acme/plugin@1.2.3", scope: "project", projectID: "repo:github.com/acme/app" })
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
