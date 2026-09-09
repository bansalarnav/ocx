# Connection and host lifetime

An Effect `RcRef` owns the OpenCode host. Each ordinary request borrows it until the response body ends or is cancelled. Before returning the lease, the wrapper waits for OpenCode's execution service to report that all active turns have settled. This includes asynchronous prompts, queued starts, permission waits, retries and subagents. Closing the last lease finalizes the host and cancels its background timers. The next request rebuilds the host from SQLite and reloads the stored plugins.

The Durable Object accepts sockets with `acceptWebSocket`. Global events, plugin notifications and following session logs have subscription state in `serializeAttachment`, so they survive hibernation without an internal SSE reader. Session logs replay history through the normal finite HTTP route, then switch to live durable events after the replay watermark. Incoming messages wake the object. Client heartbeats use Cloudflare's automatic reply, which does not wake it. SSE heartbeat comments are generated locally for the CLI, between complete event frames.

The local proxy listens only on `127.0.0.1`, on a random port, and requires a fresh password supplied to the child process. Remote credentials stay in the wrapper. Requests retain their methods, paths, query strings and end-to-end headers. Request and response bodies travel in 32 KiB chunks with acknowledgements and cancellation. Connection-specific headers are removed. The protocol limits concurrent requests and subscription buffers; slow subscribers fail and reconnect instead of accumulating an unlimited backlog.

After a network disconnect, the wrapper reconnects its socket. It fails in-flight requests without replaying them, since a mutation may already have reached the server. OpenCode reconnects its event streams; durable session logs can resume from their sequence cursor. Plugin notifications trigger a fresh manifest fetch on every reconnect.

Direct HTTP access remains available for tools such as `curl`. A client attached directly to the remote SSE endpoints still prevents hibernation. Use `ocx` for idle connections that can hibernate. Running model work and other active HTTP streams continue to keep the host alive.

Typechecking, a Worker build and local HTTP/WebSocket checks do not verify Cloudflare eviction or billing. Confirm those against a deployed Worker with an idle attached client before relying on the expected savings.

## Shared devices

`--share-device` negotiates `ocx.v1.device` and carries a validated device ID, HTTPS endpoint, and bearer token in the WebSocket upgrade headers. Ordinary clients continue to use `ocx.v1`. Frame headers cannot register a device.

The DO keeps registration in the socket attachment. Each OpenCode host rebuild reads the live sockets; scoped MCP transforms reload when devices connect or disconnect. Closing a socket clears its registration before notifying the MCP services. Reconnecting with the same device ID replaces the old socket registration.

The MCP service checks that a shared device is still connected before executing a tool, including tools cached by an active turn. It interrupts in-flight calls when registration disappears. Static device configuration remains independent. Shared device names use the reserved `ocx_device_` prefix.

The launcher owns the local MCP process and a Bun child running the embedded OpenTunnel client. It shuts them down on startup failure, interruption, normal CLI exit, or unexpected process exit. Device shutdown also stops its preview processes and running shell commands. Public OpenTunnel reachability and deployed hibernation still need live validation.
