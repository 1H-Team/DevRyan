# Repair verification — 20 October 2026

Nine final resource profiles passed: three fresh launches each for idle, waiting skeleton and one stream. Three separate strict long-history attempts passed loading and inactive checkpoints, then failed at the unchanged Archive API boundary. Full memory-lifecycle qualification remains incomplete.

## Candidate and scope

The isolated package contains the current shared UI, backend and Electron shell. Its UI SHA-256 is `94df68b63bc4cf24806d896d9aa32aae643e5db7a7e9e0568ca41887763cf588`; archive SHA-256 is `e69136e5f47dbcf62f6e2ebb73bf20d8910ce7668c7a4aea139492884745a40c`. Electron 41.2.1 native SQLite and terminal-module smoke checks passed.

The compatible native input is repository runtime 2.1.0, build `6abdc8e8949b58961232392f8d9075f487a2ce30b6adc3774a3f3402c837dc02`. Its compiled worker predates the current worker changes. These profiles do not qualify those compiled changes, live providers, credentials, signing, updates or physical-device interaction. Profiles used private homes/browser profiles, a mock keychain and credential-free loopback fixtures; background Bots were disabled. The installed app and its data were untouched.

## Protocol and environment

The final resource runs used a 5-second warm-up, 30-second measurement window and 500-ms samples. Each retained 59 CPU samples after discarding the first of 60 raw samples. Long-history attempts separately used four 180-turn histories with 4,096-byte assistant responses, 6-second checkpoint settling and the same 30-second natural-memory windows. Separately labelled forced-GC samples followed natural windows.

Frozen fixture protocol: `1a5a2bcf6f2ab2fcadbeac30dc69b3167263c1ccebc4a625d8abbbb1d0177f3d`. Frozen lifecycle protocol: `287f0db350b9195e2be572eccf89a423cf94b2ebeba3e1a356a735f79a825500`. Earlier protocols and short preflights were not pooled with the final measurements.

Fixture setup waited for normal native readiness, acknowledged focus of the owned window, then registered/navigated to its loopback wire facade. Readiness includes this controlled setup and is not natural first-document startup latency. Visible-document, exact model/catalog, SSE, chronological history, contiguous page coverage and cleanup assertions remained required.

The host was an Apple M3 with 8 logical CPUs and 16 GiB RAM. Electron 41.2.1 / Chromium 146.0.7680.188 used a visible 1280×800 viewport at DPR 1. No builds or tests ran during sampling; other user activity was not controlled. Load averages before sampling were 6.59/6.01/5.26 and afterward 3.95/5.38/5.77. There is no matched baseline, regression or speedup claim.

## Repeated resource observations

Values below are medians of the three per-run medians; ranges span those medians. CPU is the summed Electron process CPU share of **total machine capacity**. Electron 41.2.1 divides Chromium's per-process CPU percentage by processor count; on this host, multiply these percentages by eight for a one-core equivalent. [Pinned Electron implementation](https://raw.githubusercontent.com/electron/electron/v41.2.1/shell/browser/api/electron_api_app.cc), [pinned Chromium definition](https://raw.githubusercontent.com/chromium/chromium/146.0.7680.188/base/process/process_metrics.h).

| Scenario | Passed runs | CPU % (range) | Summed working set MiB (range) | Median per-run p95 working set MiB |
| --- | ---: | ---: | ---: | ---: |
| Idle | 3/3 | 0.520 (0.479–0.539) | 837.1 (771.7–862.6) | 1004.3 |
| Waiting skeleton | 3/3 | 3.082 (3.057–3.234) | 844.7 (833.2–873.1) | 998.0 |
| One stream | 3/3 | 8.359 (8.257–8.400) | 1122.9 (1089.6–1200.7) | 1259.9 |

Working set sums `app.getAppMetrics().memory.workingSetSize` across Browser/GPU/Tab/Utility processes, converting KiB to MiB. Shared pages can be counted more than once; this is not unique physical memory. Separate native workers are outside this Electron process set. Working-set changes and compression alone do not establish a leak. [Electron memory definition](https://www.electronjs.org/docs/latest/api/structures/memory-info).

The waiting fixture displayed 48 skeleton lines with one running animation. Each stream run confirmed exactly one session emitting throughout the window, using synthetic 16-ms fixture deltas. All nine windows had zero retained browser errors during measurement. Startup/setup diagnostics were retained, including readiness 503s, fixture WebSocket 502 fallback and filesystem 400/404 responses; they were not suppressed. Every final run's journal scan was available and complete with zero gaps/errors. Package/protocol integrity checks and owned-process cleanup passed for all twelve final launches, with no surviving owned processes.

Representative median-CPU traces showed higher renderer/GPU activity in the synthetic stream. Median process CPU shares were: idle Tab 0.099% / GPU 0.169%; waiting Tab 1.473% / GPU 1.315%; stream Tab 4.912% / GPU 3.174%. The stream trace contained 7,815 FunctionCall events (2,977 ms nested duration), 3,001 paint-lifecycle events (1,441 ms) and 3,086 renderer-raster-worker events (1,242 ms). These durations overlap and cannot be added as exclusive CPU time. Minified chunk names do not identify a causal component. These observations do not justify a UI change; no UI optimization is proposed.

## Long-history observations and functional failure

All three attempts verified four complete 360-message histories, four Load Older clicks per history and actual cursor-anchor/direction continuity. Initial, loaded and inactive checkpoints passed. These are repeated pre-archive observations only.

| Checkpoint | Natural renderer heap MiB | Post-GC renderer heap MiB | Natural renderer working set MiB | DOM nodes |
| --- | ---: | ---: | ---: | ---: |
| Initial | 34.76 | 30.44 | 321.6 | 19,592 |
| Loaded | 41.52 | 41.12 | 315.2 | 20,135 |
| Inactive | 43.79 | 36.96 | 240.2 | 19,592 |

Each value is the median of three attempt summaries. The same renderer identity persisted through each attempt's checkpoints. Inactive mounted-message rows were zero. Inactive natural heap exceeding loaded heap does not establish a leak; the post-GC reduction demonstrates partial release only. Four histories are below the 40-session LRU capacity, so retained inactive caches are expected within this fixture scope.

Every attempt then failed with `Timed out: Archive confirmation or authoritative acknowledgement`. The retained browser diagnostic contains HTTP 400: `Only title may be updated through the session facade`. The UI [archive action](../packages/ui/src/sync/session-actions.ts) sends `sdk.session.update({time:{archived}})` while the current [v2 session facade](../packages/web/server/lib/opencode/v2/facade-routes.js) accepts title patches only. No production fix, fixture-only bypass or relaxed assertion was added. Archive, deleted-cache checks and full memory-lifecycle qualification remain failed/unrun. Each strict attempt exited 1, while journal completeness, package integrity and cleanup passed; no model prompts were received.

All twelve final memory screenshots were inspected: initial, loaded, inactive and failure for each attempt. Loaded screenshots show the exact oldest numbered request/response; inactive screenshots show New Chat with the history sidebar preserved. Failure screenshots preserve the post-400 state. Recovery/diff states were not captured. Representative [loaded](../.artifacts/qa-repair-qualification-2026-10-20/final-memory-1-memory-loaded.png) and [inactive](../.artifacts/qa-repair-qualification-2026-10-20/final-memory-1-memory-inactive.png) images are retained.

## Validation and remaining qualification

The final frozen-source `bun run validate` passed with exit 0 on 20 October 2026 at approximately 17:07 UTC, before the final sampling window. It included docs, lint, types, imports, script contracts, harness, orchestration, UI, web, startup and cache guard. Relevant results included web 7,243 tests / 571 files plus 126 native integration tests / 8 files; main UI 4,199 tests / 601 files plus isolated suites; startup 56 UI and 285 backend tests. The existing managed Rust daemon check was skipped by its established prerequisite. QA regressions included 81 focused tests and a broader 41-test fixture/lifecycle run; these sets overlap and are not summed.

The QA-only changes migrated the resource runner to supported facade setup, validated live-owned OS-temp scopes, required owned-window focus acknowledgement, used authenticated v2 canonical reads without polluting pagination evidence, revealed clipped historical text through the trusted UI, and recorded actual cursor direction/anchors. Foreign/expired scopes, symlinks, wrong directions and discontinuous anchors remain rejected. Measurement and startup assertions were preserved.

The offline actual-Claude probe completed six canonical tool handoffs without a replay wrapper or missing tool results. Its unchanged strict prefix grader failed a text-block-array to identical-string environment-message shape change. Seven SDK session IDs reflect the forked passthrough-resume policy, not proof of six resumptions without new sessions. Native persisted-checkpoint fallback was not exercised. The isolated dependency overlay used an existing same-version JSON parser and the captured native SQLite asset; original captured files were unchanged and the overlay was removed. This qualifies the bounded synthetic continuation probe, not captured-production-artifact completeness or live usage.

The following qualification remains unrun or incomplete:

- Actual direct upgrades from installed 2.0.2 and 2.0.15 apps; regression tests were implemented, but those physical upgrade paths were not run.
- Three consecutive final-DMG CI candidates, signing/update delivery and newly compiled native-worker behavior.
- A matched real-CLI Claude cache/latency comparison; account quota is not inferred from token counts.
- The three-run exploration comparison against the 30% improvement target.
- Successful Archive/delete and full memory-lifecycle qualification, plus recovery/diff visual coverage.

## Evidence and cleanup

Bounded sanitized evidence is retained in [the qualification artifacts](../.artifacts/qa-repair-qualification-2026-10-20/): `final-observations.json`, `final-resource-summary.json`, three `final-memory-*-measurements.json` files with actual page-chain evidence, package/protocol receipts, separate earlier-attempt history, offline-Claude summary, ambient context and inspected screenshots. Raw traces are represented by hashes and bounded event summaries. No earlier protocol contributes to the final tables.

Owned package/build scratch and all retained isolated performance-run directories were removed after export. The cleanup receipt records explicit owned paths and absence checks. Original native donors, repository runtime inputs, unrelated artifacts and the installed app were preserved.
