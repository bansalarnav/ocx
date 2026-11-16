import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface Options {
  shareDevice: boolean
  deviceRoot: string
  origin: string
  password?: string
  binary: string
  dataRoot: string
  yes: boolean
  config: string | null | undefined
  childArgs: string[]
}

export const usage = `Usage: ocx [-- opencode arguments]
       ocx --server <server-url> [options] [-- opencode arguments]
       ocx remote <command> [options]

Without --server, starts ordinary local OpenCode with your existing configuration.
Open /remote inside OpenCode to create remote threads or move conversations.
Use ocx remote --help for automation commands.

Options:
  --server <url>        OpenCode server URL (alternative to the positional URL)
  --password <value>    Server password (default: OPENCODE_PASSWORD)
  --share-device        Share local files and shell through OpenTunnel
  --device-root <path>  Directory to share (default: current directory)
  --binary <path>       CLI to launch (default: opencode)
  --data-dir <path>     Cache root (default: $XDG_DATA_HOME/ocx or ~/.local/share/ocx)
  --config <path>       Sync an opencode.json/jsonc to the server before launch
  --clear-config        Remove the server's saved OpenCode config before launch
  --yes                Approve new or changed plugin bytes without prompting
  -h, --help           Show this help

The local proxy uses a separate per-process password.`

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
  let shareDevice = false
  let deviceRoot: string | undefined
  let server: string | undefined
  let password = env.OPENCODE_PASSWORD
  let binary = env.OCX_OPENCODE_BINARY || "opencode"
  let dataRoot =
    env.OCX_DATA_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "ocx")
  let yes = false
  let config: string | null | undefined = env.OCX_CONFIG ? resolve(env.OCX_CONFIG) : undefined
  let configArgument = false
  const childArgs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      childArgs.push(...args.slice(index + 1))
      break
    }
    if (arg === "--share-device") {
      shareDevice = true
      continue
    }
    if (arg === "--device-root") {
      const value = args[++index]
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`)
      deviceRoot = resolve(value)
      continue
    }
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--clear-config") {
      if (configArgument) fail("--clear-config cannot be combined with --config")
      config = null
      continue
    }
    if (arg === "--server" || arg === "--password" || arg === "--binary" || arg === "--data-dir" || arg === "--config") {
      const value = args[++index]
      if (!value) fail(`${arg} requires a value`)
      if (arg === "--server") server = value
      else if (arg === "--password") password = value
      else if (arg === "--binary") binary = value
      else if (arg === "--data-dir") dataRoot = resolve(value)
      else {
        if (config === null) fail("--config cannot be combined with --clear-config")
        config = resolve(value)
        configArgument = true
      }
      continue
    }
    if (arg.startsWith("-")) fail(`Unknown ocx option: ${arg}. Put OpenCode options after --.`)
    if (server !== undefined) fail(`Unexpected argument: ${arg}. Put OpenCode arguments after --.`)
    server = arg
  }

  if (deviceRoot && !shareDevice) fail("--device-root requires --share-device")
  if (!server && shareDevice) fail("--share-device requires --server")
  if (!server && config === null) fail("--clear-config requires --server")
  return { shareDevice, deviceRoot: deviceRoot ?? process.cwd(), origin: server ? normalizeOrigin(server) : "", password, binary, dataRoot, yes, config, childArgs }
}
