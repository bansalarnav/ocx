import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface Options {
  origin: string
  binary: string
  dataRoot: string
  yes: boolean
  childArgs: string[]
}

export const usage = `Usage: ocx [options] <server-url> [-- opencode2 arguments]

Options:
  --server <url>       OpenCode server URL (alternative to the positional URL)
  --binary <path>      CLI to launch (default: opencode2)
  --data-dir <path>    Cache root (default: $XDG_DATA_HOME/ocx or ~/.local/share/ocx)
  --yes                Approve new or changed plugin bytes without prompting
  -h, --help           Show this help

Remote authentication uses OPENCODE_PASSWORD. The local proxy uses a per-process password.`

const fail = (message: string): never => {
  throw new Error(message)
}

const normalizeOrigin = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(`Invalid server URL: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("Server URL must use http or https")
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return fail("Server URL must be an origin without credentials, path, query, or fragment")
  }
  return url.origin
}

export const parseArguments = (args: string[], env = process.env): Options => {
  let server: string | undefined
  let binary = env.OCX_OPENCODE_BINARY || "opencode2"
  let dataRoot =
    env.OCX_DATA_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "ocx")
  let yes = false
  const childArgs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      childArgs.push(...args.slice(index + 1))
      break
    }
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--server" || arg === "--binary" || arg === "--data-dir") {
      const value = args[++index]
      if (!value) fail(`${arg} requires a value`)
      if (arg === "--server") server = value
      else if (arg === "--binary") binary = value
      else dataRoot = resolve(value)
      continue
    }
    if (arg.startsWith("-")) fail(`Unknown ocx option: ${arg}. Put OpenCode options after --.`)
    if (server !== undefined) fail(`Unexpected argument: ${arg}. Put OpenCode arguments after --.`)
    server = arg
  }

  if (!server) throw new Error("Missing server URL\n\n" + usage)
  return { origin: normalizeOrigin(server), binary, dataRoot, yes, childArgs }
}
