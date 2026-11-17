import { InputRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { draftMarker, readNativeStash, type ComposerDraft } from "./composer-draft"

type NativeCommand = { id?: string; enabled?: boolean | (() => boolean); run(input?: string): unknown }
export interface NativeComposer {
  editor(): TextareaRenderable | undefined
  commands(): readonly NativeCommand[]
  ready?(): boolean
}
export function findComposerEditor(anchor: Renderable | undefined): TextareaRenderable | undefined {
  const visit = (node: Renderable): TextareaRenderable | undefined => {
    if (node.isDestroyed || !node.visible) return
    // Native plugins can load their own copy of OpenTUI. Check the editor
    // contract as well as class identity across those module boundaries.
    const editor = node as TextareaRenderable
    const textarea = node instanceof TextareaRenderable ||
      typeof editor.plainText === "string" && typeof editor.cursorOffset === "number" &&
      typeof editor.gotoBufferEnd === "function" && typeof editor.deleteCharBackward === "function"
    if (textarea && !(node instanceof InputRenderable) && !node.constructor.name.startsWith("InputRenderable")) return editor
    for (const child of node.getChildren()) { const found = visit(child); if (found) return found }
  }
  for (let node = anchor; node; node = node.parent ?? undefined) { const found = visit(node); if (found) return found }
}
const command = (composer: NativeComposer, id: string) => {
  const command = composer.commands().find(c => c.id === id)
  if (!command) throw new Error("OpenCode's composer is not ready; try again when the input is visible")
  return command
}
function stripMarker(editor: TextareaRenderable, marker: string, cursor: number) {
  if (!editor.plainText.endsWith(marker)) throw new Error("Draft restoration did not match; saved draft was retained")
  editor.gotoBufferEnd()
  for (let i = 0; i < marker.length; i++) editor.deleteCharBackward()
  editor.cursorOffset = Math.min(cursor, editor.cursorOffset)
}

/** Native stash includes files, mentions and expanded paste data, unlike plainText. */
export async function captureComposer(composer: NativeComposer): Promise<ComposerDraft> {
  const editor = composer.editor()
  if (!editor) throw new Error("Focus the conversation input before changing its location")
  const cursor = editor.cursorOffset, id = crypto.randomUUID(), marker = draftMarker(id)
  const focused = editor.focused
  editor.blur(); editor.focusable = false
  let stashed = false
  editor.gotoBufferEnd(); editor.insertText(marker)
  try {
    await Promise.resolve()
    await command(composer, "prompt.stash").run()
    if (editor.plainText) throw new Error("Could not stash the input; location was not changed")
    stashed = true
    let captured: ComposerDraft | undefined
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const entry = (await readNativeStash()).findLast(e => e.prompt?.text?.endsWith(marker))
      if (entry) { captured = { prompt: { ...entry.prompt, text: entry.prompt.text.slice(0, -marker.length) }, cursor }; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!captured) throw new Error("Could not save the complete draft; location was not changed")
    return captured
  } finally {
    try {
      if (stashed) await command(composer, "prompt.stash.pop").run()
      if (editor.plainText.endsWith(marker)) stripMarker(editor, marker, cursor)
    } finally {
      if (!editor.isDestroyed) {
        editor.focusable = true
        if (focused) editor.focus()
      }
    }
  }
}

export async function restoreComposer(composer: NativeComposer, id: string, cursor: number, signal?: AbortSignal) {
  const marker = draftMarker(id), deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (composer.ready && !composer.ready()) { await new Promise(resolve => setTimeout(resolve, 25)); continue }
    const editor = composer.editor()
    const pop = composer.commands().find(c => c.id === "prompt.stash.pop")
    const entries = await readNativeStash()
    const enabled = pop && (typeof pop.enabled === "function" ? pop.enabled() : pop.enabled !== false)
    if (editor && pop && enabled && entries.at(-1)?.prompt?.text?.endsWith(marker)) {
      // A newly attached UI must not overwrite anything the user has typed.
      if (editor.plainText) throw new Error("Your saved draft is in the prompt stash; restore it when this input is empty")
      await pop.run()
      if (editor.plainText.endsWith(marker)) { stripMarker(editor, marker, cursor); return }
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error("Draft was kept in the prompt stash; use Stash pop to restore it")
}
