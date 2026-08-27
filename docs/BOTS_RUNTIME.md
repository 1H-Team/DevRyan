# Production Bots runtime

Production Bots is a Docker-backed, Supabase-controlled governed-computer
runtime. The macOS Electron app is its primary client; after background Bots are
enabled, the same signed Electron executable also runs as a windowless
launchd-managed runtime service. This document is the operator runbook and
security-boundary reference. The package-level documents linked throughout
remain the authority for implementation details.

## Current simplified product contract

The user-facing model is documented in
`docs/BOTS_SIMPLIFICATION_2026-08-27.md`. A Bot is created with capability-first
defaults and new configurations always run through OpenCode. Bot Settings has
Overview, Resources, Memory, Members, Routines, and Lifecycle. Resources owns
the persistent computer files, optional on-demand Skills/SOPs, protected
provider credentials, and concise environment secrets. There is no user-facing
MCP, AG-UI, policy/access matrix, Library/source workflow, revision/bundle,
recovery, or advanced-instruction configuration.

Some sections below document retained persistence and adapters. Those paths are
compatibility/security machinery only: immutable revisions still pin admitted
runs; old AG-UI deployments remain readable/executable during migration; old
MCP records remain readable/detachable for cleanup but cannot be newly attached
or executed; retirement and recovery formats remain for safe purge/migration.
They do not define the current product information architecture.

## Availability and prerequisites

Bots can run only when `GET /api/bots/capabilities` reports `healthy`. The
following prerequisites must all be true:

1. DevRyan is installed as the local macOS Electron app. A migrated deployment
   may be owned by its registered background runtime while the UI is closed;
   Docker mutations remain inside the signed local runtime boundary. VS Code
   shows an explicit unsupported-host message, and the legacy Tauri shell does
   not own this feature.
2. Supabase multi-user mode is configured and every repository migration,
   through `supabase/migrations/20260827100000_agent_agnostic_bots_program.sql`,
   is deployed. A schema-cache miss returns `migration_required` with
   `requiredMigration: "20260827100000"`; it must never fall back to local
   plaintext state. The required marker is a minimum: newer 14-digit markers
   are accepted, and Bot migrations remain backward-compatible for at least one
   desktop release so database-first rollout does not disable older clients.
3. Electron `safeStorage` is available so the deployment encryption key can be
   OS-sealed.
4. Docker Desktop is installed and the Docker Engine is running.
5. The packaged app contains a signed, architecture-complete Bot image manifest
   and the selected image digests are available. Development builds use only
   `packages/electron/resources/bot-runtime/images.dev.json`.
6. The Bot has an Active internal configuration whose OpenCode model,
   credential, default public-internet/computer boundary, and optional Skill
   packages pass activation. Live runtime availability and scoped credentials
   are checked after an accepted run is claimed. The local retrieval index must
   be ready.

The capability states are deliberately distinct:
`supabase_unavailable`, `migration_required`, `unsupported_host`,
`encryption_unavailable`, `docker_not_installed`, `docker_stopped`,
`setup_required`, `image_update_available`, `index_rebuilding`,
`runtime_degraded`, `desktop_host_unavailable`, and `healthy`. The UI enables
new sends only while the required capabilities are healthy;
the server still durably preserves an authorized request if runtime health
changes between the last capability check and admission, then exposes any safe
startup failure on that run.

## Trust boundaries

| Boundary | Authority and data | Deliberate limit |
| --- | --- | --- |
| Electron runtime owner | The foreground app or fenced launchd service owns the OS-sealed key, signed image manifest, Docker executable, fixed Compose project, setup/repair/update/rollback, and exact runtime paths. | Renderer and HTTP callers cannot choose Docker arguments, images, mounts, networks, containers, or volume names. Exactly one generation owns a data directory. |
| Web/runtime service | Owns authenticated policy, Supabase access, encryption/decryption, private gateway capabilities, adapter-neutral run dispatch, recovery, routines, memory, computer supervision, and purge. | It receives only fixed typed Docker callbacks and never receives the Docker socket. Plaintext is transient. |
| Supabase | Stores the control plane, immutable encrypted records, and ciphertext in the private `devryan-bot-objects` bucket. Database functions enforce atomic claims and cross-row invariants. | Storage receives no plaintext object bytes or unwrapped object keys. Public projections omit envelopes, object names, host paths, and execution segment IDs. |
| Bot engine proxy | Is the only container that mounts `/var/run/docker.sock`; it validates the supervisor's eleven version-normalized Engine operations, request bodies, owned labels, image digests, networks, volumes, query parameters, and response bounds. | The socket remains root-equivalent, but supervisor compromise no longer directly grants it. Unknown API versions, upgrades, encoded paths, arbitrary exec/create options, and unowned resources fail closed. |
| Bot supervisor | Translates eleven authenticated domain verbs into calls to the engine proxy and carries scoped OpenCode traffic through a revocable in-memory capability. | It has no Docker socket and cannot widen the engine-proxy schema, images, resources, or ownership scope. An unavailable engine proxy disables lifecycle mutation. |
| Reasoning adapter | New configurations select immutable OpenCode reasoning. The dispatcher consumes one ordered normalized event contract and persists a generic execution handle. | An adapter can reason but cannot act. Every tool intent must traverse the local gateway; adapter switching after run admission is forbidden. The AG-UI adapter is retained only for already-deployed compatibility. |
| Reasoning container or legacy AG-UI endpoint | OpenCode receives only scoped container mounts and run context. A retained legacy AG-UI deployment receives bounded conversation/tool context over its already-pinned endpoint. | Neither receives gateway authority, stored credentials, computer tokens, or local callback URLs. New AG-UI activation is rejected. |
| Bot-egress proxy | Uses purpose-separated model, agent-endpoint, and browser capabilities. It revalidates the active revision, exact policy, DNS answers, and reserved-address rules before opening an upstream socket. | It rejects loopback, LAN, RFC1918/ULA, link-local, metadata, multicast, wildcard, redirects, and rebinding destinations. Only the proxy joins the public-NAT network. |
| Computer container | Owns a persistent Chromium login profile and scoped scratch space, exposes only reviewed browser commands, and stages files through the private gateway. Chromium uses an authenticated explicit proxy with QUIC and implicit loopback bypass disabled. | It has no shell, evaluate, script, raw CDP, host-path, Docker, generic proxy endpoint, or direct public interface. Browser networking defaults to public-only and may be narrowed to an exact host/port allowlist. |
| Local indexer | Holds a disposable SQLite FTS/vector plaintext projection and pinned offline embedding model. | It has no outbound NAT, accepts exact namespaces only, and is never the source of truth. Reasoning containers do not receive its bearer token. |
| Shared UI | Receives principal-scoped snapshots/events, encrypted-object download routes, generic run IDs, low-frequency computer metadata, and an ephemeral MJPEG screencast. | Keys, credentials, cookies, Docker details, adapter-specific execution IDs, and unauthorized Bot/channel identifiers never enter browser state. Screencast frames are not retained. |

The production connector registry contains only the host-owned
`connector:workspace` and explicit `connector:shared` adapters. Bot MCP is not
registered for execution; legacy MCP records exist only for read/detach/purge
compatibility.
The persistent browser remains inside the already-authorized `devryan_bot`
gateway as `computer.command`. Its tool description and a per-turn runtime
instruction expose the exact browser contract without changing immutable Bot
revision permissions. Raw browser/CDP tools remain denied, and subagents do not
receive the gateway.
The workspace adapter is narrower still: it accepts one safe top-level file,
requires the revision's write capability and policy decision, and delegates to
Electron's fixed supervisor archive write without exposing host paths or Docker
identity.
The Shared adapter accepts only a bounded explicit file payload for the current
run/channel. It cannot scan a computer or accept a host/container path.

`devryan_bot image.generate` is a separate reviewed operation in
`devryan-bot-tools@1.2.0`. The server exposes it only when the admitted model is
OpenAI with a resolved ChatGPT OAuth credential; API keys and all other
providers fail with `bot_image_generation_unavailable`. It delegates to the
pinned `opencode-gpt-imagegen@0.1.10` inside the `1.1.8` runtime image and uses
the existing scoped `auth.json`. Egress remains limited to
`auth.openai.com:443` and `chatgpt.com:443`.

## Reasoning adapters and durable execution

Revision contract v3 adds a discriminated reasoning binding. `opencode` keeps
the existing model list and is the effective default for every legacy revision;
`ag_ui` pins an exact Bot-scoped connection reference plus a secret-free
descriptor digest and optional model hint. A run snapshots that binding at
admission and never changes adapter afterward.

`run-dispatcher.js` knows only the `BotReasoningAdapter` lifecycle: health,
revision preparation, start/continue/inspect, cancel/close, structured
completion, and optional warm leases. Adapters emit normalized ordered start,
text, governed-tool-intent, artifact, checkpoint, usage, completion, and error
events. OpenCode session/segment interpretation stays in the OpenCode adapter;
AG-UI protocol interpretation stays in the AG-UI adapter.

Durable runs project both adapters into `agent_adapter`, `agent_thread_id`, and
bounded `agent_execution` state. Existing OpenCode columns remain during the
compatibility window and are backfilled into that generic projection without
rewriting active revision JSON or hashes. Once an execution handle or governed
action exists, ambiguous replay is forbidden. If an adapter cannot inspect or
resume an interrupted run, retry creates a new run rather than inferring
completion.

Bot Managers may register an exact public HTTPS/SSE AG-UI endpoint with `none`
or encrypted bearer authentication. The descriptor digest covers connection
semantics and limits but never secret material. The implementation pins
`@ag-ui/core@0.0.58` and accepts only its reviewed lifecycle, text, reasoning,
tool-call, and error subset. Every completed `devryan_bot` call is validated and
executed locally; its result returns on a later AG-UI invocation as a tool
message. Memory consolidation and routine drafting use the selected adapter as
well, so AG-UI Bots have no hidden OpenCode dependency.

## Signed Bot specifications

Published revisions export as deterministic
`DevRyan-Bot-<slug>-r<revision>.devryan-bot.json` documents with API version
`devryan.ai/bot-revision/v1`. The portable specification includes identity,
soul, instructions, reasoning binding, egress, tools, structured policy,
browser/computer policy, memory, and content-addressed Skill/MCP/Library
bindings. It contains no secret, credential UUID, local object ID, host path, or
encrypted envelope.

The strict parser bounds bytes/depth/collections, rejects duplicate keys and
unknown fields, and canonicalizes keys before hashing and Ed25519 signing. The
integrity block binds the portable spec hash, source compiled hash, compiler
version, signer key ID/public key, and signature. Global Administrators can
trust signers globally; Managers can trust them only for their Bot. Unknown
valid signers require explicit acknowledgement, while invalid or revoked
signatures are rejected.

Import always produces a new draft and an immutable local binding-resolution
set. Managers must map local credentials, agent connections, Skills, MCP
servers, and Library versions; unresolved or digest-mismatched bindings remain
publication failures and nothing is installed automatically. The ordinary
optimistic save, activation-health, and publish path is the only route to
activation. Same-environment promotion reproduces the compiled hash;
cross-environment promotion must reproduce the portable spec hash and makes any
binding-induced compiled-hash difference explicit.

## Scope and privacy model

Every Bot has exactly one computer, shared by everyone assigned to it. Reasoning
stays per-channel so two conversations never bleed into one another:

An Active Bot's computer is supervised continuously while its fenced runtime
owner is running. For a migrated installation that owner is the launchd service,
not the presence of an Electron window.
Its profile and workspace survive run changes and container replacement; pause,
retirement, explicit reset/purge, or DevRyan shutdown stops the service without
silently deleting workspace files.

| Surface | Scope key | Dispatch |
| --- | --- | --- |
| Reasoning / workspace | `channel:<channelId>` | One FIFO per channel |
| Computer / browser profile | `bot:<botId>` | One Bot-wide computer FIFO |

The Settings Files view does not use generic host filesystem routes. Global
administrators receive a separate read-only supervisor listing rooted at the
computer container `/`; other Managers remain rooted at `/workspace`. Paths
are always relative to the server-selected root. Credential-bearing and virtual
roots, links, and special files are visible as Restricted metadata but cannot
be traversed or opened. Administrator reads are audited by principal, Bot, and
normalized path without recording directory contents. The running computer is
listed one level at a time by a fixed non-shell `opendir`/`lstat` supervisor
command; browsing `/` never recursively exports the container filesystem.

There is no per-member computer. `resolveComputerScopeKey` returns
`bot:<botId>` regardless of the tenancy a record carries, and the supervisor
rejects any computer request whose scope key is not exactly that. Records
written before this change may still say `personalized`; they resolve to the
same shared computer. Their old `-profile` and `-scratch` volumes are orphaned
by the scope-digest change and are reclaimed through the supervisor reset path,
never from SQL. Bot credentials are team-scoped for the same reason: they belong
to the Bot, not to whoever added them.

**All Bot memory is shared.** A Bot keeps one memory that every member can
retrieve from — there is no owner-private layer. This is a deliberate change in
privacy behavior: a personal or sensitive statement made in one member's channel
becomes retrievable by every other member. The classifier still flags such
statements as `confidential` or `restricted` so the Memory console can surface
them, and `thread_only` remains available for context that should not outlive
its channel. Memories converted from the old private layer keep their subject in
the logical key (`<key>:u:<uuid>`) so two members who taught the Bot the same
key both survive. A memory-index rebuild is what clears the legacy
`bot:<botId>:user:<uuid>` retrieval namespaces.

Channels themselves remain private. Active membership permits Bot discovery,
while transcript access still requires ownership or a Reader / Collaborator
channel ACL. A Manager without a channel ACL cannot read that channel. A global
administrator may read only through an explicit, attributable, read-only
break-glass decision. Canonical scope values remain server metadata; Docker
resource names use deployment-bound hashes.

### Soul

Each revision may carry a `soul` — a short markdown file describing who the Bot
is, how it sounds, and what it will not do. It is injected **first** in the
compiled system prompt, ahead of the standing role, so identity anchors
everything operational that follows, and it is materialized read-only as
`soul.md` next to `opencode.json` in the compiled config directory.

A soul is seeded once from the Bot's profile when it is created, and backfilled
once for Bots that predate it (folding in any `tone` the revision already had).
After that it belongs to whoever edits it and is never overwritten. The `soul`
key is omitted entirely when unset, so revisions written before souls existed
still hash to their stored `compiled_hash`. Soul boundaries are behavioral —
enforcement still lives in the action policy.

The user-facing lifecycle begins with **Setup incomplete**, followed by
`active <-> paused` and `active|paused -> retired`; retirement is terminal. A
setup Bot remains visible only in Settings and cannot appear in chat until
**Save & Publish** activates its first revision. Active revision contents are
immutable internally, so later edits use a new working revision without
presenting a draft workflow. Publication first saves the exact submitted
profile and revision candidate, runs every readiness gate, and activates only
that saved timestamp/hash. Failure preserves entered setup values and leaves a
previous Active revision unchanged. Publication affects only future admissions.
Queued/running/recovering runs stay pinned to their admitted revision, policy,
Library versions, and routine contract; the exact model snapshot is selected
once after claim and then remains pinned for execution and recovery.

Name, Title, Short Summary, and avatar are durable Bot profile fields rather
than revision identity. Profile updates use optimistic Bot `updated_at`
preconditions. Avatars are encrypted private `profile` objects, restricted to
PNG/JPEG/WebP up to 5 MiB, included in recovery and purge, and authorized only
to current members and Managers. Legacy revision glyphs remain presentation
fallbacks; the UI uses initials when no glyph exists.

Skill and MCP assignments are revision-bound. The newest working revision is
the editable target; Active revisions remain immutable. Installed Skill or MCP
server changes appear as **Update available** and never rewrite Active Bots.
Managers can edit the working revision; other assigned users receive only safe
status and a Manager-required state.

Candidate discovery translates project hints through the managed assignment
boundary and returns only safe names and display metadata. MCP attach and
credential rotation accept a configured server name; transport descriptors and
credential values are resolved on the host and never round-trip through the
renderer.

Skill attachment snapshots `SKILL.md` plus bounded safe supporting files into
an encrypted immutable package. Symlinks, traversal, devices, secret-like
files, and oversized packages are rejected. At runtime only assigned names are
permitted and their exact snapshot is mounted read-only at
`/workspace/.opencode/skills`; supporting scripts remain readable resources,
not executable capabilities.

MCP attachment preflights local stdio or remote Streamable HTTP (legacy SSE is
fallback), pins the discovered tool manifest, and commits the working revision
only after success. Credential import requires explicit shared confirmation,
since a Bot's credentials are shared by everyone on it. Only tools with an explicit
read-only annotation are reads, all others are writes, and newly attached tools
receive prompt-by-default policy without removing customized rules.
A bounded runtime catalog tells the Bot which binding ID, pinned tools, schemas,
and `action.request` shape it may use without exposing transport or credential
data; no MCP server is configured directly inside the Bot container. Cached MCP
clients use count and idle-lifetime bounds and close on rotation or shutdown.

Provider credentials remain host-local. In Settings, a Manager may select an
existing OAuth connection or submit a write-only API key through the Bot
credentials route. API-key values are converted into the provider auth record
and encrypted in the existing OS-key vault; Supabase stores only safe connection
metadata such as provider, label, kind, scope, masked identifier, status, and
version. Create removes a just-written vault record if metadata persistence
fails. Rotation preserves the connection identity and restores the prior vault
record if its metadata update fails. Inputs are cleared after success, and no
secret value is returned, audited, logged, snapshotted, or stored in browser
state.

Principal-scoped chat snapshots include only Bots with an Active revision.
Settings-only setup records therefore cannot leak into navigation. A committed
publication emits the existing Bot, revision, and membership events so an
authorized member sees the Bot without reloading; event-delivery failure does
not undo the database commit, and the next reconnect snapshot is authoritative.

## Chat latency, streaming, and safe retry

Production Bot chat uses an immediate local turn path separate from durable
synchronization. Submit atomically inserts the optimistic user row, clears the
composer, updates ordering, and marks only the short acceptance request pending.
The server reconciles the same client message ID in its `202` response. A
definitive rejection removes the row and restores the exact draft and attachment
IDs; an ambiguous network result retains **Not confirmed**, refreshes canonical
history, and retries once with the same message ID/idempotency key.

Acceptance performs one joined service-role authorization read, concurrent
Library source pinning, and one encrypted message/run transaction. The admitted
run is always queued with a pending model snapshot. Event publication, Shared
copy preparation, FIFO claim, model catalog and credential checks, config
materialization, and runtime startup occur after the response. Opening an idle,
active, send-capable channel requests an optional two-minute warm lease. At most
two principal/channel/revision/Library-bound leases keep the exact preallocated
run-scoped runtime, credential, gateway capability, compiled revision, and
Library materialization ready without creating a durable message or run. An
eligible send atomically adopts its run ID; attachments, routines, mismatch,
expiry, or warm failure use the cold path. Release, LRU eviction, invalidation,
shutdown, and replacement run the full scoped cleanup.

The initiating user receives `message.streaming` full-text snapshots through a
short-lived, revalidated channel-access lease. The first provider text is sent
immediately and later snapshots are coalesced to 50 ms; 192 KiB is the direct
payload ceiling. Canonical checkpoints carry the same monotonic revision so a
slow database event cannot rewind newer live text. Final/terminal events,
revocation, removal, principal reset, and SSE reconnect snapshots clear the
transient store.

Tool-use turns keep one canonical `result` checkpoint. Any unexpected pre-tool
or inter-tool prose is cleared at the next tool boundary and remains private;
post-tool result text streams back into that same bubble. New runs never create
an acknowledgment row. Historical acknowledgment rows remain readable for
storage compatibility but are hidden from transcripts and previews. Tool-free
turns use the same single-message streaming path. Typing begins at local send
acceptance, covers queued/starting/running, and stops for visible output,
terminal state, approval, or reconciliation.

Only a failed run with no generic agent execution handle, assistant output, or
action attempt can be retryable. Retry atomically requeues that same run for its
initiating user while its pinned revision and channel remain valid. It never
creates a duplicate message or silently retries. `Server-Timing`, content-free
journal milestones, and browser performance marks separate acceptance, queue,
startup, provider, delivery, checkpoint, and terminal latency without recording
message text, credentials, tokens, or decrypted configuration.

## Setup, repair, update, and rollback

The ordinary desktop launch waits only for bounded local HTTP/control readiness.
Docker `ensureReady` runs after the renderer is activated, reports progress
through runtime capability state, and never holds the startup splash for its
15-minute deadline. In background mode, the launchd-owned runtime starts the
loopback server first and continues Docker preparation asynchronously. The
single-flight operation still checks the signed manifest, installed state,
images, and fixed services; applies setup, update, or repair as required; and
rechecks health within three state transitions. An incomplete staged release is
repaired to its committed state before the desired update is retried. Individual
Docker commands remain capped at two minutes, and progress exposes only safe
phases such as image counts, service start, and health verification.

Once Docker is healthy, the in-process server reconciles and starts shared Bot
infrastructure and warms the model catalog. This boundary does not lease model
credentials, create per-Bot reasoning or computer containers, or eagerly
compile every revision. Those operations remain scoped to an admitted run or
the existing selected-channel prewarm path.

If Bot preparation fails, the already-running web server and coding-agent UI
remain available while Bot capability fails closed. **Retry** repeats only Bot
preparation. Remote-default-host launches and installations with Production
Bots disabled skip local Docker preparation. Generic local-server startup
failures retain the bounded startup retry path.

Before first setup:

1. Deploy the Supabase migrations using the deployment's normal migration
   process and confirm `20260826140000` is present in the target database.
2. Start Docker Desktop and wait for `docker info` to succeed.
3. Install a packaged DevRyan build containing the release-generated
   `bot-runtime/images.release.json`. Never hand-author or bypass the signature,
   digest, SBOM, provenance, or architecture checks.
   The six `ghcr.io/1h-team/devryan-bot-*` container packages must be public:
   packaged desktop installs intentionally carry no registry credential and pull
   only the immutable platform digests in that manifest. Release CI verifies the
   index plus both platform digests through an empty Docker credential directory
   before it exposes the manifest or desktop artifacts.
4. Open Bots and choose **Save & Publish**. When image readiness is blocked, the
   publication dialog exposes **Set Up Runtime** or **Repair Runtime** only when
   the Electron-owned status advertises that operation. The same recovery remains
   available from an already-published Bot conversation.

The operations have fixed meanings:

- **Setup** pulls/verifies the selected immutable release images, creates the
  fixed Compose services and named volumes, and writes
  `bots/runtime/installation.v1.json` only after health checks pass.
  Source-development builds instead inspect all six fixed local `:dev` images
  and fail before Compose when one is missing; they never pull mutable
  development tags.
- **Repair** reasserts the same desired signed manifest and fixed topology. It
  replaces unhealthy owned containers but retains named profiles, workspaces,
  and the index unless an explicit reset is separately confirmed.
- **Update** stages the desired signed manifest, verifies replacement services,
  and commits it only after health succeeds. Existing runs remain revision- and
  digest-pinned until the controlled replacement boundary.
- **Rollback** restores the recorded previous manifest or abandons an incomplete
  staged update. It never selects an arbitrary image and does not delete named
  data volumes.

All four mutations remain local desktop operations. App-bound mode uses the
existing local-only Electron IPC (`desktop_bot_runtime_*`); service mode forwards
the same fixed verbs over the authenticated loopback runtime-service contract.
No generic Docker or Compose HTTP endpoint exists. The same boundary exposes an
operation-status read and safe progress state. The Settings publication-readiness dialog and current
conversation surface present authoritative Setup/Repair progress and retryable
sanitized failures without clearing draft text or attachments.
Update/Rollback remain main-process operations and
must be invoked only through an authorized DevRyan UI or release/operator flow
that respects `canUpdate` / `canRollback`; do not call manager internals or raw
Compose commands as an operational shortcut.

If setup or repair fails, keep the capability state and issue list intact,
confirm Docker health and the signed manifest first, then retry the advertised
operation. A "not publicly accessible" image failure is a release-package
visibility defect, not a customer-login request: verify anonymous access to the
exact digest and ship a corrected release. Do not ask the user for GHCR
credentials. Do not delete named volumes to repair a container. Profile,
scratch, reasoning workspace, or index reset is a separate typed operation with
explicit scope and confirmation.

## Docker-off and background-service behavior

Known Docker absence, a stopped Engine, image drift, degraded services, or a
rebuilding index disables the composer. If health changes during a send, the
authorized message and queued run may already have been accepted atomically;
runtime preparation then records an explicit terminal startup failure instead
of losing the turn. A failure classified as pre-execution and retryable can be
requeued only through the same-run Retry contract. Nothing is silently replayed
when Docker returns, and existing authorized history remains readable from
Supabase.

If transport is lost after an action began, a read becomes `failed` and may be
retried as a new action. A write becomes `unknown`, moves its run to
`needs_reconciliation`, and is never automatically replayed. An Operator must
record complete/abandon or authorize a fresh idempotency key after checking the
external system.

When background Bots are enabled, the signed `--runtime-service` process owns
run dispatch, routines, memory consolidation, computer supervision, and Docker
management after every Electron window closes. launchd restarts a crashed
service, while the owner-generation fence prevents a second process from
admitting work for the same data directory. The renderer connects through a
one-time OS-sealed bootstrap, then uses an HttpOnly SameSite cookie and CSRF
header; stale or unsupported protocol generations are rejected.

On macOS 13 and later, first enable registers the signed bundle LaunchAgent via
`SMAppService` and surfaces approval/System Settings state. Older supported
hosts require explicit consent before writing a private mode-0600 per-user
LaunchAgent that runs the same executable. Handoff checkpoints work, stops the
in-process owner, starts and verifies the service, connects the short-lived
desktop-host broker, and reloads. Failure unregisters the service and restores
the in-process owner only after proving the service owner stopped.

Release packaging must build the native service-control helper for the same
architecture as the Electron artifact and place it at
`Contents/Resources/native/DevRyanRuntimeServiceControl`. The agent plist must
be sealed at
`Contents/Library/LaunchAgents/dev.openchamber.desktop.runtime-service.plist`.
Both local packaging and release CI run the finished-app verifier, which rejects
a missing or non-executable helper, the wrong Mach-O architecture, invalid plist
keys, an invalid code signature, or a Developer Team mismatch. Source-development
launches do not register the signed service, even when they reuse a packaged
Electron shell; use an installed packaged build for end-to-end launchd testing.

Settings treats registration failures as stable, sanitized states. A missing,
unreadable, non-executable, or wrong-architecture helper is a non-retryable build
failure and requires installing a repaired DevRyan build. `requires_approval`
is the only state that directs the user to Login Items. Control launch failures
and timeouts remain retryable after reopening the app.

Closing the app releases only the broker for native focus, notification, and
browser/CDP capabilities. Bot services continue; a UI-only operation receives
`desktop_host_unavailable` instead of an implicit fallback. **Disable background
Bots** checkpoints and drains execution, unregisters the service, and preserves
configuration while making execution unavailable. Legacy Bot users may retain
app-bound mode for the compatibility release until they accept migration.

Sleep, offline periods, restart, and disabled service state still use the
reviewed `skip`, `run_once`, or `replay_capped` missed-occurrence policy (hard
cap three); recovered write-capable occurrences require fresh approval. No
claim is made that routines execute while the Mac is powered off or the user is
logged out.

## Data, encryption, and retention

The data root is `$OPENCHAMBER_DATA_DIR` when set, otherwise the existing
DevRyan compatibility data directory (normally `~/.config/openchamber`). Its
Bot-owned local paths are:

- `bots/keys/deployment-key.v1`: one Electron `safeStorage`-sealed 32-byte
  deployment key;
- `bots/vault/credentials.v1.json`: the OS-key encrypted connector/provider
  credential vault;
- `bots/vault/environment-secrets.v1.json`: Bot-wide values encrypted with the
  deployment key; Supabase stores metadata and a local vault reference only;
- `bots/runtime/installation.v1.json`: current, staged, and previous runtime
  manifest state;
- `runtime-service/owner.v1.lock`: private single-owner generation fence for
  the current data directory;
- `runtime-service/handshake.v1.json`: private protocol/port/health descriptor
  whose bootstrap token is sealed with Electron `safeStorage` and rotated after
  one use;
- `bots/runtime/channels/<channelId>/<revisionId>/<compiledHash>/`: immutable, private
  channel/revision runtime config plus exact read-only assigned Skill snapshots;
  missing or corrupt generated trees are automatically rebuilt through a
  verified quarantine-and-swap without changing the published revision;
- `bots/runtime/auth/<runId>/auth.json`: ephemeral one-provider OpenCode auth;
  only the file is mounted so the persistent OpenCode data volume remains
  visible, and its containing directory is removed after stop or startup rollback;
- `bots/runtime/environment/<runId>/environment.json`: ephemeral `0400`
  complete active-secret snapshot, mounted read-only in reasoning only and
  removed after completion, failure, abort, failed start, or shutdown;
- `bots/runtime/artifacts/<runId>/`: ephemeral, private run staging, removed
  after completion, failure, timeout, or shutdown;
- `bots/purge/<botId>.v1.json`: private resumable purge receipt.

Docker named volumes retain reasoning workspaces, Chromium profiles/scratch,
the Bot-wide `/workspace/Shared` volume, and the disposable index under
deployment/Bot/scope labels. Shared files use
`<channelId>/<messageId>/<sanitizedFilename>`, remain mapped in
`bot_shared_files`, and are ready only after exact size/hash verification.
They survive container replacement and ordinary restarts but are removed by an
explicit Shared/all reset or Bot purge. Supabase retains the
authoritative control plane and encrypted objects. Do not copy these pieces
independently as a backup: the wrapped keys, database identities, object
metadata, and volume ownership must remain consistent.

Bot chat indexes the selected channel's Shared mappings by message. Bot-authored
PNG, JPEG, GIF, and WebP mappings create inline stable placeholders immediately,
including while computer-volume copying is pending. Near-viewport previews fetch
the encrypted object through the authorized object route, verify the MIME type,
decode before display, and revoke bounded object URLs deterministically. Exact
Shared-path Markdown images deduplicate against the mapping; SVG remains rejected.

For `image.generate`, the dispatcher inspects only finalized tool parts after
authoritative idle, then securely exports at most 12 regular files below the
reasoning `/workspace` before container teardown. The supervisor rejects links,
linked ancestors, wrong runtime ownership, path escapes, unknown magic bytes,
and files above 10 MiB. The host encrypts and
associates each image with the assistant result using an idempotent
run/tool/path source key. That encrypted object is the chat attachment; copying
to the computer Shared volume is asynchronous and may be retried without making
the inline image disappear or creating a duplicate. Secure export/upload
failure ends the run visibly as `bot_image_publication_failed`.

Each Supabase object uses a fresh AES-256-GCM key; the deployment key wraps that
object key. Bot memory, Library provenance, historical evaluation inputs,
credentials, and other sensitive control-plane values use versioned
deployment-key envelopes. Historical evaluation records remain preserved for
compatibility but are not a publication gate or an active Settings surface.
Logs and public projections must contain identifiers/digests/status codes only,
not prompts, message bodies, tool output, credentials, cookies, tokens, keys, or
ciphertext envelopes.

Security/lifecycle audit retention defaults to 365 days. The configured
`DEVRYAN_BOT_AUDIT_RETENTION_DAYS` cannot be below the database-enforced 30-day
floor. Pruning crosses the durable audit-delivery barrier first. Transcript,
object, memory, and purge lifetimes are separate from this audit policy.

Deleting a channel requires the owner to acknowledge that reviewed shared
learning survives. Private channel objects, channel summaries/index data, and
its Shared mappings are removed; shared memory remains active but its source
provenance is tombstoned. Granular purge accepts a never-activated Draft or a
Retired Bot, requires exact name and revision confirmation, writes a local
receipt before deletion, exposes partial failure, and resumes only explicitly
selected incomplete steps. Complete deletion derives the full resource set
server-side, automatically retires an Active or Paused Bot, and resumes prior
incomplete work from the same confirmed action. If the Bot runtime is
authoritatively `setup_required`, its
container, profile, workspace, and index cleanup completes as an explicit
no-op; other runtime failures remain retryable. Capability bindings are deleted
before dependent encrypted Skill objects and credentials.

## Recovery bundles

Recovery exports are `.drbr` files with a clear, non-sensitive format header and
an authenticated scrypt + AES-256-GCM payload. The baseline contains the Bot
configuration and durable profile, its encrypted profile avatar, the sealed
deployment key, and selected already-encrypted Library/workspace/Skill-package
objects plus immutable Skill/MCP binding rows.
Connector-vault records, Bot environment-secret vault records, and Chromium
profile volumes are independent high-risk secret sections; each needs separate
confirmation.

Only a global administrator may restore. Restore validates format, hashes,
schema/image compatibility, references, collisions, key compatibility, and
volume ownership before mutation. It preserves the importer as a Manager,
recreates routines paused, and reports compensation failures explicitly.
Electron owns the native save/open dialogs and passes only encrypted bytes to the
authenticated loopback server; the renderer never receives the bundle, key,
connector records, cookies, or browser archive.

Keep the passphrase outside DevRyan and store the bundle according to the secret
sections it includes. A bundle with connector credentials, environment secrets,
or browser profiles
must be handled as a credential backup, not as ordinary configuration export.

## Action policy and external-write uncertainty

Policy first hard-denies malformed, unbounded, denied-origin, or out-of-scope
operations and hard-prompts critical irreversible operations (payments or
transfers, destructive purge/deletion, credential export, access-control
changes, and production publication). It then combines every matching user rule
with `deny > prompt > allow` and applies the selected default. New Bots default
to low-risk Allow with an empty allowlist meaning any valid HTTP(S) origin;
ordinary bounded navigation, clicks, forms, uploads, and sends therefore run
without approval. Broad Allow is an informational warning, not a health gate.

Revision-v3 policy uses structured matcher v2: top-level dimensions are ANDed,
list values are ORed, and predicates within one rule are all required. The
bounded dimensions are live actor role, normalized URL-path globs, canonical
virtual-file globs with `any`/`all` quantifiers, typed JSON-Pointer argument
predicates, and fixed-window quotas. Only literal, `?`, `*`, and `**` glob
syntax and the reviewed `exists`, `eq`, `in`, `prefix`, `suffix`, `glob`, `gte`,
`lte`, and `arrayContains` operators exist. There is no CEL, regex, JavaScript,
callback, filesystem access, or free-form expression editor. Legacy revisions
continue to use matcher v1 and retain their decision corpus.

An approval binds the complete action hash, immutable revision, matcher version,
canonical authoritative policy-facts digest, live actor role, normalized
arguments/URL/file facts, quota buckets/reservations, target, limits, and
expiry. Facts are re-resolved immediately before execution; any role, URL,
path, argument, revision, or quota-binding change invalidates the approval.
Low-risk prompts may be approved by the requester;
sensitive actions require another Operator; critical actions require a Manager.
Purge, credential export, and broad-autonomy grants forbid self-approval.
If an approval window expires, the service-only reconciliation transaction
cancels the pending action without creating a decision, fails the waiting run
with `bot_approval_expired`, publishes/audits the terminal facts, and releases
that Bot's FIFO scope. Reconciliation runs at startup, every five seconds, and
before a scope claim. Quota slots are reserved atomically when an action is
proposed, consumed once immediately before execution, and released on denial,
cancellation, expiry, or pre-execution failure. Decision expiry never exceeds a
quota window, and concurrent rules cannot oversubscribe the hardest matching
ceiling. Concurrent and post-crash retries reuse the exact durable reservation
IDs and cannot advance the short-lived `proposed` staging state until the
idempotent reservation transaction is confirmed. Unexpired approvals and unknown-write reconciliation keep
blocking only their own Bot; distinct Bot scopes continue concurrently.

Website and MCP writes cannot generally provide an exactly-once receipt.
Their approval behavior follows the compiled default/rules unless a hard prompt
applies.
A transport loss after a write is durable uncertainty, not success and not an
automatic retry. Use the Approvals/Reconciliation surface, inspect the external
system, then record the outcome. Evidence capture occurs only when policy requests it;
the server crops and redacts the selected target and stores a bounded encrypted
artifact with expiry.

Computer networking fails closed through bot-egress. `public_only` permits any
public HTTP(S)/WebSocket host after DNS/address checks; `allowlist` narrows that
to exact normalized hosts with optional ports. `allowedOrigins` remains the
action-policy layer, so an empty origin list means any public origin—not private
network access. Redirect destinations and every request are revalidated against
the active revision, and DNS rebinding, RFC1918/ULA, loopback, link-local,
metadata, multicast, reserved ranges, unsupported protocols, and direct
container egress are blocked. A proxy failure disables browser networking; it
never falls back to direct access. Browser-purpose capabilities rotate through
an exact, runtime-authenticated computer control route without restarting the
persistent Chromium profile. If the host cannot confirm rotation, it stops the
owned computer rather than retaining stale authority. Live Computer screencast JPEGs are ephemeral
fan-out and must never be treated as retained evidence.

`computerPolicy.isolationTier` is `standard` or `runsc`. For `runsc`, Electron
checks Docker's declared runtime list and executes a disposable owned,
no-network, read-only smoke container. Publication or startup fails visibly if
either check fails; no silent downgrade is permitted. A tier change drains the
computer, flushes its Chromium profile, and recreates the container with the
requested runtime while retaining the named profile volume. The computer
backend interface reserves a future Apple Virtualization implementation, but
the shipped implementation is Docker/gVisor only.

## Diagnostics and support

Start with the capability payload and do not infer readiness from a visible Bot
or running Docker process:

```text
GET /api/bots/capabilities
```

For runtime anomalies, inspect the diagnostic journal before theorizing:

```bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 200
bun scripts/journal.mjs gaps
```

Use the Error Log UUID only to resolve the session and strongest correlation ID;
then search the journal by `callId`, `toolId`, `messageId`, `taskId`, or a
bounded timestamp window. A journal gap or expired/unavailable host journal must
remain an explicit evidence limitation.

Safe operational checks include Docker client/server version and architecture,
the Electron runtime status, the capability state, the required Supabase
migration, and the signed manifest verifier. Never paste `supabase.json`, sealed
key files, vault files, recovery bundles, auth staging, cookies, or bearer values
into an issue. Use the diagnostics export path, whose sanitizer and native
atomic-save workflow are documented in the repository diagnostics modules.

## Further implementation references

- Runtime policy: `packages/bots-runtime/DOCUMENTATION.md`
- Electron/Docker ownership: `packages/electron/codemap.md`
- Supervisor and socket boundary: `packages/bot-supervisor/DOCUMENTATION.md`
- Model egress: `packages/bot-egress/DOCUMENTATION.md`
- Computer runtime: `packages/bot-computer/DOCUMENTATION.md`
- Local index: `packages/bot-indexer/DOCUMENTATION.md`
- Server control plane: `packages/web/server/lib/bots/DOCUMENTATION.md`
- UI behavior: `packages/ui/src/components/bots/DOCUMENTATION.md`
- Verification matrix: `docs/TESTING.md`
