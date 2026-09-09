# Server-authored TUI plugins

`ocx` is a small wrapper around `opencode2`. It fetches enabled TUI plugins from this Worker, asks before installing local code, verifies each artifact's SHA-256 digest, writes a disposable `tui.json`, then starts the normal CLI process.

From this checkout:

```sh
bun run ocx --server https://opencode-durable-object.<subdomain>.workers.dev --password secret
```

Use `--binary opencode` if the preview executable on your machine has that name. Put options for OpenCode after `--`:

```sh
bun run ocx --server http://localhost:8787 -- --log-level DEBUG
```

The cache lives under `$XDG_DATA_HOME/ocx`, or `~/.local/share/ocx` when `XDG_DATA_HOME` is unset. Each server origin has a separate cache and approval file. A first install and every content change requires confirmation. `--yes` is available for trusted non-interactive use.

`ocx` carries registry notifications over its authenticated WebSocket while the TUI runs. Publishing, editing, enabling, or disabling a TUI plugin notifies every connected `ocx` client. Each client shows its own approval dialog for new code, verifies and caches the artifact, then replaces the running plugin without restarting OpenCode. Starting with `--yes` also approves live updates automatically.

Approved plugins are materialized in each client's disposable config directory at `plugins/<id>/index.ts` and `tui.tsx`. OpenCode watches those entrypoints and performs the hot reload itself. A small separate TUI plugin only presents approval dialogs for updates received while the client is running. Plugins must return cleanup functions so OpenCode can remove the previous version cleanly.

The launcher reads the user's existing `tui.json` or `tui.jsonc`, but does not edit it. It passes the generated file through `OPENCODE_TUI_CONFIG` and uses a per-process `OPENCODE_CONFIG_DIR`, whose `plugins` directory OpenCode discovers automatically.
