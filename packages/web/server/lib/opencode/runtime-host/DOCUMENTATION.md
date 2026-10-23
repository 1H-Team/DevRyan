# Native startup catalog diagnostics

## Managed task admission errors

The controller bridge preserves the shared allowlisted model-admission reason,
bounded model tuple and constructed Settings guidance. It continues to expose
only the code for other bridge failures. This lets `devryan_task` explain an
unsupported reasoning variant without forwarding foreign error text or arbitrary
details. Admission records the parent dispatch message and tool-call identities
before any child session is created.

## Image context preparation

`native-image-runtime.js` skips the confined image worker only when the selected
canonical user rows contain exclusively text parts (or no parts). It still
validates the canonical anchor, authorization and unchanged before/after context,
and retains owned-request cancellation and settlement. Historical images and
unknown part shapes keep the existing worker and publication path. A successful
validated return emits `native_image_context` with only the `text-only` or
`worker` outcome, bounded message count and elapsed milliseconds; observation
cannot change context delivery. Direct image routing is unchanged.

## Mandatory startup contract

`native-artifacts.js` bounds manifest reads and keeps every integrity check before
execution. Within one process, a payload's SHA-256 and code-signature results
are reused while its path, device, inode, size, mode, mtime and ctime are
unchanged (boot, inspection, native start and spawn otherwise re-read about
0.5 GB each); a result is recorded only if that identity was stable across the
read, and every other manifest, inventory, reviewed-asset and launcher check
runs on each call. Verification failures retain the public code
`native_runtime_artifacts_unverified` and a sanitized stage, reason, basename and
verification purpose. The same manifest reader covers first provisioning and
cold upgrade detection. Early failures emit the safe envelope before a journal
exists; composed native failures add it to the bundle/controller journal event.
`bundle-startup-upgrade-status.js` carries it to lifecycle health, including a
failed repair at the same OpenCode version. A current bundle must be compiled
with `NATIVE_BUNDLE_BUN_VERSION`; an installed bundle built with a
`REVIEWED_PREVIOUS_BUNDLE_BUN_VERSIONS` entry is accepted only as a
`bundle-source` or `bundle-rollback`, so upgrades can still read it.

### What refuses startup and what is isolated

Startup refuses only for in-flight or foreign state: unsettled leases, pending
materialization or revert, `committed` removals, running tasks, lost session,
message or Git references, descriptor, manifest, artifact, credential and
checkpoint failures, and any relocation to a different directory. A defect in a
record that is already finished, or in a derived tree, is isolated and
reported instead:

- `inspectBundleHarness` returns `findings` (`{ code, ledger, key }`,
  identifiers only, at most 256) for a `completed` native removal that fails a
  shape check, a terminal lease whose receipt, attestation or view path is not
  exact, a stray entry in `session-mutations/` or `evidence/records`, and an
  evidence record outside `complete`/`gap`. A completed removal keeps excusing
  only the sessions it still proves, so a session it cannot excuse still fails
  as `bundle_session_reference_lost`. A `cancelled-calls/` marker only blocks a
  late start of its call, so a message or session it names that is gone is a
  finding too; the same lost reference on any other record still refuses. An
  orchestration ledger task's references belong to its `childSessionId`, so a
  removed child session excuses them; a lost reference in a finished task
  (`completed`, `failed`, `aborted`, `interrupted`) is a finding with ledger
  `orchestration` and key `tasks/<taskId>`, while a `queued` task still
  refuses. With a non-identity project map every finding throws.
- The clone copy leaves behind sockets and FIFOs anywhere, and symlinks inside
  a project ledger and under `global/{cache,tmp,log}`. Links under config,
  `global/home` and `global/data` still refuse with `bundle_symlink_source`.
- Cursor recovery pauses the one session whose intent it cannot settle
  (invalid, foreign owner, scope mismatch, unconfirmed termination) with a
  `<bundleID>-cursor-recovery` hold, keeps the intent, and continues. The
  native owner releases those holds at each startup before recovery
  re-examines the intents. An unreadable intent names no session and is only
  reported. Other recovery steps stay all-or-nothing.

`data-root-startup.js` runs the one-time data-folder move before any data-root
reader (Electron main, the server entry outside Electron, the CLI); a merged or
unmovable folder becomes a `data_root` startup notice. `startup-notices.js`
collects these for the process. The health snapshot
exposes them as `startupNotices`, and the UI shows a persistent warning.

A refused cold upgrade is recorded, not thrown. When the selected runtime
still meets the OpenCode version pin and passes its own launch verification,
it launches and the upgrade retries at the next start. When the selected
runtime is an older reviewed native release (`NATIVE_PRIMARY_SUPPORTED_OPENCODE_VERSIONS`),
the refusal records it as the retained version and `resolveExpectedOpenCodeVersion`
names it instead of the pin for this process only
(`readStartupRetainedRuntimeVersion`), so the app opens on that runtime with the
`bundle_upgrade` startup notice instead of locking out. Any other version below
the pin still refuses with `bundle_upgrade_required`. When the retained
runtime's verification fails too, `startupUpgradeFailureOver` reports the
refused upgrade with the verification error as its cause, so an old-pin
rejection cannot mask the original refusal. Cold
upgrade preflights the selected harness after owner checks and before artifact
retention; the full final verifier still runs. Compatibility checking shares its
fresh source result only with the immediately following upgrade decision, never
across checkpoint, mutation or spawn boundaries.

First-run setup preserves explicit background-service opt-out and disabled Bot
runtime preferences. It still excludes prior service registration and ownership
state, so provisioning cannot silently turn a user's opt-out into registration.
The setup preference allowlist also preserves `helperModelSelection`, including
its saved revision, independently from primary and notification model choices.

Existing startup timing records now include manifest payload hashing, signature
verification, first-install artifact retention/preparation/selection and binding.
Shell visibility and ownership resolution precede binding/controller readiness;
renderer directory/session readiness and the global event-stream ACK complete
the contract. These observations do not bypass checks; only per-file artifact digests and signatures are reused, as described above.
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

Native registration also captures `DEVRYAN_MANAGED_RESULT_CONTRACT_VERSION`
from the host capability projection. Version 2 exposes batch result reads,
settled waits and ordered bulk continuation. Compatibility plugin hosts retain
scalar version 1 because they lack the canonical native later-Step reader.
Both the owner cursor-normalization slice and attached native executor intersect
v2 attention with `changedTaskIds`: an unchanged parked child does not return
control to the model while a selected sibling runs. Full settlement still
returns immediately; v1 ready/attention behavior is preserved.

`native.managed-task` RPCs get a 45 s transport budget: a 25 s wait slice plus
its single authorization pass and publication reads. On a transport timeout the
attached executor re-issues `start`, `status`, `wait` and `wait_any` unchanged,
up to three consecutive times, while the invocation stays live. An exhausted wait
returns its last live slice, or a `wait_slice_timeout` notice. Other actions fail
with `managed_task_host_timeout`, so raw timeout text never reaches the model.
Each start phase has its own 25 s budget: preparation, then the commit, timed
from when the session permit is acquired. Parallel starts queued behind
siblings therefore cannot exhaust it. An uncommitted start that runs out reports
`native_task_start_timeout`, and the executor retries it under the same
idempotency key. A terminal `status` collects and stages exactly like `wait`.
Reading a result that was never collected reports `native_task_wait_required`.
v2 `continue` returns only its committed receipt.

`native-managed-publication-owner.js` reads ordered canonical messages under
the current prepared attempt and reviewed configuration. A handler response is
only a delivery candidate: `native-managed-results.js` requires its exact
completed native tool part, input and output, rejects native truncation, and
collects every required metadata/report page. Disposition requires an authorized
assistant Step later than the last needed publication in that canonical order.
Controller, configuration, original objective, cancellation generation and
attempt changes revoke the live grant; diagnostic and UI events grant nothing.
Restart requires explicit recollection of the same retained envelopes. Candidates
are bounded to the latest verified publication and one pending delivery.

Page acceptance and its publication candidate are staged synchronously together;
a failed publication read leaves the exact cursor retryable. Publication reads
retain only recorded message identities from bounded 200-message pages (2,000
records, 20 pages and 64 MiB maximum), with five-second native page requests.

Native result collection allows 24 KiB raw report/metadata pages only under its
constructor-owned v2 scope; a result's own version flag cannot upgrade v1's
8 KiB limit. Exact serialized reply caps, canonical publication, full section
coverage and later-Step disposition checks remain separate and mandatory.
Repeated publication checks still reread canonical payloads and fresh primary
and authority state; no immutable history-version receipt currently permits
payload reuse. The page evaluation
recorded reduced calls and unqualified latency results.
Long sessions do not require a full transcript scan. Bounded disposition barrier
inspection stays under the disposition permit; the long-running result-read
permit remains limited to status, wait, wait_any and read_result.

The actual Plan application gate retains its 480-second absolute limit and
reserves two existing 30-second cleanup allowances. It owns browsers before
readiness, drains queued opening/capture work on failure, and requires natural
application exit plus empty process registry. Native/QA and UI source, runner
and live loaded entry bytes are pinned before/after on success and failure;
helper reload proves the exact selection and enabled UI hydration.

## Built-in agent orchestration

The agent orchestration derived from Oh My OpenCode Slim (`devryan.slim`,
`devryan.slim-commands`, `devryan.slim-lifecycle`) is part of DevRyan, not a
plugin. `native-core-registrations.js` lists these origins;
`native-configuration-snapshot.js` activates them in every location whenever
the bundle registers them, with no `plugin` entry, and always resolves Slim
agent routing. The retired adapter and package specs an upgraded setup still
lists are ignored (`isRetiredDevRyanPluginSpec`), never rejected. Ponytail's
specs are retired the same way: there is no `devryan.ponytail` registration,
`native.ponytail.command` RPC or `ponytail` action on `native.slim.hook` (which
accepts `assert` and `message`), and the snapshot neither reads a stored
`.ponytail-active` mode or `ponytail/config.json` default nor injects mode
instructions or `/ponytail` commands.

Its code is the workspace package `@devryan/agents-core`
(`packages/agents-core`, see its `DOCUMENTATION.md`). Every `native-slim*`
module, `controller-slim.ts`, `controller-webfetch.ts`,
`native-image-worker.ts`, `native-interview-worker.ts` and
`reviewed-configuration-entry.ts` compile against its declared surface
(`index.d.ts`); the native build bundles it from source. Host owners follow its
3.x algorithms:

- `native-context-assets.js` parses and remaps the image hook's notice (a
  readable and an oversized section of saved paths). The image worker keeps no
  state between runs.
- Interview documents support `markComplete`, `markIncomplete`, `stat` and
  patch rewrites. A patch that does not apply crosses back from the confined
  worker as `native_interview_patch_failed` (bounded hunk and context) or
  `native_interview_patch_required`, and `native-interview-owner.js` rethrows
  the original error class so the service's repair flow runs.
- `native-slim-context-owner.js` maps managed tasks to the 3.x board record
  (recency from the attempt's timestamps). Its primary fallback hook leaves
  canonical child sessions without a primary objective to the managed executor:
  native retries stop and publish the original provider failure, preserving
  managed usage-limit backup and manual recovery policy. Missing primary
  ownership on a root session remains fenced.
- Webfetch results may carry inline image attachments, mapped to file parts;
  the host never enables them (`imageRouting` is not `direct`).
- `REVIEWED_AST_ASSET_SHA256` lives in `reviewed-ast-asset.js`.

## Host helper and title ownership

`native-configuration-snapshot.js` applies `runtime-helper-agents.js` after saved
and Slim agent resolution. This installs the hidden, deny-all `devryan-title`,
`devryan-commit`, `devryan-pr` and `devryan-notify` roles without assigning a
model or variant, and disables native `title`. The existing standard title
coordinator owns generation, bounded retry/fallback and compare-before-rename
persistence. Without those roles, `controller-webfetch.ts` rejects generation
with `native_helper_agent_unavailable` before a provider request. The compiled
controller-webfetch test now starts from resolver-produced configuration;
the multipart Plan admission/projection/title regression checks that synthetic
format instructions remain excluded while every real request part is retained.

`native-authorization.js.captureHelperSelection` resolves the effective shared
helper tuple/revision inside current title-owner or exact web-caller grants.
`devryan-notify` (notification summaries) follows the title path: detached
authorization bound to the canonical session, with a session required and no
web request principal. `native-admission-owner.js` retains this configured/active
selection alongside the existing title, commit, PR or notification purpose and
rechecks it before physical model use. The helper input's `variant` must equal
the captured selection's: a configured helper sends its saved reasoning level (none
for Default), and active fallback sends the session's own variant. Admission requires a captured revision
and recheck owner; missing authority refuses before provider work, while
unavailable settings return 503.
Neither path switches the primary selection or grants tools.
An issued private title permit admits only its exact native rename after fresh
session/title/model/agent, revision/hold and owner checks. That validated permit
does not fall through to generic operation authorization, which continues to
deny an ambient `session.rename`. Native transaction-local compare-before-rename
and manual-title priority remain mandatory.
Cold helpers acquire the original location graph through `LocationServiceMap`
and await its plugin activation inside a scope held through provider settlement.
`generateReadyHelper` resolves its model through `SessionContext.resolveModel`, the
location's `SessionRunnerModel`, as primary turns and webfetch secondaries do. That
decorated resolve opens the permit-bound credential resolution scope and records
the selection proof that owned providers (OpenCode Zen, xAI, OpenAI) require at
`model.request`. A bare `ModelResolver` read skips it and every owned-credential
helper is refused (`native_*_resolution_proof_required`, HTTP 503); a fixture
provider without credentials does not detect this, so
`scripts/opencode-v2-native/native-helper-credentials.graph.test.ts` drives the
helper through the real OpenAI credential owners. The controller HTTP route
reports a refusal's bounded `native_*` `code` (not only its message), and title,
Git and notification diagnostics journal that code.
They do not create a persisted conversation to initialize native services.
The constructor composes the scoped helper LLM capture inside the stream
continuation owner's winning LLM override. LayerNode replacements are last-wins;
independent overrides would silently discard one owner. The captured client is
the actual wrapped native service, and both owners expire with its original scope.
The configured-instructions plugin maps finite captured agent `temperature` and
`top_p` defaults into native generation options for the qualified native
OpenAI-compatible chat package. It respects explicit legacy sampling capability
disablement, preserves preceding hook choices and omitted defaults, and copies
no arbitrary request-body fields. Other provider packages remain unqualified
for this mapping; GPT high-effort sampling stays omitted.
The helper owner starts one deadline before admission, checks it before dispatch,
and retains expired/unsettled work until real ACK/exit. Private accepted-input
verification admits a paused title cycle only for a canonical `origin: human`
record; body text, synthetic input and replayed ID cannot reopen it.

## Reviewed skill resolution

`native-reviewed-skill-execution.ts` accepts `{ id, name? }` for the native `skill`
tool and resolves it with `reviewed-skills.js.resolveReviewedSkillRequest` against
the invocation location's reviewed skills only: the exact ID or alias, then a
supplied `name`, then a single reviewed `devryan-<hex>` ID within edit distance 2
of a mistyped one. Two or more near IDs refuse. The hashed ID stays the permission
resource. A refusal reads `native_skill_unreviewed: ...` and lists the reviewed
skill names (`reviewedSkillNames`, at most 50) so the model's retry can name one.

## Native Claude checkpoint continuity

Claude checkpoint verification uses `native-claude-checkpoint.js` to derive the
same private account/location state directory as the physical transport. The
worker exposes that directory only for the current constructor-authorized
attempt, session, location and profile; SDK profile environment paths cannot
select a native transcript. Canonical checkpoint reads reject symlinked state,
project and transcript paths and recheck attempt authority after the read.
The canonical helper remains `../meridian-passthrough-handoff.js`; native asset
preparation embeds it as a recorded rewrite of the hash-checked captured helper.
Checkpoint settling, settled, rejected, retained and replay observations use a
finite `claude-checkpoint-diagnostic` frame and `native_claude_checkpoint` journal
record. Only event/reason enums, bounded tool counts and correlation identities
cross that boundary. Raw Meridian logging remains disabled; diagnostic failure
cannot change execution or retention.

## Native grep and glob execution

OpenCode 2.0.30, 2.1.0 and 2.1.3 spawn ripgrep for `grep` and `glob` through `Environment.spawner`.
`execution-routing.ts` turns that spawn into `execution.native.start` with
`kind: 'read'`, and the host runs it under the read-only supervisor in
`session-execution-host.js`. A location's read and protected roots may not exist
yet (the per-directory webfetch scratch root under `global/tmp/devryan-webfetch`
is created on first use). The host resolves them with `canonicalTarget` from
`native-read-paths.js`, as the controller read guard does: a missing root
canonicalizes through its nearest existing parent, so a missing protected root
still protects its location. The working directory itself must exist.

The read handle keeps the supervisor's stdout and stderr apart, because core
parses ripgrep's `--json` stdout line by line. Shell handles stay merged.
Core reports any refused spawn as the generic "ripgrep execution failed", so the
host journals each refused or uncertain read start as a `session_execution`
record with `phase: 'native_read'`, `state: 'failed'` and the bounded host code.

## Private recovered execution during startup

During the private `recovering` startup phase, stream preparation and native
observations accept only the exact live controller and a session with an actual
current recovered-input grant. Native provider-attempt admission still rechecks
the permit's captured grant and shell receipt before inference. Missing, foreign,
old-instance and consumed grants cannot open that path, and public startup stays
closed until `open`. The stream owner records its known current-scope refusal
code and action without exception text, RPC payloads or stderr.

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
scheduler admission. This bounds preparation, not already committed execution
or the result-collection wait. Native selection validation bounds catalog reads at 20
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

### Interrupted native streams

`native-stream-continuation.ts` decorates the constructor-owned primary
`SessionModelRequest.Prepared.retry` after the native/Slim decision. It can only
restrict a proposed retry. Its private attempt scope observes all five native
output-start setters, including empty text/reasoning starts, and requires a
successfully published canonical text, reasoning or tool-input start before
reserving a Continue. Diagnostics and projected messages grant no authority.
An independent constructor-private output flag remains after attempt-scope loss;
missing attempt proof after actual output vetoes retry. Native pre-output retry
still reserves nothing. The source and compiled `missing-attempt` graph scenario
must qualify that the third physical request is vetoed after two partial sends;
the lightweight retry-decorator tests do not substitute for that graph.

The private `native.stream-continuation` owner binds the exact controller,
configuration, permit, cancellation generation, physical attempt, original
objective and canonical failed predecessor. The pinned OpenCode 2.1.3
Synthetic event supplies its committed event ID, sequence, derived user ID and
payload fingerprint. The durable pending reservation becomes consumed before
successor preparation/send; Step adoption consumes its proof once. There are
at most two continuations per original objective. Plain Retry reserves nothing,
and a third Continue is refused before a physical request. New human input,
unsettled execution/tools/requests, changed selection or missing proof fail
closed. Lost publication or Step proofs expire on the existing progress
timeout; exact successor transport I/O can refresh liveness. Stop releases a
pending reservation, while uncertain failures retain the fence and enter
`needs_attention` with `provider_stream_interrupted`.

The transport wrapper mirrors the pinned publisher's per-physical-request
provider-error fence. After `provider-error` or a `step-finish` with
`content-filter`, later text, reasoning and tool start events cannot mark that
attempt as output-started. Source and compiled graph traces feed all five
setter events through the actual native publisher after each refusal; ordinary
pre-output Retry and the two-continuation capacity gate retain their own traces.

The HTTP observer measures pulled response bytes, chunk count and maximum gap
before SSE framing, without reading ahead or changing cancellation. Response
headers have their own timing mark; `first-byte` denotes the first body byte.
Only content-free typed timing fields reach the journal/export. The observer
enables no timer; the deadlines come from provider settings (see "Provider
transport deadlines").

API-key Session WebSocket timing is separate from those HTTP limits. In pinned
2.1.3, connection admission waits 15 seconds before its unsent HTTP fallback.
The real model resolver passes the provider's explicit `chunkTimeout` to the
Session WebSocket: a number sets the idle bound, `false` disables it, and an
omitted setting uses the session transport's 30-minute idle fallback. A
configured `openai` stanza now carries the 300,000 ms deadline default below, so
that is its idle bound. The model's
HTTP defaults separately contain 300,000 ms; that value does not become the
Session WebSocket idle default. Local source and compiled fixtures use actual
API-key WebSocket handshakes and model-request/transport services, advance the
Effect test clock for these bounds, prove frame-driven idle resets, and verify
that interrupting the stream closes its socket. They qualify transport Stop,
not a live provider or the desktop Stop control. No 900-second WebSocket total
cap or new 120-second post-output policy is claimed.

Native preparation records the actual `prepared.request.tools.length`. Each
linked physical send retains that count and projects the final materialized
JSON body's tool-array count through the existing bounded parse used for wire
reasoning options; unsupported/malformed bodies report null rather than zero.
No second body parse, stream consumption or tool content is introduced.
The same actual-body parse separately projects ordered Responses
`configuration_update` reasoning controls into optional `wireEffortUpdates`
(count 1–256 and the last finite effort). Top-level `wireOptions` remain literal:
GPT6 cache-preserving effort updates can set the effective effort while omitting
its top-level field. Malformed, unknown, excessive updates or conflicting top-level
effort aliases produce null update evidence and cannot qualify effective effort.
Only typed input-array controls are inspected; message content is never examined.
The strict QA grader retains this provenance and still requires exact accepted,
prepared and canonical-step selection. Default helper qualification refuses any
update evidence. These observations neither rewrite requests nor explain away
provider authentication failures.
`withProviderAttempt` supplies optional observation metadata from its private
helper entry. Only a retained captured selection can supply mode/revision;
constructors without selection capture refuse helper admission. The Node
observation owner rejects controller-supplied revision fields, compares the
prepared helper's actual agent/provider/model/variant with the exact admitted
helper input, rechecks the existing selection owner and then publishes the
captured revision. A bounded private request table also binds each physical
helper observation to its own prepared request, exact permit, tuple and tool
count; cross-helper or evicted request IDs produce a diagnostic gap. The table
never grants execution and never exports its permit identity.
Authorized active-session fallback keeps its distinct tuple.
This metadata supplies no execution or credential authority.

Finalizing presentation uses a separate read-only observation at the pinned
native step's post-model, post-tool-join settlement seam. The SHA-guarded
`native-finalization-observation-transform.mjs` brackets the existing mandatory
snapshot/files/publication work without changing its ordering or decisions.
The constructor-private producer binds the actual prepared request, step and
attempt; the host rechecks controller, permit, original user and assistant.
Progress comes from completed settlement operations, never timers or body
silence. Begin/progress observations do not await display I/O or change native
writes. The terminal observer drains its own finite queue before the original
permit is released, including the retained terminal mark under pressure. One
30-second aggregate budget starts at the interval's first enqueue; expiry or
native interruption aborts optional requests and drops unsent marks. An expired
or replaced interval cannot reopen, and observer failures cannot replace the
original save/error/cancellation outcome. Renewed model work,
cancellation, settlement and owner retirement clear presentation; this grants
no retry, approval or watchdog authority. The transform and helper are bound
inputs of both source qualification and compiled artifacts.

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
Dedicated enrollment is optional automatic renewal: a due dedicated profile
renews during status and usage inspection through the same serialized,
journaled renewal as a request, so an idle enrollment is never reported expired.

The host configuration snapshot also activates Claude catalog metadata for the
same unambiguous saved `claude-max` profile (including the legacy omitted type),
without reading its credential or contacting a provider. The constructor uses
the private Meridian configuration resolver; only a reviewed
`devryan.provider-compat` registration permits an empty Anthropic stanza. Saved
provider/model settings survive, and explicit provider exclusions, absent
profiles, inline credentials and ambiguous selection do not enable this bridge.
Meridian `profiles.json` and `settings.json` metadata are included in the existing
configuration capture/retry stamp. The original native configuration plugin owns
catalog activation; no placeholder API key or native credential is created.
The physical Meridian attempt still requires the original admission permit and
host-owned selected credential. Catalog visibility alone grants neither.
At a passthrough tool boundary Meridian closes the client stream early and then
drains the Claude SDK to its terminal result before it stores the session. A
normal attempt end (`provider.meridian.end`) therefore first drains the
attempt's Claude children on the transport host, waiting up to
`MERIDIAN_HANDOFF_DRAIN_MS` (12 s, just above the handoff's 10 s drain bound)
for them to exit on their own, and only then releases the worker attempt and
kills what remains. The drain is not a provider command, so other attempts keep
their command channel. An aborted attempt is released immediately. Killing the
child before the drain finished made Meridian evict the session
(`noncanonical_session_evicted`), so every later step replayed the whole history
as one flattened block and only the system/tools prefix hit the prompt cache.
The compiled provider owner is registered independently of the legacy plugin
list. Disabling legacy plugins does not disconnect that native account or stop
this metadata bridge; the saved plugin list is preserved.

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

The packaged macOS Claude Code fallback is 2.1.302. About can independently
select a newer official Claude executable through a managed installation record. The existing npm hydrator verifies the
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

New builds seed the current packaged Claude pin. Independently updated
activation candidates require the managed installation provenance and publisher
checks described below. Bundle cloning and explicit rollback also recognize
the historical macOS ARM64 Claude 2.1.251 and 2.1.280 identities (digest, size,
mode and signature).
These constructor-owned `bundle-source`/`bundle-rollback` purposes never come
from HTTP metadata; prepared targets and retained-candidate resume stay current-only.
An explicit rollback selector grants its historical purpose at load and before
spawn. Cold upgrades use `upgradeSelectedNativeBundleAtStartup` inside the existing
bootstrap file lock, before any controller or data owner starts, preserving the
verified source and credential checkpoint through the ordinary lifecycle.

An upgrade whose shipped manifest keeps the selected `opencodeVersion` and
`inputs.coreDigest` does not clone (`runtime-bundle-lifecycle.js` `applyCandidate`,
result `mode: 'rebind'`). Outside a Claude update and on non-Windows hosts it calls
the store's `rebindArtifacts` under the same checkpoint and `selection.lock`: the
selected bundle keeps its ID, data and checkpoint; `descriptor.json` gets the new
controller, writer and artifact manifest, `config/reviewed-plugins.json` the new
reviewed plugins, and `prepared.json` those hashes. It needs the same verified
artifact contracts and compatibility proof as a clone, and verifies the rebound
bundle before the selector flips. The journal under `<controlRoot>/rebind/`
(`intent.json`, protocol `devryan.bundle.rebind/1`) is written first with byte
copies of the previous documents; `selection.json` is the commit point. A failure
before it puts the previous documents back (`abandoned`). Rollback of a committed
rebind (`rebindRestorable`, `restoreRebind`) restores those bytes with a `rollback`
transition and needs no credential projection. `recoverRuntimeBundleRebind`, called
by `provisionDefaultNativeBundle` before the binding read, undoes a `pending`
rebind whose selector did not flip and completes an interrupted `restoring` one;
a journal that matches neither selector refuses with
`bundle_rebind_selection_changed`. Pruning keeps the artifacts the journaled
previous descriptor names. A different version or core digest keeps the full
migration-safe clone. Removing a reviewed registration is such an artifact-only
change: when Ponytail was retired, the shipped manifest lost `devryan.ponytail`
and its reviewed input while the core digest stayed, so a selected bundle that
still lists it rebinds and its `config/reviewed-plugins.json` is replaced by the
shipped registrations. A controller refuses a registration it has no plugin for
(`native_reviewed_plugin_unavailable`); the rebind is what keeps the two in step.

A clone hashes its copied tree several times (preparation record, prepared
manifest, prepared-phase verification). `runtime-bundle.js` reuses a file's
SHA-256 within the process while its device, inode, size, mode, mtime and ctime
are unchanged, and hashes trees with bounded parallelism (8 files) in stable
order; any modification changes ctime and is re-read.

Each clone leaves its source bundle behind, a full copy of the user's data.
`sweepSelectedLeftovers` (startup, inside `selection.lock` of an unheld
selection) calls `pruneSupersededBundles` before artifact pruning. It keeps the
selected bundle, `previousBundleID`, any bundle created at or after the selected
one, both bundles of a pending Claude activation's `sourceSelection`, and every
entry without a valid descriptor; it prunes nothing while a rebind is `pending`
or `restoring`. Clone origins (`sources/clone.json` `migrationOrigin`) and
source bundle IDs are only compared as strings, so removing `default-native` or
an older source is safe. Removal renames to `.stale-*` first; an interrupted
removal is swept at the next launch. Windows keeps every bundle.

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

The four `*.integration` caller operations recheck the original web authority
and controller after their awaited read before returning data. Other operations
retain their existing commit boundaries; this read fence cannot replace a
truthful committed credential-mutation receipt. Cursor runtime-status uses the
existing metadata owner for its exact current registered location, with the
current configuration digest. It does not widen provider configuration access
to directories outside the immutable import map.

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
for isolation rules.

### Startup timing

The web entry logs `bundle_preparation` and `application_import` before the
journal owner exists. Native launch logs consecutive `native_settlement`,
`native_verification`, `native_configuration_sync`, `native_configuration`,
`native_controller`, `native_recovery`, and `native_open` durations through
`../startup-timing.js`. Inside `native_configuration`, the nested
`native_configuration_locations`, `native_configuration_snapshot` and
`native_configuration_browser` spans time project locations, the configuration
snapshot and the managed browser environment. Electron bounds that browser wait
at 10 seconds and repairs recording (FFmpeg) in the background, so an optional
download never holds startup. These records contain fixed phase names, monotonic
elapsed milliseconds and completion/failure outcomes only. Existing journal
startup/failure records and recovery ordering remain authoritative. The timings
are observations, never readiness or integrity shortcuts. The desktop shell
registers `setStartupPhaseListener` (exported for `@devryan/electron`) before
importing the server, and turns phase starts into splash progress text.

Bundle upgrades additionally time artifact verification, artifact retention,
database checkpointing, data copying, candidate preparation and selection, or
`bundle_artifact_rebind` for an artifact-only rebind.
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

### Launcher order and binding

`server/index.js` calls `prepareNativeRuntimeEntry()` (`runtime-entry-bootstrap.js`)
and only then dynamically imports a composition (`application.js`, or
`runtime-bundle-recovery.js` for a held selection). The launcher captures the
shell-owned setup, provisions the bundle (including the cold startup upgrade in
`native-bundle-startup-upgrade.js`), verifies and binds the selection through
`initializeRuntimeBundleBinding`, which sets `DEVRYAN_DATA_DIR`,
`OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG`, and restores setup owners. Importing
`runtime-bundle-binding.js` or the launcher reads no selection and changes no
environment: `selectedRuntimeBundle` stays `null` until the explicit call. Modules
that capture paths at load (`application.js`, `auth.js`, `mcp.js`, `shared.js`,
`devryan-sidecar.js` and others) are therefore safe only behind the launcher.
Other processes either inspect with the pure `readRuntimeBundleBinding` (Electron's
shell, package and QA drivers) or, when they are their own launcher, call
`initializeRuntimeBundleBinding` before importing those owners. A selection change
after construction keeps the existing restart/relaunch semantics; there is no
live rebind. `runtime-bundle.test.js` checks this order in a fresh process with
conflicting ambient paths.

### One web host per process

`application.js` has two tiers.

- **Process tier.** This tier is evaluated once at import:
  - the bound environment and `selectedRuntimeBundle` (from the launcher);
  - private persistence;
  - the boot bundle verification;
  - the loaded native bundle and its runtime-selection record;
  - the `globalThis` HMR state.

  A failure here fails the import, and Electron answers it with a relaunch (`startup-retry.mjs`).
- **Host tier.** `constructWebHost()` builds everything with a lifecycle, once per construction:
  - the harness journal;
  - the session, Cursor, watcher and stream owners;
  - the session execution host;
  - the native runtime owner;
  - the scheduler;
  - the HTTP server;
  - that host's graceful shutdown.

  A failure here is a start failure, and Electron retries it in-process. The module exports (`gracefulShutdown`, `setupProxy`, `restartOpenCode`) and the process signal handlers act on the latest construction. Signal and error listeners are attached once per process.

`startWebUiServer` goes through `web-host-lifecycle.js`:
- A start while another is starting or running acquires nothing and fails with `web_host_already_running` (409).
- A new start is allowed after the previous start failed, or after its graceful shutdown completed (`onShutdownComplete`). It constructs a fresh host. The native runtime owner's `close()` and the session execution host's final drain are terminal, so they only end the discarded host's owners.
- A restart first clears the finished shutdown's `isShuttingDown` HMR flag.

Construction is timed as `web_host_construction`, inside Electron's `server_listen` phase. DevRyan never runs two hosts at once in one process, and a selection change still requires a restart or relaunch.

A failed start releases what it acquired before its error surfaces. The lifecycle runs that construction's graceful shutdown, which handles admission, then native settlement, then dependent infrastructure. It rethrows the original error with a non-enumerable `error.startupCleanup` of `{state: released|retained|failed, code}`.
- If native settlement is refused, the partial host keeps its owners (`retained`).
- The next start settles that host first, and constructs only once it is released.
- If it is refused again, that start fails with `web_host_start_cleanup_incomplete` (its `cause` is the refusal), so two native owners never coexist.

`packages/web/package.json` `exports` is the web package's public surface for
other packages: the server entry (`.` and `./server/index.js`) and the modules the
Electron shell loads by package name — `runtime-bundle-binding.js`,
`runtime-bundle-root.js` (including `readNativeShellBundleBinding`, shared by the
CLI and the shell), `native-artifacts.js`, `native-bundle-reboot-recovery.js`,
`opencode/path-utils.js`, `opencode/login-shell-env-filter.js` and
`agent-browser/install.js`. Node refuses any other package-name subpath at runtime,
and Electron externalizes `@devryan/web/*` in its bundle, so a new import must
be added there first; the boundary check reports it before it can ship.

Startup binding reads sealed bundle documents with the same 32 MiB
`BUNDLE_DOCUMENT_MAX_BYTES` limit used by bundle storage and native boot
verification, checking both file metadata and bytes read. Hash, canonical-path
and symlink checks remain required. Electron's startup failure page falls back
to its default appearance if selected-bundle settings cannot be read, preserving
the original error and Retry action even after an upgrade changes selection.

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
earlier builds.

## Claude updates in About

The shared UI's `ClaudeCodeVersionSection.tsx` reads the running version from
`../claude-runtime-update.js`. `../claude-update-routes.js` owns authenticated
GET `/api/config/claude-update` and administrator-only POST `/install` and
`/rollback` below that path. Mutations accept only `{ expectedRevision }` and
require `x-devryan-csrf: 1`. They return 202 with a pollable host-owned operation;
a browser disconnect does not cancel activation. Other platforms retain the
existing app-delivered update flow.

`managed-claude-installation.js` resolves an exact stable npm platform package,
bounds downloads, verifies SHA-512 archive integrity, extracts only a regular
ARM64 Mach-O executable, and checks Apple's signature chain and Anthropic's
`Q6L2SF6YDW` team. Its isolated preflight checks the reported version, required
flags and SDK initialize control response. It sends no prompt, denies network
and Keychain command access, disables settings and tools, and waits for process
termination before deleting scratch. `scripts/hydrate-reviewed-claude.mjs` uses
the same downloader for the packaged fallback on macOS. Portable CI restores only
the exact reviewed archive and executable bytes, checking pinned archive integrity,
executable size and SHA-256 without invoking macOS tools; native packaging retains
publisher verification and protocol preflight.

`managed-claude-candidate.js` copies the verified artifact inventory, replacing
only Claude and recording `claudeInstallation` (schema, package, version,
platform, archive URL/integrity, executable hash/size and signature evidence).
The manifest digest binds this record; `native-artifacts.js` verifies the actual
publisher and bytes on every launch. Other assets retain their exact pins.
The reviewed configuration and reviewed Claude credentials modules are executed
from the bytes that passed their digest check, through
`verified-module-import.js`: a `data:` URL on Node, an in-memory `blob:` URL on
Bun (which rejects module names over about 4 KiB). The file is not read again.
The candidate uses the existing bundle retention, checkpoint, selector CAS and
host recomposition lifecycle. Download/check failures leave admission open;
activation reserves idle admission before checkpointing and never replaces a
running executable. A later app upgrade preserves a newer managed Claude;
`claudeBaseManifestSha256` prevents reinstalling the same shipped core at every
cold start. Source and rollback verification also recognize the previous
2.1.280 and 2.1.251 packaged assets.

Before selecting a Claude update, the bundle store persists a pending activation
record with the source selector and source file inventory. Cold bootstrap runs
`claude-activation-recovery.js` before opening data owners. Failed preflight can
restore only an untouched prepared candidate's unchanged source, with absent
owners and a fresh selector revision. It never projects old credentials over
new work. Ready startup retires this automatic recovery; subsequent recovery
uses the existing explicit bundle rollback and its reconciliation guards.
Interrupted staging is removed under the updater lock on the next attempt.


### xAI usage renewal

`provider-refresh-selected-owned` is an exact-field controller operation for the selected xAI device OAuth credential. It carries the original usage caller grant, controller/location identity, credential ID and expected fingerprint, never credential values. The `provider.usage` GET scope authorizes one update with the fixed renewal-intent fingerprint; create, activate, remove and other providers remain refused. The registered native xAI implementation renews inside the existing reverse credential mutation queue and rechecks caller, acquisition and selected record before commit. Usage and admitted model resolutions share pending renewal observations; one bounded prior-renewal receipt per reviewed location permits reuse of this owner's renewal without accepting unrelated writes. Quota reads remain read-only until their usage request is rejected. Refresh tokens never cross into the web fetcher. The default launch quota refresh therefore loads usage without a chat request.

### Plan execution restrictions

Native admission captures canonical Plan mode from the original accepted user
objective and inherited managed read-only assignment. The canonical legacy
`plan` agent also restricts authority without requiring prompt markers. A child
missing from a valid retained managed board receives conservative read-only
policy only after its complete parent chain is verified in the same project and
directory. Unavailable boards and mismatched parents refuse; a mutable root
never restores a pruned child's write authority. Legacy markers can only
restrict authority. Writes/patches are denied before dispatch, and shell
execution retains the normal outer lease/receipt while running in a private
read-only view with no writable project inputs or ignored-output grants. Stop,
publication and cleanup remain owned by the execution host. Children receive
the captured read-only policy; prompt text cannot grant write authority.
Plan admission requires its canonical-policy and implementation-validation
hooks; an Implement marker also requires validation. Missing hooks refuse Plan
before dispatch while ordinary non-Plan admission remains available.
Plan shell runs from the original snapshot under the read-only host boundary.
Its macOS profile denies network operations, including localhost POST/push;
Linux adds a private network namespace. Other execution modes retain their
existing network policy. The current Windows LPAC policy cannot supply a
read-only original workspace and isolated network, so Plan shell returns
`native_plan_confinement_unavailable` before creating its replacement view.
The native runtime's private `readCanonicalPlanSequence` delegates to the
privileged client; application wiring supplies it only to the Plan source
owner. It reads at most 2,000 native rows/8 MiB, preserves canonical paging
order and native compaction type/status/reason, and projects the complete
sequence once. The Plan validator can therefore verify automatic-compaction
successors without trusting display parts, summary text or client metadata.

Initial negative writer admission records no-start evidence through
`native-plan-denial-owner.js` only after captured read-only policy, exact pending
canonical assistant/tool identity and an absent execution pointer agree. It
uses the existing cancelled-call receipt store. A previously issued permit's
failed recheck, a policy-read error or tool error text cannot create that proof.
The owner rechecks controller identity after awaited admission state reads and
passes its captured revision and synchronous owner assertion into the existing
ledger cancellation transaction and guarded commit. No-start queries wait for
that writer's lock through settlement or revocation rollback.
This lets a later owned stream continuation cross a settled, denied Plan writer
without weakening the uncertain-tool fence.

A registered writer excluded from the actual native tool snapshot's definitions
also passes through this initial admission check before the native filtered-tool
rejection. The gate retains the sealed registration and checks that it is still
current; it never enters the writer executor. A granted admission is released
and does not bypass the snapshot's permission decision. Unknown or replaced
registrations cannot obtain negative proof through this path.
Plan admission admits only host-classified native reads, questions and confined
shell, plus the specifically owned managed-task, context, document and Slim read
tools. Unknown MCP/plugin effects and caller read-only annotations cannot grant
authority. Managed descendants retain their captured read-only policy, and
Plan persistence retains its separate owned route. Filtered writer preflight
checks both the native registration ID and its current effective tool name.

Native configuration translates legacy bash/task/write/patch permission names
to shell/subagent/edit across ordered native and legacy supported shapes.
Patterns and allow/deny/ask decisions are preserved; conflicting collapsed
aliases fail closed. Boolean `tools` maps are translated at global and agent
scope using pinned 2.1.3 precedence: global tool rules precede explicit rules;
agent write/edit/patch entries merge into edit before explicit legacy action
overrides. Invalid boolean maps and ambiguous aliases produce typed configuration
errors. Frontmatter, frozen snapshots and native permission evaluation are
covered separately. The Plan settlement verifier is composed with current
controller/configuration, primary generation, canonical session status, active
execution leases and managed task/envelope barriers.

## Managed child title sources

`native-managed-title-owner.js` seals only the private verified managed dispatch
and independently reads its durable assignment and original root control call.
Its canonical source marker is not authority. Capture/recheck bind controller,
configuration, objective, cancellation generation, captured generation, selection,
permissions and exact ordered accepted-user identity. A separate latest-human
capture preserves child follow-ups and paused persistence reopening; replay,
Synthetic input, missing/cyclic/deep ancestry and changed ownership fail closed.
Latest-human capture compares the exact canonical ordered source parts, including
attachments, alongside the private accepted-user record. Session `time.updated`
alone is volatile during stream activity; other session fields remain compared.
`native_managed_title_source_invalid` is an enumerated content-free title refusal.
The three-purpose HTTP/controller tests use actual admission, provider-attempt
authorization and settlement; fresh compiled provider qualification is a separate gate.

## Claude credential command diagnostics

The constructor-owned credential command observer emits
`native_claude_credential_command` only for the exact `/usr/bin/security`
credential operations. Its payload contains `phase` (`probe`, `read`, `write`,
`delete`) and bounded `exitCode` (or `null` when no numeric exit was available).
Enrollment, renewal, settlement and legacy-fence reads share the observer. It
waits for the original command owner to settle; diagnostics cannot change its
result, public refusal or cancellation/close ownership. Journal and export
sanitize this event separately and omit all command arguments, account/service
names, HOME paths, stdout/stderr and credential content.

The actual OS command owner replaces `execFile` failures before returning them,
retaining only a bounded exit/system code. The error message, command line and
stderr cannot reach vendor logging through that error. The macOS CLI still
receives the reviewed store's arguments; this does not change the OS command
interface or its process-list visibility.

The existing reviewed macOS store uses the implicit OS Keychain. This diagnostic
adds no store, fallback, HOME override, Keychain command or credential mutation.

`startWebUiServer` may receive the trusted constructor option
`nativeClaudeSecurityHome` for an isolated host whose inherited HOME cannot
address the OS user's existing Keychain. `native-claude-security-home.js` applies
that HOME only to the original `/usr/bin/security` credential command for an
exact private enrollment under this bundle's control root. It validates the
enrollment UUID, generation, profile, computed service, exact account/arguments,
private directories and retained directory identities before dispatch. The
host's HOME and native configuration remain isolated; HTTP, environment flags,
public profile metadata and service-name patterns cannot enable this backend.

Fresh enrollment supplies its live constructor binding. Credential resolution
reads the original canonical lifecycle before its first private account read
and rechecks that exact enrollment at each command. Renewal keeps the original
mutation queue and issuer/write ownership; its uncancelled settlement read is
confined to the exact prepared replacement attempt. Default, shared and legacy
credential paths retain inherited HOME. A missing or replaced owned directory
refuses this backend, including deletion; it never falls back to an installed
default service. This option creates no Keychain and adds no file credential
store, token export or credential-copy path.

Before another enrollment, legacy migration skips profiles already proved by
the existing canonical lifecycle and private enrollment directory validator.
They have no legacy fence to import. Actual legacy/default migration keeps its
original command backend and inherited HOME.
Actual OS Keychain behavior remains unverified until the authorized isolated sign-in.

### Archived deletion recovery

Child-first manual bulk deletion can leave a retained terminal managed task
whose child is no longer in its parent's canonical subtree. The removal owner
verifies the child's direct ledger removal hold, completed intent, matching
generation and recorded disposition, and absence of active leases before the
scheduler may settle that historical reference. Missing proof or live managed
work still refuses deletion; interrupted child disposal completes before an
ancestor can begin its own removal decision. No holds are cleared or ownership widened.

Recovered input remains execution-fenced, but an exact `sessions.remove` web grant
and the private held-tree `removal.inspect`/`removal.delete` permits may dispose of
it. They never authorize prompt admission, inbox delivery or execution wake.
A native execution claim (`time_suspended`) is only a restart-resume marker, and
restart cannot resume a removal-held session. After a non-quiet removal has
settled a member (managed fence plus `cancelAndWait` termination), an inactive
claim on that member is released through the held-tree `removal.release-claim`
permit (`release-removal-claim-owned`); an active member or a member that was not
settled is never released and still refuses deletion. Quiet retention removal
keeps refusing any claim.
Startup inherits unfinished native removals only after full selected-bundle
verification supplies the checkpoint's preserved state ref and object ID. The
mutation ledger compares the inherited decision and each member's generation
and exclusive removal holds under its existing lock before changing `ownerID`.
Preparing decisions remain fenced until a fresh authorized DELETE; committed
decisions retain their exact members, dispositions and acknowledgement recovery.
Foreign or changed records, unrelated holds and missing checkpoint proof refuse
inheritance. No hold is cleared to recover deletion.

The coordinator journals `session_removal` outcomes with session/intent IDs,
stage and bounded error code. Web authorization failures record the same event with stage
`web_authorization`. Neither
record contains transcript content, request bodies or exception messages.

### Bounded native search output

Broad native scans exclude `node_modules`, `.cache`, `dist`, `.worktrees`, `worktrees` (including `.claude/worktrees`), `.artifacts` and generated-worktree directories by default. An authorized canonical read directory explicitly inside one such tree expands only that category; user include globs cannot widen it. Git exclusions and `--no-ignore` remain mandatory.

The web execution host caps trusted `grep`/`glob` stdout before its event queue at 64 KiB and 200 grep records or 1,000 glob paths. `native-search-output.js` retains complete newline records; it never inserts prose into ripgrep JSON. At the cap a separate search-limit controller stops the confined producer. Only an exact host-owned limit stop with a terminated, confined receipt and no user/owner abort, permit failure or queue overflow can settle as partial success. The raw cancellation/exit receipt is retained. The typed settled event carries `truncated` and its counts/limits; routing normalizes the native parser's exit code only for this successful limited read, then appends an explicit narrowing notice and `searchTruncation` metadata to the tool result. Writer/shell overflow and uncertain termination remain failures.

### Provider transport deadlines

`nativeProviderConfigurations` (`native-configuration-data.js`) merges
`NATIVE_PROVIDER_DEADLINES` into the `settings` of every native provider stanza
it emits: `headerTimeout` 45,000 ms and `chunkTimeout` 120,000 ms. The `openai`
stanza gets `chunkTimeout` 300,000 ms, because reasoning can send nothing for
minutes before the first output item. Native-shaped `providers` stanzas and the
snapshot's settings-only Meridian `anthropic` stanza get the same defaults.
Saved `options` or `settings` values, including `false`, always win. No total
`timeout` is added.

OpenCode 2.1.3 otherwise waits 300,000 ms for response headers and 900,000 ms
between stream chunks. Its header timer starts at send, so it also bounds
connect. Live QA (2026-10-23) saw byte-less 75–90 s hangs before
ECONNRESET/ECONNREFUSED. A deadline failure is a `Transport/Timeout`, which core
retries up to 3 times.

This is the only source of these deadlines. The OpenAI header 120 s / chunk
300 s / total 15 min defaults that `syncRuntimeAgentOverlays` used to write
went into a managed `OPENCODE_CONFIG_DIR` overlay. The native snapshot never
reads that overlay, because it loads only the user, project and `OPENCODE_CONFIG`
layers, so those defaults have been removed.

Coverage limit: a stanza sets core's provider `activation` to `enabled`, so
DevRyan writes deadlines only for providers that already have a stanza. Built-in
catalog providers used without one (Zen `opencode`, OpenAI signed in by OAuth
with no `provider.openai` block) still use core's 300 s / 900 s defaults.

### Idle location release

`translateNativeConfiguration` (`native-configuration-data.js`) sets
`experimental.location_idle_timeout` to `NATIVE_LOCATION_IDLE_TIMEOUT`
(15 minutes) for every native location. OpenCode's location activity sweep
then invalidates a location's services, including the MCP servers it started,
after 15 minutes without durable session activity instead of its 60-minute
default. Running sessions, pending questions and background jobs still keep a
location loaded; the next request rebuilds the services. Eviction itself is the
same OpenCode path that previously ran at 60 minutes.

`worker-protocol.ts` derives permission assertion wire validation from the native
`Permission.Request` fields plus optional permission and agent IDs. OpenCode 2.1.3
exports `AssertInput` only as a type; worker events retain the same validated shape.
