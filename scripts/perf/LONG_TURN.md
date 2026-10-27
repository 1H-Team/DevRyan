# Long-turn activity window benchmark

Run `node scripts/perf/long-turn-benchmark.mjs` from the repository root. It
alternates ten matched baseline/candidate pairs after warm-up. Each arm mounts
and grows the same turn through 200, 400 and 800 assistant tool messages. The
baseline sets `longTurnActivityWindowingEnabled` to false; the candidate sets it
to true. It prints every paired total commit time, each median, the percentage
improvement and whether every candidate pair is faster. The proposed threshold
requires at least 5% median improvement and every candidate pair faster.

The workload mounts the real MessageList and its projection but replaces the
ChatMessage leaf with a lightweight DOM probe. Its timing is a focused signal;
it does not qualify the change for default-on use. Browser/Electron rendering,
layout and real tool cards must also be measured on matched growing sessions.
The flag defaults to false pending qualification.

Two local runs on 2026-10-26 produced these results:

| Run | Baseline median | Candidate median | Improvement | Every pair faster |
| --- | ---: | ---: | ---: | --- |
| 1 | 18.22 ms | 13.48 ms | 26.0% | No (9/10) |
| 2 | 16.06 ms | 11.00 ms | 31.5% | Yes (10/10) |

The first run fails the paired threshold, and neither run measures the full
browser workload. They do not qualify the default-on optimization.
