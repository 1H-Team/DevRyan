# November 2 harness implementation measurements

The fixed tool workload uses 300 files, 1,000 seeded receipt calls, three warm-up
iterations and 20 measured repetitions for each of reads, four-call batches and
confined edits. The direct runtime and worker-host configurations run sequentially
on the same machine. Other development tests were active, so tail latency is
contention-sensitive. These measurements establish a reproducible local baseline;
they do not establish a Claude-native speedup.

| Configuration | Read p50 / p90 | Four reads p50 / p90 | Edit p50 / p90 |
|---|---:|---:|---:|
| Direct runtime | 19 / 21 ms | 38 / 48 ms | 341 / 378 ms |
| Worker host | 21 / 24 ms | 32 / 50 ms | 357 / 727 ms |

Cold first read/batch/edit timings were 24/24/971 ms for direct runtime and
22/27/1,142 ms for the worker host. Initialization was 1,246/1,349 ms and receipt
seeding 1,508/1,719 ms. The worker host's edit-wave CPU median was 220 ms with a
1 ms median busy main-thread event loop. Its maximum observed process RSS was
408,784,216 bytes. This process includes the collector and workers; it does not
measure the Electron application or provider process tree.

Command: `node scripts/perf/tool-latency-benchmark.mjs --files 300 --seed-calls 1000 --warmup 3 --reads 20 --bursts 20 --parallel 4 --edits 20`, followed by the same command with `--host`.

The matched Claude experiment completed three alternating pairs on an
authenticated isolated QA profile. Both arms selected `opus`, medium effort,
Claude Code `2.1.311` and SDK `0.3.301`, with identical fixture content, role and
project instructions, task prompt and acceptance checks. Native responses report
`claude-opus-5-5`; bridge messages retain the selected alias `opus`. CLI bytes and
instruction hashes are recorded in [the measurement data](2026-11-02-claude-comparison.json).

| Pair | Order | Bridge arm wall time | Native arm wall time |
|---|---|---:|---:|
| 1 | Bridge, native | 20.53 s | 13.35 s |
| 2 | Native, bridge | 28.65 s | 12.98 s |
| 3 | Bridge, native | 30.52 s | 14.80 s |

All six trials passed the unchanged acceptance tests and restored the fixture.
Arm wall time includes execution and process/session cleanup, excluding the
runner's baseline and final acceptance tests. Each bridge trial used seven tools
(three reads, three Bash calls and one edit); each native trial used five
(two reads, two Bash calls and one edit). These small, warm-cache observations
are directional: different tool behavior, context, permission ownership and
runtime guidance prevent attributing the difference solely to the adapter.
They do not establish a production speedup or justify replacing selective
ownership with native Claude tools.

Three earlier measurement attempts are retained separately in the data: a
disconnected provider declined before session creation; a completed bridge turn
could not read privileged timing metadata; and a native launch omitted required
account environment variables and appeared signed out. The corrected collector
checks provider availability and native authentication before allocating trials,
uses the bridge's platform-variable allowlist, and explicitly records timing
HTTP 403 as unavailable. The six-trial series ran once after these corrections;
no model or acceptance failure was replaced. Privileged timing metadata was
unavailable in all three bridge rows, not measured as zero. The private journal
gap verification passed after the series.

The cached changes-summary fixture uses eight sessions, 104 changed files and
256 historical read calls. Warm p95 was 0.2 ms with both one and three clients
(ten rounds, in-process authenticated fixture transport). A real private mutation
owner lock was held throughout the warm samples. Assertions require zero new
reconciliation, transcript/history reads, historical-outcome calls, mutation-owner
lock acquisitions and restore-proof requests. Authorization and directory checks
still run. One initial refresh plus one coalesced trailing refresh was observed;
this fixture proves the cache boundary, not end-to-end browser/network latency.

The isolated Electron session-changes scenario passed all 28 checks after the
cold-start SSE correction, with no console errors, captured stream failures,
diagnostic journal gaps or cleanup errors. It used native build
`9d298430e77f6803e3ed1d2ca697a6c0c90345d0c2a7c97ff6e876259d3c4626`.
The preceding diagnostic run located its stream error in the initial local
document before native readiness. Regression coverage now keeps never-connected
subscribers pending during initial upstream failures while retaining disconnect
revocation after connectivity, including during replay authorization.

The original Explorer missing-capture incident remains unresolved. This change
does not reconstruct missing evidence or relax Undo's ownership fences.

Final verification: `DEVRYAN_TEST_CONCURRENCY=2 bun run validate` passed all
95 units, with zero failures or unrun units, in 6m23s, including lint, type checks
and startup contracts. An earlier run had two timing-sensitive failures in the
test-pool process-start deadline and native helper's 5 ms admission deadline;
both passed individually and in the final full gate. Their assertions were not
changed. The four benchmark collector regression tests also passed.
