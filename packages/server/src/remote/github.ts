export interface GitHubEnv { GITHUB_TOKEN?: string; GITHUB_CLIENT_ID?: string }
interface TokenStore { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<unknown> }
const tokenKey = "ocx/github/token"
export async function githubToken(storage: TokenStore, env: GitHubEnv) {
  return env.GITHUB_TOKEN ?? await storage.get<string>(tokenKey)
}

export function githubHandler(storage: TokenStore, env: GitHubEnv, requestFetch: typeof fetch = fetch) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/api/ocx/github/")) return
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
    try {
      if (url.pathname.endsWith("/status")) return json({ connected: !!await githubToken(storage, env), deviceLoginAvailable: !!env.GITHUB_CLIENT_ID })
      if (url.pathname.endsWith("/login") && request.method === "POST") {
        if (!env.GITHUB_CLIENT_ID) return json({ error: "Set GITHUB_CLIENT_ID for GitHub device login, or configure GITHUB_TOKEN" }, 503)
        const response = await requestFetch("https://github.com/login/device/code", {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, scope: "repo" }),
        })
        const result = await response.json() as any
        if (!response.ok || result.error) return json({ error: result.error_description ?? result.error ?? "GitHub login failed" }, 400)
        await storage.put("ocx/github/device/" + result.device_code, { expires: Date.now() + result.expires_in * 1000 })
        return json(result)
      }
      if (url.pathname.endsWith("/poll") && request.method === "POST") {
        const { device_code } = await request.json() as { device_code: string }
        const grant = await storage.get<{ expires: number }>("ocx/github/device/" + device_code)
        if (!grant || grant.expires < Date.now()) return json({ error: "Device login expired" }, 400)
        const response = await requestFetch("https://github.com/login/oauth/access_token", {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        })
        const result = await response.json() as any
        if (result.access_token) { await storage.put(tokenKey, result.access_token); return json({ connected: true }) }
        return json({ pending: result.error === "authorization_pending" || result.error === "slow_down", error: result.error, interval: result.error === "slow_down" ? 10 : 5 })
      }
      const token = await githubToken(storage, env)
      if (!token) return json({ error: "Connect GitHub first" }, 401)
      const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "ocx", "x-github-api-version": "2022-11-28" }
      if (url.pathname.endsWith("/repos") && request.method === "GET") {
        const page = Math.max(1, Math.min(100, Number(url.searchParams.get("page")) || 1))
        const response = await requestFetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`, { headers })
        return json(await response.json(), response.status)
      }
      if (url.pathname.endsWith("/branches") && request.method === "GET") {
        const repo = url.searchParams.get("repo") ?? ""
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "Choose a GitHub repository" }, 400)
        const response = await requestFetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers })
        return json(await response.json(), response.status)
      }
      return json({ error: "Unknown GitHub operation" }, 404)
    } catch { return json({ error: "GitHub operation failed" }, 502) }
  }
}
