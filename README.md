# OpenCode on a Durable Object

This Worker runs the full OpenCode v2 HTTP server inside one Cloudflare Durable Object. SQLite-backed state and durable events survive object eviction.

Wrangler minifies the Worker for deployment. The current bundle is about 2.82 MiB compressed, below Cloudflare's 3 MiB free-plan limit.

## Run locally

```sh
bun install
bun run dev
```

Check the server:

```sh
curl http://localhost:8787/api/health
opencode2 --server http://localhost:8787
```

The v2 preview CLI may be named `opencode` instead of `opencode2` in your installation.

## Load server-authored TUI plugins

`ocx` is a small wrapper around `opencode2`. It fetches enabled TUI plugins from this Worker, asks before installing local code, verifies each artifact's SHA-256 digest, writes a disposable `tui.json`, then starts the normal CLI process.

From this checkout:

```sh
OPENCODE_PASSWORD=secret bun run ocx --server https://opencode-durable-object.<subdomain>.workers.dev
```

Use `--binary opencode` if the preview executable on your machine has that name. Put options for OpenCode after `--`:

```sh
bun run ocx --server http://localhost:8787 -- --log-level DEBUG
```

The cache lives under `$XDG_DATA_HOME/ocx`, or `~/.local/share/ocx` when `XDG_DATA_HOME` is unset. Each server origin has a separate cache and approval file. A first install and every content change requires confirmation. `--yes` is available for trusted non-interactive use.

The launcher reads the user's existing `tui.json` or `tui.jsonc`, but does not edit it. It passes the generated file through `OPENCODE_TUI_CONFIG` and uses a per-server `OPENCODE_CONFIG_DIR` so OpenCode can resolve the TUI runtime imports.

## Protect and deploy it

Set a password before exposing the Worker publicly:

```sh
bunx wrangler secret put OPENCODE_PASSWORD
bun run deploy
```

Connect with the same password:

```sh
OPENCODE_PASSWORD=secret opencode2 --server https://opencode-durable-object.<subdomain>.workers.dev
```

Without the secret, the complete API is public and unauthenticated.

## Device tools over MCP

The Durable Object disables OpenCode's built-in `read`, `glob`, `grep`, `write`, `edit`, `patch`, and `shell` tools. A small MCP server in `device/server.ts` provides replacements that operate on this machine. Create a persistent token once, then start the server:

```sh
mkdir -p ~/.tnl
umask 077
test -s ~/.tnl/opencode-device-token || openssl rand -hex 32 > ~/.tnl/opencode-device-token
IFS= read -r OPENCODE_DEVICE_TOKEN < ~/.tnl/opencode-device-token
export OPENCODE_DEVICE_TOKEN
export OPENCODE_DEVICE_ROOT="$PWD"
bun run device
```

It listens on `127.0.0.1:7331` by default. The MCP endpoint is `/mcp`; `/health` is available for tunnel health checks. Requests to `/mcp` require `Authorization: Bearer $OPENCODE_DEVICE_TOKEN`.

In another terminal, expose port 7331 with `tnlc`:

```sh
bun run device:tunnel
```

Then configure the Worker with the tunnel endpoint and the same token:

```sh
printf %s 'https://opencode-mcp.tnl.arnav.fish/mcp' | bunx wrangler secret put DEVICE_MCP_URL
bunx wrangler secret put DEVICE_MCP_TOKEN < ~/.tnl/opencode-device-token

bun run deploy
```

The model receives the replacements as `device_read`, `device_glob`, `device_grep`, `device_write`, `device_edit`, `device_patch`, and `device_shell`.

### Multiple devices

Set the `DEVICE_MCP_SERVERS` secret to a JSON object keyed by device name. Names may contain lowercase letters, numbers, and underscores. Each name becomes the prefix for that device's tools.

```sh
bunx wrangler secret put DEVICE_MCP_SERVERS
```

Paste a registry like this when Wrangler prompts for the secret:

```json
{
  "laptop": {
    "url": "https://my-laptop.tnl.arnav.fish/mcp",
    "token": "token-used-by-the-laptop-device-server"
  },
  "desktop": {
    "url": "https://my-desktop.tnl.arnav.fish/mcp",
    "token": "token-used-by-the-desktop-device-server"
  }
}
```

Run the device server and a uniquely named tunnel on each machine. For example, set `OPENCODE_DEVICE_TUNNEL_NAME=my-laptop` on the laptop and `OPENCODE_DEVICE_TUNNEL_NAME=my-desktop` on the desktop before running `bun run device:tunnel`.

The model then receives `laptop_read`, `laptop_shell`, `desktop_read`, `desktop_shell`, and the rest of each device's catalog. The device server includes its workspace root in its MCP instructions, which helps the model choose the right machine. Updating the registry secret creates a new Worker version, so the next Durable Object activation uses the new device list.

The old `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` secrets remain supported as a device named `device`. Named registry entries are added alongside it. A `device` entry in `DEVICE_MCP_SERVERS` replaces the legacy slot.

### Public previews

The device server also exposes `device_preview_start`, `device_preview_list`, and `device_preview_stop`. The agent can launch a local web server, wait for its port, expose it through `tnlc`, and return the public HTTPS URL. For example, it can call `device_preview_start` with a command such as `bun run dev -- --host 127.0.0.1 --port 3000` and port `3000`.

If a web server is already running, the agent can omit `command` and provide only its port. `device_preview_stop` closes the tunnel and also stops the command launched by `device_preview_start`. The default URL is `https://opencode-preview.tnl.arnav.fish`; its certificate is cached, so later previews do not wait for new certificate issuance. Only one preview can use that hostname at a time. The agent can provide another name when it needs a second concurrent preview.

Preview URLs are public and do not use the MCP bearer token. Do not preview applications containing secrets, administrative routes, or trusted development-only APIs.

File operations reject paths and symlinks that leave `OPENCODE_DEVICE_ROOT`. The shell starts in that root but is intentionally not sandboxed; a shell command can still access anything allowed to the local operating-system user. Run this under a restricted user if that is not acceptable.

## Runtime limits

The Workerd profile exposes every HTTP route, but Cloudflare cannot provide its own local process, filesystem, shell, or PTY. Sessions, configuration, credentials, integrations, model calls, events, and other database-backed APIs run inside the Durable Object. File and shell work crosses MCP to the device server while it is online. PTY endpoints remain unavailable.

The Worker uses OpenCode's bundled model catalog and disables its periodic models.dev refresh. Update the OpenCode dependency and redeploy to pick up new catalog metadata.

An Effect `RcRef` owns the OpenCode host. Each request borrows it through an Effect `Scope`, so concurrent requests and open response streams share one host. Once the final response body finishes or is cancelled, closing its borrower scope makes `RcRef` finalize OpenCode and cancel its background timers. The Durable Object can then become idle. A later request rebuilds the host from durable SQLite state and reconnects the MCP server. An attached TUI keeps its event stream open, so the host stays active until that client disconnects.
