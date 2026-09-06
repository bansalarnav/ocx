import { Effect } from "effect"
import { evaluate } from "@ocx/protocol/errors"
import type { Bus } from "@opencode-ai/core/bus"

export interface LogTarget {
  sessionID: string
  path: string
}
export const logTarget = (path: string): LogTarget | undefined => {
  const url = new URL(path, "http://ocx")
  const match = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(url.pathname)
  if (!match || url.searchParams.get("follow") !== "true") return
  const sessionID = decodeURIComponent(match[1]!)
  url.searchParams.set("follow", "false")
  return { sessionID, path: url.pathname + url.search }
}

/** Read only the replay watermark; all HTTP response bytes pass through untouched. */
export const replayCursor = () => {
  const decoder = new TextDecoder()
  let buffer = ""
  let cursor: number | undefined
  let synced = false
  return {
    write: (bytes: Uint8Array) =>
      evaluate("Read log replay watermark", () => {
        buffer += decoder.decode(bytes, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) continue
          const value = JSON.parse(data) as { type: string; seq?: number }
          if (value.type === "log.synced") {
            cursor = value.seq
            synced = true
          }
        }
        if (buffer.length > 8 * 1024 * 1024)
          throw new Error("Log event exceeds replay buffer limit")
      }),
    finish: Effect.suspend(() =>
      synced
        ? Effect.succeed(cursor ?? -1)
        : Effect.fail(new Error("Log replay ended without its watermark")),
    ),
  }
}
export type DurableEvent = Bus.LogItem & { durable: { aggregateID: string; seq: number } }
