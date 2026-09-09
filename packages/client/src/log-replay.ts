/** Parse only the watermark; forward the original HTTP bytes unchanged. */
export const replayCursor = () => {
  const decoder = new TextDecoder()
  let buffer = ""
  let cursor: number | undefined
  let synced = false
  return {
    write(bytes: Uint8Array) {
      buffer += decoder.decode(bytes, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n")
        if (!data) continue
        const value = JSON.parse(data) as { type: string; seq?: number }
        if (value.type === "log.synced") {
          if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq < 0)) throw new Error("Invalid log watermark")
          cursor = value.seq
          synced = true
        }
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Log event exceeds replay buffer limit")
    },
    finish(): number {
      if (!synced) throw new Error("Log replay ended without its watermark")
      return cursor ?? -1
    },
  }
}
