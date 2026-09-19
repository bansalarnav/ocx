import { ConfigNormalize } from "@opencode-ai/core/config/normalize"
import { Config } from "@opencode-ai/schema/config"
import { Effect, Option, Schema } from "effect"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { attempt, evaluate, OperationError } from "@ocx/protocol/errors"
import type { RemoteMcpServer } from "./device-mcps"
import { authenticated } from "./tui-registry"

const path = "/api/ocx/config"
const storageKey = "ocx/instance-config"
const maximumBytes = 256 * 1024
const encoder = new TextEncoder()
const decode = Schema.decodeUnknownOption(Config.Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

export interface ParsedInstanceConfig {
  content: Readonly<Record<string, unknown>>
  diagnostics: readonly ConfigNormalize.Diagnostic[]
}

export function parseInstanceConfig(content: string): ParsedInstanceConfig {
  if (encoder.encode(content).byteLength > maximumBytes)
    throw new Error(`Config is larger than ${maximumBytes / 1024} KiB`)
  const errors: ParseError[] = []
  const input: unknown = parse(content, errors, { allowTrailingComma: true })
  if (errors.length) {
    const error = errors[0]!
    throw new Error(`${printParseErrorCode(error.error)} at offset ${error.offset}`)
  }
  const normalized = ConfigNormalize.normalize(input)
  if (normalized.type === "rejected") {
    throw new Error(normalized.diagnostics.map((item) => item.message).join("; ") || "Config was rejected")
  }
  const invalid = normalized.diagnostics.filter((item) => item.kind === "invalid")
  if (invalid.length) {
    throw new Error(invalid.map((item) => {
      const location = item.path.length ? ` at ${item.path.join(".")}` : ""
      return `Invalid OpenCode config${location}: ${item.message}`
    }).join("; "))
  }
  if (Option.isNone(decode(normalized.encoded))) throw new Error("Config does not match the OpenCode schema")
  return { content: normalized.encoded, diagnostics: normalized.diagnostics }
}

export function effectiveInstanceConfig(
  content: string | undefined,
  deviceServers: Record<string, RemoteMcpServer>,
): string {
  const configured = content === undefined ? {} : parseInstanceConfig(content).content
  const mcp = configured.mcp && typeof configured.mcp === "object" && !Array.isArray(configured.mcp)
    ? configured.mcp as Record<string, unknown>
    : {}
  const servers = mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)
    ? mcp.servers as Record<string, unknown>
    : {}
  return JSON.stringify({
    ...configured,
    mcp: { ...mcp, servers: { ...servers, ...deviceServers } },
  })
}

export interface InstanceConfigStore {
  readonly get: Effect.Effect<string | undefined, OperationError>
  readonly put: (content: string) => Effect.Effect<boolean, OperationError>
  readonly remove: Effect.Effect<boolean, OperationError>
  readonly effective: (
    deviceServers: Record<string, RemoteMcpServer>,
  ) => Effect.Effect<string, OperationError>
}

export const makeInstanceConfigStore = (storage: DurableObjectStorage): InstanceConfigStore => {
  const get = attempt("Read instance config", () => storage.get<string>(storageKey))
  return {
    get,
    put: (content) =>
      get.pipe(
        Effect.flatMap((current) =>
          current === content
            ? Effect.succeed(false)
            : attempt("Store instance config", () => storage.put(storageKey, content)).pipe(Effect.as(true)),
        ),
      ),
    remove: get.pipe(
      Effect.flatMap((current) =>
        current === undefined
          ? Effect.succeed(false)
          : attempt("Remove instance config", () => storage.delete(storageKey)).pipe(Effect.as(true)),
      ),
    ),
    effective: (deviceServers) =>
      get.pipe(
        Effect.flatMap((content) =>
          evaluate("Build instance config", () => effectiveInstanceConfig(content, deviceServers)),
        ),
      ),
  }
}

interface RouteResult {
  response: Response
  changed: boolean
}

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  })

export const makeInstanceConfigHandler = (store: InstanceConfigStore, password?: string) =>
  (request: Request): Effect.Effect<RouteResult | undefined, OperationError> =>
    Effect.gen(function* () {
      if (new URL(request.url).pathname !== path) return undefined
      if (!authenticated(request, password))
        return {
          changed: false,
          response: json({ error: "Authentication required" }, 401, {
            "www-authenticate": 'Basic realm="Secure Area"',
          }),
        }
      if (request.method === "GET") {
        return {
          changed: false,
          response: new Response((yield* store.get) ?? "{}\n", {
            headers: {
              "content-type": "application/jsonc; charset=utf-8",
              "cache-control": "no-store",
            },
          }),
        }
      }
      if (request.method === "DELETE") {
        const changed = yield* store.remove
        return { changed, response: json({ changed }) }
      }
      if (request.method !== "PUT") {
        return {
          changed: false,
          response: json({ error: "Method not allowed" }, 405, { allow: "GET, PUT, DELETE" }),
        }
      }
      const length = Number(request.headers.get("content-length"))
      if (Number.isFinite(length) && length > maximumBytes) {
        return { changed: false, response: json({ error: `Config is larger than ${maximumBytes / 1024} KiB` }, 413) }
      }
      const content = yield* attempt("Read instance config upload", () => request.text())
      const parsed = yield* evaluate("Validate instance config", () => parseInstanceConfig(content)).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      )
      if (!parsed.ok)
        return { changed: false, response: json({ error: parsed.error.message }, 400) }
      const changed = yield* store.put(content)
      return { changed, response: json({ changed, diagnostics: parsed.value.diagnostics }) }
    })
