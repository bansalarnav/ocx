# OpenCode on Cloudflare Durable Objects

Run the OpenCode v2 server on your own Cloudflare account and connect from your terminal with `ocx`. Sessions live in SQLite-backed Durable Objects. The client uses HTTP for API calls and log history, and a hibernating WebSocket for live events and device presence.

This is an experimental, single-owner setup. Everyone with the server password shares access to its sessions, credentials, and configured devices. It uses stable OpenCode packages pinned to `2.3.0`.

`bun run ocx` opens local OpenCode with a built-in **Remote** menu. Connect a remote, move conversations in either direction, create remote threads, browse repositories, open PRs, and recover transfers inside OpenCode. Destination conversations open automatically in the same terminal. See [local and remote workspaces](docs/remote-workspaces.md) for the user flow and server setup.

## Set up your remote instance

You need [Bun](https://bun.sh/), a Cloudflare account, and the stable OpenCode v2 CLI on your local machine. Install the matching version with `npm install -g @opencode/cli@2.3.0`. `ocx` launches `opencode` by default. Use `--binary /path/to/opencode` to select another installation.

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

Start OpenCode through the launcher:

```sh
bun run ocx
```

Open `/remote`, choose **Connect a remote**, and enter the HTTPS Worker URL printed by Wrangler and its password. The launcher remembers the connection on this device. Maritime and Artifacts setup for remote execution is described in [remote workspaces](docs/remote-workspaces.md#server-setup).

The Worker returns HTTP 503 until its password is configured, and 401 for missing or incorrect credentials. Command-line connection options remain available for automation.

In the TUI, use `/connect` to configure a model provider.

### Use an OpenCode server config

OpenCode v2 reads `opencode.json` on the server. Because this server runs inside a Durable Object, it cannot see the config file in your local project. Sync one explicitly when you connect:

```sh
bun run ocx --server "https://opencode-durable-object.<subdomain>.workers.dev" \
  --password 'your-server-password' \
  --config ./opencode.json
```

The config is validated against the pinned OpenCode version, stored on the instance, and applied before the TUI opens. It stays active for later connections, so you only need `--config` when adding or changing settings. Use `--clear-config` to remove it. `OCX_CONFIG=/path/to/opencode.json` is the scripting equivalent.

This is instance-wide config, not per-project config. Everyone with the server password uses it. Prefer `/connect` for provider credentials instead of putting API keys in the file. Local paths, local plugins, and local-process MCP servers cannot run inside the Cloudflare Worker. Remote providers and remote MCP servers are the useful cases here.

For example, current OpenCode v2 config uses `providers` and `settings` for an OpenAI-compatible endpoint:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "acme": {
      "name": "Acme Models",
      "package": "@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "https://models.example.com/v1"
      },
      "models": {
        "coder": {
          "name": "Acme Coder",
          "modelID": "coder-v1"
        }
      }
    }
  },
  "model": "acme/coder"
}
```

Sync the file, then use `/connect` and select `Acme Models` to save its API key in the server credential store. `ocx` accepts the current OpenCode v2 schema only.

## Connect with ocx

```sh
bun run ocx --server "$OCX_SERVER_URL" --password 'your-server-password'
bun run ocx --server "$OCX_SERVER_URL" --password 'your-server-password' --binary opencode
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
