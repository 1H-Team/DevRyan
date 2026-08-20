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

## Integration

Run `bun run perf:electron -- --label <name>` after `bun run electron:build`.
Use the same physical display and window conditions for baseline/current runs.
