import { DurableObject } from "cloudflare:workers"
import { authenticated } from "./auth"
import type { Env, OpenCodeDO as Implementation } from "./index"

// Keep the OpenCode/Effect dependency graph out of isolate startup. Wrangler
// bundles this import behind an initializer that runs only on the first event.
export class OpenCodeDO extends DurableObject<Env> {
  private implementation?: Promise<Implementation>

  private load(): Promise<Implementation> {
    return this.implementation ??= import("./index").then(
      ({ OpenCodeDO }) => new OpenCodeDO(this.ctx, this.env),
    )
  }

  async fetch(request: Request): Promise<Response> {
    return (await this.load()).fetch(request)
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return (await this.load()).webSocketMessage(socket, message)
  }

  async webSocketClose(socket: WebSocket) {
    return (await this.load()).webSocketClose(socket)
  }

  async webSocketError(socket: WebSocket) {
    return (await this.load()).webSocketError(socket)
  }
}

export default {
  fetch: (request, env) => {
    if (!env.OPENCODE_PASSWORD) return new Response("Set OPENCODE_PASSWORD before using this server", { status: 503 })
    if (!authenticated(request, env.OPENCODE_PASSWORD)) return new Response("Unauthorized", { status: 401 })
    return env.OPENCODE.get(env.OPENCODE.idFromName("default")).fetch(request)
  },
} satisfies ExportedHandler<Env>
