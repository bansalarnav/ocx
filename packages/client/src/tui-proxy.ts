import { randomBytes, timingSafeEqual } from "node:crypto"

/** Local attachments use the same authenticated interception point as remote ones. */
export function createLocalTuiProxy(serverOrigin: string, password: string | undefined, intercept: (request: Request) => Promise<Response | undefined>) {
  const secret = randomBytes(32).toString("hex")
  const expected = Buffer.from(`Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`)
  let origin = ""
  const server = (globalThis as any).Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 40 * 1024 * 1024,
    async fetch(request: Request) {
      const url = new URL(request.url)
      const supplied = Buffer.from(request.headers.get("authorization") ?? "")
      if (request.headers.get("host") !== new URL(origin).host || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin)) return new Response("Unauthorized", { status: 401 })
      try {
        const handled = await intercept(request.clone())
        if (handled) return handled
        const headers = new Headers(request.headers)
        headers.delete("host"); headers.delete("authorization"); headers.delete("origin")
        headers.set("accept-encoding", "identity")
        if (password) headers.set("authorization", `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
        const response = await fetch(new Request(new URL(url.pathname + url.search, serverOrigin), request), { headers, redirect: "error" })
        const outgoing = new Headers(response.headers)
        // Fetch decodes compressed bodies before the proxy streams them to the TUI.
        outgoing.delete("content-encoding"); outgoing.delete("content-length")
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
      } catch (error) { return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return { origin, password: secret, stop: async () => { await server.stop(true) } }
}
