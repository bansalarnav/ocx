/** A conservative preflight for the restricted VM. Validation also executes setup offline. */
export const assertPortableBundle = (source: string, side: "server" | "tui") => {
  if (/\bimport\s*\(/.test(source)) throw new Error("Unsupported runtime capability: dynamic import")
  for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
    const name = match[1]!
    if (side === "tui" && /^(?:@opencode(?:-ai)?\/plugin\/tui|@opentui\/(?:core|solid)(?:\/.*)?|solid-js(?:\/.*)?)$/.test(name)) continue
    throw new Error(`Unsupported ${side} runtime import: ${name}. Node, filesystem and process modules cannot run in the cloud plugin VM`)
  }
  if (side === "server") {
    const toolCapability = /\.\s*(reload|signal)\b/.exec(source)
    if (toolCapability) throw new Error(`Unsupported server tool capability: ${toolCapability[1]}. Register tools during setup; cancellation interrupts execution`)
    const global = /\b(process|Bun|Deno|fetch|WebSocket|XMLHttpRequest|Worker|setTimeout|setInterval|require)\s*(?:[.(]|\?\.)/.exec(source)
    if (global) throw new Error(`Unsupported server runtime capability: ${global[1]}`)
    const domain = /\.\s*(app|location|options|agent|aisdk|command|credential|event|experimental|integration|mcp|model|permission|plugin|provider|reference|rpc|session|shell|skill|vcs|websearch|worktree)\s*(?:[.(]|\?\.)/.exec(source)
    if (domain) throw new Error(`Unsupported server context capability: ${domain[1]}. Supported domains: tool and storage`)
  }
}
