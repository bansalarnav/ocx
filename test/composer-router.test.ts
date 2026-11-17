import { describe, expect, test } from "bun:test"
import { ComposerRouter, type ComposerRouterOptions, type ComposerTarget } from "../packages/client/src/composer-router"

const target: ComposerTarget = { location: "cloud", workspaceID: "workspace", machine: "Cloud", checkout: "agent/task", projectID: "repo:example" }
function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`http://127.0.0.1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) })
}
function fixture(overrides: Partial<ComposerRouterOptions> = {}) {
  const created: { target: ComposerTarget; input: Record<string, any> }[] = []
  const forwarded: { path: string; method: string; body?: any }[] = []
  const admitted: string[] = []
  const router = new ComposerRouter({
    async create(target, input) {
      created.push({ target, input })
      return { session: { id: input.id, location: { directory: "/repo" } }, launch: { server: "https://cloud.example", sessionID: input.id, binary: "opencode" } }
    },
    async forward(launch, req, path) {
      forwarded.push({ path, method: req.method, body: req.body ? await req.json() : undefined })
      return ["/agent", "/model"].some(suffix => path.endsWith(suffix)) ? new Response(null, { status: 204 }) : Response.json({ data: { id: launch.sessionID } })
    },
    admitted(launch) { admitted.push(launch.sessionID) },
    ...overrides,
  })
  return { router, created, forwarded, admitted }
}

describe("native composer routing", () => {
  test("selection is lazy and a new native session runs its whole preparation and attachment payload remotely", async () => {
    const f = fixture()
    f.router.select(target)
    expect(f.created).toHaveLength(0)
    const model = { providerID: "example", id: "model", variant: "fast" }
    const create = await f.router.intercept(request("/api/session", { id: "ses_native", agent: "build", model, location: { directory: "/source" } }))
    expect((await create!.json()).data.id).toBe("ses_native")
    await f.router.intercept(request("/api/session/ses_native/environment", { variables: { PRIVATE_TOKEN: "device-secret" } }, "PUT"))
    await f.router.intercept(request("/api/session/ses_native/agent", { agent: "plan" }))
    await f.router.intercept(request("/api/session/ses_native/model", { model }))
    await f.router.intercept(request("/api/session/ses_native/synthetic", { text: "Editor context", resume: false }))
    const prompt = {
      id: "msg_native", text: "Look at the screenshot and @build", delivery: "steer",
      files: [{ uri: "data:image/png;base64,AQID", mediaType: "image/png", filename: "screen.png", source: { text: "@screen", start: 0, end: 7 } }],
      agents: [{ id: "build", mention: { start: 27, end: 33 } }], skills: [{ id: "debug" }], metadata: { origin: "native" },
    }
    await f.router.intercept(request("/api/session/ses_native/prompt", prompt))
    expect(f.created).toHaveLength(1)
    expect(f.created[0].input).toMatchObject({ id: "ses_native", agent: "build", model })
    expect(f.forwarded.map(entry => entry.path)).toEqual([
      "/api/session/ses_native/agent", "/api/session/ses_native/model", "/api/session/ses_native/synthetic", "/api/session/ses_native/prompt",
    ])
    expect(f.forwarded.at(-1)?.body).toEqual(prompt)
    expect(JSON.stringify(f.forwarded)).not.toContain("device-secret")
    expect(f.admitted).toEqual(["ses_native"])
  })

  test("a checkout change in an existing conversation creates a fresh session and leaves its source revert untouched", async () => {
    const f = fixture()
    f.router.select({ ...target, location: "device", checkoutID: "another-checkout" })
    await f.router.intercept(request("/api/session/ses_source/revert/commit", {}))
    expect(f.created).toHaveLength(0)
    await f.router.intercept(request("/api/session/ses_source/model", { model: { providerID: "example", id: "model" } }))
    await f.router.intercept(request("/api/session/ses_source/prompt", { text: "Work in the other checkout" }))
    expect(f.created).toHaveLength(1)
    const id = f.created[0].input.id
    expect(id).toStartWith("ses_")
    expect(id).not.toBe("ses_source")
    expect(f.forwarded.map(entry => entry.path)).toEqual([`/api/session/${id}/model`, `/api/session/${id}/prompt`])
    expect(f.admitted).toEqual([id])
  })

  test("mapped session reads keep query strings and use the destination without creating another session", async () => {
    const f = fixture()
    f.router.select(target)
    await f.router.intercept(request("/api/session", { id: "ses_native" }))
    await f.router.intercept(request("/api/session/ses_native"))
    await f.router.intercept(request("/api/experimental/session/ses_native/log?after=event_1&follow=false"))
    expect(f.created).toHaveLength(1)
    expect(f.forwarded).toEqual([
      { path: "/api/session/ses_native", method: "GET", body: undefined },
      { path: "/api/experimental/session/ses_native/log?after=event_1&follow=false", method: "GET", body: undefined },
    ])
    expect(await f.router.intercept(request("/api/session/ses_unrelated"))).toBeUndefined()
    expect(await f.router.intercept(request("/api/config"))).toBeUndefined()
    expect(f.admitted).toHaveLength(0)
  })

  test("a rejected admission can retry its session, change destination, or cancel the selection", async () => {
    let accept = false
    const f = fixture({ forward: async () => Response.json({ error: "Model not configured" }, { status: accept ? 200 : 422 }) })
    f.router.select(target)
    const first = await f.router.intercept(request("/api/session/ses_source/prompt", { text: "Keep my draft" }))
    expect(first!.status).toBe(422)
    expect(f.admitted).toHaveLength(0)
    await f.router.intercept(request("/api/session/ses_source/prompt", { text: "Retry it" }))
    expect(f.created).toHaveLength(1)
    f.router.select({ ...target, workspaceID: "other-workspace" })
    await f.router.intercept(request("/api/session/ses_source/prompt", { text: "Another destination" }))
    expect(f.created).toHaveLength(2)
    f.router.select(undefined)
    expect(await f.router.intercept(request("/api/session/ses_source/prompt", { text: "Device fallback" }))).toBeUndefined()
    f.router.select(target)
    accept = true
    await f.router.intercept(request("/api/session/ses_source/prompt", { text: "Now accepted" }))
    expect(f.admitted).toHaveLength(1)
    expect(() => f.router.select(undefined)).toThrow("Wait for the current submission")
    f.router.clear()
    f.router.select(undefined)
  })

  test("concurrent native preparation shares creation and cannot change destination halfway through a request", async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    let creates = 0
    const f = fixture({ async create(_target, input) {
      creates++
      await pending
      return { session: { id: input.id }, launch: { server: "https://cloud.example", sessionID: input.id, binary: "opencode" } }
    } })
    f.router.select(target)
    const agent = f.router.intercept(request("/api/session/ses_source/agent", { agent: "build" }))
    const model = f.router.intercept(request("/api/session/ses_source/model", { model: { providerID: "example", id: "model" } }))
    expect(() => f.router.select(undefined)).toThrow("Wait for the current submission")
    finish()
    await Promise.all([agent, model])
    expect(creates).toBe(1)
    expect(f.forwarded).toHaveLength(2)
    expect(f.forwarded[0].path.split("/")[3]).toBe(f.forwarded[1].path.split("/")[3])
    f.router.select(undefined)
  })
})
