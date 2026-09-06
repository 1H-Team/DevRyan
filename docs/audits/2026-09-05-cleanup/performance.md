# Measurements — final candidate, September 6

The fresh typing comparison is complete. Session-memory retention and the remaining full interaction timings are **unverified** after repeated pagination prerequisites failed. Earlier resource/backend measurements retain their original applicability; the four-stream CPU and skeleton GPU reduction targets remain **failed**. No speculative optimization or persistent memory system was added to meet a target.

## Final-candidate typing

Candidate `packaged-electron-YJDmZ4` and baseline `packaged-electron-Vnc9m7` share the current backend, shell, native artifacts and archive (`0f0ebea2…`). Their served UI differs: baseline `4c713e5f…`, candidate `7cd8ff58…`. Full validation, UI/web builds, packaging and unchanged web bundle limits pass on source `3c96c656…` / scripts `5c448f72…`. Qualification receipts are in `.cache/audit/coding-agents-2026-09-05/finish-qualification-r1/`.

Six fresh runs followed B1/C1/C2/B2/B3/C3 with five seconds of warm-up, normal navigation to the exact control session, foreground admission and sixty trusted inputs at a 75 ms cadence while a background session streamed. All 360 actions passed. Every run retained its unsent draft, submitted no prompt, observed background progress and kept the correct session selected. All six original screenshots, traces, journals, browser-error buffers and retained process identities were reviewed. No build, test, provider run or peer work overlapped these measurement windows.

Values are the median of three run statistics, followed by the minimum–maximum of those three statistics. Each package has 180 input samples.

| Metric | Baseline median (range), ms | Candidate median (range), ms | Absolute change | Relative change |
|---|---:|---:|---:|---:|
| Typing p50 | 32.5 (32.5–32.6) | 32.8 (31.8–33.8) | +0.3 ms | +0.92% |
| Typing p95 | 38.5 (37.7–38.6) | 38.9 (38.4–39.0) | +0.4 ms | +1.04% |
| Frame interval p95 | 14.9 (14.9–14.9) | 15.0 (14.9–15.1) | +0.1 ms | +0.67% |

Ranges overlap: **no clear change**. No Long Tasks were observed in these six windows. These are descriptive local fixture input measurements, not compositor latency, provider latency or general application responsiveness. The complete prospective protocol, ledgers, aggregates and exact values are in `.cache/audit/coding-agents-2026-09-05/finish-performance-r1/{proposal,typing-ledger,typing-baseline-aggregate,typing-candidate-aggregate,typing-comparison}.json`. Per-run `root-review.json` receipts remain with the original `.cache/perf/*-finish-r4-typing-*` evidence.

## Session memory and remaining interactions

The approved pagination correction requires each actual Load Older click to extend contiguous page coverage and render the returned canonical message ID/text in the selected transcript; unchanged scroll height is allowed. Forty-four focused performance-helper tests pass, including rejection of HTTP-only, stale, wrong-session and absent-content evidence.

The fresh baseline at `.cache/perf/2026-09-06T04-00-34-283Z-finish-r4-memory-baseline-1/` passed artifact integrity and natural startup, then failed `fresh contiguous older history page`. Initial sixty natural samples and a separately recorded forced-GC observation exist. Loaded, inactive and deleted checkpoints do not exist. Responses returned initial 100 and older 100/100/60 rows, but the required per-click canonical-to-visible chain was not established. HTTP success alone does not resolve whether the remaining break was in the UI or verification machinery.

The two original PNGs are reviewed, four journal records have no gaps/errors, and all sixteen retained process identities are absent. The failed arm is preserved, the five remaining arms are unrun, and no aggregate or retention comparison is computed. The stopping rule prevents further helper expansion for this repeated prerequisite. Full history opening/switching/scrolling/expansion/cancellation/reconnect/navigation timings likewise remain unverified where the earlier complete interaction protocol could not pass pagination; correctness fixtures are not substituted for matched timing runs.

## Earlier measurements and applicability

The following records describe earlier candidates and failed attempts. They are preserved without pooling or relabeling. In particular, the resource comparisons predate the final Plan-authority/restoration changes and cannot qualify final-candidate resource performance. The isolated backend discovery improvement remains evidence for the unchanged package-manager detection module; it is not a renderer claim. Historical references to work running or awaiting correction describe those checkpoints only.


Earlier measurement checkpoint: `mUsL9F` and matching-backend baseline `4TOqUt` are built and qualified. The original 36-arm ledger in `post-profile-measurement-proposal-r1/proposal-r2.json` remains at eighteen passed arms, three failed arms and fifteen unrun arms: three resource comparisons completed; typing, session-memory and backend each stopped at their first failure. A separately declared six-arm backend study now passes independent review after the CPU-profile reader correction. It does not replace or pool any original arm. The fresh complete gate passes with unchanged application source `7b049793696e14d2b2d682cbd094cce037b6f139274ab98cd13768ff57c65f1d` and scripts `f57e16126a88941cdf1eba221e5056ee3645c8ca0ae839a9b75af54d2be1f927`; its receipt is `backend-cpu-normalization-r1/full-validation-receipt.json` under the audit cache.

The current resource comparisons each contain three fresh runs per side in B1/C1/C2/B2/B3/C3 order. Every arm has the same five-second warm-up, thirty-second measurement, sixty raw samples and 59 retained samples. All eighteen arms pass workload, package/source/scripts, complete-trace, journal and owned-process cleanup review. Foreground-controlled startup is not natural launch latency. Values below are medians of the three arm medians, with their minimum–maximum ranges.

| Current metric | Baseline median (range) | Candidate median (range) | Relative change | Declared limit |
|---|---:|---:|---:|---|
| One-stream renderer CPU, % | 5.2421 (5.2395–5.3222) | 5.2749 (5.1916–5.3366) | +0.63% | ≤+5%: pass |
| Four-stream renderer CPU, % | 5.2735 (5.2009–5.4581) | 5.3600 (5.3206–5.3911) | +1.64% | ≤−25%: fail |
| Four-stream renderer working set, KiB | 565,392 (560,192–684,640) | 548,400 (535,824–570,528) | −3.01% | ≤+5%: pass |
| Four-stream total working set, KiB | 1,243,920 (1,228,240–1,294,464) | 1,169,760 (1,167,440–1,186,272) | −5.96% | ≤+5%: pass |
| Plan-skeleton GPU CPU, % | 1.0607 (1.0543–1.0651) | 1.0435 (1.0321–1.0557) | −1.62% | ≤−50%: fail |

Only total app memory has separated ranges and is lower in every matched pair. The remaining ranges overlap; no repeatable CPU or GPU improvement is established. Both reduction targets remain open. Exact raw values, absolute/paired changes and receipt hashes are retained in `one-stream-comparison.json`, `four-stream-comparison.json` and `plan-skeleton-comparison.json` under the proposal cache directory. No historical observations are pooled and idle remains qualified only to its earlier source.

A bounded applicability review finds the two shipped skeleton CSS sections byte-identical (1,316 bytes, SHA-256 `f3065a84b2a04f586721f9c659b4683fa21ab4e4478a5484e8901d4526ac9f2c`); all six GPU arms show 48 spans and one running parent animation. Both shipped UIs already have the 32 ms throttle and the same whole-text Markdown block/memo structure. The −25%/−50% constants come from local release commit `0304454c2cc0746f3d45130199a92b16793a9202` (2026-08-20), which already includes those implementations; no quantitative derivation was found in the inspected records. The plain-text streams do exercise the new image guard, but this comparison does not measure introducing those earlier animation/throttle optimizations. The failed limits remain recorded. Vendor chunks also differ, so the measured memory change is not causally assigned to the guard. No further source optimization is justified by this retained evidence. See `resource-applicability-assessment.json` (SHA-256 `890636872f5edc13998028b7f9ed3ff00078ba7aba8ee1195ee4a3b277b67579`).

The original current-graph backend arm remains failed because its CPU completeness checker rejects a single −1 µs V8 time delta. The profile stopped before the cached-selection lookup, so overlap is not established. All ten owned process identities are absent, the journal has no gaps/errors, and all 567 original files remain preserved. Its remaining five arms stay unrun.

The fresh normalized-profile study `.cache/perf/web-update-check/post-profile-normalized-r2-b62Dpm/` passes all six prospective AB/BA/AB arms and independent review on the current graph. Median cold discovery falls from 3,433.05 to 3,014.56 ms (−12.19%); median per-arm maximum health latency falls from 3,386.29 to 3.00 ms. Both three-run ranges separate. Review confirms all 53 recorded process identities absent, six journal records without gaps/errors, and all 3,387 original files preserved. Exact values are in `backend-cpu-normalization-r1/fresh-study-comparison.json`; the later `independent-post-run-review.json` in the study directory completes the review marked pending in the earlier execution/comparison receipts. This measures read-only local discovery with native Node and a fixed HTTP response, not renderer or live-provider performance. No historical observations are pooled.

The first typing baseline passed startup but timed out waiting for the requested control session to become selected, before any trusted typing actions or latency collection. Its failure screenshot shows the parent session selected and an empty composer after timeout; it cannot distinguish a missed click from a later selection override. Two journal records have no gaps/errors, and all sixteen recorded process identities are absent. The block remains stopped with five unrun arms and no typing-performance result. Evidence is retained in `.cache/perf/post-profile-r1/2026-09-05T23-50-02-686Z-post-profile-r1-typing60-baseline-1/`.

A separate first-selection diagnostic at `.cache/perf/first-select-only-diagnostic-r1/2026-09-06T00-25-59-873Z-first-select-only-diagnostic-r1/` records one click call, exactly three trusted events on the requested row, and successful canonical selection. It intentionally stops before any workload or latency collection. This proves delivery in that diagnostic only; it neither identifies the earlier typing failure nor revives its stopped block. Independent cleanup confirms all sixteen recorded process identities absent (receipt SHA-256 `edd670a5079d89c8d31c7929b30847be4267f6dada6f0ba152b3fa7d43bcffdb`), and the PNG review is complete. At the 00:30 UTC checkpoint on September 6, a manual compaction representative was running and natural/broad execution was held. Its later outcome is preserved in the historical acceptance record; it established no full live-compaction acceptance.

The first session-memory baseline passed natural startup and recorded its initial sixty natural samples plus a separate forced-GC observation, then timed out at `older history commits`. No history completed the required loading gate and no loaded/inactive/deleted checkpoint exists. Both PNGs are visually reviewed; four journal records have no gaps/errors, all eighteen recorded owned identities are absent, and original evidence is preserved. The block remains failed with five unrun arms and no retention comparison. Its closure and root visual review are under `.cache/perf/post-profile-r1/2026-09-05T23-55-41-066Z-post-profile-r1-session-memory-baseline-1/`.

Primary reducer metric: per-event execution time, excluding React, network, and provider work. Three fresh Bun 1.3.14 processes per variant; each scenario has 10 warm-up batches and 50 measured batches of 100 events. Histories, event generation, and benchmark code were identical. Run medians and their min/max range appear below. Smaller is better. An asterisk means the ranges overlap: no clear improvement claim for that scenario.

| Sessions / history / event | Before median (range), µs/event | After median (range), µs/event | Change |
|---|---:|---:|---:|
| 1 / 50 / delta | 0.80 (0.80–0.84) | 0.46 (0.40–0.68) | -42.5% |
| 1 / 50 / snapshot | 1.11 (1.11–1.12) | 0.68 (0.64–0.69) | -38.7% |
| 1 / 500 / delta | 5.09 (4.90–5.28) | 3.33 (2.13–3.39) | -34.5% |
| 1 / 500 / snapshot | 6.53 (6.45–6.76) | 1.91 (1.74–1.99) | -70.8% |
| 1 / 2000 / delta | 23.76 (23.74–23.91) | 7.00 (6.90–8.44) | -70.5% |
| 1 / 2000 / snapshot | 30.07 (29.03–31.55) | 7.23 (6.81–9.15) | -76.0% |
| 4 / 50 / delta | 0.90 (0.88–0.93) | 0.53 (0.53–0.54) | -41.0% |
| 4 / 50 / snapshot | 1.11 (1.07–1.13) | 0.49 (0.47–0.50) | -55.6% |
| 4 / 500 / delta | 4.61 (4.39–4.68) | 2.17 (2.09–2.29) | -52.8% |
| 4 / 500 / snapshot | 6.40 (6.05–6.40) | 2.03 (1.93–2.08) | -68.2% |
| 4 / 2000 / delta | 19.66 (19.01–19.87) | 8.58 (7.64–9.22) | -56.4% |
| 4 / 2000 / snapshot | 30.79 (30.49–30.90) | 7.41 (6.79–7.67) | -75.9% |

These are reducer microbenchmarks, not measured interaction latency or whole-app CPU savings. The selected change removes repeated history scans without changing reducers' event semantics. Existing 75 reducer behavioral tests passed. Host background activity was not controlled; concurrent repository work also prevents treating HEAD alone as the complete candidate identity. Raw before/after JSON is in `.cache/audit/devryan-2026-09-05/reducer-{before,after}-{1,2,3}.json`; reviewed aggregates are in `measurements.json`. No historical Electron feature-specific CPU target was applied.

The control-copy audit's primary metric was peak resident memory. Three fresh `/usr/bin/time -l bun test packages/ui/src/lib/i18n/messages/controlCopy.test.ts` runs per variant measured:

| Metric | Before runs | After runs |
|---|---|---|
| Peak RSS, MiB | 408.61, 409.86, 404.97 | 193.94, 250.98, 213.03 |
| Wall time, seconds | 1.08, 1.61, 1.94 | 4.83, 3.92, 3.75 |

Peak RSS median fell from 408.61 to 213.03 MiB (−47.9%); ranges are separated. Elapsed time regressed in these runs; this is a memory improvement only, with a latency tradeoff under observed load. Both title-case checks still run over every candidate source; only findings survive between tests. All six assertions passed in every isolated run. Raw `copy-before/after-*.log` files retain macOS time output. The prior full-suite timeout is recorded separately and is not claimed fixed until the full gate passes.

The preceding measurements belong to the initial cleanup batch. Its web startup graph was 5,048,720 raw / 1,481,202 gzip bytes against unchanged 4,962,877 / 1,456,388 limits; concurrent SDK/version edits prevented attribution of that overage to this batch. The subsequent source-isolated bundle correction and current passing web graph are recorded in [startup-bundle.md](startup-bundle.md) and [Coding Agents acceptance](coding-agents-acceptance.md).

The original R5 packaged whole-app study has 42 planned members: six interactive runs, 24 resource runs, six memory-lifecycle runs and six source-isolated backend update-check runs. Its first baseline interactive member finishes 63 actions and fails the third older-history page's height-growth/anchor-presence predicate. The trusted click and successful HTTP response are recorded, but the predicate operands are unavailable; the later 2 px correctness check did not run. That original recording alone cannot distinguish UI failure from measurement defect. Its complete trace, gap-free journal, reviewed images and clean owned-process closure are retained under `.cache/perf/2026-09-05T14-32-15-225Z-final-interactive-r5-baseline-1/`.

Two separate diagnostic attempts stop before workload because the document remains hidden; a single acknowledged CDP foreground command in the second does not change that state. A third separate diagnostic starts without any foreground intervention and reproduces the pagination failure: 149 subsequent samples show the visible selected transcript collapsed from 50 message elements and 8,548 px to two elements and 641 px, with its saved anchor absent, after an HTTP 200 response containing 200 history rows. This demonstrates a baseline rendering failure, with no claim of canonical-store data loss or a proven internal mechanism. These observed samples do not reconstruct the original member's missing operands and their added reads perturb timing. All diagnostic outcomes remain separate.

After the diagnostic closure review, the original sequence resumed without instrumentation. Baseline 2 also passed startup and 63 actions before the same page-3 timeout. Its two reviewed images, complete trace, ten gap-free journal records and absence of all 31 recorded owned processes are retained in `.cache/perf/2026-09-05T16-05-04-397Z-final-interactive-r5-baseline-2/closure-review.json`. This original recording also lacks the predicate operands.

Original baseline 3 failed native startup before entering the workload. The final saved document is complete but hidden, with controls and the fixture model/catalog ready. Sparse saved snapshots do not establish native-window state or explain the hidden document. Its sole PNG and three gap-free journal records are reviewed; interactive and trace artifacts were never created. Cleanup escalated to SIGKILL, followed by confirmed absence of all 24 owned identities. Its evidence remains in `.cache/perf/2026-09-05T16-16-07-287Z-final-interactive-r5-baseline-3/closure-review.json`.

The declared stopping rule leaves the remaining 39 R5 members unrun. All three failed attempts remain in the original cohort; none is replaced. The exact references are retained in `.cache/audit/coding-agents-2026-09-05/final-interactive-r5-cohort-summary.json`, with `completeComparison=false` and no aggregate invocation. No complete interactive aggregate, baseline/candidate comparison or whole-app CPU improvement is claimed. Resource and memory admission was not satisfied because no candidate interactive member ran.

## Foreground resource cohort

The separately declared foreground cohort ran on the frozen Q1gHWd candidate and ev6WR8 baseline on 2026-09-05, 21:22–21:47 UTC. Both packages have the same backend, shell and native artifacts; their served UI differs. Each completed scenario used the prospective B1/C1/C2/B2/B3/C3 order, a five-second warm-up, thirty-second measurement and unchanged 500 ms sampling. Sixty samples were captured per arm; the first was discarded, leaving 59. Foreground acknowledgement and observed visibility were required before admission. Provider runs, builds and repository edits were held during measurement.

The original proposal permits comparison of a complete six-arm scenario. Idle, one-stream and four-stream each qualify with three fresh observations per side. Values below are the median of each arm's median, followed by the minimum–maximum of those three arm medians. CPU absolute changes are percentage points; memory changes are KiB.

| Metric | Baseline median (range) | Candidate median (range) | Absolute change | Relative change | Original gate |
|---|---:|---:|---:|---:|---|
| Idle renderer CPU, % | 0.0994 (0.0935–0.1096) | 0.0917 (0.0802–0.1081) | -0.0078 | -7.81% | ≤+5%: pass |
| One-stream renderer CPU, % | 5.1456 (4.9350–5.2731) | 5.3185 (5.2088–5.3647) | +0.1729 | +3.36% | ≤+5%: pass |
| Four-stream renderer CPU, % | 5.4313 (5.3188–5.5454) | 5.3693 (5.3497–5.5588) | -0.0620 | -1.14% | ≤-25%: fail |
| Four-stream renderer working set, KiB | 566,576 (551,936–577,136) | 572,816 (571,648–581,664) | +6,240 | +1.10% | ≤+5%: pass |
| Four-stream total working set, KiB | 1,197,760 (1,184,304–1,208,160) | 1,212,336 (1,205,712–1,214,880) | +14,576 | +1.22% | ≤+5%: pass |

All five ranges overlap. The four passing limits demonstrate bounded regression under this workload; none establishes a clear improvement. Four-stream CPU misses its declared 25% reduction target. The first GPU plan-skeleton baseline failed before warm-up or measurement: after navigation, injection called appendChild on a null document.body. Its failure image shows the DevRyan starting screen later, without establishing the exact injection-time DOM. The ledger remains stopped at 18 passed, one failed and five unrun; GPU has no comparison. A subsequent navigation-readiness correction requires its own qualified protocol and fresh GPU observations.

Independent closure preserves 296 original evidence files, parses 49 journal chunks containing 296 records with zero gaps, errors or parse failures, and verifies all 407 recorded process identities absent. Eighteen complete trace receipts cover 16,052,323 events. Inactive isolated profiles remain retained as evidence. This is resource evidence only; interactive responsiveness and memory after sessions close remain unmeasured. Exact raw values, source/package/protocol pins and run references are in `.cache/audit/coding-agents-2026-09-05/foreground-resource-r1/completed-scenario-comparison.json`; closure is in `cohort-closure-review.json` (SHA-256 `e8fdad0c1a35c13a5b8b67c370ffcf29934056b934beee928e67726ebcee053a`).

A bounded inspection of the median four-stream CPU arms (baseline 3 and candidate 1) finds similar inclusive React scheduler boundaries, layout and paint work. Event-pipeline flush and socket-message callbacks also remain nearly unchanged. Neither trace contains CPU samples or JS call stacks that identify a responsible reducer, selector or component, so this evidence does not justify another source optimization. Inclusive trace durations overlap and must not be added as self CPU time. Exact trace hashes and shipped bundle/source locations are retained in `foreground-resource-r1/four-stream-attribution-review.json` (SHA-256 `e9122ad2350bd63a0491dcdeb65845ade33bb1f75d9dab8cf30ff964bf618ffc`).

## CPU attribution and image-extractor fast path

One separately declared candidate-only profile reused the four-stream workload with 5 seconds of warm-up and one 30-second capture. Independent closure verifies the exact candidate/foreground/workload pins, one profiler start/stop/disable sequence, 37 gap-free/error-free journal records, a complete 1,309,530-event trace, and all 25 recorded process identities absent. Every metric from this instrumented run remains diagnostic.

The raw CPU profile contains 42,163 samples, including 4,966 negative time deltas. Attribution preserves those bytes and follows [Chromium DevTools' timestamp/sample sorting and final-interval normalization](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/models/cpu_profile/CPUProfileDataModel.ts). The resulting 30,004.818 ms coverage includes 18,388.720 ms idle, 8,796.290 ms unresolved program samples, 155.152 ms GC and 2,664.656 ms other sampled frames. No heuristic reassigns unresolved samples to JavaScript. The React-to-Markdown parse stack accounts for 1,709.551 ms inclusive, but existing block memoization and a 32 ms display throttle make a parser replacement unjustified by this one profile. Image extraction accounts for a separate 142.078 ms inclusive; its code-masking leaf accounts for 109.751 ms self. Inclusive stack times must not be added. Exact normalization, bundle/source coordinates and hashes are retained in `four-stream-profile-r1/attribution.json` (SHA-256 `037547624510ff765f62dc7b31c99260ac87a6cbc2a82a0a8e271ec638252bf8`).

The supported image-reference grammar requires a literal opening bracket. A one-line guard now skips masking and scanning inputs without it. All 14 focused behavioral tests pass, including existing image forms, Unicode/code, bare HTML and paths, and independent source canonicalization. The prospectively declared function benchmark uses three fresh Node processes per version in B1/C1/C2/B2/B3/C3 order, four fixed inputs, 100 warm-up calls and 1,000 measured calls per input/process. Other agent tools/checks were held throughout the measurement. Values below are median process means and their minimum–maximum, in microseconds per extraction call.

| No-image input | Before, µs/call (range) | After, µs/call (range) | Change |
|---|---:|---:|---:|
| fixture-parent-1k | 19.124 (19.005–19.153) | 0.088 (0.084–0.092) | -99.54% |
| fixture-parent-8k | 148.207 (147.163–149.923) | 0.464 (0.416–0.466) | -99.69% |
| prose-32k | 564.709 (558.609–571.086) | 0.599 (0.589–0.614) | -99.89% |
| unicode-code-8k | 210.027 (209.505–214.271) | 0.338 (0.327–0.338) | -99.84% |

All ranges separate. These are repeated-input function measurements, including their JIT/warm-up conditions, and establish removal of impossible scans only. They do not imply comparable renderer or whole-app savings, or meet the 25% four-stream CPU target. Raw six-process values, process CPU supplements and standard deviations remain in `assistant-image-guard-r1/benchmark-summary.json`; protocol SHA-256 is `5091c5365e6909a7f584c96bfacf65573c521f064571fd0cc63ba0c58cd6d27f`. Fresh integrated validation and the affected resource/backend comparisons are recorded above; typing and memory-retention comparisons remain unavailable.
