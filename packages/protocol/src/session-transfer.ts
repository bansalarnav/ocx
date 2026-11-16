export interface Transcript {
  info: { id: string; parentID?: string; location?: { directory: string }; metadata?: Record<string, unknown>; [key: string]: any }
  messages: { id: string; [key: string]: any }[]
}
export interface SessionBundle { rootID: string; sessions: Transcript[] }

/** Imports get fresh identities so repeated round trips never collide with the
 * recoverable source copy. Only identity fields change, never transcript text. */
export function relocateSessions(bundle: SessionBundle, directory: string): SessionBundle {
  if (!bundle || !Array.isArray(bundle.sessions) || !bundle.sessions.length || bundle.sessions.length > 100)
    throw new Error("Invalid session bundle")
  const identities = new Map<string, string>()
  for (const session of bundle.sessions) {
    if (!session.info?.id || !Array.isArray(session.messages)) throw new Error("Invalid session transcript")
    if (identities.has(session.info.id)) throw new Error("Duplicate session identity")
    identities.set(session.info.id, "ses_" + crypto.randomUUID().replaceAll("-", ""))
  }
  if (!identities.has(bundle.rootID)) throw new Error("Root session is absent")
  for (const session of bundle.sessions)
    for (const message of session.messages) identities.set(message.id, "msg_" + crypto.randomUUID().replaceAll("-", ""))
  const remap = (value: any, field = ""): any => {
    if (typeof value === "string") return (field === "id" || /[Ii][Dd]$/.test(field)) ? identities.get(value) ?? value : value
    if (Array.isArray(value)) return value.map(item => remap(item, field))
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, key)]))
    return value
  }
  const sessions = bundle.sessions.map(original => {
    const session = remap(original) as Transcript
    if (!original.info.parentID || !identities.has(original.info.parentID)) delete session.info.parentID
    session.info.location = { directory }
    session.info.metadata = { ...session.info.metadata, ocxSourceSession: original.info.id }
    // An old machine's filesystem snapshots cannot implement revert on this one.
    delete session.info.revert
    if (session.info.time) delete session.info.time.archived
    return session
  })
  const sorted: Transcript[] = []
  const remaining = new Set(sessions)
  while (remaining.size) {
    const next = [...remaining].find(s => !s.info.parentID || sorted.some(p => p.info.id === s.info.parentID))
    if (!next) throw new Error("Session parents contain a cycle")
    sorted.push(next); remaining.delete(next)
  }
  return { rootID: identities.get(bundle.rootID)!, sessions: sorted }
}

export async function exportSessionFamily(rootID: string, api: (path: string, method?: string, body?: unknown) => Promise<any>): Promise<SessionBundle> {
  const sessions: Transcript[] = []
  const seen = new Set<string>()
  const visit = async (id: string) => {
    if (seen.has(id)) return
    if (seen.size >= 100) throw new Error("Handoff exceeds 100 sessions")
    seen.add(id)
    await api(`/api/session/${id}/interrupt`, "POST")
    await api(`/api/experimental/session/${id}/wait`, "POST")
    const inbox = await api(`/api/session/${id}/inbox`)
    if (inbox.data?.length) throw new Error("Deliver or cancel queued prompts before handing off")
    let cursor: string | undefined
    do {
      const page = await api(`/api/session?parentID=${encodeURIComponent(id)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      for (const child of page.data) await visit(child.id)
      cursor = page.cursor?.next
    } while (cursor)
  }
  await visit(rootID)
  // Child completion can enqueue a report on a parent we already settled.
  // Recheck the entire family before exporting any transcript.
  for (const id of seen) {
    await api(`/api/session/${id}/interrupt`, "POST")
    await api(`/api/experimental/session/${id}/wait`, "POST")
    if ((await api(`/api/session/${id}/inbox`)).data?.length)
      throw new Error("Deliver or cancel queued prompts before handing off")
  }
  for (const id of seen) sessions.push((await api(`/api/experimental/session/${id}/export`)).data)
  return { rootID, sessions }
}
