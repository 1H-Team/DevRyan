# Ledger preparation profiling

The retained journal's 72.2-second preparation and its separate 45.4-second,
99-commit preparation are distinct observations. These fixtures measure current
source and do not reconstruct either historical session. In particular, a
generic confined write does not identify the cause of the historical bash stall,
and 99 prior operations are not equivalent to 99 commits inside one preparation.

## Historical incident correlation

A final read-only journal recheck on 27 September found 13,826 retained records;
`bun scripts/journal.mjs gaps --verify` completed without gaps. This is a later
snapshot than the plan's 13,822 records. The following correlation uses matching
session, assistant-message, and call identities, and bounded surrounding records.
Raw commands and prompts are not reproduced here. Both incidents precede the
v1.2.17 release and are historical evidence, not reproductions of this patch.

| Incident | Tool | Preparation | Reconciliation | Ledger commit methods | Queue wait |
| --- | --- | ---: | ---: | ---: | ---: |
| 08:54:37.268 UTC preparation completion | `devryan_browser` | 45.421 s | 40.077 s | 99 / 27.070 s | 99 / 1 ms |
| 09:21:42.126 UTC preparation completion | `bash` | 72.224 s | 0.922 s | 2 / 0.595 s | 2 / 0 ms |

Dates are 27 September 2026. Durations come from recorded `elapsedMs` and
admission `steps`, not subtraction of journal timestamps. The commit and queue
columns show count / summed elapsed work. Nested phase totals are not additive.

The 45.421-second event belongs to session
`ses_f1dee8400ffewB15R9a43eY5ho`, assistant message
`msg_0e211eb83001lLAP0ojA65JLqP`, call `call_NZbzAgJf14dsmTPS3BoyB05V`.
Its preparation summary also records 99 ledger opens / 0.982 s, 99 recoveries /
0.880 s, and 99 transactions / 7.111 s. The tool completed at 08:54:40.770 UTC.
This establishes a reconciliation-heavy preparation with repeated ledger
commits; it does not establish why that historical file/history state required
99 commits. The 24 current fixtures reproduce expensive cold reconciliation,
but their preparations have only two to nine commit-method calls. They therefore
do not reproduce the historical commit-heavy shape.

The 72.224-second event belongs to session
`ses_f1de86395ffejx9QbaFyNzVBgU`, assistant message
`msg_0e22a15f0001531YizzTPKTG5v`, call `call_XzxAagsHzvX4SyqIsVBJvC2P`.
Its preparation summary also records two ledger opens / 0.087 s, two recoveries /
0.056 s, and two transactions / 0.847 s. The tool completed at 09:21:59.753 UTC.
Unlike the 45.421-second incident, reconciliation and ledger work account for
little of this preparation. The current cold fixture's reconciliation hotspot
therefore does not explain this incident. Copying or other preparation work is
an unverified candidate, not an established cause.

The correlated historical records contain no copy counts, copy duration, Git
subcommand timings, or a breakdown of the remaining preparation work. The
bounded surrounding `session.changes.updated` records contain only session
identities, and the recorded `session.diff` arrays are empty; neither provides
the preparation's file/history inventory. Reconstructing the two historical
inputs and attributing those missing subphases remain unresolved. No additional
trials or production policy changes were made from this correlation.

## Method

Run from the repository root:

```sh
node scripts/perf/ledger-benchmark.mjs --profile --companion --iterations 3 \
  --timeout-ms 300000 --out .cache/perf/ledger-preparation-profile.json
```

Each of four cases receives three fresh worker processes, separately for direct
ledger calls and the verified repository companion using the existing loopback
model fixture:

- **Cold:** empty ledger; one confined write to a new small file.
- **Warm:** explicit complete ledger prewarm, then the same write.
- **Metadata-only:** prewarm, change README's timestamp without changing its
  contents, then the same write.
- **Changed-content:** prewarm, append a small external change to README, then
  the same write.

Each worker shallow-clones the committed repository tree and imports the current
working-tree runtime. Reports retain both identities. Case order rotates across
repetitions. Prewarm time and its phase/Git/copy costs are reported separately;
it is never counted as free work. The original benchmark CLI remains available
without `--profile`.
The optional alternate `--runtime` is supported for direct-ledger profiling;
companion mode always measures this checkout's verified host and artifacts.

## Measurement boundaries

Admission summaries provide preparation, reconciliation, queue, and ledger
commit counts/time. Benchmark-only wrappers observe host Git subprocesses and
`copyFile`; no production instrumentation or batching policy changes are made.
Direct preparation includes reservation inside `runtime.begin`; native
preparation measures the existing asynchronous preparation job. These are
related boundaries, not interchangeable before/after measurements.
Copy work excludes hash verification, chmod, and rename, which remain inside
preparation. Git/copy totals sum overlapping work and nested phase times are not
additive. Only operations fully contained in the sampled interval enter those
work totals; background operations crossing its boundaries are excluded.
Git `write-tree` counts and ledger commit-method counts are reported
separately: the store publishes Git trees directly and does not create commit
objects.

Host CPU measures the sampled interval, while host peak RSS covers that fresh
worker's complete lifetime, including prewarm. Both exclude child processes.
Companion CPU comes from its process CPU counter; its RSS peak is sampled every
250 ms across startup, prewarm, and the measured call, and may miss spikes.
Git child CPU and an exact whole-process-tree peak
are unavailable. Companion worker trace boundaries separate tool execution from
worker initialization; result-return time runs from host finish to the completed
loopback HTTP response. Whole sample wall time also includes output validation;
`promptWallMs` excludes that post-response validation.

Project, config, data, and logs stay in repository-local disposable fixtures.
Native macOS confinement still uses its existing lease-specific sockets under
`/private/tmp`; their removal is checked explicitly. Parent deadlines stop only
owned processes using the existing QA identity tracker. Timeouts retain partial
diagnostics and logs. Fixture deletion follows verified process cleanup.
Successful-trial cleanup also removes its sibling temporary HOME; failed trials
retain their disposable state for diagnosis.

## Interpretation

Use median and min/max across all three successful repetitions; failures and
timeouts remain failures, not omitted samples. Compare preparation against
reconciliation, Git/commit work, copy work, and queue time before proposing an
optimization. Keep any follow-up specific to the measured phase.

These four cases do not reproduce arbitrary retained ledger history, many-file
external changes, concurrent sessions, browser startup, or contention from the
running installation. If the historical 99-commit shape is absent, a subsequent
fixture needs that incident's missing file/history inventory rather than an
arbitrary sequence of 99 synthetic calls. No performance threshold or claimed
production improvement is attached to this profiling change.

## Results: 27 September 2026

All 24 measured trials completed: three fresh processes for each case in each
mode. The fixture contained 5,826 tracked files at project commit
`ceff9fdc467b7486d9b41a8d78d954baed620111`, on `darwin-arm64`, Node `v26.0.0`.
The native arm verified companion 2.1.1, base 1.18.32, with SHA-256
`3a83f25e2f5ed70f3e06d68854623ad5eabb25b85c799b0627de211717ef4b7c`.
The three recorded runtime source hashes were identical across all 24 trials.

Values below are median (minimum–maximum), with three samples per row. Times
are seconds unless the column says otherwise. Cold means a fresh ledger;
operating-system filesystem caches were not flushed.

| Mode / case | Separate prewarm | Preparation | Whole measured call |
| --- | ---: | ---: | ---: |
| Direct / cold | — | 67.69 (64.34–67.92) | 70.48 (66.91–71.02) |
| Direct / warm | 62.50 (61.61–62.75) | 5.95 (5.93–6.18) | 8.26 (7.64–8.39) |
| Direct / metadata-only | 61.49 (59.67–61.57) | 6.28 (6.05–6.60) | 7.96 (7.71–8.29) |
| Direct / changed-content | 60.02 (59.71–63.81) | 6.74 (6.61–6.84) | 8.39 (8.24–8.48) |
| Companion / cold | — | 68.21 (66.94–69.55) | 73.12 (71.73–74.45) |
| Companion / warm | 61.82 (61.61–66.33) | 4.60 (4.35–5.13) | 9.95 (9.69–11.68) |
| Companion / metadata-only | 64.61 (61.42–67.52) | 6.05 (5.90–6.34) | 11.49 (11.17–11.81) |
| Companion / changed-content | 63.10 (62.57–63.13) | 6.59 (5.72–7.42) | 11.69 (10.95–12.69) |

Cold preparation is repeatably expensive in current source. Reconciliation
occupies most of it. Prewarming moves that work before the tool request and
costs approximately a minute; these results do not justify making prewarm more
aggressive or changing when it runs.

| Mode / case | Reconciliation | Git subprocess work | `copyFile` work | Queue wait, ms |
| --- | ---: | ---: | ---: | ---: |
| Direct / cold | 62.65 (59.27–62.86) | 55.67 (51.58–56.06) | 1.60 (1.36–1.65) | 2 (2–3) |
| Direct / warm | 0.92 (0.78–0.96) | 6.22 (5.51–6.23) | 1.78 (1.71–1.78) | 0 (0–0) |
| Direct / metadata-only | 1.66 (1.55–1.74) | 6.83 (6.49–13.55) | 1.53 (1.44–1.62) | 0 (0–0) |
| Direct / changed-content | 1.89 (1.83–2.10) | 6.97 (6.84–6.99) | 1.45 (1.44–1.46) | 1 (0–2) |
| Companion / cold | 63.13 (61.97–64.35) | 56.93 (54.61–57.57) | 1.52 (1.52–1.57) | 1 (1–1) |
| Companion / warm | 0.69 (0.69–0.76) | 15.07 (14.78–17.17) | 1.73 (1.66–1.79) | 0 (0–1) |
| Companion / metadata-only | 1.70 (1.68–1.77) | 16.86 (16.63–17.14) | 2.50 (2.34–2.70) | 0 (0–0) |
| Companion / changed-content | 1.94 (1.89–1.95) | 16.67 (16.02–17.97) | 2.83 (2.28–3.39) | 0 (0–2) |

Git work sums concurrent subprocess lifetimes and can exceed elapsed wall time.
It is not Git CPU time. Every measured call copied 5,827 files. Queueing was
negligible in this deliberately uncontended fixture; concurrent fairness and
production queue behavior were not measured.

| Mode / case | Git processes | Tree writes | Ledger commit-method calls | Ledger commit work |
| --- | ---: | ---: | ---: | ---: |
| Direct / cold | 3049 | 15 | 14 | 18.34 (16.93–18.80) |
| Direct / warm | 120 | 9 | 8 | 2.20 (1.73–2.25) |
| Direct / metadata-only | 134 (134–135) | 10 | 9 | 1.97 (1.86–2.01) |
| Direct / changed-content | 142 | 10 | 9 | 1.99 (1.97–2.04) |
| Companion / cold | 3082 | 17 | 12 | 19.05 (17.94–19.29) |
| Companion / warm | 156 | 10 | 5 | 1.65 (1.60–1.86) |
| Companion / metadata-only | 170 | 11 | 6 | 2.66 (2.55–2.70) |
| Companion / changed-content | 178 | 11 | 6 | 2.68 (2.65–2.86) |

Single counts were identical in all three trials. This table covers the complete
measured call. Preparation alone contained nine direct or eight companion
commit-method calls in the cold case, and two to four in the other cases.
The 99-commit preparation shape was not reproduced.

The native trace separates execution and publication from preparation:

| Companion case | Tool execution, ms | Publication | Result return, ms |
| --- | ---: | ---: | ---: |
| Cold | 47 (45–57) | 1.65 (1.61–1.81) | 127.1 (119.1–129.2) |
| Warm | 54 (45–68) | 1.40 (1.36–1.69) | 102.9 (102.0–162.7) |
| Metadata-only | 49 (43–52) | 1.28 (1.16–1.29) | 103.9 (99.8–118.8) |
| Changed-content | 48 (47–48) | 1.20 (1.18–1.29) | 99.8 (99.4–142.2) |

Direct tool execution was a synthetic file write, approximately 0.1 ms; it has
no transport return phase. Native tool startup and other request overhead
remain in the whole-call wall time and retained worker traces, rather than being
mislabelled as execution or result return.

| Mode / case | Host CPU, seconds | Host peak RSS, MiB | Companion CPU, seconds | Companion sampled peak RSS, MiB |
| --- | ---: | ---: | ---: | ---: |
| Direct / cold | 27.09 (26.47–28.73) | 218.9 (209.9–231.3) | — | — |
| Direct / warm | 6.09 (5.98–6.17) | 219.3 (218.4–230.8) | — | — |
| Direct / metadata-only | 5.82 (5.77–6.17) | 245.3 (225.7–248.8) | — | — |
| Direct / changed-content | 6.00 (5.91–6.13) | 224.6 (215.9–238.3) | — | — |
| Companion / cold | 28.24 (27.57–28.53) | 236.7 (221.2–238.8) | 12.04 (11.40–12.20) | 900.0 (807.1–918.4) |
| Companion / warm | 7.12 (7.00–7.30) | 260.1 (227.7–270.1) | 3.47 (3.45–5.17) | 671.2 (669.2–734.9) |
| Companion / metadata-only | 7.40 (7.30–7.56) | 259.8 (231.9–269.6) | 7.99 (3.75–8.40) | 1047.0 (683.5–1100.8) |
| Companion / changed-content | 7.31 (6.92–7.64) | 260.5 (253.2–264.8) | 7.37 (4.85–8.32) | 819.9 (779.6–990.7) |

CPU columns cover the measured call; RSS columns include earlier startup and
prewarm as described above. Companion means the `serve` process, excluding
its execution workers. These columns are not total process-tree resource use.
Per-prewarm CPU, Git, copy, and phase data remain in the JSON report.

## Specific follow-up supported by these measurements

Whitelisted per-command Git attribution was added after the 12 direct trials;
it is available for all 12 native trials. Aggregate Git metrics retained the
same boundaries throughout. In the native cold case:

| Git command | Count | Summed subprocess work, seconds |
| --- | ---: | ---: |
| `ls-tree` | 2773 | 24.42 (24.07–25.60) |
| `update-index` | 17 | 10.03 (9.62–10.13) |
| `hash-object` | 147 | 9.16 (8.81–9.26) |
| `read-tree` | 17 | 5.53 (5.13–5.95) |
| `write-tree` | 17 | 5.25 (5.17–5.44) |

The next narrow experiment should test eliminating unused initial-document
`runsFor` reads in `recordFile` in
`packages/harness-runtime/lib/session-mutations.js`. Its initial baseline branch
builds new runs without consuming the preceding `runsFor` result. The existing
fresh-document path already skips other impossible-history reads. The store's
large-index fallback can turn prefix reads into individual `ls-tree` processes,
which matches the command category worth investigating here. A controlled A/B
and existing ownership/Revert correctness checks are still required before a
fix; the observer does not establish that every `ls-tree` came from this call.
No batching, fairness, or safety policy was changed.

This candidate does not establish the cause of the historical 72.2-second bash
preparation: its retained summary shows only 0.922 seconds of reconciliation.
The present single-write cold fixture demonstrates a different attributable
cost of similar magnitude. The separate 45.4-second incident is already
attributed to reconciliation and repeated ledger commits at that granularity;
its missing file/history inventory still prevents a representative fixture or
a justified commit-policy change. An arbitrary 99-operation setup would not
prove that shape and was not substituted for it.

## Retained evidence and cleanup

The full report is `.cache/perf/ledger-preparation-profile.json`; its evidence
root is `.cache/perf/ledger-profile/run-SaiTlf`. Each trial retains diagnostics,
worker logs, native logs where applicable, source identities, and process/socket
cleanup evidence. All 24 completed trials have no remaining owned processes;
all 12 native lease socket directories were verified absent. Their fixtures and
temporary HOMEs were removed, with logs and reports preserved. Eight native
cleanups used the existing bounded SIGTERM escalation after the initial graceful
wait; that shutdown time is outside measured preparation/tool latency.

Before measurement, an eight-case tiny-repository smoke completed successfully;
its evidence is `.cache/perf/ledger-profile-smoke.json`. After measurement, four
intentional one-second deadlines exercised timeout cleanup. All four retained
the `timeout` status and disposable failure state, stopped their owned process
trees, and recorded no cleanup errors. Their report is
`.cache/perf/ledger-profile-timeout.json`, with partial evidence under
`.cache/perf/ledger-profile/run-SIRhZ6`. These expected deadline checks are
separate from the 24 performance samples.

Other validation jobs were paused during measured intervals. Three short test
windows occurred only after a worker had exited and completed cleanup, while
the benchmark parent was paused. No measured worker overlapped those tests.
No installed app state, real provider, or credentials were used.
