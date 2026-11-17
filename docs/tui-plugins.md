# Cloud and authored TUI plugins

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

## Durable npm package installations

Inside OpenCode, open **Cloud plugins** from the command palette or `/cloud-plugins`. Install by npm package name and choose all cloud projects or the current project. The same manager enables, disables and uninstalls packages. The launcher resolves the attached session's project for manifest, artifact and watch requests; changing to a session in another project reloads the attachment with that scope.

The cloud package manager accepts npm names with an optional version, range, or tag. It resolves the version once, downloads the package and its production dependencies into a virtual filesystem, and builds self-contained server and TUI bundles. It never runs npm lifecycle scripts. The package record, resolved version, and bundles live in Durable Object storage. Suspending or replacing a workspace sandbox does not remove them, and restarting the host does not fetch npm again.

The implementation follows the installed `@opencode/plugin@2.3.0` contract. It resolves the `./server` export before the root export, and resolves `./tui` separately. Packages without exports can use conventional `server.js`, `server.ts`, `tui.js`, `tui.tsx`, or a main entry. A server plugin must default-export `Plugin.define({ id, setup })` using the Promise API. Package authors do not need a cloud-specific manifest or a rewritten plugin. The Effect API and legacy function/hook-map plugins are unsupported and fail installation.

Server code runs in QuickJS with `tool.transform` during setup and durable plugin `storage`. Tools can publish progress through the normal tool context. Tool inputs must be JSON Schema. This bridge adds tools; it cannot modify built-in tools or change the tool catalog after setup. `tool.reload` and the tool context's `signal` are unsupported and fail explicitly; cancellation interrupts execution. Node, Bun, filesystem, subprocess, network, timers, dynamic imports, and other plugin context domains are unavailable. Bundling checks imports and common unsupported capability references, then executes setup in an isolated VM with disposable storage responses and no network or durable writes. These checks are conservative and can reject packages whose bundled code mentions an unsupported API even in an unused branch. They cannot prove every later execution path succeeds. No plugin receives a Node or filesystem runtime inside the Durable Object.

The host supplies the `Plugin.define` import. Other runtime exports from `@opencode/plugin`, such as schema helpers, are not implemented by that virtual module. Bundle schema libraries as dependencies or use JSON Schema literals. TUI bundles may retain imports from the stable TUI SDK, OpenTUI, and Solid. Other unresolved imports fail installation. TUI code still requires approval on each connected client through the existing artifact registry.

All endpoints use the server's existing Basic authentication. JSON errors use `{ "error": "message" }`. Invalid packages or unsupported capabilities return 422; missing installations return 404; installing an existing package in the same scope returns 409.

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/ocx/plugins` | None | `{ plugins: CloudPluginInfo[] }` |
| `POST /api/ocx/plugins` | `{ package: "name@version", scope: "cloud" }` or `{ package, scope: "project", projectID }` | 201 `{ plugin: CloudPluginInfo }` |
| `POST /api/ocx/plugins/:id/enable` | None | `{ plugin: CloudPluginInfo }` |
| `POST /api/ocx/plugins/:id/disable` | None | `{ plugin: CloudPluginInfo }` |
| `DELETE /api/ocx/plugins/:id` | None | `{ ok: true, id }` |

`CloudPluginInfo` includes `id`, `package`, pinned `version`, `scope`, optional `projectID`, `enabled`, `updatedAt`, `runtime: "quickjs-promise"`, `serverStatus`, `tuiStatus`, and `warnings`. Server status is `enabled`, `disabled`, or `absent`; TUI status is `available-to-clients`, `disabled`, or `absent`. Enabled describes configured activation. Package mutations invalidate the host so subsequent requests use the updated registry. Existing requests retain their host until they finish. A tool failure still reports through the normal tool error path. Shared types live in `packages/protocol/src/cloud-plugins.ts`.

A cloud installation applies to every session in this cloud instance. A project installation applies to sessions whose workspace has that `projectID`. Sessions outside managed workspaces use their exact session directory as the project identity. Filtering removes tools from other sessions' context and also rejects direct execution outside the project. Each package installation gets its own tool namespace and durable storage namespace, so installing a package in two projects does not collide. Package tool names use a compact installation prefix. Long names get a stable hash suffix to stay within provider limits while execution still invokes the original package tool.

Project TUI clients must send the same identity as `?projectID=...` or `x-ocx-project-id` on both the manifest and artifact requests to `/api/generated-plugins/tui`. Omitting the identity returns cloud and authored plugins only. The artifact endpoint repeats the scope check. Registry change notifications continue to reach connected clients; clients refresh the manifest for their current project.

Package installations are managed separately from authored workspaces. The author cannot edit an installed package in place. To change its version, remove it and install another pinned version. Existing authoring and source dependency installation continue through their original tools.

Run the server package tests with `bun test test/cloud-plugins.test.ts`. They start a local workerd process to exercise the actual npm tar extractor, dependency resolver, bundler, and QuickJS VM. Set `OCX_TEST_NPM=1` to also test a live registry download. No deployment or secrets are required.
