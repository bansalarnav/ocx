# Connection and host lifetime

An Effect `RcRef` owns the OpenCode host. Each ordinary request borrows it until the response body ends or is cancelled. Before returning the lease, the wrapper waits for OpenCode's execution service to report that all active turns have settled. This includes asynchronous prompts, queued starts, permission waits, retries and subagents. Closing the last lease finalizes the host and cancels its background timers. The next request rebuilds the host from SQLite and reloads the stored plugins.

The Durable Object accepts sockets with `acceptWebSocket`. Global events, plugin notifications and following session logs have subscription state in `serializeAttachment`, so they survive hibernation without an internal SSE reader. For session logs, the client first installs a live subscription, then fetches history over HTTP with `follow=false`. It forwards the original replay bytes, reads the final sequence watermark, and discards queued live events at or below that watermark before continuing. Subscribing before the snapshot prevents a gap during the handoff. Incoming messages wake the object. Client heartbeats use Cloudflare's automatic reply, which does not wake it. SSE heartbeat comments are generated locally for the CLI. Socket events contain complete SSE frames, so heartbeats cannot split an event. Live events do not rewrite socket attachments.

The local proxy listens only on `127.0.0.1`, on a random port, and requires a fresh password supplied to the child process. Remote credentials stay in the wrapper. Requests retain their methods, paths, query strings and end-to-end headers. API requests and bodies stream over ordinary HTTP, including finite log replay. The proxy replaces local credentials with remote credentials, strips connection-specific headers and device registration headers, and forwards redirects without following them. Fetch decodes response compression, so the proxy removes stale encoding and length headers. Request aborts propagate to HTTP fetches.

The WebSocket carries only subscription controls and live events. There are no application ACKs, upload chunks, response chunks, or request/response exchanges. Each connection allows eight subscriptions. Each subscription has a 2 MiB client queue; overflow fails that stream and unsubscribes it so the consumer can reconnect and resync. Serialized event frames are limited to 2 MiB. These limits bound application queues and individual frames, not Cloudflare's internal socket send buffers, which the Workers API does not expose. Removing ACKs means the server no longer tracks consumer progress. Oversized events fail the connection explicitly.

The local proxy still presents ordinary HTTP and SSE to OpenCode, so the upstream TUI needs no changes.

After a network disconnect, the wrapper reconnects its socket. It fails event subscriptions; independent HTTP requests continue. HTTP mutations are never automatically replayed, since a mutation may already have reached the server. OpenCode reconnects its event streams; durable session logs can resume from their sequence cursor. Plugin notifications trigger a fresh manifest fetch on every reconnect.

Direct HTTP access remains available for tools such as `curl`. A client attached directly to the remote SSE endpoints still prevents hibernation. Use `ocx` for idle connections that can hibernate. Running model work and other active HTTP streams continue to keep the host alive.

Typechecking, a Worker build and local HTTP/WebSocket checks do not verify Cloudflare eviction or billing. Confirm those against a deployed Worker with an idle attached client before relying on the expected savings.

## Shared devices

`--share-device` negotiates `ocx.v2.device` and carries a validated device ID, HTTPS endpoint, and bearer token in the WebSocket upgrade headers. Ordinary clients continue to use `ocx.v2`. Only the authenticated upgrade can register a device. The client waits for registration before making HTTP calls when device sharing is enabled. Deploy the Worker and update ocx together; v1 handshakes and surviving v1 attachments are rejected.

The DO keeps registration in the socket attachment. Each OpenCode host rebuild reads the live sockets; scoped MCP transforms reload when devices connect or disconnect. Closing a socket clears its registration before notifying the MCP services. Reconnecting with the same device ID replaces the old socket registration.

The MCP service checks that a shared device is still connected before executing a tool, including tools cached by an active turn. It interrupts in-flight calls when registration disappears. Static device configuration remains independent. Shared device names use the reserved `ocx_device_` prefix.

The launcher owns the local MCP process and a Bun child running the embedded OpenTunnel client. It shuts them down on startup failure, interruption, normal CLI exit, or unexpected process exit. Device shutdown also stops its preview processes and running shell commands. Public OpenTunnel reachability and deployed hibernation still need live validation.

## Transport checks

Run `bun test ./test/transport.test.ts ./test/socket-subscriptions.test.ts`, `bun run typecheck`, and `bun run build`. The transport tests cover HTTP bodies/authentication/redirects, event cancellation without ACKs, log replay overlap, replay errors, queue overflow, disconnect isolation, shared-device registration, and attachment reconstruction.
