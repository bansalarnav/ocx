import { SharedDevices } from "./shared-devices"
import { DurableObject } from "cloudflare:workers"
import { isOpenCodeEvent } from "@opencode/protocol/groups/event"
import { Effect, Layer, ManagedRuntime } from "effect"
import { socketPath } from "@ocx/protocol/transport"
import { Host, hostLayer, type HostEnv } from "./host"
import { makePluginStore, PluginStore } from "./plugin-manager/store"
import { authenticated, makeTuiRegistryEvents, makeTuiRegistryHandler } from "./tui-registry"
import { SocketTransport } from "./transport"
import { makeInstanceConfigHandler, makeInstanceConfigStore } from "./instance-config"
import { WorkspaceManager, type WorkspaceEnv } from "./remote/manager"
import { workspaceHandler, workspaceExecutionGuard } from "./remote/http"
import { githubHandler } from "./remote/github"

export interface Env extends HostEnv, WorkspaceEnv {
  OPENCODE: DurableObjectNamespace<OpenCodeDO>
}

export class OpenCodeDO extends DurableObject<Env> {
  private readonly transport: SocketTransport
  private readonly runtime: ManagedRuntime.ManagedRuntime<Host, never>
  private readonly registry: ReturnType<typeof makeTuiRegistryHandler>
  private readonly instanceConfig: ReturnType<typeof makeInstanceConfigHandler>
  private readonly workspaces: WorkspaceManager
  private readonly workspaceRoutes: ReturnType<typeof workspaceHandler>
  private readonly githubRoutes: ReturnType<typeof githubHandler>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    const devices = new SharedDevices(() => this.transport.devices())
    this.transport = new SocketTransport(state, () => devices.changed())
    const events = makeTuiRegistryEvents(() =>
      this.transport.publish("plugins", "event: changed\ndata: 0\n\n"),
    )
    const store = makePluginStore(state.storage, events.publish)
    const instanceConfig = makeInstanceConfigStore(state.storage)
    this.registry = makeTuiRegistryHandler(store, env.OPENCODE_PASSWORD, events)
    this.instanceConfig = makeInstanceConfigHandler(instanceConfig, env.OPENCODE_PASSWORD)
    this.workspaces = new WorkspaceManager(state.storage, env, async (path, method = "GET", body) => {
      const response = await this.runtime.runPromise(Effect.gen({ self: this }, function* () {
        return yield* (yield* Host).fetch(new Request(`https://opencode.internal${path}`, {
          method, headers: { authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }))
      }))
      const text = await response.text()
      if (!response.ok) throw new Error(`OpenCode ${response.status}: ${text}`)
      return text ? JSON.parse(text) : undefined
    })
    this.workspaceRoutes = workspaceHandler(this.workspaces)
    this.githubRoutes = githubHandler(state.storage, env)
    this.runtime = ManagedRuntime.make(
      hostLayer(state.storage, env, instanceConfig, (event) =>
        Effect.sync(() => {
          this.transport.publishLog(event)
          if (isOpenCodeEvent(event))
            this.transport.publish("opencode", `data: ${JSON.stringify(event)}\n\n`)
        }),
        devices, this.workspaces,
      ).pipe(Layer.provide(Layer.succeed(PluginStore, store))),
    )
  }

  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === socketPath) {
      if (!authenticated(request, this.env.OPENCODE_PASSWORD))
        return Promise.resolve(new Response("Unauthorized", { status: 401 }))
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return Promise.resolve(new Response("WebSocket required", { status: 426 }))
      return Promise.resolve(this.transport.accept(request))
    }
    return this.fetchHTTP(request)
  }

  private async fetchHTTP(request: Request): Promise<Response> {
    const github = await this.githubRoutes(request)
    if (github) return github
    const workspace = await this.workspaceRoutes(request)
    if (workspace) return workspace
    const rejected = await workspaceExecutionGuard(this.workspaces, request)
    if (rejected) return rejected
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const configured = yield* this.instanceConfig(request)
        if (configured) {
          if (configured.changed) yield* (yield* Host).invalidate
          return configured.response
        }
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
  fetch: (request, env) => {
    if (!env.OPENCODE_PASSWORD) return new Response("Set OPENCODE_PASSWORD before using this server", { status: 503 })
    if (!authenticated(request, env.OPENCODE_PASSWORD)) return new Response("Unauthorized", { status: 401 })
    return env.OPENCODE.get(env.OPENCODE.idFromName("default")).fetch(request)
  },
} satisfies ExportedHandler<Env>
