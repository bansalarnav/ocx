import { SharedDevices } from "./shared-devices"
import { DurableObject } from "cloudflare:workers"
import { isOpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Layer, ManagedRuntime } from "effect"
import { socketPath } from "@ocx/protocol/transport"
import { Host, hostLayer, type HostEnv } from "./host"
import { makePluginStore, PluginStore } from "./plugin-manager/store"
import { authenticated, makeTuiRegistryEvents, makeTuiRegistryHandler } from "./tui-registry"
import { SocketTransport } from "./transport"

export interface Env extends HostEnv {
  OPENCODE: DurableObjectNamespace<OpenCodeDO>
}

export class OpenCodeDO extends DurableObject<Env> {
  private readonly transport: SocketTransport
  private readonly runtime: ManagedRuntime.ManagedRuntime<Host, never>
  private readonly registry: ReturnType<typeof makeTuiRegistryHandler>

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    const devices = new SharedDevices(() => this.transport.devices())
    this.transport = new SocketTransport(state, (request) => this.fetch(request), () => devices.changed())
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
        devices,
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
  fetch: (request, env) => {
    if (!env.OPENCODE_PASSWORD) return new Response("Set OPENCODE_PASSWORD before using this server", { status: 503 })
    if (!authenticated(request, env.OPENCODE_PASSWORD)) return new Response("Unauthorized", { status: 401 })
    return env.OPENCODE.get(env.OPENCODE.idFromName("default")).fetch(request)
  },
} satisfies ExportedHandler<Env>
