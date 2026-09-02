# TUI plugin shim plan

## Status

Phase 1 is implemented. The Durable Object exposes authenticated manifest, immutable content-addressed artifact, and registry-event routes. The `ocx` launcher keeps per-origin approvals and cache entries, verifies SHA-256 digests, creates a disposable TUI config, and starts the unmodified CLI. Connected clients receive registry changes and materialize approved versions into OpenCode's native watched plugin directories.

The original plan referred to `cli.json` and a managed `XDG_CONFIG_HOME`. The matching OpenCode beta uses `tui.json` for TUI settings and auto-discovers local TUI plugins under `OPENCODE_CONFIG_DIR/plugins/<name>/`. Each discovered directory requires an `index.ts` or `index.js` anchor plus its `tui.tsx`; it does not require a `package.json`. The implementation uses `OPENCODE_TUI_CONFIG` and `OPENCODE_CONFIG_DIR`, which preserves the user's normal config and credential locations.

Signing keys, retained rollback history, permission changes, pinning, command-line disabling, and compatibility checks remain phase 2 work.

The chosen TUI model permits arbitrary OpenCode CLI plugins. Agent-written TUI code will run locally inside the normal OpenCode terminal process, so installation must be explicit and every downloaded artifact must be pinned and verifiable.

## Goal

Provide a small launcher, tentatively named `ocx`, that lets a user connect to an OpenCode server and use TUI plugins authored or updated by that server without publishing each plugin to npm.

The launcher should not fork or replace OpenCode. It prepares a local plugin directory and CLI configuration, then executes the installed `opencode2` binary.

```text
ocx
  -> authenticate with the selected OpenCode server
  -> fetch its TUI plugin manifest
  -> approve and download changed plugins
  -> verify and cache immutable artifacts
  -> create a merged cli.json in a managed config directory
  -> exec opencode2 --server <url>
```

## Server contract

The server should expose an authenticated TUI registry independently from OpenCode's existing plugin-list endpoint.

Suggested endpoints:

- `GET /api/generated-plugins/tui` returns the enabled plugin manifest.
- `GET /api/generated-plugins/tui/:id/:version` returns one immutable artifact.
- `GET /api/generated-plugins/tui/:id/:version/signature` is optional if the signature is included in the manifest.

Each manifest entry should include:

```json
{
  "id": "device-dashboard",
  "version": "3",
  "sha256": "hex-encoded-content-hash",
  "signature": "base64-signature",
  "entrypoint": "tui.tsx",
  "contentType": "application/typescript",
  "opencode": {
    "minimumVersion": "2.0.0-beta.18371"
  },
  "permissions": {
    "serverOrigins": ["self"],
    "filesystem": false,
    "process": false,
    "network": false
  },
  "notes": "Adds a device and preview dashboard"
}
```

The initial artifact format should be a single TypeScript or TSX entrypoint that imports only APIs supplied by the OpenCode TUI runtime. Package directories and third-party dependencies can come later. This avoids package installation and lifecycle scripts in the first client implementation.

The server must never change the bytes associated with an existing `(plugin id, version, sha256)` tuple. A code change creates a new version.

## Local launcher behavior

The launcher should identify a server by its normalized origin and public signing key, not by its display name. Two servers must never share a plugin cache or approval record.

Suggested local layout:

```text
~/.local/share/ocx/
  servers/<server-id>/
    trust.json
    approvals.json
    plugins/<plugin-id>/<sha256>/tui.tsx
    generated-config/tui.json
    generated-config/plugins/<plugin-id>/index.ts
    generated-config/plugins/<plugin-id>/tui.tsx
```

On startup, the launcher should:

1. Read the user's normal `cli.json` without modifying it.
2. Fetch the remote manifest using the same server credentials that will be used by OpenCode.
3. Compare enabled versions with the local lock and cache.
4. Ask for approval before the first install and whenever declared permissions expand.
5. Download artifacts into a temporary file, verify the hash and signature, then move the verified file into the immutable cache path.
6. Produce a merged `tui.json` and materialize approved plugins in the managed config directory's native `plugins/<id>/` layout.
7. Launch OpenCode with `OPENCODE_TUI_CONFIG`, `OPENCODE_CONFIG_DIR`, and the requested remote server.

The generated configuration is disposable. The launcher should regenerate it rather than edit it in place. User settings remain owned by the user.

## Trust and approval rules

TUI plugins are local code execution. They receive OpenCode's TUI context and run with the operating-system permissions of the OpenCode process. The launcher cannot honestly present them as sandboxed.

Required rules:

- Trust is granted to one server identity, never to every server at a hostname pattern.
- The first plugin install requires confirmation that names the server and plugin.
- A new content hash requires approval unless the user explicitly enabled automatic updates for that plugin.
- Permission expansion always requires fresh approval, even when automatic updates are enabled.
- Downgrades and rollbacks are explicit and retain the previous artifact in the cache.
- A failed signature or hash check stops the launch for that plugin and shows a clear error.
- Plugin artifacts cannot alter the launcher, its trust database, or the generated configuration.
- The launcher provides `list`, `disable`, `pin`, `rollback`, and `clear` commands without requiring the TUI to start.

Signatures protect the transfer and bind an artifact to the trusted server key. They do not make agent-written code safe. The approval screen should say that plainly.

## Authentication

The launcher should avoid copying long-lived credentials into plugin files or generated configuration. Prefer one of these approaches:

1. Reuse an OpenCode-supported credential store if the CLI exposes a stable interface for it.
2. Pass a short-lived bearer token to the manifest download and the launched client through inherited process state.
3. Let the server issue an artifact-only token that cannot call session, model, or device APIs.

Downloaded TUI code should call the connected server through `context.client`. It should not receive the bearer token as a string.

## Version compatibility

The manifest must declare its supported OpenCode CLI and TUI plugin API versions. The launcher should reject incompatible plugins before starting OpenCode.

The local cache key should include the artifact hash, while the generated configuration should point at the selected hash. This makes rollback deterministic and prevents an update from changing a running client.

Plugin updates take effect immediately for connected `ocx` clients after local approval. The server broadcasts only that the registry changed. Each client fetches the manifest, verifies the selected artifact, and controls activation.

## Server authoring flow

The future server-side agent flow should be:

1. Create a TUI plugin draft containing source, metadata, and tests or static checks.
2. Validate the entrypoint and restrict imports to the supported TUI packages.
3. Type-check or compile the source in an isolated build environment.
4. Record the requested local permissions.
5. Publish an immutable version into the TUI registry.
6. Sign the artifact manifest with a server-held key that generated code cannot access.
7. Keep prior versions available for rollback.

Publishing a TUI plugin should not enable it automatically for existing clients. The launcher remains the local approval boundary.

## Delivery phases

### Phase 1: launcher proof of concept

- One manually written TSX plugin served by the DO.
- One manifest endpoint and one artifact endpoint.
- SHA-256 verification.
- Explicit first-install approval.
- Managed `XDG_CONFIG_HOME` and an unmodified `opencode2` child process.

### Phase 2: durable trust

- Server signing keys and signature verification.
- Per-server trust records.
- Pin, disable, rollback, and cache inspection commands.
- Compatibility checks.

### Phase 3: agent authoring

- Draft, validate, test, publish, and deprecate tools for the agent.
- Import restrictions and isolated compilation.
- Permission-diff approval.
- Audit log linking a published artifact to the session and message that created it.

### Phase 4: package-shaped plugins

- Multi-file artifacts.
- Static assets.
- Carefully controlled dependencies without install scripts.
- Third-party package dependencies.

## Open questions

- Which stable server authentication mechanism can the launcher reuse?
- Should the server signing key be unique per deployment or derived from an operator-managed root key?
- How should a plugin declare local filesystem, subprocess, and unrestricted network use when JavaScript cannot enforce those declarations by itself?
- Can TypeScript and TSX validation run entirely in a Dynamic Worker, or does it need a Cloudflare Sandbox or local build step?
- Should a client pin the first approved server key, or require an out-of-band fingerprint for the first connection?
