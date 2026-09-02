# Distributed plugin and public app platform plan

## Status

Deferred architecture. There is other prerequisite work to finish before implementing this.

This document records the intended direction in enough detail to resume without reconstructing the design from chat history. The existing plugin manager remains the starting point. It already lets a hidden plugin-author edit a normal virtual project, bundles external npm dependencies, executes server plugins in QuickJS, stores TUI artifacts, and hot-adds tools to OpenCode.

The next large step is to let one logical plugin run in several places at once:

- the owner's OpenCode server
- a public Cloudflare application host
- a browser opened from a share link
- one or more local OpenCode TUI clients

The motivating request is:

> Make me a global coordinated chat, then give me a link I can send to a friend.

The agent should be able to author that application, create a live room, expose direct OpenCode tools, and supply both a browser UI and a native TUI UI.

## Main conclusion

The useful product is not merely a distributed code registry. It is a distributed plugin runtime with public application hosting and client synchronization.

A registry answers where code comes from. It does not run the code, coordinate shared state, authenticate visitors, or install local TUI code. The full system needs all of those pieces.

The implementation should begin with the public host and a single coordinated application. Registry federation can follow once the execution model works.

## Terms

### Plugin definition

The source project written by the plugin-author. A definition can target several runtimes.

### Artifact

An immutable bundle produced from a plugin definition for one runtime. Artifacts use SHA-256 content digests. Users do not need to manage semantic versions, but the runtime still needs immutable identities for caches, signatures, updates, and rollback.

### Plugin instance

A running application created from a plugin artifact. A chat plugin is a definition. A particular room is an instance.

### Registry node

An OpenCode server that publishes plugin manifests and content-addressed artifacts. A central discovery index may exist later, but a node must remain usable without it.

### Room home

The server and Durable Object instance that authoritatively own a shared room. Registry distribution does not imply multi-master application state.

## One logical plugin, several runtimes

The plugin remains one normal project in the author agent's virtual filesystem:

```text
server.ts        OpenCode tools and server hooks
worker.ts        Cloudflare Worker and Durable Object code
web.tsx          browser interface for public links
tui.tsx          native OpenCode TUI interface
package.json     shared npm dependencies
src/             relative modules
public/          optional static assets
```

Only the relevant files are required. A server-only plugin may contain just `server.ts`. A public app might have `server.ts`, `worker.ts`, and `web.tsx`. A full native experience can add `tui.tsx`.

The agent writes ordinary source files. It does not write a generated manifest, encoded file map, publication record, or custom deployment payload. The plugin manager detects entrypoints, builds the targets, computes digests, and writes all internal metadata.

Names remain exactly as the author writes them. Do not add `generated_` or `tui_` prefixes.

| Runtime | Source | Purpose |
| --- | --- | --- |
| OpenCode server | `server.ts` | Direct tools such as `create_chat`, server hooks, and controlled host operations |
| Cloudflare host | `worker.ts` | Public request handling and a generated Durable Object facet class |
| Browser | `web.tsx` | UI loaded from a share link without requiring OpenCode |
| OpenCode client | `tui.tsx` | Native terminal UI installed by the local launcher |

## Overall architecture

```text
OpenCode agent
    |
    | create_plugin("make a coordinated chat")
    v
Hidden plugin-author
    |
    | writes ordinary project files
    v
Plugin manager
    |
    +-- activates server.ts as direct OpenCode tools
    |
    +-- stores worker.ts as Dynamic Worker modules
    |
    +-- stores web.tsx as public browser assets
    |
    +-- adds tui.tsx to the client artifact registry
    |
    +-- records content digests and requested capabilities
              |
              v
        Public gateway Worker
              |
              | /join/<invite>
              v
        PluginHostDO supervisor
              |
              | ctx.facets.get("app", ...)
              v
        agent-written DO facet
        messages, members, presence, application state
```

The browser client and local TUI client talk to the same room home. The browser receives its code from the public gateway. The TUI client receives its code through the local launcher and registry synchronization.

## Authoring flow

The main agent continues to use the four plugin manager tools:

- `create_plugin`
- `edit_plugin`
- `list_plugins`
- `plugin_deactivate`

There is no explicit publish operation. The manager performs validation, bundling, storage, and activation after the hidden author finishes.

For the chat request, the flow should be:

1. The main agent calls `create_plugin` with the user's request.
2. The hidden author researches current OpenCode and Cloudflare APIs.
3. It writes `server.ts`, `worker.ts`, `web.tsx`, and `tui.tsx` as needed.
4. The manager builds every detected target.
5. The manager activates the tools from `server.ts` immediately.
6. The manager makes the Cloudflare and browser artifacts available to the public host.
7. The manager exposes the TUI artifact through the client registry.
8. A newly added direct tool such as `create_chat` becomes visible to the main agent.
9. The main agent calls `create_chat`.
10. The tool creates a plugin instance and returns browser and launcher links.

Example output:

```text
Chat created.

Browser:
https://apps.example.com/join/abc123

OpenCode:
ocx join https://apps.example.com/join/abc123
```

The main agent calls `create_chat` directly. It does not call the plugin manager as a proxy. The generated server plugin can route through trusted host capabilities internally.

## Public hosting

### Fixed gateway Worker

A statically deployed gateway Worker accepts all public app traffic. Generated code never owns the deployment token or public route configuration.

Suggested routes:

```text
GET  /join/:invite
GET  /apps/:instance/*
GET  /registry/.well-known/opencode-plugins.json
GET  /registry/plugins/:publisher/:id/manifest.json
GET  /registry/blobs/:digest
POST /api/instances/:instance/invites
POST /api/instances/:instance/revoke
```

The exact route names can change. The important boundary is that the fixed gateway handles routing, invitation checks, rate limits, request-size limits, trusted headers, and response policy before generated code runs.

### PluginHostDO supervisor

Add a statically deployed `PluginHostDO` class. Create one supervisor object per application instance:

```text
PluginHostDO ID = owner/plugin/instance
facet name      = app
```

Using a separate host class is preferable to running public application traffic through the existing OpenCode DO. It keeps public load, failures, and application storage away from the private OpenCode session server.

The supervisor owns trusted control data:

- plugin and artifact digest
- instance owner
- active or disabled state
- invite hashes and membership
- capability grants
- resource policy
- update and rollback state
- audit events

The generated facet owns application data:

- messages
- members and presence
- application-specific SQLite tables
- Durable Object alarms if supported by the selected facet API
- live connections if the facet supports the required WebSocket APIs

Cloudflare Durable Object Facets are designed for dynamically generated Durable Object classes. The supervisor loads a class through the Worker Loader API. Each facet receives a separate SQLite database and cannot read the supervisor's database.

### Dynamic code loading

The plugin manager should compile `worker.ts` and its dependencies into modules accepted by the Worker Loader API. Use a stable loader ID derived from the artifact digest:

```text
dynamic worker ID = sha256(worker modules + build settings)
```

The supervisor loads the generated class and starts the facet:

```ts
const worker = env.LOADER.get(artifactDigest, async () => ({
  compatibilityDate,
  mainModule,
  modules,
  globalOutbound: null,
  limits: {
    cpuMs: 20,
    subRequests: 10,
  },
}))

const appClass = worker.getDurableObjectClass("App")
const facet = this.ctx.facets.get("app", () => ({ class: appClass }))
return facet.fetch(request)
```

The exact limits will need measurement. They should be owner policy, not values selected by generated code.

### Code updates

An edit creates a new artifact digest. Existing instances remain pinned until upgraded.

To upgrade an instance:

1. Validate the new artifact.
2. Record the intended new digest in supervisor storage.
3. Abort the running facet.
4. Restart it with the new generated class.
5. Preserve the facet database.
6. Mark the update successful only after a health request passes.
7. Roll back to the previous digest if startup fails.

Cloudflare's facet `abort` operation preserves the facet database and allows a restart with another class. Its `delete` operation permanently removes the facet database. Deactivation must not call `delete` unless the user explicitly requests data removal.

No OpenCode DO restart or Worker redeployment should be required for a plugin code update.

## Public links and invitations

A share URL should contain a random invitation capability rather than a plugin ID, DO name, owner ID, or registry credential:

```text
https://apps.example.com/join/f9K2sV...
```

Recommended first-visit flow:

1. Hash the presented invite and look it up in trusted supervisor or gateway storage.
2. Check expiry, revocation, intended instance, role, and use count.
3. Issue a short-lived `HttpOnly`, `Secure`, `SameSite` session cookie.
4. Redirect to a clean application URL that no longer contains the secret.
5. Set a restrictive `Referrer-Policy` so invite URLs do not leak.

The owner should be able to create, expire, and revoke invites. An invite may grant a role such as viewer, participant, or moderator.

Generated code may receive the authenticated participant identity and role. It must not receive the original invite secret, OpenCode credentials, Cloudflare API tokens, or registry signing keys.

## Browser client

The browser path makes a share link useful to someone who does not run OpenCode.

The gateway serves the built `web.tsx` artifact and any approved static assets. The browser client connects to the instance's HTTP or WebSocket endpoint using the session established from the invite.

This path needs no OpenCode plugin installation:

```text
friend clicks link
    -> gateway validates invite
    -> gateway serves generated web client
    -> web client connects to room home
```

The web build must use a controlled runtime and content security policy. Avoid arbitrary external script tags. Bundle third-party dependencies or serve them from a controlled, digest-pinned location.

## Native OpenCode client synchronization

The browser path is not enough if participants should use the application inside OpenCode. A plain OpenCode client cannot load arbitrary TUI code from the server. The local launcher remains necessary unless OpenCode gains a supported remote-plugin mechanism.

Suggested command:

```text
ocx join https://apps.example.com/join/abc123
```

The launcher should:

1. Resolve the invite to a public instance descriptor.
2. Identify the publisher by origin and signing key.
3. Fetch the plugin manifest.
4. Download the matching TUI artifact.
5. Verify its content digest and publisher signature.
6. Check OpenCode and TUI API compatibility.
7. Show the local permissions and allowed network origins.
8. Ask for approval before the first installation or any permission expansion.
9. Store the artifact in an immutable local cache.
10. Store a scoped instance credential outside the plugin source.
11. Generate an OpenCode configuration that loads the selected artifact.
12. Launch OpenCode with that generated configuration.

The TUI plugin connects directly to the room home's public gateway. It cannot assume `ctx.client` points to the owner. The participant may be connected to a different OpenCode server or to no remote server at all.

The plugin should receive the instance URL and a short-lived scoped credential through launcher-managed runtime configuration. Do not embed invite tokens or long-lived credentials in downloaded JavaScript.

The TUI manifest must declare allowed server origins. The launcher should require approval when a plugin adds a new origin.

Updates initially take effect on the next launcher run. Native TUI hot reload can be investigated later. Server and facet updates should remain independent from local TUI update timing.

## Registry design

### One manifest for every runtime

The manager generates a manifest after building the project:

```json
{
  "publisher": "server-public-key",
  "id": "global-chat",
  "digest": "sha256:plugin-definition-digest",
  "artifacts": {
    "server": {
      "entrypoint": "server.ts",
      "digest": "sha256:server-artifact"
    },
    "cloudflare": {
      "entrypoint": "worker.ts",
      "durableObjectClass": "App",
      "digest": "sha256:worker-artifact"
    },
    "web": {
      "entrypoint": "web.tsx",
      "digest": "sha256:web-artifact"
    },
    "tui": {
      "entrypoint": "tui.tsx",
      "digest": "sha256:tui-artifact"
    }
  },
  "capabilities": {
    "public": true,
    "durableStorage": true,
    "outboundOrigins": [],
    "tuiOrigins": [
      "https://apps.example.com"
    ]
  }
}
```

The author agent never constructs this JSON. It may write ordinary application metadata if a framework requires it, but the trusted manager creates the registry record.

### Plugin identity

Use this identity tuple:

```text
publisher key + plugin ID + content digest
```

This prevents unrelated publishers from colliding on names such as `global-chat`.

### Federation

Every OpenCode server can publish a small registry endpoint:

```text
GET /.well-known/opencode-plugin-registry
GET /plugins/<id>/manifest.json
GET /blobs/<sha256>
```

Cross-server installation should:

1. Fetch a manifest from a named origin.
2. Pin the origin's publisher key according to the trust policy.
3. Fetch content-addressed artifacts.
4. Verify hashes and signatures.
5. Run local validation rather than trusting the publisher's validation result.
6. Store and activate the plugin under the publisher-qualified identity.

A central service may index public manifests for search. It should not be required to run already installed plugins. Artifacts can remain at publisher nodes or be mirrored by digest.

### Registry distribution is not state replication

A shared chat room has one authoritative room home. Browsers, TUI clients, and remote OpenCode servers connect to it.

Do not start with multi-master Durable Object state or registry-driven chat replication. That adds conflict resolution without helping the link-sharing use case. Federation should distribute definitions and establish connections. The room's writable state remains in one strongly consistent Durable Object.

## Instance descriptors

The registry stores reusable definitions. Share links resolve to instances:

```json
{
  "instance": "room_8f19",
  "plugin": {
    "publisher": "server-public-key",
    "id": "global-chat",
    "digest": "sha256:plugin-definition-digest"
  },
  "home": "https://apps.example.com",
  "browserUrl": "https://apps.example.com/apps/room_8f19/",
  "tui": {
    "artifact": "sha256:tui-artifact",
    "minimumOpenCode": "2.0.0-beta.18371"
  }
}
```

The invite response may include this descriptor after authentication. Public descriptors must not expose internal DO IDs, control-plane keys, or owner credentials.

## Server plugin host API

Generated `server.ts` plugins need a narrow way to create and manage public instances. Extend the QuickJS context bridge with a host-owned API. A tentative shape is:

```ts
interface PublicAppsContext {
  create(input: {
    plugin?: string
    access: "invite" | "private" | "public"
    title?: string
    metadata?: Record<string, string>
  }): Promise<{
    instanceID: string
    browserURL: string
    joinURL: string
  }>

  invite(input: {
    instanceID: string
    role?: string
    expiresAt?: number
    maxUses?: number
  }): Promise<{ joinURL: string }>

  revoke(input: {
    instanceID: string
    inviteID?: string
  }): Promise<void>

  describe(instanceID: string): Promise<unknown>
}
```

Possible context name:

```ts
ctx.public
```

The name can change if it conflicts with OpenCode. The important rule is that this is a trusted bridge implemented by the platform. Generated code never receives Cloudflare management credentials.

A generated plugin can then add a direct tool:

```ts
tools.add({
  name: "create_chat",
  description: "Create a shared chat room and return invitation links",
  input: {
    type: "object",
    properties: {
      title: { type: "string" }
    },
    additionalProperties: false
  },
  options: { codemode: false },
  async execute(input) {
    const instance = await ctx.public.create({
      access: "invite",
      title: input.title
    })
    return { content: instance.joinURL }
  }
})
```

OpenCode sees `create_chat` beside other tools. The manager remains invisible during normal use.

## Capabilities and security

The existing system was designed for one trusted user. A public app host changes the risk model because strangers can send requests to generated code.

Required boundaries:

- Generated code never receives a Cloudflare API token.
- Generated code cannot deploy, delete, or reconfigure Workers directly.
- Generated code cannot read the OpenCode server's storage.
- Facet storage is separate from supervisor storage.
- Public requests pass through a trusted gateway.
- Internal headers supplied by visitors are removed and replaced.
- Outbound network access starts disabled.
- Approved outbound access uses host-controlled bindings or an outbound proxy.
- CPU time, subrequests, request bodies, response bodies, and concurrent connections have limits.
- Invite tokens are random, hashed at rest, scoped, expiring, and revocable.
- TUI permissions are shown before installation.
- A changed TUI digest requires approval unless the user enabled automatic updates for that publisher and permission set.
- Permission expansion always requires approval.
- Artifacts are immutable after publication.
- Running instances remain pinned to a digest until an explicit upgrade.
- Logs identify publisher, plugin, artifact digest, instance, and request without recording secrets.

The Dynamic Worker loader can block global outbound access, pass only selected custom bindings, and enforce CPU and subrequest limits. Custom bindings should expose operations, not raw underlying resources.

## WebSockets and real-time applications

Durable Objects are a natural coordinator for chat rooms. The generated class can own membership, message ordering, and fan-out.

The implementation must verify which WebSocket APIs, including hibernation, work inside Durable Object facets before promising them to plugin authors. If facet hibernation is unavailable or incomplete, options include:

- keep WebSocket acceptance in the trusted supervisor and call the facet over RPC
- use regular request polling for the first proof of concept
- use Server-Sent Events if supported by the chosen path
- keep generated message logic in the facet while trusted host code manages connections

Do this as an early technical spike. It affects the worker authoring contract.

## Dynamic Workers versus Workers for Platforms

### Start with Dynamic Workers and facets

This matches a federated personal-server model:

- code is generated at runtime
- one deployed host can load many plugin artifacts
- the host selects bindings and outbound policy
- facets provide isolated persistent SQLite storage
- code updates do not require a normal Worker deployment
- the current runtime bundler already covers part of the build path

Dynamic Workers currently require a Workers Paid plan. Stable loader IDs should be used instead of one-off `load()` calls to avoid needless cold starts and creation charges.

### Consider Workers for Platforms later

Workers for Platforms is a better fit if this becomes a centrally operated service that hosts applications for many unrelated customers. It adds dispatch namespaces, user Worker isolation, hostname routing, customer limits, and programmatic deployments.

Do not begin by granting the plugin manager a broad Cloudflare API token and deploying one normal Worker per plugin. That makes credentials, migrations, cleanup, and routing part of the first implementation. Dynamic Workers and facets keep those controls inside one deployed host.

## Storage sketch

### Plugin registry record

```ts
interface PublishedPlugin {
  publisher: string
  id: string
  definitionDigest: string
  artifacts: Partial<Record<"server" | "cloudflare" | "web" | "tui", {
    digest: string
    contentType: string
    size: number
  }>>
  capabilities: PluginCapabilities
  signature: string
  createdAt: number
}
```

### Supervisor instance record

```ts
interface HostedInstance {
  id: string
  owner: string
  publisher: string
  pluginID: string
  artifactDigest: string
  previousArtifactDigest?: string
  status: "starting" | "active" | "disabled" | "failed"
  title?: string
  capabilities: GrantedCapabilities
  createdAt: number
  updatedAt: number
}
```

### Invite record

```ts
interface InstanceInvite {
  id: string
  tokenHash: string
  role: string
  expiresAt?: number
  maxUses?: number
  uses: number
  revokedAt?: number
}
```

Store large immutable artifacts separately from hot supervisor metadata. R2 is a likely future artifact store, but the first single-user implementation can continue using chunked Durable Object storage if sizes remain manageable.

## Implementation order

This work is intentionally deferred. When prerequisites are ready, use the following sequence.

### Phase 1: public host spike

- Add a Worker Loader binding.
- Add a statically deployed `PluginHostDO` class and migration.
- Manually load one known Dynamic Worker module.
- Run one generated Durable Object facet.
- Forward HTTP requests through a fixed public gateway route.
- Verify facet storage isolation, restart behavior, `abort`, and `delete` semantics.
- Verify the real-time connection APIs required for chat.

### Phase 2: plugin build target

- Teach the hidden author about `worker.ts`.
- Extend the runtime bundler to emit Worker Loader modules rather than only a single QuickJS string.
- Detect and validate the generated Durable Object export.
- Compute an immutable artifact digest.
- Store the modules and requested capabilities.
- Keep `server.ts` and `tui.tsx` behavior unchanged.

### Phase 3: hosted instances

- Add instance creation, disable, upgrade, rollback, and delete operations.
- Add the trusted `ctx.public` bridge.
- Add invitation issuance and revocation.
- Return usable browser links.
- Keep public traffic separate from the OpenCode DO.

### Phase 4: generated browser clients

- Add `web.tsx` compilation.
- Serve digest-pinned web assets.
- Add content security policy and asset limits.
- Pass only an instance endpoint and short-lived session to browser code.

### Phase 5: chat reference plugin

- Have the author create a chat plugin using the normal VFS tools.
- Register direct tools such as `create_chat` and `invite_chat_user`.
- Create room instances.
- Support message ordering, history, presence, and reconnects.
- Test browser-to-browser collaboration before adding registry federation.

### Phase 6: TUI client sync

- Implement the `ocx` launcher described in `docs/tui-plugin-shim-plan.md`.
- Add `ocx join <url>`.
- Fetch and verify the TUI artifact and instance descriptor.
- Manage per-publisher trust and per-plugin permission approvals.
- Supply scoped runtime configuration without embedding credentials in code.
- Launch OpenCode with a generated configuration.

### Phase 7: registry federation

- Add publisher signing keys.
- Add well-known registry and content-addressed blob endpoints.
- Add remote installation by manifest URL.
- Qualify IDs by publisher.
- Add optional discovery indexes and mirrors.
- Keep already installed applications independent from the discovery service.

### Phase 8: scale and central hosting

- Measure Dynamic Worker counts, CPU, requests, and facet concurrency.
- Add quotas, abuse controls, and observability.
- Evaluate Workers for Platforms if a central service begins hosting many unrelated users.
- Add custom hostnames only after path-based routing is stable.

## Prerequisites before this work

The near-term project work should establish:

- reliable server plugin creation and editing
- stable external package bundling
- a complete enough QuickJS context bridge for direct tools
- durable draft handling for interrupted author sessions if needed
- a clear deployment and authentication story for the current OpenCode server
- the first version of the local TUI launcher contract

The public app platform should not be mixed into those tasks until the existing plugin manager is reliable.

## Open questions

- Should `worker.ts` export only one conventional class named `App`, or may plugins declare several facet classes?
- Does the full Durable Object Hibernation WebSocket API work inside a dynamically loaded facet?
- Should the generated browser Worker run as a separate Dynamic Worker before calling the facet, or should the facet's `fetch` method own the whole public application in the first version?
- How should a generated plugin declare capabilities without making the author write a custom manifest?
- Should the trusted manager infer capabilities from imports and API use, or should the author write ordinary configuration such as `wrangler.jsonc` that the manager sanitizes?
- How does `ocx` pass instance configuration to a TUI plugin using stable OpenCode APIs?
- Can a TUI plugin safely open arbitrary WebSockets, and how should the launcher enforce declared origins?
- Which authentication mechanism should a native TUI use after an invite is exchanged?
- Should plugin instances upgrade automatically when only server tools change but public or TUI artifacts do not?
- Where should immutable artifacts live before R2 is introduced?
- How should registry publishers rotate signing keys without breaking previously trusted artifacts?
- How should a remote OpenCode agent join a room as an agent identity rather than as a browser participant?

## Cloudflare references

- [Dynamic Workers overview](https://developers.cloudflare.com/dynamic-workers/)
- [Dynamic Workers getting started and Worker Loader](https://developers.cloudflare.com/dynamic-workers/getting-started/)
- [Dynamic Workers API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)
- [Dynamic Worker custom bindings and capability isolation](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)
- [Dynamic Worker custom resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)
- [Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
- [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
- [Workers for Platforms dynamic dispatch](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/)
- [Workers for Platforms bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)

## Related local document

See `docs/tui-plugin-shim-plan.md` for the earlier client launcher, trust, caching, and TUI installation plan. The launcher is part of this architecture rather than an optional UI enhancement. Public browser clients and local TUI clients are separate delivery paths for the same hosted plugin instance.
