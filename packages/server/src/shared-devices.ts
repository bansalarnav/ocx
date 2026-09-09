import { deviceName, devicePrefix, type SharedDevice } from "@ocx/protocol/device"
import { Mcp } from "@opencode-ai/core/mcp/index"
import { Context, Effect, Layer } from "effect"
import { deviceMcpServers } from "./device-mcps"

/** Registrations live only in WebSocket attachments, including across hibernation. */
export class SharedDevices {
  private readonly listeners = new Set<() => void>()
  constructor(readonly list: () => SharedDevice[]) {}

  changed() {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Recheck cached tool calls at execution time and interrupt calls when access is revoked. */
  guard<A, E, R>(server: string, effect: Effect.Effect<A, E, R>) {
    if (!server.startsWith(devicePrefix)) return effect
    const disconnected = () => new Mcp.ToolCallError({ server: Mcp.ServerName.make(server), tool: "device", message: "Shared device disconnected" })
    return Effect.suspend(() => {
      const device = this.list().find(device => deviceName(device) === server)
      if (!device) return Effect.fail(disconnected())
      const revoked = Effect.callback<never, Mcp.ToolCallError>(resume => {
        const check = () => {
          if (!this.list().some(current => current.id === device.id && current.token === device.token && current.url === device.url)) {
            resume(Effect.fail(disconnected()))
          }
        }
        const unsubscribe = this.subscribe(check)
        check()
        return Effect.sync(unsubscribe)
      })
      return Effect.raceFirst(effect, revoked)
    })
  }

  node = Mcp.node.mapLayer(layer => Layer.flatMap(layer, context => Layer.effect(Mcp.Service,
    Effect.gen({ self: this }, function* () {
      const service = Context.get(context, Mcp.Service)
      yield* service.transform(draft => {
        for (const [name] of draft.list()) if (name.startsWith(devicePrefix)) draft.remove(name)
        for (const device of this.list()) {
          const config = deviceMcpServers({ DEVICE_MCP_URL: device.url, DEVICE_MCP_TOKEN: device.token }).device!
          draft.set(deviceName(device), config)
        }
      })
      const scope = yield* Effect.scope
      const unsubscribe = this.subscribe(() => {
        Effect.runFork(service.reload().pipe(Effect.forkIn(scope), Effect.asVoid))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
      return Mcp.Service.of({ ...service, callTool: input => this.guard(input.server, service.callTool(input)) })
    }),
  )))
}
