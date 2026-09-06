import { Context, Deferred, Effect, Layer, Queue, Schedule, Scope } from "effect"
import WebSocket from "ws"
import {
  chunkSize,
  decodeBytes,
  decodeServer,
  encodeBytes,
  maxFrameBytes,
  maxRequests,
  ping,
  pong,
  protocol,
  socketPath,
  TransportError,
  wireHeaders,
  type ClientFrame,
  type ServerFrame,
} from "@ocx/protocol/transport"

interface BodyChunk {
  bytes: Uint8Array
  acknowledge: boolean
}

interface Pending {
  response: Deferred.Deferred<Response, TransportError>
  uploadCredit: Deferred.Deferred<void, TransportError>
  body: Queue.Queue<BodyChunk, TransportError | import("effect/Cause").Done>
  ended: boolean
  sse: boolean
  trailingNewlines: number
  completed: Deferred.Deferred<void>
  cleanup: () => void
}

export class Transport extends Context.Service<
  Transport,
  {
    readonly fetch: (request: Request) => Effect.Effect<Response, TransportError>
  }
>()("ocx/Transport") {}

const failure = (message: string, cause?: unknown) => new TransportError({ message, cause })

export const transportLayer = (origin: string, password?: string) =>
  Layer.effect(
    Transport,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const pending = new Map<string, Pending>()
      let lastPong = 0
      let socket: WebSocket | undefined
      let ready = Deferred.makeUnsafe<WebSocket, TransportError>()

      const send = (frame: ClientFrame) =>
        Effect.try({
          try: () => {
            if (socket?.readyState !== WebSocket.OPEN) throw failure("Transport disconnected")
            socket.send(JSON.stringify(frame))
          },
          catch: (cause) => failure("Could not send transport frame", cause),
        })
      const failPending = (error: TransportError) =>
        Effect.gen(function* () {
          for (const item of pending.values()) {
            yield* Deferred.fail(item.response, error)
            yield* Deferred.fail(item.uploadCredit, error)
            yield* Queue.fail(item.body, error)
            yield* Deferred.succeed(item.completed, undefined)
            item.cleanup()
          }
          pending.clear()
        })
      const receive = (frame: ServerFrame) =>
        Effect.gen(function* () {
          const item = pending.get(frame.id)
          if (!item) return
          switch (frame.type) {
            case "response": {
              const noBody = [101, 204, 205, 304].includes(frame.status)
              item.sse =
                new Headers(frame.headers as [string, string][])
                  .get("content-type")
                  ?.startsWith("text/event-stream") ?? false
              const stream = new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    return Effect.runPromise(
                      Queue.take(item.body).pipe(
                        Effect.matchCauseEffect({
                          onSuccess: ({ bytes, acknowledge }) =>
                            Effect.sync(() => controller.enqueue(new Uint8Array(bytes))).pipe(
                              Effect.andThen(
                                acknowledge ? send({ type: "ack", id: frame.id }) : Effect.void,
                              ),
                            ),
                          onFailure: (cause) =>
                            Effect.sync(() => {
                              if (item.ended) controller.close()
                              else controller.error(failure("Response stream failed", cause))
                            }),
                        }),
                        Effect.catch((error) => Effect.sync(() => controller.error(error))),
                      ),
                    )
                  },
                  cancel() {
                    pending.delete(frame.id)
                    item.cleanup()
                    return Effect.runPromise(
                      send({ type: "cancel", id: frame.id }).pipe(
                        Effect.ignore,
                        Effect.andThen(Deferred.succeed(item.completed, undefined)),
                        Effect.andThen(Queue.shutdown(item.body)),
                        Effect.asVoid,
                      ),
                    )
                  },
                },
                { highWaterMark: 0 },
              )
              const response = yield* Effect.try({
                try: () =>
                  new Response(noBody ? null : stream, {
                    status: frame.status,
                    statusText: frame.statusText,
                    headers: frame.headers as [string, string][],
                  }),
                catch: (cause) => failure("Invalid response", cause),
              })
              yield* Deferred.succeed(item.response, response)
              return
            }
            case "chunk": {
              const bytes = yield* Effect.try({
                try: () => decodeBytes(frame.data),
                catch: (cause) => failure("Invalid response chunk", cause),
              })
              if (item.sse) {
                for (const byte of bytes) {
                  if (byte !== 13)
                    item.trailingNewlines = byte === 10 ? Math.min(2, item.trailingNewlines + 1) : 0
                }
              }
              if (!Queue.offerUnsafe(item.body, { bytes, acknowledge: true })) {
                yield* Queue.fail(item.body, failure("Response buffer overflow"))
                pending.delete(frame.id)
                yield* Deferred.succeed(item.completed, undefined)
                item.cleanup()
                yield* send({ type: "cancel", id: frame.id })
              }
              return
            }
            case "ack":
              yield* Deferred.succeed(item.uploadCredit, undefined)
              return
            case "end":
              item.ended = true
              yield* Queue.end(item.body)
              pending.delete(frame.id)
              yield* Deferred.succeed(item.completed, undefined)
              item.cleanup()
              return
            case "error": {
              const error = failure(frame.message)
              yield* Deferred.fail(item.response, error)
              yield* Deferred.fail(item.uploadCredit, error)
              yield* Queue.fail(item.body, error)
              pending.delete(frame.id)
              yield* Deferred.succeed(item.completed, undefined)
              item.cleanup()
            }
          }
        })

      const connection = Effect.scoped(
        Effect.gen(function* () {
          const url = new URL(socketPath, origin)
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
          const ws = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new WebSocket(url, protocol, {
                  headers: password
                    ? {
                        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
                      }
                    : {},
                  handshakeTimeout: 10_000,
                  maxPayload: maxFrameBytes,
                }),
            ),
            (ws) =>
              Effect.callback<void>((resume) => {
                if (ws.readyState === WebSocket.CLOSED) {
                  resume(Effect.void)
                  return
                }
                ws.on("error", () => {})
                ws.once("close", () => resume(Effect.void))
                ws.close(1000, "Client shutting down")
                return Effect.sync(() => ws.terminate())
              }).pipe(Effect.timeoutOption("1 second"), Effect.asVoid),
          )
          yield* Effect.callback<void, TransportError>((resume) => {
            ws.on("open", () => {
              socket = ws
              lastPong = Date.now()
              Effect.runSync(Deferred.succeed(ready, ws))
            })
            ws.on("message", (data) => {
              const text = data.toString()
              if (text === pong) {
                lastPong = Date.now()
                return
              }
              Effect.runFork(
                Effect.try({
                  try: () => decodeServer(text),
                  catch: (cause) => failure("Invalid server frame", cause),
                }).pipe(
                  Effect.flatMap(receive),
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      resume(Effect.fail(error))
                      ws.terminate()
                    }),
                  ),
                ),
              )
            })
            ws.on("error", (cause) =>
              resume(Effect.fail(failure("WebSocket connection failed", cause))),
            )
            ws.on("close", () => resume(Effect.fail(failure("WebSocket disconnected"))))
            return Effect.sync(() => ws.removeAllListeners())
          })
        }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            socket = undefined
            const error = failure("Transport disconnected; in-flight requests are not replayed")
            yield* Deferred.fail(ready, error)
            ready = Deferred.makeUnsafe()
            yield* failPending(error)
          }),
        ),
      )

      yield* connection.pipe(
        Effect.tapError((error) => Effect.logWarning(error.message)),
        Effect.retry(Schedule.spaced("1 second")),
        Effect.forkScoped,
      )
      // Cloudflare answers these without waking the object.
      yield* Effect.sync(() => {
        if (socket?.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastPong > 60_000) socket.terminate()
        else socket.send(ping)
      }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)
      const heartbeat = new TextEncoder().encode(": heartbeat\n\n")
      yield* Effect.sync(() => {
        for (const item of pending.values()) {
          // Insert only between complete SSE frames, and never acknowledge local comments.
          if (item.sse && item.trailingNewlines === 2 && Queue.sizeUnsafe(item.body) === 0) {
            Queue.offerUnsafe(item.body, { bytes: heartbeat, acknowledge: false })
          }
        }
      }).pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped)
      yield* Effect.addFinalizer(() => failPending(failure("Client shutting down")))

      return Transport.of({
        fetch: Effect.fn("Transport.fetch")(function* (request: Request) {
          yield* Deferred.await(ready).pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError((cause) => failure("Transport unavailable", cause)),
          )
          if (pending.size >= maxRequests) return yield* Effect.fail(failure("Too many requests"))
          const id = crypto.randomUUID()
          const item: Pending = {
            response: Deferred.makeUnsafe(),
            uploadCredit: Deferred.makeUnsafe(),
            body: yield* Queue.dropping<BodyChunk, TransportError | import("effect/Cause").Done>(
              64,
            ),
            ended: false,
            sse: false,
            trailingNewlines: 2,
            completed: Deferred.makeUnsafe(),
            cleanup: () => {},
          }
          pending.set(id, item)
          const cancel = () => {
            if (!pending.delete(id)) return
            item.cleanup()
            Effect.runFork(
              failOne.pipe(Effect.andThen(send({ type: "cancel", id })), Effect.ignore),
            )
          }
          const failOne = Effect.gen(function* () {
            const error = failure("Request cancelled")
            yield* Deferred.fail(item.response, error)
            yield* Deferred.fail(item.uploadCredit, error)
            yield* Queue.fail(item.body, error)
            yield* Deferred.succeed(item.completed, undefined)
            item.cleanup()
          })
          item.cleanup = () => request.signal.removeEventListener("abort", cancel)
          request.signal.addEventListener("abort", cancel, { once: true })
          if (request.signal.aborted) {
            cancel()
            return yield* Effect.fail(failure("Request cancelled"))
          }
          const url = new URL(request.url)
          const upload = Effect.gen(function* () {
            yield* send({
              type: "request",
              id,
              path: url.pathname + url.search,
              method: request.method,
              headers: wireHeaders(request.headers),
              body: request.body !== null,
            })
            if (request.body) {
              const reader = yield* Effect.acquireRelease(
                Effect.sync(() => request.body!.getReader()),
                (reader) => Effect.promise(() => reader.cancel().catch(() => undefined)),
              )
              while (true) {
                const next = yield* Effect.tryPromise({
                  try: () => reader.read(),
                  catch: (cause) => failure("Read request body", cause),
                })
                if (next.done) break
                for (let offset = 0; offset < next.value.byteLength; offset += chunkSize) {
                  item.uploadCredit = Deferred.makeUnsafe()
                  yield* send({
                    type: "chunk",
                    id,
                    data: encodeBytes(next.value.subarray(offset, offset + chunkSize)),
                  })
                  yield* Deferred.await(item.uploadCredit).pipe(
                    Effect.timeout("60 seconds"),
                    Effect.mapError((cause) => failure("Upload stalled", cause)),
                  )
                }
              }
              yield* send({ type: "end", id })
            }
          }).pipe(
            Effect.scoped,
            Effect.catch((error) =>
              Deferred.fail(item.response, error).pipe(Effect.andThen(Effect.sync(cancel))),
            ),
          )
          yield* Effect.forkIn(Effect.raceFirst(upload, Deferred.await(item.completed)), scope)
          return yield* Deferred.await(item.response).pipe(
            Effect.onInterrupt(() => Effect.sync(cancel)),
          )
        }),
      })
    }),
  )
