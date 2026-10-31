# Native startup catalog diagnostics

## Managed result delivery measurements

`native-result-delivery.js` observes `devryan_task` output only after the result
collector verifies the exact completed, untruncated canonical tool part. Staged
returns and failed publication checks do not count. `native_result_delivery`
records contain call/message/task/envelope identities, UTF-8 section offsets,
SHA-256 hashes and byte counts, never report text, prompts or cursors. Repeated
canonical rechecks count once while retained in the bounded history. Exact repeated section ranges across distinct
calls count as repeats; differently paginated overlapping ranges are not inferred
to repeat. The identity-only history is bounded to 2,048 entries, so eviction
makes repeat counts a lower bound. Observer failure cannot alter publication,
cursor coverage, later-Step review, acknowledgement or canonical records.

Publication `serializedBytes` measures escaped tool JSON. `reportBytes` and
`metadataBytes` measure unescaped text in report and explicit metadata sections;
`framingBytes` measures the remaining serialized fields/framing after removing
those escaped texts. These are transport/context-delivery measurements, not
provider tokens, cumulative child usage or proof of model attention.
Use the parent session, `assistantMessageID` and payload `callID` to join native
turn-timing/provider observations. Provider-reported active context, cached input
and cumulative processed input retain their existing owners and units; do not
add child usage or tool JSON bytes to an active-context token snapshot.

Isolated lifecycle qualification uses `native-session-context.test.ts`,
`native-auto-compaction.graph.test.ts` and `native-compaction-checkpoint.graph.test.ts`
for bounded compaction anchors, Plan lineage and exact provider/model replay;
`native-queued-input.test.ts` retains the same queued human input through busy,
suspended or unknown grandchildren while its parent and immediate child idle.
`native-tool-catalog.graph.test.ts` verifies sealed per-location advertised tool
schemas against native owners. These do not qualify provider quality, an overnight
MCP resource scenario, or moved-subagent panel behavior in a packaged renderer.
`native-managed-results.test.js` separately refuses inherited collection and
publication authority after a directory move or collector restart.

Compact verification headers accept `pending`, `passed`, `failed`, `blocked` and
`waived`, with legacy `not-observed` retained as incomplete evidence. A selective
detail path requires current matching content identities and either actual
successful receipts (including populated visual evidence) or an authenticated
user waiver; a waiver stays `waived`, never a test pass. Empty-check Explorer
results accept both current vacuous `passed` and legacy `not-observed` headers.
If fresh verification rejects automatic continuation, the automatic mark is
cleared while result inspection, checkpoints and waits remain available. Scheduler
admission still refuses completion until its current requirements pass or are
explicitly waived by the user.

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

Before spawning a controller, `native-process.js` rechecks the managed-process
registry for up to two seconds (bounded by the launch timeout) while an old owner
settles. Launch still requires confirmed physical exit; a live or unverified
owner ends the window with `native_process_owner_unsettled`.

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

`verifyUpdateCandidateArtifacts` is the installer's check of a downloaded
update's runtime before the running app stops. It is not a purpose: no
descriptor, selector or request can reach it. It requires the same manifest
digest and schema, inventory, per-file digests, sizes and modes, macOS
signatures and launcher, but accepts any well-formed Bun version and does not
compare reviewed asset digests with this app's pins; the candidate enforces its
own pins in `verifyNativeRuntimeArtifacts` when it starts. Failures report the
purpose `update-candidate`. Installers through 2.1.17 pass the candidate to
their own current-purpose verifier, so they refuse any other Bun or reviewed
asset; `scripts/fixtures/shipped-updater/candidate-pins.json` records those
pins and release preflight fails before packaging when this checkout would
break a supported one.

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
- A provisional prompt reservation carries no execution or restore authority.
  Inspection validates its exact shape, session ancestry and ledger sequence;
  only its reserved message field can be absent from canonical history. A
  promoted prompt still queued in the native inbox needs matching session,
  directory, full item hash and sealed admission fingerprint. After a committed
  session or tree Revert, native history may clip the reverted root turn when the next
  user turn commits. The proof binds a later persisted native user to its ledger
  fingerprint and validates the transaction's exact members, targets and ancestry.
  Each selected inactive operation must join its reverted prompt, exact call
  pointer and published lease with matching scope and sequence. Only the proved
  root reference fields are excused; child references remain checked normally.
  An explicitly discarded accepted input instead needs its verified native
  cancellation receipt, exact payload hash, session and directory, and absence
  from both inbox and canonical messages; only that prompt's message field is
  excused. Reused identities or unrelated references still refuse startup.
  The queued, discarded and clipped prompt exceptions do not apply during
  relocation; unrelated lost references continue to refuse startup.
- Reviewed rebuilds of the same OpenCode version use the same exact graph,
  source layout, migration level and credential-contract checks as cross-version
  clones; a version match alone never admits a different core digest.
- The clone copy leaves behind sockets and FIFOs anywhere, and symlinks inside
  a project ledger and under `global/{cache,tmp,log}`. Links under config,
  `global/home` and `global/data` still refuse with `bundle_symlink_source`.
  A ledger's derived `context-cache/`, `module-overlays/` and `view-standby/`
  (parked execution views, adoptable only by the process that parked them) are
  not copied; the rollback file inventory skips `context-cache/` and
  `view-standby/` the same way. A Codex CLI home's scratch
  (`quota/codex-usage/<id>/.tmp/`, its plugin checkout cache) is not copied
  either; its auth file and databases are.
- A synthetic `session_inbox` item queued to an archived session (a
  background shell's completion notice that arrived after its task finished)
  is never delivered. The clone's source check tolerates exactly those rows
  (`undeliverableInboxIDs`), the copy deletes them from the candidate database
  only, and each is reported as `bundle_inbox_notice_undelivered`. The source
  bundle keeps them unchanged as the rollback target. Any other queued input,
  including user input in an archived session and notices in a live session,
  still refuses with `migration_pending_input_unsupported`. The cancelled
  shell lease behind such a notice records it as delivered (`deliveredID`)
  although it never became a message; the harness check receives the archived
  session IDs and reports that lease as `bundle_shell_notice_undelivered`
  instead of `bundle_message_reference_lost`.
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
Expected leftovers that need no action (`bundle_shell_notice_undelivered`,
`bundle_inbox_notice_undelivered`) are
logged but never become a notice.

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

First-run setup imports no settings or registration state of the retired
background runtime service. The setup preference allowlist also preserves `helperModelSelection`, including
its saved revision, independently from primary and notification model choices.

Existing startup timing records now include manifest payload hashing, signature
verification, first-install artifact retention/preparation/selection and binding.
Shell visibility and ownership resolution precede binding/controller readiness;
renderer directory/session readiness and the global event-stream ACK complete
the contract. These observations do not bypass checks; only per-file artifact digests and signatures are reused, as described above.
The existing matched benchmark still requires at least 5% median improvement and
every candidate pair faster before retaining a performance optimization.

## Managed tool capability advertising

`DEVRYAN_ADAPTIVE_DELEGATION=1` enables the candidate adaptive routing policy;
it defaults off until matched workflow qualification. The same host-captured
policy renders bundled prompts, native capability schemas and run fingerprints.
The candidate permits a root to implement a small known unit after declaring
checks, while managed specialists retain their scoped contracts and explicit
user ownership. `declare_checks` and `correct_objective_check` are available to
current root Builder/Orchestrator calls through narrow native authority; Builder
does not acquire delegation or child-result actions.

When adaptive routing is enabled, the existing session-context hook appends a
bounded host-derived capability snapshot after history. It reports the selected
runtime version/build, shell deadline constants and scratch lifetimes, canonical
policy flags, reviewed browser availability and owner-resolved preview readiness.
Unavailable facts remain null/unknown, preview URLs and paths stay private, and
lookup rechecks the original session grant. The stable role/tool prefix remains
unchanged. The existing `contextProjection` policy still defaults off; checkpoint
and compaction projections read current objective-wide verification, including
already-collected child requirements, without becoming an authority store.

`devryan_task correct_check` accepts only `task_id`, `check_name` and `expected_command`. The native owner captures current root-Orchestrator objective authority and carries a private Symbol grant to the orchestration runtime; model arguments cannot provide runner policy, a replacement command or objective identity. The host resolves only its attested repository runner convention, atomically archives the old declaration/receipt and clears current proof. Before a managed start, known mistaken Deno/Vitest declarations are corrected under that policy or refused explicitly. Native starts additionally capture `dispatchObjectiveId` from `authorizeNativeTaskInvocation`; follow-ups retain it across automatic continuation Steps. These fields never enter the model's start schema. See the [orchestration owner](../../orchestration/DOCUMENTATION.md) for runner policy setup and verification semantics.

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

Later `wait`, `wait_any` and `status` slices reattach to the exact published
control lease through the host. The ledger rechecks cancellation, admission and
generation without rewriting the lease; the host rechecks invocation identity
and the current permit. Only the original slice finishes it. Refused reattachment
cannot cancel or clean up a published lease, and claimed ready leases remain
fenced. Async control results settle before lease finish so a delayed finish
cannot leave a rejected tool promise temporarily unhandled.
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

Auto-continue (v2 only; `DEVRYAN_TASK_AUTO_CONTINUE=0` disables it on the next
call). `wait_any` marks a returned result in the collection only when it is
`completed`, carries no manual recovery or auto-resume (parked) state, its compact
header (present when `compactResults` is on) reports a complete marker, no
partial output, failures or recovery restriction, under 64 KiB, and either every
declared required check passed (`detail.requiredBeforeDisposition === false`) or
none was declared (an Explorer report), and its whole report and metadata were
delivered in that reply; the reply then lists those IDs in `autoContinued`.
Failed, blocked, large, partially delivered, parked and recovery results, and
results with a failed or unobserved declared check, keep an explicit `continue`. The next `devryan_task` call of any kind, after its own
authorization and before dispatch, runs the same `continueOne` as bulk continue,
so the later-Step review rule (`assertPublished(..., review = true)`), the
acknowledgement identity and the disposition permit are unchanged; a call in the
same Step leaves the mark. One pass runs per root scope. A mark that keeps failing
returns the result to explicit continue. At session idle, `observeSessionIdle`
runs `settleIdle` before todo continuation: under the session lock it requires
root-Orchestrator authority (`authorizePrivateRpc`), an idle session, and a
completed primary-record step later than the published `wait_any`, then rechecks
that review inside scheduler acknowledgement. Failures are journaled as
`native_task_auto_continue_failed` and never block idle handling.

`native-plan-read-advisory.js` counts a root session's `read`/`grep` direct
reads in plan mode once an Explorer started in the current objective has
settled (`context_state` now projects each task's `agent` and `createdAt`). Each
counted read is journaled as `plan_mode_read_after_explorer` with its count; from
the fourth, `direct-finish` returns a typed `advisory`
(`plan_mode_reread_after_explorer`) that routing appends to the tool result and
records as `planReadAdvisory` metadata. It never refuses a read; any failure
yields no advisory. `DEVRYAN_PLAN_READ_ADVISORY=0` disables it.

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
  (recency from the attempt's timestamps). Canonical `interrupted` attempts map
  to terminal `stopped` rows, including after their retry is dispositioned;
  acknowledged interrupted attempts never become phantom running/resumed work.
  Observed, dispositioned attempts are reconciled and excluded from reusable
  actions. An empty current board explicitly says no managed tasks are running,
  so retained historical snapshots cannot imply a resumed attempt.
  Its primary fallback hook leaves
  canonical child sessions without a primary objective to the managed executor:
  native retries stop and publish the original provider failure, preserving
  managed usage-limit backup and manual recovery policy. Missing primary
  ownership on a root session remains fenced. An owned root whose managed
  results block fallback also stops retry after fresh authorization and publishes
  the original provider failure. That refusal reserves no fallback and never
  dispositions a child result.
- Webfetch results may carry inline image attachments, mapped to file parts;
  the host never enables them (`imageRouting` is not `direct`).
- `REVIEWED_AST_ASSET_SHA256` lives in `reviewed-ast-asset.js`.

## Prompt cache through compaction

OpenCode builds the compaction (summary) request from the normal request's
system, tools and history so that it reuses the provider prompt cache, and it
is the largest request a session makes. DevRyan keeps that prefix identical:

- `nativeSlimSystemTransform` (`native-slim-runtime.ts`) runs Slim's collapse
  over native parts through agents-core `applySystemTransform`, on context and
  compaction requests alike. Neighbouring parts join only when their cache
  markers match (`collapseSystemPartsInPlace`); a joined run keeps its marker
  and merged metadata.
- The Anthropic system scrub (`native-provider-compat-plugin.ts`) scrubs each
  marker run separately and rebuilds parts with their `cache` and `metadata`.
- `native-session-context.ts` appends the compaction objective anchor after the
  history as a system update (`Message.system`), not as a new system part. A
  new system part would change every byte after it, including the history.
  When OpenCode drops the recent tail because the full request exceeds the
  window minus 16k tokens, the anchor is dropped with it; earlier summaries
  still carry `## Objective anchor`.

`DEVRYAN_SYSTEM_CACHE_PRESERVE=0` (forwarded to the native host by
`native-runtime-owner.js`, read by `system-cache.ts`) restores the earlier
shape: one joined system string without markers or metadata on context
requests, an untouched compaction system and the anchor as a trailing system
part. The phase-reminder strip in the compaction bridge still makes the
history differ from the normal request's from the first reminder onward.
`agents-core/src/v2/setup-system-cache.test.ts` compiles both requests to
Anthropic and OpenAI Responses bodies and pins the shared prefix bytes.

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
for Default), and active fallback sends the session's own variant. `devryan-notify`
always captures the helper tuple without a variant (Default reasoning), so its
small summary cap is not spent on reasoning. Admission requires a captured revision
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
resource. The mandatory native Tool owner advertises an enum of unambiguous
readable names and exact IDs in the skill input schema, keeping native skill
provenance and permission ownership. Spliced hashes cannot select another skill.
A refusal reads `native_skill_unreviewed: ...` and lists the reviewed
skill names (`reviewedSkillNames`, at most 50) so the model's retry can name one.

## Native grep and glob execution

OpenCode 2.0.30, 2.1.0 and 2.1.4 spawn ripgrep for `grep` and `glob` through `Environment.spawner`.
`execution-routing.ts` turns that spawn into `execution.native.start` with
`kind: 'read'`, and the host runs it under the read-only supervisor in
`session-execution-host.js`. A location's read and protected roots may not exist
yet (the per-directory webfetch scratch root under `global/tmp/devryan-webfetch`
is created on first use). The host resolves them with `canonicalTarget` from
`native-read-paths.js`, as the controller read guard does: a missing root
canonicalizes through its nearest existing parent, so a missing protected root
still protects its location. The working directory itself must exist.
A read root nested inside a protected root opens only its own subtree: the
webfetch binary folder stays readable although `global/tmp` is protected. The
controller guard (`native-read-paths.js`) and this host check apply the same rule.

### File-tool boundaries

- `execution-read-guard.ts` labels a refusal with the operation that asked:
  `tool.read` for reads, `tool.write` for the writer worker's write, edit and
  patch targets. Both add one line of guidance (read by project path; write
  scratch from the shell under `$DEVRYAN_SESSION_TMP` or `$TMPDIR`).
- A writable shell's `$PWD` is the call's view,
  `<ledger>/<sha256(repository)>/views/<token>/worktree`, so script output names
  view paths. The controller's `FileAccess.authorizeRead` maps such a path to the
  project file it mirrors (`projectPathForView`) before OpenCode resolves it, when
  the hash matches the location directory or one of its parents; the read guard
  then decides on the project path. Other view paths stay protected data paths.
- OpenCode's `core/environment` instruction advises preferring `global.tmp`,
  which DevRyan protects. `configuration.ts` replaces that line with the shell
  scratch rule; `bootstrap.test.ts` fails if an OpenCode upgrade changes the
  sentence it replaces.

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
allows only its pinned `session.setMetadata` effect, plus the native
`session.archive` flag that matches the override (2.1), or a lone native
`session.unarchive`, and retains fresh caller authorization, session holds and
revision checks. Native `archive`/`unarchive` are gated in `admission-gates.ts`;
without such a permit they fail closed. `withArchiveAlignment` is the detached
backfill/repair permit (`v2/native-archive.js`): no web principal, one native
`archived` PATCH equal to the owned override, which it rereads before and at the
native effect. Retention archive writes the override and then, unless
`DEVRYAN_NATIVE_ARCHIVE=0` (forwarded to the controller), the native flag in the
same transaction. `native-recovered-input.js`
keeps retained inputs and their execution fence intact; archiving does not
resume or discard them. Generic web operations, prompts and wakes remain fenced.
Startup preserves valid archived queued input under the same fence, allowing
owned deletion to finish after restart. Explicit resume and automatic grants
refuse while archived; unarchiving changes the scoped revision and requires a
fresh recovery read. Malformed archive timestamps still refuse inspection.

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
transcript persistence failure after cleanup rather than confirming success.
The private SDK abort outcome keeps physical termination distinct from that failed
write: proven termination retains the accepted managed Stop even on HTTP 500;
unconfirmed termination retains pending Stop fencing through its bounded uncertain
outcome. Neither case permits an agent retry. Cursor tool `cancelled` maps to a
native error with an `aborted` cause while retaining tool identity, input, metadata
and timing. Cancelled assistants publish a failed step and interrupted execution,
never successful execution. The ingress unwraps only its Effect exit so known
refusal codes survive the private control wire; schema defects remain sanitized.
Terminal-only `cursor_persistence` phases locate the SDK queue,
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
objective and canonical failed predecessor. The pinned OpenCode 2.2.5
Synthetic event supplies its committed event ID, sequence, derived user ID and
payload fingerprint. The durable pending reservation becomes consumed before
successor preparation/send; Step adoption consumes its proof once. There are
at most two continuations per original objective. Plain Retry reserves nothing,
and a third Continue is refused before a physical request. New human input,
unsettled execution/tools/requests, changed selection or missing proof fail
closed. An `active` managed barrier permits continuation while children run if
requests are explicitly unblocked; acknowledgement and unknown barriers and
unsettled tools still fence both reservation and successor adoption. A refused
`reserve` RPC declines retry without a defect; `prepare`, `send` and `bind`
failures remain fatal after reservation. `native_stream_continuation_refused`
records a bounded action and reason. Lost publication or Step proofs expire on the existing progress
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

#### Provider transport failures

A provider request that fails in transport is recorded once, for every request
kind and both transports. The header, chunk and total timeouts wrap the HTTP
middleware from outside (the middleware only sees an interruption), so the
middleware and WebSocket frame observer in `native-observation.ts` only record
per-request send state: send start, last pulled byte or frame, target URL and
the provider's response request ID (`x-request-id`, `request-id`,
`openai-request-id`, `x-amzn-requestid`). The report comes from the decorator
that `createNativeObservation` adds to the stream continuation's LLM client
wrapper (the single LLM client replacement; production always enables it):
when `stream` or `generate` fails with a typed AI `Transport` or `Timeout`
reason, `projectNativeProviderFailure` sends one unawaited
`native.provider-timing` frame with `event: 'failed'` and a `failure` object.
Status, authentication, rate-limit and output errors are not transport
failures, interruption (Stop) is not a failure, and the original error is
rethrown unchanged.

| Field | Meaning |
| --- | --- |
| `phase` | `stream` after response headers (operation `read`, or a timeout that carries the response); before headers, `connect` for connection-establishment codes (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, Bun `ConnectionRefused`, TLS certificate codes) or a WebSocket `connect` phase, otherwise `headers` (including the header timeout). |
| `elapsedMs` | Since the physical send started (or preparation, when no send was observed). |
| `sinceLastByteMs` | `stream` only: since the last pulled body byte or frame, else since headers. |
| `code` | The error's bounded code (`ECONNRESET`, `Timeout`, …), else the first bounded `code` on its cause chain, else the innermost reason tag, else `unknown`. Never a message. |
| `host`, `port` | Hostname and port only; never the path, query or credentials. |
| `providerID`, `modelID`, `providerRequestID` | The prepared selection; the provider's request ID for `stream` failures, else `null`. |

`native-provider-timing.js` accepts only that exact shape. The web host writes
one `timing` journal record `turn.provider_request_failed` (the request
identity, `kind`, `transport`, the failure fields and `probe`) and one
`[native-provider] request failed …` line to the console, which Electron
persists in `main.log`. The first failure per host in 60 seconds first runs
`probeProviderHost`, a DNS + TCP connect to the same host and port within 3
seconds, and adds `probe: 'ok'|'unreachable'`: `unreachable` points at the
local network or a stopped local proxy, `ok` at the provider. Later failures in
the window carry no `probe`. The diagnostic sanitizer allowlists `host`, `port`,
`sinceLastByteMs` and `probe`.

API-key Session WebSocket timing is separate from those HTTP limits. Since
2.1.4, connection admission waits 15 seconds before its unsent HTTP fallback.
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
Bodies OpenCode compressed (`settings.encoding`; zstd by default for ChatGPT
sign-in since 2.0.28) are decoded from their `content-encoding` (zstd or gzip),
with decompressed output capped at the same 64 MiB. Before this, every ChatGPT
sign-in send reported null `wireOptions`, `wireToolCount` and `wireEffortUpdates`.
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
`openai.attempt` remains; `openai.access` is removed. Every ChatGPT method,
token-sharing included, keeps OpenCode's model limits (2.1.4 `openai-context-caps`:
272k input, 500k from GPT-6.1), and native compaction derives its ceiling from
them. The legacy 1.05M/256k context pin (`normalizeOpenAIModels` with
`pinContext`) remains for the v1 plugin only; `DEVRYAN_CODEX_CONTEXT_PIN=1`
restores it on the native path. Under native ceiling math that pin compacted at
234.6k, not the intended 256k, and it overrode the plan's input cap.

Provider credential resolution reads its selected snapshot inside the serialized
mutation queue. Concurrent requests may advance only through a refresh committed
by that same controller while their resolutions are pending. Account switches,
revoked authorization and unrelated credential replacement still fail. Session
correlation includes the credential request's binding, allowing title and primary
request resolution to be traced independently.

Bundle cloning and explicit rollback still read older bundles that list the
Meridian-era Claude, libsql and credentials assets; nothing runs them, so they
are verified only against their own manifest.
These constructor-owned `bundle-source`/`bundle-rollback` purposes never come
from HTTP metadata; prepared targets and retained-candidate resume stay current-only.
An explicit rollback selector grants its historical purpose at load and before
spawn. Cold upgrades use `upgradeSelectedNativeBundleAtStartup` inside the existing
bootstrap file lock, before any controller or data owner starts, preserving the
verified source and credential checkpoint through the ordinary lifecycle.

Cross-release clone admission uses the source's reviewed legacy or fresh-install
layout, then checks the actual database layout. Releases with only a reviewed
fresh-install layout (2.2.x) remain eligible for forward upgrades; unreviewed
graphs, changed source layouts and lower migration levels still refuse.

An upgrade whose shipped manifest keeps the selected `opencodeVersion` and
`inputs.coreDigest` does not clone (`runtime-bundle-lifecycle.js` `applyCandidate`,
result `mode: 'rebind'`). On non-Windows hosts it calls
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
one, and every
entry without a valid descriptor; it prunes nothing while a rebind is `pending`
or `restoring`. Clone origins (`sources/clone.json` `migrationOrigin`) and
source bundle IDs are only compared as strings, so removing `default-native` or
an older source is safe. Removal renames to `.stale-*` first; an interrupted
removal is swept at the next launch. Windows keeps every bundle.

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
validation accepts OAuth rows for OpenAI `chatgpt-*` methods, xAI `device` and any
well-formed method of another catalog provider; the controller decides which are
usable (below).

Catalog providers: the generic `provider` scope covers every integration
`isCatalogProviderIntegration` (`native-provider-integrations.js`) admits, which is
every OpenCode integration except `openai`, `cursor-acp`, `claude-agent`,
`anthropic` and MCP servers (`mcp_<sha1 prefix>`). Host authorization, credential
bindings, the process protocol, provider attempts and configuration removal all use
that rule, and every credential change still needs the original caller's grant. In
the controller (`controller-provider-credentials.ts`), keys are accepted for all of
them. An OAuth method is admitted only when a reviewed native plugin registered it
(`reviewedNativeProviderOrigins`, the `opencode.provider.*` entries of the reviewed
registry, matched by origin fingerprint) and the policy allows it: xAI `device` only,
OpenCode Console never. An unreviewed plugin's OAuth registers as unusable, except
xAI, whose unreviewed registration still refuses. OAuth grants, attempts and
resolution bindings carry the provider's own ID and method, and admitted refreshes run
under the same resolution commit as xAI. Removing an account never requires its
method to be admitted.

The quota route records failed selected-credential reads and xAI renewals as
`native_quota_read_failed`, carrying only provider, stage and an allowlisted
code. It retries a transient selected-read failure once against the current
owner, without retrying changed credentials or authorization refusals. Missing
host capability is reported as `native_credential_update_required`, rather than
asking the user to reconnect an otherwise usable account. Native scope and
selected-account checks are unchanged; refresh tokens remain private.

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

The first provisioned bundle's base location is the home directory
(`provisionDefaultNativeBundle`), whatever directory the host was launched from.

Native locations (`native-project-locations.js`) are the reviewed base locations,
then registered projects, then each location's app-created linked worktrees
(`listManagedWorktrees` in `lib/git/service.js`: worktrees under OpenCode's
`worktree/` data root). A worktree that is missing, a symlink, noncanonical,
protected or unreadable is skipped rather than failing the list. Creating a
worktree through `POST /api/git/worktrees` prepares its location with the same
`ensureNativeDirectory` restart a newly opened project uses; while sessions are
busy the response carries `nativeLocation: {status:'pending'}` and the
location joins at the next native restart. A project added through
`PUT /api/config/settings` (the Add Project dialog), or selected there as
`lastDirectory`, is prepared the same way in the background: the response is
not held, and while sessions are busy the preparation retries every 30 s for up
to 30 minutes. Before, such a project's agent catalog failed (500) until the
app restarted.

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

Per-file tree rows never sit inside a bundle document, because their size
grows with the user's data while documents are capped. Schema 2 records (all new
writes) keep them in canonical NDJSON sidecars written by `saveBundleRows` and
read by `readBundleRows` (`bundle-migration-inventory.js`): one canonical
`{path,sha256}` per line in tree order, unique paths, bound by the document's
`{protocol:'devryan.bundle.tree-rows/1',count,sha256}` reference. No row is
trusted before the whole file matches. `sources/preparation.json` binds
`sources/copied-files.ndjson` as `copiedFiles`. `prepared.json` keeps the
immutable rows (`descriptor.json`, `sources/`, `config/reviewed-*`) inline as
`immutableFiles` and binds every other row in `prepared-files.ndjson` as
`dataFiles`. An artifact rebind reseals only immutable documents, so it never
rewrites a sidecar. Prepared-phase verification hashes the actual tree, without
the seal and its sidecar, and compares both halves in tree order. Schema 1
records with inline `copiedFiles`/`initialFiles` arrays (bundles sealed before
this change) still verify, select and act as clone sources. A refused oversized
document carries `detail: {document, bytes}`, its file name and size only. Each
clone logs a `startup measure` line with its copied file count.

Startup binding reads sealed bundle documents with the same 32 MiB
`BUNDLE_DOCUMENT_MAX_BYTES` limit used by bundle storage and native boot
verification, checking both file metadata and bytes read. Hash, canonical-path
and symlink checks remain required. Electron's startup failure page falls back
to its default appearance if selected-bundle settings cannot be read, preserving
the original error and Retry action even after an upgrade changes selection.

### Abandoned execution leases and explicit reboot recovery

The startup upgrade and every launch verification run `inspectBundleHarness`,
which refuses any ledger lease that is not `published`/`cancelled` or still has
`cleanupPending` (`bundle_execution_unsettled`). Outside relocation it does not
read per-file content records (`files/`, `revisions/`, `runs/`, `bases/`):
they never carry a session or message reference (`BUNDLE_REFERENCE_FIELDS`,
asserted in its test), and on three 13k-file ledgers they made a launch scan
take 4.3 s instead of 0.5 s. Relocation still reads and rewrites every record. In-runtime lease recovery runs
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

### xAI usage renewal

`provider-refresh-selected-owned` is an exact-field controller operation for the selected xAI device OAuth credential. It carries the original usage caller grant, controller/location identity, credential ID and expected fingerprint, never credential values. The `provider.usage` GET scope authorizes one update with the fixed renewal-intent fingerprint; create, activate, remove and other providers remain refused. The registered native xAI implementation renews inside the existing reverse credential mutation queue and rechecks caller, acquisition and selected record before commit. Usage and admitted model resolutions share pending renewal observations; one bounded prior-renewal receipt per reviewed location permits reuse of this owner's renewal without accepting unrelated writes. Quota reads remain read-only until their usage request is rejected. Refresh tokens never cross into the web fetcher. The default launch quota refresh therefore loads usage without a chat request.

### Plan execution restrictions

Native `question` execution stays in the controller under `withControl`: the
canonical `opencode.tool.question` registration must pass both routing and the
host control-origin gate before acquiring a control lease. Pending forms,
answers and cancellations continue through native Form and request permits.
A finish whose permit was retired cancels and cleans only its exact ready
control lease; it never publishes a successful question receipt.

Native shell results preserve `metadata.exitCode` from the verified termination
receipt separately from tool transport completion. A completed tool can therefore
report a failed command. Shell commands begin in a mapped private view; an
absolute `cd` to the logical project selects the read-only live tree instead.
Use the mapped `$PWD`, `$TMPDIR` for one-call scratch and
`$DEVRYAN_SESSION_TMP` across calls; both are shell-only. Evidence goes to
`$DEVRYAN_ARTIFACT_DIR` when set: this call's own folder in the project's
ignored `.artifacts/` (macOS, when the project ignores it), written through
unpublished, so file tools read the same bytes. The settled call carries a
manifest of what it left there (path, size, SHA-256; at most 200 files and
256 MiB hashed, links never followed) in `metadata.artifacts`, with a notice.
Deleting `.artifacts/` itself replaces the input and is reported as dropped.
Temporary directory and server launch failure must stop verification before
readiness polling. Shell bodies are not
rewritten, and no write grants are added for absolute paths.

Native admission captures canonical Plan mode from the original accepted user
objective and inherited managed read-only assignment. The canonical legacy
`plan` agent also restricts authority without requiring prompt markers. A child
missing from a valid retained managed board receives conservative read-only
policy only after its complete parent chain is verified in the same project and
directory. Unavailable boards and mismatched parents refuse; a mutable root
never restores a pruned child's write authority. Legacy markers can only
restrict authority. Writes/patches are denied before dispatch, and shell
execution retains the normal outer lease, shell-job binding and termination
receipt while running read-only with no writable project inputs or
ignored-output grants. On macOS its lease is reserved with
`preparation: 'read-only'`: no reconciliation and no private view copy
(`view_files`, `view_git`, `view_inputs`), the command runs from the live
project directory, and publication is always empty. Linux keeps the private
read-only view. `DEVRYAN_READ_ONLY_SHELL_LIVE=0` restores the view on macOS.
Shell-job binding also carries the job's start (`info.time.started`), the
requested timeout and the timeout the native shell arms (`final.timeout` inside
the `Shell.create` callback: the foreground default when none was requested,
0 for a background job) through `registerShellJob` and `bind-shell-job`; the
execution host registers the command deadline from them (`onShellJobBound`).
Routing refuses `timeout` above 3600000 (milliseconds) with
`native_shell_timeout_invalid`. A deadline cancellation reaches the model as
`command_deadline_exceeded` with the enforced and requested timeouts
(`WorkerError.code`/`metadata`), never as a bare `execution_cancelled`; a job
that already exited and is still publishing is never aborted. When the native
shell's own timer stopped the command (OpenCode marks its result `timeout: true`
before it kills), the call returns that result with a notice that its changes
were not published. A command that replaced an ignored input folder (deleting
and recreating it, as Playwright does with `test-results/`) settles with those
folders in `publication.ignoredInputs` and a notice that what it wrote inside
them was dropped; a check that needed that output stays incomplete.
A host error reaches the controller as its code only, except the refusals in
`MODEL_FACING_REFUSALS` (`worker-protocol.ts`: `preview_stale`,
`native_shell_background_unavailable`, `native_verification_publication_pending`,
`native_plan_write_denied`, `plan_selection_required`, `plan_assignment_missing`,
`required_verification_pending`), whose message is guidance for the model
(at most 2 KiB, written `<code>: <guidance>`). The controller's RPC client keeps
that message; `native-admission-bridge.ts` appends it to the admission refusal
(`DevRyan refused native.admission.<op>: <code>. <guidance>`), managed-task and
todo tools return it as the tool error, and when one refuses a shell's start the
shell route returns it with its code in place of the native tool's generic
`Unable to execute command`, which drops the cause. A failure inside the
execution pump keeps its own platform error (`native_output_overflow`,
`native_execution_result_missing`, `native_search_truncation_invalid`, the
settled error) instead of collapsing to `native_execution_failed`.
Stop, publication and cleanup remain owned by the execution host. A background
shell completion whose lease a user Stop cancelled (`stoppedBy: 'operator'`), or
that the orchestrator stopped because its task attempt settled
(`stoppedBy: 'task_settled'`), is admitted and delivered, but
`native-admission-owner.js` neither wakes the conversation nor retains a
`shell.complete` intent; the notice reaches the model with the next prompt.
A managed child's lease names its task attempt (`attempt`), and its completion
wakes the child only while that attempt is the child's current one
(`childAttempt`); a run a settled or replaced attempt left behind is delivered
the same way, never woken (the 2026-10-28 Designer was woken 30 min after its
task completed). Roots and unmanaged subagents wake as before. While managed
orchestration cannot yet classify a child (`unknown` during startup), the
intent is kept durably without a wake, and `resumeDeferredShellContinuations`
evaluates it once orchestration is initialized. The recovered-grant
re-authorization checks the attempt again (`native_completion_attempt_settled`).
A managed child cannot keep a server past its call (D2): the execution host
refuses its `background: true` shell before any lease exists, and
`authorizeShellJob` refuses moving its running shell to the background
(`job.shell.background`), both with `native_shell_background_unavailable`,
also once its task settled (`childAttempt` `none`). The refusal tells the
model to run the server and its checks in one foreground call (timeout up to
3600000 ms): start it inside the command, stop it on exit (`trap … EXIT`), wait
until it answers, check, and write evidence to `$DEVRYAN_ARTIFACT_DIR`
(`scripts/opencode-v2-native/one-call-verification.test.ts` runs that call
under the real launcher). Roots and unmanaged subagents keep background shells.
While orchestration cannot classify the child (`unknown`) the shell runs and
`background_policy_unknown` is journaled; P0.3 attempt fencing still applies to
it, and a shell started in the background stays there. Kill switch:
`DEVRYAN_REFUSE_DELEGATED_BACKGROUND=0`. Children receive
the captured read-only policy; prompt text cannot grant write authority.
Plan admission requires its canonical-policy and implementation-validation
hooks; an Implement marker also requires validation. Missing hooks refuse Plan
before dispatch while ordinary non-Plan admission remains available.
Plan shell runs from the live project (macOS) or the original snapshot (Linux)
under the read-only host boundary. The trade-off on macOS: it sees the current
disk, including files a concurrent writer has published, rather than a ledger
snapshot, exactly like native `read`/`glob`/`grep`.
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
The sequence is read at the canonical session's directory, which for a worktree
session differs from the project root a Plan card submits.

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
scope using 2.1.4 precedence: global tool rules precede explicit rules;
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

`native-provider-deadlines.js` owns the whole deadline policy: the values, the
exempt providers, the stanza merge (`nativeProviderDeadlines`,
`withNativeProviderDeadlines`) and the per-request header rule
(`nativeRequestHeaderDeadline`). It has no imports, so the configuration
translation and the native controller bundle both load it; the call sites
below only apply it.

`nativeProviderConfigurations` (`native-configuration-data.js`) merges
`NATIVE_PROVIDER_DEADLINES` into the `settings` of every native provider stanza
it emits: `headerTimeout` 45,000 ms and `chunkTimeout` 300,000 ms. Reasoning
models can send nothing for minutes between output items, and a chunk timeout
replays the whole prompt; the byte-less hangs that motivated tight deadlines end
in a reset before 120 s anyway. (Before OpenCode 2.1.4 adoption, every stanza but
`openai` had a 120 s chunk deadline.) Native-shaped `providers` stanzas get the
same defaults. `claude-agent` is exempt (`NATIVE_DEADLINE_EXEMPT_PROVIDERS`): it
runs the user's Claude Code, which owns its API and stream idle timeouts, and
OpenCode would pass a stanza deadline to it as `API_TIMEOUT_MS`.
Saved `options` or `settings` values, including `false`, always win. No total
`timeout` is added.

OpenCode 2.1.4 otherwise waits 300,000 ms for response headers and 900,000 ms
between stream chunks. Its header timer starts at send, so it also bounds
connect. Live QA (2026-10-23) saw byte-less 75–90 s hangs before
ECONNRESET/ECONNREFUSED. A deadline failure is a `Transport/Timeout`, which core
retries up to 3 times.

This is the only source of these deadlines. The OpenAI header 120 s / chunk
300 s / total 15 min defaults that `syncRuntimeAgentOverlays` used to write
went into a managed `OPENCODE_CONFIG_DIR` overlay. The native snapshot never
reads that overlay, because it loads only the user, project and `OPENCODE_CONFIG`
layers, so those defaults have been removed.

A stanza sets core's provider `activation` to `enabled`, so DevRyan writes
stanza deadlines only for providers that already have a stanza. Built-in catalog
providers used without one (Zen `opencode`, OpenAI signed in by OAuth with no
`provider.openai` block) are bounded per request instead:
`withNativeHeaderDeadline` (`native-observation.ts`) sets the prepared
request's `http.headerTimeout` to 45,000 ms whenever neither the request nor its
model configured one other than core's 300,000 ms default (`anthropic` excepted,
as above); `nativeRequestHeaderDeadline` decides, given core's
`DEFAULT_HTTP_TIMEOUT_MS`. Chunk waits are left
as configured for these providers, because reasoning models such as DeepSeek
can legitimately stream nothing for minutes.

### Idle location release

`translateNativeConfiguration` (`native-configuration-data.js`) sets
`experimental.location_idle_timeout` to `NATIVE_LOCATION_IDLE_TIMEOUT`
(15 minutes) for every native location. OpenCode's location activity sweep
then invalidates a location's services, including the MCP servers it started,
after 15 minutes without durable session activity instead of its 60-minute
default. Running sessions, pending questions and background jobs still keep a
location loaded; the next request rebuilds the services. Eviction itself is the
same OpenCode path that previously ran at 60 minutes.

### Background compaction (opt-in)

`DEVRYAN_BACKGROUND_COMPACTION=1` adds `experimental.background_compaction: true`
(OpenCode 2.1.4) to the same `experimental` block. OpenCode then prepares a
summary in the background as a session nears its compaction threshold, so the
automatic compaction does not wait for the summary call. It stays off by default
for three reasons:
- a summary that is never used still costs tokens;
- the precompute request is not covered by the compaction journal wrapper;
- Stop does not cancel a precompute already running, because it lives in the
  compaction scope.

If the precompute outlives the turn's permit, OpenCode stops precomputing after
two refusals. `experimental.todo` is never set: DevRyan registers its own
`todowrite` and `todoread` tools, and native todo would collide with them.

`worker-protocol.ts` derives permission assertion wire validation from the native
`Permission.Request` fields plus optional permission and agent IDs. OpenCode 2.1.3
and 2.1.4 export `AssertInput` only as a type; worker events retain the same validated shape.

## MCP elicitation (Form gate)

OpenCode 2.1.4 through 2.2.5 own every MCP elicitation form with the sentinel session
`global`, so no client can tell which turn asked. DevRyan attributes it on the
host, in `native-mcp-elicitation.ts`:

- `createOwnedRemoteMcp` (`remote-mcp.ts`) registers each reviewed `callTool`
  in flight, keyed by location and server, with its session, message and call
  IDs (`createMcpElicitationCalls`, shared by `controller-startup.ts` with the
  admission gates as `mcpElicitationCalls`). The entry is released when the
  call settles.
- The Form gate (`admission-gates.ts`, a location node that also depends on
  `Location.node`) handles `Form.ask` for a `global` form. It shows the form
  only when it is an `mcp-elicitation` and exactly one call of that location
  and server is in flight. It then stamps
  `metadata.devryan {sessionID, messageID, callID}`, replacing any incoming
  `devryan` key. Zero or several calls, another `global` kind, a link that is
  not plain `http(s)` without credentials, or `DEVRYAN_MCP_ELICITATION=0|off|false`
  (read on each request) return `cancelled` before a form exists. The MCP tool
  call then continues instead of waiting for its execution timeout (12 h by
  default). `Form.create` refuses `global` forms. When the attributed call
  ends first (Stop, or the server stopped waiting), its pending form is
  cancelled with it, so no card outlives the call.
- Reply and cancel of an attributed form are admitted against the attributed
  session (`form.reply`/`form.cancel` with `pending.sessionID` set to it),
  never `global`. A client request whose web permit names another session is
  refused in the gate (`native_permit_lineage_mismatch`) before admission. The
  admission owner then applies its usual lineage and revision checks, and a
  detached form effect stays `native_owned_operation_required`. The web route
  `/api/session/global/form/:id[/reply]` maps to those effects only with the
  projection's attributed `elicitationSessionID` (`native-web-operation.js`);
  the principal's web authorization covers that session.
- The MCP server's own `notifications/elicitation/complete` settles its URL
  request without a permit only while the attributed call is still in flight
  and the answer is exactly `{elicitation: true}`. A client answer always
  needs admission.
- Each refusal is journaled once as the lifecycle diagnostic
  `native_mcp_elicitation` (`outcome: cancelled`, `reason`, field kinds,
  server) through the bridge's `mcpElicitationRefused`. Values, messages,
  URLs and field keys are never journaled.

The owned MCP service also adds display-only `metadata.mcp {server, tool}` to
the native MCP tool permission assertion, beside OpenCode's `metadata.input`,
so approval cards name the reviewed server and tool. Rules and saved approvals
still match only the native action and resources.

Tests: `scripts/opencode-v2-native/mcp-elicitation.test.ts` (gate and
registry) and `remote-mcp-elicitation.graph.test.ts` (real SDK round trip
through the admission owner).

## Upstream dependency patches

OpenCode applies `patchedDependencies` from its own root `package.json`, so npm
consumers of `@opencode/core` do not get them. DevRyan ports the ones it needs
as Bun `patchedDependencies` in the root `package.json`, with the patch files
in `patches/` (the upstream files, unchanged). Bun applies them in the isolated
store copy that `@opencode/core` resolves, which is the copy
`scripts/build-native-runtime.mjs` bundles; the patched bytes enter the bundle's
`sourceFiles` and build identity, and `patches/` is part of the native
acceptance source. Do not reintroduce `patch-package`: it scans the same
directory and rejects Bun's patch file names.

- `@modelcontextprotocol/client@2.3.1`: a tool `outputSchema` only needs to be
  an object (`looseObject`), so a server whose tool declares a union (`anyOf`)
  output schema keeps its whole tool list instead of failing `tools/list`;
  OAuth discovery no longer copies the server URL query into well-known URLs;
  `offline_access` no longer forces `prompt=consent`.

The other upstream patches for packages the native bundle resolves at the same
version are not ported, because none fails here:

- `@silvia-odwyer/photon-node@0.3.4` (embedded WASM path, wasm-bindgen imports):
  `rewriteNativeAsset('photon')` already points Photon at the embedded WASM,
  and the compiled asset proof (`verify-assets.ts`) resizes a real PNG.
- `@ff-labs/fff-bun@0.10.5` (`.js` import extensions): only strict Node ESM
  needs them; `Bun.build` resolves the extensionless imports.
- `@npmcli/agent@4.0.2` (proxy getter returns a string): under Bun 1.4.3 an
  HTTP request through the unpatched agent still reaches its configured proxy.
- `pacote@21.5.1` (git specs with `::path:` subdirectories): only plugin
  installs from such specs use it, and DevRyan's native plugins are reviewed
  and bundled.

When editing the patch set, keep `bun.lock` to the `patchedDependencies` block
Bun writes: Bun 1.4.3 re-saves a lock written by 1.4.4 with unrelated changes
(musl `libc` fields, an `ajv-keywords` hoist). Check with
`bun install --frozen-lockfile`.

Tests: `scripts/opencode-v2-native/mcp-client-patch.test.mjs` (real client
round trip over `InMemoryTransport` against a stub server whose `tools/list`
returns an `anyOf` output schema, plus the two OAuth changes).

## Built-in browser availability

`devryan.browser` is a core registration, so new and migrated configurations do
not need a legacy browser plugin entry to advertise `devryan_browser`. The host
does not automatically require this optional origin in the startup catalog;
an explicit catalog requirement still applies. This permits startup before
installation or with browser control disabled. The host
still filters the registration out before boot when the browser-control setting
is disabled or verified managed assets are unavailable. The location snapshot
alone grants no browser execution authority: the native owner, scoped lease,
permission checks and confined worker remain required.

The managed CLI is pinned to 0.39.2. Its reviewed plugin transform fingerprint
includes the FFmpeg receipt reader fix: the reader matches the installer's
inode/size/timestamps receipt without the reboot-unstable device number. Original
CLI validation, bounded sequences and failure behavior remain intact; the native
transform still replaces filesystem/launch/transport access with owned callbacks.

## Required verification and root TODO completion

The native execution host observes declared check commands through trusted constructor callbacks; real process receipts and publication precede check completion. `native-session-context-owner.js` reads the current primary objective and asks the orchestration owner for its authoritative required-check projection. Root `todowrite` cannot complete or empty the TODO list while declared verification is pending, failed or blocked. The existing open TODOs remain unchanged. Verification gates completion, not independent implementation. A settled turn with runnable TODOs can continue while checks remain pending. Pending TODOs may declare bounded `blockedBy` reasons; when every remaining item is dependency-blocked, no automatic TODO continuation is enqueued, avoiding an unchanged-failure loop. The root can inspect the exact remaining checks, rerun them, or let the user waive them through the authenticated UI route. Legacy objectives with no declared requirements retain their existing behavior.

### Managed task settlement before runtime replacement

A managed restart holds scheduler dispatch and reconciles only terminal child
results before pausing browser leases or closing the ready controller. A live,
transient, or relaunch result refuses replacement while the current controller
remains available. This path never replays a resumed prompt or arms auto-resume.
The scheduler serializes each terminal result and envelope through its existing
atomic ledger owner; a failed save leaves the original task retryable.

After controller exit, the native owner retains the exact controller instance
only after provider shutdown, execution drainage, and grant invalidation. Before
launch verification, it uses a private authority callback to settle remaining
managed records as interrupted (or aborted for an accepted user stop), preserving
partial output, canonical references, and history. The callback rechecks the same
instance, closed phase, and physical exit on every commit. A failed ledger save
retains that proof for Retry Apply; a later controller invalidates it. The strict
`bundle_task_unsettled` verifier remains unchanged.

`native-bundle-task-recovery.js` runs under the default bundle bootstrap lock after native lease recovery and before strict verification/upgrade. It settles active managed task records through a temporary scheduler in load-only mode and ordinary atomic ledger ownership, preserving canonical child references and resumable results without prompting, observing, launching queued work or arming automatic recovery. Authority requires absence of another host owner, confined termination receipts for every retained controller instance (at least one), empty controller/provider process registries, settled execution leases, and repeated verification of the temporary ledger owner. Missing, malformed or linked receipts, live/unknown owners and unsettled writers leave the active records untouched, so the existing strict bundle gate still refuses startup. PID absence alone never settles tasks. Windows cold recovery remains disabled until its native ownership proof is available.


## Native result collection and assigned plans

`native-session-context-owner.js` watches the managed runtime's durable result-commit cursor. It scans idle roots after a commit, after recovery, and on bounded watch timeouts to retry transient observation failures; it claims one eligible result, and reserves a native `collect` continuation with the existing primary owner. The reservation retains the same message ID across delivery retries; canonical step observation consumes it. The primary owner's durable `collectionWakes` receipts prevent duplicate turns across multiple unacknowledged tasks, including after restart. Receipts are bounded to 256 per cancellation generation; capacity exhaustion requires explicit collection rather than evicting a receipt and repeating a wake. Controller generation, objective, user stop, holds, and the original plan-mode instruction remain authoritative. Disposal aborts the long poll and releases its listener. Collecting a result acknowledges receipt without satisfying its required checks; strict verified completion remains separate.

An authoritative `SessionNotFoundError` stops a collection scan. For an exact
pending native continuation, the primary owner repeats that proof under its
mutation lock and checks the current controller and captured revision before
durably cancelling the reservation. Child results remain unacknowledged and
available. Other read, location and transport failures remain retryable.
`native_collection_continuation_failed` retains the bounded, regex-validated
error code and valid session ID so restart diagnostics preserve the actual cause.

A native task may request `approved_plan` with its selected version, exact phase heading, and bounded logical paths. `harness-task-context.js` captures the selected application plan under root authority, scopes the immutable content to that phase plus shared constraints and verification, and binds its SHA-256 to the objective, source message, and version. The scheduler retains `approvedPlanRef`; dispatch also includes its text so the child need not search the repository. An assigned child can retrieve that exact snapshot through the empty-input `devryan_plan_read` tool, with parent/task ownership and hash validation. This read-only alias does not expose the root `devryan_task` delegation or update actions. It cannot read arbitrary parent history or update the root plan. The task owner rechecks the selected plan before committing dispatch.

## Host operations and provider launch health

`native-host-operations.ts` exposes administrator registrations through a typed
`devryan_operation {operationID}` tool. Boot carries only public operation IDs,
project scope, purpose and description. The registry remains private in the web
owner; the authenticated execution bridge resolves pinned argv and capabilities,
then runs through the existing lease/supervisor/publication boundary. See
`packages/harness-runtime/DOCUMENTATION.md` for registration and restrictions.
`application.js` forwards the trusted prepared `executionDirectory` to required
check observation; after observation runs following publication and before view
cleanup. Registered operations use the deterministic check-command marker
`devryan_operation <operationID>`, never a caller-supplied shell command.

Native websearch activation remains reviewed for compatibility, but its tool
definition is withheld because there is no owned search executor. Read-only
managed prompts do not grant it. Webfetch remains available for known URLs.

Managed children retrieve their injected immutable plan artifact with
`devryan_plan_read {}`. The tool has no action, path, session or update fields;
its owner derives `plan_read` only after verifying the original empty canonical
input and native permit. Read-only prompt policy grants this alias while keeping
`devryan_task` denied. The assigned-task/snapshot owner still checks parent,
objective and hash identity. Root or unassigned callers cannot use the alias,
and supplying delegation, update or arbitrary path fields is refused. The real
permit/controller/managed-owner route is exercised by
`assigned-plan-tool.test.js`.

Explorer and Librarian also explicitly allow this reader in their packaged
wildcard-deny policies, so assigned children can retrieve the artifact during
ordinary build-mode dispatches. `task.readOnly` prompt overrides are only
applied for an explicitly read-only dispatch. Tests evaluate the packaged rules
with native `Permission.evaluate`; delegation and writer tools remain denied.

Writer results now attach a `mutationReceipt` with the logical project directory,
actually published relative paths and published/partial outcome. Only typed path
fields (`metadata.path`, `metadata.filePath`, and corresponding `files` entries)
are rebased from the private view. Source text, patch strings and user content
are never rewritten. This receipt states publication, not successful testing.

Managed child prompt tool maps enable `devryan_plan_read` only for retained `approvedPlanRef` snapshots; the fixed empty-input host reader still validates the immutable assignment. Required-check declarations accept project-relative `cwd` and a named `environment`, both included in check content identities. Canonical Docker/UID prerequisite diagnoses retain failed exits as skipped `environment_unavailable` evidence; they never convert verification to a pass.

Only complete canonical process output can establish an environment skip. Skipped checks permit disposition and closeout with completion status `skipped`, never `passed`; SQL/assertion/application failures remain blocking. Content changes invalidate skip receipts as well as passes.

## Managed child interruption authority

`withManagedTaskDispatch` accepts `abort` for the current scheduler settlement lease and its canonical child. It verifies task identity, parent control-call capture, directory and child ancestry before issuing a permit limited to `session.interrupt` with an empty payload. Every effect rechecks the lease; resume, child removal and selection changes are excluded. This lets detached timeout cleanup and same-child retry stop the old runner without requiring an HTTP principal or retaining the original tool permit.

## Claude Code through claude-agent

OpenCode's `opencode.provider.claude-agent` runs the user's own Claude Code through the
Agent SDK. The controller runs under Seatbelt (no mach lookups, writes only inside the
bundle), so a `claude` it spawned could neither read the login keychain nor write
`~/.claude`. Admission therefore activates the reviewed builtin only with
`claudeAgentPlugin`: core's `make(io)` over `claude-agent-io.ts`, provided the ambient
Bus core gives its internal plugins. Without that IO the builtin stays inert.

`claude-agent-io.ts` reports the sentinel executable `CLAUDE_AGENT_EXECUTABLE` and an
empty environment, and relays every SDK spawn and every Claude session-file operation
(`exists`, `fork`, `remove`) as `claude-agent` frames on the controller's stdio
(`claude-agent-protocol.js`). `native-process.js` hands those frames to the
per-controller `claude-agent-host.js` created by `native-runtime-owner.js`, and writes
`claude-agent-reply` frames back. The host:

- resolves the real executable itself (`DEVRYAN_CLAUDE_PATH`/`OPENCODE_CLAUDE_PATH`,
  `PATH`, then `~/.local/bin`, `~/.claude/local`, Homebrew and `/usr/local/bin`);
- refuses any argument outside the tool-less SDK invocation (`assertClaudeAgentArgs`:
  `--tools=`, `--allowedTools=mcp__opencode__*`, `--permission-mode=dontAsk`,
  `--setting-sources=`, `--strict-mcp-config`, only the in-process `opencode` MCP server,
  `{"disableAllHooks":true}` settings), so every action is an OpenCode tool DevRyan executes;
- builds the environment from an allowlist with the account home (`os.userInfo()`), so
  macOS finds the login keychain. A host running under another `HOME` (isolated QA)
  sets `CLAUDE_CONFIG_DIR=<HOME>/.claude` instead of moving the keychain;
- queues stdin, end and kill frames that arrive before the asynchronous spawn finishes;
- records `rate_limit_event` usage, and on request (`refreshUsage`) asks a prompt-less
  Agent SDK session for Claude Code's `/usage` answer (see `../../quota/DOCUMENTATION.md`);
- terminates its processes when the controller exits.

Connecting uses OpenCode's external `claude-login` method. The facade
(`v2/native-integration-facade.js` `claudeStatus/claudeConnect/claudeDisconnect`,
routes `/api/provider/claude-agent/status|connect`) runs under the `claude` integration
kind, which admits only reading the integration, `connect/external` with
`claude-login`, and removing its connection. `claudeAutoConnect` runs before the
`/provider` and `/config/providers` catalog reads, once per configuration snapshot:
when a `claude` executable resolves and nobody pressed Disconnect, it connects
`claude-login` so Claude models are listed without visiting Providers. Connect and
Disconnect record the choice in `<webDataDirectory>/runtime/claude-agent-connection.json`
(owner `claudeAgentConnectionChoice`); after a Disconnect it never reconnects on its own. The controller delegates claude-agent
credentials and accepts only an external `claude-login` value without metadata.
