import { deviceHeader, deviceProtocol, type SharedDevice } from "@ocx/protocol/device"
import { Context, Deferred, Effect, Layer, Schedule } from "effect"
import WebSocket from "ws"
import {
  decodeServer, maxBufferedBytes, maxFrameBytes, maxSubscriptions, ping, pong, protocol,
  socketPath, subscriptionTarget, TransportError, wireHeaders,
  type ClientFrame, type EventFrame, type ServerFrame,
} from "@ocx/protocol/transport"
import { replayCursor } from "./log-replay"

interface Subscription {
  ready: Deferred.Deferred<void, TransportError>
  controller: ReadableStreamDefaultController<EventFrame>
  abort: AbortController
  socket: WebSocket
  cleanup: () => void
}

export class Transport extends Context.Service<
  Transport,
  { readonly fetch: (request: Request) => Effect.Effect<Response, TransportError> }
>()("ocx/Transport") {}

const failure = (message: string, cause?: unknown) => new TransportError({ message, cause })
const encoder = new TextEncoder()
const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" }

export const transportLayer = (origin: string, password?: string, device?: SharedDevice) =>
  Layer.effect(Transport, Effect.gen(function* () {
    const subscriptions = new Map<string, Subscription>()
    const authorization = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined
    let socket: WebSocket | undefined
    let ready = Deferred.makeUnsafe<WebSocket, TransportError>()
    let lastPong = 0

    const send = (ws: WebSocket, frame: ClientFrame) => {
      if (ws.readyState !== WebSocket.OPEN) throw failure("Event socket disconnected")
      if (ws.bufferedAmount > maxBufferedBytes) throw failure("Event socket send buffer full")
      ws.send(JSON.stringify(frame))
    }
    const stop = (id: string, error = failure("Subscription cancelled"), notify = true, abort = true) => {
      const item = subscriptions.get(id)
      if (!item) return
      subscriptions.delete(id)
      item.cleanup()
      if (abort) item.abort.abort(error)
      Effect.runSync(Deferred.fail(item.ready, error))
      try { item.controller.error(error) } catch {}
      if (notify) {
        try { send(item.socket, { type: "unsubscribe", id }) }
        catch { item.socket.terminate() }
      }
    }
    const failSubscriptions = (error: TransportError) => {
      for (const id of subscriptions.keys()) stop(id, error, false)
    }
    const receive = (frame: ServerFrame) => {
      const item = subscriptions.get(frame.id)
      if (!item) return
      if (frame.type === "subscribed") {
        Effect.runSync(Deferred.succeed(item.ready, undefined))
      } else if (frame.type === "error") {
        stop(frame.id, failure(frame.message))
      } else {
        const bytes = encoder.encode(frame.data).byteLength
        if (bytes > (item.controller.desiredSize ?? 0)) {
          stop(frame.id, failure("Event buffer overflow; reconnect to resync"))
          return
        }
        item.controller.enqueue(frame)
      }
    }

    const connection = Effect.scoped(Effect.gen(function* () {
      const url = new URL(socketPath, origin)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      const selectedProtocol = device ? deviceProtocol : protocol
      const ws = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocket(url, selectedProtocol, {
          headers: {
            ...(authorization ? { authorization } : {}),
            ...(device ? { [deviceHeader]: JSON.stringify(device) } : {}),
          },
          handshakeTimeout: 10_000,
          maxPayload: maxFrameBytes,
        })),
        ws => Effect.sync(() => {
          ws.removeAllListeners()
          ws.on("error", () => {})
          ws.terminate()
        }),
      )
      yield* Effect.callback<void, TransportError>(resume => {
        ws.on("open", () => {
          if (ws.protocol !== selectedProtocol) {
            resume(Effect.fail(failure("Event protocol mismatch; update ocx and the Worker together")))
            return
          }
          socket = ws
          lastPong = Date.now()
          Effect.runSync(Deferred.succeed(ready, ws))
        })
        // Process in wire order; no detached per-message fibers or acknowledgements.
        ws.on("message", (data, binary) => {
          try {
            if (binary) throw new Error("Expected a text event frame")
            const text = data.toString()
            if (text === pong) { lastPong = Date.now(); return }
            receive(decodeServer(text))
          } catch (cause) {
            resume(Effect.fail(failure("Invalid event frame", cause)))
          }
        })
        ws.on("error", cause => resume(Effect.fail(failure(
          `Event WebSocket connection failed: ${cause.message}; check credentials and update ocx/Worker together`, cause,
        ))))
        ws.on("close", () => resume(Effect.fail(failure("Event WebSocket disconnected"))))
      })
    })).pipe(Effect.ensuring(Effect.sync(() => {
      socket = undefined
      const error = failure("Event socket disconnected; resubscribe to resume")
      Effect.runSync(Deferred.fail(ready, error))
      ready = Deferred.makeUnsafe()
      failSubscriptions(error)
    })))
    yield* connection.pipe(
      Effect.tapError(error => Effect.logWarning(error.message)),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.forkScoped,
    )
    yield* Effect.sync(() => {
      if (socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPong > 60_000) socket.terminate()
      else socket.send(ping)
    }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)
    // The TUI sees SSE heartbeats locally. They never cross the remote socket.
    yield* Effect.sync(() => {
      for (const [id, item] of subscriptions) {
        if (item.controller.desiredSize === maxBufferedBytes) {
          item.controller.enqueue({ type: "event", id, data: ": heartbeat\n\n" })
        }
      }
    }).pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped)
    yield* Effect.addFinalizer(() => Effect.sync(() => failSubscriptions(failure("Client shutting down"))))

    const waitReady = () => Deferred.await(ready).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(cause => failure("Event transport unavailable; check Worker/client versions and credentials", cause)),
    )
    const http = (request: Request, path?: string, abort?: AbortSignal) => Effect.tryPromise({
      try: async signal => {
        const local = new URL(path ?? request.url, origin)
        // Assign the path rather than resolving it against the origin: //host must remain a path.
        const url = new URL(origin)
        url.pathname = local.pathname
        url.search = local.search
        const headers = new Headers(wireHeaders(request.headers))
        headers.delete("host")
        headers.delete("authorization")
        headers.delete(deviceHeader)
        if (authorization) headers.set("authorization", authorization)
        headers.set("accept-encoding", "identity")
        const init: RequestInit & { duplex: "half" } = {
          method: request.method, headers, body: request.body, duplex: "half",
          signal: AbortSignal.any([request.signal, signal, ...(abort ? [abort] : [])]),
          redirect: "manual",
        }
        const response = await fetch(url, init)
        const outgoing = new Headers(wireHeaders(response.headers))
        // Fetch decodes compressed bodies. Forward the decoded representation with fresh framing.
        outgoing.delete("content-encoding")
        outgoing.delete("content-length")
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
      },
      catch: cause => failure("Remote HTTP request failed", cause),
    })

    return Transport.of({
      fetch: Effect.fn("Transport.fetch")(function* (request: Request) {
        const url = new URL(request.url)
        const target = request.method === "GET" && !request.body
          ? subscriptionTarget(url.pathname + url.search) : undefined
        if (!target) {
          // Register shared devices before the first HTTP call can start a host or model turn.
          if (device) yield* waitReady()
          return yield* http(request)
        }
        const ws = yield* waitReady()
        if (ws !== socket || ws.readyState !== WebSocket.OPEN) return yield* Effect.fail(failure("Event socket disconnected"))
        if (subscriptions.size >= maxSubscriptions) return yield* Effect.fail(failure("Too many subscriptions"))
        const id = crypto.randomUUID()
        let controller!: ReadableStreamDefaultController<EventFrame>
        const events = new ReadableStream<EventFrame>({
          start(value) { controller = value },
          cancel() { stop(id) },
        }, { highWaterMark: maxBufferedBytes, size: frame => Math.max(1, encoder.encode(frame.data).byteLength) })
        const item: Subscription = { ready: Deferred.makeUnsafe(), controller, abort: new AbortController(), socket: ws, cleanup: () => {} }
        const cancel = () => stop(id)
        item.cleanup = () => request.signal.removeEventListener("abort", cancel)
        subscriptions.set(id, item)
        request.signal.addEventListener("abort", cancel, { once: true })

        return yield* Effect.gen(function* () {
          if (request.signal.aborted) return yield* Effect.fail(failure("Request cancelled"))
          yield* Effect.try({
            try: () => send(ws, target.channel === "log"
              ? { type: "subscribe", id, channel: "log", sessionID: target.sessionID }
              : { type: "subscribe", id, channel: target.channel }),
            catch: cause => failure("Could not subscribe", cause),
          })
          yield* Deferred.await(item.ready).pipe(Effect.timeout("15 seconds"), Effect.mapError(cause => failure("Subscription unavailable", cause)))
          // Subscription is installed before the snapshot request, so events during replay are queued.
          const replay = target.channel === "log" ? yield* http(request, target.replayPath, item.abort.signal) : undefined
          if (replay && !replay.ok) {
            // Keep the HTTP error body readable after removing the unused live subscription.
            stop(id, undefined, true, false)
            return replay
          }
          const history = replay?.body?.getReader()
          const cursor = replay ? replayCursor() : undefined
          const live = events.getReader()
          let through: number | undefined
          let replaying = !!cursor
          const stream = new ReadableStream<Uint8Array>({
            async pull(output) {
              try {
                if (replaying) {
                  const next = await history?.read()
                  if (next && !next.done) {
                    cursor!.write(next.value)
                    output.enqueue(next.value)
                    return
                  }
                  through = cursor!.finish()
                  replaying = false
                }
                while (true) {
                  const next = await live.read()
                  if (next.done) throw failure("Event subscription ended")
                  const frame = next.value
                  if (frame.seq !== undefined) {
                    if (frame.seq <= (through ?? -1)) continue
                    through = frame.seq
                  }
                  output.enqueue(encoder.encode(frame.data))
                  return
                }
              } catch (cause) {
                stop(id, failure("Event stream failed", cause))
                void history?.cancel().catch(() => {})
                void live.cancel().catch(() => {})
                output.error(cause)
              }
            },
            async cancel() {
              stop(id)
              await Promise.allSettled([history?.cancel(), live.cancel()])
            },
          }, { highWaterMark: 0 })
          // A finite replay's framing does not describe the following live stream.
          const headers = new Headers(replay?.headers ?? sseHeaders)
          headers.delete("content-length")
          headers.delete("content-encoding")
          return new Response(stream, { status: replay?.status ?? 200, headers })
        }).pipe(Effect.onError(() => Effect.sync(() => stop(id))))
      }),
    })
  }))
