# Work locally and remotely inside OpenCode

Start OpenCode through the launcher:

```sh
bun run ocx
```

It opens local OpenCode with your existing server configuration, providers, conversation database, and TUI settings. The launcher reuses a registered local OpenCode service, or starts a backend automatically, and adds the workspace UI. There is no separate server command, plugin installation, local URL, or environment variable to manage.

The footer shows your device's hostname or `remote`. Open **Remote** in the command palette, or type `/remote`, for all remote actions.

## Connect once

Choose **Connect a remote**. Enter your Cloudflare OpenCode server URL and password in OpenCode. The launcher checks the connection and remembers it privately on this device. Its password stays in the launcher; the TUI receives only a temporary loopback capability.

The remote installation needs to have been deployed by its administrator. Infrastructure provisioning is separate from using OpenCode; see the server setup below.

## Continue the current conversation remotely

Choose **Continue remotely** in the command palette or Remote menu. The current thread and repository come from OpenCode itself.

A progress dialog covers settling the conversation, saving the checkout, preparing the sandbox, and importing the thread. On completion, the destination conversation opens automatically in the same terminal. There is no attach command to copy and no session ID to look up.

The source conversation is archived and its checkout stays in place. Cloudflare runs the remote agent and Maritime executes its commands, so the task continues after you close the local client. Ignored files are omitted; tracked files and nonignored untracked files are transferred as they are. Model provider credentials are configured separately on the remote through OpenCode's normal `/connect` flow.

## Create a remote conversation

Choose **New remote thread** from the Remote menu or command palette.

1. Select a GitHub repository, or enter a public repository URL.
2. Choose a new branch or an existing branch.
3. Pick the base branch and enter a name for a new branch if needed.
4. Describe the task, or leave it empty to start a conversation.

OpenCode prepares the checkout and opens the new remote thread automatically. Every workspace has its own isolated checkout. The current version uses independent clones, not linked Git worktrees.

**Connect GitHub** in the same menu displays an authorization URL and code. Authorize in the browser; OpenCode notices completion and you can browse private repositories. No terminal login command is needed.

## Switch between local and remote work

Choose **Browse remote workspaces**, select a workspace, then select a named thread. It opens in the same terminal. **Back to <hostname>** returns to conversations on your device while the remote task keeps running.

The launcher keeps the local backend alive while switching. Upstream's TUI has no public API for replacing its server connection, so the launcher automatically replaces the TUI attachment in the same terminal. Conversations and compute survive that change. The user does not exit and relaunch OpenCode manually. Exiting the launcher leaves a reused local service running and stops a backend it started itself.

## Continue remotely created work locally

From a remote conversation, choose **Continue on <hostname>**, where the label uses your device's actual hostname. The default destination is an **OpenCode-managed checkout**. Choose **Choose a folder** only if you want a specific new or empty directory. The `/continue-here` command opens the same flow; `/continue-locally` remains an alias.

The launcher restores the checkout and conversation, transfers ownership, and opens the local thread automatically. Managed checkouts live under `$XDG_DATA_HOME/opencode/workspaces/<workspace>/<transfer>`, or `~/.local/share/opencode/workspaces/...`.

Remote execution is disabled after the local handoff commits. Both copies remain recoverable. Imported sessions have fresh session and message identities so repeated round trips can coexist with older copies. Source local conversations are archived, but stock OpenCode can explicitly reopen an archived source; do that only when you intend to fork the work.

## Recover without leaving OpenCode

The footer indicates unfinished transfers. Choose **Recover transfer** from the Remote menu or command palette, select the transfer, then choose **Resume transfer** or **Return to the source**.

Transfer receipts are saved before mutations. Preparation is recorded before freezing a remote source. Recovery resumes completed stages, including restoring a checkout or importing part of a session family. Ownership commit and continuation admission are tracked separately, preventing lost admission replies from duplicating work. A committed transfer cannot be aborted.

Receipts are private files containing conversation content and paths. They do not contain remote passwords. A new launcher can recover receipts from an older local backend port by routing them to the current managed backend, which uses the same persistent OpenCode database.

## Previews, pull requests, and pausing

While in a remote workspace, the Remote menu also offers:

- **Open preview**: enter the port of a development server started by the agent and receive its private Maritime URL.
- **Create pull request**: enter a title and description. Current nonignored changes are committed, the branch is pushed, and an open PR is created or reused. A checkout on the base branch gets a separate `ocx/<workspace>` branch first.
- **Pause workspace**: checkpoint the checkout and pause compute.

Private checkpoint refs are never pushed to GitHub. Preview URLs contain a token and should be treated as credentials. Sandboxes also pause automatically after 15 minutes without activity.

## Server setup

The server runs stable OpenCode 2.3.0 in a Cloudflare Durable Object. Cloudflare Artifacts stores Git history and workspace checkpoints. Maritime supplies Linux execution. Model calls and conversation state remain on Cloudflare.

An administrator installs dependencies, logs into Cloudflare, configures the Artifacts namespace in `wrangler.jsonc`, and sets these Worker secrets:

```sh
bun install --frozen-lockfile
bunx wrangler login
bunx wrangler secret put OPENCODE_PASSWORD
bunx wrangler secret put MARITIME_API_KEY
```

Artifacts requires Workers Paid. Maritime needs sandbox access and a template containing `git`, Node.js, Python 3, `rg`, `/bin/bash`, and GNU coreutils. Set `MARITIME_TEMPLATE` to that image or snapshot name; `base` is used otherwise. Provisioning checks these tools before cloning.

For GitHub, configure `GITHUB_CLIENT_ID` for an OAuth app with device authorization enabled, or set `GITHUB_TOKEN` as a Worker secret. Private repository access and PR creation require the corresponding GitHub permissions. Everyone with the server password shares the connection in this single-owner deployment.

Deploy the server:

```sh
bun run deploy
```

Users then connect to its URL from inside OpenCode. Provider credentials are configured using `/connect` on the remote. Instance config syncing is supported; automatic checkout-specific `opencode.json` discovery is not implemented.

## Transfer boundaries

Checkpoints preserve HEAD, unpublished history, staged and unstaged edits, binary files, modes, symlinks, deletions, and nonignored untracked files without adding commits to the working branch. Unresolved Git operations and submodules are rejected explicitly.

Session transfers preserve projected transcripts, including settled tool results and compaction summaries. Running processes, pending permissions, queued prompts, filesystem revert snapshots, and the old durable event log do not migrate. Pending prompts must be delivered or cancelled first. Historical absolute paths stay in transcript text; the remote continuation receives a location-change notice.

Process output arrives when the command finishes. Interactive terminals and live shell output are not implemented. Commands have a maximum lifetime of one hour. Artifacts currently limits new repositories to 1 GB, files to 32 MiB, and pushes to 64 MiB; upload failure leaves the source available.

## Automation and checks

`ocx remote ...` remains available for scripts and automation. It is not required for any of the interactive flows above. Run `bun run ocx remote --help` for those commands.

```sh
bun run prepare:checkpoint
bun run typecheck
bun test ./test
bun run build
```

Tests use real Git repositories, local processes, the actual OpenCode host, and a scripted model to exercise transfers and native tools. Launcher and UI tests cover discovery, destination activation, recovery, and cleanup. Production hibernation, provider billing, and real Maritime reachability still require a configured deployment smoke test.
