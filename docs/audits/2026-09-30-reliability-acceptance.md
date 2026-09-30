# Reliability fixes and orchestrator acceptance — 2026-09-30

Status: implementation, full repository validation, build, bundle checks, and
packaged native verification passed. Live acceptance remains partial: A and E
did not complete their root turns, C and D required recovery, and F did not reach
Implement. The expired Claude credential also prevented the required live
Plan/normal sentinels after review corrections. These are not recorded as passes.

## Candidate and scope

- Repository: `1H-Team/DevRyan`, working tree based on
  `bdf0dec1e1ff2193cdd8c139138ef0e7b9fdfe43`.
- Final candidate 5 digest:
  `adbc53e5fe2a0ade2d0ed37c0f40a75962b417be61358d10e807dbf24ecf5bec`.
  Its manifest covers 90 modified or new source/documentation files, excluding
  this audit report. The final build and bundle checks passed. Packaged ASAR:
  `0547884f1e1b656e4a246a2647456a1860975c16f26f5ada12e27ceea525ad9f`.
  Packaging verified all 90 source hashes before and after assembly. All seven
  native checks passed on these runtime bytes; full repository validation passed.
  Candidate 5 differs from candidate 4 only in one test assertion's
  typing. Rebuilding and repackaging produced identical ASAR, UI, preload,
  bootstrap, and native artifact hashes, so the seven native results still apply.
- Pre-review candidate 3 digest:
  `fde1ada73654f9b0a8b46eb26dfe48e7688807388bf124be135556e858caab49`.
  The cache-owned manifest pairs the base commit with hashes of all 89 modified
  or new source/documentation files, excluding this evolving audit report.
  Candidate 3's packaged ASAR is
  `806dd75eb6214d22d27ecd998e3819714893aee6189d5dd4c8eb3534a289e3a3`;
  packaging verified the source hashes before and after assembly and passed
  native SQLite and PTY checks. Earlier matrix runs used the initial package,
  identified separately below.
- Preserved the pre-existing working-tree changes. No commit, push, release,
  dependency addition, upstream checkout access, or installed-app modification.
- Implementation used GPT-6.1-sol subagents. Product acceptance preserves the
  user's saved orchestration roles, models, efforts, presets, and backups.

The changes cover sequential mutation ordering; long-lived OAuth refresh
responses and bounded diagnostics; superseded authentication failures; agent
verification and supervised-server guidance; versioned saved-plan updates;
and owned terminal descendant cleanup during stop, shutdown, and restart.
The status shimmer keeps its existing appearance and timing while removing the
duplicate accessible label. No ledger or animation optimization was made.

## Focused evidence

| Area | Result |
| --- | --- |
| Mutation ordering and durable mutation/recovery suites | 159 passed, 3,984 assertions across seven files; 681.21 seconds including the existing 1,300-file stress case |
| OAuth coordinator, authentication errors, reasoning adapter, host OAuth connections, credential broker | 68 passed |
| Harness diagnostic sanitizer, journal round trip, export | 29 passed |
| Same-session failure supersession and canonical message loading | 116 passed before the plan-event forwarding case; lifecycle suite then passed 87 tests including that case |
| Saved-plan HTTP persistence | 15 passed: version conflicts, concurrent winner, size/blank validation, ownership revocation, symlink files/directories/ancestors, atomic failure and cleanup, content-free events |
| Saved-plan host, transport, and context | 48 host/transport checks and 16 task-context checks passed; the focused current-grant ownership check also passed |
| Plan View and client | 117 UI checks and four web API checks passed; mounted checks cover load echoes, serialized saves, own-event acknowledgment, identity changes, conflicts, and unmount/remount retention; UI typecheck passed |
| Review-corrected plan authority | 141 checks across HTTP, current caller grants, and private host passed; independent global-root and legacy-root selection probe passed |
| Review-corrected canceled Plan View loading | 18 focused checks passed, including the mounted regression that failed before correction |
| Terminal cleanup | After review correction, 21 deterministic checks and native macOS stop/restart/shutdown passed with a child resistant to both SIGHUP and SIGTERM; unrelated sentinel survived all three cases |
| Electron quit/restart | Nine deterministic checks plus seven native packaged-fixture checks passed, including normal restart, service-window detach/restart, native PTYs, and owned-process cleanup |

The invalid-expiry defect was reproduced with an isolated synthetic refresh
transport. This confirms the defect and its correction; it does not establish
that every historical live authentication incident had that cause.

The saved-plan store uses one cross-process lock and byte-derived version for
both HTTP edits and the private agent tool. The host checks canonical selection,
current call, primary role, owner/project, cancellation generation, and writable
objective again before committing. Full revisions are bounded to 256 KiB UTF-8.
Dirty editor drafts remain visible on conflict. Native filesystem confinement
continues to enforce raw-write restrictions independently of advisory guidance.

The native packaged run used separate owned service and normal-app profiles. A
real service descriptor, authentication bootstrap, desktop lease, and terminal
were exercised. Window detach/restart preserved the same service-owned terminal
and subsequent input; stopping the owned service stopped it. Normal restart
stopped the old app-owned terminal and relaunched a packaged app within the
13-second check bound (11.73 seconds observed under concurrent QA load in the
earlier run; 2.23 seconds in the final candidate run).

This service fixture substitutes only the OS-registration status preflight:
the QA package intentionally disables launchd registration. Actual OS service
registration remains unavailable. The final candidate's seven-check result is
`.cache/qa/reliability-desktop-cleanup/attempt-1790780972640/evidence.json`;
its final retention record confirms the ASAR was reverified, both archived
journals passed gap verification, and all 43 observed OS process identities
were stopped. Both private runtime/profile trees and their credential copies
were removed. No provider calls were made. The earlier seven-check result is
retained under `attempt-1790776789966`. Retained ancestry and explicitly verified
relaunched-process identities showed no remaining owned processes. Earlier
fixture/debugger failures and their cleanup are retained, including explicit
cleanup of three relaunched apps missed by ancestry polling. The initial audit
of 13 native process trackers found none of their captured identities remaining;
a later targeted scan also found a paused relaunch from an earlier failed
fixture, before its restart evidence had been assigned. Its known inspector
log, private QA runtime, and OS start identity established ownership before
cleanup. The final scan found no remaining owned QA app. Ten private native
profiles were removed after retaining their journals and evidence.

## Measurements

### Ledger

Command: `node scripts/perf/ledger-benchmark.mjs --fixture-files 1000 --iterations 3 --warm-calls 3 --parallel 4 --restamp --out .cache/qa/reliability-ledger.json`.

The fixture contains 1,002 tracked files including its support files. Medians:

| Measurement | Milliseconds |
| --- | ---: |
| First begin | 6,991 |
| First finish | 413 |
| Warm begin, nine samples | 666 |
| Warm finish, nine samples | 425 |
| Warm cleanup | 200 |
| Four-call burst span | 3,619 |
| Burst begin, twelve samples | 1,270.5 |
| Restamp begin | 1,340 |
| Control | 411 |

Median reported maximum RSS was 192 MiB. These are local candidate measurements,
not a before/after optimization claim.

### Status shimmer

An isolated Electron 41.2.1 fixture rendered the current `StatusShimmerText` DOM
and exact production shimmer CSS, with one label at 1,280 × 768 CSS pixels,
device pixel ratio 2, and a visible window. Each of three running/paused pairs
used five seconds of warmup and 30 seconds of samples at 500 ms intervals;
pair order alternated. Pausing used the existing animation, preserving layout.

| State | Median renderer CPU | Median GPU-process CPU |
| --- | ---: | ---: |
| Running | 1.29% | 1.65% |
| Paused | 0% | 0% |

These are Electron process CPU readings for one CSS label, excluding React,
streaming, and status timers. Zero medians do not establish zero total work.
Raw evidence and the fixture screenshot are under `.cache/qa/shimmer-measure/`.
The first fixture attempt failed its animation observation check; the corrected
fixture completed all six windows. Both attempts cleaned their owned processes;
the final ancestry audit reported no remaining process IDs.

## Repository gates

The final candidate passed `bun run validate:full`, including workspace lint,
all typechecks, documentation validation, and every deterministic suite. The
web suite finished with 4,826 passed tests across 423 files. Final production
build and bundle checks passed; the packaged runtime and UI match the bytes
that passed all seven native checks. Earlier failures and their corrections
remain documented below.

The first `bun run validate:full` passed workspace lint, all typechecks, and
documentation validation, then failed seven web contract assertions in three
files. Prompt trimming had removed existing recovery guidance, the plan tool
description exceeded its unchanged budget, and changed plugins needed stale
qualification metadata. Those regressions were corrected; the seven affected
contract suites subsequently passed all 321 checks. Integration also exposed a
Builder permission gap: Builder could not invoke the new plan actions. The
correction allows only plan actions for Builder (including the native `build`
alias), with the private host enforcing the canonical primary role before any
orchestration management action. A refused pending start now settles its native
barrier. Six focused suites passed 381 checks after these corrections.

Candidate 3's first full rerun failed three unchanged script startup/time-bound
checks while the build was active. Once the build finished, the full rerun
passed all 748 script checks with unchanged assertions. This supports resource
contention as the cause of those transient failures. The rerun has passed lint,
typechecks, and documentation validation. The harness suite then reported
536 passes, two failures, and one unhandled error. Both failed tests passed
unchanged in the isolated rerun (six assertions, 9.99 seconds). The queue test
had exceeded its deadline under load; because that test does not await its
publication after an assertion failure, fixture cleanup can interrupt its Git
work and cascade into the next test. The observed second error is consistent
with that cascade; this does not turn the failed full command into a pass.
The remaining orchestration, Cursor, Electron, desktop, and UI suites passed
separately; the UI's final group passed 3,998 tests in addition to its isolated
suite groups. Web passed 4,809 of 4,810 checks, with one timeout in an unchanged
stalled-HTTP-response test. That entire five-check transport file then passed
unchanged in 846 ms. No deadline or assertion was weakened.

`bun run build` passed for web and Electron. `bun run bundle:check` passed:
web startup assets total 4,857,897 raw bytes and 1,430,459 gzip bytes, within the
existing limits. The build retained existing third-party annotation/eval
warnings; they were not suppressed or treated as failures.

Candidate 4 repeated the production build and bundle check successfully after
all review corrections. Startup assets remain 4,857,897 raw bytes; gzip size is
1,430,461 bytes, within the existing limit. The isolated QA packager passed with
the required Bun runtime after an initial Node invocation correctly refused
before packaging. The QA app is unsigned; this is not release-signing evidence.

Candidate 4's full command then stopped at UI typechecking: the new canceled-load
regression used `expect.objectContaining`, which is absent from this repository's
local test declaration. Replacing it with an exact call-count check and the
supported `toMatchObject` preserved the assertion. The owning four tests and UI
typecheck passed. Candidate 5 freezes that test-only correction, repeats the
successful build/bundle/package checks, and retains identical runtime/UI bytes.
The final full command passed with all owned QA apps and build processes stopped.
This includes lint, all typechecks, documentation, script tests, harness (538/538),
orchestration (592/592), Cursor (163/163), Electron, desktop, UI, and web
(4,826/4,826). The UI final group passed 3,998 tests in addition to its isolated
groups. The two harness cases that failed under earlier concurrent load passed
unchanged in this run; queue acquisition completed in 7.30 seconds.

## Initial live matrix

| Case | Required evidence | Result |
| --- | --- | --- |
| A | Actual Plan toggle; overlapping cross-area Explorer reads; no edits | Partial: parallel read-only discovery passed; initial refusals were corrected, but corrected root turns did not finish within their bounded attempts |
| B | Normal-mode parallel read-only discovery | Passed on initial and candidate-3 packages with correct project/model, saved graph, parallel reads, and unchanged files |
| C | Separate bug and feature work; child-owned edits and checks after final edit | Recovered: owner edits/checks and new HTTP/restart check passed, envelopes consumed and barrier clear; original aborted tasks and one premature-continue refusal retained |
| D | Allowed scoped third check; bounded unrelated failure with no scope expansion | Recovered before the original cohort deadline: domain correction retained and new persistence/restart regression passed after its final write; original aborted task and premature-continue refusal retained |
| E | Designer-owned restyle and real visual check; disjoint mixed ownership | Partial: disjoint Designer/Fixer writes overlapped; independent 14/14 tests, real form/reload checks, and desktop/mobile visual review passed; root turn timed out |
| F | Plan then explicit Implement, including worktree; saved revisions/deviations/todos and reload | Partial/unavailable: initial Plan completed with code unchanged; helper stopped before Implement; candidate-3 retry refused before launch due insufficient credential lifetime |
| G | Sequential edits and second handoff; exact bytes and selective Undo/Redo | Passed: successive child handoffs, exact final bytes, actual footer Undo/Redo, and reconciled dispositions |
| H | Single-call server start/readiness/check/cleanup on success and failure | Required server lifecycle passed; optional browser visual verification unavailable without a configured preview runner |
| I | Isolated synthetic authentication recovery; actual credentials unchanged | Six checks passed, including direct provider-auth session.error, ordinary/Plan retry while busy, current-failure retention and reload; 11 screenshots inspected, no renderer errors or journal gaps |

Case A used root `ses_f0d79b3eaffeduMfywtmnj3Ups`. Two actual DeepSeek
Explorer children overlapped for 17.33 seconds, then an Oracle reviewed the
findings. Protected files were unchanged and children were reconciled. An
unnecessary plan read before a revision was selected and a missing optional
plan-file read prevent calling this a clean pass. Initial B/C attempts selected
the wrong registered project; they are invalid harness attempts, retained as
evidence and excluded from acceptance. Their owned processes were stopped.

The premature plan read in A also occurred in the first F attempt. The prompts
and tool description now limit saved-plan reads to an Implement-selected
revision, excluding new Plan proposals. The regression check first failed and
then passed with the unchanged prompt budgets. The candidate-3 normal-mode B
sentinel passed. The candidate-3 A attempt proved parallel read-only discovery
without the premature plan read, but waited for a valid fixture clarification
that its helper did not answer. That attempt is incomplete, not a product
failure. A bounded rerun supplied the known creation-order decision but also
reached the original cohort deadline before its root turn completed. Both
attempts retained their journals and cleaned all owned processes and profiles.

Case G used root `ses_f0d591bd7ffek2ETHL2g2y59oI`. Both successive edits were
published with exact bytes; actual footer Undo restored the original and Redo
restored the final result. Case H used root
`ses_f0d544c7affeDMDSpvfUdz84yF`. One bounded native call started the server,
observed its assigned URL, checked the API/assets, and stopped it in `finally`,
then verified the endpoint was unreachable. A separate intentional exit 7
remained a failure. Managed receipts passed, all 14 seeded tracked files matched,
and the browser lease closed. The agent correctly reported browser visual
verification as pending; HTTP asset checks are not visual evidence. Independent
grading is retained in `H-acceptance.json` beside the canonical result.

The first F Plan revision was correctly persisted under the registered project
root despite the session running in a worktree. Its version was
`11faac62b0d95c8ea7d738c23c131bb43fd3efe63ca447ce497b910b15cb987b`;
all 14 seeded files and the protected user note remained unchanged before
approval. The test helper's worktree lookup was wrong, and its cleanup removed
the private session state. This establishes Plan persistence and preapproval
safety, not live `plan_update`, Implement, revision-reload, or todo acceptance.
The retry did not launch or send any prompt. A read-only check found that the
original credential expiry had not renewed; a final read-only check after the
review corrections confirmed the same expired value. The unchanged ten-minute safety
margin was preserved. No credentials were forced to refresh or altered.

Case E's Designer/Fixer mutation calls overlapped by 9,574 ms and touched
disjoint UI and domain files. Protected notes, requirements, original tests,
manifest, and instructions remained unchanged. Independent checks submitted
the real form, reloaded the page to verify persistence, and visually inspected
1,280 × 800 and 390 × 844 screenshots with no horizontal overflow. Both children
completed and managed dispositions passed, but the root's final turn was
interrupted by the helper deadline. The agent's own browser attempt was
unavailable without a configured preview runner. E and F journals had zero gaps
and no unexpected process exits; their owned apps, preview processes, profiles,
and private credential copies were removed.

Case I's final evidence is
`.cache/qa/reliability-auth-recovery/attempt-1790776327897/result.json`.
It used the production built UI/server with an isolated HTTP/SSE fixture, no
provider calls or real credentials. Its 54 journal records had zero gaps; both
owned process audits were empty after cleanup. This direct provider-auth event
run supersedes an earlier run limited to timeout events.

## Post-implementation reviews and cleanup

Broad review round 1 started after the initial repository gates and live matrix
attempts finished. Three GPT-6.1-sol reviewers checked areas they did not
implement: saved-plan host/persistence authority; editor/OAuth/failure state;
and mutation/terminal/desktop/prompt behavior. At most three broad rounds are
permitted. One broad round was needed, followed by focused independent review
of its corrections. The completed correction batch contains:

- A stopped terminal lost its capture before a TERM/HUP-resistant child exited.
  The native reproduction failed before correction. Cleanup now retains original
  process identities, allows 500 ms for graceful termination, revalidates before
  individual escalation, and drains pending work at shutdown. Hard shutdown also
  handles owned processes in groups that cannot safely be signalled as a whole.
  Close/restart await cleanup; shutdown prevents a waiting restart from creating
  another PTY. All 21 focused checks and three native cases passed.
- A canceled legacy Plan View read could activate its next fallback after another
  chat's plan had loaded, clearing that plan and misdirecting edits. The mounted
  regression failed first; two cancellation guards preserve the current draft
  and save identity. Eighteen focused checks passed after correction.
- Managed HTTP plan access previously trusted request-supplied filename fields
  and retained the request's grant snapshot. It now binds the revision to the
  canonical session/source assistant message and reloads the authenticated
  caller's grants at admission, final read, and both locked commit boundaries.
  Project, branch, and storage root must remain unchanged. These were two P1
  findings; their isolated regressions failed before correction.
- Unrelated non-Git projects share OpenCode's `global` ID. Directory identity
  is now checked by the shared selected-revision resolver for HTTP and private
  access. Unsafe legacy candidates are skipped before considering a valid root;
  explicit mismatches fail closed. Historical Git worktree reads and canonical
  path aliases remain supported. All 141 focused authority checks passed, and
  an independent review found no remaining issue in these corrections.

No further concrete findings were identified in the mutation, OAuth, diagnostic
sanitizer, superseded-failure, Electron, or prompt/guard review areas. An
additional seeded mutation probe passed 14,400 edit/Undo/Redo invariants.
Reports and red/green evidence are retained under
`.cache/qa/reliability-review-round1/`. The unavailable live writer case remains
an explicit acceptance gap; candidate 3's B pass predates this correction batch.
The final read-only credential check found no natural renewal. No provider
substitution, forced refresh, reduced lifetime margin, or installed-app change
was used to bypass that constraint. Finishing F and the post-correction Plan
and normal sentinels requires a fresh Claude sign-in using the saved graph.

Final gate logs and source/artifact continuity evidence are under
`.cache/qa/reliability-candidate5/`; its source manifest is
`.cache/qa/reliability-candidate-5.json`. All owned live/native QA processes and
private profiles were cleaned, with sanitized journals retained and gap-checked.
The deterministic suites also completed normally. No commit or push was made.
