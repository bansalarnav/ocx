# Server-authored TUI plugins

`ocx` wraps stable `opencode`. It fetches enabled TUI plugins from the Worker, verifies approved artifacts against their SHA-256 digests, writes a disposable `cli.json`, and starts the normal CLI process. First-time approvals appear inside OpenCode after the interface opens.

From this checkout:

```sh
bun run ocx --server https://opencode-durable-object.<subdomain>.workers.dev --password secret
```

Use `--binary /path/to/opencode` to choose another installation. Put options for OpenCode after `--`:

```sh
bun run ocx --server http://localhost:8787 -- --log-level debug
```

The cache lives under `$XDG_DATA_HOME/ocx`, or `~/.local/share/ocx` when `XDG_DATA_HOME` is unset. Each server origin has a separate cache and approval file. A first install and every content change requires confirmation. `--yes` is available for trusted non-interactive use.

`ocx` carries registry notifications over its authenticated WebSocket while the TUI runs. Publishing, editing, enabling, or disabling a TUI plugin notifies every connected `ocx` client. Each client shows its own approval dialog for new code, verifies and caches the artifact, then replaces the running plugin without restarting OpenCode. Starting with `--yes` also approves live updates automatically.

Approved plugins are materialized in each client's disposable config directory at `plugins/<id>/index.ts` and `tui.tsx`. Stable OpenCode watches the `plugins` directory and each discovered plugin's sources. Approval creates the directory, updates replace the verified source, and disabling removes the directory. OpenCode loads or cleans up each plugin without restarting. A built-in TUI plugin presents approval dialogs. Plugins must return cleanup functions so OpenCode can remove the previous version cleanly.

The launcher reads the user's existing `cli.json`, with `tui.jsonc` and `tui.json` as migration fallbacks, and leaves it untouched. Stable OpenCode uses `OPENCODE_CONFIG_DIR` to select the disposable configuration directory and `OPENCODE_CLI_CONFIG_CONTENT` for the built-in plugin declarations. Generated plugin paths stay out of that immutable inline list so native discovery can add and remove them while OpenCode runs.
