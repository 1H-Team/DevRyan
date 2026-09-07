# Production Bots server control plane

The cross-component operator and security runbook is `docs/BOTS_RUNTIME.md`.
This document remains the implementation contract for the server control plane.
Retry repair verification and outstanding live acceptance are recorded in
`docs/BOT_SAFE_RETRY_REPAIR_2026-08-30.md`.

## Current simplified product boundary

`docs/BOTS_SIMPLIFICATION_2026-08-27.md` is the current user-facing contract.
New and newly saved Bots are OpenCode-only, receive server-enforced file,
runtime, public-internet, and persistent-computer defaults, and clear MCP plus
operating/prohibited/advanced instruction layers. Optional per-Bot Skills remain
content-addressed SOP packages and are materialized for OpenCode's on-demand
Skill loading. Computer files under `/workspace/Resources` are the file/reference
source of truth, with encrypted index projections used only to rebuild search.
Memory extraction is asynchronous and `memory.changed` refreshes the UI.

Legacy revision, Library, recovery, AG-UI, MCP, role, and retirement data below
is retained only where immutable run pinning, deployed-client compatibility,
cleanup, migration, audit, or security invariants require it. MCP attach and
execution are disabled; new AG-UI activation is disabled. These internal paths
must not be reintroduced into Bot Settings.

## Ownership and composition

The Bots server module owns policy and persistence above the local Docker
services. It is composed by `lib/multi-user/runtime.js`, where the authenticated
principal, server-only Supabase client, and durable actor audit already exist.
The module receives only these narrow dependencies:

```js
createBotsRuntime({
  supabase,
  audit,
  principalPolicy,
  dataDirectory,
  botHost,
  encryption,
  withAuditDeliveryBarrier,
})
```

`botHost` exposes Electron-owned status plus fixed `ensure reasoning`, `ensure
computer`, `inspect`, `stop`, typed reset/profile-archive, workspace write/list,
administrator container listing, secure workspace-image export, Bot-wide Shared
import, and indexer-request callbacks. The server cannot supply an image,
mount, network, Docker argument, or Engine request. A reasoning ensure/inspect
returns a validated loopback supervisor endpoint with an unguessable scoped
path; the reasoning container itself has no published host port, and the
endpoint never enters a browser projection. Docker setup, repair,
update, and rollback remain local Electron commands. Capability ownership issues
retain only validated deployment IDs, fixed service names, and allowlisted Docker
states (at most 32 conflicts plus a truncation flag); raw Docker metadata is never
forwarded. These states describe containers, not host-process liveness. `encryption.getKey`
returns a defensive copy of the OS-sealed deployment key across an in-process
callback. Recovery may call the separate atomic `encryption.installKey`
callback only after compatibility and collision validation. Neither operation
is an HTTP or renderer capability.

The Computer-files route derives its root from authorization only. A global
administrator uses the separate typed container-list callback rooted at `/`;
other authorized settings users use the workspace callback rooted at `/workspace`.
Client query data contains only a relative path and cannot choose or widen the
scope. Restricted credential/virtual entries remain visible metadata but cannot
be traversed; neither path reads file content. Administrator directory reads
write a content-free audit containing principal, Bot, and normalized path. A
fixed supervisor `opendir`/`lstat` operation lists only one directory level in
the running computer, rather than recursively archiving the selected path. A
local Electron host must return an accurate ready/offline/setup/runtime state;
`unsupported` is reserved for web hosts that do not own Docker.

When Supabase is not configured, the runtime still registers the capability
route so clients can explain why Bots are unavailable. No Bot data route falls
back to local plaintext persistence.

On managed hosts, the multi-user middleware applies the principal's default-on
`bots` capability before this module receives a request. A sparse per-user Off
override denies the capability probe, SSE, catalog, action, channel, and run
route families with `bots_access_disabled`; it does not revoke memberships or
delete Bot state. Local and managed administrators remain allowed.

## Execution adapters and compatibility

Execution starts only after the Bot Supabase schema/retention probe succeeds.
`config-compiler.js` validates every runtime-bearing revision field and hashes
the canonical standing role, immutable OpenCode binding (or retained legacy AG-UI binding), reasoning
policy, file tools, optional runtime tools, gateway plugin version, Library
versions, memory policy, action policy, browser/computer policy, and the optional soul. The soul leads the assembled
prompt and is also written as a `0400` `soul.md`. The `soul` key is omitted when
unset so revisions predating it keep their stored hash. It writes
an immutable `0500` channel/hash directory containing exact `0400`
`revision.json` and `opencode.json` files. Existing contents and permissions
must match exactly; edited config is never adopted. A missing, partial, edited,
or permission-invalid generated directory is disposable: compilation is
singleflight per channel/revision/hash, builds and verifies a private sibling,
atomically quarantines and replaces the bad tree, and continues the original
run without changing the published revision. Failed swaps restore the
quarantined tree when possible. Content-free diagnostic lifecycle events record
repair detection, completion, and failure.
Contracts that omit the v3 agent/browser/computer fields retain the legacy
compiler branch and hash and resolve to OpenCode. Revision v3 precompiles matcher
v2 globs/predicates and pins either `{ kind: "opencode" }` or an exact
`{ kind: "ag_ui", connectionRef, connectionDigest, modelHint? }`; a run never
switches that binding after admission. Contracts that omit `runtimeTools` retain
their earlier compiler behavior. Autonomous contracts use the versioned compiler branch, expose only the selected
`bash`, `terminal`, `git`, and non-recursive `task` tools, and enable scoped
native `explore`/`general` subagents. Raw browser/CDP, direct MCP, recursive
delegation, Docker, host orchestration, external directories, and host
credentials remain denied.

`reasoning-adapter.js` defines health/preparation, start/continue/inspect,
cancel/close, structured completion, and optional warm/release capabilities.
`run-dispatcher.js` consumes only normalized ordered start, text, governed tool
intent, artifact, checkpoint, usage, completion, and error events. OpenCode
sessions, segments, native events, warm leases, image export, and provider error
translation live in `opencode-reasoning-adapter.js`.
Its structured-completion translation forwards only `runId`, `prompt`,
`schema`, and non-empty `title`/`system` fields to the provider. Dispatcher
binding/preparation internals therefore cannot cross the strict no-tools
provider request boundary.
`reasoning-adapter.conformance.test.js` runs OpenCode and AG-UI through the same
health, preparation, continuation, inspection, cancellation, close, structured
completion, and normalized-event contract; it also rejects provider semantics in
the dispatcher source boundary.

OpenCode reasoning ownership is exclusive per Bot/channel. `opencode-provider.js`
serializes start/stop operations by that scope, permits same-run warm adoption,
and rejects provisional/background admission with `bot_runtime_scope_busy` while
an interactive owner is active. Interactive admission may preempt a provisional
owner only after its cleanup completes. Stop and failed-start cleanup are fenced
by the current scope owner, so an old run can never stop or release a newer one;
different channel scopes continue concurrently.

`ag-ui-reasoning-adapter.js` pins the reviewed `@ag-ui/core@0.0.58` subset. A
Manager-owned connection resolves to one exact public HTTPS/SSE endpoint with
none or encrypted bearer authentication; its descriptor digest excludes the
secret. Requests use purpose-separated bot-egress with redirects disabled and
advertise exactly one frontend tool, `devryan_bot`. Completed tool intents are
validated locally and results return on a subsequent invocation as ToolMessage.
Endpoint tool results, unknown tools, raw/custom/activity UI, interrupts,
duplicate/replayed IDs, malformed order/arguments, and oversized streams fail
closed. The endpoint never receives gateway authority, credential values,
computer tokens, or local callbacks.

`model-credential-broker.js` evaluates the primary model and then ordered
fallbacks. A candidate is usable only when the live catalog contains the exact
provider/model, the scoped credential is active, and its reviewed HTTPS:443
egress authorities equal the catalog. The chosen snapshot is persisted to
`bot_runs` with the caller's optimistic revision. No candidate produces the
stable `bot_model_unavailable` error; prompts cannot supply an override.

For API keys and other providers, the broker materializes one provider under
`bots/runtime/auth/<runId>/auth.json` with `0600` permissions, mounts only that
file at OpenCode's auth path without shadowing its persistent data volume,
ingests any refreshed record into the OS-sealed vault on stop, and removes the
plaintext directory. Startup rollback removes it without attempting refresh.
Host-linked OpenAI OAuth instead uses `host-oauth-connections.js` and the
managed `openai-oauth-coordinator.js`. Existing credential/revision IDs stay
fixed. A legacy sealed snapshot must prove its account matches the current
host account before migration; missing/different identities need explicit
Manager reconnection. Metadata holds `connectionId` and a one-way account
identity key; projections expose only `authState` (`unknown`, `ready`,
`reauth_required`, `unavailable`). Migrated vault entries contain a reference,
never reusable OAuth tokens. Scoped auth starts as a non-secret discriminator;
finalization never ingests its OpenAI OAuth contents.

`POST /api/bots/:botId/credentials/:credentialId/reconnect` requires Manager
authorization, `connectionId: "host:openai"`, and `expectedUpdatedAt`. It
updates the existing credential with optimistic concurrency and invalidates
unused warm runtimes. It does not repair a revoked provider login; reconnect
that account in Providers first. Active runs pinned to a different account
fail authentication rather than silently switching.

The separate private `/api/bots/private/oauth` endpoint accepts only protocol
1 `ready`/`access` requests from reasoning capabilities. Bot/run/channel/revision
and permitted connection are derived from live server claims, not body fields.
It has no agent-tool registration, renderer route, URL proxy, cookies, or CORS.
Revoked/expired capabilities cannot receive a pending refresh result. Provider
discovery initializes and checks the plugin before warm admission; adoption,
prompt dispatch, structured work and every provider request revalidate access.
Cold startup retries one content-free, transient provider-discovery failure
before any prompt exists. Authentication/configuration rejections are never
retried and retain their stable reconnect code. Attachment materialization,
runtime readiness, prompt acceptance, and cleanup emit count/byte/class-only
journal records without filenames or content.
The broker also derives one non-secret image capability bit. It is true only
for an admitted `openai` snapshot whose resolved credential kind is `oauth`;
API keys, other providers, and caller input cannot enable it. The reasoning
container uses the existing scoped `auth.json`, never a second credential path.
The reviewed image wrapper checks access immediately before both dedicated and
legacy image calls, updates the bind-mounted inode with access-only credentials,
and strips dependency exceptions containing provider response bodies.

Rollout and offline Docker acceptance: `docs/BOT_OAUTH_COORDINATION.md`.

`environment-secret-vault.js` stores Bot-wide values only in a dedicated
host-local deployment-key-encrypted file with atomic replacement. Supabase
`bot_environment_secrets` rows contain only exact case-sensitive names,
status/timestamps, creator, and a vault reference. `environment-secrets.js`
enforces Manager authorization, optimistic timestamps, 128-name/16-KiB-value/
256-KiB-total limits, reserved process/proxy namespaces, and compensation for
cross-store failure. Values never appear in reads, audit metadata, logs, or
journal records. At reasoning admission it must decrypt the complete active
set into one private per-run JSON snapshot or fail with
`bot_environment_secrets_unavailable` before Docker starts. Rotation/deletion
therefore changes only later runs. The fixed launcher imports the snapshot
without shell evaluation; terminal, abort, failed startup, shutdown, recovery,
and purge paths remove or restore the corresponding host material. The
persistent computer never receives it.

`gateway-host.js` binds a `127.0.0.1` port before a Bot container can start:
the port the deployment used last time (remembered under
`bots/gateway/port.v1.json`, random on first start, and replaced by a fresh
random port only when it is already taken), which keeps the address the egress
relay was told about stable across DevRyan restarts. Random bearer capabilities
bind Bot, run, channel, revision, runtime kind, scope, operations, and expiry.

No Bot container reaches this port itself: reasoning and computer containers
hold no route off their internal networks, so their calls arrive through the
bot-egress relay, which Electron addresses over the same authenticated control
channel it uses for revision attestation. The host still requires Docker's exact
Host header through `host.docker.internal`, which no other process on the host
loopback sends, denies browser/forwarded headers, enforces request/response
limits, stores only token hashes, and never logs payloads or credentials. Until
the channel/action modules install a handler, operations fail closed with a
stable unavailable response.

The selected egress authorities cross the same typed Electron boundary.
Electron signs a short-lived deployment/Bot/revision capability, the
supervisor places it only in standard proxy URL credentials, and a separately
authenticated loopback control call attests the current active revision to the
model-egress service. The same control channel publishes the gateway address
before each container that will use it starts; the address is stripped from the
supervisor request, so neither the supervisor nor any container ever holds it.
If attestation fails after container creation, Electron stops that scoped
container before returning failure.

Graceful process shutdown stops all scoped Bot OpenCode containers, revokes
private gateway capabilities, ingests/removes scoped auth, and closes the
gateway before browser leases, ordinary provider runtimes, OpenCode, or the
HTTP server are torn down.

## Supabase repositories

`store.js` defines every relation and fixed RPC through migration
`20260903110000`. Each
repository has a literal select list and literal writable fields. Request JSON
is never spread into a PostgREST body. Unsupported filters or fields fail before
network I/O, and diagnostic logging contains only operation, table, and field
names—not values, envelopes, or ciphertext.

Lists use opaque descending cursors over a timestamp and stable identity column.
Mutable rows use `updateIfRevision`: the caller supplies the previously read
`updated_at`, which is included in the update predicate. An empty result is the
stable `bot_revision_conflict` response. Activated revisions, messages,
approvals, memory versions, Library versions, and Bot audit events have no
general update path.

Cross-row operations are restricted to the migration-owned functions:

- `devryan_bot_schema_version`
- `devryan_bot_send_context`
- `devryan_bot_channel_audience`
- `devryan_create_bot`
- `devryan_enqueue_bot_message_run`
- `devryan_retry_bot_run`
- `devryan_allocate_bot_message_sequence`
- `devryan_claim_bot_run`
- `devryan_settle_bot_run_terminal`
- `devryan_expire_bot_approvals`
- `devryan_claim_bot_routine_occurrence`
- `devryan_activate_bot_revision`
- `devryan_publish_bot_revision`
- `devryan_commit_bot_memory_version`
- `devryan_commit_bot_channel_summary`
- `devryan_enqueue_bot_memory_extraction_job`
- `devryan_claim_bot_memory_extraction_job`
- `devryan_persist_bot_memory_extraction_candidates`
- `devryan_settle_bot_memory_extraction_job`
- `devryan_delete_bot_channel`
- `devryan_prune_bot_audit`
- `devryan_purge_bot_resource`
- `devryan_purge_bot`

`bot_skill_packages` and `bot_mcp_bindings` are service-only, forced-RLS,
immutable snapshot tables. Skill rows reference encrypted `bot_objects`; MCP
rows retain only an encrypted transport descriptor, a pinned safe tool
manifest, display metadata, and digests. Credential values remain in the
host-local Bot vault. Browser roles have explicit revocations and no policies.

Startup calls the service-role-only schema marker before retention, execution,
or route mutations become available. The server constant is the minimum
supported 14-digit migration marker: equal and newer markers are accepted,
while missing, malformed, or older markers fail closed. Bot migrations must
therefore remain backward-compatible for at least one desktop release. A stale
marker or a schema-cache miss for any Bot table/function produces HTTP 503 with
`code: "bot_schema_migration_required"` and
`requiredMigration: "20260903110000"`.

The migration adds nullable `agent_adapter`, `agent_thread_id`, and bounded
`agent_execution` fields to durable runs and backfills the projection from
legacy OpenCode session/segment data without modifying revision contracts or
compiled hashes. OpenCode columns remain readable during the compatibility
window. Agent connections, portable binding resolutions, signatures/trust, and
quota bucket/reservation tables are additive, service-only, forced-RLS
relations with browser-role revocations. Active revision/spec/signature rows and
local resolution rows are immutable; quota reserve/consume/release happens only
through service-role transactions.

Compiled reasoning configuration is revision-scoped at
`bots/runtime/channels/<channelId>/<revisionId>/<compiledHash>/`. Equal immutable
revision contents may share a compiled hash without sharing a manifest or mount.
Legacy hash-only directories are never read as the active revision and remain
disposable generated state until the existing Bot/channel purge removes them.

## Manager administration and publication

`management.js` is the server authority for `/api/bots` management. Only a
global administrator with a durable actor UUID can create a Bot. The same
server-authoritative rule is exposed as `canCreateBot` on catalog/capability
responses; unrelated detail or readiness failures do not suppress it.
`devryan_create_bot` atomically creates its first setup revision and the
creator's initial Manager membership. A
database trigger serializes membership mutations per Bot and rejects any
attempt to remove the final active Manager.

Bot presentation is durable and independent of revisions. `PATCH /api/bots/:botId/profile`
updates Name, Title, Short Summary, and the optional encrypted avatar under an
exact Bot `updated_at` precondition. `GET /api/bots/:botId/avatar` permits only
current members and Managers. Avatar
uploads accept PNG, JPEG, or WebP up to 5 MiB and verify both declared MIME and
byte signature before encryption. Replacement uploads the new object first,
swaps the same-Bot profile pointer optimistically, removes the new object on
conflict, then tombstones and resumably cleans the old object. A migrated
revision glyph remains the fallback; clients use initials when no glyph exists.

`GET /api/bots/:botId/model-options` is Manager-only and projects the live host
catalog to provider/model names, availability, Thinking variants, context
limits, and reviewed HTTPS egress metadata. It also projects only the safe
authentication kind and, for a configured OAuth provider, one opaque
`host:<provider>` connection descriptor. API keys, OAuth tokens, account auth
records, and other catalog secrets are never serialized.

Managers edit structured setup contracts through optimistic `updated_at`
preconditions. Revisions remain the immutable internal safety boundary, but
setup records are not exposed to users as drafts. Active revision content
remains database-immutable, so editing an active Bot creates a new working
revision. `POST /api/bots/:botId/revisions/:revisionId/publish` accepts the
candidate profile (including an optional bounded avatar) with the revision
contract, saves the exact contract, runs every activation gate, and then calls
the exact-version publish RPC with the saved `updated_at` and compiled hash.
For a setup-only Bot, blocked readiness keeps the entered profile, avatar, and
contract for correction. For an already active Bot, profile/avatar mutations
are applied only after readiness and compensated if exact publication fails;
the old avatar is cleaned only after commit. A racing revision cannot activate.
The legacy activate endpoint remains compatibility-only. Publishing checks schema
readiness, exact Docker image digests, the selected reasoning adapter and
connection/model credential health, reviewed egress, browser/computer isolation,
the tool manifest, and structural compiler/policy validity. An
Allow default with an empty browser allowlist is valid and means any valid
public HTTP(S) origin; private networking remains blocked and the broad public
scope is an informational warning rather than a
publication blocker. Library/index,
Skill package integrity/materialization, and MCP credentials/connectivity/pinned
manifests are gates only when the exact revision assigns them; an empty assignment
is a valid configuration and produces no readiness row. Model and binding preflight
remain independent of Docker health so one runtime failure cannot manufacture
unrelated credential or assignment failures. Evaluations are not a publication gate.
The fixed publish RPC advances only
future chats and routines; admitted runs retain their pinned revision.

Revision contracts accept optional `skillBindings` and `mcpBindings`. Missing
fields mean no bindings and are deliberately omitted during normalization so a
legacy Active revision keeps its historical canonical hash. New Drafts emit
empty arrays. General Draft create/update endpoints cannot forge or replace
binding references; only the capability service can mutate them.
New Bot setup revisions also default to all five scoped file tools, all four
scoped runtime tools, low-risk Allow, and empty browser allow/deny lists.
Managers may opt out per tool or change the default before publication. The
guided autonomous migration copies these defaults into a working revision while
preserving identity, model, credentials, Library, skills, memory, and MCP
bindings; it never changes the active revision until Save & Publish succeeds.

Historical evaluation inputs remain encrypted with the deployment key and are
preserved for compatibility. Their read route remains available for one
compatibility release, while save/run routes return the stable
`bot_evaluations_deprecated` response and are not used by publication.
Lifecycle operations handle pause, resume, and retirement; publication is
separate. Purge first returns a granular
resource preview so the client can present typed-name confirmation and retry
partial failures without hiding retained resources.

API-key Bot connections are created and rotated only through Manager-authorized
write-only secret requests. The server normalizes each key to the OpenCode auth
record `{ type: 'api', key }`, writes it to the OS-sealed host-local vault, and
persists only allowlisted metadata to Supabase. A failed metadata insert removes
the new vault record; a failed rotation restores the exact prior encrypted
record and version. OAuth creation accepts only the opaque connection ID from
the current model-options catalog, persists no token, and lets the model broker
import only that selected host record into the vault. Public credential rows
contain only ID, provider, label, kind, scope, masked identifier, status,
version, and timestamps. Legacy metadata-only creation is rejected.

`agent-connections.js` applies the same Bot-scoped Manager and write-only secret
rules to AG-UI endpoints. Descriptors accept one exact public HTTPS/SSE URL,
protocol version, none/bearer auth mode, bounded limits, and optional model hint.
The public digest excludes the encrypted bearer. Health, revocation, digest
drift, and endpoint policy are independent activation gates; revocation never
changes an already-admitted run's adapter.

## Signed Bot-as-code publication

`bot-spec.js` exports a published revision as deterministic sorted JSON named
`DevRyan-Bot-<slug>-r<revision>.devryan-bot.json`. The portable spec contains
identity, soul/instructions, reasoning binding, egress, tools, structured
policy, browser/computer policy, memory, and content-addressed Skill/MCP/Library
bindings. It explicitly omits credential UUIDs/values, local object IDs, host
paths, encrypted envelopes, and export timestamps.

The strict parser rejects duplicate keys, unknown fields, unsupported versions,
and bounded-size/depth/count overflow. `bot-spec-signer.js` hashes the canonical
spec and signs the canonical document excluding only the signature value with
Ed25519. Signature rows are immutable. The trust store supports global Admin
trust and Bot-scoped Manager trust; unknown valid signers require explicit
acknowledgement, while invalid/revoked signers fail before mapping.

Import preview resolves logical, immutable-digest bindings against local agent
connections, credentials, Skills, MCP servers, and Library versions. It installs
nothing automatically and stores an immutable local resolution set. Import
always calls ordinary draft creation—never activation—and the resulting draft
must pass the exact optimistic save, health, and publication APIs above. The
portable spec hash must survive cross-environment promotion; only local
binding-derived compiled-hash differences may be explained in the preview.

## Revision-bound Skill and MCP assignments

`capability-bindings.js` owns the Manager-authorized, optimistic-concurrency
assignment API. It lists only safe summaries and supports Draft-only Skill/MCP
attach/detach plus MCP credential import/rotation. Every mutation requires the
exact revision `updated_at`, recompiles the Draft, returns the refreshed public
revision, and emits a content-free audit event. Active revisions are read-only;
an assigned non-Manager can read safe status but cannot mutate.

Manager candidate lists are assembled server-side. A project hint is first
translated through the managed-user assignment boundary before Skill discovery
or project MCP configuration is read. The API returns Skill name/description/
scope and MCP name/type/scope only—never host paths, commands, URLs, environment
values, headers, or credentials. MCP attach/rotation accepts only the configured
server name plus the project hint; the host resolves the pinned descriptor and
credential material after authorization rather than trusting a renderer-supplied
transport descriptor.
For remote servers authenticated through OpenCode OAuth, the host imports only
the exact-name, exact-URL, unexpired access token into the Bot credential vault.
Expired OAuth state produces an actionable re-authentication error, and failed
transport preflight is reported as an MCP connection problem rather than Docker
or Production Bot availability.

Skill attach resolves an installed skill through the host discovery contract,
then uses the bounded no-follow scanner to snapshot `SKILL.md` and safe support
files. Traversal, links, devices, `.git`, credential-like files, duplicate
names/paths, per-file overflow, total overflow, and changing file identity fail
before the Draft changes. The canonical package is encrypted as a private
Library object and referenced by its immutable digest. Later installed-skill
changes appear as `Update available`; they never rewrite an Active revision.

`config-compiler.js` decrypts only the exact revision references, verifies every
row/object/package digest, and writes immutable private files beneath the
compiled `skills/` directory. Electron verifies that exact manifest again; the
supervisor mounts it read-only at `/workspace/.opencode/skills`. Binding-aware
OpenCode config denies `skill: "*"` and permits only assigned names. Shell,
terminal, task, Git, and execution remain denied, so bundled scripts are
readable resources rather than executable capabilities.

`mcp-connector.js` uses the repository-pinned MCP SDK for local stdio and remote
Streamable HTTP, with legacy SSE fallback. Attach first connects, discovers a
bounded tool set, and pins its canonical manifest before committing any Draft
reference. Candidate binding, credential, and policy mutations compensate on
failure. Credentials require explicit shared-import confirmation because a Bot's
credentials are shared by everyone on it. Secrets are split from encrypted
transport descriptors and resolved only server-side for the exact Bot/channel.

Every MCP invocation enters the registered `connector:mcp` adapter and then the
existing action gateway, policy, approval, receipt, audit, and reconciliation
flow. Only an explicit MCP read-only annotation becomes a read; every other
tool is a write. Attach creates prompt-by-default policy rules without deleting
customized rules. A bounded, secret-free runtime catalog supplies the pinned
binding IDs, tool schemas, operation classification, and exact `action.request`
shape to the Bot context; direct container MCP configuration remains empty.
Live calls recheck the pinned manifest and fail closed on
drift, bound clients/timeouts/results/idle process lifetimes, and close local
processes plus cached secret state on rotation or shutdown. MCP writes have no
exactly-once guarantee: transport loss after a possible write becomes the
existing durable unknown-outcome reconciliation state.

The Skills and MCP activation gates independently verify referenced immutable
rows and digests. Skills also verify decryptability and materialization; MCP
also verifies credential scope, connectivity, and the pinned live manifest.

## Encrypted recovery and resumable purge

`recovery-bundle.js` creates the versioned `DevRyan.BotRecovery` binary format.
Its small clear header contains only KDF/AEAD parameters; scrypt derives an
AES-256-GCM key from the Manager-supplied passphrase, and the authenticated
payload contains a manifest plus per-section size/SHA-256 descriptors. Bot
configuration, the OS-sealed deployment key, and selected encrypted
Library/workspace objects are the safe baseline. Connector-vault records,
Bot environment-secret vault records, and browser-profile volumes are three
independent secret sections and each requires a separate high-risk confirmation.

`recovery-adapter.js` exports only explicit control-plane fields and existing
ciphertext, including the durable Bot profile and encrypted profile avatar,
immutable Skill/MCP binding rows, and their required encrypted skill objects.
Before any restore mutation it checks format, section hashes,
schema/image versions, every user/row/object reference, target emptiness or
explicit merge mode, ID/storage collisions, connector/environment-vault
identity, browser-volume
ownership, and deployment-key compatibility. Restore keeps the importing
principal as a Manager, recreates routines paused, and compensates Storage,
control-plane, vault, browser-profile, and key mutations on failure. Only a
global administrator may restore a deployment bundle. Any failed compensation
is returned as an explicit partial-rollback error with content-free step codes.

Electron owns save/open dialogs in `bot-recovery-dialog.mjs`. Export streams
the encrypted response into a private sibling temporary file and completes it
with fsync plus atomic rename. Restore reads only a bounded, no-follow regular
file into main-process memory and sends encrypted bytes to the authenticated
loopback server. The renderer receives only cancellation/file/result metadata,
never bundle bytes, keys, connector records, cookies, or browser archives.

`purge-runtime.js` writes a private, atomic, per-Bot recovery journal before
deleting anything. A Bot must be a never-activated Draft or Retired and the
request must repeat its exact name and `updated_at`. Each selected Storage,
vault, Docker volume, local index, capability-binding, channel, shared-memory,
and private-memory step records attempts and a bounded content-free result.
When the authoritative host state is `setup_required`, runtime containers,
profiles, workspaces, and indexes complete as explicit no-ops; an empty index
selection is also already clean. Other runtime failures remain partial so
local data cannot be silently orphaned. Failed or dependency-blocked work
remains partial. Granular purge requires an explicit incomplete-step retry.
Complete deletion derives the canonical full selection on the server,
automatically retires Active or Paused Bots, resumes prior incomplete work, and
invokes the service-only database Bot delete after all host resources succeed.
It reports `botDeleted: true`; granular selection retains the Bot. Channel
purge tombstones shared-memory provenance while deleting private channel state.
Audit retention runs only after destructive steps. `auditRetention.prune()` is
the sole owner of the durable audit-delivery barrier; purge callers must not
wrap it in another barrier because the serialized outbox boundary is deliberately
non-reentrant. Lifecycle and purge audit rows remain retained by policy.
The terminal service transaction temporarily permits only the foreign-key
`bot_id` nulling performed on retained audit rows. All other audit updates and
deletes stay rejected. The user-facing and server purge workflow also accepts a
never-activated Draft so failed setup and isolated verification fixtures can be
removed without first activating an otherwise invalid revision.

## Continuous channels and durable dispatch

`channels.js` owns canonical encrypted channel messages. Owner-channel creation
is idempotent under concurrent inserts, and every read/send still evaluates the
current Bot membership plus channel ACL. A stable client message ID and
idempotency key are passed to `devryan_enqueue_bot_message_run`, which inserts
the finalized encrypted user message and its queued run in one database
transaction. The current admission overload also inserts one empty,
unfinalized `assistant_phase="pending"` row using the client-provided
acknowledgment ID or a server-generated fallback. A retry returns and decrypts
the already-persisted user and pending assistant messages; caller text from a
conflicting retry is never reflected back as canonical content.
Attachment admission also creates durable `bot_shared_files` mappings in that
transaction. The FIFO claim function will not claim the queued head until every
required mapping is `ready`; preparation failures remain visible and retryable
without inserting a duplicate chat message.

Message admission also accepts the optional server-validated
`attachmentDeliveryMode` (`auto` or `compatibility`) and pins it in the run
context snapshot. Ordinary sends default to `auto`. Admission uses one joined
service-only send-context RPC, applies the existing JavaScript policy to those
authoritative records, resolves configured Library sources concurrently, and
commits an encrypted user message, its pending assistant response, and a queued run with a
pending immutable adapter/model snapshot. The HTTP `202` publishes both
messages but does not wait
for event publication, Shared-file preparation, FIFO claim, model/credential
checks, config compilation, or runtime startup.

Every Bot shares one computer-scope FIFO. An in-process drain coalesces wakeups,
while `devryan_claim_bot_run` remains the durable one-lease-per-scope authority
across processes. Claiming begins only after the acceptance response is released.
After claim, run records, selected-adapter preparation state, runtime health, and the
source user message load concurrently. Context assembly and reasoning startup
also overlap; a runtime that succeeds while context assembly fails is cleaned
up. The selected adapter owns scoped preparation. The OpenCode adapter handles
one forced catalog refresh for a stale model-unavailable result before failing visibly;
AG-UI uses its pinned connection health/digest instead.
`queueSequence` remains a compatibility ordering field and is not a user-facing
queue position.

`POST /api/bot-channels/:channelId/prewarm` prepares the immutable revision and
model catalog, then starts one exact run-scoped reasoning runtime in explicit
provisional mode without a durable message or run. Credential selection and
materialization therefore skip `bot_runs` model-snapshot writes until normal
admission claims the same preallocated run ID. `warm-runtime-leases.js` binds its opaque lease and
preallocated run ID to the principal, channel, active revision, and Library
snapshot. It keeps at most two live leases with a two-minute idle TTL and LRU
eviction. Eligible attachment-free sends atomically claim the lease; attachments,
routines, expiry, mismatch, or preparation failure fall back to the cold path.
`DELETE /api/bot-channels/:channelId/prewarm/:leaseId` releases an unused lease.
Release, expiry, eviction, revision/channel invalidation, shutdown, and cold-path
replacement stop the runtime and revoke credentials, capabilities, environment
files, artifacts, and containers through the provider's normal scoped cleanup.
Preparation failures retain content-free `stage` and `errorCode` diagnostics;
they are not collapsed to one `prepare_failed` label.

Electron's app-bound or background owner uses the separate
`prepareStartup`/server-handle `prepareBotRuntime()` contract after bounded HTTP
readiness. After the
Electron manager reports Docker healthy, it reconciles any execution layer that
failed during the earlier server start, starts the shared gateway, indexer,
memory, routine, dispatcher, and recovery composition, and warms the host model
catalog once. The result is typed as `skipped`, `ready`, or a sanitized `failed`
record. This host-wide warmup never requests a model credential, creates a
reasoning container, creates a computer container, or compiles every Bot
revision. The authenticated selected-channel prewarm above remains lazy.

Only an explicitly classified startup/execution failure without visible output
or possibly mutating action evidence can expose `retryable: true`. Provider
retry advice alone cannot authorize replay of an executed Bot run.
`retry-policy.js` treats a governed attempt as non-mutating evidence only when
it is classified as a read, settled as succeeded/failed/denied, has no unknown
outcome, and its receipt is absent or says `safe_to_retry`; pending, unknown,
paginated, or write evidence fails closed.
`POST /api/bot-runs/:runId/retry` uses `devryan_retry_bot_run` to acquire the
computer-scope lock before locking and requeueing that same run. It checks the
initiating actor, current access, active pinned revision, attachments, execution
identifiers (including AG-UI invocation IDs), and active scope ownership. Only
an unfinalized, attachment-free pending admission placeholder is exempt from
assistant-output evidence. Prompt execution persists its identity before that
placeholder can acquire response text. Acknowledgments, results, finalized
rows, and every action attempt except the settled read-only case above block
replay. Migration
`20260902120000_bot_audit_resolution_and_read_only_retry.sql` enforces the same
predicate transactionally in the retry RPC.
Retry preserves the original user message, placeholder, idempotency identity,
Library snapshot, attachments, and FIFO sequence. Existing HTTP status codes
remain unchanged; an allowlisted `details.retryReason` explains permanent
refusals and temporary scope contention. Retry is never automatic. Migration
`20260830210000_bot_safe_run_retry.sql` must precede the updated runtime.

The final-answer path deliberately buffers ambiguous text until completion:
the runtime cannot reliably distinguish commentary before a tool from a final
answer while streaming. Legacy `message.streaming` contracts remain recognized
but are not rendered. Canonical events use the joined audience RPC and remain
failure-independent; immediate client working feedback does not require prose.

The send response emits `Server-Timing` for authorization, Library pinning,
admission, and total acceptance. Content-free journal milestones cover request,
durable acceptance, pending-response readiness/publication, claim, runtime
readiness, prompt acceptance, first provider result, first requester delivery,
first canonical checkpoint, and terminal outcome. Additional content-free
server and browser marks separate verified final-answer paint, provisional
warm preparation/adoption/failure stage, runtime startup, Shared mapping
creation, preview fetch, complete screen-frame draw, human-input dispatch, and
image decode from provider/image-generation duration. Correlation is limited to
safe Bot/channel/run/view identifiers. Message content, input text/keys/
coordinates, credentials, tokens, and decrypted configuration are never
recorded.

`computer-runtime-manager.js` owns one Bot-scoped computer for every Active Bot
while the fenced runtime owner is running. It starts Active computers during bootstrap and
before activation/resume commits, performs a single-flight health sweep, and
restarts failures independently. Pause, retirement, purge, and shutdown stop
the service without deleting the persistent workspace. Browser artifact
transfers receive separate short-lived durable-run gateway capabilities.
Provision/refresh start, completion, and failure are content-free lifecycle
records. The browser service polls known computer runtimes every two seconds
without needing an open viewer or human lease; polls never provision or recover
a computer, overlap, or retain more than 256 runtime handles. Shutdown cancels
the collector. The optional network trail is projected before journal capture,
deduplicated by process stream and sequence, and reports retention gaps.
Snapshots are byte-bounded pages; per-turn instructions explain stable cursor
continuation, explicit omissions, and using observed account-specific links.
The gateway's reviewed result-size error explains the limit without exposing
upstream messages or incorrectly claiming a browser/network outage.

`model-catalog.js` obtains `/config/providers` from the authenticated host
OpenCode runtime with a five-second deadline and a streaming 4 MiB ceiling.
Transport/HTTP failures remain a stable preflight 503, while malformed or
oversized catalogs are rejected before model selection. Its Bot-management
projection strips credentials, auth material, transport details, and unknown
provider fields before returning model options to a Manager. When the live
catalog omits transport metadata, the server supplies only its narrow reviewed
provider/auth-kind registry (for example, OpenAI API and OAuth use distinct
authorities); both publication and execution require the revision to match that
same registry exactly.

## Curated Library, run-local artifacts, and Shared files

Library sources are optional. A revision with no selected Library versions
publishes without them. If execution services are temporarily unavailable, the
Manager list route returns an authorized structured `runtime_unavailable`
state instead of a generic 503; the UI neither treats that state as a required
publication step nor pretends that previously published sources were deleted.

`source-scanner.js` inspects only a path explicitly selected by a Manager. It
does not install a watcher or infer additional host roots. Traversal, symlinks,
filesystem devices, sockets, FIFOs, `.git`, secret-bearing files, unsupported
binaries, configured exclusions, and files that change identity while being
read are rejected or surfaced as review findings. Absolute source paths and
encrypted source provenance are returned only after Manager authorization;
ordinary members never receive host filesystem identity.

`library-runtime.js` retains each reviewed scan only briefly in memory. A
Manager must inspect its bounded diff and security findings before explicitly
publishing. Publication copies and encrypts immutable Library objects, inserts
a new immutable version, advances the source pointer optimistically, and
indexes that exact version. There is no automatic refresh: every changed host
source requires another Manager-selected scan and publication. A full index
rebuild decrypts authoritative active memory plus every immutable Library
version so rebuilding either domain cannot erase the other.

Run admission resolves configured Library sources to their newest published
versions immediately before the atomic message/run insert. Those exact version
IDs are stored in the run context snapshot. New runs therefore see newer
publications while queued, starting, running, and recovering runs remain pinned
to the versions admitted with them.

Generated artifacts remain private channel objects. Manager publication is an
explicit copy into a distinct encrypted Library object/version and never
widens or rewrites the source ACL. `artifact-service.js` materializes only
authorized channel objects and admitted Library versions into a fixed private
per-run staging directory, writes a bounded manifest, and removes the plaintext
after the run, timeout, failed start, or shutdown. Electron validates that tree
without following links before the supervisor mounts it read-only at
`/workspace/.devryan`; the container cannot select another host path.
Private message attachments are classified during materialization. Valid UTF-8
`text/*`, CSV, JSON, and XML are labeled as untrusted user-data prompt parts,
bounded to 128 KiB per file and 256 KiB per turn with explicit truncation
metadata. Images and PDFs remain native OpenCode file parts in `auto` mode.
Unsupported binaries remain mounted and are exposed only through the compact
mounted-path manifest. `compatibility` mode suppresses native file parts while
retaining inline text and every mounted manifest entry. Attachment-only messages
are valid, while messages with neither text nor attachments remain invalid.

`shared-files.js` additionally copies every user attachment into the Bot-wide
managed volume at the deterministic traversal-safe path
`/workspace/Shared/<channelId>/<messageId>/<sanitizedFilename>`. It streams the
authorized private object through Electron's fixed supervisor import, verifies
the exact size and SHA-256 hash, records `pending`, `copying`, `ready`, or
`failed`, and emits only authorized status projections. The physical volume is
Bot-wide and survives container replacement, while list/download/retry/open
contracts remain filtered to the selected readable conversation. No host path,
gateway token, or unfiltered computer listing is exposed.

Bot-created arbitrary files are never discovered by scanning the computer. A
Bot must explicitly call the governed `artifact.put` action, which is normalized
to the host-owned `connector:shared` write. The connector accepts one bounded
canonical base64 payload, binds it to the exact bot/run/channel assistant
message, stores an encrypted private object, imports/verifies the Shared copy,
and records a `direction: bot` mapping. Transport uncertainty remains
non-replayable.

ChatGPT image generation is a narrower automatic path. The reviewed
`devryan_image` tool exposes the pinned image plugin's exact `prompt`, `out`,
`quality`, optional `size`, and optional `images` schema only to the primary
agent and only for the server-derived OpenAI OAuth capability. The legacy
`devryan_bot image.generate` executor remains readable for persisted 1.2 calls
but is no longer model-visible. After authoritative
idle and assistant checkpoint finalization—but before reasoning teardown—the
dispatcher inspects only finalized image tool parts, accepts at most 12 relative
workspace paths, and calls Electron's fixed secure export. The supervisor
canonicalizes the source beneath `/workspace`, rejects links/non-regular files,
linked ancestors, and wrong runtime UID/GID, then validates PNG/JPEG/GIF/WebP
magic bytes and the 10 MiB limit. Each result is
encrypted and associated with the assistant message using a deterministic
run/tool/path source key. Failure ends visibly as
`bot_image_publication_failed`; the Bot must never promise a later publisher.

The encrypted object and `bot_shared_files` row are the chat authority. Shared
volume copying is queued after the mapping commit, so `pending`, `copying`,
`ready`, and `failed` copies all remain downloadable and inline-renderable.
Copy failure leaves the attachment intact and retry updates the same mapping;
the source key prevents duplicate automatic publications.

`context-assembler.js` reconstructs a bounded context from the active revision,
encrypted channel checkpoint, messages no newer than the admitted user-message
sequence, the Bot's shared memory, and authorized Library retrieval
chunks. The adapter receives a generic continuation parent. The OpenCode adapter
creates a fresh segment on revision change, at 60 percent provider-reported
context, or after 40 completed user turns; AG-UI uses its endpoint thread and
checkpoint contract. Adapter-specific IDs remain execution metadata; Supabase
message sequence is the product timeline and client resume source.

The immediately preceding channel run is selected by `queue_sequence` regardless
of terminal state. Segment continuation is allowed only after a completed
predecessor. Failed, cancelled, interrupted, or otherwise incomplete predecessors
force a fresh adapter execution while the canonical Supabase transcript rebuilds
durable context, preventing a failed provider execution from poisoning follow-up
turns.

Every assembled turn also includes one runtime-owned synthetic response-style
instruction between the private context and the user's query. It requires a
direct final answer without acknowledgments or pre-tool/inter-tool narration.
The Bot retains its configured Soul and selected reasoning model.
The instruction is execution-only: it is not written into the
published revision contract, compiled hash, context snapshot, or canonical
channel transcript, so existing Bots receive it on their next submitted turn
without republishing.

Normalized adapter events retain authoritative request/message/part identity,
part type, visibility and completion. Finalization reconciles against provider
records for the exact submitted request; reasoning, hidden and unknown fragments
fail closed. The pending row is promoted to one final `result` only after that
reconciliation. Missing text fails as `bot_response_missing` unless a valid
persisted deliverable exists. Generated images are published before finality.
`response-sanitizer.js` uses metadata only: it never removes legitimate sentences,
literal protocol markers or code by natural-language heuristics. Historical
acknowledgment rows are hidden by the UI without a destructive migration.
OpenCode SSE reconnects with bounded backoff and read-only completion polling;
it never resends an uncertain prompt. `request-lifetime.js` starts the deadline
before preparation/submission and propagates cancellation to pending HTTP work.
Successful authorized checkpoints publish `message.updated` projections to the
channel audience. Unverified response text is never checkpointed; the UI shows
pending work separately and paints answer text only after finality. Events never
contain the encrypted envelope or hidden adapter identifiers.
Cancellation calls the active adapter, queued cancellation is durable, and a
run-scoped cancellation marker covers the startup interval before active
execution registration so an abort in that race still settles as `cancelled`
instead of a failed request. Run timeout records a terminal failure before
scoped-runtime cleanup.
Adapter errors retain a safe subtype-specific
`interruption_kind` for authentication, API rejection/retry, output length,
abort, structured output, context overflow, content filter, and unknown errors.
Runtime logs contain only that safe error type, bounded status, retryability,
and an allowlisted bounded provider reference; response bodies and headers are
never logged or projected.
`failure-diagnostics.js` additionally projects scoped OpenCode errors into the
sanitized journal before adapter normalization. Records include Bot/run/session
correlation, classification, bounded sanitized error text, HTTP status, and a
safe request reference. Browser recovery records correlate the action attempt
and recovery stage; Electron supervisor failures expose bounded transport
classifications only. Headers, response bodies, credentials, and raw transport
objects are excluded. These records do not add content to Bot Audit, and a
journal failure cannot replace the original execution error.

## Structured background-owned routines

`routine-drafter.js` turns a Manager's conversational rationale into an exact
JSON candidate through the active revision's selected adapter with every tool
disabled.
The model cannot activate or persist a routine. Its output is revalidated by
`routine-runtime.js`, the original Manager rationale and IANA timezone replace
the model copies, and the UI requires review of the exact trigger, inputs,
tool/account/origin allowlists, action/write limits, approval class, timeout,
missed-run policy/cap, and completion criteria before activation.

`routine-runtime.js` is a single fenced-owner scheduler. It uses timezone-aware
daily, weekly, one-time, or five-field cron calculation and owns only one wake
timer. On startup it resolves missed occurrences as `skip`, `run_once`, or at
most three `replay_capped` runs. A recovered write-capable occurrence carries a
fresh-approval requirement into the immutable run snapshot. Paused routines
retain their due time, so resuming applies the reviewed missed-run policy rather
than silently moving the schedule forward.

Every occurrence first calls `devryan_claim_bot_routine_occurrence`; an
optimistic claimant update elects one live web process even when concurrent RPC
callers observe the migration's temporary `routine-scheduler` owner. Only the
winner reloads the routine, Bot lifecycle, current Manager membership, and
current active revision. Admission uses the occurrence UUID as the durable
message ID and an occurrence-bound idempotency key, records the exact active
revision plus routine contract in `bot_runs.context_snapshot`, and never
replays an already-admitted or unknown-outcome write after restart.

The action gateway reevaluates the activated revision policy for every new
attempt and then applies the snapshotted routine as a strictly narrower guard.
It denies tools, credential accounts, origins, and action/write counts outside
the reviewed contract and may strengthen approval; it cannot soften a revision
policy denial. Run completion, failure, cancellation, and explicit unknown-write
reconciliation settle the occurrence without automatic replay.

Scheduling exists in the app-bound compatibility owner or, after migration, the
launchd runtime service. Bot pause/retire, Manager revocation, Docker/runtime
failure, and unavailable active revisions leave the due timestamp durable for
reviewed missed-run recovery. Closing the UI only releases the desktop broker;
service disable/update checkpoints and drains the scheduler before owner
release. No claim is made while the Mac is powered off or the user is logged
out.

## Layered automatic memory

`memory-runtime.js` is the sole write authority for reusable Bot memory. A
database trigger creates one service-only `bot_memory_extraction_jobs` row when
a run becomes completed. The runtime claims jobs with expiring leases, admits
at most one concurrent extraction per Bot, and uses a small global worker pool.
It reconstructs the exact finalized user/result messages and pinned revision;
it never replays the completed Bot turn or any external action. The adapter
creates a disposable structured-completion execution pinned to that run's
already-selected model/connection, disables every tool, and requests the exact
JSON schema from `memory-classifier.js`. Disposable memory and routine-drafting
tasks declare `persistence: ephemeral`; OpenCode maps that contract to the
provisional credential path, so a synthetic task ID can never update
`bot_runs.model_snapshot`.

The dispatcher offers the completed run's still-active runtime to
`enqueueCompletedRun` (`extract` callback plus a bounded abort signal). The
runtime claims that run's job through
`devryan_claim_bot_memory_extraction_job_by_run` (migration
`20260903110000`), which honours the one-leased-job-per-Bot rule and never
touches a job that already carries candidates, and processes it in place; an
unavailable claim, a queued follow-up message, or an aborted pass leaves the job
to the durable worker unchanged. The structured completion prefers the agent's
validated `structured` value over the text parts, and the classifier recovers
JSON wrapped in fences, prose, a bare array, or extra top-level keys while
keeping every per-candidate trust check strict; an empty answer is zero
candidates, not a failure. `bot_memory_extraction_invalid`,
`bot_opencode_request_invalid`, and `bot_opencode_response_invalid` are
repairable: one immediate repair pass with a content-free hint, then up to
three durable attempts, after which the terminal audit metadata and log line
carry a `reason` (`not_json`, `shape`, `too_large`, `provenance`) or the host
`validator` label (`start_input`, `session_id`, `structured_schema`,
`method_input`, `scope_mismatch`, …). `bot_opencode_request_aborted`,
`bot_opencode_run_not_found`, `bot_runtime_scope_busy`, and any admission-stage
or aborted failure settle as `defer` without consuming an attempt.

Accepted/rejected classifier output is encrypted with the deployment key and
persisted on the job before any summary, version, or index commit. Lease expiry,
process crashes, and restarts therefore resume the commit phase without another
model request. Transient provider, checkpoint, storage, and index failures use
bounded durable backoff; malformed, missing, deleted, or undecryptable inputs
settle terminally. The terminal branch logs only the normalized code/name/status,
run/Bot IDs, phase, and attempt count before its audit diagnostic; provider
payloads and extracted content never enter the log. Underlying non-retryable classifications are preserved, and
revision conflicts settle after one attempt instead of exhausting the retry
schedule. Migration `20260901130000_bot_memory_extraction_conflict_recovery.sql`
requeues only the historical terminal `classification` plus
`bot_revision_conflict` signature; a later success resolves the prior issue in
the audit projection without deleting the immutable event. Intermediate retries
emit content-free journal lifecycle events but no Bot Audit issue. A success or
exhausted terminal job emits one
stable audit event and can never change the completed run state or retract the
already-published completion event.

Migration `20260901160000_bot_runtime_scope_and_audit_repair.sql` makes
conversation ownership authoritative for extraction admission. The claim RPC
skips jobs whose channel has any non-terminal run. The provider closes the
remaining race with `bot_runtime_scope_busy`; memory settlement maps that code
to `defer`, requeues the job, and restores the attempt count. Deferred work
resumes after channel idle and emits only a content-free journal lifecycle
record—not a Bot Audit issue.

The classifier rejects unsupported fields/scopes, cross-user subjects,
unrecognized provenance, long transcript copies, and credential-like values.
Every retained fact is shared: a Bot keeps one memory that all of its members
can retrieve from, and there is no owner-private layer. Personal or sensitive
statements are still escalated to `confidential` so the console can surface
them, but they are shared like everything else; temporary facts enter only the
encrypted channel summary. Retained facts call
`devryan_commit_bot_memory_version`, which serializes one logical identity.
Automatic sources use a deterministic run/logical-key UUID; replay returns the
existing immutable source/version. An initial identity race refetches and
re-encrypts for the authoritative memory ID, while a Manager-won activation
race preserves the classifier version as inactive and successful/superseded.
Channel-summary commits are serialized per channel and call
`devryan_commit_bot_channel_summary`, whose compare-and-swap value is only
`current_checkpoint_number`. Unrelated channel activity cannot invalidate a
summary. A genuine checkpoint conflict refetches, decrypts, rebases, and retries
three times before the durable job backs off. Existing
`(sourceRunId, logicalKey)` candidates are idempotent and repair a missing index
entry; an undecryptable summary is never replaced with an empty one. Audit
metadata separates activated, idempotent, superseded, skipped, conflict,
index-sync, recovery, and retry counts without including memory or transcript
content.

`indexer-client.js` constructs the exact per-Bot and per-channel namespaces and
delegates only bounded typed operations through Electron to the
loopback indexer. Plaintext is transient in the server/indexer processes and is
never persisted in Supabase outside OS-key encrypted envelopes. Index changes
are rebuildable. Startup automatically replaces a fresh or invalidated
`rebuild_required` index from authoritative active Memory, channel summaries,
and immutable Library versions before Bot execution becomes available. A
Manager-triggered full rebuild uses the same complete source set.

`memory-consolidation.js` runs under the fenced runtime owner (the launchd
service after migration), coalesces concurrent sweeps, and merges only exact
normalized duplicates. Closing the UI releases no memory work. Conflicting facts remain
separate. Manager routes can list/decrypt memory, inspect immutable versions and
provenance, edit, merge, tombstone, restore, and rebuild; every route begins
with `requireManager`, so ordinary members cannot enumerate a Bot's memory.

Channel deletion requires an explicit acknowledgment that what the Bot learned
survives. Only the owner may proceed and unfinished runs block deletion. Private
objects and the channel-summary index namespace are removed. No memory is
deleted — every memory is shared and outlives its source channel — but its
source records are tombstoned with `channelDeleted: true` so provenance does not
pretend the deleted transcript is still available.

`event-stream.js` is a separate principal-scoped Bot event runtime. A subscriber
is registered before its authorized snapshot is loaded, so events concurrent
with snapshot construction queue behind it and then retain monotonic
epoch/sequence order. Audience filtering happens before Bot/channel identifiers
or payloads are constructed; an unauthorized principal therefore receives no
private identifiers. This stream does not enter the ordinary OpenCode SSE
reducers.
The chat snapshot includes only Bots with an active revision; setup-only Bots
remain visible in Settings but cannot enter chat. Paused and retired Bots keep
their active revision in the snapshot so historical channels remain visible.
Post-commit activation, profile, lifecycle, and membership events reconcile
authorized clients immediately; delivery failure never rolls back committed
management state, and the reconnect snapshot remains authoritative. The
snapshot otherwise includes only the principal's active memberships, safe Bot
and revision metadata, readable channels, and runs for those channels, plus
separately composed approvals/computer status. It also includes one authorized
`channelPreviews` projection per readable channel, sourced only from the latest
finalized visible user/assistant message, and recent governed action attempts
for Activity. Final `message.updated` events carry the same preview so the roster
does not load every transcript or subscribe to streaming collections. Revision contracts and hidden
OpenCode segment/session IDs never enter the browser projection. Pending action
rows include the argument digest required to submit an exact bound decision.
Each channel projection carries only the principal's `owner`, `reader`, or
`collaborator` access role and a derived send capability, so the composer does
not infer write access from Bot-level membership.

At startup, `run-recovery.js` inspects durable `starting`, `running`, and
`waiting_control` runs plus
their action ledger. Runs containing interrupted or already-unknown writes move
to `needs_reconciliation` and are not replayed. Runs with no unsafe action may
resume only after an optimistic lease takeover; a still-live foreign owner or a
concurrent winner is deferred before Docker starts. The pinned adapter then
inspects the generic execution handle: a busy execution is reattached, an idle
terminal assistant is checkpointed/finalized, and only an execution with no
observed prompt may submit it. A failed persisted-execution reconciliation becomes
`interrupted`. Existing `needs_reconciliation` states and unexpired
`waiting_approval` states are left durable for an operator decision. A
`waiting_control` run resumes its persisted action and idempotency key instead
of converting the pre-execution fence into a failed or uncertain action.

`approval-service.js` calls the service-only
`devryan_expire_bot_approvals` transaction at execution startup, every five
seconds, and immediately before each scoped FIFO claim. The transaction locks
eligible pending actions with `SKIP LOCKED`, changes only expired actions to
`cancelled`, changes only their still-waiting runs to `failed` with
`bot_approval_expired`, clears their leases, and returns only rows changed by
that caller. The server then publishes the normal `action.cancelled` and
`run.failed` projections, records a content-free system audit event, invokes
run-settlement hooks, and drains every released scope. Repeated and concurrent
sweeps are therefore idempotent; no approval decision is invented. A released
Bot continues FIFO, while different Bot scope keys continue draining in
parallel.

## Policy-gated actions and browser control

`connector-registry.js` defines the complete connector boundary—describe,
validate, authorize, execute, reconcile, and revoke. Production registers only
the host-owned `connector:mcp`, `connector:workspace`, and `connector:shared`
adapters; a tool name cannot become executable
merely by appearing in a prompt or revision. Every connector validates its
operation kind, immutable binding/revision membership, payload, credential
scope, and pinned manifest before the gateway creates or executes an attempt.

`connector:workspace` accepts only one bounded top-level file and content body.
It always traverses the same policy, separation-of-duties approval, immutable
action hash, durable receipt, audit, and reconciliation path as other writes,
then invokes Electron's fixed supervisor callback. It never accepts a host path,
volume name, Docker identifier, or generic filesystem operation.

`connector:shared` is the explicit Bot-file publication path described above.
It cannot enumerate the computer or accept an existing computer/host path.

`policy-engine.js` first hard-denies malformed, unbounded, denied-origin, and
out-of-scope operations, then hard-prompts critical irreversible operations
such as payments/transfers, destructive purge/deletion, credential export,
access-control changes, and production publication. It next combines matching
user rules with `deny` stronger than `prompt`, and `prompt` stronger than
`allow`, then applies the selected default. Ordinary bounded navigation, clicks,
form filling, uploads, and sends therefore follow an Allow default without an
approval. Matcher v2 adds bounded live actor roles, normalized URL-path globs,
canonical virtual-file globs with `any`/`all`, typed JSON-Pointer predicates,
and fixed-window actor/Bot quotas. Top-level dimensions are ANDed; list values
are ORed; one rule's predicates are all required. Only escaped literals, `?`,
`*`, `**`, and the reviewed typed operators are accepted—never CEL, regex,
JavaScript, filesystem access, or callbacks. Legacy revision decisions remain
on matcher v1.

The resulting decision is bound to a canonical action hash containing the Bot,
immutable revision, run, initiator, credential/computer scopes, authoritative
actor/URL/file/argument facts, matcher version, quota bucket/reservation IDs,
limits, and expiry. Durable approvals repeat that exact binding. Facts and role
are re-resolved immediately before execution; drift invalidates approval. Low-risk
actions may be confirmed by the requester, sensitive actions require another
Operator, and critical actions require a Manager; purge, credential export, and
broad-autonomy grants additionally forbid self-approval.

`action-gateway.js` persists the attempt and atomically reserves every matching
quota before proposal. It consumes reservations once immediately before an
execution attempt; denial, cancellation, expiry, and pre-execution failure
release them. Decision expiry is capped at the quota window, and concurrent
callers cannot oversubscribe the hardest matching ceiling. The durable
`proposed` staging row and its exact reservation IDs are recoverable: a
concurrent or post-crash retry may repeat only the same reservation transaction,
and cannot advance the action until that transaction is confirmed. The gateway uses a caller
idempotency key to return an already-encrypted result without replay. Safe reads
may retry within their decision limit. A transport loss after a browser write
has no native exactly-once receipt, becomes `unknown`, moves the run to
`needs_reconciliation`, and cannot execute again under the same attempt. An
Operator can record complete, abandon, or obtain a fresh retry idempotency key;
reconciliation itself never replays the action.

`browser-service.js` grants safe reads separately from interactions. Clicks,
fills, uploads, and other writes require an exact origin, goal, reviewed
operation, revision, run, and short-lived capability. They follow the compiled
policy default unless a hard gate or matching rule narrows it. Arbitrary websites cannot provide native exactly-once
write receipts, which remains explicit in the durable action receipt and audit.
The computer first relaunches a dead Chromium/CDP driver in place. If that
bounded recovery is exhausted, the host probes live status with a five-second
deadline. A healthy or launching browser is preserved and the read returns an
explicit incomplete-command error without replay; the caller can inspect the
current page with a snapshot. Cold commands have a 90-second transport deadline
to cover startup plus navigation within the tool gateway's 120-second limit.
Only an unhealthy or unreachable computer is recreated once
for a safe read while retaining its named profile, workspace, and Shared
volumes. Browser writes are never replayed: CDP closure or command timeout after
dispatch remains an unknown outcome requiring reconciliation. Navigation, DNS,
TLS, HTTP, policy, and target errors are not treated as transport recovery.
Chromium has no direct public network: it uses a local authenticated relay into
bot-egress with QUIC and implicit loopback bypass disabled. Every request
revalidates the active revision and `public_only` or exact-host allowlist policy;
private/reserved/metadata/rebinding targets and direct egress fail closed.
`runsc` revisions must pass the host runtime-list and owned smoke checks and are
never silently downgraded.
Human take/heartbeat/return control is attributed to an Operator. Screencast
frames are proxied ephemerally and never enter Supabase or the object store.
Status, take/heartbeat/return, and reviewed human commands use the Bot-scoped
`/api/bots/:botId/computer/*` contract, so they remain available between runs.
The status projection allowlists the typed browser lifecycle, headed-mode,
engine/display, active-target/popup state, managed web-capability, and sanitized
navigation-diagnostic fields. It projects at most ten trail entries, five
non-actionable cookie blocks, and five dialogs. Origins are renormalized and
pathnames are revalidated/masked; query/hash/userinfo, headers, cookie values,
page content, and input data cannot cross into the renderer. A genuine
same-path/redirect loop writes one content-free partial audit row per browser
generation/diagnostic revision and a matching journal lifecycle record.
The optional `recentNetworkTrail` status field is revalidated independently by
`browser-network-diagnostics.js` (100 entries, 64 KiB, five minutes). It contains
Document/Fetch/XHR statuses and failure reasons plus reviewed lifecycle changes,
not request/response bodies or credentials. Authorized status reads submit each
unseen stream/sequence once to the existing sanitized journal as
`bot.computer.network`; missing sequences become `bot.computer.network_gap`
records. Cursors are process-local and bounded to 256 streams/five minutes;
host restart can replay the surviving short trail, identifiable by stream and
sequence. No new route or expanded membership permission is introduced.
An agent command encounters human control as the explicit pre-execution
`DEVRYAN_BOT_CONTROL_HELD` fence. The gateway persists both the run and the same
action attempt as `waiting_control`, polls the authoritative renewable lease,
and resumes that exact attempt after return or natural expiry. Cancellation
remains available. Wait and resume are successful lifecycle audit records;
only allowlisted safe remote codes cross into audit metadata.
Passive viewing is independent from control: any active Bot member may create a
viewer only for a channel they may currently read. `POST
/api/bots/:botId/computer/view` creates a principal/Bot/channel/scope-bound,
one-use in-memory descriptor; its stream route attaches it and DELETE stops it.
Unattached viewers expire after 15 seconds, and attached viewers close on
disconnect, explicit stop, Bot deactivation, principal reset, or server shutdown.
Viewer creation idempotently ensures the continuously supervised Active-Bot
runtime; it never activates a Draft, Paused, or Retired Bot. Attaching the
one-use stream launches Chromium when the Active Bot has not used it yet, then
starts the shared CDP screencast. The proxy aborts and cancels both stream layers
from the response lifecycle, records content-free created/attached/first-stream-
chunk/complete-frame/closed milestones, and settles the viewer exactly once. The last disconnect
stops screencasting without stopping the persistent browser. Passive viewing
never grants control or pauses agent commands.

The renderer accepts only bounded multipart JPEG frames with mandatory content
length, valid JPEG boundaries, a 2 MiB frame cap, and verified 1280×720,
device-scale-1 metadata. It uses same-origin fetch, abortable incremental
parsing, `createImageBitmap`, and a canvas; connection is established only after
a complete JPEG is decoded and drawn. A five-second first-frame deadline closes
the viewer and exposes Retry. Only the newest decoded frame is retained.

The existing human-command route additionally accepts `command: "input"` with
an exact attached `viewId`, owned lease ID, and up to 32 events/64 KiB. The
discriminated event union covers pointer, wheel, key, and bounded Unicode text.
The host revalidates principal, Bot membership, Operator role, channel read,
CSRF, view attachment, and lease ownership immediately before dispatch. Input
is disabled on disconnect, return, expiry, role/channel change, or conflict.
The computer service dispatches ordered CDP input without exposing `input` to
the Bot agent's reviewed command inventory. Successful batches accumulate into
one `bot.computer.human_session` row per control lease with counts by event type,
aggregate timings, and an end reason. Return, view cleanup, expiry, five minutes
of inactivity, and shutdown flush it; heartbeats remain in the event stream but
do not enter the ledger. A failed batch keeps one individual content-free
failure row. Text, keys, modifiers, and coordinates are forbidden.
An already-authorized active runtime does not repeat Docker inspection for each
input batch; the periodic sweep remains the health authority. Continuous hover
and wheel events are coalesced behind at most one in-flight request. Held-button
movement remains ordered, discrete down/up events survive backlog pressure, a
queued real release drains before control/view teardown, and lease aggregation
means audit storage is not on the per-click success path.

`evidence-service.js` captures only when the selected write policy requests it.
The browser supplies a PNG, then the server crops to policy-bound target bounds,
applies explicit black-box redactions, re-encodes it, and stores only that
bounded encrypted artifact with an expiry. Retrieval requires Manager access
and an exact Bot/action/object provenance binding.

## Authorization

### Native Telegram and speech

`telegram/` adds a transport to existing private owner channels, execution,
memory, Skills, resources and routines; it does not introduce a second agent
runtime or plugin marketplace. `/api/bots/:botId/telegram` exposes metadata-only
reads and manager-only configuration. Pairing, revocation, preferences and
delivery retry are member-scoped. `multi-user/runtime.js` supplies a freshly
resolved active account and effective `policy.bots` for every transport job.
Numeric Telegram IDs, ten-minute one-use nonces and confirmation inside DevRyan
bind a Telegram DM to the existing member channel. Groups and public access are
not supported. Saving connection changes requires re-pairing and invalidates
old generation-bound work; uncertain delivery is surfaced, never silently
re-executed. Unadmitted requests expire after fifteen minutes.

The background owner long-polls with a durable encrypted inbox/outbox and
database fencing; it never deletes another consumer's webhook or takes it over.
Text, bounded media and opted-in future routine results share canonical verified
answers. Text delivery precedes optional voice generation. Tokens use a separate
host credential vault and never enter agent environment secrets or containers.
The additive migration `20260831002620_bot_telegram_transport.sql` is optional
for existing Bots; missing Telegram tables surface setup-required metadata
without disabling ordinary Bot chat. Four service-only RLS tables and atomic
lease/ingest/pairing RPCs are documented in `telegram/DOCUMENTATION.md`.
Purge removes transport records and dedicated local credentials. Recovery
bundles intentionally do not export Telegram or speech secrets: configure and
pair again after restoring on another host. Production migration/release are
separate deployment steps.

`bot-voice.js` owns encrypted per-Bot speech settings under the host data root.
GET/PUT `/api/bots/:botId/speech` and POST `/speech/check` never return API keys.
Only explicitly configured OpenAI-compatible endpoints are used; native HTTPS
requests pin validated public DNS addresses, reject redirects, and permit
explicit loopback endpoints. Browser/global/API/OAuth credentials are never
inherited. Input accepts bounded validated Ogg Opus or MP3, at most five minutes
and 20 MiB. STT and TTS each run one job plus at most two waiting jobs per Bot,
with 120-second deadlines, a global 64 MiB memory budget, and bounded operation
deduplication. Empty transcripts fail without submitting prompts. Automatic
speech uses the exact verified answer with a 4,000-character limit and no
summarization turn. Speech failure never reruns successful text work. Purge and
shutdown abort jobs and erase retained audio; diagnostics contain no transcript,
audio, credentials or token-bearing URLs.

### Inline computer ownership

`computer-activity.js` publishes ephemeral channel-authorized `computer.activity`
containing only Bot/channel/run/revision/state after actual computer execution
starts. It is not inferred from prose or a persistent browser being open. SSE
snapshots reauthorize each channel. Automatic view tickets include the owning
run and are fenced both before and after asynchronous runtime preparation;
handoff aborts attached streams synchronously. Manual viewing remains Bot-shared.
No frames are placed in chat, diagnostics, Telegram or this activity projection.

An attributed control lease is bound ephemerally to its viewer. Stream teardown
uses the original actor and exact lease ID to relinquish only that lease, even
after account change or membership revocation. This release-only cleanup does
not perform a new privileged action or restart the computer. Control mutations
are serialized per Bot, including late takeover cleanup, so closing an old
viewer cannot relinquish a replacement viewer's new lease. Passive views do not
release unrelated control. Failed cleanup is diagnostic-visible; the computer
service keeps execution fenced until held input is safely released.

### Membership and channel authorization

Bot roles and channel ACLs are independent:

| Decision | Requirement |
|---|---|
| Bot membership | Active, non-revoked `bot_memberships` row |
| Operate | Operator or Manager |
| Manage | Manager (or global administrator for Bot-level administration) |
| Read own private channel | Active membership and channel ownership |
| Read shared private channel | Active membership and Reader/Collaborator ACL |
| Send to shared private channel | Active membership and Collaborator ACL |
| Administrator private read | Explicit break-glass reason and Bot audit event |

A Manager who is not the channel owner still needs a channel ACL to see the
transcript or decrypt its objects. This preserves personalized-channel privacy
while allowing Bot-level configuration management.

## Encrypted objects

The only Storage bucket is private `devryan-bot-objects`. Uploads are bounded to
25 MiB, restricted to the allowlist in `blob-store.js`, and verified from both
declared MIME and magic bytes/strict UTF-8 before any write.

For each object the server generates a fresh 32-byte object key and 96-bit IV.
Object bytes are encrypted with AES-256-GCM and object identity as associated
data. Supabase Storage receives only ciphertext. The metadata row records:

- ciphertext SHA-256 and exact byte size;
- algorithm/IV/tag/AAD version without the key;
- the object key wrapped by the OS-sealed deployment key;
- bounded content type and provenance.

Downloads require the exact current ACL, are bounded while streaming from
Storage, and verify size plus SHA-256 before unwrapping/decrypting. The public
projection omits Storage object names, wrapped keys, and all encryption
envelopes.

Publish-to-Library is copy-on-publish: the source is authorized and decrypted,
then re-encrypted under a new random object key as a `library` object. A new
immutable `bot_library_versions` row is inserted and the source pointer advances
with an optimistic revision check. Failure performs compensating cleanup; it
never mutates a private object into a Library object or widens its ACL. Host
imports use the same immutable object/version boundary after the reviewed scan;
their host paths and provenance remain deployment-key encrypted at rest.

Profile avatars use the same encrypted object pipeline with the distinct
`profile` visibility class, no channel, a same-Bot foreign key/pointer trigger,
and a 5 MiB PNG/JPEG/WebP database bound. They are never exposed through the
generic object catalog or a signed Storage URL.

Object deletion tombstones metadata first. Storage deletion failure returns a
visible `cleanupRequired` disposition so later purge/recovery can resume it.
Expired evidence objects fail closed before decryption.

## Capabilities

`GET /api/bots/capabilities` returns stable, mutually distinguishable states:

- `bots_starting`
- `supabase_unavailable`
- `migration_required`
- `unsupported_host`
- `encryption_unavailable`
- `docker_not_installed`
- `docker_stopped`
- `setup_required`
- `image_update_available`
- `index_rebuilding`
- `runtime_degraded`
- `healthy`

Only `healthy` is runnable. The payload advertises Electron runtime-management
availability but never exposes a mutation route. Capability resolution always
inspects the current Electron status before projecting a prior server-execution
failure; route reads reuse one Electron status probe for sixty seconds
(`?refresh=1` forces a new probe, failed probes are never cached, and any
execution-state change drops the entry), while per-run preflight and
host-driven reconciliation always probe live. When the host is healthy, the
server retries its execution composition
through a bounded single-flight reconciliation and clears the prior failure only
after durable run recovery succeeds. Routes resolve execution services dynamically
so a successful reconciliation does not require restarting DevRyan.
The listener does not wait for schema, retention, credential-vault, or execution
composition startup. While that bounded background startup is active, the
capability route returns `bots_starting` and every other Bot route fails closed
with a retryable typed `503`; schema and runtime-specific states replace it as
soon as startup settles.

## Audit retention

Bot security/lifecycle audit rows are separate from transcript content. Metadata
validation rejects content-bearing key families (prompt, message body, tool
output, credentials, cookies, tokens, and similar payloads), enforces bounded
JSON, and permits identifiers/digests/status codes needed for correlation.

`20260828210316_bot_terminal_error_audit.sql` owns terminal run observability.
Its `AFTER UPDATE OF state` trigger appends one dedicated Bot audit row whenever
a run distinctly enters `failed` or `interrupted`, including approval denial or
expiry and recovery paths. The row contains only Bot/run/channel/revision and
adapter/thread identifiers plus terminal code/phase/retry facts. Foreign SDK
and DOM failures cross a normalization boundary before this write: timeouts
(including numeric DOM code 23), aborts, and unknown errors become bounded
string codes, and diagnostics retain a content-free failure stage. A retry may
later produce another terminal transition and therefore another event; repeated
writes of the same terminal state produce none. Existing terminal rows are
backfilled only when no matching run diagnostic exists.

`20260901160000_bot_runtime_scope_and_audit_repair.sql` adds the idempotent
`devryan_settle_bot_run_terminal` service RPC. It locks the run, returns an
already-terminal row unchanged after uncertain commits, or persists
`failed`/`interrupted` while releasing its lease. The existing trigger appends
the audit row in that same transaction. Dispatcher publication uses only the
returned persisted row and retries boundedly; exhaustion writes a sanitized
`bot.turn.terminal_persistence_failed` journal mark. Startup recovery uses the
same RPC when an orphan cannot be resumed. The migration also backfills missing
terminal evidence by inspecting the immutable ledger, so cleared review records
prevent duplicates just like visible records.

`audit-query.js` exposes this append-only ledger through exact-managed-admin
`GET /api/bot-audit`, `/api/bot-audit/options`, and
`/api/bot-audit/:eventId`. The default result set is
`failure | partial | unknown`; denied and successful events remain available by
explicit filter. Reads use `(created_at, id)` keyset cursors, hydrate Bots and
actors in batches, and replace invalid legacy metadata with a redaction marker
per row. These routes assert the schema marker but intentionally bypass Bot
execution-health middleware so Docker or adapter degradation cannot hide prior
evidence. `DELETE /api/bot-audit?range=24h|7d|14d|30d|all` clears the review list for
all administrators, independently of list filters. Migration
`20260830180651_bot_audit_clear.sql` adds the service-only
`devryan_clear_bot_audit` RPC, which atomically inserts per-event dismissal
records with administrator attribution and a bounded server timestamp. It
requires an active administrator and preserves every immutable ledger row.
Listings use the security-invoker `bot_audit_review_events` view. Migration
`20260902120000_bot_audit_resolution_and_read_only_retry.sql` annotates any
failed/partial/unknown event when the same Bot target later has a matching
success, `.requeue` success, or `.retry` success. A `bot_run` issue also resolves
when its durable run later completes. List/detail responses expose
`resolvedAt` and the resolving event ID when one exists; the default Issues
query hides those resolved projections, while All and UUID detail keep the
immutable history visible. Repeated clears count only newly cleared
events; events inserted after the snapshot remain visible. Dismissals cascade
away only when retention removes their corresponding ledger events. Missing
clear schema returns an explicit migration-required error without falling back
to deletion or browser-only state. Web and Electron share these routes; the
managed-host settings page remains limited to authorized hosts.

Retention defaults to 365 days and is configurable through
`DEVRYAN_BOT_AUDIT_RETENTION_DAYS`. Values below the database-enforced 30-day
floor fail configuration. Pruning first crosses the managed audit-outbox
delivery barrier exactly once, then calls the fixed security-invoker RPC daily;
transient control-plane failures are retried without taking the existing
multi-user runtime offline.
