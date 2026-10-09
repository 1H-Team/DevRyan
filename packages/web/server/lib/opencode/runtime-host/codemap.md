# Native OpenCode host

The current package and compiled host pin is OpenCode 2.0.26. Artifact verification
also accepts retained 2.0.24 and 2.0.20 bundles for rollback, each using its matching
controller. Cross-version credential capture or projection cannot substitute a
controller: exact OpenCode version, core digest and existing manifest checks still
apply. The build pins PTY 0.2.0 bytes and the 2.0.26 compaction observation source
(`location-services-qhaz1dgr.js`, behavior unchanged from 2.0.24). A pinned
`@opencode/schema` agent-defaults transform restores the 2.0.24
`external_directory: * → ask` default that 2.0.26 removed.

`native-bundle-compatibility.js` admits cross-release clones only for the reviewed
2.0.20/2.0.24/2.0.26 core digests, exact SQLite schema and migration metadata, and declared
clone/credential-owner contracts. Two layouts are reviewed: a legacy-imported database
with its `__drizzle_migrations` table, and the fresh-install database every 2.x install
creates from an empty source, which has no such table (`migrationsSha256: null`). 2.0.26 adds a data-only Azure CLI credential
migration, so a database never clones from 2.0.26 into an older release. It reads no account values. The lifecycle uses
each original controller for cross-release credential capture and projection;
same-core replacement capture retains its existing strict check. Compiled package
qualification accepts `--baseline-artifact-root` to prove the retained old release
against the candidate, including rollback; a same-release baseline proves no
cross-release compatibility. It covers both layouts: the main lane clones a
legacy-imported baseline, and a separate fresh-install lane clones a baseline
imported from the production zero-byte `empty.db`. Each lane checks its baseline
against its own reviewed layout, then runs the forward clone, the candidate
controller, rollback with original-controller credential projection, and a
baseline restart.

`runtime-bundle-lifecycle.js` can retain one frozen, constructor-only held
checkpoint grant. It reserves ownership before selection reads, rechecks the
selector after settlement, and exposes only the genuine action-scoped
`assertHeld`. Failed settlement revokes the grant; expired scopes cannot revive
during a later action. This grant is absent from HTTP and Electron APIs.

`native-command-refusal.js` distinguishes correlated replies and commands never
dispatched from uncertain transport failures. The integration owner preserves
the controller after finite refusals. Uncertain commands hold the credential
queue through `native-process.js`'s verified child termination ACK, then allow
queue-dependent owner cleanup to finish; the original full-cleanup exit ACK is
unchanged. Provider workers expose failure state and require their own verified
termination before replacement or successful drain.

`native-claude-enrollment.js` records a fingerprint-only `enrollment-prepared`
intent in the original lifecycle KV before the exclusive vendor write. It is
not renewal authority. Fresh authorized selection settles only its matching
vendor record, so revocation or a lost settlement reply does not orphan a grant
or retry the issuer. Unavailable directories are individual list rows; unused
live starts remove only their own empty directories. The control root is private
before issuer work. `native-claude-lifecycle.js` reserves renewal-intent space
when accepting a new account. A lost begin acknowledgement is reconciled only
for the exact physical owner's proved undispatched attempt; ambiguous dispatch
and unverified receipts remain fenced.

`native-provider-timing.js` binds response measurements to committed native
request observations and real attempt spans. `native-observation.ts` emits
content-free first-response measurements without delaying provider streams.
The web turn-timing owner journals bounded marks and ledger/bridge aggregates;
its HTTP routes require diagnostic permission and session ownership.
`first_output` observes typed reasoning, answer text or active tool publication;
`first_text_output` observes answer text only. They preserve the older
text/reasoning `first_text_delta` metric. Part types are retained for at most 64
announcements until answer text arrives; unknown types leave timing absent.
Projected native idle carries its inbox identity. The timing owner settles that
exact record and keeps any newer send active; unknown identities are ignored.

`native-setup-source.js` owns the private sibling fresh seed, including canonical
ownership checks, mode repair before any native launch, and complete removal only
after verified selection. Removal renames the seed to a sibling
`.fresh-native-source.removing-*` (parent fsynced) before deleting it, and every launch
sweeps validated (owned, unlinked directory) leftovers under the bootstrap lock without
re-verifying them. Failed preparation retains the complete seed and its
atomic `native-setup-seed.json` pins. Inside the bootstrap lock,
`resetAbandonedNativeSetupSource` removes only the four seeded trees (`web-data`,
`web-config`, `opencode-config`, `home`) of a stamped seed whose marker is absent
while neither `selection.json` nor any `bundles/*` draft exists, so a failed
first seed reseeds current owner setup; every other partial seed keeps the
identical-retry rule and a completed seed still refuses changed files. A pinned seed older than the
live source stays the setup input until a selection consumes it: owner setup changed after pinning
(including a newer `auth.json` sign-in) is neither imported nor a reason to refresh or refuse the
seed, so those changes are made again in the native runtime; tampered pinned rows refuse with
`native_setup_seed_changed` and no values. A half-deleted
2.0.0 seed (2.0.0 removed it in place: marker or pinned files gone, no remaining pinned byte
changed) is never seeded from: without selection or drafts the same reset rebuilds it,
stamped or not, and after verified selection removal validates the whole canonical tree and
completes the rename-aside removal instead of refusing every launch. Custom configuration remains a separate
`native-custom-config.json` layer; Slim JSONC, declarative tunnel registration,
prompt overrides and logical local-owner identities retain their original owners.

`retained-native-artifacts.js` retains every verified manifest-owned file under
the existing bundle control root before application Resources can be replaced,
including the reviewed Claude host credential module and the complete accepted
Windows MinGit tree. Its inventory cap is 4096 only for the pinned Windows Git
contract; other targets keep the 256-file cap. Under `artifacts/retention.lock` it
sweeps abandoned `.retaining-*` copies and restarts a reused set's age.
`pruneRetainedNativeArtifacts` removes (rename to `.pruning-*`, then delete) only sets at
least an hour old that no selected, previous, newer-than-selected draft, rollback intent or
selected/previous rollback baseline references; owned unlinked directories only, and any
unreadable reference prunes nothing. `runtime-bundle.js` clones
the current coherent V2 database and stores through `source.kind='bundle'`, under
`bundle-checkpoint.js`'s original controller/admission/drain fence. It retains the
original import receipt as provenance rather than presenting a new V1 import.
`native-boot-migration.js` binds cloned receipt provenance through the selected
prepared manifest, descriptor and clone hashes to the new bundle/database/artifact.
Its prepared hash comes from the frozen selection, never from a resealed file.
It reads no source bundle and preserves exact non-clone receipt checks. Sealed
bundle documents share the original 32MiB bound; the boot envelope stays 4MiB.
The checkpoint scope expires after copying and rejects a replacement controller.

`native-bundle-credential-contract.js` is the finite private recovery boundary;
`native-bundle-credential-process.js` verifies retained artifacts and closed scope,
then uses bounded private pipes and confirmed process exit. Capture may use a
verified new controller against compatible old data; projection always requires
the target's own compiled contract. `native-bundle-credentials.ts` uses the
original Credential/Database/KV services for exact credentials, active choices,
removals, host refresh-block state and Claude lifecycle metadata under
`devryan.bundle.credentials/2`. Its durable private intent permits recovery
after native commit but refuses changed baselines or newer ambiguity. Bundle
manifests and rollback receipts contain hashes only. Known incompatible rollback
targets refuse before closing current admission. Once projection begins, an
unresolved transition holds both bundles for inspection with candidate work preserved.
`bundle-credential-owner-guard.js` seals checkpoint fingerprints for Meridian
profiles/settings and account files, managed quota connections, and paired
authorization/branch-preview vaults. Only typed account-directory relocation is
normalized; preserved Keychain identity and all other semantics remain exact.
Host-owner protocol `devryan.bundle.credential-owners/2` compares the multi-user
vault through its original authenticated codec, excluding only validated local
root-session ownership while retaining every owner, login token, policy, expiry,
unknown record and the exact paired key. It never imports candidate ownership
into the old bundle. Historical `/1` rollback baselines refuse reinterpretation;
sealed boot evidence retains strict recognition of either version. New clone
preparation requires that exact `/2` compiled contract on the verified target
before checkpointing or copying, including when artifact manifests match.
Existing nonclone legacy imports and rollback targets retain their old receipts.
Activation compares a clone against its current source. Rollback compares both
bundles against the sealed source baseline before and after native projection;
missing, changed or unreadable owner evidence selects held inspection with
`bundle_credential_owner_unsupported`. It never merges secret files or grants.

This candidate embeds the pinned OpenCode 2.0.20 SDK in Bun. Production
activation remains gated by integrated native acceptance and agent parity.
The Node web process retains the existing ledger, supervisor and scheduler.

`runtime-bundle-lifecycle.js` connects verified application-resource updates to
the real application owner: close admission, stop producers, drain credential
resolution and mutations, obtain controller quiescence/exit and drain stores
before copying. Administrator HTTP mutations accept only an expected selector
revision. The returned server handle exposes the same lifecycle for Electron;
new selection needs host recomposition.
`native-bundle-startup-upgrade.js` drives the same `upgrade` from provisioning,
inside the bootstrap lock and before any data owner or controller exists. It runs
only when the selected bundle's OpenCode version misses the application pin and the
shipped artifacts carry exactly the pinned version; it never downgrades. Its cold
owner is `neverStarted` (no controller) and every held step re-proves that no other
process owns the source: no live owner or controller in the bundle's managed-process
registry and no live holder of its orchestration owner lock. An unsealed candidate
left by a killed attempt is moved aside first. Failures keep the selection and are
recorded in `bundle-startup-upgrade-status.js`; the lifecycle then refuses a
below-pin runtime before launch with `bundle_upgrade_required`, naming the version
pair and that code. POSIX only: Windows owners hold OS locks this check cannot observe.
The committed selector schedules recomposition once after response completion
or disconnect, including a caller lost while the checkpoint was settling.
Once a checkpoint starts closing admission the lifecycle is held for the rest of
the process: it never reports
`ready` again and refuses further upgrade/rollback with
`bundle_runtime_admission_held`, keeping the original failure as `reason`. A
failure before any checkpoint keeps the prior state. Inspection reports
`rollbackAvailable` only when the rollback route would proceed. `runtime-bundle-recovery.js` is the cold
held startup path: loopback status and an explanatory page, with no provider,
feature-store or controller startup and no fabricated checkpoint acknowledgement.
`bundle-rollback-intent.js` publishes the digest-bound checkpoint, drain, owner-exit
and retained-state proof before projection, and seals completion before selection.
`runtime-bundle-binding.js` recognizes pending intent even when selection still
names B. `runtime-bundle-resume.js` verifies that original proof and unchanged B
before incrementing the selector revision and clearing the hold for a fresh
composition. The CLI `runtime bundle resume --expected-revision N` and trusted
Electron IPC use this same core. Recovery HTTP exposes no mutation route.
The cold page recognizes only bounded finite native codes from the original
Electron invoke error envelope; it never displays arbitrary transport text.
`runtime-bundle-root.js` resolves one validated absolute root for CLI, shell
inspection and default provisioning. Empty XDG state uses the home default;
relative authority and an empty explicit bundle root refuse before owner access.

- `runtime-bundle-binding.js` reads only the explicitly selected bundle before
  the web store owners initialize. It binds copied configuration and data without
  changing the parent process's HOME. Unresolved rollback state refuses execution;
  explicit held inspection permits only the recovery application to read the
  selection before feature owners are imported. `runtime-bundle.js` owns offline legacy-data copy preparation into generation 2, verification and
  the atomic selection pointer. The `prepared` tree snapshot omits only the bundle database's
  `opencode/opencode.db-shm` wal-index, which every read-only open rewrites; any other `*.db-shm` and `*.db-wal` stay covered. Runnable descriptors and activation targets are generation 2 only;
  a legacy source is data paths under an actual quiesced checkpoint, never a selectable controller.
  Rollback requires reconciled current-2/prior-2 selection and retains candidate work.
  The sealed importer receipt permits an absent migration marker only when the SDK
  reported not-needed for an empty source inventory; nonempty imports require completion.
  Its coherent setup-home copy includes exact Meridian profile/settings and account credential files, preserving original Keychain identity while relocating account directories, plus existing user
  skill data roots `global.home/.agents/skills` and `.opencode/{skill,skills}`;
  ancestor/leaf symlinks are refused, and unrelated home data is excluded. These
  bytes enter the existing prepared manifest while remaining mutable settings
  after activation. `bundle-checkpoint.js` keeps source admission
  closed through controller exit, producer/store drain and the complete copy.
  `migration-mode.ts` runs offline against an explicit copied database; the
  inventory modules verify relocated IDs, permissions, attachments and harness
  references. Import never starts the agent runtime. Import preflight refuses
  every Revert marker; generation-2 resume can retain a completed conversation-only
  marker with a same-session native boundary. Resume still rejects incomplete
  migration, unproved pending input, prepared ledger transactions, materialization
  and unsettled execution receipts; a retained marker grants no mutation authority.
  `bundle-owned-continuations.js` reads bounded original provider-recovery
  envelopes and native schema/projection evidence for the selected generation-2
  bundle's existing TODO/collection reservation. Queued payloads use the same
  accepted-prompt fingerprint as admission. Pre-dispatch reservations and native
  promotion before the primary ACK retain their existing recovery path. Only the
  exact unchanged recovery file's continuation ID occurrences can reference an
  uncommitted reservation; other files/fields cannot borrow it. SQL and file pins
  are rechecked, `session_pending` remains closed, and copy/import/selection checks
  retain strict pending refusal. This offline proof opens no admission; the fresh
  controller's capture and authorization remain the sole dispatch authority.
- `native-bundle-file-operations.js` is the constructor-owned Windows creation
  boundary for setup, fresh-source provisioning and candidate copies. Native
  tree copies retain source and destination identities; SQLite output is reserved
  under a dedicated private directory and accepted only after its exact file and
  namespace flush receipt. The POSIX implementations keep their existing behavior.
  `native-migration-process.js` uses the fixed native import lease for Windows:
  it captures provisional artifact identities, waits for retained ownership, runs
  the full accepted artifact verifier while every artifact is immutable, compares
  the accepted controller digest, and sends the request only after that succeeds.
  The compiled `native-migration-files.js` writer requires the kernel parent/job
  probe and writes only the bound import outputs. It grants no session admission.
  `native-setup-credential-ack.js` captures the original seed before launch;
  the compiled credential transaction returns the matching digest/count ACK,
  and only the Node host retires the exact captured seed through native CAS.
  Missing or mismatched ACKs retain it for an unchanged retry.
- `native-harness-relocation.js` owns fixed Windows Git inspection and relocation
  inside that import job. The accepted artifact inventory includes the pinned
  Git executable and complete loading payload. After the same retained artifact
  verification, the compiled mode checks its kernel job proof before accessing
  the exact harness root. It parses local bare Git configuration as include-free
  data outside the repository, rejects includes, hooks, filters, fsmonitor,
  unsupported extensions and alternate object roots, and keeps each original
  config immutable throughout plumbing. The original change-store transactions
  retain state, lease and migration refs and their objects; no history is dropped.
  Read-only inspection uses a separate protected HOME/XDG/TMP root and cannot
  mutate source payload. Mutation success additionally requires descendant
  settlement, sealed objects/refs/JSON, the bound output tree and namespace flush
  receipt. Git-bearing Windows inspection cannot fall back to ambient Git.
  The deterministic tests verify protocol, verifier ordering, refusal and original
  metadata/ref preservation. Actual Windows build, config-held ancestor rename,
  filesystem durability and architecture qualification remain separate gates.
- `runtime-entry-bootstrap.js` initializes the application binding before store-owner imports.
  `native-default-bundle.js` verifies the bundled native controller, writer and supervisor,
  creates a private never-started empty source for a fresh install, and uses the same
  offline importer/checkpoint/atomic selector. A selected generation-2 bundle is reused.
  An existing unproved legacy database fails with `bundle_legacy_source_requires_quiescence`;
  startup never guesses external-writer quiescence or modifies the old source. Missing
  artifacts and external/skip/binary overrides fail deterministically. The fresh reviewed
  location is launch cwd; further locations require reviewed bundle configuration.
  Before any selection, a `bundles/default-native` draft that `sources/preparation.json`
  does not seal for the exact current input (interrupted copy, earlier build or cwd) is
  removed with the source's derived `reviewed-*.json`, as is a matching sealed draft whose
  `verify('prepared')` fails; a selected install is never reset.
  The draft is renamed to a sibling `bundles/.stale-*` before removal, and later unselected
  launches sweep validated `.stale-*` leftovers before any draft or seed decision. An
  unheld selected launch sweeps them too, and prunes retained artifact sets, only under a
  non-waiting `selection.lock` (a lifecycle operation holding it defers the sweep to a later
  launch); this storage hygiene reports failures and never blocks the selected launch.
  `bootstrap.lock` waits up to 5 minutes for a live holder (a concurrent first start
  provisioning real artifacts); a dead holder is reclaimed at once.
  `native-setup-local-owners.js` restores the v1 owner snapshot once, then renames it to
  `native-setup-local-owners.restored.json`, so later app owner changes survive restarts.
  It applies the snapshot only to a vault this restore creates (a pending
  `native-setup-local-owners.restoring` marker covers a start that dies before the
  owner is durable); an existing vault without that marker already holds a 2.0.0
  restore, so the snapshot is consumed without re-applying a removed or replaced owner.
  Concurrent first starts serialize on `native-setup-local-owners.lock` in web-data.
  Both locks use its `reclaimReusedLock`: lock age never reclaims (a live holder's
  `createdAt` ages across a system sleep). A live pid is reclaimed, by atomic rename with
  compare and link-back, only when its UTC `ps` lstart is more than 2 s after the lock's
  `createdAt` (a crashed start's pid reused, any uid); an unreadable start time keeps the lock.
- `native-recovered-input.js` reconstructs typed queued/promoted input and incomplete
  canonical work before every controller spawn. Only startup-affected sessions
  are fenced; selected recovery summaries are bounded and full contents are read
  lazily. `bundle-recovered-inputs.js` permits constructor-owned native resume
  integrity checks, never execution. Explicit same-ID adoption pins current DB
  encoding, selection/tools, owner, revision and epoch; automatic TODO/shell work
  requires its original exact prompt/receipt proof. Grants remain through native
  delivery/Step settlement. Recovery polling defers canonical-missing uncertainty
  only for the existing live dispatch/grant's current owner, cancellation and
  controller scope plus exact sealed accepted-item hash. The committed acceptance
  pins automatic fallback hashes in the existing objective liveness entry; these
  status proofs are neither persisted nor execution authority. Explicit grants
  precede durable adoption and survive the promotion/Step gap; failed dispatch,
  failed idle, Stop and replacement close the proof. The sole `primary-step.ts` Bus decorator checks the
  whole guarded batch before publishing, using local inbox observation under its
  original mutex and Node-only fresh owner rechecks. Stop cleanup remains allowed.
  `native-input-cancellation-receipt.ts` retains a bounded hash-only witness in
  the existing native event table, atomically inside the original cancellation
  projector and transaction. The SDK normally projects without persisting events;
  this selective receipt uses a derived aggregate to coexist with optional native
  event retention. Receipts are local operational evidence, never native log
  exports, live SSE publications, or replay inputs. Session deletion clears that aggregate in its own original
  transaction. `native-input-cancellation.js` validates the exact native event
  identity/version/sequence, accepted enqueue/type/delivery/hash and canonical
  absence, then pins receipt bytes; existing recovery dispositions
  retain canceled reference evidence through replacement and fresh admission.
  Missing refs are exempt only at exact unchanged owning file occurrences. Resolved
  cancellation proofs also permit reactivation; pending import/copy/rollback and
  `session_pending` remain closed. The strict boot field rejects older controllers
  before SDK import, and unfenced sessions resume normal queue/steer behavior.
  Exact cancellation additionally requires the receipt version and enqueue sequence
  at the strict command parser, preventing an older controller from canceling
  without proof. Shell automatic recovery uses the immutable final sealed item
  hash and delivery in its existing native shell lease, with fresh termination
  receipt authorization; it does not require retained enqueue events. A queued
  shell notification reference is admitted only at its exact settled Git lease
  occurrence when the pinned pending item hash/delivery and current lease generation
  agree; other namespaces cannot borrow it. Exact Discard supports queued user
  inputs; shell and other non-user inputs stay inspectable under their existing
  owner's lifecycle, without creating a cross-owner disposition.
- `native-runtime-owner.js` composes the selected descriptor with the existing
  execution, primary and task owners. Every bundle controller uses its verified
  artifact supervisor; caller options can add denied read roots but cannot
  disable confinement or replace the launcher. `native-process.js` owns the compiled
  child's bounded stdin/stdout protocol, exact instance nonce, watchdog and
  registry. Replacement awaits OS exit, supervisor/publication settlement and
  the admission owner's ACK barrier. Its stderr drain retains only a finite
  observation-failure marker, reports it once to the existing journal and keeps
  it in the process exit record; raw provider/plugin output is never persisted.
  Before fresh admission opens, constructor recovery clears temporary holds
  belonging only to the selected bundle and its verified immediate checkpoint
  source. Revert, retention, removal, future-shaped and foreign holds remain.
  Startup retries durable execution wakes through the existing exact permit,
  observed native result and revision-bound ACK. Unresolved restored inputs
  retain their explicit recovery decision and their wake intent.
  `native-migration-process.js` separately
  requires an offline process exit and matching persisted migration receipt.
- `native-artifacts.js` verifies every packaged output, the accepted supervisor,
  pinned SDK/Bun identity and real Darwin signatures before launch. Source
  files and installed packages are build inputs, never runtime verification
  dependencies. `reviewed-windows-assets.js` owns the existing architecture-specific
  AST/Claude pins, PE inspection and exact libsql source/ABI evidence shared by
  the Windows builders and portable artifact verifier. Windows candidates seal
  `DevRyan-libsql-source-evidence.json`; resource verification grants no admission.
  `reviewed-windows-git.js` pins the official MinGit archive,
  architecture, canonical complete inventory digest, file count and fixed entry point, rejects Windows
  path aliases, and checks its exact subtree including DLLs, libexec helpers,
  templates and licenses. `controller-entry.ts` handles boot, offline migration and asset
  verification; `writer-entry.ts` unconditionally starts the compiled worker's
  protocol owner. The importable `writer-worker.ts` keeps registry helpers and
  direct-source entry compatibility. Compiled startup does not depend on Bun's
  platform-sensitive `import.meta.main` folding. `native-process-protocol.js`
  bounds and validates each message.
- `native-authorization.js` retains the original web principal and rechecks
  managed grants before effects. Integration and provider-configuration grants
  also recheck current provider/MCP settings read or edit permissions; chat
  grants remain independent. `native-web-operation.js` binds normalized
  requests to their exact native effects inside the existing admission owner.
  Detached runners use canonical session ownership and reviewed registration
  provenance; a missing HTTP principal grants no web authority. Each location
  retains its own allowed roots.
  Existing local and tunnel authenticators privately bind the original principal
  to a live grant before the native owner copies its identity. Expiry, owner or
  mode changes, logout/revocation and disposal invalidate the captured check;
  copied identity fields cannot create one. Legacy UI JWT authentication retains
  its existing expiry/reset/disposal revocation behavior. Detached work in
  configured Off mode separately requires the active enrolled administrator and
  a canonical session in a pinned location; repair provenance is not an access gate.
  Authorization is checked again after asynchronous canonical, ledger and
  Revert reads; managed grants also revalidate the original login last.
  Configured commands derive one prompt at the sealed `opencode.config.command`
  executor. `command-derivation.ts` clears its private marker before session
  hooks; the owner compares the prepared command and selection with the final
  native message identity. Constructor-only `withCommandSelection` admits only
  the exact HTTP agent, model and permission changes before command dispatch.
  Raw native deletion stays unavailable because it recurses through a local
  undecorated facade. The private `native-session-removal.js` coordinator owns
  the sealed subtree and deletion progress in the existing mutation ledger.
  Scheduler fences precede actual native/OS settlement; only private controls
  remove settled leaves. Recovery distinguishes live sessions from verified
  absence after a lost acknowledgement and preserves published workspace bytes.

- `controller-startup.ts` composes provider physical-request ownership inside
  the observation owner's single `SessionModelRequest` decorator. Meridian
  middleware, scope lifetime and observation IDs therefore share the actual
  native request service; separate original-node replacements must not erase
  either wrapper. Queue prepare and terminal-wake callbacks filter their exact native
  event types before reading the captured host: cold original Project resolution
  runs during catalog initialization, before the host promise returns. Relevant
  inbox publications without a ready host still fail closed.

- `bootstrap.ts` builds the private loopback server and owns startup, holds
  and disposal. Mandatory overrides are applied last so plugin replacements
  cannot replace the admission gate. The private bridge stays alive until
  native scopes and executions have drained.
  Authenticated `GET /devryan/tools?directory=...` exposes native wire IDs
  from one current sealed `Tool.snapshot`. The Tool acquisition captures the
  final Model dependency without replacing its reviewed provider read view; both
  catalog handles expire with that same location scope. Paired `providerID`/`modelID`
  validate the actual location's model catalog and include native JSON-schema
  definitions; the shared v2 client projects compatibility names. Unknown or
  noncanonical locations, expired acquisitions and unsupported execution tools
  remain closed. This route performs no tool execution. Model reads retain the existing owned
  selected-account resolution and refresh boundary.
  `native-runtime-owner.js` joins `session-execution-host.settleController()`
  after controller exit: old acquisitions, workers, receipts, publication and
  the keeper settle before a fresh host lifetime opens. Missing termination
  evidence keeps acquisitions fenced. Final `drain()` remains terminal; a
  concurrent controller-exit callback joins that same drain without reopening.
  The selected owner opens private recovery before advertising HTTP readiness
  or issuing fresh web grants. Execution may settle during recovery; public
  readiness opens only after durable removal, hold and continuation recovery.
  `native-model-catalog.ts` feeds the original ModelsDev file parser the exact
  reviewed `DevRyan-model-catalog.json` embedded by Bun. Explicit file mode
  skips KV; fetching and SDK snapshot fallback are disabled. Missing, corrupt
  or empty data fails closed and explicit refresh is refused.
  `native-configuration-snapshot.js` derives each location's model/variant
  requirements from effective roles, commands, ordered Council and Slim chains.
  `startup-catalog.ts` checks those exact tuples against the actual location
  catalog and returns typed per-source availability. Missing saved models or
  efforts, unavailable catalogs and an empty connected-provider catalog leave
  setup usable; malformed configuration, artifact integrity and required
  registration failures still refuse startup. Physical admission rechecks the
  complete selected tuple and never substitutes default effort.
  Non-OK catalog reads reuse the request-scoped host refusal owner and retain
  only a fixed route key, actual HTTP status and recognized error identifier in
  the existing boot error code. Without that authoritative refusal, diagnostics
  report `cause_unavailable` and do not inspect response bodies. Raw messages,
  paths and configuration are never retained. The SDK may convert defects to an
  empty 500 before this read.
  Catalog availability does not establish credentials or quota availability. Native
  Claude quota/status inspection uses the same selected credential owner and
  shared mutation queue with original web read authorization and constructor
  profile/config/controller checks before and after asynchronous work. A single
  explicit profile is required; absent/ambiguous selection returns unavailable,
  without CLI/PATH/default-account probing or an inference permit. Explicit
  `oauth-token` profiles may opt into `credentialPolicy: "access-only"` with
  `oauthTokenExpiresAt` held only by the host. Marked profiles use the existing
  selected-account IPC before SDK dispatch, refuse missing/expired tokens and
  authentication retry, and never read Keychain or renew. Unmarked legacy
  token/API dispatch remains unchanged. Shared Claude Max profiles use their
  preserved service and validated unexpired access token, with no renewal or
  credential writes. Dedicated DevRyan enrollment alone authorizes renewal.
  Status and quota reads never renew either kind of profile.
  Snapshot agent requirements combine explicit reviewed requirements with
  enabled translated agents. Original `disable` and native `disabled` flags
  use the existing translator; a dormant agent is not implicitly required,
  while an explicitly required disabled or missing agent still blocks startup.
  Cursor requirements use a separate, finite `cursorCatalog` boot projection
  from the actual external SDK runtime's fresh `getDeclaredVirtualProvider()`.
  This is only a startup availability view. Before a physical Cursor request,
  its existing SDK discovers the actual selected account's model and effort,
  then rechecks account identity and epoch after discovery. Offline declarations
  cannot prove a saved effort unsupported or authorize a request. Unavailable
  selections retain their saved intent for later account setup or explicit edit.
  The compiled Cursor fixture declares original `composer-2.5`, correcting its
  former synthetic `composer` alias without substituting any user selection.
- `child-session-route.ts` validates the host-owned child-create request, retains
  its parent permit and checks the requested directory against the native parent
  before the decorated session service creates the child.
- `controller-integrations.ts` composes the single native Credential service and
  each actual location's Integration acquisition. `native-integration-owner.js`
  retains original browser grants and joins credential commits and OAuth refresh
  to the existing host mutation queue. A timed-out reverse command holds that
  queue until actual controller exit. Global Credential HTTP routes cannot lend
  a location: manual key creation, label updates, selection and removal use the
  private acquisition-bound command. Account metadata contains no secret values.
  `controller-cursor-credentials.ts` applies this same queue to Cursor API keys,
  including in-process mutations. Its fixed key Integration exists even without
  a saved provider stanza; the existing external SDK still owns Cursor models
  and execution. No native model transport or mirrored auth file is introduced.
  `native-openai.ts` projects one host-owned Sign in with ChatGPT catalog method,
  removes retired Codex browser/headless methods, and preserves other entries.
  The projection supplies no SDK authorization callback. It reuses the bundled SIWC body/terminal-stream policy at final
  HTTP request/response hooks, fencing unsupported tools before refresh and
  preserving API-key request bodies. It checks each physical inference attempt and final transport
  headers; `remote-mcp.ts` binds tools, OAuth and selected-credential refresh to
  their exact catalog acquisition and configuration digest. Only reviewed
  configuration origins may transform the sealed MCP catalog; the 2.0.26
  `opencode.config.policy` origin may list and remove servers but never set or
  update them. Reload expires old
  closures before cleanup; it does not delete unrelated credentials.
  `controller-provider-credentials.ts` preserves original native XAI device
  OAuth and XAI/OpenCode/Go key registrations. Owned credential resolution
  requires the actual SessionRunnerModel permit (including native title,
  compaction and reviewed secondary generation through SessionContext). Key
  resolution performs fresh selected-account and caller reads; OAuth resolution
  holds the same queue through original refresh, exact Credential.update and
  finalizers. Active reverse calls are never evicted; only bounded settled
  replay receipts expire, while the bridge's private actions remain single-use.
  Exact full-record observations are weakly keyed to the original permit object;
  model/request/WebSocket hooks recheck selection, acquisition and caller after
  original hooks. Unknown credential writes and foreign OAuth implementations
  fail closed. Native Console background policy/config acquisition is refused
  before sending a selected Zen key; its builtin catalog still registers. No
  legacy auth.json mirror or token-import wire exists: absent native OAuth
  records require fresh authorized original OAuth. Anthropic/Claude retains its
  separate supervised SDK authority; this finite fence does not claim all
  provider transports.
- `native-provider-configuration-operation.js` preserves provider Disconnect
  for selected generation-2 OpenAI/Cursor/XAI/OpenCode/Go accounts and copied configuration.
  It derives editable files only from the selected descriptor and explicit
  reviewed project, validates JSONC/source and backup identities before native
  credential effects, and rechecks the original caller's current provider
  settings policy through commit. Exact native credential metadata/CAS owns
  account removal; JSONC-preserving source replacements retain byte backups.
  Routes report acknowledged removals and uncertain partial failures, mark the
  existing configuration apply revision, and never invent rollback. Apply
  rebuilds a stamped native snapshot on the existing settled restart path.
  Source/status reads use fresh metadata without exposing or mirroring keys.
- `configuration.ts` supplies explicit configuration and disables ambient
  plugin, instruction, snapshot and warming discovery. `controller-processes.ts`
  denies uncontrolled controller subprocesses and PTYs. Raw config skill,
  instruction, reference and MCP sources are refused until an owned adapter
  supplies reviewed resources; native directory scans follow symlinks.
- `native-configuration-snapshot.js` captures one coherent, provider-free
  revision of mutable copied settings beneath the immutable reviewed registration
  policy. Node and Bun use the same source stamp, digest, per-location roles,
  providers, commands and skill/resource inventory for a controller lifetime.
  Reloading saved settings requires controller recomposition; it does not amend
  prepared executable evidence. The sealed `reviewed-configuration-entry.ts`
  asset exposes original pure package resolvers and finite owned factories.
  The captured file/environment Slim preset supplies the original base layer;
  it is not a TUI runtime preset switch. Explicit saved roles and host selections
  keep their original precedence, including effort, Council order and fallback
  arrays.
- `native-slim-runtime.ts` composes the actual reviewed Slim setup per active
  location. `controller-slim.ts` supplies original path, interview, taskboard,
  image and retry adapters through current hook authority, rather than a second
  plugin state machine. Hook authority captures the actual permit, native event,
  location and AbortSignal at execution and expires after settlement. Owned
  failures remain sticky across original bridge catches. Taskboard replacement
  mutates the original message array in place and retains native media references.
  Original commands require private derivation and the exact compiled declaration;
  a public marker or matching command name cannot authorize an effect.
  `controller-startup.ts` passes Slim and Ponytail declarations to the native
  host using their already-verified compiled registration origins, matching the
  Node owner's sealed registry. Missing or mismatched declarations still refuse.
  `native-slim-context-owner.js` obtains task state from the existing scheduler;
  prompt-observed terminal CAS does not acknowledge or change result disposition.
  The original fallback selector reserves one existing primary recovery attempt,
  retaining the objective tuple and recording separate recovery execution.
  An exact active read-only fallback preserves Slim context without taskboard
  insertion or terminal-observation receipts. Existing recovery and hook grants
  recheck its owner; canonical native Step ownership, or bounded history before
  that Step, proves the current objective despite SDK presentation-only user rows.
- `controller-webfetch.ts` captures the actual native location and global LLM
  scopes. Each original webfetch invocation has its own cache, fresh permission,
  immediate progress and cancellation/settlement channel under an owned control
  lease. Secondary summarization uses actual SessionContext, transcript,
  model-request hooks and LLMClient under a private derived permit, without
  changing the session's saved model. The sealed original JSDOM extractor and
  WX binary allocator remain package behavior. Binary scratch files live only
  beneath the exact per-location owned temp root, with bounded bytes, symlink
  checks and cleanup after failed authorization; they are not project publication.
- `controller-interview.ts` binds the original context bridge to private accepted
  command proof and the true hook AbortSignal, including active-interview reads.
  `native-controller-interview.js` composes the original service and same-origin
  UI handler with existing web authorization, admission and supervised document
  owners. No standalone original dashboard listener or ambient auth file runs.
  Its owner-minted `statusOnly` metadata is interpreted only on native synthetic rows by the shared message-status predicate; visible notices do not replace the accepted turn in REST/live projection or recovery observation.
  Its private status-only notification uses `native-notification.ts` and the
  original durable `SessionEvent.Synthetic` projector, after canonical session
  checks and a final permit recheck. It does not admit inbox input or wake an
  active runner. Admission captures the final Bus through the Session graph,
  retaining primary-step, Cursor and observation publication decorators.
  Explicit interview continuation and shell completion retain their owned
  admission paths.
  Cancellation settlement remains awaited separately from the interrupted RPC.
  Focused SDK/leaf evidence and remaining integration qualifications are recorded
  in [the Slim compatibility note](../../../../../../docs/audits/2026-10-02-opencode-v2-slim/README.md).
- `native-slim-owner.js` keeps original path-rescue metadata reads under the
  actual running tool and fresh hook grant. Only the native `read` tool may
  stat or resolve an exact snapshot skill file after its hash, size and symlink
  checks; parent directories, other tools and text reads retain ordinary root
  guards. The actual file read still requires native permission and the direct
  ledger fence in `execution-routing.ts`.
- `native-cursor-owner.js` retains the original admitted caller throughout the
  existing Cursor SDK run. `native-cursor-ingress.ts` publishes its exact user,
  assistant and cumulative content through the native Bus and projector, retaining
  original part and call IDs. The SDK's owned-prompt callback covers its stream,
  process and persistence queues. Terminal content waits for the existing ledger
  lease to reach published or cancelled after real process settlement.
  `controller-startup.ts` composes Cursor store and Bus captures inside the final
  mandatory replacements; independent replacements would silently discard them.
  Read-only execution activity combines native runners with owned Cursor scopes.
  A separate finite cleanup grant may finish an interrupted assistant after a
  hold or caller revocation, but cannot add content, claim or wake a runner.
  Actual HTTP/REST/SSE and owner checks cover these contracts; full confined SDK
  lifecycle and controller-death recovery qualification remain required.
- `native-imagegen-plugin.ts` and `native-imagegen-worker.ts` use the sealed
  original image schema, Responses transport and versioned output allocator.
  The original image parser retains its Codex endpoint and account header;
  `native-image-generation.js` refuses SIWC images before provider traffic.
  Original parser fixtures do not authorize legacy enrollment or inference.
  Native registration declares the original string output; the SDK validates
  it before projecting exact text content and preserving image metadata.
  Production images use the selected native OpenAI API key through
  `native-openai-auth.js` and `native-integration-owner.js`, bound to the actual
  process lease and a private exact selected-record proof. Selection changes
  refuse before traffic or publication. SIWC is refused before the refresh
  coordinator; legacy OAuth still requires reconnection. The key transport uses
  public Responses without a ChatGPT account header. Its private result marks
  API-key billing, which the worker projects over the original subscription
  metadata while retaining the original output allocator and parser. Request/result
  files are private and bounded; cancellation settles transport and process before
  publication or discard. `native-image-runtime.js` and `controller-images.ts`
  separately route existing prompt images through the original image-context
  worker and match replacement notices by exact content hash and media identity.
  Its private bounded canonical page keeps genuine native user attachment rows
  separate from the latest raw turn parent (user, owned synthetic, or compaction),
  excluding private status-only notices. Context IDs must contain that canonical
  anchor; attachments are filtered to the current context before the worker.
  Constructor capture seals the raw anchor fingerprint and canonical user parts,
  rechecks both through publication, and permits summary-only empty user input
  through the original algorithm without inventing a user/tool identity.
- `registration-origin.ts`, `native-plugin-registry.ts` and
  `trusted-plugins.ts` bind reviewed registration provenance to native and
  explicitly supplied plugin code. Plugin IDs and tool names alone grant
  no execution authority. SDK activation clears its Effect services, so the
  trusted wrapper captures the core-supplied location before registration.
  Tools keep that location rather than taking one from execution input.
  SDK plugin permission assertions remain closed without a native permission
  owner. Arbitrary JavaScript plugins are not sandboxed.
- `admission-gates.ts` decorates native sessions, tools, inference, inbox,
  startup recovery and hooks. `native-admission-contract.ts` defines the
  private permit contract. `host-refusal.ts` preserves typed refusals across
  native request error handling. Inbox preflight and admission hold the native
  inbox lock; committed host verification runs after its release and remains
  awaited, because owned completion may reenter that same lock.
  Persisted skill aliases are translated only within a current native Permission
  evaluation. Stored rows and ordering are unchanged. The view expires after
  evaluation or location reload; an always-reply may reevaluate only sessions
  from the original native pending registry in that same location.
- `native-admission-owner.js` and `native-admission-bridge.ts` connect the
  Bun gates to Node ownership. Durable holds and deferred continuation
  records live in the existing session ledger; transient permits do not
  replace it. A shell continuation stays durable after wake registration and
  native Job marker removal. Only a canonical step plus the actual termination
  receipt, or startup reconciliation against raw native message sequence, can
  acknowledge its consumption. Already consumed notices are cleaned up without
  another wake; a newer ordinary input awaiting its assistant blocks an old wake.
  `invalidateController()` rejects the old controller's permits and in-flight
  authorization without changing durable holds. Call it only after verified
  controller exit and settlement of all owned processes and publications, and
  await it before replacement or disposal. It closes new owner operations and
  acknowledgements, then waits for admitted ledger acknowledgements to finish
  their full commit before rotating the epoch. Disposal refuses a pending
  acknowledgement or replacement barrier.
  Owned shell continuation refreshes canonical parent lineage before wake.
  Native `Store.claim` uses that captured lineage inside its SQLite callback;
  it cannot reread native HTTP there. Replacement clears the cache, so recovery
  must rebuild the binding before it can claim work.
  Queued notices use native wake. An exact promoted, unconsumed notice uses
  scoped resume only after the inbox lock verifies no newer input or active
  runner. The lock is released before waiting for independently authorized
  runner admission; failure to transfer the continuation remains an error.
  Redo's deferred `execution.wake` uses a separate private capability. It
  acknowledges the durable intent only after native inbox/runner inspection
  proves idle or a normal wake reaches independent runner admission, with an
  atomic ledger revision check. It never resumes completed history. Unknown
  continuation operations remain closed.
- `execution-routing.ts`, `writer-worker.ts` and `worker-protocol.ts`
  route exact reviewed native writers, reads and shell jobs through
  `../session-execution-host.js`. Writer permissions and progress cross the
  bridge; publication waits for real supervisor settlement and the existing
  ledger transaction. Failed writes discard their private execution view.
  Original Slim AST leaves use this same worker/publication path. The complete
  reviewed plugin origin and the separately verified branded AST executable are
  constructor inputs; execution payloads cannot select an executable. The
  original package is transformed only at inventoried, hash-guarded seams.
  The build-only Meridian libsql transform selects exactly one reviewed native
  target (Darwin ARM64 or Windows x64/ARM64), with no package lookup fallback.
  Windows compilation candidates still have no accepted launcher or runtime
  manifest and cannot grant execution admission.
- `execution-read-guard.ts` resolves read targets against explicit allowed
  roots and protected paths, including symlink targets and Git metadata.
  Reads remain subject to native permissions and the ledger generation fence.
  Reviewed skill support files have exact per-location snapshot grants.
  `native-reviewed-skill-execution.ts` keeps the hashed reviewed id as the
  permission resource and reports the human skill name only as display data
  (running progress and permission-ask `metadata.name`). The
  Environment replacement returns bytes from the verified file descriptor;
  parent directories, unlisted files, changed bytes and symlinks gain no grant.
  Explicit native instruction loads are closed until reviewed resource
  registration. Supervised scans exclude Git metadata and refuse followed
  symlinks or directories containing protected roots.
- `managed-task.ts` registers the candidate managed tool and binds its
  reviewed provenance to `managed-task-owner.js`. That adapter delegates to
  the existing scheduler after `../harness-task-context.js` verifies the
  current root Orchestrator, exact native turn/call and durable Plan objective.
  The initial acceptance surface is start, status, wait and cancel; remaining
  task actions and plugin behavior are still required for complete parity.
  Private `nativeManagedControl` and `nativeManagedChild` methods validate
  actual native invocation and durable parent-control lineage. Deferred child
  creation and prompting use `withManagedTaskDispatch` with a fresh scheduler
  lease, parent ledger generation and exact saved execution tuple. They do not
  inherit the completed parent tool's permit. The legacy plugin bridge stays
  closed for generation two.
- `primary-step.ts` observes the committed native `SessionEvent.Step.Started`
  synchronously before tool dispatch. `primary-step-owner.js` checks its live
  runner permit, canonical sequence and existing objective before updating the
  existing primary controller; it creates no parallel primary record store.
  Original Slim retry and Step handoff capture the same native attempt span and
  private runner permit. A retry before the SDK lazily creates its assistant
  retains a pending choice in that owner; the real canonical Started binds it
  before failure settlement. Its first lazy retry uses the existing canonical
  `helloNative` version handshake under the captured hook grant, since no Step
  has yet performed that read. The live controller getter fences replaced boots.
  Native Step, Slim retry and both TODO scan/startup recovery callers pass that
  constructor guard through the shared host; its final synchronous instance
  check precedes the existing handshake write after awaited authorization.
  When the original SDK lazily publishes Started while settling an already
  interrupted fiber, the wrapper proves delivered interruption through Effect's
  public interruptibility/Exit APIs and preserves the native publication without
  a new primary handoff. It repeats that proof after a rejected handoff to cover
  Stop racing the reply; ordinary held or unavailable handoffs still fail closed.
  The verified selected artifact's `devryan.primary-step-stop/1` contract enables
  an exact pending-handoff Stop disposition. The host requires the same live
  permit, controller, objective, execution lineage and canonical assistant,
  exactly one Stop generation advance, and a final unchanged cancelled snapshot.
  It acknowledges no continuation. The strict native mapper invokes its
  constructor-owned raw execution interrupt before delivering Effect interruption,
  preserving user-interrupted idle and claim release without waiting on itself.
  Historical adapters without that contract retain the original refusal path.
  A constructor-only callback disposition omits that cleanup's step-link RPC.
  Prepared/physical observations remain visible as unmatched cancelled attempts;
  reasoning coverage continues to require successful user turns, while native
  aborted assistants, interrupted idle and settled transport prove cancellation.
  Its direct `helloNative()` handshake verifies the pinned native `/api/info`
  version through the bounded client. It does not grant public readiness or
  provider-recovery eligibility; ordinary plugin handshakes retain those gates.
  `native-shell-continuation.js` proves background continuation from the current
  ledger, real termination receipt and exact native user/assistant/call chain.
  The primary controller adopts that user only at the next native step, retaining
  the original objective and saved provider/model/effort through compaction.
- `native-session-context.ts` and `native-session-context-owner.js` bind TODO
  tools, compaction anchors and primary tool observations to current native
  calls. TODO metadata replaces only `metadata.devryan.todo` under the existing
  session lock through a private, exact metadata derivative. Reads use the
  privileged client's bounded, session/directory-matched native metadata map;
  the ordinary facade intentionally strips these internal fields. Idle events use the
  existing harness event feed to request the existing primary continuation
  planner. Its durable reservation keeps the same message ID after a lost ACK;
  only canonical Step.Started consumes it. Held intents remain pending. This
  does not establish parity for legacy compaction retention settings.
- `native-browser-plugin.ts` registers the hash-guarded original browser schema;
  the complete tool runs in one supervised worker. `native-browser-owner.js`
  checks the current native assistant/tool/user chain and original permit for
  every private lease operation, then delegates to `browser-cdp/lease-runtime.js`.
  A grant lost during acquisition releases that exact lease. `native-browser-assets.js`
  seals the injected existing Electron installation and optional verified FFmpeg;
  it never installs or probes executables. An absent desktop installation omits
  the browser registration. Worker publication and real Electron behavior still
  require their acceptance evidence.
- `controller-effects.ts` keeps logs from private native Effect calls on stderr;
  stdout remains the strict JSON-lines process protocol. Credential operations
  separately suppress native logging and use the existing structured diagnostics.
- Native interruption retains the missing-job no-op in `Job.cancel(sessionID)`
  so the native interrupted event can release its claim. Actual job cancellation
  remains owned. Acceptance checks canonical interrupted-idle and released
  suspension/retry state before sending another prompt.
- `native-observation.ts` observes actual prepared model options, final HTTP/WS
  reasoning controls, the original `SessionStep.attempt` trace, and committed Bus
  events. `native-observation-owner.js` binds canonical turn identity and the
  current snapshot before using the existing diagnostic journal. The shared
  finite contract lives in `packages/shared-runtime/lib/native-observation.js`;
  sanitized worktree witnesses use a separate strict parser. Missing tracing,
  unsupported wire bodies and refused/dropped observations are evidence gaps.
  Constructor-owned Cursor ingress remains outside native `SessionStep.attempt`
  linkage: its private WeakSet scope excludes only projected `Step.Started`
  from that observation RPC. External primary tracking, canonical events and
  supervised receipts still apply; copied Cursor metadata cannot skip observation.
  They do not change native model or compaction behavior. Final controls use one
  JSON parse per materialized send, bounded to 64 MiB by actual UTF-8 bytes;
  unsupported/oversized bodies remain unqualified. Stage E includes that cost.
- `native-compaction-observation.ts` has a scoped WeakMap keyed by the actual
  native trigger. `scripts/native-compaction-observation-transform.mjs` permits
  only the pinned 2.0.20 source hash and one insertion after its original budget
  calculation. The insertion captures actual settings/revision, estimates,
  threshold and checkpoint positions without changing a decision. Public
  compaction interfaces expose configuration writes but no exact read; a later
  mirrored read could observe a different revision. Original early skips do no
  diagnostic hashing or RPC. Raw Started/Ended event sequence and time retain
  the running compaction ID; manual input IDs bind Starts outside compact scope.
- `tsconfig.json` checks the native host and native acceptance TypeScript
  against the installed SDK interfaces. Bun tests live in
  `scripts/opencode-v2-native/`; Node-owner tests remain beside their sources.

The acceptance runner uses repository-owned HOME/XDG/temp/database/project
paths, a simulated native model and the accepted Darwin arm64 supervisor.
Simulation changes model responses; it does not replace native tool execution,
receipts, publication or task ownership.

- SIWC enrollment and disconnect use `chatgpt-siwc-host.js` against this owner's
  scoped native selected/read-record commands and existing mutation grants.
  Grants compare the selected fingerprint before commit and recheck attempt
  cancellation. `holdOpenAiSelection` drains the shared refresh queue and blocks
  physical native/helper/Bot access until exact local token cleanup succeeds;
  `stopOpenAiRequests` additionally settles existing helpers and session owners.
  `native-setup-credential-data.js` retains explicit SIWC method/client/subject,
  scopes, host identity and ID token metadata; old OpenAI imports keep their
  legacy browser discriminator and cannot acquire SIWC permissions by relabeling.

- Fresh application startup uses `native-default-bundle.js` and the existing private empty-source prepare/select flow. Old conversation databases and diagnostic journals do not enter the new bundle and cannot block it. A valid native selection is reused with all current state on subsequent boots; when its OpenCode version misses the application pin, `native-bundle-startup-upgrade.js` first clones it onto the shipped runtime. `native-setup-seed.js` copies a bounded setup allowlist: preferences/registered projects, declarative agents/commands/skills/roles/Council/provider configuration, connection setup and exact account inputs. Session pointers, tasks, recovery/receipt authority, permits and caches are excluded; published project files remain unchanged. OpenCode configuration is layered as OpenCode loads it: the global directory (`$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode`) is always a source, and an `OPENCODE_CONFIG_DIR` that is another directory is layered over it into the one target directory (`native-default-bundle.js` passes it as `opencodeConfigOverlayDirectory`). Folders (`agent(s)`, `command(s)`, `prompts`, `skill(s)`) union both layers, a same-named top-level entry (an agent file, a whole skill folder) coming from the overlay; `AGENTS.md`, `.openchamber/config.json`, `ponytail/config.json` and the Slim JSON/JSONC pair (one setting) come from the highest layer that supplies them; `config.json`/`opencode.json`/`opencode.jsonc` keep their bytes when only one layer has any, otherwise they merge in OpenCode's order (global `config.json`, `opencode.json`, `opencode.jsonc`, then the same names in the overlay; objects merge deeply, later scalars and arrays win, top-level `plugin`/`instructions` concatenate without duplicates) into one target `opencode.json` without comments, and a layer that does not parse fails closed with `native_setup_json_invalid` and its file name. Web-config `projects/` imports only top-level `*.json` object records; `projects/<id>/plans/**` are v1 conversation artifacts left in place. Finder metadata (`.DS_Store`, `._*`, `Icon\r`) is skipped in every copied folder and tolerated directly inside `fresh-native-source`. Benign setup never fails launch: unusable optional entries are skipped and returned as a non-persisted `skipped` list (sanitized `relativePath` + reason, capped at 200 with `skippedCount`) plus one `console.warn` summary. Source roots are canonicalized once (a linked root only to a uid-owned directory); a symlink inside is followed only when its realpath stays in the canonical HOME, is a uid-owned file or directory, is neither HOME itself nor an ancestor of the copied root, is not in DevRyan state or the seed target, and is not a cycle; credential, token and browser stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.password-store`, `~/.netrc`, `~/Library/Keychains`, `~/Library/Cookies`, `~/.codex`, `~/.claude.json`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/Library/Application Support/{Google,BraveSoftware,Firefox,Microsoft Edge,Arc}`, every `~/Library/Application Support` entry named like DevRyan/OpenChamber (Electron userData, its `-runtime-service` sibling, `@openchamber`, legacy Tauri data), and absolute `$XDG_CONFIG_HOME/gh`, `$GH_CONFIG_DIR`, `$CLOUDSDK_CONFIG`) and anything below them are skipped as `protected`, as is any Chromium/Electron `Cookies`, `Login Data`, `Web Data` (and `-journal`), `Local Storage`, `Session Storage`, `IndexedDB` or `Partitions` entry; the v1 web data/config roots are read only from their own roots by the exact setup copies, so a link reaching into them is `protected` (unless the root is HOME or above another setup root; an exact setup folder/file such as `themes` linked strictly below its own web root, not onto or above any web root nor into another web root nested in it, is still that root's setup), and their `multi-user-vault.*`, `branch-preview-vault.*`, `jwt-secret`, `github-auth.json`, `ui-passkeys.json`, `bots/`, `multi-user/`, `credentials/` and runtime state (`bot-integrations/`, `runtime/`, `push-subscriptions.json`, `cursor-sdk-sessions/`, `harness/`, `orchestration/`, `processes/`) are never copied (`multi-user-vault.*` are read only by `captureNativeSetupOwners`); account stores (the raw OpenCode data directory, `~/.claude`, `~/.config/meridian/accounts`) are likewise `protected` from every link and copied folder, and read only by the exact `auth.json`, `~/.claude/.credentials.json` and Meridian account copies. The one exception is setup shared from Claude Code/Codex: inside canonical `~/.claude` and `~/.codex` a link or copied folder may reach only the top-level `skills/`, `commands/`, `agents/`, `prompts/`, `output-styles/` directories and `CLAUDE.md`/`AGENTS.md` files; everything else there (credentials, projects, history, sessions, settings, `auth.json`, ...) stays `protected`, and links nested inside shared folders are checked again. Stores are canonicalized first; one that resolves to HOME, outside HOME, or to/above a setup root protects nothing. Every entry is checked by its canonical path, so a requested name in a different case (a Meridian `claudeConfigDir` of `~/.SSH`) meets the store it is on disk. On case-insensitive volumes a requested name stored with different case (`agents.md` for `AGENTS.md`, `Skills/`) is the same entry when its realpath differs only by case and has the same dev:ino; the destination keeps the requested name. `.git`/`.hg`/`.svn`/`node_modules`/`.venv`/`__pycache__` are never traversed; FIFOs, sockets, devices and EACCES/EPERM entries are skipped (reads use `O_NONBLOCK|O_NOFOLLOW` and require a regular file). A file with more than one hard link is skipped as `hard_link`, since another name of it may sit in a protected store; the opened descriptor must have the dev:ino of the entry checked by the component walk, and after the read the path must still `lstat` to that inode and canonicalize to the checked path, otherwise the seed fails closed with `native_setup_source_changed` (a same-uid swap of the file or of a checked directory component never reaches a protected store). `native-setup-source.js` exports the one seed budget (4096 rows, 1 MiB per file, 16 MiB total, bundle-document marker cap) used both when saving and by `verifySeed`; generated auth/Meridian/local-owner rows (and the copied `~/.claude/.credentials.json` and Meridian account `.credentials.json` rows) are saved first and are never budget-skipped (one that cannot fit fails closed with `native_setup_source_too_large` and its `relativePath`); their required source inputs (`auth.json`, Meridian `settings.json`/`profiles.json`, those `.credentials.json` files) are never skipped or truncated for size either: one over the 1 MiB per-file cap fails closed with `native_setup_source_too_large`, `reason: 'file_too_large'`, its sanitized `relativePath`, `size` and `limit`, never its bytes; exact records, project records and bulk folders follow and only those are skipped when over budget. Meridian `settings.json` is saved once (`MERIDIAN_DEFAULT_PROFILE` merged as `activeProfile`); profiles follow the runtime loader's tolerance, dropping id-less rows, non-absolute `claudeConfigDir` values (`profile_account_invalid`), accounts outside HOME, non-standard keychain services (`profile_keychain_invalid`), later duplicate ids and rows past 64 with a profile-id diagnostic; bundle clones stay strict. Corrupt required records, non-JSON `auth.json`, changed files and tampered retry pins still fail closed with their `code` and sanitized `relativePath`; raw platform errors surface as `native_setup_io_failed`. `native-setup-credential-data.js` is the shared pure auth projection; it mirrors the pinned SDK legacy import (trailing-slash IDs, skip undecodable/duplicate entries) and skips wellknown entries whose origins the controller cannot store (each reported as `credential_wellknown_unsupported` on `auth.json` without an integration ID, because the URL-shaped key may carry userinfo; their token is not imported and that provider is signed in again natively, while sibling entries still import); without `onSkip` (bots) the original strict projection applies unchanged and any unknown shape fails closed. `native-setup-credentials.ts` imports its bounded envelope through the original Credential/KV/Database services before decoration; original activation and the one-time native KV stamp share a transaction. Later native account choices are never reset, and the transient active seed is removed only after commit.
- `runtime-entry-bootstrap.js` runs before the thin `server/index.js` dynamically imports `server/application.js`, so no feature store can capture the old data/config paths while provisioning is pending.

- `native-helper-owner.js` and `controller-helper-text.ts` own authenticated, constructor-issued title/Git text requests. `controller-webfetch.ts` reuses the captured native location, model resolver and decorated SessionModelRequest/LLM graph with exact selected model/variant, bounded output and final tools empty. There is no helper Session, Inbox, Step or history write. `native-helper-context.ts` exposes transient correlation only to the matching plugin session read within the provider Effect. A bounded cancellation response may report `native_helper_unsettled`; its original permit remains held until actual provider acknowledgement or confirmed owning controller exit. The owner never kills unrelated conversations for that timeout. Reverse settlement compares the exact token/session/revision field set independently of JSON key order, so the original controller header reconstruction can acknowledge cancellation without accepting foreign or extra fields. One caller-created logical operation ID spans repairs, model/account rotation and title retries. Pending/unsettled IDs reject overlap and late publication; four unsettled helpers block new helpers until real settlement frees capacity. Sign-out uses `stopProvider` to cancel only matching helper inference and waits for its actual provider ACK/work settlement; timeout refuses revocation and preserves held admission. Helpers canceled before dispatch require no provider ACK. Native provider HTTP statuses remain classified without exposing upstream bodies.
- Detached titles use the existing canonical session owner checks, distinct from ordinary directory helpers. `native-helper-title.ts` pins the previous title inside the sole native Bus transaction before the original rename projector; concurrent manual renames win. Cursor raw helpers retain selected models, no tools/settings, and wait for owned worker receipts. Meridian transport keeps each copied account's original constructor-owned keychain service identity.

- Claude's supervised worker requests credentials for the concrete Meridian
  active/priority/sticky profile before acquiring its SDK concurrency slot.
  `native-provider-process.js` validates the bounded reverse credential protocol;
  `native-provider-runtime-owner.js` resolves private profile paths/service names
  and rechecks live attempt, account, generation and admission before and after
  credential work through the existing mutation queue. The manifest-verified
  `DevRyan-Claude-credentials.mjs` asset supplies the captured renewal algorithm
  and explicit Keychain read/write identity. Only request-local access token and
  expiry cross to the worker; ambient worker renewal is disabled. Exact reviewed
  signed-out health is degraded availability, while listener, version and protocol
  failures still refuse startup. Tokens never enter browser responses or diagnostic
  records. Independent access-only QA profiles fail at expiry without refresh.

- `native-claude-lifecycle.js`, `native-claude-lifecycle-kv.ts` and the private
  client keep versioned nonsecret enrollment/generation bindings and the bounded
  unresolved-grant ledger in the existing native durable KV service. Revision
  checked transitions persist issuer intent, then the canonical replacement
  fingerprint before credential persistence. Only that exact replacement can
  settle interrupted work; uncertain issuer results remain fenced. Recognized
  legacy markers enter the ledger before enrollment, without vendor writes.
  Controller KV finalizers do not call back into the host mutation queue; close
  drains the queue while the controller is still alive.
- `native-claude-enrollment.js` prepares the reviewed vendor login in an unused,
  private stable directory under the bundle control root. Original principal,
  directory, grant, configuration and controller bindings are rechecked through
  publication. The lifecycle count/byte ceiling and complete renewal capacity
  are checked before returning a URL and again before issuer dispatch; capacity
  refusal cannot mint an unrecorded grant or evict unresolved fingerprints.
  `native-claude-profile-publication.js` preserves existing settings
  and priority, performs raw-byte CAS and selects only on the explicit Use action.
  `native-claude-enrollment-directory.js` validates path ownership; it grants no
  renewal authority. `native-setup-profiles.js` preserves stable directory and
  service identity on clone only with exact lifecycle authorization.
- `native-claude-worker-profiles.js` projects stable external enrollments to
  empty private worker configuration directories inside the existing worker
  roots. The host keeps the original profile/service and resolves credentials;
  external credential files never enter the worker. Missing compiled Claude
  support refuses before projection, worker launch or credential authorization,
  leaving core startup and other providers available.
- The credential reply channel retains timed-out and closed request IDs/profile
  bindings until one validated reply or process exit. Active and retired entries
  share the 64-request limit; valid late credentials are discarded immediately.
  Unknown, duplicate, malformed and foreign-profile replies fail the channel.

- `native-retention.js` and `native-retention-quiet.ts` reuse the existing admission and removal owners. Constructor-issued automatic cleanup holds the full subtree under original Inbox mutexes plus the SQLite transaction, refuses queued/pending/claimed/running work, and rechecks Node-only selected/managed/ledger policy without calling the child back. Archival preserves native metadata and publishes every member in that transaction. Deletion atomically transfers the exact current-boot hold into a quiet removal intent; quiet removal never invokes cancellation or Stop. Failed/uncommitted decisions are abandoned without waking, committed decisions keep existing disposition/ACK recovery. Startup releases abandoned automatic holds before opening recovery; the strict private command parser rejects unsupported artifacts.

- `native-queued-input.ts` owns bounded native subtree proof for resolved human FIFO input. The existing primary-step Bus wrapper checks before publication and again in the original enqueue/delivery transaction, so busy, claimed, pending or unknown descendants cannot authorize input across awaits. Manual steer and native control continuations retain their own contracts. The accepted native owner stages primary admission until actual enqueue commit under the original Inbox mutex; its existing final write guard retains caller, cancellation and controller identity. Queued slash commands preserve their private command provenance and reuse the same callback after enqueue, while command preselection reads require the exact existing command owner. The native publication witness pins the actual selected tuple, including inherited variants, and the transaction rejects a concurrent selection change. Failed post-commit callbacks retain the exact item; same-ID retries require the current primary owner instead of silently readmitting it. Terminal native execution events use the existing deferred wake after true idle; no new polling owner is created.
