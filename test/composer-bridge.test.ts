import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createControlBridge } from "../packages/client/src/control-bridge"
import { createLocalTuiProxy } from "../packages/client/src/tui-proxy"
import type { RemoteLaunch } from "../packages/client/src/remote"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const basic = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const json = (value: unknown, status = 200) => Response.json(value, { status })
type Call = { executor: "device" | "cloud"; path: string; method: string; body?: any; authorization: string | null }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ocx-composer-bridge-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const calls: Call[] = [], launches: RemoteLaunch[] = []
  const workspaces = new Map([["ws_primary", {
    id: "ws_primary", name: "Current checkout", source: "https://github.com/acme/app.git", root: "/cloud/primary",
    branch: "main", state: "ready", sessionIDs: [], updatedAt: 1,
  }]])
  const sessions = new Map<string, any>()
  let rejectPrompt = false
  const plugin = { id: "cloud_demo", package: "@acme/plugin", version: "1.2.3", scope: "project", projectID: "repo:github.com/acme/app", enabled: true }
  const api = (executor: "device" | "cloud", password: string) => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.headers.get("authorization") !== basic(password)) return json({ error: "Authentication failed" }, 401)
      const content = await request.text(), body = content ? JSON.parse(content) : undefined
      const path = url.pathname + url.search
      calls.push({ executor, path, method: request.method, body, authorization: request.headers.get("authorization") })
      if (executor === "device") return json({ version: "2.3.0", device: true })
      if (path === "/api/ocx/workspaces") {
        if (request.method === "GET") return json({ workspaces: [...workspaces.values()] })
        const workspace = { ...workspaces.get("ws_primary")!, id: body.id, root: `/cloud/${body.id}`, name: body.name, branch: body.newBranch }
        workspaces.set(workspace.id, workspace)
        return json({ workspace }, 201)
      }
      const workspace = path.match(/^\/api\/ocx\/workspaces\/([^/]+)(\/sessions)?$/)
      if (workspace) {
        const checkout = workspaces.get(workspace[1])
        if (!checkout) return json({ error: "Unknown checkout" }, 404)
        if (!workspace[2]) return json({ workspace: checkout })
        const session = { ...body, id: body.id, location: { directory: checkout.root }, title: "Untitled" }
        sessions.set(session.id, session)
        return json({ session }, 201)
      }
      const session = path.match(/^\/api\/(?:experimental\/)?session\/([^/]+)(\/[^?]*)?(?:\?.*)?$/)
      if (session) {
        if (!sessions.has(session[1])) return json({ message: "Unknown conversation" }, 404)
        if (session[2] === "/prompt" && rejectPrompt) { rejectPrompt = false; return json({ message: "Checkout has an active writer" }, 409) }
        if (session[2]) return new Response(null, { status: 204 })
        return json({ data: sessions.get(session[1]) })
      }
      if (path === "/api/ocx/plugins") return json(request.method === "GET" ? { plugins: [plugin] } : { plugin }, request.method === "GET" ? 200 : 201)
      if (path.startsWith("/api/ocx/plugins/")) return json(path.endsWith("/disable") ? { plugin: { ...plugin, enabled: false } } : { plugin })
      return json({ error: "Unexpected request" }, 404)
    },
  })
  const device = api("device", "device-secret"), cloud = api("cloud", "cloud-secret")
  cleanup.push(async () => { await device.stop(true); await cloud.stop(true) })
  const deviceOrigin = `http://127.0.0.1:${device.port}`, cloudOrigin = `http://127.0.0.1:${cloud.port}`
  const control = await createControlBridge({ dataRoot: root, binary: "opencode", local: { server: deviceOrigin, password: "device-secret" },
    initialRemote: { server: cloudOrigin, password: "cloud-secret" }, onSwitch(launch) { launches.push(launch) },
  })
  cleanup.push(() => control.stop())
  const proxy = createLocalTuiProxy(deviceOrigin, "device-secret", control.interceptSubmission)
  cleanup.push(() => proxy.stop())
  const action = async (input: unknown) => {
    const reply = await fetch(control.origin + "/action", { method: "POST", headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" }, body: JSON.stringify(input) })
    return { status: reply.status, value: await reply.json() as any }
  }
  const state = () => fetch(control.origin + "/state", { headers: { authorization: `Bearer ${control.token}` } }).then(reply => reply.json()) as Promise<any>
  const submit = (path: string, body?: unknown, method = "POST") => fetch(proxy.origin + path, {
    method, headers: { authorization: basic(proxy.password), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { root, calls, launches, control, proxy, action, state, submit, rejectNextPrompt() { rejectPrompt = true } }
}

test("native submission routes its full draft to the selected checkout and switches only after admission and activation", async () => {
  const f = await fixture()
  expect((await fetch(f.proxy.origin + "/api/info")).status).toBe(401)
  expect((await fetch(f.proxy.origin + "/api/info", { headers: { authorization: basic("device-secret") } })).status).toBe(401)
  expect((await fetch(f.proxy.origin + "/api/info", { headers: { authorization: basic(f.proxy.password), origin: "https://unrelated.test" } })).status).toBe(401)
  const selection = await f.action({ action: "selectComposerTarget", target: {
    location: "cloud", projectID: "repo:github.com/acme/app", newCheckout: { source: "https://github.com/acme/app.git", branch: "main" },
  } })
  expect(selection.status).toBe(200)
  expect(f.calls.filter(call => call.method !== "GET")).toEqual([])
  expect((await f.state()).autoActivate).toBe(false)
  expect(f.launches).toEqual([])

  // Use the native protocol order, including selection commits before admission.
  const model = { providerID: "acme", id: "coder", variant: "fast" }
  const create = await f.submit("/api/session", { id: "ses_native", agent: "build", model, location: { directory: "/device/source" } })
  expect(create.status).toBe(200)
  expect((await create.json() as any).data.id).toBe("ses_native")
  expect((await f.submit("/api/session/ses_native/environment", { variables: { PROVIDER_TOKEN: "must-stay-on-device" } }, "PUT")).status).toBe(204)
  expect((await f.submit("/api/session/ses_native/agent", { agent: "build" })).status).toBe(204)
  expect((await f.submit("/api/session/ses_native/model", { model })).status).toBe(204)
  expect((await f.state()).autoActivate).toBe(false)
  const prompt = { id: "msg_native", text: "Use this image to fix the checkout.\nKeep the pasted context: αβγ", delivery: "enqueue",
    files: [{ name: "design.png", uri: "data:image/png;base64,aGVsbG8=", source: { path: "/device/private/design.png" } },
      { name: "a b.ts", uri: "file:///device/source/src/a%20b.ts?start=2&end=5" }],
    agents: [{ name: "reviewer" }], skills: [{ name: "typescript" }],
  }
  expect((await f.submit("/api/session/ses_native/prompt", prompt)).status).toBe(204)
  const creation = f.calls.find(call => call.path.endsWith("/sessions"))!
  expect(creation.body).toMatchObject({ id: "ses_native", agent: "build", model })
  expect(f.calls.filter(call => call.path === "/api/ocx/workspaces" && call.method === "POST")).toHaveLength(1)
  expect(f.calls.filter(call => call.path.endsWith("/sessions"))).toHaveLength(1)
  expect(f.calls.find(call => call.path.endsWith("/agent"))?.body).toEqual({ agent: "build" })
  expect(f.calls.find(call => call.path.endsWith("/model"))?.body).toEqual({ model })
  const checkoutID = f.calls.find(call => call.path === "/api/ocx/workspaces" && call.method === "POST")!.body.id
  expect(f.calls.find(call => call.path.endsWith("/prompt"))?.body).toEqual({ ...prompt, files: [
    { name: "design.png", uri: "data:image/png;base64,aGVsbG8=" },
    { name: "a b.ts", uri: `file:///cloud/${checkoutID}/src/a%20b.ts?start=2&end=5` },
  ] })
  expect(JSON.stringify(f.calls)).not.toContain("must-stay-on-device")
  const admitted = await f.state()
  expect(admitted.autoActivate).toBe(true)
  expect(admitted.pending).toMatchObject({ sessionID: "ses_native", local: false })
  expect(f.launches).toEqual([])
  expect(JSON.stringify(admitted)).not.toContain("cloud-secret")
  expect(JSON.stringify(admitted)).not.toContain("device-secret")

  // A next draft typed while the send was in flight moves with the attachment.
  const draft = { prompt: { text: "Next question [Image #1]", files: prompt.files, pasted: [{ text: "full pasted contents", source: { text: "[Pasted]", start: 0, end: 8 } }], agents: prompt.agents, skills: prompt.skills }, cursor: 4 }
  const captured = await f.action({ action: "captureDraft", draft })
  const draftID = captured.value.data.id
  const draftPath = join(f.root, "drafts", draftID + ".json")
  expect(JSON.parse(await readFile(draftPath, "utf8"))).toEqual(draft)
  expect((await stat(draftPath)).mode & 0o077).toBe(0)
  expect((await f.action({ action: "activate", draftID })).status).toBe(200)
  expect(f.launches).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(f.launches).toHaveLength(1)
  expect(f.launches[0]).toMatchObject({ sessionID: "ses_native", password: "cloud-secret", draftID })
  expect((await f.state()).mode).toBe("remote")
})

test("rejected native admission retains its destination for retry and does not trigger a switch", async () => {
  const f = await fixture()
  expect((await f.action({ action: "selectComposerTarget", target: { location: "cloud", workspaceID: "ws_primary" } })).status).toBe(200)
  f.rejectNextPrompt()
  const prompt = { id: "msg_retry", text: "Keep my draft", files: [{ name: "reference.png", uri: "data:image/png;base64,AA==" }] }
  const draft = { prompt: { text: prompt.text, files: prompt.files }, cursor: 4 }
  const draftID = (await f.action({ action: "captureDraft", draft })).value.data.id
  const rejected = await f.submit("/api/session/ses_source/model", { model: { providerID: "acme", id: "coder" } })
  expect(rejected.status).toBe(204)
  const first = await f.submit("/api/session/ses_source/prompt", prompt)
  expect(first.status).toBe(409)
  expect((await first.json() as any).message).toContain("active writer")
  expect((await f.state()).autoActivate).toBe(false)
  expect(f.launches).toEqual([])
  expect(JSON.parse(await readFile(join(f.root, "drafts", draftID + ".json"), "utf8"))).toEqual(draft)
  const second = await f.submit("/api/session/ses_source/prompt", prompt)
  expect(second.status).toBe(204)
  expect(f.calls.filter(call => call.path.endsWith("/sessions"))).toHaveLength(1)
  const attempts = f.calls.filter(call => call.path.endsWith("/prompt"))
  expect(attempts).toHaveLength(2)
  expect(attempts[0].path).toBe(attempts[1].path)
  expect(attempts[0].path).not.toContain("ses_source")
  expect(attempts[0].body).toEqual(prompt)
  expect(attempts[1].body).toEqual(prompt)
  expect((await f.state()).autoActivate).toBe(true)
  expect(f.launches).toEqual([])
})

test("cloud plugin management forwards project scope and keeps server authentication in the parent", async () => {
  const f = await fixture()
  const installed = await f.action({ action: "installCloudPlugin", package: "@acme/plugin@1.2.3", scope: "project", projectID: "repo:github.com/acme/app" })
  expect(installed.status).toBe(200)
  expect(f.calls.find(call => call.path === "/api/ocx/plugins" && call.method === "POST")?.body).toEqual({ package: "@acme/plugin@1.2.3", scope: "project", projectID: "repo:github.com/acme/app" })
  expect((await f.action({ action: "cloudPlugins" })).value.data.plugins[0].id).toBe("cloud_demo")
  expect((await f.action({ action: "manageCloudPlugin", id: "cloud_demo", operation: "disable" })).value.data.plugin.enabled).toBe(false)
  expect((await f.action({ action: "manageCloudPlugin", id: "cloud_demo", operation: "remove" })).status).toBe(200)
  expect(f.calls.some(call => call.path === "/api/ocx/plugins/cloud_demo" && call.method === "DELETE")).toBe(true)
  const management = f.calls.filter(call => call.path.startsWith("/api/ocx/plugins"))
  expect(management.every(call => call.executor === "cloud" && call.authorization === basic("cloud-secret"))).toBe(true)
  expect(JSON.stringify(installed)).not.toContain("cloud-secret")
  expect(JSON.stringify(await f.state())).not.toContain("cloud-secret")
  expect(f.launches).toEqual([])
})
