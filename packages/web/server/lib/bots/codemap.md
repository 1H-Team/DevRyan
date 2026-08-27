# packages/web/server/lib/bots/

## Responsibility

Server-owned Production Bots control plane and scoped execution boundary:
explicit Supabase repositories, principal-aware authorization, encrypted
private object persistence, immutable revision config, selected-provider and
legacy-agent credential compatibility, typed Docker/reasoning adapters, a capability-bound
loopback gateway, continuous encrypted channels, durable scoped run dispatch,
principal-filtered Bot events, capability projection, content-free Bot audit
retention, hard safety policy, confirmations, browser control, and selective
evidence, plus simplified settings, asynchronous event-driven memory,
computer-resource import/retrieval, optional revision-pinned Skills, private
run-local artifact materialization, and resumable full purge. Legacy revision,
Library, MCP, AG-UI, recovery, signed-spec, and structured-policy code remains
only for deployed compatibility, migration, cleanup, or security integrity.
Bot-wide write-only environment-secret vaulting, authorized container
  metadata browsing, Bot-wide persistent Shared-file mappings/imports and
  automatic generated-image publication, plus durable Bot profiles, encrypted profile avatars, sanitized model
options, and exact save-gate-publish semantics.
Domain logic stays out of `multi-user/runtime.js` and the
Electron shell.

## Entry points

- `index.js`: public module exports.
- `runtime.js`: focused composition root receiving only Supabase, platform
  audit, principal policy, data directory, Bot host, and encryption callbacks.
- `routes.js`: authenticated `/api/bots/*` capability, management/routine,
  channel/message/run, Bot-SSE, and encrypted-object routes plus stable
  migration/error envelopes, including profile/avatar/model-option/publish
  contracts.
- `store.js`: one explicit-select repository per Bot table, cursor paging,
  optimistic `updated_at` writes, fixed exact-version publish RPCs, and private
  Storage delegation.
- `management.js`: global-admin creation, settings-authorized catalog/detail operations,
  authoritative create capability, optimistic durable profiles and internal
  setup revisions, encrypted avatar publication/compensation, secret-free
  model/OAuth-connection projection, membership and allowlisted credential
  metadata, API-key vault create/rotation rollback, save-gate-publish,
  post-commit management events, lifecycle transitions, read-compatible
  historical eval cases, and granular purge previews.
- `capability-bindings.js`: safe Skill summaries, optimistic per-Bot Skill
  attach/detach, managed-path translation, encrypted Skill snapshots,
  activation gates, and exact binding-to-package resolution. MCP attach returns
  `410`; retained MCP read/detach/cleanup paths support legacy data only.
- `mcp-connector.js`: unregistered legacy connector implementation retained for
  deployed-data migration tests; `runtime.js` does not expose it to Bot execution.
- `computer-resources.js`: bounded no-follow local file/folder import into the
  persistent computer, encrypted manifest/index projections, Finder source
  mapping, and deterministic retrieval-index rebuild input.
- `workspace-connector.js`: approval-gated single-file writes into the owned
  reasoning workspace through Electron's typed supervisor callback; it exposes
  no host path, volume, Docker, or generic filesystem surface.
- `shared-files.js`: authorized conversation file mappings, deterministic safe
  Shared paths, verified import/retry/recovery, queue readiness, and projections.
- `shared-connector.js`: explicit bounded Bot publication into Shared; it
  accepts bytes, never a host/computer path or directory scan.
- `authorization.js`: active membership, Member/Operator/Manager, channel
  Reader/Collaborator, owner privacy, and audited administrator break glass.
- `blob-store.js`: MIME/magic validation, per-object AES-256-GCM, wrapped keys,
  ciphertext integrity, private bucket access, bounded profile avatars,
  deletion disposition, and immutable Library publication.
- `source-scanner.js`: bounded Manager-selected host traversal with no-follow
  reads, containment/identity checks, exclusions, secret detection, and safe
  review projections.
- `library-runtime.js`: encrypted source/provenance records, transient reviewed
  scans, immutable publication/diffs, exact-version retrieval, run snapshots,
  and the memory-plus-Library local-index rebuild boundary.
- `artifact-service.js`: authorized private-object and pinned-Library plaintext
  staging under one fixed per-run root, bounded UTF-8/native/mounted attachment
  classification, explicit copy publication, and deterministic cleanup.
- `audit-retention.js`: content-free Bot audit events and the one-year/default,
  30-day-minimum retention job.
- `validation.js`: strict JSON/UUID/base64/page request boundaries.
- `encryption.js`: exact deployment-key AES-256-GCM JSON envelopes.
- `credential-vault.js`: host-local encrypted connector credential lifecycle.
- `environment-secret-vault.js`: atomic host-local encrypted Bot environment
  values, opaque recovery export/restore, rotation/delete compensation, and
  Bot-scoped purge.
- `environment-secrets.js`: Manager-only write-only metadata API, validation,
  complete per-run JSON materialization, terminal cleanup, and purge boundary.
- `recovery-bundle.js`: versioned scrypt/AES-256-GCM manifest/section format,
  compatibility validation, secret-section confirmations, and global-admin
  restore boundary.
- `recovery-adapter.js`: explicit control-plane/ciphertext export, pre-mutation
  collision validation, compensating restore, and typed host/control-plane
  purge operations.
- `purge-runtime.js`: private atomic per-Bot job journal, ordered per-resource
  results, explicit granular retry, server-derived one-shot full deletion with
  automatic retirement/resume, final control-plane deletion, and delegation to
  the audit-retention service's single delivery barrier.
- `config-compiler.js`: deterministic legacy/v3 compiler branches, immutable
  OpenCode/AG-UI bindings, structured matcher precompilation, browser/computer
  policy, scoped tools/subagents, private per-channel OpenCode configuration,
  and exact read-only assigned Skill materialization. Legacy active JSON and
  compiled hashes are never rewritten.
- `reasoning-adapter.js`: provider-neutral lifecycle and normalized ordered
  run/text/tool-intent/artifact/checkpoint/usage event contract.
- `opencode-reasoning-adapter.js`: OpenCode session/segment/event translation,
  recovery, cancellation, warm leases, image export, and structured completion.
- `ag-ui-reasoning-adapter.js`: pinned `@ag-ui/core@0.0.58` reviewed SSE subset,
  exact event ordering/size/replay checks, sole `devryan_bot` tool contract,
  continuation via ToolMessage, and fail-closed recovery.
- `agent-connections.js`: Bot-scoped Manager CRUD, encrypted bearer resolution,
  exact public HTTPS/SSE descriptors/digests, health checks, revocation, and
  activation gates.
- `bot-spec.js` / `bot-spec-signer.js`: deterministic portable revision export,
  Ed25519 integrity/trust verification, strict import preview, immutable local
  binding resolution, and draft-only creation through normal publication gates.
- `model-credential-broker.js`: ordered catalog/credential/egress model
  selection, chosen-model persistence, one-provider scoped auth, and refresh
  ingestion/removal.
- `model-catalog.js`: authenticated, deadline-bound, streaming-size-bounded
  loading plus secret-free Bot projection of the host OpenCode provider/model
  catalog, safe auth kind, and opaque existing OAuth-connection selectors.
- `gateway-host.js`: random-token, loopback-only, Docker-origin private tool
  gateway with exact claims and bounded bodies/responses.
- `docker-provider.js`: strict adapter over Electron's fixed scoped-resource
  callbacks; it has no raw Docker command surface.
- `opencode-provider.js`: scoped OpenCode lifecycle used behind the OpenCode
  reasoning adapter, pinned-model prompts,
  disposable purpose-bound strict-JSON/no-tools runs for memory extraction and
  routine drafting, canonical event forwarding, capability rollback,
  credential finalization, and shutdown.
- `response-sanitizer.js`: deterministic public-text boundary that excludes
  provider-hidden/synthetic parts, internal reasoning/tool protocol blocks,
  and leading agent-work labels before streaming, persistence, or history
  projection.
- `indexer-client.js`: bounded exact-namespace client for the Electron-owned
  loopback retrieval index.
- `memory-classifier.js`: strict extraction schema plus leakage, secret, scope,
  subject, and provenance classification boundary.
- `memory-runtime.js`: asynchronous completed-run extraction, encrypted
  immutable version commits, Remembered/Forgotten administration,
  `memory.changed` publication, index rebuild, and tracked shutdown.
- `memory-consolidation.js`: bounded runtime-owned exact-duplicate planning and
  conflict-safe coalesced sweeps.
- `routine-drafter.js`: exact JSON schema and no-tools conversational drafting
  boundary that restores rationale/timezone and returns only a
  review-required candidate.
- `routine-runtime.js`: structured contract validation, timezone-aware
  occurrence calculation, atomic cross-process claims, bounded missed-run
  recovery, active-revision admission, lifecycle/checkpoint control, and the
  action-gateway routine guard.
- `channels.js`: idempotent owner channels, current-ACL reads/sends, encrypted
  canonical messages/checkpoints, atomic message/run/Shared admission, and authorized
  safe catalog/channel/run/finalized-preview snapshot plus audience projection. Public runs omit
  adapter-specific execution identity.
- `context-assembler.js`: bounded revision/checkpoint/message/memory and retained
  legacy-Library context plus the runtime-owned conversational response-style
  instruction and deterministic continuation decisions. Legacy MCP assignments
  do not contribute executable tools.
- `run-dispatcher.js`: agent-neutral fast atomic acceptance with pending adapter/model snapshots,
  post-response scoped FIFO claims, concurrent startup, requester-only coalesced
  streaming, safe same-run retry, content-free timing milestones, attachment
  delivery, normalized adapter error classification, generic execution-handle recovery, checkpoint finalization,
  cancellation, timeout, and finalized generated-image secure export/publication
  before reasoning teardown.
- `prewarm-cache.js`: four-entry/five-minute non-secret channel/revision LRU,
  30-second model-catalog singleflight, health/config warming, and invalidation.
- `warm-runtime-leases.js`: principal/channel/revision/Library-bound two-minute
  reasoning-runtime leases, two-entry LRU, atomic run-ID adoption, and cleanup.
- `stream-access-lease.js`: short-lived requester stream authorization with
  fail-closed revalidation and synchronous revocation invalidation.
- `run-recovery.js`: restart inspection of durable runs/action attempts and
  fail-closed reconciliation for interrupted writes.
- `event-stream.js`: snapshot-first, monotonic, principal-filtered Bot SSE kept
  separate from ordinary OpenCode event state.
- `connector-registry.js`: complete connector interface with isolated-workspace
  and explicit Shared-publication connectors registered in production and
  fail-closed dispatch for unknown connectors. MCP is not registered.
- `policy-engine.js`: strict v1/v2 action/browser policy validation, bounded
  actor/URL/file/argument/glob matching, precedence, risk and separation of
  duties, authoritative fact normalization, quota requirements, expiry, and
  canonical exact-decision binding.
- `approval-service.js`: immutable exact-action approvals, pending projections,
  atomic expired-approval cancellation/run failure, settlement/audit events,
  and requester confirmation available to active members.
- `action-gateway.js`: encrypted durable attempts, atomic quota
  reservation/consumption/release with idempotent proposed-state recovery,
  execution-time policy-fact revalidation,
  idempotent read/write dispatch, revision-plus-routine policy narrowing, result receipts,
  unknown-write quarantine, and explicit Operator reconciliation without replay.
- `browser-service.js`: scoped computer lifecycle, reviewed command grants,
  transient screencast proxy, and attributed human-control leases.
- `computer-runtime-manager.js`: one continuously supervised computer per
  Active Bot, isolated health recovery, and lifecycle/shutdown stops.
- `evidence-service.js`: policy-selected PNG crop/redaction, expiring encrypted
  evidence, and exact Manager-only retrieval.

## Data flow

1. `multi-user/runtime.js` creates this runtime after Supabase and actor audit
   exist, then delegates route registration and shutdown.
2. Routes validate exact request shapes before authorization or persistence.
3. Authorization reads current Bot membership/channel ACL rows; Managers have
   no implicit private transcript access.
4. The management service exposes revision contracts only to Managers, keeps
   durable profile presentation outside revisions, keeps Active revisions
   immutable, and saves then requires every activation gate to pass before
   publishing the exact saved revision/hash. Optional Skill assignment requires
   an internal editable configuration and exact `updated_at`, snapshots before
   mutation, records immutable package IDs/digests, and compensates partial rows
   and objects on failure.
5. Blob uploads are validated, encrypted under a random object key, uploaded
   as ciphertext, and then recorded with a deployment-key-wrapped object key.
6. Repositories send explicit selects/writes and log field names only. Mutable
   records require an `updated_at` precondition; multi-row transitions use the
   migration-owned fixed RPCs.
7. A healthy control plane starts the private gateway before any container.
   Model selection creates only the chosen provider auth directory; Electron
   then signs/attests the exact egress allowlist and asks the fixed supervisor
   to start the scoped runtime. Reasoning publishes no host port; Electron
   returns only the supervisor's loopback endpoint and scoped path to this
   in-process server.
8. Channel message admission completes every authorization/model/runtime
   preflight and stores required compatibility snapshots before one database RPC inserts the
   encrypted user message, queued run, and attachment-to-Shared mappings.
   Durable claims serialize each channel FIFO and refuse its head until every
   required Shared copy is ready.
9. The dispatcher rebuilds context only through the admitted message sequence,
   remembered facts, computer references, and any retained pinned Library versions; it materializes only authorized private objects,
   passes the prior generic execution handle to the pinned adapter, coalesces assistant checkpoints,
   publishes authorized canonical `message.updated` projections, and finalizes
   the canonical message on terminal state. Finalized image-generation tool
   outputs are canonicalized and encrypted onto that result message before the
   reasoning container is stopped; Shared copying is asynchronous.
10. The Bot event runtime loads an authorized snapshot, then releases queued
    live events in epoch/sequence order. Snapshots/finalized message events carry
    authorized channel previews without loading every transcript. Startup recovery resumes only runs whose
   action ledger contains no unsafe unknown write.
11. Tool calls enter the action gateway, which validates the connector/browser
    boundary, binds policy to an exact durable attempt, and either denies,
    requests a qualified approval, returns an idempotent receipt, or executes.
12. Browser transport uncertainty after a write persists `unknown` and pauses
    the run until an active member records an explicit non-replaying reconciliation.
13. A finalized run publishes completion and schedules its no-tools extraction
    follow-up asynchronously. Accepted facts enter shared, owner-private, or channel-only
    layers through immutable optimistic versions and exact local index
    namespaces.
14. Conversational routine drafting runs in a disposable no-tools scope. After
    review/activation, the app-open scheduler claims a due occurrence,
    reloads current lifecycle/membership/revision state, and admits an
    occurrence-idempotent run with the exact structured contract snapshotted.
15. Retained compatibility recovery can include the durable profile and encrypted avatar, selects
    only reviewed protected/secret sections—including the separately confirmed
    environment-secret vault—then
    Electron writes the passphrase-encrypted bundle natively. Restore validates
    compatibility, integrity, references, and collisions before mutation.
    Granular purge journals every host/database step and exposes partial results;
    one-shot complete deletion automatically retires live Bots and resumes prior
    incomplete work.

## Invariants

- Browser clients never receive Storage paths, wrapped keys, encryption
  envelopes, signed URLs, or plaintext secrets.
- Supabase Storage is service-only and private; downloads are bounded before
  allocation and verified against ciphertext size and SHA-256.
- Reader can read, Collaborator can read/send, and neither ACL grants Bot
  operation/management. Active Bot membership is always required.
- Bot creation is global-admin-only and atomically installs its first Manager.
  Per-Bot serialized membership writes cannot revoke or demote the final active
  Manager.
- Profile edits require the exact Bot `updated_at`. Avatar pointers can reference
  only live `profile` objects owned by the same Bot; conflicts remove the newly
  uploaded object and replacement cleanup remains resumable.
- Draft updates require the exact previously-read `updated_at`; a conflict is
  explicit. Active revision content cannot be changed; publish locks the exact
  saved timestamp/hash, and future work adopts it without repinning in-flight
  runs.
- Legacy contracts that omit Skill/MCP fields keep their prior canonical hash.
  New and newly saved configurations emit no MCP bindings; ordinary writes
  cannot forge Skill IDs/digests, and immutable Skill package rows cannot be
  changed in place.
- Skill snapshots follow no links, reject secret-like/unsafe/oversized files,
  are mounted read-only from the compiled revision, and allow only assigned
  skill names. Autonomous revisions may use selected confined shell/Git tools
  and non-recursive native task delegation, but never raw browser/CDP, direct
  MCP, Docker, host orchestration, external directories, or host credentials.
- MCP attachment is removed and returns `410`. Legacy MCP records are readable,
  detachable, and purgeable only; no MCP connector is registered for execution.
- Draft simulation uses a dedicated test computer/profile scope with external
  mutations disabled. A live canary is a separate, exact-name-confirmed path.
- Routine rationale is non-executable. Activation requires explicit review of
  the structured contract, claims happen before run creation, and a
  routine can only narrow—not widen—the active revision's action policy.
- Paused, retired, revoked, or runtime-offline routines do not advance their
  due state. Startup recovery is bounded to three occurrences, recovered writes
  require fresh approval, and no scheduler timer survives app shutdown.
- Global administrators must provide an audited break-glass reason to read a
  private channel they do not own; Manager role alone is insufficient.
- Library publication copies/re-encrypts into a new object and inserts a new
  immutable version. The private source object is never reclassified.
- Host source scanning is Manager-selected and manual. It follows no links,
  watches no directory, rejects unsafe or sensitive content, and never exposes
  a host path or provenance to an ordinary member.
- A run snapshots exact immutable Library version IDs at admission. Later
  publication changes only future runs; index rebuild includes active memory
  and every Library version.
- Setup-only Bots never enter chat snapshots. Publication emits authorized
  Bot/revision/membership events after commit; lost delivery is repaired by the
  reconnect snapshot rather than rolling back publication.
- Publication readiness preserves schema, runtime image, model/credential,
  egress, tool, and hard safety gates. The Skill gate exists only for non-empty
  assignments; legacy Library/MCP data does not create a new configuration gate. Model and assignment checks remain independent
  of runtime health so a Docker failure cannot create false dependent blockers.
  Historical evaluations are retained but are not a gate, and their mutation
  routes are deprecated.
- Bot API keys exist only as normalized OpenCode auth records in the encrypted
  host vault. Supabase and public projections receive allowlisted metadata;
  failed create/rotation persistence compensates the vault exactly.
- Bot environment values exist only in the dedicated host-encrypted vault.
  Supabase stores names/status/references only; reasoning admission requires a
  complete active snapshot, and the computer container never receives it.
- Plaintext artifacts exist only in the fixed private per-run staging root,
  are mounted read-only after Electron validation, and are cleaned on every
  terminal, timeout, failed-start, and shutdown path.
- Durable Shared mappings expose only conversation-authorized metadata. Exact
  private-object bytes are copied through the fixed supervisor import to the
  Bot-wide `/workspace/Shared` volume and marked ready only after size/hash
  verification; failures remain retryable without a duplicate message.
- Automatic image rows are idempotent by run/tool/path source key and remain
  authoritative inline attachments even while the best-effort Shared-volume
  copy is pending or failed. Export/upload failure terminates visibly.
- Audit metadata rejects prompts, bodies, outputs, credentials, and other
  content-bearing fields before persistence.
- Compiled revision directories are immutable and content-verified; runtime
  auth contains exactly one provider and is deleted after refresh ingestion.
- Private gateway bearer values, model credentials, and model-egress tokens
  never enter public runtime projections or logs.
- Failed Docker/model/runtime preflight performs no database write; successful
  admission creates the user message and queued run atomically and idempotently.
- Reasoning runs are serialized by channel scope, the computer is always
  Bot-wide, and the database claim RPC—not the process-local drain—is the lease authority.
- Context never includes messages newer than the run's admitted message
  sequence. Clients resume from Supabase sequence, never OpenCode history.
- Each run has one unresolved/result assistant row for tool-free work, or one
  finalized acknowledgment plus one result row for tool work. Pending
  checkpoints write at most twice per second and terminal message content is
  immutable.
- Bot SSE filters the principal before serializing private identifiers or
  payloads and never enters the ordinary session/message stores.
- Interrupted writes are never replayed automatically; their runs enter
  `needs_reconciliation` with durable action-attempt identifiers.
- Restart reconciliation asks the pinned adapter to inspect the persisted generic
  execution handle before deciding to reattach, finalize, or submit a missing prompt.
- Recovery claims the persisted run optimistically before starting Docker and
  defers when another live process or concurrent claimant owns the lease.
- Action approvals cannot authorize changed arguments, target, revision,
  credential/computer scope, initiator, limits, or an expired decision.
- The production connector registry contains only `connector:mcp`,
  `connector:workspace`, and `connector:shared`; unregistered or unassigned tools never reach
  authorization or execution.
- Browser interactions require an exact origin/goal/operation capability.
  Arbitrary sites provide no native exactly-once receipt, so uncertain writes
  are never retried automatically.
- Screencast frames are transient. Retained evidence is policy-selected,
  target-bounded, redacted, expiring, encrypted, and Manager-only.
- Ordinary members cannot enumerate memory. A stale automatic or consolidation
  version is retained but cannot replace a newer Manager edit; channel deletion
  removes private memory while explicitly preserving shared learning and
  tombstoning its deleted provenance.
- Recovery bundle bytes and decrypted sections never enter the renderer.
  Connector credentials and browser profiles are excluded by default and need
  independent high-risk confirmations.
- Restore performs no mutation before complete integrity/compatibility/collision
  inspection. Granular purge requires Draft/Retired lifecycle, exact name,
  optimistic revision, and a durable per-resource journal. Complete deletion
  retires Active/Paused Bots server-side and derives the full resource set; audit
  rows survive Bot deletion. The service-only terminal delete also accepts never-activated Draft fixtures and
  permits only the foreign-key `bot_id` cleanup on retained audit rows.

## Tests

`*.test.js` files colocated here cover validation, repository boundaries,
authorization, object encryption/integrity/publication, capability states,
routes, retention, channel idempotency/ACLs, context/segment boundaries,
controlled FIFO and cancellation interleavings, restart reconciliation,
snapshot-before-live event ordering, policy precedence, approval separation,
idempotent action execution, unknown outcomes, human control, and selective
evidence, plus extraction leakage/classification, immutable version conflicts,
Manager edits, channel-source deletion, consolidation, and deterministic full
index rebuild. Routine tests cover IANA/DST calculation, duplicate process
claims, bounded missed policies, restart/idempotency recovery, lifecycle and
membership blocks, current-revision rollout, queue fairness, exact gateway
limits, fresh approvals, and unknown-write reconciliation. Library tests
additionally cover traversal/symlink/secret
rejection, encrypted provenance, review diffs, immutable publication, exact run
pinning, private ACL preservation, bounded staging cleanup, and cross-domain
index rebuild. Recovery tests cover wrong passphrases, corrupt/truncated
bundles, safe versus secret selections, compatibility/collision rejection,
native atomic file handling, partial purge restart/retry, shared-memory channel
deletion, binding-aware recovery/purge, and full Bot purge. Capability tests
cover legacy hashes, immutable snapshots, unsafe skill files, optimistic
conflicts/rollback, credential scope, local/remote MCP fixtures, manifest drift,
generated prompt policies, bounded output, and uncertain-write reconciliation.
Supabase client Storage transport tests
remain under `../multi-user/supabase-client.test.js`; composition coverage
remains in `../multi-user/runtime.auth.test.js`. The pgTAP suite in
`supabase/tests/production_bots.test.sql` proves service-only atomic admission,
identity conflict handling, and one-scope claim semantics.
