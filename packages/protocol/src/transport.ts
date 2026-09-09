import { Schema } from "effect"

export const socketPath = "/api/ocx/transport"
export const protocol = "ocx.v2"
export const maxFrameBytes = 2 * 1024 * 1024
export const maxBufferedBytes = 2 * 1024 * 1024
export const maxSubscriptions = 8
export const ping = "ocx:ping"
export const pong = "ocx:pong"

const id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/))
export const ClientFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("subscribe"), id, channel: Schema.Literals(["opencode", "plugins"]) }),
  Schema.Struct({ type: Schema.Literal("subscribe"), id, channel: Schema.Literal("log"), sessionID: id }),
  Schema.Struct({ type: Schema.Literal("unsubscribe"), id }),
])
export type ClientFrame = typeof ClientFrame.Type
export const ServerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("subscribed"), id }),
  Schema.Struct({ type: Schema.Literal("event"), id, data: Schema.String, seq: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("error"), id, message: Schema.String }),
])
export type ServerFrame = typeof ServerFrame.Type
export type EventFrame = Extract<ServerFrame, { type: "event" }>
export const decodeClient = Schema.decodeUnknownSync(Schema.fromJsonString(ClientFrame))
export const decodeServer = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Connection-specific headers must not cross the local HTTP proxy.
const hopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
])
export const wireHeaders = (headers: Headers): [string, string][] => {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ])
  return Array.from(headers.entries()).filter(([name]) => !excluded.has(name.toLowerCase()))
}

export type Channel = "opencode" | "plugins"
export type SubscriptionTarget =
  | { channel: Channel }
  | { channel: "log"; sessionID: string; replayPath: string }

export const subscriptionTarget = (path: string): SubscriptionTarget | undefined => {
  const url = new URL(path, "http://ocx")
  if (url.pathname === "/api/event") return { channel: "opencode" }
  if (url.pathname === "/api/generated-plugins/tui/events") return { channel: "plugins" }
  const match = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(url.pathname)
  if (!match || url.searchParams.get("follow") !== "true") return
  let sessionID: string
  try { sessionID = decodeURIComponent(match[1]!) } catch { return }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionID)) return
  url.searchParams.set("follow", "false")
  return { channel: "log", sessionID, replayPath: url.pathname + url.search }
}
