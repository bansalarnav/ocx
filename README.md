# OpenCode on Cloudflare Durable Objects

Run the OpenCode v2 server on your own Cloudflare account and connect from your terminal with `ocx`. Sessions live in SQLite-backed Durable Objects. The client carries HTTP and event streams over a hibernating WebSocket.

This is an experimental, single-owner setup. Everyone with the server password shares access to its sessions, credentials, and configured devices. It uses OpenCode preview packages, currently pinned to `0.0.0-beta-18866`.

## Set up your remote instance

You need [Bun](https://bun.sh/), a Cloudflare account, and a compatible OpenCode v2 preview CLI on your local machine. `ocx` launches `opencode2` by default. Use `--binary opencode` if your preview installation uses that name.

Run these commands from this checkout:

```sh
bun install --frozen-lockfile
bunx wrangler login
```

Review `wrangler.jsonc` and choose a Worker name if you want to change the default, `opencode-durable-object`. Keep the Durable Object bindings and migration entries. Wrangler creates the objects on deployment; there is no VM to provision.

Set a strong password at the prompt, then deploy:

```sh
bunx wrangler secret put OPENCODE_PASSWORD
bun run deploy
```

Copy the HTTPS Worker URL printed by Wrangler, then connect using the same password:

```sh
export OCX_SERVER_URL='https://opencode-durable-object.<subdomain>.workers.dev'

bun run ocx --server "$OCX_SERVER_URL" --password 'your-server-password'
```

The Worker returns HTTP 503 until its password is configured, and 401 for missing or incorrect credentials. `OPENCODE_PASSWORD` remains available as a fallback when `--password` is omitted. A command-line password may be saved in shell history or briefly visible to other processes on the same machine.

In the TUI, use `/connect` to configure a model provider.

## Connect with ocx

```sh
bun run ocx --server "$OCX_SERVER_URL" --password 'your-server-password'
bun run ocx --server "$OCX_SERVER_URL" --password 'your-server-password' --binary opencode
bun run ocx --server "$OCX_SERVER_URL" --password 'your-server-password' -- --log-level DEBUG
```

`ocx` asks before installing server-authored TUI plugins and before accepting changed plugin code. `--yes` approves those changes automatically, including live updates. The launcher uses a disposable config and leaves your existing OpenCode config untouched. See [plugin loading and approvals](docs/tui-plugins.md).

## Share your local device with ocx

Install `rg` for file searches, then connect with:

```sh
bun run ocx --server "$OCX_SERVER_URL" --share-device
# Share a specific directory instead of the current directory:
bun run ocx --server "$OCX_SERVER_URL" --share-device --device-root /path/to/project
```

`ocx` starts a device MCP server on a random loopback port, generates a fresh token, opens an [OpenTunnel](https://github.com/anomalyco/opentunnel) connection, and sends the endpoint and token through the authenticated WebSocket handshake. The OpenTunnel client is bundled with the project, so there is no tunnel executable to install. No device secrets need to be set on the Worker. Deploy the updated Worker before using this flag.

The agent can read and edit files, run shell commands, and start web previews on your machine. Shell commands have your local user's permissions; the selected directory is not a sandbox. Everyone connected to the same OpenCode instance can use the device while it is shared.

`ocx` re-registers after network reconnects. The DO removes access when it observes the socket disconnect, and `ocx` stops the MCP server and tunnel on exit. Registration survives DO hibernation in the socket attachment and is not written to permanent Worker configuration. If either local process stops unexpectedly, `ocx` exits and cleans up the other process. Temporary network interruptions do not replay failed tool calls.

## Develop locally

Create a git-ignored `.dev.vars` file containing a local password:

```dotenv
OPENCODE_PASSWORD=replace-with-a-local-password
```

Then start Wrangler:

```sh
bun install --frozen-lockfile
bun run dev
```

In another terminal, use the same password:

```sh
bun run ocx --server http://localhost:8787 --password replace-with-a-local-password
```

For local device sharing, connect with `--share-device`.

## Repository and checks

- `packages/server`: Worker, Durable Objects, and plugin registry.
- `packages/client`: `ocx`, WebSocket transport, loopback proxy, and TUI plugins.
- `packages/protocol`: shared schemas and transport framing.
- `packages/device`: local MCP server and OpenTunnel previews.

```sh
bun run typecheck
bun run build
```

The build bundles the Worker without deploying. Vendored OpenTunnel sources and their pinned revision are recorded in [vendor/opentunnel](vendor/opentunnel/README.md).

See [connection and host lifetime](docs/architecture.md) for transport details. Local checks do not verify Cloudflare eviction or billing. Test an idle attached client against your deployed Worker before relying on hibernation savings.
