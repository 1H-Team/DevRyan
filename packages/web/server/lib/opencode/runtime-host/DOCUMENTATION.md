# Native startup catalog diagnostics

## Mandatory startup contract

`native-artifacts.js` bounds manifest reads and keeps every integrity check before
execution. Verification failures retain the public code
`native_runtime_artifacts_unverified` and a sanitized stage, reason, basename and
verification purpose. The same manifest reader covers first provisioning and
cold upgrade detection. Early failures emit the safe envelope before a journal
exists; composed native failures add it to the bundle/controller journal event.
`bundle-startup-upgrade-status.js` carries it to lifecycle health, including a
failed repair at the same OpenCode version. A recorded failed repair cannot
silently launch the old selected runtime as though startup succeeded.

The thin runtime entry asserts that cold upgrade succeeded before assigning its
inherited bundle root, binding data owners or importing the application. This
preserves the original refusal (for example `bundle_execution_unsettled`) instead
of masking it with a current-pin check against the retained old runtime. Cold
upgrade preflights the selected harness after owner checks and before artifact
retention; the full final verifier still runs. Compatibility checking shares its
fresh source result only with the immediately following upgrade decision, never
across checkpoint, mutation or spawn boundaries.

First-run setup preserves explicit background-service opt-out and disabled Bot
runtime preferences. It still excludes prior service registration and ownership
state, so provisioning cannot silently turn a user's opt-out into registration.

Existing startup timing records now include manifest payload hashing, signature
verification, first-install artifact retention/preparation/selection and binding.
Shell visibility and ownership resolution precede binding/controller readiness;
renderer directory/session readiness and the global event-stream ACK complete
the contract. These observations do not bypass checks or cache verification.
The existing matched benchmark still requires at least 5% median improvement and
every candidate pair faster before retaining a performance optimization.

## Managed tool capability advertising

`managed-task.ts` registers only the enabled optional actions: `wait_any` follows
`waitAny`; `checkpoint`, `decisions`, and `remember_decision` follow
`contextProjection`. `native-runtime-owner.js` supplies these flags from the
managed scheduler's capability projection at controller startup, overriding
caller environment values. Disabled actions and their fields never enter the
model's tool schema. `DEVRYAN_CAPABILITY_TOOL_SCHEMA=0` retains the full schema
for rollout compatibility; host policy checks still govern execution. Retained
calls decode against the complete contract without acquiring new authority.

## Host helper and title ownership

`native-configuration-snapshot.js` applies `runtime-helper-agents.js` after saved
and Slim agent resolution. This installs the hidden, deny-all `devryan-title`,
`devryan-commit` and `devryan-pr` roles without assigning a model or variant,
and disables native `title`. The existing standard title coordinator owns
generation, bounded retry/fallback and compare-before-rename persistence.
Without those roles, `controller-webfetch.ts` rejects generation with
`native_helper_agent_unavailable` before a provider request. The compiled
controller-webfetch test now starts from resolver-produced configuration;
the multipart Plan admission/projection/title regression checks that synthetic
format instructions remain excluded while every real request part is retained.

## Archiving sessions with recovered input

`native-admission-owner.js` permits archive/unarchive through the recovered-input
fence only after the private metadata reader verifies the session/directory and
the exact archive-only replacement. Other metadata is preserved. The permit
allows only its pinned `session.setMetadata` effect and retains fresh caller
authorization, session holds and revision checks. `native-recovered-input.js`
keeps retained inputs and their execution fence intact; archiving does not
resume or discard them. Generic web operations, prompts and wakes remain fenced.

## Managed Cursor catalog and inspection authority

Managed start preparation has a 25-second deadline inside the existing 30-second
bridge window and carries caller cancellation through catalog validation and
scheduler admission. Native selection validation bounds catalog reads at 20
seconds. The SDK catalog command uses the existing confined read-only worker,
with a bounded projection of model IDs and exact string-valued variant parameters.
Cancellation waits for the owned process termination receipt before releasing
authority; an unconfirmed receipt remains `native_process_settlement_unconfirmed`.
The signal stays local and is excluded from stored scopes, RPC and worker payloads.
`cursor_catalog` journal phases (`key_resolved`, `worker_started`, `worker_result`,
`settled`) report elapsed time from the same start and a bounded settlement outcome,
including admission reads with no session. Native Stop also cancels prompt-time
catalog startup and awaits worker termination, transcript persistence and grant
cleanup before confirming success. It keeps busy until that settlement; compatibility
hosts retain their immediate abort behavior. First emitted text timing counts only
assistant answer text, excluding replayed user input and reasoning.
Preparation forwards cancellation and journal phase observations through the
execution owner, and a rejected start waits for no-launch cleanup before releasing
its grant. Parent cancellation fences new dispatch immediately; only the completed
cancelled transcript, after the owned termination outcome or no-launch cleanup,
uses the same live task lease's private settlement proof. Scope, controller epoch,
revision, generation and execution selection remain checked, and terminal tasks
cannot reuse this proof. `cursor_persistence` failure diagnostics retain only
allowlisted error codes and message identities. Native abort propagates final
transcript persistence failure after cleanup rather than confirming success. Terminal-only `cursor_persistence` phases locate the SDK queue,
owner callback and local save (`sdk_queued` through `sdk_settled`) and the native
start/receipt/check/lease/assert/call/recheck boundaries (`native_entered` through
`native_settled`). Each marker contains only session/message IDs, phase, start
time, elapsed time and an optional bounded failure code. Observer failures do
not affect settlement; canonical idle can precede the final persistence reply
and these markers do not change the authoritative busy/idle boundary. SDK
persistence replaces only a pending tail snapshot for the same assistant message;
user records, distinct messages and awaited terminal/error writes keep their
ordered barriers. The executing snapshot is immutable, so a later completion
cannot turn an earlier streaming write into a terminal record. Full cloning
occurs only when a queued snapshot actually writes, rather than on every delta.
Authority refusals retain their safe native code; catalog deadline exhaustion is
the separate transient `native_cursor_catalog_timeout`. Timed public discovery
returns declared fallback metadata after cleanup, while admission never publishes a
late cancelled result or admits a task after cancellation.

After an SDK catalog successfully commits, Cursor emits the existing host SSE
event `openchamber:provider-catalog` with only `providerID: cursor-acp`, the
accepted request `directory` and `source: sdk`. An empty directory identifies
the compatibility global scope. The first admitted directory adoption of each
committed SDK records generation also emits; repeated cached reads, declared
fallback and failed or cancelled discovery stay silent. UI consumers invalidate only their matching
active directory. Observer failure cannot replace the committed catalog.

`native-runtime-owner.js` exposes constructor-only `withManagedCursorCatalog`
for exact directory/root/agent/provider/model/variant validation. Initial and
agent-requested recovery validation run inside the private current
`devryan_task` invocation installed by `managed-task-owner.js`; the admission
owner rechecks its canonical call and permit. Detached automatic recovery must
supply the task ID and cancellation generation, and the orchestration owner
verifies the current pending recovery and exact configured backup selection.
The separate `captureManagedCatalogAuthorization` checks the canonical root's
current account access without manufacturing a browser principal or adding a
public detached operation. Catalog grants recheck owner, controller epoch,
canonical directory, archive/revert, holds and revision. SDK prompt-time discovery
can use the already accepted exact native Cursor prompt permit; ordinary browser
catalog reads and authenticated manual retry/resume overrides retain their original
browser authorization. A generation-bearing automatic recovery never falls back
to browser authority.

Cursor prompt grants return immutable `{ run, close, readOnly }`. Managed
`readOnly` comes from the verified current task lease, never prompt input, and a
policy change revokes the grant. The SDK owner applies this captured policy to
agent creation, resume and cached worker identity. Model and effort availability
remain account-specific and fail closed; inspection authority does not grant a
replacement model or permission to dispatch nested tasks.

## Provider request and account boundaries

OpenAI new enrollment uses reviewed `opencode.provider.openai` / `chatgpt-browser`
(**Codex browser (legacy)**). Existing `opencode.provider.chatgpt` /
`chatgpt-token-sharing` credentials remain usable for chat. The catalog exposes
only Codex browser and API key. `native-openai.ts` checks admission, this permit's
selected credential proof, and the exact method-specific HTTP route: Codex
`https://chatgpt.com/backend-api/codex/responses`, or token-sharing
`https://api.openai.com/v1/responses`. It re-stamps bearer and actual Codex account
headers without changing bodies or responses. Both OAuth flows strip prepared
WebSocket options and refuse physical handshakes. API-key behavior is unchanged.

OpenCode owns enrollment and refresh, under the host's serialized credential
resolution commit shared with xAI. Unscoped plugin loads return stored values
without renewal. Only a refresh commit writes OAuth values; startup method
migrations remain logged no-ops. Catalog readers use metadata. Usage uses the
existing private `openai-read-selected-owned` read under an `openai.integration`
grant, verifies the active metadata ID, and forwards only Codex access/account
fields to the usage fetcher. It never refreshes or forwards the refresh token.
`openai.attempt` remains; `openai.access` is removed. The compatibility context
pinning flag applies only to token-sharing; Codex retains OpenCode's model limits.
See the [native Codex audit](../../../../../../docs/audits/2026-10-11/native-codex-signin/README.md).

Provider credential resolution reads its selected snapshot inside the serialized
mutation queue. Concurrent requests may advance only through a refresh committed
by that same controller while their resolutions are pending. Account switches,
revoked authorization and unrelated credential replacement still fail. Session
correlation includes the credential request's binding, allowing title and primary
request resolution to be traced independently.

Anthropic requests retain their native parser and physical-attempt scope. The
controller accepts only `/v1/messages` and the native `/messages` alias produced
by saved legacy root base URLs; both target `/v1/messages` on the owned Meridian
origin. Other path prefixes, token-count routes, user information and fragments
remain refused. Owned headers replace prepared credentials, and the attempt is
released on completion, refusal or cancellation.

Claude inspection uses the implicit default account when there are no saved
profiles, the sole profile when there is one, and the exact configured default
when there are several. An ambiguous selection stays unavailable. Ordinary
shared credentials are read from their original owner without renewal or writes;
expired shared credentials require reconnecting through Claude Code/Meridian.
Dedicated enrollment is optional automatic renewal.

Dedicated enrollment is global to the bundle. `native-claude-enrollment-location.js`
binds a request to its own directory when that directory is a reviewed location,
and to the default location (`locations[0]`) otherwise, so a registered project
outside the bundle's project map can still list, start, complete and select
enrollments. A bundle with no reviewed default location still refuses with
`native_claude_enrollment_location_unreviewed`.

Dedicated profile deletion uses the same administrator binding and credential
mutation queue. It refuses selected profiles, including the implicit first saved
profile; the user must explicitly select another first. The private provider fence
refuses active attempts, inspection or worker startup and blocks new Claude work
until deletion settles. Only the exact lifecycle enrollment, generation, canonical
directory and derived credential service confer deletion authority. Reviewed store
reads must match both saved record and grant fingerprints before the exact owned
Keychain service/account is deleted; deletion performs no renewal or issuer revoke.
A missing incomplete credential is allowed, while unreadable or changed records
remain refused. An absent directory can still have an owned credential; dangling
links and recreated directory identities refuse.

`prepare-deletion` records a durable `deletion-prepared` intent before mutation,
retaining fingerprints and the observed directory identity. It fences credential
access, selection and bundle clone authority. The profile file owner checks its
original byte baseline and preserves other profiles and settings; directories are
removed nonrecursively. Partial failures stay listed as `deleting` and can be retried
with fresh administrator authority. `settle-deletion` removes only the matching
enrollment after cleanup. Successful UI deletion refreshes the runtime configuration.
Removal of a profile present in the provider's saved configuration invalidates
that cache as soon as the profile file mutation succeeds, including partial cleanup.
Claude attempts and inspection then refuse until reconfiguration retires the owner.
Deleting an unpublished incomplete profile does not invalidate the working provider.

The reviewed macOS Claude Code asset is pinned to 2.1.280, the minimum version
required by the saved Opus 5.5 selection. The existing npm hydrator verifies the
archive integrity and exact binary hash/size; native build/startup signature checks
remain required. Meridian and Agent SDK versions are unchanged. Windows retains
its separately qualified executable pins.

Claude subprocesses launch through `native-claude-transport-host.js` on the host,
using the provider worker's existing private IPC. Applying a second execution
supervisor inside the already confined Meridian worker fails at `setpgid` before
the Claude executable starts. The host admits only an issued attempt for its exact
session, directory and profile, verifies the immutable executable, and resolves
access credentials itself. Workers cannot supply a command or environment.
The original model pins, effort arguments, quiet settings and account/directory
state key remain intact. Every launch uses the accepted read-only supervisor,
including its protected read roots, scoped state writes and termination receipt.
The synchronous SDK child adapter streams bounded chunks; stdin advances only
after host write acknowledgments. Cancellation, attempt retirement and shutdown
await the physical supervisor. Infrastructure refusals retain finite transport
errors and exit 125 instead of becoming a misleading generic exit-one auth error.
The obsolete nested `--claude-transport-worker` entry is no longer accepted.

New builds and activation candidates require the current reviewed Claude pin.
Bundle cloning and explicit rollback alone may verify the exact previously
reviewed macOS ARM64 Claude 2.1.251 identity (digest, size, mode and signature).
These constructor-owned `bundle-source`/`bundle-rollback` purposes never come
from HTTP metadata; prepared targets and retained-candidate resume stay current-only.
An explicit rollback selector grants its historical purpose at load and before
spawn. Cold upgrades use `upgradeSelectedNativeBundleAtStartup` inside the existing
bootstrap file lock, before any controller or data owner starts, preserving the
verified source and credential checkpoint through the ordinary lifecycle.

Claude stderr is drained into a finite, constructor-scoped process receipt
reported as `native_claude_process` through the existing diagnostic journal.
Receipts retain exit code, signal presence, bounded byte counts and allowlisted
clues for explicit HTTP/auth, model/argument/configuration, launcher/module/syntax,
permission, connection and native receipt failures. Numeric matching state spans
chunks without retaining stderr text. Unknown text stays unknown; exit code 1
does not establish an auth failure. Diagnostics do not change provider errors,
streams, credentials or process cleanup. Updated compiled provider workers are
required to emit this private protocol observation; older workers remain usable.

## Startup diagnostics

The native controller composes the actual location graphs in `bootstrap.ts`.
`startup-catalog.ts` reads their agent, plugin and model HTTP catalogs after the
plugin activation barrier. Model availability remains a separate per-selection
result; unavailable saved models do not block intrinsic startup readiness.

The native owner verifies each launch after prior-controller settlement, then
runs the lifecycle's `beforeConfiguration` callback to synchronize managed
configuration before capturing its snapshot. The lifecycle does not repeat the
same full bundle scan. Boot's fresh bundle verification also carries its checked
artifacts privately to the loader, pinned to the exact selected manifest,
controller, writer and supervisor. This receipt is not serialized. Executable
configuration is still checked and imported from its exact validated bytes;
the independent artifact verification immediately before controller spawn and
all restart/checkpoint verification remain in place.

`native-catalog-diagnostics.ts` classifies known host refusals, construction and
model stages, and schema failures. HTTP response-body schema failures use
`response_schema_invalid`, including the SDK's `InvalidRequestError` with
`kind: Body`. A failed model HTTP read therefore reports
`native_catalog_read_failed_model_http_<status>_response_schema_invalid`.
Arbitrary errors retain `cause_unavailable`; response text is never used to
infer a cause.

Retired OpenAI OAuth methods (`chatgpt-headless` and `chatgpt-siwc`) and
`chatgpt-browser` rows carrying token-sharing `metadata.clientID` resolve as
unavailable catalog connections. Their
presence cannot prevent startup, refresh a credential or rewrite the database.
Physical requests still refuse unsupported authentication before acquiring
access. Other unsupported methods retain `openai_method_unsupported` in catalog
diagnostics. The cold graph regression starts with a synthetic retired login
and NULL connector/method columns and requires model HTTP 200 in both locations.

Provider usage reads: `provider-read-selected-owned` (protocol allowlist
`directory`, `controllerInstanceID`, `integrationID`) is a read-only owned
action limited to `xai` and `opencode-go`; the protocol parser rejects every
other integration. The controller refuses a foreign controller instance or an
unreviewed directory, returns nothing when no credential connection is active,
requires xAI `oauth`/`device` with an access token or an OpenCode Go key, and
refuses `native_credential_changed` if the active credential changes during the
read. It never refreshes, writes or logs the value, and an xAI reply carries only
the access token and its expiry — the refresh grant never leaves the controller.
The host owner exposes it as
`readProviderSelected` under a `provider.integration` caller grant, and the
reply's instance, directory and integration are verified. Credential metadata
validation accepts OAuth rows only for OpenAI `chatgpt-*` methods and xAI
`device`; other providers must be keys.

SDK endpoints can retain their construction error reporter. An asynchronous
request scope routes its reports to the active catalog assertion, without
mixing concurrent requests or retaining a previous request's failure. Cause
chains are bounded and cycle checked. Native schema issue trees, or the SDK's
converted formatter path lines, yield at most eight paths of 256 characters.
Only enumerated native field names and numeric indices survive; dynamic record
keys become `<key>`. Input values, reason text, stacks and configuration are
never recorded by this producer.

`native-provider-compat.js` validates each model against the encoded `Model.Info`
schema and checks JSON serialization before policy normalization and after
provider discovery. The compatibility service excludes unencodable rows from
catalog reads and records `model_response_schema_invalid` with a model index
and safe field path. Healthy model references and unchanged arrays survive.
The source config and database are not rewritten. This guard may remove a
saved model from the picker; it does not establish that an installed incident
was caused by an invalid model.

`native-process.js` retains at most 4 KiB of controller stderr in memory. Raw
stderr is never written to its lifecycle log or journal. After owned termination
on startup failure, only sanitized recognized logfmt fields (`level`, fixed
`msg`, enumerated `name`/`_tag`, whitelisted `schemaPath`) attach to the startup
error. Successful binding also exposes these bounded diagnostics. The runtime
owner includes them in the `native_startup` failed/bound journal record. The
existing observation-gap marker remains deduplicated across stderr chunks.
The harness sanitizer validates these fields again and preserves exact fixed
catalog codes through journaling and export without the high-entropy heuristic
redacting them. Unrecognized plugin text cannot become journal evidence.

The isolated `startup-catalog-reproduction.mjs` runner captures Cursor model
IDs, prices and variant structures and optional Anthropic credential presence.
Endpoints and credentials become synthetic loopback fixture values. Its
`--legacy-oauth-columns` switch clears legacy connector/method columns only in
the fixture's synthetic credential rows. `--output-root` is confined to repository
`.cache/sessions/` and retains the sanitized input documents. The host and
selection-view subprocesses run under Node even when the CLI runs under Bun;
the compiled native controller remains the supplied verified artifact.

See [runtime verification](../../../../../../docs/AGENT_RUNTIME_VERIFICATION.md)
and the [2026-10-10 incident audit](../../../../../../docs/audits/2026-10-10/model-catalog/README.md)
for isolation rules and the limits of the reproduced evidence.

### Startup timing

The web entry logs `bundle_preparation` and `application_import` before the
journal owner exists. Native launch logs consecutive `native_settlement`,
`native_verification`, `native_configuration_sync`, `native_configuration`,
`native_controller`, `native_recovery`, and `native_open` durations through
`../startup-timing.js`. These records contain fixed phase names, monotonic
elapsed milliseconds and completion/failure outcomes only. Existing journal
startup/failure records and recovery ordering remain authoritative. The timings
are observations, never readiness or integrity shortcuts.

Bundle upgrades additionally time artifact verification, artifact retention,
database checkpointing, data copying, candidate preparation and selection.
These are nested spans, not additive startup durations. Artifact and bundle
copies request filesystem copy-on-write with ordinary-copy fallback; they never
share writable inodes. Large file hashes stream through SHA-256 rather than
buffering whole executables. Source/destination verification, signatures,
SQLite snapshotting, checkpoint ownership and selector CAS remain mandatory.

Harness relocation retains the immutable baseline `projectMap`. Additional
projects registered through the normal project settings owner are preserved at
their exact canonical directory, using the checkpointed settings copied into
the candidate. This identity allowance covers harness records and derived task
context keys; it grants no parent, sibling or descendant scope. Symlinks and
private source/candidate bundle paths remain closed, and an unregistered
directory still fails with `bundle_harness_directory_unmapped`.
Removed registered projects retain these historical identities without becoming
executable locations; recreated symlink or noncanonical directories still refuse.

Startup binding reads sealed bundle documents with the same 32 MiB
`BUNDLE_DOCUMENT_MAX_BYTES` limit used by bundle storage and native boot
verification, checking both file metadata and bytes read. Hash, canonical-path
and symlink checks remain required. Electron's startup failure page falls back
to its default appearance if selected-bundle settings cannot be read, preserving
the original error and Retry action even after an upgrade changes selection.
The [runtime preparation audit](../../../../../../docs/audits/2026-10-10/runtime-preparation/README.md)
records the incident and isolated packaged regression evidence.

### Abandoned execution leases and explicit reboot recovery

The startup upgrade and every launch verification run `inspectBundleHarness`,
which refuses any ledger lease that is not `published`/`cancelled` or still has
`cleanupPending` (`bundle_execution_unsettled`). In-runtime lease recovery runs
only after launch. `native-bundle-lease-recovery.js` therefore settles the
selected bundle's abandoned control leases first, inside the bootstrap lock and
before setup-source removal and the startup upgrade
(`recoverSelectedBundleLeasesAtStartup`, called from `native-default-bundle.js`).
It qualifies never-spawned control leases (`preparation: 'none'`) whose view
lies inside their own ledger's `views/`. Orphan process leases additionally
require a verified source launcher, a released native execution-owner lock and
their genuine supervisor termination receipt or the host's
`cancelledBeforeStart` attestation. A claimed `ready` process lease whose
receipt file is absent, reserved more than ten minutes earlier, is cancelled as
never started: the supervisor creates its receipt exclusively before it forks,
the confined command cannot write beside its view, and no owner of the bundle is
alive to launch a late supervisor. An existing but empty or invalid receipt
means the command may have run and stays held. It refuses while a live process
owns the bundle (`assertNoLiveOwner`), refuses pending materialization, and is
skipped on Windows. It cancels and cleans through the existing
`recoverExecutionLeases` and logs the `bundle_lease_recovery` startup phase only
when it has work. It never throws; anything left unsettled still fails the
strict gate. Its log line lists every distinct failure and names system errors
(`bundle_lease_recovery_failed:ENOENT`).
`assertSelectedBundleLeasesSettled` reads lease records before expensive cold
upgrade work; full bundle verification still owns admission. Its refusal carries
identifier-only `detail` (ledger prefix, lease token, state, kind), which the
startup upgrade writes to the log.

The trusted native action `beginNativeBundleRebootRecovery` in
`native-bundle-reboot-recovery.js` prepares `recovery/reboot.json` under the
bootstrap, selection and ledger locks (in that order). It only accepts a claimed `ready` process lease
whose supervisor receipt is absent, after native owner proof. Invalid receipts
and genuine available receipts do not qualify. The private versioned fence
pins the exact selector/descriptor, ledger records, lease hashes, active lease
Git refs and private view hashes, plus the macOS kernel boot-session UUID.
It neither reboots nor changes the lease. The ledger and view digests are
computed as streams with no record, entry or byte limit, since a ledger holds
several records per project file; `readBundleLeaseInventory` returns only lease
records with the digest. Sockets and FIFOs in a view are recorded by type.
Repeated preparation that matches the same evidence returns the same fence.
When the evidence under an unfinished fence has changed, preparation renames it
to `recovery/reboot-superseded-<fenceID>.json` and fences the current evidence;
leases the old fence already recovered stay recovered.

`finishNativeBundleRebootRecoveryAtStartup` requires its caller to hold
`bootstrap.lock`; it acquires selection ownership before ledger locks. A different kernel boot UUID establishes termination of
pre-fence processes. The original selector, ledgers and views must still match;
same-boot retries, live owners, materialization and changed evidence refuse.
Recovery records `devryan.session-reboot-recovery/1`, cancels the lease with an
explicit `uncertain` outcome, and retains its private view. The terminal
`cleaned` marker prevents normal cleanup from deleting retained evidence; it
does not claim the view was removed. Its active lease snapshot moves atomically
to `refs/devryan/reboot/<fenceID>/<token>` with the exact original OID, so cloning
preserves the historical evidence without treating its old snapshot as live.
No command is replayed, no result published and no termination receipt forged.
Partial completion is idempotent, including an additional reboot before retry.
The strict harness verifier recognizes only the exact terminal attestation;
relocation preserves its stable token/owner/scope identity. Runtime outcome
queries keep the call uncertain, and never-started cancellation cannot
reclassify it.

`native-cursor-recovery.js` keeps one write-ahead intent per Cursor turn under
`harness/native-cursor/`, stamped with the bundle ID that wrote it. A bundle
upgrade copies pending intents into the clone. The clone accepts intents of its
verified `sourceBundleID`, re-stamps them under the recovery lock and settles
them as its own; any other owner is `native_cursor_recovery_owner_mismatch`.

Native managed control calls (`devryan_task`, `council_session`) record the
execution-host owner on their lease. When `finish` fails, for example because a
timeout or Stop retired the tool permit, `nativeManagedControl` cancels and
cleans the exact scope-matched `ready` control lease and rethrows the original
failure. `recoverExecutionLeases` also settles owner-less control leases left by
earlier builds. The [incident audit](../../../../../../docs/audits/2026-10-11/bundle-execution-unsettled/README.md)
records the evidence.

## Claude updates in About

The shared UI's `ClaudeCodeVersionSection.tsx` displays the running bundle's
Claude identity through `../claude-runtime-update.js`. The public registry check
is informational. Applying a verified bundle reuses `BundledRuntimeUpdate.tsx`
and the existing runtime bundle lifecycle; no runtime pin, executable integrity
check, credential checkpoint or rollback rule is relaxed. The reusable update
control accepts a refresh key after an explicit About check and reports pending
mutations so About cannot refresh away an in-flight transition. It disables its
mutations while About is checking. App-delivered Claude upgrades use the ordinary
DevRyan update dialog and its existing download/restart path.


### xAI usage renewal

`provider-refresh-selected-owned` is an exact-field controller operation for the selected xAI device OAuth credential. It carries the original usage caller grant, controller/location identity, credential ID and expected fingerprint, never credential values. The `provider.usage` GET scope authorizes one update with the fixed renewal-intent fingerprint; create, activate, remove and other providers remain refused. The registered native xAI implementation renews inside the existing reverse credential mutation queue and rechecks caller, acquisition and selected record before commit. Usage and admitted model resolutions share pending renewal observations; one bounded prior-renewal receipt per reviewed location permits reuse of this owner's renewal without accepting unrelated writes. Quota reads remain read-only until their usage request is rejected. Refresh tokens never cross into the web fetcher. The default launch quota refresh therefore loads usage without a chat request.
