import { deviceHeader, deviceProtocol, parseSharedDevice, type SharedDevice } from "@ocx/protocol/device"
import { Schema } from "effect"
import { SessionEvent } from "@opencode/schema/session-event"
import { Event } from "@opencode/schema/event"
import type { Bus } from "@opencode/core/bus"
import {
  decodeClient, maxFrameBytes, maxSubscriptions, ping, pong, protocol,
  type Channel, type ClientFrame, type ServerFrame,
} from "@ocx/protocol/transport"

type Subscription = Extract<ClientFrame, { type: "subscribe" }>
interface Attachment {
  version: 2
  device?: SharedDevice
  subscriptions: Subscription[]
}
const isSessionEvent = Schema.is(SessionEvent.Durable)
const encoder = new TextEncoder()
const attachment = (socket: WebSocket): Attachment => socket.deserializeAttachment() as Attachment
const save = (socket: WebSocket, value: Attachment) => socket.serializeAttachment(value)

/** Live subscriptions survive hibernation. HTTP and history never pass through this class. */
export class SocketTransport {
  constructor(
    private readonly state: DurableObjectState,
    private readonly devicesChanged: () => void = () => {},
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong))
    // Old sockets can survive a deployment with incompatible attachments/framing.
    for (const socket of state.getWebSockets()) {
      if (attachment(socket)?.version !== 2) {
        save(socket, { version: 2, subscriptions: [] })
        socket.close(1002, "Transport changed; update ocx and reconnect")
      }
    }
  }

  accept(request: Request): Response {
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? []
    const selectedProtocol = request.headers.has(deviceHeader) ? deviceProtocol : protocol
    if (!protocols.includes(selectedProtocol)) return new Response("Update ocx: unsupported event protocol", { status: 426 })
    let device: SharedDevice | undefined
    const registration = request.headers.get(deviceHeader)
    if (registration) {
      try { device = parseSharedDevice(registration) }
      catch { return new Response("Invalid shared device registration", { status: 400 }) }
    }
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    save(pair[1], { version: 2, subscriptions: [], device })
    if (device) {
      for (const socket of this.state.getWebSockets()) {
        if (socket !== pair[1] && attachment(socket).device?.id === device.id) {
          this.close(socket)
          socket.close(1000, "Device reconnected")
        }
      }
      this.devicesChanged()
    }
    return new Response(null, {
      status: 101, webSocket: pair[0],
      headers: { "sec-websocket-protocol": selectedProtocol },
    })
  }

  private send(socket: WebSocket, frame: ServerFrame): boolean {
    try {
      if (socket.readyState !== WebSocket.OPEN) return false
      const text = JSON.stringify(frame)
      if (encoder.encode(text).byteLength > maxFrameBytes) throw new Error("Event too large")
      socket.send(text)
      return true
    } catch {
      this.close(socket)
      socket.close(1009, "Event delivery failed; reconnect to resync")
      return false
    }
  }

  publish(channel: Channel, data: string): void {
    for (const socket of this.state.getWebSockets()) {
      for (const subscription of attachment(socket).subscriptions) {
        if (subscription.channel === channel && !this.send(socket, { type: "event", id: subscription.id, data })) break
      }
    }
  }

  publishLog(event: Bus.LogItem): void {
    if (!isSessionEvent(event)) return
    const durable = event as Bus.LogItem & { durable: { aggregateID: string; seq: number } }
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const socket of this.state.getWebSockets()) {
      for (const subscription of attachment(socket).subscriptions) {
        if (subscription.channel === "log" && subscription.sessionID === durable.durable.aggregateID) {
          if (!this.send(socket, { type: "event", id: subscription.id, data, seq: durable.durable.seq })) break
        }
      }
    }
  }

  message(socket: WebSocket, message: string | ArrayBuffer): void {
    try {
      if (typeof message !== "string" || encoder.encode(message).byteLength > 4096) throw new Error("Invalid frame")
      const frame = decodeClient(message)
      const stored = attachment(socket)
      if (frame.type === "unsubscribe") {
        stored.subscriptions = stored.subscriptions.filter(item => item.id !== frame.id)
        save(socket, stored)
        return
      }
      if (stored.subscriptions.some(item => item.id === frame.id)) throw new Error("Duplicate subscription")
      if (stored.subscriptions.length >= maxSubscriptions) {
        this.send(socket, { type: "error", id: frame.id, message: "Too many subscriptions" })
        return
      }
      stored.subscriptions.push(frame)
      save(socket, stored)
      this.send(socket, { type: "subscribed", id: frame.id })
      if (frame.channel !== "log") {
        this.send(socket, {
          type: "event", id: frame.id,
          data: frame.channel === "plugins" ? "event: ready\ndata: 0\n\n"
            : `data: ${JSON.stringify({ id: Event.ID.create(), type: "server.connected", data: {} })}\n\n`,
        })
      }
    } catch {
      this.close(socket)
      socket.close(1002, "Invalid subscription frame")
    }
  }

  devices(): SharedDevice[] {
    return this.state.getWebSockets().flatMap(socket => {
      const device = attachment(socket).device
      return socket.readyState === WebSocket.OPEN && device ? [device] : []
    })
  }

  close(socket: WebSocket): void {
    const stored = attachment(socket)
    const hadDevice = !!stored.device
    save(socket, { version: 2, subscriptions: [] })
    if (hadDevice) this.devicesChanged()
  }
}
