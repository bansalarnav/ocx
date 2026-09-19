import { Effect, FileSystem } from "effect"
import { Transport } from "./transport"
import type { Options } from "./options"
import { attempt, OperationError } from "@ocx/protocol/errors"

interface SyncResult {
  changed?: boolean
  diagnostics?: Array<{ kind?: string; path?: string[]; message?: string }>
  error?: string
}

const endpoint = "/api/ocx/config"

export const syncInstanceConfig = (options: Options) =>
  Effect.gen(function* () {
    if (options.config === undefined) return
    const transport = yield* Transport
    const content = options.config === null
      ? undefined
      : yield* (yield* FileSystem.FileSystem).readFileString(options.config)
    const response = yield* transport.fetch(new Request(new URL(endpoint, options.origin), {
      method: options.config === null ? "DELETE" : "PUT",
      body: content,
      headers: content === undefined ? undefined : { "content-type": "application/jsonc" },
    }))
    const result = yield* attempt("Read config sync response", () => response.json() as Promise<SyncResult>)
    if (!response.ok) {
      return yield* Effect.fail(new OperationError({
        operation: "Sync instance config",
        cause: new Error(result.error ?? `HTTP ${response.status}`),
      }))
    }
    for (const diagnostic of result.diagnostics ?? []) {
      const location = diagnostic.path?.length ? ` at ${diagnostic.path.join(".")}` : ""
      yield* Effect.sync(() => console.error(`OpenCode config ${diagnostic.kind ?? "warning"}${location}: ${diagnostic.message ?? "Unknown warning"}`))
    }
    if (!result.changed) return
    yield* Effect.sync(() => console.error(
      options.config === null
        ? "Removed the instance OpenCode config."
        : `Synced ${options.config} as the instance OpenCode config.`,
    ))
  })
