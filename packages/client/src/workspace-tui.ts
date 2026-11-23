import { Plugin } from "@opencode/plugin/tui"
import type { Workspace } from "@ocx/protocol/workspaces"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"
import { deviceName } from "./device-name"
import { repositoryIdentity, type Project, type ProjectCheckout } from "@ocx/protocol/projects"
import { captureComposer, findComposerEditor, restoreComposer } from "./composer-native"
import type { Renderable } from "@opentui/core"
import type { ComposerTarget } from "./composer-router"
import type { CloudPluginInfo } from "@ocx/protocol/cloud-plugins"
type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export interface WorkspaceUIState {
  mode: "local" | "remote"
  connected: boolean
  remote?: { server: string }
  progress?: string
  transfers: { id: string; stage: string; direction: string }[]
  composerTarget?: ComposerTarget
  autoActivate?: boolean
  pending?: { sessionID: string }
}
export interface WorkspaceUIBridge {
  state(): Promise<WorkspaceUIState>
  action<T = any>(action: string, input?: Record<string, unknown>): Promise<T>
}
export function workspaceBridge(origin: string, token: string, request: typeof fetch = fetch): WorkspaceUIBridge {
  const call = async (path: string, input?: unknown) => {
    const response = await request(new URL(path, origin), {
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    })
    const value = await response.json() as any
    if (!response.ok) throw new Error(value.error ?? "Remote operation failed")
    return path === "/state" ? value : value.data
  }
  return { state: () => call("/state"), action: (action, input = {}) => call("/action", { action, ...input }) }
}

/** The launcher owns credentials, local server discovery, transfers and switching.
 * Dialogs never ask users to find a session ID, port, or transfer command. */
export function setupWorkspaceUI(ctx: Context, bridge: WorkspaceUIBridge) {
  let busy = false, stopped = false, refreshing = false, switchingAttachment = false
  const lifetime = new AbortController()
  const [mode, setMode] = createSignal<"local" | "remote">(process.env.OCX_MODE === "remote" ? "remote" : "local")
  const [progress, setProgress] = createSignal("Preparing…")
  const [pending, setPending] = createSignal(0)
  const [selectedTarget, setSelectedTarget] = createSignal<ComposerTarget>()
  const [checkoutContext, setCheckoutContext] = createSignal<ProjectCheckout>()
  let footerAnchor: Renderable | undefined
  let contextKey = "", loadingContext = false, activationAttempted: string | undefined
  const nativeComposer = {
    editor: () => findComposerEditor(footerAnchor) ?? findComposerEditor(ctx.renderer?.root),
    commands: () => ctx.keymap.commands(),
    ready: () => {
      const sessionID = process.env.OCX_DRAFT_SESSION_ID, route = ctx.ui.router.current()
      return !sessionID || route.type === "session" && route.sessionID === sessionID
    },
  }
  let frozenComposer: ReturnType<typeof nativeComposer.editor>
  const thawComposer = () => {
    if (frozenComposer && !frozenComposer.isDestroyed) { frozenComposer.focusable = true; frozenComposer.focus() }
    frozenComposer = undefined
  }
  const saveDraft = async () => {
    if (!ctx.renderer) return undefined
    const draft = await captureComposer(nativeComposer)
    frozenComposer = nativeComposer.editor()
    if (frozenComposer) { frozenComposer.blur(); frozenComposer.focusable = false }
    draft.directory = checkoutContext()?.directory ?? currentDirectory()
    return (await bridge.action<{ id: string }>("captureDraft", { draft })).id
  }
  const refresh = async () => {
    if (refreshing || stopped) return
    refreshing = true
    try {
      const state = await bridge.state()
      setMode(state.mode)
      setSelectedTarget(state.composerTarget)
      if (state.progress) setProgress(state.progress)
      setPending(state.transfers.filter(t => !["committed", "aborted"].includes(t.stage)).length)
      if (state.autoActivate && state.pending && !busy && activationAttempted !== state.pending.sessionID) {
        activationAttempted = state.pending.sessionID
        void run(async () => {
          const draftID = await saveDraft()
          await bridge.action("activate", { draftID })
          switchingAttachment = true
        })()
      }
      const route = ctx.ui.router.current()
      const key = `${state.mode}:${route.type === "session" ? route.sessionID : "home"}`
      if (ctx.renderer && !loadingContext && contextKey !== key && !busy) {
        contextKey = key; loadingContext = true
        void loadContext().catch(() => {}).finally(() => { loadingContext = false })
      }
    } catch {} finally { refreshing = false }
  }
  const timer = setInterval(() => { void refresh() }, 1000)
  const run = (action: () => Promise<void>) => async () => {
    if (busy || switchingAttachment) return
    busy = true
    try { await action() }
    catch (error) {
      let recovery = false
      try { recovery = (await bridge.state()).transfers.some(t => !["committed", "aborted"].includes(t.stage)) } catch {}
      await ctx.ui.dialog.alert({ title: "Remote", message: (error instanceof Error ? error.message : String(error)) + (recovery ? "\n\nRecover this transfer from Remote → Recover transfer." : "") })
    }
    finally { if (!switchingAttachment) thawComposer(); busy = false; void refresh() }
  }
  const current = () => {
    const route = ctx.ui.router.current()
    if (route.type !== "session") throw new Error("Open a conversation first")
    const session = ctx.data.session.get(route.sessionID)
    if (!session) throw new Error("The conversation is still loading")
    return session
  }
  const showProgress = () => ctx.ui.dialog.show(() => jsx("box", {
    flexDirection: "column", padding: 1, gap: 1,
    children: [jsx("text", { children: "Your workspace" }), jsx("text", { get children() { return progress() } })],
  }))
  const perform = async (action: string, input: Record<string, unknown> = {}, label = "Preparing workspace…") => {
    const switching = ["send", "receive", "recover", "switch", "switchLocal", "openConversation", "createConversation", "configure"].includes(action)
    const draftID = switching ? await saveDraft() : undefined
    setProgress(label); showProgress()
    try {
      const result = await bridge.action<any>(action, input)
      ctx.ui.dialog.clear()
      if (result?.launch) {
        setProgress("Opening the conversation…"); showProgress()
        await bridge.action("activate", { draftID })
        switchingAttachment = true
      } else if (result?.url) await ctx.ui.dialog.alert({ title: action === "pr" ? "Pull request" : "Preview", message: result.url })
      else ctx.ui.toast.show({ variant: "success", message: action === "pause" ? "Workspace paused" : "Done" })
      return result
    } catch (error) { ctx.ui.dialog.clear(); throw error }
  }
  const configure = async () => {
    const state = await bridge.state()
    const server = await ctx.ui.dialog.prompt({ title: "Connect a remote", description: "Your Cloudflare OpenCode server", value: state.remote?.server, placeholder: "https://your-server.workers.dev" })
    if (!server) return false
    const password = await ctx.ui.dialog.prompt({ title: "Server password", description: "Saved on this device for this remote connection" })
    if (password === undefined) return false
    const result = await perform("configure", { server, password }, "Connecting to your remote…")
    return !result?.launch
  }
  const connected = async () => {
    const state = await bridge.state()
    if (state.connected) return true
    if (state.remote) {
      try { await perform("reconnect", {}, "Connecting to your remote…"); return true } catch {}
    }
    return configure()
  }
  const listWorkspaces = async () => (await bridge.action<{ workspaces: Workspace[] }>("workspaces")).workspaces
  const catalog = () => {
    const route = ctx.ui.router.current()
    const session = route.type === "session" ? ctx.data.session.get(route.sessionID) : undefined
    return bridge.action<{ projects: Project[]; deviceID: string; currentCheckoutID?: string; offline?: boolean }>("projects", { directory: session?.location.directory ?? ctx.location?.directory ?? process.cwd() })
  }
  const target = (checkout: ProjectCheckout) => checkout.location === "cloud" ? { workspaceID: checkout.id } : { checkoutID: checkout.id }
  const currentDirectory = () => {
    const route = ctx.ui.router.current()
    return (route.type === "session" ? ctx.data.session.get(route.sessionID)?.location.directory : undefined) ?? ctx.location?.directory ?? process.cwd()
  }
  const loadContext = async () => {
    const data = await catalog()
    const directory = currentDirectory()
    const checkout = data.projects.flatMap(p => p.checkouts).find(c => mode() === "remote" ? c.location === "cloud" && c.directory === directory : c.id === data.currentCheckoutID)
    setCheckoutContext(checkout)
    const route = ctx.ui.router.current()
    // A new attachment reloads project-scoped TUI plugins before showing the
    // next project. The server independently enforces tool scope.
    if (!busy && mode() === "remote" && route.type === "session" && checkout?.location === "cloud" && checkout.projectID !== process.env.OCX_PROJECT_ID) {
      void run(async () => { await perform("openConversation", { workspaceID: checkout.id, sessionID: route.sessionID }, "Opening this project's plugins…") })()
    }
    return { ...data, current: checkout, project: data.projects.find(p => p.id === checkout?.projectID) }
  }
  const selectTarget = async (value: Partial<ComposerTarget>) => {
    const { target } = await bridge.action<{ target: ComposerTarget }>("selectComposerTarget", { target: value, directory: checkoutContext()?.directory ?? currentDirectory() })
    setSelectedTarget(target)
  }
  const pickCheckout = async (location = selectedTarget()?.location ?? (mode() === "remote" ? "cloud" : "device")) => {
    const data = await loadContext()
    const project = data.projects.find(p => p.id === selectedTarget()?.projectID) ?? data.project
    if (!project) throw new Error("Open a project directory before selecting a checkout")
    const checkouts = project.checkouts.filter(c => c.location === location)
    const chosen = await ctx.ui.dialog.select<ProjectCheckout | "__new">({ title: `${project.name} · ${location === "cloud" ? "Cloud" : deviceName}`, options: [
      ...checkouts.map(c => ({ title: c.branch ?? c.name, value: c, description: c.name, disabled: c.location === "device" ? c.deviceID !== data.deviceID : ["transferring", "local"].includes(c.state) })),
      ...(location === "cloud" && project.source ? [{ title: "New checkout", value: "__new" as const, description: `Start from ${data.current?.branch ?? "the default branch"}` }] : []),
    ] })
    if (chosen === "__new") await selectTarget({ location: "cloud", projectID: project.id, newCheckout: { id: "", source: project.source!, branch: data.current?.branch } })
    else if (chosen) {
      if (chosen.id === data.current?.id) {
        await bridge.action("selectComposerTarget", { target: null }); setSelectedTarget(undefined)
      } else await selectTarget({ location, ...target(chosen) })
    }
  }
  const pickMachine = async () => {
    const route = ctx.ui.router.current()
    const existing = route.type === "session" && (ctx.data.session.message?.list(route.sessionID)?.length ?? 0) > 0
    const chosen = await ctx.ui.dialog.select({ title: existing ? "Continue this conversation on…" : "Run on…", options: [
      { title: deviceName, value: "device", description: "This device" },
      { title: "Cloud", value: "cloud", description: existing ? "Move this conversation and checkout" : "Run a session on a cloud machine" },
    ] })
    if (!chosen) return
    if (existing) {
      if (chosen === "cloud" && mode() === "local") await send()
      else if (chosen === "device" && mode() === "remote") await receive()
      return
    }
    if (chosen === "cloud" && !await connected()) return
    await pickCheckout(chosen as "device" | "cloud")
  }
  const cloudPlugins = async () => {
    if (!await connected()) return
    const data = await loadContext()
    const projectID = selectedTarget()?.projectID ?? data.current?.projectID
    const projectName = data.projects.find(p => p.id === projectID)?.name ?? "this project"
    for (;;) {
      const { plugins } = await bridge.action<{ plugins: CloudPluginInfo[] }>("cloudPlugins")
      const selected = await ctx.ui.dialog.select<CloudPluginInfo | "__install">({ title: "Cloud plugins", options: [
        { title: "Install a plugin", value: "__install", description: "Install an npm package on Cloud" },
        ...plugins.map(p => ({ title: `${p.package}@${p.version}`, value: p,
          description: `${p.enabled ? "Enabled" : "Disabled"} · ${p.scope === "cloud" ? "All cloud projects" : data.projects.find(project => project.id === p.projectID)?.name ?? p.projectID}` })),
      ] })
      if (!selected) return
      if (selected === "__install") {
        const pkg = await ctx.ui.dialog.prompt({ title: "Install a cloud plugin", placeholder: "@scope/plugin or plugin@version", description: "Runs on your Cloudflare server. Packages must support OpenCode's cloud plugin runtime." })
        if (!pkg?.trim()) continue
        const scope = await ctx.ui.dialog.select({ title: "Install for…", options: [
          { title: "All cloud projects", value: "cloud" },
          ...(projectID ? [{ title: projectName, value: "project", description: "Only this project" }] : []),
        ] })
        if (!scope) continue
        const result = await perform("installCloudPlugin", { package: pkg.trim(), scope, projectID }, "Installing the plugin on Cloud…")
        if (result?.plugin?.warnings?.length) await ctx.ui.dialog.alert({ title: "Plugin installed", message: result.plugin.warnings.join("\n") })
      } else {
        const operation = await ctx.ui.dialog.select({ title: `${selected.package}@${selected.version}`, options: [
          { title: selected.enabled ? "Disable" : "Enable", value: selected.enabled ? "disable" : "enable" },
          { title: "Uninstall", value: "remove" },
        ] })
        if (operation) await perform("manageCloudPlugin", { id: selected.id, operation }, "Updating the cloud plugin…")
      }
    }
  }
  const newConversation = async (checkout: ProjectCheckout) => {
    if (checkout.location === "cloud" && !await connected()) return
    await selectTarget({ location: checkout.location, ...target(checkout) })
    ctx.ui.toast.show({ variant: "success", message: `Next message starts a conversation in ${checkout.branch ?? checkout.name}` })
  }
  const openCheckout = async (checkout: ProjectCheckout) => {
    const { sessions } = await bridge.action<{ sessions: { id: string; title?: string }[] }>("checkoutSessions", target(checkout))
    const route = ctx.ui.router.current()
    const selected = await ctx.ui.dialog.select({ title: `${checkout.name} · ${checkout.location === "cloud" ? "Cloud" : checkout.hostname}`, current: route.type === "session" ? route.sessionID : undefined, options: [
      { title: "New conversation in this checkout", value: "__new", disabled: checkout.location === "cloud" && ["local", "transferring"].includes(checkout.state), description: "Reuse this branch, files, and environment" },
      ...sessions.map(s => ({ title: s.title ?? "Untitled conversation", value: s.id })),
    ] })
    if (selected === "__new") await newConversation(checkout)
    else if (selected) await perform("openConversation", { ...target(checkout), sessionID: selected }, "Opening the conversation…")
  }
  const chooseCheckout = async (project: Project, deviceID: string, cloudOnly = false) => {
    const checkouts = project.checkouts.filter(c => !cloudOnly || c.location === "cloud")
    return ctx.ui.dialog.select<ProjectCheckout | "__new">({ title: `${project.name} · Checkouts`, options: [
      ...checkouts.map(c => ({ title: c.name, value: c, disabled: c.location === "device" ? c.deviceID !== deviceID : cloudOnly && ["local", "transferring"].includes(c.state),
        description: `${c.location === "cloud" ? "Cloud" : c.hostname} · ${c.branch ?? "directory"} · ${c.state}${c.sessionCount === undefined ? "" : ` · ${c.sessionCount} conversations`}` })),
      { title: "New cloud checkout", value: "__new" as const, description: "A separate working directory and branch" },
    ] })
  }
  const browse = async () => {
    const data = await catalog()
    const selected = await ctx.ui.dialog.select<Project | "__new">({ title: data.offline ? "Projects · remote unavailable" : "Projects", options: [
      ...data.projects.map(p => ({ title: p.name, value: p, description: `${p.checkouts.length} checkout${p.checkouts.length === 1 ? "" : "s"}` })),
      { title: "Add a cloud project", value: "__new" as const, description: "Choose a repository" },
    ] })
    if (!selected) return
    if (selected === "__new") { const checkout = await newCheckout(); if (checkout) await openCheckout(checkout); return }
    const checkout = await chooseCheckout(selected, data.deviceID)
    if (checkout === "__new") { const created = await newCheckout(selected); if (created) await openCheckout(created) }
    else if (checkout) await openCheckout(checkout)
  }
  const github = async () => {
    if (!await connected()) return
    const status = await bridge.action<{ connected: boolean }>("githubStatus")
    if (status.connected) { ctx.ui.toast.show({ variant: "success", message: "GitHub is connected" }); return }
    const login = await bridge.action<{ verification_uri: string; user_code: string; device_code: string; interval?: number; expires_in: number }>("githubLoginStart")
    let closed = false
    const expires = Date.now() + login.expires_in * 1000
    const dialog = ctx.ui.dialog.alert({ title: "Connect GitHub", message: `Open ${login.verification_uri}\n\nEnter ${login.user_code}\n\nThis dialog updates when authorization completes. Escape cancels.` }).then(() => { closed = true })
    let interval = Math.max(1, login.interval ?? 5)
    while (!closed && !stopped && Date.now() < expires) {
      await Promise.race([new Promise(resolve => setTimeout(resolve, interval * 1000)), dialog])
      if (closed || stopped) return
      const result = await bridge.action<{ connected?: boolean; pending?: boolean; error?: string; interval?: number }>("githubLoginPoll", { device_code: login.device_code })
      if (result.connected) { ctx.ui.dialog.clear(); ctx.ui.toast.show({ variant: "success", message: "GitHub connected" }); return }
      if (!result.pending) { ctx.ui.dialog.clear(); throw new Error(result.error ?? "GitHub authorization failed") }
      interval = Math.max(interval, result.interval ?? interval)
    }
    if (!closed) { ctx.ui.dialog.clear(); throw new Error("GitHub authorization expired") }
  }
  const newCheckout = async (project?: Project): Promise<ProjectCheckout | undefined> => {
    if (!await connected()) return
    const status = await bridge.action<{ connected: boolean }>("githubStatus")
    const repos: { full_name: string; default_branch?: string; private?: boolean }[] = status.connected ? await bridge.action("repositories") : []
    const repository = project?.source ?? await ctx.ui.dialog.select({ title: "Choose a repository", options: [
      ...repos.map(r => ({ title: r.full_name, value: r.full_name, description: r.private ? "Private repository" : "Repository" })),
      { title: "Enter a repository URL", value: "__url" },
      ...(!status.connected ? [{ title: "Connect GitHub", value: "__github", description: "Browse your repositories" }] : []),
    ] })
    if (!repository) return
    if (repository === "__github") { await github(); return newCheckout(project) }
    const source = repository === "__url" ? await ctx.ui.dialog.prompt({ title: "Repository", placeholder: "owner/repo or HTTPS URL" }) : repository
    if (!source) return
    const checkout = await ctx.ui.dialog.select({ title: "Checkout", options: [
      { title: "New branch", value: "new", description: "An isolated checkout for this task" },
      { title: "Existing branch", value: "existing", description: "Use an existing branch in an isolated checkout" },
    ] })
    if (!checkout) return
    const repo = repos.find(r => r.full_name === source || repositoryIdentity(r.full_name.includes("://") ? r.full_name : `https://github.com/${r.full_name}`)?.id === repositoryIdentity(source)?.id)
    const branches: { name: string }[] = repo ? await bridge.action("branches", { repository: source }) : []
    const branch = branches.length
      ? await ctx.ui.dialog.select({ title: checkout === "new" ? "Start from" : "Branch", current: repo?.default_branch, options: branches.map(b => ({ title: b.name, value: b.name })) })
      : await ctx.ui.dialog.prompt({ title: checkout === "new" ? "Start from branch" : "Branch", description: "Leave empty for the repository's default branch" })
    if (branch === undefined) return
    const newBranch = checkout === "new" ? await ctx.ui.dialog.prompt({ title: "New branch name", value: `agent/task-${Date.now().toString(36)}` }) : undefined
    if (checkout === "new" && !newBranch) return
    const name = await ctx.ui.dialog.prompt({ title: "Checkout name", value: newBranch ?? branch ?? "main", description: "Identify this checkout in the project" })
    if (!name) return
    const result = await perform("createCheckout", { source, branch: branch || undefined, newBranch, name }, "Saving your cloud checkout…")
    return result.checkout
  }
  const createCheckout = async () => {
    const data = await catalog()
    const selected = await ctx.ui.dialog.select<Project | "__new">({ title: "New cloud checkout · Project", options: [
      ...data.projects.filter(p => p.source).map(p => ({ title: p.name, value: p })),
      { title: "Choose another repository", value: "__new" as const },
    ] })
    if (!selected) return
    const checkout = await newCheckout(selected === "__new" ? undefined : selected)
    if (checkout) await openCheckout(checkout)
  }
  const newThread = async (): Promise<void> => {
    const data = await catalog()
    const selected = await ctx.ui.dialog.select<Project | "__new">({ title: "New cloud conversation · Project", options: [
      ...data.projects.map(p => ({ title: p.name, value: p })),
      { title: "Choose another repository", value: "__new" as const },
    ] })
    if (!selected) return
    const checkout = selected === "__new" ? "__new" : await chooseCheckout(selected, data.deviceID, true)
    if (checkout === "__new") {
      const created = await newCheckout(selected === "__new" ? undefined : selected)
      if (created) await newConversation(created)
    } else if (checkout) await newConversation(checkout)
  }
  const newHere = async () => {
    const data = await catalog()
    const directory = ctx.ui.router.current().type === "session" ? current().location.directory : process.cwd()
    const checkout = data.projects.flatMap(p => p.checkouts).find(c => mode() === "remote" ? c.location === "cloud" && c.directory === directory : c.id === data.currentCheckoutID)
    if (!checkout) throw new Error("Choose a checkout from Projects first")
    await newConversation(checkout)
  }
  const send = async () => {
    if (!await connected()) return
    const session = current()
    await perform("send", { sessionID: session.id, directory: session.location.directory }, "Moving this conversation and checkout remotely…")
  }
  const receive = async () => {
    const session = current()
    const workspace = (await listWorkspaces()).find(w => w.root === session.location.directory)
    if (!workspace) throw new Error("This conversation has no remote checkout")
    const destination = await ctx.ui.dialog.select({ title: `Continue on ${deviceName}`, options: [
      { title: "OpenCode-managed checkout", value: "managed", description: "Restore and open automatically on this device" },
      { title: "Choose a folder", value: "custom", description: "Restore into a new or empty folder" },
    ] })
    if (!destination) return
    const directory = destination === "custom" ? await ctx.ui.dialog.prompt({ title: "Destination folder" }) : undefined
    if (destination === "custom" && !directory) return
    await perform("receive", { workspaceID: workspace.id, sessionID: session.id, directory }, `Bringing this conversation and checkout to ${deviceName}…`)
  }
  const recover = async () => {
    const pending = (await bridge.state()).transfers.filter(t => !["committed", "aborted"].includes(t.stage))
    if (!pending.length) { await ctx.ui.dialog.alert({ title: "Transfers", message: "No unfinished transfers." }); return }
    const transfer = await ctx.ui.dialog.select({ title: "Recover transfer", options: pending.map(t => ({ title: t.direction === "local-to-remote" ? "Continue remotely" : `Continue on ${deviceName}`, value: t, description: t.stage })) })
    if (!transfer) return
    const choice = await ctx.ui.dialog.select({ title: "Transfer recovery", options: [
      { title: "Resume transfer", value: "resume", description: "Continue from the last completed step" },
      { title: "Return to the source", value: "abort", description: "Abort the transfer and keep the saved files" },
    ] })
    if (choice) await perform("recover", { transferID: transfer.id, abort: choice === "abort" }, "Recovering your transfer…")
  }
  const workspaceAction = async (action: "pause" | "preview" | "pr") => {
    const session = current()
    const workspace = (await listWorkspaces()).find(w => w.root === session.location.directory)
    if (!workspace) throw new Error("Open a remote workspace conversation first")
    if (action === "preview") {
      const value = await ctx.ui.dialog.prompt({ title: "Preview port", value: "3000" })
      if (!value) return
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a port between 1 and 65535")
      await perform(action, { workspaceID: workspace.id, port }, "Opening preview…")
    } else if (action === "pr") {
      const title = await ctx.ui.dialog.prompt({ title: "Pull request title", value: session.title })
      if (!title) return
      const body = await ctx.ui.dialog.prompt({ title: "Pull request description", description: "Current changes will be committed and pushed" })
      if (body !== undefined) await perform(action, { workspaceID: workspace.id, title, body }, "Creating your pull request…")
    } else await perform(action, { workspaceID: workspace.id }, "Saving and pausing the workspace…")
  }
  const hub = async () => {
    const state = await bridge.state()
    const selected = await ctx.ui.dialog.select({ title: state.mode === "remote" ? "Remote workspace" : "Remote", options: [
      ...(ctx.ui.router.current().type === "session" ? [{ title: state.mode === "local" ? "Continue remotely" : `Continue on ${deviceName}`, value: state.mode === "local" ? "send" : "receive", description: "Move this conversation and its checkout" }] : []),
      { title: "Projects and checkouts", value: "browse", description: "Browse checkouts and their conversations" },
      ...(state.mode === "local" || ctx.ui.router.current().type === "session" ? [{ title: "New conversation in this checkout", value: "here", description: "Share this checkout's files and environment" }] : []),
      { title: "New cloud conversation", value: "new", description: "Use an existing checkout or create one" },
      { title: "New cloud checkout", value: "checkout", description: "A separate working directory and branch" },
      ...(state.mode === "remote" ? [{ title: `Back to ${deviceName}`, value: "local", description: "Leave the remote task running" }, { title: "Open preview", value: "preview" }, { title: "Create pull request", value: "pr" }, { title: "Pause workspace", value: "pause" }] : []),
      { title: "Recover transfer", value: "recover" }, { title: "Connect GitHub", value: "github" },
      { title: "Cloud plugins", value: "plugins", description: "Install and manage packages on Cloud" },
      { title: state.connected ? "Change remote connection" : "Connect a remote", value: "configure", description: state.remote?.server },
    ] })
    if (selected === "send") await send()
    else if (selected === "receive") await receive()
    else if (selected === "new") await newThread()
    else if (selected === "here") await newHere()
    else if (selected === "checkout") await createCheckout()
    else if (selected === "browse") await browse()
    else if (selected === "recover") await recover()
    else if (selected === "github") await github()
    else if (selected === "configure") await configure()
    else if (selected === "plugins") await cloudPlugins()
    else if (selected === "local") await perform("switchLocal", {}, `Opening OpenCode on ${deviceName}…`)
    else if (selected === "preview" || selected === "pr" || selected === "pause") await workspaceAction(selected)
  }
  ctx.keymap.layer(() => ({ mode: "global", commands: [
    { id: "ocx.machine", title: "Choose machine", bind: "alt+m", palette: true, run: run(pickMachine) },
    { id: "ocx.composer-checkout", title: "Choose checkout", bind: "alt+w", palette: true, run: run(() => pickCheckout()) },
    { id: "ocx.plugins", title: "Cloud plugins", palette: true, slash: { name: "cloud-plugins" }, run: run(cloudPlugins) },
    { id: "ocx.remote", title: "Remote", palette: true, slash: { name: "remote" }, run: run(hub) },
    { id: "ocx.workspaces", title: "Projects and checkouts", palette: true, slash: { name: "checkouts", aliases: ["workspaces"] }, run: run(browse) },
    { id: "ocx.new", title: "New cloud conversation", palette: true, slash: { name: "remote-new" }, run: run(newThread) },
    { id: "ocx.checkout", title: "New cloud checkout", palette: true, slash: { name: "checkout-new" }, run: run(createCheckout) },
    { id: "ocx.here", title: "New conversation in this checkout", palette: true, slash: { name: "conversation-new" }, enabled: () => mode() === "local" || ctx.ui.router.current().type === "session", run: run(newHere) },
    { id: "ocx.send", title: "Continue remotely", palette: true, slash: { name: "continue-remotely" }, enabled: () => mode() === "local", run: run(send) },
    { id: "ocx.receive", title: `Continue on ${deviceName}`, palette: true, slash: { name: "continue-here", aliases: ["continue-locally"] }, enabled: () => mode() === "remote", run: run(receive) },
    { id: "ocx.recover", title: "Recover transfer", palette: true, slash: { name: "remote-recover" }, run: run(recover) },
  ] }))
  const draftID = process.env.OCX_DRAFT_ID
  let restorationStarted = false
  const restoreDraft = () => {
    if (restorationStarted || !draftID || !ctx.renderer) return
    restorationStarted = true; busy = true
    void restoreComposer(nativeComposer, draftID, Number(process.env.OCX_DRAFT_CURSOR ?? 0), lifetime.signal)
      .then(async () => {
        delete process.env.OCX_DRAFT_ID
        await bridge.action("draftRestored", { id: draftID })
      })
      .catch(error => { if (!stopped) return ctx.ui.dialog.alert({ title: "Saved draft", message: error instanceof Error ? error.message : String(error) }) })
      .finally(() => { busy = false; void refresh() })
  }
  const controls = () => jsx("box", {
    id: "ocx.composer-target", ref: (node: Renderable) => { footerAnchor = node; queueMicrotask(restoreDraft) },
    flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0, height: 1, gap: 1,
    children: [
      jsx("text", {
        id: "ocx.composer-machine", fg: ctx.theme?.text?.base,
        flexShrink: 0, height: 1, wrapMode: "none",
        onMouseUp: run(pickMachine),
        get children() { return `${selectedTarget()?.machine ?? (mode() === "remote" ? "Cloud" : deviceName)} ▾` },
      }),
      jsx("text", {
        id: "ocx.composer-checkout", fg: ctx.theme?.text?.muted,
        flexGrow: 1, flexShrink: 1, minWidth: 0, height: 1, wrapMode: "none", truncate: true,
        onMouseUp: run(() => pickCheckout()),
        get children() {
          const checkout = checkoutContext()
          const branch = checkout?.branch ?? checkout?.name ?? currentDirectory().split("/").filter(Boolean).at(-1) ?? "/"
          return `${selectedTarget()?.checkout ?? branch}${selectedTarget() ? " (new)" : ""} ▾`
        },
      }),
      jsx("text", { fg: ctx.theme?.text?.muted, get children() {
        return pending() ? `${pending()} unfinished transfer${pending() === 1 ? "" : "s"}` : ""
      } }),
    ],
  })
  ctx.ui.slot({ prepend: "prompt.footer.status", render: controls })
  createEffect(() => {
    const route = ctx.ui.router.current()
    if (route.type === "session" && ctx.data.session.status?.(route.sessionID) === "running") return
    // Keep the native interrupt indicator while running. When idle, the
    // checkout control takes the location label's space, including on narrow terminals.
    onCleanup(ctx.ui.slot({ replace: "prompt.footer.status", render: controls }))
  })
  void refresh()
  return () => { stopped = true; lifetime.abort(); thawComposer(); clearInterval(timer) }
}

export default Plugin.define({
  id: "ocx-workspaces",
  setup(ctx) {
    const origin = process.env.OCX_CONTROL_ORIGIN, token = process.env.OCX_CONTROL_TOKEN
    if (!origin || !token) return
    return setupWorkspaceUI(ctx, workspaceBridge(origin, token))
  },
})
