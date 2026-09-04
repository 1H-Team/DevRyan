# scripts/perf/

## Responsibility

Owns reproducible, benchmark-only Electron resource measurements. It does not
change runtime scheduling, caching, persistence, or OpenCode behavior.

## Design

- `loopback-opencode-fixture.mjs` serves one selected parent and three child
  sessions with deterministic message/status/SSE fixtures on loopback.
- `electron-resource-benchmark.mjs` launches a packaged DevRyan binary with
  isolated app and Chromium data, controls the renderer through CDP, samples
  Electron app metrics through `/api/debug/memory`, and captures Chromium
  traces.
- Defaults are three fresh runs, a 5-second warm-up, a 30-second measured
  interval, and 500 ms samples. The first CPU sample is excluded from medians.
- Results live only under ignored `.cache/perf/`; `--baseline` applies the
  renderer/GPU CPU and working-set gates to a prior `summary.json`.
- `multi-session-sampler.mjs` observes the *live* installed DevRyan app instead
  of launching one: it walks the `DevRyan.app` process tree (Electron main with
  the in-process server, helpers, managed `opencode serve`, and every spawned
  descendant), records macOS `phys_footprint` via `footprint`/`top` (the
  Activity Monitor Memory column; `ps` RSS undercounts compressed pages),
  `vm_stat`/swap/load pressure, `docker stats` for `devryan-*` containers,
  fd counts, log growth, the unauthenticated `/api/health` round trip, and
  (with `--cookie <oc_ui_session>`) server heap, Electron app metrics, and busy
  session counts. Output is `samples.jsonl` + `events.jsonl` (spawn/exit/mark)
  under `.cache/perf/multi-session/<label>/`; append lines to `marks.txt` to
  annotate the timeline. It never signals or reconfigures the app.
- `multi-session-report.mjs` turns a run into `report.md` (per-role peaks and
  growth slopes, child-process churn as memory-time, responsiveness
  percentiles, busy-session buckets, Docker, system competitors, timeline) and
  `--compare` diffs two runs.
- `session-pipeline-profile.mjs` profiles what one session *tree* spent, from
  the OpenCode database instead of the process table: it opens
  `~/.local/share/opencode/opencode.db` read-only (`better-sqlite3` from
  `packages/web` via `createRequire`, falling back to `node:sqlite` when the
  native binding was built for another Node ABI), walks `session.parent_id`
  recursively from `--session`, and aggregates per session and per tree: turns,
  assistant messages and tokens by provider/model, tool calls by name
  (count/errors/p50/p95/bytes), `DEVRYAN_TOOL_INPUT_INVALID:` guard rejections
  by model, skill loads (and the same skill re-loaded across one parent's
  children), MCP calls by server, bash classified as
  `tsc | vitest | bun test | eslint | git | playwright | other`, and wall time.
  `--preflight` / `--turn-timing` join `/api/diagnostics/harness/preflight`
  (once per agent+provider+model) and `/api/diagnostics/turn-timing/recent`
  (by assistant message id) from the running server and are skipped silently
  when it is unreachable. Output is `report.md` + `report.json` under
  `.cache/perf/multi-session/<run>/pipeline/`. Pure helpers
  (`classifyBashCommand`, `aggregateTree`, …) are exported for the tests.

## Integration

Run `bun run perf:electron -- --label <name>` after `bun run electron:build`.
Use the same physical display and window conditions for baseline/current runs.
For a live workload measurement run
`node scripts/perf/multi-session-sampler.mjs --label <name>` while the
installed app is running, then
`node scripts/perf/multi-session-report.mjs .cache/perf/multi-session/<name>`.
To see what a session tree spent (tools, skills, tokens per model) run
`bun run perf:pipeline -- --session <ses_id> --run <name> [--preflight --turn-timing]`;
it reads the live database read-only and is safe while the app is running.
