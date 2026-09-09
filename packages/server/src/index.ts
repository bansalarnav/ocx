import { DurableObject } from "cloudflare:workers"
import { isOpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Layer, ManagedRuntime } from "effect"
import { socketPath } from "@ocx/protocol/transport"
import { Host, hostLayer, type HostEnv } from "./host"
import { makePluginStore, PluginStore } from "./plugin-manager/store"
import { authenticated, makeTuiRegistryEvents, makeTuiRegistryHandler } from "./tui-registry"
import { catalog, computer, type RemoteEnv } from "./remote/catalog"
import { workspaceAPI, workspaceHeader, workspaceID, remotePath, executionBackend } from "@ocx/protocol/workspaces"
export { RemoteComputer, WorkspaceServiceProxy } from "./remote/computer"
export { WorkspaceCatalog } from "./remote/catalog"
import { SocketTransport } from "./transport"

export interface Env extends HostEnv, RemoteEnv {
  OPENCODE: DurableObjectNamespace<OpenCodeDO>
}

export class OpenCodeDO extends DurableObject<Env> {
  private workspace?: string
  private readonly transport: SocketTransport
  private readonly runtime: ManagedRuntime.ManagedRuntime<Host, never>
  private readonly registry: ReturnType<typeof makeTuiRegistryHandler>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.transport = new SocketTransport(state, (request) => this.fetch(request))
    const events = makeTuiRegistryEvents(() =>
      this.transport.publish("plugins", "event: changed\ndata: 0\n\n"),
    )
    const store = makePluginStore(state.storage, events.publish)
    this.registry = makeTuiRegistryHandler(store, env.OPENCODE_PASSWORD, events)
    this.runtime = ManagedRuntime.make(
      hostLayer(state.storage, env, (event) =>
        Effect.sync(() => {
          this.transport.publishLog(event)
          if (isOpenCodeEvent(event))
            this.transport.publish("opencode", `data: ${JSON.stringify(event)}\n\n`)
        }),
        { computer: () => {
          if (!this.workspace) throw new Error("No remote checkout attached. Use /workspaces in the TUI.")
          return computer(env, this.workspace)
        },
        attached: () => Boolean(this.workspace),
        git: (operation, branch) => {
          if (!this.workspace) throw new Error("Attach a remote workspace first")
          return catalog(env).git(this.workspace, operation, branch)
        } },
      ).pipe(Layer.provide(Layer.succeed(PluginStore, store))),
    )
  }

  async fetch(request: Request): Promise<Response> {
    if (!authenticated(request, this.env.OPENCODE_PASSWORD)) return new Response("Unauthorized", { status: 401 })
    const supplied = request.headers.get(workspaceHeader)
    if (supplied) {
      const id = workspaceID(supplied)
      const previous = this.workspace ?? await this.ctx.storage.get<string>("ocx:workspace")
      if (previous && previous !== id) return new Response("Workspace mismatch", { status: 409 })
      this.workspace = id
      if (!previous) await this.ctx.storage.put("ocx:workspace", id)
    } else this.workspace ??= await this.ctx.storage.get<string>("ocx:workspace")
    const url = new URL(request.url)
    if (url.pathname === workspaceAPI + "/current") {
      return Response.json(this.workspace ? await catalog(this.env).get(this.workspace) : null)
    }
    if (url.pathname.startsWith(workspaceAPI + "/exec")) {
      if (!this.workspace) return Response.json({ error: "Attach a workspace first" }, { status: 409 })
      try {
        const instance = computer(this.env, this.workspace)
        if (url.pathname === workspaceAPI + "/exec" && request.method === "POST") {
          const input = await request.json() as { command: string; cwd?: string; timeoutMs?: number; backend?: unknown }
          return Response.json(await instance.start(input.command, remotePath(input.cwd), input.timeoutMs, undefined, undefined, executionBackend(input.backend)), { status: 202 })
        }
        const match = /^\/api\/remote\/exec\/([^/]+)$/.exec(url.pathname)
        if (match && request.method === "GET") return Response.json(await instance.run(workspaceID(match[1])))
        if (match && request.method === "DELETE") { await instance.stop(workspaceID(match[1])); return new Response(null, { status: 204 }) }
        return new Response("Not found", { status: 404 })
      } catch (error) { return Response.json({ error: String(error) }, { status: 400 }) }
    }
    if (url.pathname.startsWith(workspaceAPI + "/")) return catalog(this.env).fetch(request)

    if (new URL(request.url).pathname === socketPath) {
      if (!authenticated(request, this.env.OPENCODE_PASSWORD))
        return Promise.resolve(new Response("Unauthorized", { status: 401 }))
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return Promise.resolve(new Response("WebSocket required", { status: 426 }))
      return Promise.resolve(this.transport.accept(request))
    }
    if (this.workspace) {
      url.searchParams.set("location[directory]", "/workspace/repo")
      url.searchParams.delete("location[workspace]")
      request = new Request(url, request)
    }
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const response = yield* this.registry(request)
        if (response) return response
        const host = yield* Host
        return yield* host.fetch(request)
      }),
    )
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return this.transport.message(socket, message)
  }
  webSocketClose(socket: WebSocket) {
    this.transport.close(socket)
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING)
      socket.close(1000, "Peer disconnected")
  }
  webSocketError(socket: WebSocket) {
    this.transport.close(socket)
    socket.close(1011, "WebSocket error")
  }
}

export default {
  async fetch(request, env) {
    // This is a single-owner remote server. Fail closed before exposing repositories or credentials.
    if (!env.OPENCODE_PASSWORD) return new Response("Set OPENCODE_PASSWORD before using remote workspaces", { status: 503 })
    if (!authenticated(request, env.OPENCODE_PASSWORD)) return new Response("Unauthorized", { status: 401 })
    const url = new URL(request.url)
    const selected = url.searchParams.get("workspace")
    const headers = new Headers(request.headers)
    headers.delete(workspaceHeader)
    let id: string | undefined
    try {
      if (selected) {
        id = workspaceID(selected)
        const row = await catalog(env).get(id)
        if (!row || row.status !== "ready") return Response.json({ error: "Workspace is not ready" }, { status: 409 })
        headers.set(workspaceHeader, id)
      }
    } catch { return new Response("Invalid workspace", { status: 400 }) }
    return env.OPENCODE.get(env.OPENCODE.idFromName(id ? `workspace:${id}` : "default")).fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>
