import { Schema } from "effect"

export const socketPath = "/api/ocx/transport"
export const protocol = "ocx.v1"
export const chunkSize = 32 * 1024
export const maxFrameBytes = 64 * 1024
export const maxRequests = 128
export const maxSubscriptions = 8
export const ping = "ocx:ping"
export const pong = "ocx:pong"

const id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,64}$/))
const headers = Schema.Array(Schema.Tuple([Schema.String, Schema.String]))
export const ClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("request"),
    id,
    method: Schema.String,
    path: Schema.String,
    headers,
    body: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("chunk"), id, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("end"), id }),
  Schema.Struct({ type: Schema.Literal("cancel"), id }),
  Schema.Struct({ type: Schema.Literal("ack"), id }),
])
export type ClientFrame = typeof ClientFrame.Type
export const ServerFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("response"),
    id,
    status: Schema.Number,
    statusText: Schema.String,
    headers,
  }),
  Schema.Struct({ type: Schema.Literal("chunk"), id, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("end"), id }),
  Schema.Struct({ type: Schema.Literal("error"), id, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ack"), id }),
])
export type ServerFrame = typeof ServerFrame.Type
export const decodeClient = Schema.decodeUnknownSync(Schema.fromJsonString(ClientFrame))
export const decodeServer = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const encodeBytes = (bytes: Uint8Array): string => {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}
export const decodeBytes = (text: string): Uint8Array => {
  const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0))
  if (bytes.byteLength > chunkSize)
    throw new TransportError({ message: "Transport chunk exceeds limit" })
  return bytes
}

// Connection-specific headers have no meaning inside the tunnel.
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
export const wireHeaders = (headers: Headers): [string, string][] => {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ])
  return Array.from(headers.entries()).filter(([name]) => !excluded.has(name.toLowerCase()))
}
export type Channel = "opencode" | "plugins"
export const eventChannel = (path: string): Channel | undefined => {
  const pathname = new URL(path, "http://ocx").pathname
  if (pathname === "/api/event") return "opencode"
  if (pathname === "/api/generated-plugins/tui/events") return "plugins"
}
