# Harness optimization implementation and verification

Date: 2026-09-10. Baseline: `fd84dda2e99f0afd679147a466a1c6dcf211d707`.

The P0–P5 implementation is present. Optional read overlap, wait-any, compact results and context projection remain **off by default**. Native acceptance is incomplete, so none qualifies for promotion or a claimed performance improvement. Contracts, compatibility and rollback are documented in [HARNESS_OPTIMIZATION.md](../HARNESS_OPTIMIZATION.md).

## Implementation coverage

| Phase | Delivered behavior | Evidence and limits |
| --- | --- | --- |
| P0 | Maintained packaged standard roles replace stale project prompt copies; project guidance, explicit selections and Council model companions remain. Run fingerprints distinguish configuration from observed plugin loads. Managed automatic wakes share the existing continuation owner. | Migration, fingerprint, competing-hook and synthetic-anchor contracts pass. Isolated native preflight observed the requested seven role/model/effort assignments and OpenCode 1.18.30. The user's running installation was not restarted. |
| P1 | Bounded dispatch briefs, single-agent guidance for coherent work, uncapped independent children, actionable tool corrections and stable prompt sections. | The 30-case golden catalog passes. Retained native read evidence includes six successful image reads in the manual journey and three in the natural journey. Prompt ablation is prepared but not promoted without paired live trials. |
| P2 | Host-owned retrieval allowlist, durable root-scoped `wait_any`, committed-envelope delivery, claimed collection wakes, provisional read identities and fresh existing-target writes. | Wait ordering, persistence, restart, 30-child uncapped scheduling, subscription cleanup, scope isolation and stale-write contracts pass. The native integration journeys enabled all four flags together; they are not one-factor comparisons. |
| P3 | Versioned canonical result headers, final-content-bound required checks, bounded task checkpoints, project decisions with provenance, exact duplicate observation projection and native compaction context. | Golden and contract coverage passes, including passed-then-edited checks and task/project isolation. Two manual native boundaries passed; the second natural boundary remains unverified. No summarization service or memory database was added. |
| P4 | Durable real-user objective identity, separate result delivery and repair accounting, authoritative progress, bounded deterministic rejection cycles and shared recovery causes. | Recovery and ownership contracts pass. Existing role deadlines and Designer/Fixer 150-plus-20 safeguards remain. Broad semantic stagnation remains report-only. |
| P5 | Bounded structural diagnostics, unknown-preserving timing/usage, repetition aggregation, retention reasons, scoped Chrome Trace export and paired evaluation admission. | Export/sanitizer tests exercise the actual sanitized managed-task shape. Historical events with discarded ownership cannot retrospectively prove root scope. No missing measurement is replaced with zero or fabricated attribution. |

No dependencies, external runtime, sidecar, personal memory, upstream checkout or launch cap were added. Project provider/MCP/LSP configuration and configured model routes were preserved.

## Follow-up implementation review

At the user's request, Claude reviewed the working implementation through the Claude desktop app. The review was read-only and limited to this repository. Successive exchanges challenged findings against actual ownership, transition and persistence code, then rechecked concrete corrections. This was an implementation review, not independent live-provider acceptance.

In the sixth exchange, Claude reported no remaining confirmed correctness defect in the changed code. It explicitly verified the Builder reset rule, retryable capability negotiation and cursor parsing, and classified broad outage fencing, durable continuation spending and rereads after own writes as documented conservative behavior. That conclusion is limited to source review; it does not replace the validation and native gates below.

| Finding | Correction and evidence |
| --- | --- |
| A late check completion could overwrite a newer invocation; unavailable canonical identity could preserve an old pass. | The scheduler atomically reserves all names matched by one command before execution, binds canonical identity separately and completes only the current call/message group. Conflicting identity, wrong workdir and lost pre-execution hashes remain unverified. Regression tests reproduced the ordering, identity/workdir and grouped-save failures before correction. |
| Unchanged attention returned repeatedly from `wait_any`; same-envelope changes and selection changes needed durable cursor semantics. | Version-2 cursors bind the exact selected set and existing durable envelope sequence. Meaningful collection changes wake; rescheduling and an own `continue` do not create empty wakes. Tests cover restart, retry follow-ups, other ready root tasks and shrinking a 500-task selection. Host-projected manual-recovery authority removes current-host classifier disagreement. |
| A compact header could hide the child's blocked report or permit disposition before reading uncertain detail. | Non-authoritative retained-child terminal markers remain separate from canonical outcome. Incomplete, blocked, ambiguous, partial or unverified headers require every retained detail page. Complete verified headers retain selective retrieval. Parser and actual plugin paging tests cover both paths. |
| Automatic checkpoint injection and newest-observation references changed earlier provider prompt content. | Removed the per-request checkpoint RPC/system suffix. Explicit checkpoint retrieval and native compaction carry bounded context and labelled headroom. Duplicate projection retains the first exact observation; append-prefix and two-boundary compaction contracts pass. This establishes stable projection behavior, not a measured provider cache-hit improvement. |
| Managed Builder continuation had lost the old stagnation guard. | Current TODOs must match a completed native write since the real-user anchor. Existing durable ownership stores hashes, stagnation and qualifying progress watermarks. A further review regression proved changing generic tool output could evade stagnation; such output no longer resets the guard. All 86 recovery-controller tests pass, including persistence and verified artifact progress. |
| Failed capability negotiation could disable check observation until restart, while later reservation failures fenced commands. | Failed negotiation is retried; unknown policy and malformed or unavailable reservations report `managed_check_observer_unavailable` before native bash executes. Explicit disabled policy remains inert. The 13 context-plugin tests pass, including outage/recovery. |
| Authentication and missing objective ownership were hard to distinguish; cost provenance overstated its source. | Safe bridge-authentication and missing-owner diagnostics name the recovery action. Runtime-reported cost is labelled `native-runtime-reported`, without a provider-billing claim. Historical trace-label input remains accepted by evaluation reporting. |

The review withdrew suspected lease rotation and task-only terminal mutation after source inspection: leases are assigned at admission, and terminal records are immutable. Retaining a fresh read after one's own write is a conservative contract, not a confirmed safety defect; merely sampling unknown post-write bytes would not safely remove that requirement.

Documented tradeoffs remain: unavailable bridge authority fences bash broadly; old roots without a retained objective need a new real user instruction; the Builder guard uses the real-user anchor, a twelve-continuation objective budget and durable reservations that are not refunded on uncertain delivery. Actual pinned-runtime TODO normalization and hook ordering were not independently exercised by this follow-up. The generated SDK requires TODO priority, but that alone is not a live-tool normalization test.

Retained native R2 journal records establish that canonical `metadata.exit` values of zero and one were observed: three passing and one failing required-check completion. Their source hashes and identities are recorded in `.cache/qa/harness-review-native-check-evidence.json`. They precede these corrections and do not prove post-review native acceptance.

The first broad follow-up validation encountered the newly added noisy-output regression while its correction was in progress; `.cache/qa/harness-review-validation-full-r1.log` retains that failure. The focused corrected suite and complete rerun subsequently passed. No failure was suppressed or relabelled.

| Follow-up gate | Result | Retained evidence |
| --- | --- | --- |
| `bun run validate:full` on the corrected source | Passed, including all workspace lint, type checks and deterministic suites; the final web stage passed 4,035 tests across 379 files | `.cache/qa/harness-review-validation-full-r2.log` |
| `bun run build` | Passed | `.cache/qa/harness-review-build.log` |
| `bun run bundle:check` | Passed | `.cache/qa/harness-review-bundle-check.log` |
| Fresh isolated macOS arm64 Electron package and native SQLite/PTY smoke | Passed | `.cache/qa/packaged-electron-u1kbXU/package-evidence.json` |
| Documentation validation and `git diff --check` | Passed; documentation retains existing historical-plan reference warnings | `.cache/qa/harness-review-docs.log`, `.cache/qa/harness-review-diff-check.log` |

The fresh package records source hash `e5e648f1ea7f43352e43782ac6d1685895c32fe5b9731c8672c6ca4cf256de7c` and archive hash `116df6275cfdb08f19dbfa0579b524332b826d10d3e3dca1a9112b70f5f6f2eb`. All 4,362 recorded source entries match the current files. Packaging used matching repository-local Electron native binaries without rebuilding the web dependency tree. Its owned smoke process exited; signing, notarization, publication and full native provider journeys were not run in this follow-up.

`.cache/qa/harness-review-evidence.json` records the current package identity, gate and regression-log hashes, default policy values, source comparison and completed smoke cleanup. Earlier failing attempts remain retained. It explicitly separates pre-review visual/native/performance evidence from the follow-up's source, deterministic and packaging checks.

## Pre-review implementation gates

| Gate | Result | Retained evidence |
| --- | --- | --- |
| `bun run validate:full` before the Claude follow-up | Passed | `.cache/qa/harness-validation-final-r4.log` |
| `bun run validate:quick` after the monotonic QA idle-wait correction | Passed | `.cache/qa/harness-qa-clock-quick.log` |
| `bun run build` | Passed | `.cache/qa/harness-build-final-r3.log` |
| `bun run bundle:check` | Passed | `.cache/qa/harness-bundle-check-final-r2.log` |
| `bun run docs:validate` | Passed, with warnings about source references in historical plans | `.cache/qa/harness-docs-final.log` |
| Packaged macOS arm64 Electron, SQLite and PTY native smoke | Passed | `.cache/qa/packaged-electron-gRxI5p/package-evidence.json` |
| Deterministic golden evaluation | 30 cases passed | `.cache/qa/harness-golden-reports/devryan-agent-eval-eval-20260910162849-60ce9db8da6f.json` |
| QA/history/lifecycle contracts | Passed | `.cache/qa/harness-qa-contracts-final-r3.log`, `.cache/qa/harness-perf-protocol-final.log` |
| Signing, notarization, publication and other platforms | Not run | The local package explicitly excludes these acceptance claims. |

The pre-review package records source hash `4ff2e195b488384de2df640a14b98b177e669510cb2d4ca8da6a152bf55999f1` and archive hash `9ebdba9d380c0ca80cdf471729f6278a3b62081a9ccd16a58d7fa6b2fa386dc2`. Native R2 used the earlier recorded package and source fingerprint; the subsequent trace sanitization correction is covered by those local gates and packaging, not retrospectively by native runs. The visual captures, native journeys and matched benchmark trials below are pre-review evidence; they have not been relabelled as acceptance of the follow-up corrections.

An earlier full run hit an unchanged preview Vitest coalescing test (`expected 2, received 3`). The same 19-test file passed immediately without edits, followed by a passing complete run. The original failure remains in `.cache/qa/harness-validation-final-r2.log`; no assertion was suppressed.

## Web, Electron and responsive verification

| Journey | Final available result | Evidence directory |
| --- | --- | --- |
| Desktop web core | 26 checks passed | `.cache/qa/harness-fixture-r3/web-core-core-journey-1` |
| Electron core | 26 checks passed | `.cache/qa/harness-fixture-r5/electron-core-core-journey-1` |
| Actual Electron 800×800 native frame | 27 checks passed | `.cache/qa/harness-fixture-r4/electron-narrow-800-core-journey-1` |
| Responsive web, 390×844, 844×390 and 768×1024, light/dark | 40 checks passed | `.cache/qa/harness-fixture-r4/web-mobile-mobile-1` |
| Actual Electron 600×800 native frame | Unavailable below the existing 800×520 minimum | `.cache/qa/harness-fixture-r4/electron-minimum-600-core-journey-1` |

The 600-pixel request was measured through the owned Electron main process. Its evidence records `minimum: [800, 520]`, the rejected requested bounds and the unchanged actual frame. A 600-pixel emulated content viewport is not reported as a 600-pixel native window. Changing the product's minimum is a separate behavior decision.

The final core journeys establish canonical reconnect recovery, cancellation, missing-event reconciliation, permission denial, failed-tool recovery, draft/session isolation, thinking selection, older-history loading and mounted/virtualized Plan restoration. Fixture compaction records establish UI restoration, not native model compaction.

Earlier fixture failures remain under `.cache/qa/harness-fixture-final`, `harness-fixture-core-r2`, `harness-fixture-r3` and `harness-fixture-r4`. Diagnosed QA corrections were explicit thinking-control selection, canonical Plan/child identity, trusted wheel events targeting the outer history scroller, real native-window control and a monotonic full ten-second idle wait. The affected journeys were rerun. Product state was not fabricated to satisfy the witnesses.

All **447 captured checkpoint PNGs** were individually inspected: 401 in `.cache/qa/harness-visual-r3-review.json`, 32 in `.cache/qa/harness-qa-visual-review.json` and 14 in `.cache/qa/harness-history-visual-review.json`. Each entry retains its SHA-256, observation, verdict and checklist. The final inventory check found no missing review, duplicate path or changed image across the task's evidence directories; 28 copies of the fixture's input reference image are identified separately from captured checkpoints. Failed checkpoints retain their functional failure even when the visible layout is intact. Static images do not establish focus persistence or live behavior without the associated interaction assertions.

Final evidence closure is recorded in `.cache/qa/harness-final-evidence-closure.json`. All twelve matched benchmark trials recorded stopped owned apps, closed fixtures and no cleanup errors or remaining owned processes; the final process-identity check found none still running. QA runner profiles were removed, including the copied native authorization. Retained fixture-only performance profiles contain empty credential maps. Failed trials and raw measurement artifacts remain available.

## Native model acceptance and rollout blockers

The configured baseline was preserved: Orchestrator Astra medium, Oracle Astra high, Builder/Fixer Grok 4.6 high, Designer Opus 5 medium, Explorer/Librarian DeepSeek V4 Flash high and Council Sol medium. Preflight verified advertised models and efforts before the native R2 cells. Both R2 cells recorded all four optional flags enabled, so their results establish combined integration coverage only.

The live all-flags-off independent-child control passed with three managed specialists. Its retained report is `.cache/qa/harness-live-evals-final/devryan-agent-eval-eval-20260910172839-d601635061b9.json`. Its old report's runtime version is `unknown` because the report validator rejected numeric-leading versions; that validator and its regression were corrected. The historical report remains unchanged.

| Native journey | Result | What passed and what failed |
| --- | --- | --- |
| Manual R2 | Failed final application acceptance; 19 prior checks passed | Both manual boundaries, reload/exit continuity, pause/revision/current-plan approval, resumed implementation and canonical task dispositions passed. Independent browser verification passed creation order, priorities, filtering and the all-active summary, then rejected High's exact reference color. Generated High was `#dc2626` instead of `#b91c1c`; Normal also differed (`#d97706` instead of `#a16207`). The generated project and strict grader were not altered. |
| Natural R2 | Failed before the second boundary; 14 prior checks passed | The first native automatic boundary crossed the unmodified model threshold, preserved continuity and collected the child after restart. Before the second workload, a legitimate claimed collection turn still occupied the composer; the driver's fixed 30-second Send wait expired. Journal evidence shows collection activity, not proven duplicate execution. The driver now preserves the draft and waits within the existing cell deadline. This correction has not passed a fresh complete native journey. |

Manual evidence: `.cache/qa/harness-native-manual-r2/astra-orchestrator-manual-compaction-manual-1/astra-orchestrator-manual-compaction-manual-1-2jz3a8/result.json`. Natural evidence: `.cache/qa/harness-native-natural-r2/astra-orchestrator-natural-compaction-natural-1/astra-orchestrator-natural-compaction-natural-1-Ft6xef/result.json`. Their diagnostic journals were inspected before diagnosis and the journal gap command passed for each. Both runners recorded no cleanup errors or remaining owned processes.

Fresh isolated admission at 18:38:47 UTC found that the copied Anthropic authorization expired at 18:49:20 UTC and could not cover a new 45-minute cell plus the required ten-minute margin. Other available providers were not labelled unavailable. No credential was refreshed, timeout shortened or model substituted. Evidence is retained in `.cache/qa/harness-native-admission-r2.log` and its referenced report.

The [QA native admission prerequisite](../QA.md) requires passing manual and natural journeys before the broad live matrix. Therefore three-pair flag/role trials and any disagreement expansion were **not run because the prerequisite failed**. They are not passes, model-unavailability claims or evidence of no regression. All four flags remain off; the optional role trim remains an unpromoted candidate.

## Performance and diagnostic interpretation

The long-history witness now proves canonical IDs are loaded and their numbered content is visibly reached through trusted scrolling before lifecycle measurements qualify. Fixture replay, process retention and input latency remain distinct from live model efficiency.

Matched whole-package trials are recorded under `.cache/perf/harness-matched-final/cohort.json`: three trials per arm in B1/C1/C2/B2/B3/C3 order, fresh owned profiles and five-second warmup, with all four optional flags off. Typing uses 60 trusted input events while one background stream in another session advances; it has no duration-based measurement window. Memory uses 30-second sampling windows. The candidate is the final package above; the baseline is the preserved baseline commit's package. Source, archive and protocol identities are retained for every arm.

All six typing trials passed exact draft, no-submit, selected-session, advancing-stream and startup checks. The workload, display, Chromium and protocol identities matched. The three per-run latency distributions overlap:

| Typing measurement, milliseconds | Baseline median (range of three runs) | Candidate median (range of three runs) |
| --- | --- | --- |
| Per-run p50 | 38.7 (38.3–41.4) | 41.2 (39.5–42.0) |
| Per-run p95 | 46.7 (45.8–49.6) | 47.3 (46.2–49.7) |

Both arms recorded zero long tasks in these captures. These are input action measurements, not provider or compositor latency. There is no demonstrated typing improvement. Raw evidence, three-run aggregates and the actual comparison rejection are retained in `.cache/perf/harness-matched-final/typing-report.json`.

The existing strict UI-only comparator rejected the aggregates with `Interactive comparison requires matching packaged backendSha256`. This full harness change intentionally changes backend and shell artifacts, so its raw whole-package measurements cannot establish an isolated UI optimization or a benefit from the disabled flags. The original hashes and rejection are preserved. Missing, failed or unmatched measurements remain inconclusive.

All six memory journeys also passed first-document startup, canonical history coverage, visible history witnesses, archive/delete outcomes and owned-process cleanup. Each loaded four histories of 180 turns, including 360 canonical messages per history, and visibly reached the oldest numbered response. Each checkpoint has 60 natural samples over 30 seconds after a six-second settle, followed by one separately labelled forced-GC point. The lifecycle comparator accepted the matching fixture, protocol, Chromium, visible display and sampling conditions; it reports descriptive deltas without acceptance thresholds. All three repetitions per arm are retained in `.cache/perf/harness-matched-final/memory-report.json` with raw artifact paths and hashes.

| Memory measurement, MiB | Baseline median (range of three runs) | Candidate median (range of three runs) |
| --- | --- | --- |
| Loaded: natural renderer working set | 413.53 (390.73–414.64) | 401.52 (392.41–416.30) |
| Inactive: natural renderer working set | 418.83 (396.38–420.62) | 407.45 (399.47–420.56) |
| Deleted: natural renderer working set | 420.09 (398.03–425.75) | 408.75 (405.20–421.25) |
| Loaded: heap after forced GC | 38.90 (38.90–38.92) | 38.97 (38.95–39.68) |
| Inactive: heap after forced GC | 35.23 (35.22–35.23) | 35.26 (35.23–35.29) |
| Deleted: heap after forced GC | 35.10 (35.10–35.11) | 35.14 (35.10–35.14) |

The natural working-set ranges overlap, and the post-GC retained heap is nearly identical. After deletion, both arms have no owned history sessions in the cache and 19,515 DOM nodes at the recorded GC point. Heap remains above each run's initial GC point by a median 5.78 MiB for baseline and 5.81 MiB for candidate; this does not establish a leak or a retention improvement. Natural sampling and forced-GC points are not combined into one metric. Memory-cohort startup medians were 5,399 ms (5,316–5,733) and 5,565 ms (5,250–5,604), also overlapping. No startup or memory improvement is claimed, and these fixture results do not qualify any disabled policy for promotion.

Retained old unscoped journal events expose three children with nine milliseconds of summed queue time, 11,240 milliseconds of summed first activity and 57,875 milliseconds of summed result-consumption delay. These are neither critical-path totals nor a paired performance result. Their historical sanitizer discarded ownership; the new scoped exporter correctly leaves those timings unavailable rather than guessing scope. See `.cache/qa/harness-retained-trace-check.json` and the final sanitizer/export regression tests.

## Remaining acceptance

For rollout, repeat complete manual/natural native journeys when the configured providers satisfy admission, then run the one-factor paired cases and expand any disagreements to ten pairs. Keep optional policies disabled until their targeted waste decreases without a failed invariant or outcome regression. Local fixture and performance observations do not replace these native gates.
