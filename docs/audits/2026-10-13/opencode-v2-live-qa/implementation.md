# Consensus implementation and verification record

Implementation began on 2026-10-14. This is a working record, not a release qualification receipt. Existing user changes were retained. Worker tasks use GPT-6.1 Sol with High reasoning; Codex reviews their changes independently.

The original QA did not reach implementation. First-receipt-to-task-terminal durations of 104.055s and 55.707s are completion lower bounds; raw model completion was not captured. Explorer's 1.08M input usage is cumulative consumption, not active context size. The preliminary plan is superseded by the approved consensus plan.

## Current rectification cohort

The user approved the final Claude/Codex rectification plan. The earlier full
validation and build results below describe historical source cohorts; they do
not qualify these subsequent corrections or a release. Codex independently
verified 65 release tests, 172 Cursor package tests, 66 Cursor host tests, 34 Plan
policy/denial tests, 15 native admission/retry tests and 12 mutation/store tests.
The shared result/scheduler and cleanup corrections passed their owning tests
in [the current focused proof](../../2026-10-14/managed-results-plan-cleanup.json).
Counts overlap historical suites and must not be added as unique coverage.

Release retry accounting and actual updater discovery, exact Cursor final-part
association and receipt coverage, guarded no-start proofs and strict cached
restore identities are implemented. Follow-up creation/acknowledgement is now
one durable commit. Final page acceptance cannot advance after a failed
publication read. Unknown Plan effects remain denied by trusted host policy.
The actual application runner now also requires real file Undo/Redo and drains
captures and cleanup within its existing deadline.

Helper/title and compatibility/preparation corrections are implemented and
their focused tests passed. Native source and compiled graphs passed bounded
interruption recovery, missing-attempt refusal, ordinary retry, publication and
compaction cases. The two Plan-policy fixture failures caused by missing trusted
provenance were corrected and separately rerun successfully; the failed run is
retained in the focused proof.
Production build and bundle checks passed on the later settled cohort. The new
session-changes UI correction requires a fresh UI build and bundle check. The native artifact
`9d4ae1ee07773c2fdf8cd2a5af500f416ce20a8bfc85000319a8d163416255ee`
passed the complete Node package gate on its recorded historical source cohort: all 53 cases, valid unchanged source,
zero cleanup failures and verified durable journals. Diagnostic/preflight modes
were disabled. [Current proof](../../2026-10-14/managed-results-plan-cleanup.json)
retains the superseded artifact and failed integrated attempts separately.
The later QA1 launcher correction was independently tested, the canonical project-map fingerprint was repaired, and the same V1 / QA1 profile upgraded successfully without copying accounts. A second complete original-producer Node report passed 53/53 with unchanged source and no cleanup failures. Subsequent Cursor Verify and QA catalog corrections change that cohort again, so another fresh report is required before paid admission.

The next actual Plan run produced 40 captures and reached restart after implementation and partial recovery, then failed at file Undo. The journal contained 920 relevant records with zero gaps and no restoration dispatch: the test had opened the real confirmation dialog without confirming it. The corrected driver keeps the existing exact restoration checks and 480-second deadline; its independent 19-test rerun passed. [Incident proof](../../2026-10-15/plan-file-undo-confirmation.json). Full visual, Undo/Redo and helper-save acceptance remain pending.
QA1 exercise and provider fixtures passed independent owning checks;
[QA1 exercise proof](../../2026-10-14/qa1-exercise-implementation.json) and
[provider proof](../../2026-10-14/qa1-provider-qualification.json) distinguish
them from paid execution and provider sampling. Final frozen-source validation
and complete visual/live qualification remain required. QA1 and its existing sign-ins are preserved;
no release was published or runtime version changed. The earlier result-v2
latency regression remains visible in the new paired measurements: v2 reduced
transport bytes and calls but still increased median host latency and CPU.

The integrated `validate:full` rerun (`1307`) passed before the new session-changes UI correction, including 4,138 UI tests, 6,977 web tests and 24 additional native-host tests. Production build and bundle checks passed on that cohort. A missing SDK 1.0.28 conversation witness in the cumulative-usage test double was corrected without changing production accounting; the full Cursor package passed 278 tests. An earlier application run reached file and conversation restoration but failed at the helper picker: the driver queried a button although the actual desktop trigger is a div. Screenshot review also found captures taken during loading after viewport/theme changes. Those driver boundaries were corrected and independently tested; that failed run remains retained.

The earlier application attempt retained 33 captures and failed at the restart-restored checkpoint after one session-changes summary returned HTTP 503 with no later read observed. The native startup interval was 3.092 seconds, but no exact summary-to-native-epoch join is available. The [restart recovery proof](../../2026-10-15/session-changes-restart-recovery.json) distinguishes that incident from the bounded read-only correction. Root independently passed 63 store/card tests and the final UI type check, followed by production build and bundle checks. Reviews also reproduced and corrected queued-hint budget resets and between-read backoff replacement.

The earlier rebuilt application rerun produced all 60 captures. Its four same-key summary 503s recovered to 200 after the expected 0.5/1/2/4-second backoff, with 27 further successful summaries. The journal retained 966 records without gaps, source verification was unchanged, and the owned process registry was empty. It still failed during helper-settings navigation after reload; one helper capture caught a closing dropdown. The [rerun incident proof](../../2026-10-15/plan-restart-helper-navigation.json) records those limits.

The corrected application lane subsequently passed twice with natural process exit, unchanged source, and all 60 captures/checks. The final retained run verifies the same-session Plan handoff, real Fixer/Designer writes and checks, partial recovery, restart, file Undo/Redo and conversation Revert/Redo. Its HTTP helper save exercised the UUID fallback and exact revision/readback/reload with hydrated controls. Independent inspection covered every screenshot; the sealed journal contained 946 records with zero gaps, and the existing version-2 process registry was empty. [Qualified Plan proof and retained visual limits](../../2026-10-15/plan-implement-qualified/README.md). Root verified seven copied images and removed only the owned profile/workspace through the existing cleanup owner; all 70 light proof files remained unchanged. QA1 was untouched.

Final `validate:full` passed with 4,147 UI tests, 6,977 web tests and 24 additional native-host tests. Final production build and bundle checks also passed. The fresh original-producer full native package report passed all 53 cases with no cleanup failures or remaining package gates. Root independently verified the original owner, runner SHA and complete current source inventory; paid-provider and release gates remain separate and unqualified.

A fresh coordinated [five-pair cold/warm transport rerun](../../2026-10-15/managed-result-transport-rerun.json) retained V2’s lower result bytes/RPC counts and higher host latency/CPU. The 20 natural worker exits establish physical settlement; this runner does not measure application return-to-idle latency.

## Focused verification completed

| Scope | Result |
| --- | --- |
| Cursor | Worker package suite: 242 passed across 26 files, including real direct/one-shot/persistent adapters. Web adapter suite: 60 passed. Codex reviewed FIFO, callback filtering, concatenation, final replacement and cancellation barriers. |
| Receipt ledger | Bun session-changes, recovery and host suites: 57 passed. |
| Receipt host and migration | Web `cursor-execution-receipts`, `session-execution-host`, `bundle-harness-integrity`: 87 passed. Alias retention, retries, late calls and archived continuation references covered. |
| Serialized result limits | Bun output-limits, projection and execution-owner: 17 passed. Web runtime/config focused group: 87 passed. Escaped reports reconstruct exactly; unpageable metadata refuses before acknowledgment. |
| Advisory refresh | Bun `session-mutations-inputs`: 16 passed. A later real call sees edits made after refresh. |
| Context | Bun UI send suite: 125 passed. Turn planning metadata below 256 bytes; static format retained. Explorer prompt/recovery guidance: 29 passed. |
| SSE | Web upstream-reader, runtime and v2 routes: 36 passed. Capped backoff, prompt abort and no-transform headers covered. |
| Release | Codex independently ran 33 publication/workflow/smoke tests. Stable desktop scheduling regression: 10 passed after skipping unused native/UI preparation while reusing the admitted candidate DMG. |
| Receipt performance | Five alternating pairs each cold/warm: 20 samples passed, using real disposable Git ledgers and simulated settled Cursor leases. See [sanitized numeric proof](receipt-benchmark.json). |
| A2 Plan owners | Worker web suite: 343 passed (13 files); UI Plan suite: 219 passed (12 files); sync lifecycle: 99 passed separately. Source/compiled policy function fixtures passed, but do not establish the full UI/native lifecycle gate. |
| Direct read receipts | Seven owning tests passed: concurrent durable commit, per-call staged rollback, cancellation, commit failure/retry, idempotency, captured directory/no-meter cleanup and revert fences. One-shot Cursor startup timing forwarding: one owning test passed. |
| Shared planning fixtures | Codex ran 31 script tests after updating exact fixture expectations for static guidance plus short turn metadata. |
| Runtime 2.0.27 | [Separate qualification stopped before build](opencode-2.0.27-qualification.md); changed reviewed inputs and Effect contract remain prerequisites. No runtime upgrade or compatibility pass claimed. |

Counts describe particular runs, not a sum of unique tests or integrated qualification. Temporary runner/path-resolution failures were corrected; definitive results use repository-owned tools. No dependencies or runtime versions changed.

## Independent review corrections

Native reservations now expire without actual progress; pending flags cannot exempt stalls indefinitely. Stable packaging reuses qualified candidate bytes. Startup proof follows settled I/O and leaves no passing artifact after a timeout. Published no-op retries require the original digest-bound finalization/deployment artifact. Plan review also identified bounded-history pagination, earlier draft/final-source confusion and transient settlement barriers; their owning worker is correcting them with regression coverage.

Catalog preparation now happens outside the parent mutation lock while exact submission scope is consumed once. Independent reproduction found a Stop race between preparation and scheduler reservation; reservation and durable insertion now both recheck authorization and the reproduced race leaves zero tasks. Native read-result scopes preserve fresh permits while allowing Stop to acquire the mutation lock. Bulk disposition review also found late wrapper failures could hide a committed acknowledgment; the owning worker added committed-truth preservation and a real-scheduler regression.

The first integrated `validate:full` attempt passed workspace lint, type checks and documentation. It stopped at six script assertions: three expected the former duplicated Plan guidance, two expected the former release writers, and the wire-only QA facade tried to save a Plan without a native settlement owner. These need owning corrections and a full rerun; this attempt is not a full validation pass. Production web/Electron and isolated compiled native builds are in progress.

The second full attempt passed the corrected script group and progressed through the harness suite, where one usage-export fixture used a non-native helper ID rejected by the new title diagnostic boundary. Updating it to native `ses_`/`msg_` identities retained the deleted-helper join assertions; usage and sanitizer suites then passed 30 tests. Full validation still needs to finish on the final cohort.

Web/Electron build and bundle budgets passed. Initial compiled package qualification stopped at a real cold-helper refusal (`native_helper_location_expired`): catalog readiness had not acquired the original lazy location/LLM graph. The worker is qualifying exact scoped location acquisition; title shipping is not yet qualified. Actual source SDK Plan policy passed 11 startup/auth/policy cases with stable sources and cleanup. The compiled application produced real enabled Plan approval screenshots and clicked the control, then stalled before native Implement acceptance. Diagnosis found the mandatory managed barrier read reacquiring the scheduler mutation lock already held by prompt admission. The barrier must be read under the existing captured scope rather than removed. No compiled Plan → Implement success is claimed yet.

Peer review also corrected mutable directory capture and cleanup without a progress meter in direct receipt grouping. Groups now require the same execution signal; the original precommit cancellation guard remains, and mandatory commit I/O stays owned until settlement. Visual inspection found hardcoded disabled approval colors looked active in the dark theme; they now use existing muted theme tokens and lower opacity, pending rebuilt visual confirmation.

The next rebuilt full package attempt (`package-DRYoIu`) retained thirteen passing startup/input/catalog cases and again failed `native_helper_location_expired`. The actual combined source stack reproduced the cause: LayerNode's last-wins LLM replacement discarded the helper capture. The shipped winning stream override now composes that same scoped capture; combined cold-helper, cancellation/finalizer and native Continue source graphs passed. This correction still needs rebuilt full compiled qualification, including a model title persisted exactly once and restored after restart.

The compiled application run (`native-plan-implement-4RBGYo`) stopped before approval at `native_stream_continuation_fenced`. Journal gaps were empty; the deliberately policy-denied writer had no non-execution receipt. The continuation owner correctly refused unresolved execution. Its constructor-owned negative-admission proof is being corrected rather than allowing continuation from an error label. Computer use verified the interrupted Plan remains disabled. Exact failed-turn wording now also considers the existing persisted turn failure, while a verified successful continued source takes precedence.

Independent review found numeric Plan successor fixtures contradicted the original owner's `{traceID, spanID}` attempt witness. The consumer now accepts only that actual typed witness, retains ordinal/event ordering and rejects malformed witnesses; a regression drives reserve/bind/prepare/send/adopt through the original owner and passes its unchanged receipt to the Plan validator. A failed unproved native row without completion/error was inspected directly and remains inadmissible.

A separate real-scheduler reproduction showed a starting-save failure could hide an already committed queued submission. The scheduler now returns committed task truth, schedules the existing bounded admission retry and keeps earlier durable sibling admissions running if a later save fails. Another held-save reproduction exposed proposed `running` state in a start receipt; it now uses the same committed reader as public snapshots. Three new regressions and the action/watchdog group passed 38 tests, independently reviewed.

The third full validation attempt again passed lint, types and docs, but root concurrently launched supplemental native graphs against the same fixed OAuth callback port. The full scripted provider graph failed with `ECONNRESET`; this attempt is failed, not accepted as flaky success. Supplemental graphs were stopped and the final owning/full runs will be serialized. Source and compiled result-publication graphs had passed before interruption; supplemental stream qualification was interrupted and is incomplete.

The receipt microbenchmark reduced 50 scalar receipt submissions/notifications to two batches/notifications, preserving all 48 internal call aliases and the two outer receipts. Median cold latency was 5,828ms versus 755ms; warm latency was 5,636ms versus 817ms. Median process CPU was 642ms versus 85ms cold and 635ms versus 75ms warm. Whole-process peak RSS stayed approximately 120–122MiB. This does not measure provider latency, native publication, subprocess CPU or live orchestration. RSS includes earlier samples in the same process. Repeated candidate saves verify memoized no-op behavior; assertions independently read every required durable receipt.

## Integrated qualification status

The frozen cohort's `bun run validate:full` completed successfully on 14 October
2026, including 4,135 UI tests across 594 files and 6,842 web tests across 556
files. Workspace lint, type checks, documentation, scripted native contracts and
the other affected package suites also passed. Counts are specific suite totals,
not a claim that every live acceptance gate passed. The latest production
web/Electron build and `bun run bundle:check` passed; web-main gzip is 1,446,194
bytes against a 1,456,388-byte budget.

The actual compiled application subsequently exposed a title persistence refusal,
`native_owned_operation_required`. Exact constructor-issued title permits were
validated and then incorrectly sent through the generic public rename guard.
The one-line exclusion preserves the exact payload, session, title comparison,
model, agent, admission revision and owner rechecks. Codex independently ran its
16-test helper suite with 84 assertions, including real generic authorization,
manual rename, revoked access, changed revision and expired permit. Full model
title persistence and restart acceptance is being rerun; it remains a gate.

The actual Plan browser run now reconciles only a changed canonical session slug
after checking unchanged session ID, birth time and exact directory. Thirteen
API regressions pass. Its continued Plan is authoritative and actionable in
1280×800 and touch-enabled 390×844, light and dark. After the real approval click,
the old Plan is visibly disabled. Codex independently inspected these screenshots.
That run stopped during task dispatch because the child still had its placeholder
title. Approval screenshots do not establish the complete implementation gate.

Cursor canonical text now remains exact through the UI reducer, history loading,
materialization, rendering and copy paths; the actual provider/projector-to-UI
regression passes eight tests with 38 assertions. Existing native Cursor part
identity selects this behavior. Legacy provider cleanup is unchanged. See
[connected transcript proof](cursor-exact-ui-transcripts.md).

The fresh Node qualification reached fourteen passing cases and persisted the
root model title once, then stopped because accepted-identity readback rejected
the constructor-owned managed-child title binding. The public metadata parser
remains strict; a separate canonical readback validator now accepts only the
exact typed private binding. Codex independently passed 217 admission, title and
Plan-policy tests. [Retained title-source evidence and restart limits](../../2026-10-14/native-title-scope.json)
distinguish that negative run from the still-required full shipping gate.

Connected HTTP verification also found that the V2 browser façade discarded the
UI's human-input marker. It now carries only the exact `human` marker; absent,
malformed, native and managed markers remain unknown. Codex independently passed
112 route tests, including historical A → B → A replay and newer input during
the final title authorization. Neither case buys another paused persistence
cycle. Internal constructor origins retain their separate path.

The attended provider profile is pinned and registered as the reusable V1 / QA1
default. Codex independently passed nine retention, ownership, publication and
trusted-constructor tests. The user reported all other accounts signed in;
Claude's original enrollment failed at persistence, with a clear journal gap
check. An exact private enrollment/lifecycle scope can now select the OS user's
Keychain HOME for credential commands. Default and legacy paths retain their
inherited HOME. Two independent reviews found no blocking defect, and Codex
passed the 57-test owning group. [Scoped credential evidence](../../2026-10-14/claude-owned-security-home.json)
keeps actual OS sign-in qualification separate from those fake-backend tests.
The same owned host was restarted with its stores retained; no account copy,
Keychain reset or paid inference occurred in that restart.

The supplemental native graph command completed with 20 passing cases and no
failures in 190.47 seconds:

```text
DEVRYAN_NATIVE_STREAM_COMPILED_SETTERS=1 bun test scripts/opencode-v2-native/native-stream-continuation.graph.test.ts scripts/opencode-v2-native/native-result-publication.graph.test.ts scripts/opencode-v2-native/native-plan-policy.compiled.test.ts
```

These source and compiled pinned-2.0.26 fixtures use actual native publications,
retry proposals, Synthetic successors and later Steps. They cover two bounded
continuations and third-request veto, ordinary retry, Stop/publication races,
raw-body silence, denied-tool non-execution receipts, empty text/reasoning/tool
starts, exact result publication and later-step review, plus Plan policy and
permission translation. The silence case uses an isolated short timeout to prove
native Transport/Timeout/read classification; it does not qualify a production
120-second post-output limit.

The receipt benchmark above and the separate result-transport benchmark each
contain five alternating cold/warm pairs. Result contract v2 reduces serialized
bytes and owner/RPC calls while preserving both durable acknowledgments. Its
host latency and CPU increased in this measured workload; no speed improvement
is claimed for it. See [result-transport observations](../../2026-10-14/managed-result-transport.json).

## Historical failed acceptance attempts (superseded)

The following attempts retain their original failures and evidence limits. They
precede the later `9d4ae1ee…` full Node passes and are not the current gate status.

The refreshed `97e1f5c3…` artifact completed 44 full Node package cases. The exact
retained-shell recovery now passes: one continuation request, one execution,
verified termination and publication, retained receipt and unchanged file across
two controller replacements. The actual model-title gate also passes with one
helper request and one native rename, restored after restart. Source-cohort
validation passed, cleanup had no failures and candidate journal gap verification
was clear. The complete package gate remains failed at a later selected native
lifecycle timeout; no failure assertion was weakened. The independent actual
Plan → Implement application/visual lane was subsequently rerun against later artifacts.

That historical compiled Plan application run again accepted the verified
continued Plan through its real UI control. It stopped at dispatch capture:
the Fixer wrote and checked its file but its title source was unavailable to
the title scheduler, so no task heading could be revealed. The zero-gap journal
supports those limited observations. [Current approval captures and remaining
implementation limits](../../2026-10-14/plan-approval/README.md) retain the
independent visual inspection without claiming the full implementation gate.

An earlier full Node package attempt retained 25 passing cases, including both
locations' real writes and isolation, retained input recovery and Revert/Redo.
It failed the exact retained-shell-notice consumption assertion after controller
replacement. Journal gap verification was clear, source-cohort validation passed
and cleanup had no failures. The shell was executed and published once; the
replacement promoted the queued notice but did not produce its required reply.
That attempt failed, and its assertion remained intact through the later qualification.

The user's isolated Claude enrollment subsequently wrote and reread its owned
Keychain item with exit code zero. The user confirmed Authentication remains
signed in after refresh. The sanitized command observer records phase/exit code
without call or session IDs; that correlation limit is retained in the credential
audit. Claude appearing as Usage Only was a separate native-catalog issue:
QA1's reviewed empty legacy-plugin list excludes the compatibility registration
that the first catalog correction required. The selected-profile model bridge
was subsequently corrected and tested. Later human sign-in and catalog reports
supersede that Usage Only observation; they do not qualify current paid inference.

## Current mandatory gates

The native compiled identity remains build
`9d4ae1ee07773c2fdf8cd2a5af500f416ce20a8bfc85000319a8d163416255ee`, manifest
`37f21fcbd9c5385b5c7510da4b505cb43cd5f91e3b2aa07d94e02a4b7701248e`.
Its final 53-case full Node report, including exact model-title persistence/restart,
matches current source and original runner ownership. Final integrated validation,
production build/bundle checks, the complete 60-capture Plan application lane
(52 Plan captures plus eight file controls), HTTP helper-save/reload and retained
zero-gap journal verification passed. Earlier passes and failures remain historical
and are not substitutes for this exact final cohort.

The saved QA1 original-model replay and held-out paid providers remain unrun on
the current cohort. Live helper naming/commit/PR must prove the actual captured
selection and empty physical tool set. Three representative OpenAI Astra High
HTTP samples and the original retained Medium turn remain mandatory; missing
observations or a WebSocket route cannot qualify the proposed silence policy.
The result-transport rerun retains higher V2 host latency and CPU. It does not
measure application return-to-idle or matched post-receipt UI timing. The
conditional Finalizing UI decision still requires five matched samples exceeding
one second median or three seconds worst post-receipt time.

Hosted candidate rehearsals, frozen-baseline upgrade/rollback and final tagged
DMG qualification require their separate release prerequisites. Production
signing can refresh native payload and manifest digests, so the signed installer
needs its own exact retained qualification. Final cache reporting and owned retry
cleanup will follow retained sanitized proof.

Hosted candidate rehearsals and the tagged final-DMG gate have not run. The 120s post-output silence policy stays disabled until live qualification. OpenCode stays pinned at 2.0.26; 2.0.27 qualification remains separate.
