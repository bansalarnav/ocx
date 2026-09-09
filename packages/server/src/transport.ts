import { deviceHeader, deviceProtocol, parseSharedDevice, type SharedDevice } from "@ocx/protocol/device"
import { Schema } from "effect"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import type { Bus } from "@opencode-ai/core/bus"
import { logTarget, replayCursor, type DurableEvent } from "./log-replay"
import { Event } from "@opencode-ai/schema/event"
import { Deferred, Effect } from "effect"
import { attempt, evaluate } from "@ocx/protocol/errors"
import {
  chunkSize,
  decodeBytes,
  decodeClient,
  encodeBytes,
  eventChannel,
  maxFrameBytes,
  maxRequests,
  maxSubscriptions,
  ping,
  pong,
  protocol,
  wireHeaders,
  type Channel,
  type ClientFrame,
  type ServerFrame,
} from "@ocx/protocol/transport"

interface Subscription {
  id: string
  channel: Channel | "log"
  credit: number
  sessionID?: string
  cursor?: number
}
interface Replay {
  sessionID: string
  events: DurableEvent[]
  bytes: number
  overflow: boolean
}
const isSessionEvent = Schema.is(SessionEvent.Durable)
interface Attachment {
  version: 1
  origin: string
  authorization: string | null
  device?: SharedDevice
  subscriptions: Subscription[]
}
interface Exchange {
  abort: AbortController
  upload?: WritableStreamDefaultWriter<Uint8Array>
  credit: Deferred.Deferred<void>
  replay?: Replay
}

const attachment = (socket: WebSocket): Attachment => socket.deserializeAttachment() as Attachment
const save = (socket: WebSocket, value: Attachment) => socket.serializeAttachment(value)
const send = (socket: WebSocket, frame: ServerFrame) => socket.send(JSON.stringify(frame))
const sseHeaders: [string, string][] = [
  ["content-type", "text/event-stream"],
  ["cache-control", "no-cache, no-transform"],
]

/** Cloudflare callbacks are the runtime boundary. Only ordinary exchanges own fibers. */
export class SocketTransport {
  private readonly exchanges = new Map<WebSocket, Map<string, Exchange>>()

  constructor(
    private readonly state: DurableObjectState,
    private readonly handle: (request: Request) => Promise<Response>,
    private readonly devicesChanged: () => void = () => {},
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong))
  }

  accept(request: Request): Response {
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? []
    const selectedProtocol = request.headers.has(deviceHeader) ? deviceProtocol : protocol
    if (!protocols.includes(selectedProtocol)) {
      return new Response("Unsupported transport version", { status: 426 })
    }
    let device: SharedDevice | undefined
    const registration = request.headers.get(deviceHeader)
    if (registration) {
      try { device = parseSharedDevice(registration) }
      catch { return new Response("Invalid shared device registration", { status: 400 }) }
    }
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    save(pair[1], {
      version: 1,
      origin: new URL(request.url).origin,
      authorization: request.headers.get("authorization"),
      subscriptions: [],
      device,
    })
    if (device) {
      // A reconnect replaces its previous socket, including one whose close has not arrived.
      for (const socket of this.state.getWebSockets()) {
        if (socket !== pair[1] && attachment(socket).device?.id === device.id) {
          this.close(socket)
          socket.close(1000, "Device reconnected")
        }
      }
      this.devicesChanged()
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": selectedProtocol },
    })
  }

  publish(channel: Channel, text: string): void {
    const bytes = new TextEncoder().encode(text)
    const count = Math.ceil(bytes.byteLength / chunkSize)
    for (const socket of this.state.getWebSockets()) {
      try {
        const stored = attachment(socket)
        for (const subscription of [...stored.subscriptions]) {
          if (subscription.channel !== channel) continue
          if (subscription.credit < count) {
            send(socket, {
              type: "error",
              id: subscription.id,
              message: "Event subscriber overflow; reconnect to resync",
            })
            stored.subscriptions = stored.subscriptions.filter((item) => item !== subscription)
            continue
          }
          subscription.credit -= count
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            send(socket, {
              type: "chunk",
              id: subscription.id,
              data: encodeBytes(bytes.subarray(offset, offset + chunkSize)),
            })
          }
        }
        save(socket, stored)
      } catch {
        this.close(socket)
      }
    }
  }

  publishLog(event: Bus.LogItem): void {
    if (!isSessionEvent(event)) return
    const durable = event as DurableEvent
    const text = `data: ${JSON.stringify(event)}\n\n`
    const bytes = new TextEncoder().encode(text)
    for (const requests of this.exchanges.values()) {
      for (const exchange of requests.values()) {
        const replay = exchange.replay
        if (!replay || replay.sessionID !== durable.durable.aggregateID || replay.overflow) continue
        replay.bytes += bytes.byteLength
        if (replay.bytes > 2 * 1024 * 1024) {
          replay.overflow = true
          replay.events = []
          continue
        }
        replay.events.push(durable)
      }
    }
    for (const socket of this.state.getWebSockets()) {
      try {
        const stored = attachment(socket)
        for (const subscription of [...stored.subscriptions]) {
          if (subscription.channel === "log") this.deliverLog(socket, stored, subscription, durable)
        }
        save(socket, stored)
      } catch {
        this.close(socket)
      }
    }
  }

  private deliverLog(
    socket: WebSocket,
    stored: Attachment,
    subscription: Subscription,
    event: DurableEvent,
  ) {
    if (!stored.subscriptions.includes(subscription)) return
    if (
      subscription.sessionID !== event.durable.aggregateID ||
      event.durable.seq <= (subscription.cursor ?? -1)
    )
      return
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    const count = Math.ceil(bytes.byteLength / chunkSize)
    if (subscription.credit < count) {
      send(socket, {
        type: "error",
        id: subscription.id,
        message: "Session log subscriber overflow; reconnect from the last sequence",
      })
      stored.subscriptions = stored.subscriptions.filter((item) => item !== subscription)
      return
    }
    subscription.credit -= count
    subscription.cursor = event.durable.seq
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      send(socket, {
        type: "chunk",
        id: subscription.id,
        data: encodeBytes(bytes.subarray(offset, offset + chunkSize)),
      })
    }
  }

  message(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const frame = yield* evaluate("Decode transport frame", () => {
          if (
            typeof message !== "string" ||
            new TextEncoder().encode(message).byteLength > maxFrameBytes
          ) {
            throw new Error("Invalid transport frame")
          }
          return decodeClient(message)
        })
        const stored = attachment(socket)
        const subscription = stored.subscriptions.find((item) => item.id === frame.id)
        if (frame.type === "cancel") {
          stored.subscriptions = stored.subscriptions.filter((item) => item.id !== frame.id)
          save(socket, stored)
          this.exchanges.get(socket)?.get(frame.id)?.abort.abort()
          return
        }
        if (frame.type === "ack") {
          if (subscription) {
            subscription.credit = Math.min(64, subscription.credit + 1)
            save(socket, stored)
          } else {
            const exchange = this.exchanges.get(socket)?.get(frame.id)
            if (exchange) yield* Deferred.succeed(exchange.credit, undefined)
          }
          return
        }
        if (frame.type === "request") {
          if (subscription || this.exchanges.get(socket)?.has(frame.id)) {
            socket.close(1008, "Duplicate request id")
            this.close(socket)
            return
          }
          if (
            !frame.path.startsWith("/") ||
            frame.path.startsWith("//") ||
            /[\\\r\n]/.test(frame.path)
          ) {
            send(socket, { type: "error", id: frame.id, message: "Invalid request path" })
            return
          }
          const channel = eventChannel(frame.path)
          if (channel && frame.method === "GET" && !frame.body) {
            if (stored.subscriptions.length >= maxSubscriptions) {
              send(socket, { type: "error", id: frame.id, message: "Too many subscriptions" })
              return
            }
            stored.subscriptions.push({ id: frame.id, channel, credit: 63 })
            save(socket, stored)
            send(socket, {
              type: "response",
              id: frame.id,
              status: 200,
              statusText: "OK",
              headers: sseHeaders,
            })
            const connected =
              channel === "plugins"
                ? "event: ready\ndata: 0\n\n"
                : `data: ${JSON.stringify({ id: Event.ID.create(), type: "server.connected", data: {} })}\n\n`
            send(socket, {
              type: "chunk",
              id: frame.id,
              data: encodeBytes(new TextEncoder().encode(connected)),
            })
            return
          }
          yield* this.request(socket, frame)
          return
        }
        const exchange = this.exchanges.get(socket)?.get(frame.id)
        if (!exchange?.upload) return
        yield* Effect.gen(function* () {
          if (frame.type === "end") {
            yield* attempt("Finish request body", () => exchange.upload!.close())
          } else {
            const bytes = yield* evaluate("Decode request body", () => decodeBytes(frame.data))
            yield* attempt("Write request body", () => exchange.upload!.write(bytes))
            send(socket, { type: "ack", id: frame.id })
          }
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              // A route may finish its response without consuming the entire upload.
              exchange.abort.abort()
              send(socket, { type: "error", id: frame.id, message: "Request body was closed" })
            }),
          ),
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error("ocx transport", cause)
            socket.close(1011, "Transport failed")
            this.close(socket)
          }),
        ),
      ),
    )
  }

  private request(socket: WebSocket, frame: Extract<ClientFrame, { type: "request" }>) {
    return Effect.gen({ self: this }, function* () {
      let requests = this.exchanges.get(socket)
      if (!requests) this.exchanges.set(socket, (requests = new Map()))
      if (requests.size >= maxRequests) {
        send(socket, { type: "error", id: frame.id, message: "Too many requests" })
        return
      }
      const log =
        frame.method === "GET" && !frame.body
          ? yield* evaluate("Read log target", () => logTarget(frame.path))
          : undefined
      if (
        log &&
        attachment(socket).subscriptions.length +
          Array.from(requests.values()).filter((exchange) => exchange.replay).length >=
          maxSubscriptions
      ) {
        send(socket, { type: "error", id: frame.id, message: "Too many subscriptions" })
        return
      }
      const body = frame.body ? new TransformStream<Uint8Array, Uint8Array>() : undefined
      const exchange: Exchange = {
        abort: new AbortController(),
        upload: body?.writable.getWriter(),
        credit: Deferred.makeUnsafe(),
      }
      if (log) exchange.replay = { sessionID: log.sessionID, events: [], bytes: 0, overflow: false }
      requests.set(frame.id, exchange)
      const headers = new Headers(frame.headers as [string, string][])
      headers.delete("host")
      headers.delete(deviceHeader)
      const authorization = attachment(socket).authorization
      if (authorization) headers.set("authorization", authorization)
      else headers.delete("authorization")
      const work = Effect.gen({ self: this }, function* () {
        const request = yield* evaluate(
          "Build proxied request",
          () =>
            new Request(new URL(log?.path ?? frame.path, attachment(socket).origin), {
              method: frame.method,
              headers,
              body: body?.readable,
              signal: exchange.abort.signal,
            }),
        )
        const response = yield* attempt("OpenCode request", () => this.handle(request))
        const cursor = log && response.ok ? replayCursor() : undefined
        send(socket, {
          type: "response",
          id: frame.id,
          status: response.status,
          statusText: response.statusText,
          headers: wireHeaders(response.headers),
        })
        if (response.body) {
          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => response.body!.getReader()),
            (reader) => attempt("Cancel response", () => reader.cancel()).pipe(Effect.ignore),
          )
          while (true) {
            const next = yield* attempt("Read response", () => reader.read())
            if (next.done) break
            if (cursor) yield* cursor.write(next.value)
            for (let offset = 0; offset < next.value.byteLength; offset += chunkSize) {
              exchange.credit = Deferred.makeUnsafe()
              send(socket, {
                type: "chunk",
                id: frame.id,
                data: encodeBytes(next.value.subarray(offset, offset + chunkSize)),
              })
              yield* Deferred.await(exchange.credit).pipe(Effect.timeout("60 seconds"))
            }
          }
        }
        if (cursor && exchange.replay) {
          const through = yield* cursor.finish
          if (exchange.abort.signal.aborted) return yield* Effect.interrupt
          const replay = exchange.replay
          if (replay.overflow)
            return yield* Effect.fail(new Error("Session log overflow during replay"))
          const stored = attachment(socket)
          const subscription: Subscription = {
            id: frame.id,
            channel: "log",
            sessionID: replay.sessionID,
            cursor: through,
            credit: 64,
          }
          stored.subscriptions.push(subscription)
          // No yield between snapshot handoff and draining buffered events.
          exchange.replay = undefined
          for (const event of replay.events.sort(
            (left, right) => left.durable.seq - right.durable.seq,
          ))
            this.deliverLog(socket, stored, subscription, event)
          save(socket, stored)
        } else {
          send(socket, { type: "end", id: frame.id })
        }
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            try {
              send(socket, {
                type: "error",
                id: frame.id,
                message: "Request failed or was cancelled",
              })
            } catch {}
            if (!exchange.abort.signal.aborted) console.error("ocx request", cause)
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            requests.delete(frame.id)
            if (requests.size === 0) this.exchanges.delete(socket)
            void exchange.upload?.abort().catch(() => undefined)
          }),
        ),
      )
      // This handler stays pending for the exchange, preventing hibernation mid-request.
      const cancelled = Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt)
        exchange.abort.signal.addEventListener("abort", abort, { once: true })
        if (exchange.abort.signal.aborted) abort()
        return Effect.sync(() => exchange.abort.signal.removeEventListener("abort", abort))
      })
      yield* Effect.raceFirst(work, cancelled).pipe(Effect.ignoreCause)
    })
  }

  devices(): SharedDevice[] {
    return this.state.getWebSockets().flatMap(socket => {
      const device = attachment(socket).device
      return socket.readyState === WebSocket.OPEN && device ? [device] : []
    })
  }

  close(socket: WebSocket): void {
    const stored = attachment(socket)
    if (stored.device) {
      delete stored.device
      save(socket, stored)
      this.devicesChanged()
    }
    for (const exchange of this.exchanges.get(socket)?.values() ?? []) exchange.abort.abort()
    this.exchanges.delete(socket)
  }
}
