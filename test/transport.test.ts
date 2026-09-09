import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ServerWebSocket } from "bun"
import { Transport, transportLayer } from "../packages/client/src/transport"
import { maxBufferedBytes, protocol, socketPath, type ClientFrame } from "../packages/protocol/src/transport"
import { deviceHeader, deviceProtocol } from "../packages/protocol/src/device"
import { replayCursor } from "../packages/client/src/log-replay"

const authorization = `Basic ${Buffer.from("opencode:remote-secret").toString("base64")}`
const event = (seq: number) => `data: ${JSON.stringify({ type: "session.text.ended", durable: { aggregateID: "ses_test", seq }, data: { text: `event ${seq}` } })}\n\n`
const run = <A>(origin: string, body: (transport: typeof Transport.Service) => Effect.Effect<A, any>, device?: Parameters<typeof transportLayer>[2]) =>
  Effect.runPromise(Effect.gen(function* () { return yield* body(yield* Transport) }).pipe(
    Effect.provide(transportLayer(origin, "remote-secret", device)),
    Effect.timeout("10 seconds"),
  ))

function peer(handler?: (request: Request) => Response | Promise<Response>, onFrame?: (ws: ServerWebSocket<undefined>, frame: ClientFrame) => void) {
  const frames: ClientFrame[] = []
  const upgrades: Request[] = []
  const sockets = new Set<ServerWebSocket<undefined>>()
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === socketPath) {
        upgrades.push(request)
        server.upgrade(request, { headers: { "sec-websocket-protocol": request.headers.get("sec-websocket-protocol")! } })
        return
      }
      return handler?.(request) ?? new Response("OK")
    },
    websocket: {
      open(ws) { sockets.add(ws) },
      close(ws) { sockets.delete(ws) },
      message(ws, data) {
        if (data === "ocx:ping") { ws.send("ocx:pong"); return }
        const frame = JSON.parse(String(data)) as ClientFrame
        frames.push(frame)
        if (frame.type === "subscribe") ws.send(JSON.stringify({ type: "subscribed", id: frame.id }))
        onFrame?.(ws, frame)
      },
    },
  })
  return { frames, upgrades, sockets, origin: server.url.origin, stop: () => server.stop(true) }
}

const request = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1:1234${path}`, init)

describe("HTTP and live event transport", () => {
  test("sends bodies and credentials over HTTP, preserves responses, and does not follow redirects", async () => {
    const seen: { url: string; method: string; auth: string | null; device: string | null; body: string }[] = []
    const remote = peer(async req => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), device: req.headers.get(deviceHeader), body: await req.text() })
      return new Response("rejected", { status: 409, headers: { "x-result": "kept" } })
    })
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const body = "hello".repeat(30_000)
        const response = yield* transport.fetch(request("/api/session?x=a%2Fb", {
          method: "POST", body,
          headers: { authorization: "Basic local-secret", [deviceHeader]: "forged" },
        }))
        expect(response.status).toBe(409)
        expect(response.headers.get("x-result")).toBe("kept")
        expect(yield* Effect.promise(() => response.text())).toBe("rejected")
        expect(seen).toEqual([{ url: `${remote.origin}/api/session?x=a%2Fb`, method: "POST", auth: authorization, device: null, body }])
        expect(remote.frames).toEqual([])
      }))
    } finally { remote.stop() }

    let calls = 0
    const redirect = peer(() => { calls++; return new Response(null, { status: 307, headers: { location: "/other" } }) })
    try {
      await run(redirect.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/redirect"))
        expect(response.status).toBe(307)
        expect(response.headers.get("location")).toBe("/other")
        expect(calls).toBe(1)
      }))
    } finally { redirect.stop() }
  })

  test("streams events without ACKs and unsubscribes on cancellation", async () => {
    const remote = peer(undefined, (ws, frame) => {
      if (frame.type === "subscribe") ws.send(JSON.stringify({ type: "event", id: frame.id, data: "data: hello\n\n" }))
    })
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/event"))
        expect(response.headers.get("content-type")).toBe("text/event-stream")
        const reader = response.body!.getReader()
        expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe("data: hello\n\n")
        yield* Effect.promise(() => reader.cancel())
        yield* Effect.sleep("20 millis")
        expect(remote.frames.map(frame => frame.type)).toEqual(["subscribe", "unsubscribe"])
        expect(remote.upgrades[0]!.headers.get("sec-websocket-protocol")).toBe(protocol)
      }))
    } finally { remote.stop() }
  })

  test("subscribes before HTTP log replay and removes the overlap without losing live events", async () => {
    let subscription: { ws: ServerWebSocket<undefined>; id: string } | undefined
    let replayPath = ""
    const remote = peer(req => {
      replayPath = new URL(req.url).pathname + new URL(req.url).search
      expect(subscription).toBeDefined()
      for (const seq of [1, 2]) subscription!.ws.send(JSON.stringify({ type: "event", id: subscription!.id, data: event(seq), seq }))
      return new Response(`${event(1)}data: {"type":"log.synced","seq":1}\n\n`, { headers: { "content-type": "text/event-stream" } })
    }, (ws, frame) => { if (frame.type === "subscribe") subscription = { ws, id: frame.id } })
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/experimental/session/ses_test/log?after=0&follow=true"))
        const reader = response.body!.getReader()
        let text = ""
        while (!text.includes("event 2")) {
          const next = yield* Effect.promise(() => reader.read())
          text += new TextDecoder().decode(next.value)
        }
        expect(replayPath).toBe("/api/experimental/session/ses_test/log?after=0&follow=false")
        expect(text.match(/event 1/g)?.length).toBe(1)
        expect(text.match(/event 2/g)?.length).toBe(1)
        expect(text.indexOf("log.synced")).toBeLessThan(text.indexOf("event 2"))
        yield* Effect.promise(() => reader.cancel())
      }))
    } finally { remote.stop() }
  })

  test("preserves HTTP replay errors and cleans up the subscription", async () => {
    const remote = peer(() => new Response("session missing", { status: 404 }))
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/experimental/session/ses_missing/log?follow=true"))
        expect(response.status).toBe(404)
        expect(yield* Effect.promise(() => response.text())).toBe("session missing")
        yield* Effect.sleep("20 millis")
        expect(remote.frames.map(frame => frame.type)).toEqual(["subscribe", "unsubscribe"])
      }))
    } finally { remote.stop() }
  })

  test("fails a slow event consumer at the byte limit", async () => {
    const remote = peer(undefined, (ws, frame) => {
      if (frame.type !== "subscribe") return
      const data = "x".repeat(maxBufferedBytes / 4)
      for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ type: "event", id: frame.id, data }))
    })
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/event"))
        yield* Effect.sleep("40 millis")
        yield* Effect.promise(async () => {
          await expect(response.body!.getReader().read()).rejects.toThrow("overflow")
        })
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 1000
          while (!remote.frames.some(frame => frame.type === "unsubscribe") && Date.now() < deadline) await Bun.sleep(5)
        })
        expect(remote.frames.some(frame => frame.type === "unsubscribe")).toBe(true)
      }))
    } finally { remote.stop() }
  })

  test("HTTP continues after the event socket disconnects and mutations are not replayed", async () => {
    let calls = 0
    const remote = peer(() => { calls++; return new Response("submitted") })
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/event"))
        for (const ws of remote.sockets) ws.close()
        yield* Effect.sleep("20 millis")
        yield* Effect.promise(async () => { await expect(response.body!.getReader().read()).rejects.toThrow() })
        const result = yield* transport.fetch(request("/api/session/ses_test/prompt", { method: "POST", body: "hello" }))
        expect(yield* Effect.promise(() => result.text())).toBe("submitted")
        expect(calls).toBe(1)
      }))
    } finally { remote.stop() }
  })

  test("aborting an HTTP response cancels its body without using the socket", async () => {
    const remote = peer(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")) },
    })))
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const abort = new AbortController()
        const response = yield* transport.fetch(request("/api/stream", { signal: abort.signal }))
        const reader = response.body!.getReader()
        expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe("first")
        abort.abort()
        yield* Effect.promise(async () => { await expect(reader.read()).rejects.toThrow() })
        expect(remote.frames).toEqual([])
      }))
    } finally { remote.stop() }
  })

  test("a replay without a watermark fails instead of switching to a possibly incomplete log", async () => {
    const remote = peer(() => new Response(event(1), { headers: { "content-type": "text/event-stream" } }))
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/experimental/session/ses_test/log?follow=true"))
        yield* Effect.promise(async () => { await expect(response.text()).rejects.toThrow("watermark") })
        yield* Effect.sleep("20 millis")
        expect(remote.frames.map(frame => frame.type)).toEqual(["subscribe", "unsubscribe"])
      }))
    } finally { remote.stop() }
  })

  test("registers a shared device before HTTP and never sends its token as an HTTP header", async () => {
    const device = { id: "0123456789abcdef", token: "a".repeat(64), url: "https://device.example/mcp" }
    const remote = peer(req => {
      expect(remote.upgrades).toHaveLength(1)
      expect(req.headers.get(deviceHeader)).toBeNull()
      return new Response("OK")
    })
    try {
      await run(remote.origin, transport => Effect.gen(function* () {
        const response = yield* transport.fetch(request("/api/session"))
        yield* Effect.promise(() => response.text())
        expect(remote.upgrades[0]!.headers.get("sec-websocket-protocol")).toBe(deviceProtocol)
        expect(JSON.parse(remote.upgrades[0]!.headers.get(deviceHeader)!)).toEqual(device)
      }), device)
    } finally { remote.stop() }
  })
})

test("replay watermark handles split Unicode/CRLF and rejects missing or invalid markers", () => {
  const cursor = replayCursor()
  const bytes = new TextEncoder().encode('data: {"text":"é"}\r\n\r\ndata: {"type":"log.synced","seq":42}\r\n\r\n')
  for (const byte of bytes) cursor.write(new Uint8Array([byte]))
  expect(cursor.finish()).toBe(42)
  expect(() => replayCursor().finish()).toThrow("watermark")
  expect(() => replayCursor().write(new TextEncoder().encode('data: {"type":"log.synced","seq":-1}\n\n'))).toThrow("watermark")
})
