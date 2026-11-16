import type { RepositoryAccess } from "@ocx/protocol/workspaces"

// Current Artifacts RPC handles are disposable. Keep the interface explicit because
// workers-types releases before the RPC update described get() as plain metadata.
export interface ArtifactHandle {
  info(): Promise<{ remote: string }>
  createToken(scope: "read" | "write", ttl: number): Promise<{ plaintext: string; expiresAt: string }>
  [Symbol.dispose](): void
}
export interface ArtifactBinding {
  create(name: string, options?: { setDefaultBranch?: string; description?: string }): Promise<{ remote: string; token: string }>
  get(name: string): Promise<ArtifactHandle>
}

export class RepositoryStore {
  constructor(private readonly binding: ArtifactBinding) {}

  async create(name: string) {
    const result = await this.binding.create(name, { setDefaultBranch: "main", description: "OpenCode workspace checkpoints" })
    return { url: result.remote, token: result.token } satisfies RepositoryAccess
  }

  async access(name: string, scope: "read" | "write" = "write"): Promise<RepositoryAccess> {
    using repo = await this.binding.get(name)
    const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, 3600)])
    return { url: info.remote, token: token.plaintext, expiresAt: token.expiresAt }
  }
}
