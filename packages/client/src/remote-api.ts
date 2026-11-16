export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Mutations are never replayed automatically. Handoff recovery uses saved IDs. */
export class RemoteAPI {
  readonly origin: string
  constructor(origin: string, readonly password?: string, readonly fetcher: typeof fetch = fetch) {
    const url = new URL(origin)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("OpenCode server must be an HTTP(S) origin without credentials or a path")
    this.origin = url.origin
  }

  async request<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetcher(new URL(path, this.origin), {
      method,
      headers: {
        ...(this.password ? { authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    })
    const text = await response.text()
    let result: any
    try { result = text ? JSON.parse(text) : undefined } catch {
      throw new ApiError(response.status, `Invalid JSON from ${path}: HTTP ${response.status}`)
    }
    if (!response.ok) throw new ApiError(response.status, result?.error ?? result?.message ?? `HTTP ${response.status} from ${path}`)
    return result as T
  }
}
