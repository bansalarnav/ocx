import { expect, test } from "bun:test"
import { SocketTransport } from "../packages/server/src/transport"
import { maxFrameBytes, maxSubscriptions } from "../packages/protocol/src/transport"

// Exercise hibernation attachments without starting OpenCode or accessing storage.
Object.assign(globalThis, { WebSocketRequestResponsePair: class { constructor(readonly request: string, readonly response: string) {} } })
function setup(initial?: unknown) {
  let stored: any = initial ?? { version: 2, subscriptions: [] }
  const sent: any[] = []
  const closes: { code: number; reason: string }[] = []
  let saves = 0
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => structuredClone(stored),
    serializeAttachment(value: unknown) { stored = structuredClone(value); saves++ },
    send(text: string) { sent.push(JSON.parse(text)) },
    close(code: number, reason: string) { closes.push({ code, reason }); this.readyState = WebSocket.CLOSED },
  }
  const state = {
    getWebSockets: () => [socket],
    setWebSocketAutoResponse() {},
    get storage() { throw new Error("Subscriptions must not touch SQL") },
  }
  return { socket, state, sent, closes, saves: () => saves, stored: () => stored,
    transport: () => new SocketTransport(state as never),
    frame: (transport: SocketTransport, value: unknown) => transport.message(socket as never, JSON.stringify(value)),
  }
}

test("subscriptions survive reconstruction and broadcasts do not rewrite attachments", () => {
  const peer = setup()
  peer.frame(peer.transport(), { type: "subscribe", id: "events", channel: "opencode" })
  expect(peer.sent[0]).toEqual({ type: "subscribed", id: "events" })
  expect(peer.sent[1].data).toContain("server.connected")
  const saves = peer.saves()
  const resumed = peer.transport()
  for (let i = 0; i < 100; i++) resumed.publish("opencode", `data: ${i}\n\n`)
  expect(peer.sent).toHaveLength(102)
  expect(peer.saves()).toBe(saves)
  peer.frame(resumed, { type: "unsubscribe", id: "events" })
  resumed.publish("opencode", "data: ignored\n\n")
  expect(peer.sent).toHaveLength(102)
})

test("live log events carry sequence numbers and filter by session", () => {
  const peer = setup()
  const transport = peer.transport()
  peer.frame(transport, { type: "subscribe", id: "log", channel: "log", sessionID: "ses_test" })
  const event = {
    id: "evt_test", created: Date.now(), type: "session.execution.started",
    durable: { aggregateID: "ses_test", seq: 7, version: 1 }, data: { sessionID: "ses_test" },
  }
  transport.publishLog(event as never)
  expect(peer.sent[1]).toEqual({ type: "event", id: "log", seq: 7, data: `data: ${JSON.stringify(event)}\n\n` })
  transport.publishLog({ ...event, durable: { ...event.durable, aggregateID: "ses_other" }, data: { sessionID: "ses_other" } } as never)
  expect(peer.sent).toHaveLength(2)
})

test("subscription limit, malformed frames, and oversized events fail explicitly", () => {
  const peer = setup()
  const transport = peer.transport()
  for (let i = 0; i < maxSubscriptions + 1; i++) peer.frame(transport, { type: "subscribe", id: `sub_${i}`, channel: "plugins" })
  expect(peer.stored().subscriptions).toHaveLength(maxSubscriptions)
  expect(peer.sent.at(-1).type).toBe("error")
  transport.publish("plugins", "x".repeat(maxFrameBytes))
  expect(peer.closes[0]!.code).toBe(1009)
  expect(peer.stored().subscriptions).toEqual([])

  for (const frame of [{ type: "ack", id: "old" }, { type: "request", id: "old", method: "POST", path: "/api/session" }]) {
    const old = setup()
    old.frame(old.transport(), frame)
    expect(old.closes[0]!.code).toBe(1002)
  }
})

test("old attachments are rejected and device access is removed on close", () => {
  const old = setup({ version: 1, subscriptions: [], device: { id: "stale" } })
  old.transport()
  expect(old.closes[0]!.code).toBe(1002)
  expect(old.stored()).toEqual({ version: 2, subscriptions: [] })

  const device = { id: "0123456789abcdef", token: "a".repeat(64), url: "https://device.example/mcp" }
  const peer = setup({ version: 2, subscriptions: [], device })
  let changes = 0
  const transport = new SocketTransport(peer.state as never, () => changes++)
  expect(transport.devices()).toEqual([device])
  transport.close(peer.socket as never)
  expect(transport.devices()).toEqual([])
  expect(changes).toBe(1)
})
