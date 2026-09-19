# Cloudflare resource usage audit

Reviewed 2026-09-09 against latest remote main, `6bf0335`, and the installed OpenCode packages at `0.0.0-beta-18866`.

`ux/remote-workspaces` started at `4881157`. Fetching and merging `origin/main` fast-forwarded it to `6bf0335`; there were no conflicts or branch-only commits. These findings therefore apply to both latest main and the updated branch. This is a code audit, not a measurement of the deployed session. The deployed commit, dashboard chart, session length, and actual SQL deltas were not supplied.

## Follow-up on this branch

The HTTP/WebSocket split is now implemented. Ordinary requests and finite log history use HTTP. The socket only carries live subscriptions and device presence; per-chunk ACKs and the generic HTTP tunnel are removed. The earlier findings below describe `6bf0335` and remain the baseline for comparison. The batching proposal in item 2 is superseded by this change. Host startup, plugin storage, reconnect backoff, and durable SQL writes are unchanged. The implementation and its tests will merge separately from this audit.

## What the request counter means

Workers count the initial WebSocket upgrade as a request, but not subsequent WebSocket messages. Ordinary HTTP calls still count. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Durable Object analytics count incoming WebSocket messages individually. Compute request billing applies a 20:1 ratio to those messages; outgoing messages are uncharged. Connection requests count separately. Thus 50 incoming messages represent 2.5 request-equivalents before billing aggregation, not necessarily 50 billed requests. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Our proxy multiplexes HTTP over one WebSocket, but each request, upload chunk, upload end, response acknowledgement, and cancellation is a separate incoming message. In particular, the client acknowledges every response chunk, including live event chunks. The server invokes its HTTP handler locally, so that invocation is not another external Worker request. See [client transport](../packages/client/src/transport.ts) and [server transport](../packages/server/src/transport.ts).

A bodyless GET returning one chunk normally generates two incoming frames: request and acknowledgement. Twenty-five such GETs could explain a +50 DO analytics count without a reconnect loop. Streaming output also generates acknowledgements continuously. This is an example, not a reconstruction of the reported session. A +50 Worker request count would need a different explanation, such as direct HTTP traffic or repeated upgrades.

## Findings and proposed changes

### 1. Reduce host rebuilds and repeated startup reads

[host.ts](../packages/server/src/host.ts) creates `RcRef.make({ acquire })` without an idle lifetime. The last response releases its lease after active executions settle. A later request rebuilds the host even if the DO itself has stayed in memory. Concurrent requests can share the host; requests separated by an idle gap cannot.

Every acquisition runs `store.list`, reloads plugins, and constructs the upstream server. Upstream database initialization checks migrations, including `SELECT id FROM migration`. These repeated reads are a credible source of amplification. Applied migrations are skipped; the code does not rerun every migration's writes on each request.

First measure host acquisitions per interaction and SQL rows during acquisition. Prefer keeping completed migration checks and immutable plugin metadata cached for the DO instance, with invalidation on storage changes and fresh checks after eviction or deployment. This requires an upstream initialization hook or a maintained dependency patch, not edits inside node_modules.

Also benchmark a short `RcRef` idle lifetime, such as 250 ms to 1 second, to share hosts across request bursts. A timer and retained host services can delay hibernation, so compare saved SQL/CPU against added duration. Do not retain the full host indefinitely just to save startup reads. Test async prompts, permission waits, cancellation, and shared-device reconnects.

### 2. Batch acknowledgements while preserving flow control

[transport.ts](../packages/client/src/transport.ts) sends one ACK per consumed chunk. Ordinary responses use stop-and-wait on the server. Subscriptions have a 64-chunk credit window but still replenish it one frame at a time.

Introduce a versioned credit protocol that acknowledges a count or sequence range. Start with subscription ACKs, replenishing after a small threshold or bounded client-side delay. Then give ordinary responses a bounded window. Both ends must change together; simply dropping ACKs would stall requests or exhaust subscription credit. Keep byte limits, cancellation, and slow-client handling.

For example, acknowledging eight consumed chunks in one frame would reduce the ACK component by about 87.5% during sustained streaming. Total requests would fall by less. Flush partial batches so quiet streams do not stall. This reduces message handling and wakeups, not SQL event persistence.

### 3. Treat durable event writes as a separate budget

The installed `@opencode-ai/server/dist/workerd.js` enables event persistence. Upstream `Bus.commitDurableEvent` reads sequence state, checks event identity, runs projectors, upserts `event_sequence`, and inserts `event`. Projectors also read and update session/message rows. A single lifecycle event therefore causes several storage operations. The event table has two secondary indexes.

Text and reasoning deltas are already ephemeral in `@opencode-ai/schema/dist/session-event.js`; the runner batches them at 100 ms. Their start/end boundaries are durable. There is no evidence here of writing every token to SQL. Tool progress and other durable lifecycle events can still multiply writes during a small session.

Count durable events by type and SQL rows by statement before changing persistence. If tool-progress events dominate, coalesce replaceable progress updates while preserving final output, failures, permissions, and replay order. Consider skipping proven no-op projection updates. Batching identical writes into one transaction alone does not reduce the number of rows written.

Do not disable event persistence without replacing log replay and recovery. The existing proxy resumes durable logs using sequence cursors. The main replay query already has an aggregate/sequence index; adding indexes indiscriminately can increase writes. Cloudflare counts index updates as additional written rows. See [SQLite storage accounting](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

### 4. Separate plugin metadata from source and bundles

[plugin store](../packages/server/src/plugin-manager/store.ts) reconstructs every plugin from chunked JSON during `list`. The [TUI manifest route](../packages/server/src/tui-registry.ts) then filters those records and hashes their bundles. A save rewrites all serialized chunks, even for a metadata change.

Store a small manifest record with enabled status, bundle hashes, and blob references. Read bundles only when loading that plugin or serving its artifact. Use content hashes to avoid rewriting unchanged blobs and cache manifest responses until a plugin changes. Keep artifact authorization and approval checks. This mainly helps sessions with installed/generated plugins; it cannot explain all SQL usage in an empty registry.

KV-style DO `get`, `put`, and `list` also use the hidden SQLite table and contribute to SQL row usage. Moving the same data from SQL to DO KV would not remove that accounting. See [storage pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### 5. Stop reconnects from becoming repeated startup work

The client retries the connection every second indefinitely. A persistent authentication error or unsupported protocol can generate repeated upgrades. Reconnects also resubscribe and refresh plugin manifests, and shared-device changes trigger MCP reloads.

Use capped exponential backoff with jitter for transient failures. Surface authentication/protocol failures as actionable errors instead of retrying forever. Reset backoff after a stable connection and keep the existing rule against replaying in-flight mutations. Measure upgrades and reloads during an outage and reconnect test.

### 6. Preserve the existing hibernation improvements

The proxy already uses `acceptWebSocket`, automatic heartbeat replies, attachment-backed subscriptions, and local SSE heartbeat comments. Subscription ACKs do not acquire the OpenCode host. Direct remote HTTP SSE clients can still retain the host for the lifetime of the stream. Prefer `ocx` for idle attachments and verify idle duration on Cloudflare. See [architecture](architecture.md) and [DO duration accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/).

All clients currently share the DO named `default`, and global OpenCode events broadcast to matching channel subscribers. With more clients, irrelevant events also produce extra ACKs. Add explicit workspace/session subscription filters when scaling remote workspaces. Test which global events clients still need before narrowing delivery.

## Measurement plan before implementation

1. Record deployed commit and separate Worker requests, DO incoming messages, SQL reads/writes, and DO duration over the same interval.
2. Add opt-in counters for upgrades, frame types, route templates, host acquisitions, durable event types, and reconnects. Aggregate in memory and emit sampled summaries; do not persist a metric row per event or log credentials, prompts, bodies, or bound SQL parameters.
3. Instrument the upstream SQL adapter at `native.sql.exec`. Read `cursor.rowsRead` and `cursor.rowsWritten` after consuming the cursor and group by normalized statement. The current adapter discards these counters. Instrument KV calls separately. See [SQL cursor counters](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
4. Compare idle attachment, session open, one short no-tool prompt, one tool call, plugin edit, and forced reconnect. Repeat with existing history and multiple clients. Separate first-ever schema creation from normal startup.
5. Prioritize measured startup reads and ACK traffic. Optimize durable writes only after identifying dominant event/projector statements. For large histories, inspect query plans and verify cursor-based replay before considering retention or snapshots; deleting history requires a recovery design.

The merge passed `bun install --frozen-lockfile`, `bun run typecheck`, and `bun run build`, which uses Wrangler dry-run. These checks do not validate production billing or actual eviction. No deployment was performed. The follow-up transport change is described above; this audit itself adds no runtime instrumentation.
