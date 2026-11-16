/** One modifying conversation family per checkout. Its subagents share the turn.
 * Waiters are tool executions, so OpenCode cancellation cancels the wait too. */
export class CheckoutWriters {
  private readonly owners = new Map<string, { family: string; sessions: Set<string> }>()
  private readonly listeners = new Set<() => void>()
  async acquire(checkout: string, family: string, session: string, active: () => Promise<Set<string>>, signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted()
      const owner = this.owners.get(checkout)
      if (!owner || owner.family === family) {
        const current = owner ?? { family, sessions: new Set<string>() }
        current.sessions.add(session); this.owners.set(checkout, current)
        return
      }
      const running = await active()
      // The idle hook may be skipped after a failed execution. Reconcile with
      // upstream before letting a stale owner block subsequent conversations.
      if (this.owners.get(checkout) === owner && ![...owner.sessions].some(id => running.has(id))) {
        this.owners.delete(checkout)
        continue
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(signal.reason) }
        const timer = setTimeout(finish, 1000)
        const cleanup = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener("abort", abort) }
        this.listeners.add(finish); signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  }
  release(session: string) {
    for (const [id, owner] of this.owners) {
      owner.sessions.delete(session)
      if (!owner.sessions.size) this.owners.delete(id)
    }
    for (const wake of [...this.listeners]) wake()
  }
}
