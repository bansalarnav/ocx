import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Path } from "@opencode/util/global"

export interface ComposerDraft {
  prompt: { text: string; files?: unknown[]; pasted?: unknown[]; agents?: unknown[]; skills?: unknown[]; [key: string]: unknown }
  cursor: number
  directory?: string
}
export const draftMarker = (id: string) => `[ocx-draft:${id}]`
export const nativeStashPath = () => join(Path.state, "prompt-stash.jsonl")

/** Keep repository file references valid when the checkout root changes. */
export function retargetFileURIs<T extends { files?: unknown[] }>(input: T, from: string, to: string): T {
  const source = pathToFileURL(from).pathname.replace(/\/$/, "")
  const destination = pathToFileURL(to).pathname.replace(/\/$/, "")
  const rewrite = (uri: unknown) => {
    if (typeof uri !== "string" || !uri.startsWith("file:")) return uri
    try {
      const url = new URL(uri)
      if (url.hostname && url.hostname !== "localhost") return uri
      if (url.pathname !== source && !url.pathname.startsWith(source + "/")) return uri
      url.pathname = destination + url.pathname.slice(source.length)
      return url.href
    } catch { return uri }
  }
  return { ...input, ...(input.files ? { files: input.files.map((file: any) => file && typeof file === "object" ? {
    ...file, ...(file.uri !== undefined ? { uri: rewrite(file.uri) } : {}),
    ...(file.source?.uri ? { source: { ...file.source, uri: rewrite(file.source.uri) } } : {}),
  } : file) } : {}) }
}

export function validateDraft(input: unknown): ComposerDraft {
  const draft = input as ComposerDraft
  if (!draft || typeof draft !== "object" || !draft.prompt || typeof draft.prompt.text !== "string" ||
    !Number.isSafeInteger(draft.cursor) || draft.cursor < 0 ||
    (draft.directory !== undefined && (typeof draft.directory !== "string" || draft.directory.length > 4096)) ||
    [draft.prompt.files, draft.prompt.pasted, draft.prompt.agents, draft.prompt.skills].some(v => v !== undefined && !Array.isArray(v)))
    throw new Error("Invalid composer draft")
  return structuredClone(draft)
}

export async function readNativeStash() {
  let source: string
  try { source = await readFile(nativeStashPath(), "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return source.split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

/** Stage before starting the destination TUI, so native stash hydration sees it. */
export async function stageNativeDraft(draft: ComposerDraft, id: string) {
  const path = nativeStashPath()
  await mkdir(Path.state, { recursive: true, mode: 0o700 })
  await appendFile(path, JSON.stringify({ prompt: { ...draft.prompt, text: draft.prompt.text + draftMarker(id) }, timestamp: Date.now() }) + "\n", { mode: 0o600 })
}

export async function saveComposerDraft(root: string, draft: unknown) {
  const value = validateDraft(draft), id = crypto.randomUUID()
  const directory = join(root, "drafts")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, id + ".json"), JSON.stringify(value), { mode: 0o600, flag: "wx" })
  return id
}
export async function loadComposerDraft(root: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid draft identity")
  return validateDraft(JSON.parse(await readFile(join(root, "drafts", id + ".json"), "utf8")))
}
