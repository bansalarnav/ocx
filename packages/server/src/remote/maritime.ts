import { Maritime } from "maritime-sdk"

export interface ComputeEnv {
  MARITIME_API_KEY?: string
  MARITIME_TEMPLATE?: string
  MARITIME_API_URL?: string
  MARITIME_VCPU?: number
  MARITIME_MEMORY_MIB?: number
}

export class Compute {
  private readonly client: Maritime
  constructor(private readonly env: ComputeEnv) {
    if (!env.MARITIME_API_KEY) throw new Error("Set MARITIME_API_KEY to enable remote workspaces")
    this.client = new Maritime({ apiKey: env.MARITIME_API_KEY, baseUrl: env.MARITIME_API_URL })
  }

  async create(workspaceID: string) {
    const vcpu = this.env.MARITIME_VCPU
    const memoryMib = this.env.MARITIME_MEMORY_MIB
    if (vcpu !== undefined && (!Number.isInteger(vcpu) || vcpu < 1 || vcpu > 16)) throw new Error("MARITIME_VCPU must be an integer from 1 to 16")
    if (memoryMib !== undefined && (!Number.isInteger(memoryMib) || memoryMib < 1024 || memoryMib > 65536 || memoryMib % 1024 !== 0)) throw new Error("MARITIME_MEMORY_MIB must be a multiple of 1024 from 1024 to 65536")
    const box = await this.client.sandboxes.create({
      name: `ocx-${workspaceID}`,
      from: this.env.MARITIME_TEMPLATE ?? "base",
      ...(vcpu === undefined ? {} : { vcpu }),
      ...(memoryMib === undefined ? {} : { memoryMib }),
      idleTimeoutSeconds: 900,
      onIdle: "pause",
      metadata: { workspace: workspaceID, application: "ocx" },
      idempotencyKey: `ocx-create-${workspaceID}`,
    })
    return box.id
  }

  async run(id: string, command: string, options: { timeoutSeconds?: number; signal?: AbortSignal; stdin?: string } = {}) {
    options.signal?.throwIfAborted()
    const box = await this.client.sandboxes.get(id)
    // Submit once as a background command, retain its ID, and cancel explicitly.
    // A transport retry must never execute the same shell mutation twice.
    const handle = await box.run(command, { background: true, timeoutSeconds: options.timeoutSeconds ?? 120, idempotencyKey: crypto.randomUUID(), ...(options.stdin === undefined ? {} : { stdin: options.stdin }) })
    const cancel = () => { void handle.kill().catch(() => {}) }
    options.signal?.addEventListener("abort", cancel, { once: true })
    try {
      if (options.signal?.aborted) cancel()
      const result = await handle.wait()
      options.signal?.throwIfAborted()
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
    } finally {
      options.signal?.removeEventListener("abort", cancel)
    }
  }

  async pause(id: string) { await (await this.client.sandboxes.get(id)).pause() }
  async destroy(id: string) {
    try { await (await this.client.sandboxes.get(id)).kill() }
    catch (error) {
      if (!["sandbox_not_found", "sandbox_ended"].includes((error as { code?: string }).code ?? "")) throw error
    }
  }
  async url(id: string, port: number) { return (await this.client.sandboxes.get(id)).url(port) }
}

export const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
