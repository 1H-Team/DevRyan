# Live agent QA — 23:09 Dubai, 11 October 2026

Status: first attempt interrupted by the user before a plan or implementation.
Observation only: no harness, application, configuration, or runtime changes.
Scope: agents and orchestration, excluding bots. The user operated submission,
navigation, and stop controls; the observer read the UI and diagnostic journal.

## Attempt identity

- Parent: `ses_ed3a1a4d6ffeOVdXrQsRCXnMOf`.
- Orchestrator: `openai/gpt-6-astra`, medium; journal confirms plan-only preamble
  and medium wire reasoning effort.
- Selected bundle: `native-da0024416be697594c01bee3-r11`, selection revision 12.
- Artifact hash: `da0024416be697594c01bee3aeb0a9b7765d1542d7f0c271d64dd89f40396880`.
- Task: plan fixes for signed-out mobile floating chat positioning and dark-mode
  public profile styling, including applicable live-editor shared components.
- Journal gap scans through 19:12:57 UTC reported no gaps. Evidence below is a
  sanitized observation summary, not a full journal export.

## Timeline

Times are UTC; add four hours for Dubai on this date.

| Time | Observation |
| --- | --- |
| 19:09:04.276 | Parent prompt received. Accepted after 3.981 seconds. |
| +13.680 seconds | Parent provider request sent. First byte +15.016 seconds; first text +17.473 seconds. |
| 19:09:34 approximately | First Explorer task starts; UI displays Preparing. |
| 19:10:06.392 | First task fails `native_cursor_catalog_timeout`, before child prompt or assistant output. About 31.8 seconds after task starting. |
| 19:10:45 | Parent collects failure; agent retry available, manual recovery not required. |
| 19:10:53.567 | Retry task starts using the same Cursor Claude Haiku 5.5 medium configuration. |
| 19:10:54.208 | Parent retry tool completes in 2.077 seconds. |
| 19:11:22.778 | Retry child user prompt becomes visible in journal. |
| 19:11:25.948 | Empty child assistant object created. |
| 19:11:53.585 | Retry task publishes running, around 60 seconds after starting. UI subsequently shows Running. |
| 19:12:26.333 | Parent abort control, source `stop_button`. |
| 19:12:26.338 | Retry task marked interrupted, reason Parent session stopped. |
| 19:12:26.551 | Parent turn aborted, user reason; duration about 202.272 seconds. |
| 19:13:46 observation | Child UI still shows Processing, active sidebar indicator, and Stop Generating. Child cancellation settlement needs verification. |
| 19:17:22.325 | Child finally fails with `CursorPersistenceError`, then publishes idle. The app log identifies `native_managed_task_lease_invalid`; parent stop had already invalidated its managed authority. |

First task: `dvr_task_f4a9bb290bf3450596efb8239a2660c6`, child
`ses_ed3a1205dffengLgkDhkeHyRkU`.
Retry task: `dvr_task_d29e5db259be48be8f0ecc43d57ec74c`, child
`ses_ed39ff41affeH9mmXGDnlrqzHA`.
Retry call: `call_PX0VlOS81uRqx84zqHVFs1ZP`.
Neither attempt produced substantive Explorer text or tool results before the
parent stop. This run does not establish plan or implementation quality.

## Findings to investigate after the run

1. **Cursor delegation startup and recovery.** The first attempt timed out in
   native catalog discovery; the retry remained without substantive output until
   stopped. Journal evidence does not distinguish worker startup, catalog/network
   latency, and cleanup delay. The catalog deadline owner is
   `packages/cursor-sdk-runtime/index.js`; inspect phase timings before changing
   timeouts or retry policy.
2. **Cancellation agreement.** Parent/task interruption was recorded, but the
   child UI remained active after the stop. A read-only
   `GET /api/session/status` returned HTTP 200 and `type: busy` for the retry
   child after 19:13:46 UTC. This confirms server-state disagreement too, but
   does not prove that the provider is still computing. The child eventually
   settled about 296 seconds after the parent stop, with a persistence failure.
3. **First-text instrumentation.** Retry child
   `turn.cursor_first_emitted_text_delta` at 19:11:23.739 appears to describe a
   replayed user prompt, not assistant output. Assistant-role filtering needs
   verification. Parent task `childPromptedAt` and `firstAssistantPartAt` were
   still null when running was published.
4. **Disabled checkpoint tool remains usable by the model.** A complete parent
   model step called checkpoint and received `available:false`,
   `reason:harness_policy_disabled`. The step used 17,519 input and 20 output
   tokens; tool duration was about 7.48 seconds. Check whether disabled capability
   exposure or conflicting instructions cause avoidable calls.
5. **Title-generation churn predates this run.** Old session
   `ses_ed9f2e162ffea6ZDIFJq71v3s6` had approximately 70,084 lifecycle records by
   19:09:30, with `idle_confirmation` / `retry_scheduled` around once per second
   and attempt fixed at 17. The inspected branch reads local state and writes an
   outbox; no provider requests were established for that loop. The current
   parent separately had a title-helper `upstream_error` 503 at 19:10:26 and
   persistence retries. Do not merge these two observations or infer model cost
   from timer activity.

These were investigation candidates at the end of observation. The user then
authorized implementation and isolated live verification; that work is tracked
separately below.

Follow-up preparation evidence: retry execution lease
`ac1af5a2-b846-40d3-80fb-a50fbbbadd2d` was reserved at 19:11:31.805 UTC. Its
private scratch directory, created after snapshot/view preparation, was created
at 19:17:22.289, approximately 350.5 seconds later. The immutable snapshot listed
12,922 files. No source contents from the target project were inspected. No
worker-start timing was recorded. This local preparation interval predates SDK
execution and must be investigated independently from the catalog timeout.

## Context and harness work

Seven completed parent model messages, deduplicated using message aggregates:
43,240 uncached input tokens, 89,472 cache-read input tokens, and 541 output
tokens. Total input across calls: 132,712; latest context approximately 21,615.
Cache use appeared after the first two calls. These are journal usage values,
not a billing statement or a complete child/provider cost measurement.

UI active input progressed from 16.9K to roughly 21K, well below its displayed
272K usable input capacity (400K total context, 128K output allowance). No
context-limit failure or compaction was observed.

The parent transcript had no reasoning parts and one Diagnosing Bugs skill
call. This evidence does not establish hidden reasoning being dropped by the
renderer, or multiple skill calls being merged into one row.

Bridge summary: 215 calls, 177.904 seconds summed duration, including
`native.managed-task` 8 calls / 94.112 seconds,
`credential.resolution.commit` 7 / 17.657 seconds,
`provider.credential.assert` 35 / 18.776 seconds, and
`native.observation` 23 / 10.665 seconds. Durations overlap and must not be added
to wall time. Four ledger holds totaled 3.711 seconds, with 36 milliseconds
total wait; this points toward examining commit work rather than assuming lock
contention. No credential contents were collected.

## Resource observations

CPU is percent of one logical core; the machine has eight logical CPUs. Samples
use roughly five-second process CPU-time deltas. RSS excludes compressed and
swapped memory and is not total memory footprint.

| Dubai time | DevRyan tree CPU | RSS MiB | Memory pressure | Swap MiB |
| --- | ---: | ---: | --- | ---: |
| 23:10:12 | 81.6% | 674.5 | Warning | 7,327.56 |
| 23:11:22 | 52.9% | 802.7 | Normal | 7,199.50 |
| 23:12:23 | 75.5% | 845.0 | Normal | 7,079.50 |
| 23:13:35, after stop | 53.0% | 741.9 | Normal | 7,015.5 |

Baseline machine CPU was approximately 89.5% busy, with memory pressure already
at warning and substantial unrelated Codex activity. Load averages fell during
the run; those conditions confound startup latency attribution. RSS growth as
compression eased is not evidence of a leak. The last active sample's increased
CPU was concentrated in Electron main/in-process server, not the native
controller. After stop, CPU and RSS partially settled. Eleven DevRyan processes
remained; retained idle execution wrappers alone do not prove orphan work.

No continuous profiler, browser trace, load test, or induced fault was run.
Observer overhead cannot be isolated from other Codex work.

## Research reference for the later improvement plan

- [OpenCode V2 API](https://dev.opencode.ai/v2/docs/api/): current experimental
  documentation describes volatile SSE; reconnection requires authoritative
  state reconciliation rather than an assumed replay. Verify against the
  installed runtime version before applying API recommendations.
- [OpenCode V2 compaction](https://dev.opencode.ai/v2/docs/compaction/): distinguish
  compaction acceptance from completion; fixed instruction/schema bloat is not
  solved by trimming history. No compaction issue was observed here.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
  focused context, on-demand retrieval, compact subagent results and persistent
  progress notes. Evaluate whole-tree tokens and repeated work.
- [Anthropic multi-agent systems](https://www.anthropic.com/engineering/multi-agent-research-system):
  explicit delegation boundaries and proportional effort. More agents alone do
  not establish faster or cheaper coding.
- [OpenAI harness engineering](https://openai.com/index/harness-engineering/):
  observable execution and mechanically enforced invariants support diagnosis
  and regression verification.
- [AWS retries and backoff](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/):
  inspect bounded retries across layers and idempotency before extending limits.

Research retrieved 11 October 2026. A single interrupted attempt can reveal a
failure but cannot establish a statistically reliable optimization benefit.

## Candidate remediation and verification

The follow-up implementation preserves saved specialist models and effort:

- Native Cursor abort now waits for startup/preparation cleanup and persistence.
  The scheduler keeps execution fenced while the same live lease retains a
  narrow final-cancellation write. Stale leases, mismatched child/selection,
  removal and shutdown remain rejected. Persistence failure propagates instead
  of being reported as successful cancellation.
- The confined Cursor worker uses its actual private home for SQLite startup.
  Assistant-first-text timing excludes replayed user text and reasoning.
  Catalog and preparation phases emit bounded, sanitized diagnostics.
- Disabled context-projection actions are omitted from advertised managed-tool
  schemas. Static capability discovery no longer initializes the scheduler
  before the native controller is ready.
- The packaged Orchestrator prompt calls for bounded parallel exploration of
  independent concerns, including concerns within one subsystem, and synthesis
  of actual findings before planning. Its existing prompt budget is unchanged.
- Skill names remain static through loading/status transitions, and idle-title
  confirmation retries back off instead of churning at one-second intervals.

Targeted verification passed: 197 Cursor/harness tests, 10 native Cursor
owner/integration tests, 77 web orchestration authority tests, and 12 scheduler
cancellation/removal tests. The composed parent-stop regression holds execution
preparation, observes cancellation, waits for cleanup, saves the cancelled
transcript, and verifies terminal settlement authority is then revoked.

The candidate web/Electron build and startup bundle budget check passed. The
ad-hoc native artifact build ID is
`9120edc51d7367f49b2db12ce4cb36be4730c98c8922492c4abf95991848e5a7`.
Full deterministic validation completed with six web contract failures and
6,621 passing web tests; preceding workspace suites, lint and type checks passed.
Three wording assertions in `server/opencode-agents.test.js` reference
deduplicated instructions. Three tool-definition assertions need tighter budgets
for the reduced schema and a distinction between wait-any-only and all-enabled
capabilities. Test-only corrections preserve bounded briefs, uncapped justified
dispatch, sibling ownership, and optional-action assertions; default tool budgets
were tightened. All 335 tests across six focused contract files then passed. The
complete web-suite rerun passed at 20:04:55 UTC: 6,627 Vitest tests across 539
files, followed by 14 Bun-only native tests across three files. The original
`validate:full` invocation failed before those test-only corrections; its earlier
green workspace checks and the complete corrected web rerun are the validation
evidence.

The first isolated skill UI run reached native readiness but failed before the
skill scenario: selecting its synthetic parent returned to an empty new-chat
view and timed out after 30 seconds. No console errors or journal gaps were
reported; owned runtime cleanup succeeded. This is not a skill UI pass.

The later isolated skill run completed all eight checks, including loading,
failure, reload, and loaded presentation. The fixture now uses the authenticated
V2 session client and the already selected canonical session for the skill-only
scenario. Earlier new-session selection failures remain unresolved and are not
covered by this pass. Inspected synthetic screenshots show
[loading](live-agent-qa-skill-preparing.png),
[failure after reload](live-agent-qa-skill-preparation-failed-reloaded.png),
and [loaded](live-agent-qa-skill-loaded.png).
The run completed at 19:54:00.764 UTC with exit zero, no unexpected console errors,
no cleanup errors, and no journal gaps. This is fixture UI evidence, not a live
provider result.

The live setup capture initially rejected skill JSON data with non-object
roots and then lacked the isolated-home marker for its offline resolver.
Both preparation issues are corrected. Nine focused tests passed. Actual
artifact-backed capture then passed with 97 sanitized setup files and no
account reads or provider calls. The parser retains recursive credential
removal and rejects malformed JSON. A second production-resolver snapshot
matched the complete captured graph; its Orchestrator system prompt contains
the new parallel-exploration instruction and has SHA-256
`85d7e77dea0dc1ce82f34f2ad66a7b48986911a775e51d065cd7e84bd2c42212`.
The saved role models, effort, backups and Council selections are unchanged.

The first sign-in preparation was closed before any provider sign-in or live
prompt because QA source changes invalidated its frozen identity. Its owner
recorded cleanup but remained alive on background handles. The launcher now
receives a narrowly validated IPC notice only after owner cleanup returns, then
terminates and audits its tracked processes. Nine focused process/owner tests
passed; the interrupted old launcher also completed its process audit with no
remaining owned processes. That preparation remains failed, and its never-signed-in
runtime and superseded capture payloads were removed.

A second prepared source reached the Providers page, but its first status command
caused a generic input-loop refusal and shutdown before any matrix run. Both
owner and launcher teardown passed, and its journal gap scan was empty. That
command-input failure is being diagnosed separately. The sign-in handoff was
withdrawn; this source is retained until any owner sign-in activity is clarified.

The command-input failure was reproduced without opening a browser or signing in:
the launcher and owner shared PGID 50407, but the terminal's foreground group was
the already-exited 50713. Input raised `EIO` before parsing. The launcher now owns
the attended TTY and forwards input to a pipe; its runtime child starts in a
separate session and requires exact parent-PID IPC attendance. Twelve focused
owner/process tests passed. A real host then accepted status, rejected an invalid
command without closing, accepted status again, and closed cleanly. Its launcher
retained foreground PGID 54526; child PGID 54774 had no controlling terminal.
Owner and launcher teardown both passed with zero remaining tracked processes
and no journal gaps. This command-protocol smoke deliberately ran no matrix and
therefore retains a failed overall live-result status. Its empty source and the
earlier credential-free diagnostic source were removed after cleanup audits.

Documentation validation and diff checks passed after the QA changes. Storage
report: 35.76 GiB cache against a 50 GiB budget, 175.65 GiB free. The prune preview
identified 3.49 GiB of older eligible material; unrelated entries were retained.

The live provider journey has not yet run. The original 350-second full workspace
preparation is still an unresolved performance limitation; no throughput
improvement is claimed by these deterministic checks.

The attended sign-in source later accepted independent provider sign-ins.
Claude enrollment failed while saving its dedicated credential: the isolated
home had no default macOS Keychain preference. Metadata-only checks reproduced
that difference from the user's normal home. Setting the default Keychain path
in the private home's preferences restored the lookup; the real user's default
and preference-file hash remained unchanged. No credential values were copied
or printed. The user then reported completing sign-in, but a successful Claude
provider request has not yet been verified.

The isolated Zen connection initially exposed nine free models because it had
no effective Zen credential source. The installed connection exposed 80 models;
all three questioned Council/backup models were present in the bundled catalog.
Zen and Go require separate connections. These observations came from provider
and credential-source presence metadata, not credential values.

The source selector subsequently changed to a new bundle revision through the
app's update flow. The original attended owner was closed; source and launcher
teardown passed, and the journal gap scan was empty. Its matrix never ran and
its overall outcome remains failed. Dedicated-profile lifecycle state also
prevents that original strict credential-projection recipe from being used.
Any subsequent direct journey on the retained isolated profile is separate
coverage and must record its actual source and artifact identities.

The user requested deletion support and removal of the two incomplete dedicated
Claude profiles. The implementation adds confirmed deletion with exact ownership
checks, durable retryable cleanup, and a selected-profile guard. Incomplete
unpublished records do not invalidate the healthy provider's cache. Removal of
a published cached profile prevents stale credential lookup until the existing
configuration reload retires that owner.

Both requested incomplete profiles were deleted through the authenticated owner
API on the isolated source (HTTP 200 for each). The remaining account is the
working enrolled profile; its status remained authenticated before and after
deletion. The UI exposes Delete and no longer lists either recovery row. See the
[sanitized API proof](live-agent-qa-profile-delete.json) and
[visible profile controls](live-agent-qa-profile-delete.png). The narrow browser
pane wraps the identifier; this screenshot does not qualify responsive layout.
The native artifact manifest is
`3b7526bc12176de11161ff576936dc74169e664246776796d8c4596d95256543`,
selected at bundle revision 4 through supported upgrades and owned restarts.
Both restart cleanup audits found zero remaining processes; journal gap scans
were empty.

Zen still exposes nine free models and has no effective authenticated source in
the isolated profile. Paid Zen backup/Council coverage remains unavailable.
Normal project registration initially returned `native_runtime_not_ready`
despite a ready health response. The feature-route composer omitted its existing
`ensureNativeDirectory` dependency. Forwarding that callback and testing the
actual HTTP composition corrected the refusal; registration then returned 200.

The direct live Plan attempt began at 22:10:25 UTC in a disposable task-board
project. Its saved roles and Council selections matched the captured graph.
Orchestrator GPT-6 Astra Medium dispatched two independent Explorer investigations
with Cursor Claude Haiku 5.5 Medium. Both workers overlapped, but neither produced
substantive output: the domain task failed with `model_unavailable` / `AI Model
Not Found Invalid parameters for registry model: "claude-haiku-5-5"`; the browser
task first received a 502 during API-key exchange, then its single retry received
the same model rejection. No credential value was logged. The parent stopped
with model recovery required. No plan or implementation was produced. See the
[visible blocked planning result](live-agent-qa-cursor-model-failure.png).
The [sanitized attempt record](live-agent-qa-direct-attempt1.json) retains exact
task identities, errors, and source/artifact hashes. Journal gap checks were
empty. Small-fixture workspace preparation took 881 ms
for the domain child; this does not establish performance on the original
12,922-file project.

Read-only tracing found the rejected Haiku parameter tuple came directly from
Cursor's advertised variants and was forwarded unchanged. A session-local retry
with its separately advertised `thinking-medium` tuple also failed. Recovery
through the normal UI with Cursor Composer 2.5 Default then produced a complete
investigation with real file reads. Saved agent settings were not changed.
However, after the SDK result and committed assistant completed at 22:19:45 UTC,
the journal emitted idle while the authoritative session endpoint still reported
busy and the managed task remained running. The parent could not consume the
result. This handoff remains under investigation; successful provider output is
not an end-to-end pass.

The live recovery UI also retained an abandoned result's recovery controls.
The scheduler advances an envelope's sequence when its disposition changes;
the UI incorrectly required an unchanged sequence and discarded acknowledgements.
The corrected store accepts nonregressing sequences for the same envelope while
preserving final actions and rejecting stale replay. Focused store and mounted
tests include a real scheduler acknowledgement.

Full validation completed successfully at 22:21:25 UTC for the earlier runtime,
profile-deletion and route-composition changes. Later recovery corrections require
their own validation before final completion.

The completed-but-busy Composer attempt was stopped through the parent abort and
managed cancellation APIs. The task became `interrupted`, preserving the fact
that clean provider cancellation was not confirmed; the child session then
reported idle. Owned host teardown recorded no remaining processes and no
observation errors. Terminal persistence phase diagnostics were added to the
existing journal without changing settlement or status semantics. Focused SDK
and native-owner tests cover held persistence boundaries and diagnostic privacy.

The user then requested Explorer use Cursor Grok 4.6 with Medium effort. The
authenticated save returned 200; `/api/config/agents` and the settings UI read
back `cursor-acp/grok-4.6` / `medium`. The normal Apply request exceeded its
restart readiness window and left a retry notice, although the native journal
later recorded ready after 56 seconds. The final upgraded restart must verify
the live selection again. See the [saved model view](live-agent-qa-explorer-grok.jpg).
The rebuilt web/Electron output, native artifact and bundle budgets passed.
Upgrading the isolated runtime returned
`bundle_harness_directory_unmapped`: saved tasks belong to a project registered
after the initial immutable project map was created. The refusal preserved the
existing history and held runtime admission. This upgrade mapping issue is being
repaired before the fresh Grok workflow; no successful end-to-end result is
claimed yet.

The subsequent full-validation attempt passed lint, type checks and document
validation, then failed one Bun startup readiness test with an empty JSON body
under concurrent build load (1 failure out of 1,337 script tests). The exact
five-test readiness file passed when rerun alone. This does not turn the full
attempt into a pass; full validation must run again after the upgrade repair.

The Grok recovery reproduced the completion delay. Its final SDK record queued
at 22:57:02.814 UTC, but had not begun persistence by 22:59:57. Earlier streaming
writes were still draining through the native owner, each taking several seconds.
Those queued writes shared a mutable assistant record: after completion, they
also appeared terminal. The journal recorded 34 terminal owner entries and 33
settlements before the actual final queued write started. The gap check was
empty. A delayed-owner regression reproduced the mutation before correction.
The repair combines pending updates for the same assistant message while keeping
distinct messages and awaited writes ordered; execution snapshots prevent an
in-flight streaming write from becoming terminal through later mutation.

A fresh browser reload showed Composer 2.5 Default above the recovered report
while the child was busy. After cancellation made the child idle, the same
loaded UI reverted to Claude Haiku 5.5 Medium: the nominal activity-owner fallback
incorrectly made the empty failed row eligible to own the header. This second
case requires an idle-state regression as well as the initial recovery check.
The Grok task was stopped through the parent abort and managed-task cancellation
APIs and settled as `interrupted`. The owned host
stopped responding. Its teardown audit failed because OS process observations
had been incomplete during the run, so this teardown is not counted as a verified
clean pass. The next run uses a fresh driver and disposable project and preserves
cleanup failures alongside the retained ownership evidence.

Bundle relocation now preserves exact registered project directories from the
copied settings when they are absent from the initial project map. It retains
canonical-path, symlink and protected-root checks. Harness (24), lifecycle (35)
and three targeted bundle cases passed. A full bundle-file run under concurrent
load had 19 timeout failures and 52 passes; it does not qualify as a pass.

The final-source default-concurrency validation attempt again passed lint, type
and documentation checks, then hit three subprocess timeouts in release fixture
tests (two build-argument cases and one image-resolution case). The retry uses
the existing `DEVRYAN_SCRIPT_TEST_CONCURRENCY=2` option. Assertions and timeouts
remain unchanged.

The concurrency-limited full validation completed with exit 0 at 23:32:41 UTC.
It passed workspace lint, type checks, documentation checks and deterministic
suites, including 4,107 UI tests. The idle-header correction landed before the
UI suite ran and also passed its targeted lint/type checks. The source snapshot
for the fresh live run is
`6b8d8d865d4e12f32917c936d3db3c4cc4234c485b65082ec75b639e052ef6ec`.

The fresh Grok run used root `ses_ed2a9fa10ffecC3CGNFm9t0MJF` on selected
native bundle revision 5. Both saved Cursor Grok 4.6 Medium Explorers completed
with at least 101,324 ms of overlapping running time. Their final persistence
settled in 4,536 ms and 6,231 ms, each with exactly one native terminal write;
managed completion followed 4 ms and 3 ms later. Both sessions became idle.
The parent acknowledged each result once. Journal gaps and session/persistence
errors were absent. Both children also emitted the non-fatal diagnostic
`native_todo_continuation_failed: recovery_observation_unavailable` after idle.

The parent completed its own native source read. Its first test process then
failed in the QA preload before fixture assertions ran. The QA shim validated
the host profile before reaching its existing confined-worker branch, although
the worker deliberately receives only its scratch home. The shim now selects
that branch first and keeps host marker validation for host processes. Its
owning 27-test suite passed, including the reproduced failure and negative
ownership checks. Production source and served artifacts did not change.

Revision 2 was saved as canonical Plan source
`msg_12d59b6dd001HaZR346sWCcYUM`, SHA-256
`20130e231aadfba1d5085981bde267522ce49c240f7ddec20cb0c2c1705fd428`.
API content matched the owned file. All six independent plan checks passed,
including unchanged project files, protected content, tests and dependencies.
The UI's Implement Plan action submitted approval after this check. A new full
validation run included the later QA-only preload correction; it
was intentionally interrupted with exit 130 after a newly discovered native
transport issue required another runtime change. Its lint, type, documentation
and 1,337 Node script tests had passed; this is not a full-validation pass.

After approval, the meaningful baseline test reached both expected assertion
failures with exit 1. The Fixer completed the backend changes and three new test
files. The parent then ran the unchanged baseline and `npm test`, both exit 0.
All ten independent preservation/backend checks passed, including HTTP and
restart behavior. The UI phase remained incomplete: the saved Designer tuple
`anthropic/claude-opus-5-5/medium` was rejected before generation with
`native_meridian_route_unreviewed`. Therefore this run is a partial result.

The selected configuration's existing local Claude proxy base URL has pathname
`/`; native Anthropic appends `/messages`, while the owned route guard required
`/v1/messages`. This is a transport compatibility failure before authentication
or an outbound model request. A narrow route normalization and a fresh full
journey are required. The partial fixture was archived completely (17 files,
27,235 bytes), then the parent was aborted and the isolated host stopped with
verified process observation, no observation errors and no remaining processes.

The scoped Anthropic middleware now accepts only the additional native
`/messages` alias and sends either accepted path to the fixed owned
`/v1/messages` endpoint. The actual native-provider graph reproduced the
saved-root failure before the fix. All 21 focused provider/worker checks and
runtime-host TypeScript checks passed afterward; other path prefixes,
`count_tokens`, userinfo and fragments remain refused. This does not establish
live authentication or model output, which the next fresh run must verify.

The next replay (`ses_ed296220affeG408aqoVdLX2PU`) completed both saved Grok
Explorers, with at least 120,059 ms of overlapping execution and one result
acknowledgment each. The parent read the source and then reached the two expected
assertion failures through native bash (exit 1). Its exact saved Plan revision
matched the owned file, and all six preservation checks passed before approval.
The normal Implement Plan action submitted approval. No implementation reached
the fixture: all four initial/retried child creations failed with
`controller_helper_unavailable` before either provider ran.

Cleanup of the previous disposable project exposed another lifecycle bug:
helper discovery resolved every registered root through one `Promise.all`, so
an absent unrelated root rejected discovery for the still-valid current root.
The regression reproduced that exact `ENOENT`. The host now ignores only absent
registered roots; resolving the requested directory, finding a surviving owner,
and all other filesystem failures remain mandatory. All 53 owning tests passed,
including missing requested paths, unregistered siblings, no surviving owner,
and `ENOTDIR`. The selected native artifact does not contain this web-host file.
The failed replay remains a partial result in the separate record. Its parent
was aborted and its host stopped with verified observation and no remaining
processes; the unchanged fixture is retained for a fresh complete replay.

Cold startup then reproduced `bundle_harness_directory_unmapped` because
history verification discarded the absent registered identity. That identity
is now retained only for metadata mapping; executable location discovery still
excludes the missing folder. The regression covers preserved Git references
and context records, unregistered history rejection, and recreated-symlink
rejection. All 29 harness/location checks plus targeted lint/type checks passed.
The module is a native build input, so native, web and Electron builds were
rerun successfully, followed by the startup bundle budget check.

Full validation completed with exit 0 at approximately 00:22 UTC on 12 October,
including 4,107 UI tests, 6,649 web server tests and the final 14 native tests.
The late cold-start change has the separate 29-test result above because the
full run had already started its web suite. Its targeted lint/type checks also
cover the change made after the full run's initial checks. No test assertions
or deadlines were weakened.

The [revision-7 replay record](live-agent-qa-claude-partial.json)
(`ses_ed280716fffej0K6fcYVcEKZ9I`) again completed both
saved Grok Explorers, with at least 79,382 ms of overlapping execution and one
acknowledgment each. The parent completed its native source read before the
standalone test reached both expected assertion failures, exit 1. Its exact
saved Plan matched the owned file; all six plan/preservation checks passed with
no changed files. The normal Implement Plan action then started the saved Fixer
and Designer together. The Fixer completed its five files and nine assigned
tests. All ten independent backend/preservation checks passed, including HTTP
and server restart persistence. The complete partial fixture archive contains
17 files and 24,230 bytes.

The Designer reached the owned Claude process and then failed with process
exit 1, before any tools or edits. The adapter classified that generic exit as
`authentication_error`, but the provider status endpoint subsequently returned
authenticated OAuth status. These facts do not establish expired credentials.
The confined nested process discarded stderr detail, so a bounded diagnostic
receipt is needed to distinguish authentication from launch/configuration
failure. The [failed child view](live-agent-qa-claude-settled.jpg) displays a
settled request error rather than indefinite processing. This replay remains
partial; the UI implementation, final parent test sequence, and independent
browser check are not complete.

At 00:37 UTC the isolated host was stopped with verified process observation,
no observation errors, and no remaining processes. The user reported that
Open Subtask could not open the Fixer during this downtime. After restarting
the same selected bundle, the exact Fixer session and its messages both returned
HTTP 200; the normal Open Subtask action loaded its completed conversation and
five edited files. The [reopened Fixer view](live-agent-qa-fixer-open.jpg) records
the result. The journal had no late session read/error event and no gaps; this
navigation failure was not reproduced with the preview online.

The user also reported an Explorer header displaying `Assistant Medium` and a
composer retaining the previous agent/model. The canonical session, user and
assistant records, plus the Cursor SDK run result, all identify
`cursor-acp/grok-4.6/medium`. The actual run used Grok 4.6. The UI resolver had
ignored flattened user model fields, and its friendly model label did not
subscribe to later catalog updates. Focused regressions cover both corrections.
The first rebuilt live check restored Explorer and the exact saved model/effort,
but exposed a further timing issue: the initial nine-model fallback remained in
the picker after the server catalog contained 61 models. Catalog completion
needs an authoritative invalidation signal; this live UI check is not yet a pass.

On selected revision 8, the Designer retry
`dvr_task_4006f2d0d8f04f8eb33d97b608834ef1` again reached the owned Claude process
with `claude-opus-5-5/medium` and exited 1. Native idle at 01:01:20.520 UTC
preceded durable task failure by 11 ms; the journal gap check passed. The new
finite diagnostic receipt reached the journal, but its generic sanitizer kept
only `code: 1` and `truncated: false`, dropping the bounded diagnostic categories.
This is a diagnostic projection gap and still does not establish an
authentication failure. A scoped sanitizer regression and another live retry
are required before assigning the underlying cause.

The scoped sanitizer regression then passed through the real scanner, journal
disk write/read, and export. Selected revision 9 retained a complete finite
receipt: process exit 1, no signal, 53 stderr bytes scanned without truncation,
and the `permission` category. No authentication category or HTTP 401/403 marker
was recognized. The request settled in approximately 4.24 seconds and the journal
gap scan passed. The permission boundary requires investigation; a credential
reset is not justified by this evidence.

The catalog completion signal and UI consumer passed 100 backend checks and
39 focused UI checks, including a delayed fallback response that must not
overwrite the completed SDK catalog. UI type checks and targeted lint passed.
The rebuilt web/Electron output and startup bundle budget check passed. The
live [Explorer header](live-agent-qa-cursor-header-fixed.png) now displays
Grok 4.6 Medium, and the [Cursor picker](live-agent-qa-cursor-picker-fixed.png)
contains the Grok choices while preserving Explorer/Grok 4.6/Medium in the
composer. After an owned cold restart at 01:16:46 UTC, the page was loaded once;
the [picker contained Cursor Grok 4.5/4.6/4.7](live-agent-qa-cursor-cold-start.png)
without a second page reload or provider/model change. This checks the live
cold-start catalog outcome. The complete fresh implementation journey remains
pending.

An offline composed launcher regression then reproduced the permission failure
without provider credentials: the confined outer launcher attempted to run an
inner launcher with a harmless command. The inner process emitted the exact
53-byte `private execution directory: Operation not permitted` failure and
exited 125 before that command ran. The outer sandbox denies the inner
`setpgid` operation; the outer receipt remained confined and the inner receipt
reported no established confinement. This establishes a launch-ownership bug,
not a provider authentication failure. The correction must move per-request
Claude launch ownership to the host while retaining its own read-only sandbox,
validated request scope, cancellation and termination receipt.

The replacement transport passed the captured SDK interface check and actual
confined outer-worker-to-host-to-confined-CLI tests, including protected-file
read denial, project write denial and cancellation receipts. Its native and
web/Electron builds and startup bundle budget check passed. Selected revision 10
then reached Claude's API with the saved Designer Opus 5.5 Medium tuple. The API
returned HTTP 400: bundled Claude Code 2.1.251 requires an upgrade to at least
2.1.280 for this model. Eleven physical attempts and ten automatic retries ended
naturally with native idle preceding durable task failure; no human abort or
tool execution occurred. The [sanitized version record](live-agent-qa-claude-version.json)
contains the exact identities, receipts and zero-gap result. This establishes
the next compatibility blocker, not a successful Designer request.
