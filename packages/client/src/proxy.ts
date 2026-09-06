import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Transport } from "./transport"

export class Proxy extends Context.Service<
  Proxy,
  { readonly origin: string; readonly password: string }
>()("ocx/Proxy") {
  static layer = Layer.effect(
    Proxy,
    Effect.gen(function* () {
      const transport = yield* Transport
      const password = randomBytes(32).toString("hex")
      const expected = Buffer.from(
        `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      )
      const server = yield* NodeHttpServer.make(createServer, {
        host: "127.0.0.1",
        port: 0,
        gracefulShutdownTimeout: "1 second",
      })
      yield* server.serve(
        Effect.gen(function* () {
          const incoming = yield* HttpServerRequest.HttpServerRequest
          const auth = Buffer.from(incoming.headers.authorization ?? "")
          if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
            return HttpServerResponse.text("Unauthorized", { status: 401 })
          const request = yield* HttpServerRequest.toWeb(incoming)
          return HttpServerResponse.fromWeb(yield* transport.fetch(request))
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(error).pipe(
              Effect.as(HttpServerResponse.text("Remote transport unavailable", { status: 502 })),
            ),
          ),
        ),
      )
      if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected a TCP listener")
      return Proxy.of({ origin: `http://127.0.0.1:${server.address.port}`, password })
    }),
  )
}
