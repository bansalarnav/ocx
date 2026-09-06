export interface PluginWorkspace {
  files: Record<string, string>
  expectedID?: string
}

export const normalizePath = (input: unknown): string => {
  if (typeof input !== "string") throw new Error("path must be a string")
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "")
  if (path === "" || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid workspace path: ${input}`)
  }
  if (!/^[A-Za-z0-9._/-]{1,160}$/.test(path)) throw new Error(`Invalid workspace path: ${input}`)
  return path
}
export const globPattern = (pattern: string): RegExp => {
  let expression = "^"
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?"
          index += 2
        } else {
          expression += ".*"
          index++
        }
      } else expression += "[^/]*"
    } else if (character === "?") expression += "[^/]"
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`${expression}$`)
}
const literalPluginID = (source: string, file: string): string => {
  const match = /\bid\s*:\s*(["'])([A-Za-z0-9_-]{1,64})\1/.exec(source)
  if (!match?.[2]) throw new Error(`Could not find a valid literal plugin id in ${file}`)
  return match[2]
}
export const validateID = (id: unknown): string => {
  if (typeof id !== "string") throw new Error("Plugin id must be a string")
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error("Plugin id must match [A-Za-z0-9_-]{1,64}")
  }
  return id
}
export const inspectPluginWorkspace = (workspace: PluginWorkspace) => {
  const files = workspace.files
  const serverEntry =
    files["server.ts"] !== undefined
      ? "server.ts"
      : files["server.js"] !== undefined
        ? "server.js"
        : undefined
  const tuiEntry = files["tui.tsx"] !== undefined ? "tui.tsx" : undefined
  if (serverEntry === undefined && tuiEntry === undefined) {
    throw new Error("Workspace must contain server.ts, server.js, or tui.tsx")
  }
  let bytes = 0
  for (const [name, content] of Object.entries(files)) {
    normalizePath(name)
    bytes += new TextEncoder().encode(content).byteLength
  }
  if (bytes > 1024 * 1024) throw new Error("Plugin source files exceed 1 MiB")
  const ids = [
    ...(serverEntry === undefined ? [] : [literalPluginID(files[serverEntry]!, serverEntry)]),
    ...(tuiEntry === undefined ? [] : [literalPluginID(files[tuiEntry]!, tuiEntry)]),
  ]
  const id = validateID(ids[0]!)
  if (ids.some((candidate) => candidate !== id)) {
    throw new Error(`Server and TUI entrypoints must declare the same plugin id: ${ids.join(", ")}`)
  }
  if (workspace.expectedID !== undefined && id !== workspace.expectedID) {
    throw new Error(`Edited plugin must keep id ${workspace.expectedID}; workspace declares ${id}`)
  }
  if (tuiEntry !== undefined) {
    const source = files[tuiEntry]!
    if (!source.includes("@opencode-ai/plugin/tui"))
      throw new Error("tui.tsx must import @opencode-ai/plugin/tui")
    if (
      !/import\s*\{[^}]*\bPlugin\b[^}]*\}\s*from\s*["']@opencode-ai\/plugin\/tui["']/.test(source)
    ) {
      throw new Error("tui.tsx must use the named Plugin export from @opencode-ai/plugin/tui")
    }
    if (
      !/\bPlugin\.define\s*\(/.test(source) ||
      !/\bsetup\s*\(/.test(source) ||
      !/export\s+default\s+/.test(source)
    ) {
      throw new Error("tui.tsx must default-export Plugin.define with an id and setup function")
    }
  }
  return { id, serverEntry, tuiEntry }
}
