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

Copy the HTTPS Worker URL printed by Wrangler. In your local terminal, read the same password without putting it in shell history:

```sh
read -rs -p 'Server password: ' OPENCODE_PASSWORD; echo
export OPENCODE_PASSWORD
export OCX_SERVER_URL='https://opencode-durable-object.<subdomain>.workers.dev'

curl --fail --user "opencode:$OPENCODE_PASSWORD" "$OCX_SERVER_URL/api/health"
bun run ocx --server "$OCX_SERVER_URL"
```

The password prompt above uses Bash. The Worker returns HTTP 503 until its password is configured, and 401 for missing or incorrect credentials. Local environment variables do not become deployed Worker secrets.

In the TUI, use `/connect` to configure a model provider.

## Connect with ocx

```sh
bun run ocx --server "$OCX_SERVER_URL"
bun run ocx --server "$OCX_SERVER_URL" --binary opencode
bun run ocx --server "$OCX_SERVER_URL" -- --log-level DEBUG
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

## Run a device MCP server yourself

The optional device server lets the remote agent read and edit local files, run native shell commands, and publish web previews. Device tools operate on the directory you select here.

Install `rg` for file searches. The embedded OpenTunnel client handles tunnels. From this checkout, start the device server in one terminal:

```sh
export OPENCODE_DEVICE_ROOT='/absolute/path/to/your/project'
export OPENCODE_DEVICE_TOKEN="$(openssl rand -hex 32)"
bun run device
```

Keep this terminal open. The server listens on `127.0.0.1:7331` and requires the token on `/mcp`. The shell tool runs with your local user's permissions; the workspace root is a starting directory, not a shell sandbox.

In another terminal, expose it through OpenTunnel:

```sh
bun run device:tunnel
```

Copy the `Device MCP: https://device.<id>.opentunnel.xyz/mcp` URL printed by the tunnel command. In the first terminal, stop the device server briefly with Ctrl-C so you can configure the Worker using the same token:

```sh
bunx wrangler secret put DEVICE_MCP_URL
# At the prompt, paste https://device.<id>.opentunnel.xyz/mcp
printf '%s' "$OPENCODE_DEVICE_TOKEN" | bunx wrangler secret put DEVICE_MCP_TOKEN
bun run device
```

Reconnect `ocx` after setting both secrets. The remote host loads these settings when it starts. They apply to everyone using this Worker, even when the `ocx` client runs on another machine. Keep the device server and tunnel running while using device tools.

OpenTunnel provisions a hostname and a TLS certificate for each run. Certificate issuance can take a few minutes. The automatic launcher waits up to five minutes, and the URL changes when restarted. For manual setup, update `DEVICE_MCP_URL` after restarting the tunnel. The embedded client keeps its tunnel credentials in memory and attempts to remove the remote tunnel during normal shutdown.

For a stable endpoint, you can run your own persistent HTTPS tunnel pointed at `127.0.0.1:7331` and configure its `/mcp` URL using the same Worker secrets.

`OPENCODE_DEVICE_PORT` changes the local port; set it in both terminals. `OPENCODE_DEVICE_HOST` changes the bind address and defaults to loopback.

For multiple devices, set `DEVICE_MCP_SERVERS` with `bunx wrangler secret put DEVICE_MCP_SERVERS` and paste an object such as:

```json
{
  "laptop": { "url": "https://laptop.example.com/mcp", "token": "your-laptop-token" },
  "desktop": { "url": "https://desktop.example.com/mcp", "token": "your-desktop-token" }
}
```

Names must start with a lowercase letter and contain at most 32 lowercase letters, digits, or underscores. `ocx_device_` is reserved for automatic sharing. Named entries are added alongside `DEVICE_MCP_URL`; an entry named `device` overrides that default. To remove access, stop the local server and tunnel, then delete whichever Worker secrets you configured with `bunx wrangler secret delete <name>`.

The device's `preview_start` tool also uses the embedded OpenTunnel client. Preview URLs are public and have no preview authentication. The optional preview `name` is a local label, not a hostname. `preview_stop` closes a preview; stopping the device server closes its previews.

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

In another terminal, export the same `OPENCODE_PASSWORD`, then run:

```sh
curl --fail --user "opencode:$OPENCODE_PASSWORD" http://localhost:8787/api/health
bun run ocx --server http://localhost:8787
```

For automatic local device sharing, connect with `--share-device`. For a manually managed device server, add `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` to `.dev.vars` and restart Wrangler. Local and deployed secrets are separate.

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
