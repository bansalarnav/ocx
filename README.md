# OpenCode on Cloudflare Durable Objects

Run the OpenCode v2 server on your own Cloudflare account and connect from your terminal with `ocx`. Sessions and repository files live in SQLite-backed Durable Objects. The client carries HTTP and event streams over a hibernating WebSocket.

This is an experimental, single-owner setup. Everyone with the server password shares access to its sessions, repositories, credentials, and configured devices. It uses OpenCode preview packages, currently pinned to `0.0.0-beta-18866`.

## Set up your remote instance

You need [Bun](https://bun.sh/), a Cloudflare account, and a compatible OpenCode v2 preview CLI on your local machine. `ocx` launches `opencode2` by default. Use `--binary opencode` if your preview installation uses that name.

Run these commands from this checkout:

```sh
bun install --frozen-lockfile
bunx wrangler login
```

Review `wrangler.jsonc` and choose a Worker name if you want to change the default, `opencode-durable-object`. Keep the Durable Object bindings and migration entries. Wrangler creates the objects on deployment; there is no VM to provision. The remote shell uses the configured Dynamic Worker loader.

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

In the TUI, use `/connect` to configure a model provider. Use `/workspaces` to clone or resume a GitHub repository. For private repositories, `/github` asks for a local file containing your GitHub token. See [remote workspace setup and limits](docs/ux/remote-workspaces.md).

## Connect with ocx

```sh
bun run ocx --server "$OCX_SERVER_URL"
bun run ocx --server "$OCX_SERVER_URL" --binary opencode
bun run ocx --server "$OCX_SERVER_URL" --workspace <id>
bun run ocx --server "$OCX_SERVER_URL" -- --log-level DEBUG
```

`ocx` asks before installing server-authored TUI plugins and before accepting changed plugin code. `--yes` approves those changes automatically, including live updates. The launcher uses a disposable config and leaves your existing OpenCode config untouched. See [plugin loading and approvals](docs/tui-plugins.md).

## Run a device MCP server yourself

The optional device server lets the remote agent read and edit local files, run native shell commands, and publish web previews. Remote repository tools continue to operate on the Durable Object checkout. Device tools operate on the directory you select here; files are not synced between the two.

Install `rg` for file searches and [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) for tunnels. From this checkout, start the device server in one terminal:

```sh
export OPENCODE_DEVICE_ROOT='/absolute/path/to/your/project'
export OPENCODE_DEVICE_TOKEN="$(openssl rand -hex 32)"
bun run device
```

Keep this terminal open. The server listens on `127.0.0.1:7331` and requires the token on `/mcp`. The shell tool runs with your local user's permissions; the workspace root is a starting directory, not a shell sandbox.

In another terminal, expose it through Cloudflare:

```sh
bun run device:tunnel
```

Copy the `https://...trycloudflare.com` URL from cloudflared and append `/mcp`. In the first terminal, stop the device server briefly with Ctrl-C so you can configure the Worker using the same token:

```sh
bunx wrangler secret put DEVICE_MCP_URL
# At the prompt, paste https://<assigned-host>.trycloudflare.com/mcp
printf '%s' "$OPENCODE_DEVICE_TOKEN" | bunx wrangler secret put DEVICE_MCP_TOKEN
bun run device
```

Reconnect `ocx` after setting both secrets. The remote host loads these settings for the default instance and remote workspaces. They apply to everyone using this Worker, even when the `ocx` client runs on another machine. Keep the device server and tunnel running while using device tools.

[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) assign a new hostname when restarted, so update `DEVICE_MCP_URL` each time. They are intended for development, have a 200 in-flight request limit, and do not support SSE. This device server returns JSON MCP responses. For a persistent setup, use a named Cloudflare Tunnel with a stable hostname pointed at `http://127.0.0.1:7331`, and set its HTTPS `/mcp` URL as the secret.

`OPENCODE_DEVICE_PORT` changes the local port; set it in both terminals. `OPENCODE_DEVICE_HOST` changes the bind address and defaults to loopback.

For multiple devices, set `DEVICE_MCP_SERVERS` with `bunx wrangler secret put DEVICE_MCP_SERVERS` and paste an object such as:

```json
{
  "laptop": { "url": "https://laptop.example.com/mcp", "token": "your-laptop-token" },
  "desktop": { "url": "https://desktop.example.com/mcp", "token": "your-desktop-token" }
}
```

Names must start with a lowercase letter and contain at most 32 lowercase letters, digits, or underscores. Named entries are added alongside `DEVICE_MCP_URL`; an entry named `device` overrides that default. To remove access, stop the local server and tunnel, then delete whichever Worker secrets you configured with `bunx wrangler secret delete <name>`.

The device's `preview_start` tool also uses cloudflared. Preview URLs are public and have no preview authentication. The optional preview `name` is a local label, not a hostname. `preview_stop` closes a preview; stopping the device server closes its previews.

Automatic sharing through `ocx` is not implemented yet. A future `--share-device` option should own the server and tunnel, register them for the connection, and remove access on disconnect.

## Remote workspaces without containers

Repository work uses Cloudflare Workers, Durable Objects, and V8 only. No Docker, Cloudflare Container, or Cloudflare Sandbox is configured. Computer stores files in a SQLite DO; Dynamic Workers run just-bash commands and JavaScript modules against those files.

Use `/workspaces` to clone or resume a GitHub repository. Public repositories work without a GitHub token. For private repositories and authenticated fetch/push, `/github` reads a token from a local file path and stores it in the server's catalog DO, outside the checkout and model transcript.

The agent has remote file tools, `remote_shell`, `remote_javascript`, and `remote_git`. You can run commands using `/remote-shell` and ES modules using `/remote-js`. `/remote-changes` shows Git status and diffs. Switching workspaces restarts the TUI against that workspace's session database. `--workspace <id>` attaches directly at startup.

just-bash supports shell scripts, pipes, file and text commands, `curl`, `jq`, `yq`, `xan`, `file`, and `html-to-markdown`. Git uses Computer's JavaScript implementation. JavaScript tasks support relative module imports, async workspace filesystem access, fetch, and assertions. Native programs, package installation, a full Node/Bun runtime, Python, browsers, PTYs, and background servers are unavailable. Checks that require those capabilities must be reported as untested.

See [remote workspace capabilities and examples](docs/ux/remote-workspaces.md) for authentication, execution APIs, limits, and local integration tests.

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

For local device testing, add `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` to `.dev.vars` and restart Wrangler. Local and deployed secrets are separate.

## Repository and checks

- `packages/server`: Worker, Durable Objects, remote workspace tools, and plugin registry.
- `packages/client`: `ocx`, WebSocket transport, loopback proxy, and TUI plugins.
- `packages/protocol`: shared schemas and transport framing.
- `packages/device`: local MCP server and Cloudflare preview tunnels.

```sh
bun run typecheck
bun run build
bun test test/remote test/device-mcps.test.ts test/device-preview.test.ts
```

The build bundles the Worker without deploying. Remote HTTP and WebSocket integration tests require a running server; see [validation](docs/ux/remote-workspaces.md#validation). Other top-level tests retain historical coverage of previous APIs.

See [connection and host lifetime](docs/architecture.md) for transport details. Local checks do not verify Cloudflare eviction or billing. Test an idle attached client against your deployed Worker before relying on hibernation savings.
