# OpenCode 1.18.33 baseline for the OpenCode 2 upgrade (Phase 0)

Evidence recorded on the retained 1.18.33 runtime before any OpenCode 2 work
lands, so the candidate can be compared against known numbers instead of
memory. Plan: `~/.claude/plans/hazy-questing-panda.md` (Phase 0). All runs use
an isolated host prepared by `scripts/qa/profile-preparation.mjs` with
`preserveOrchestration: true` and `mirrorPersonalSetup: true` (personal
plugins, the three skill roots, MCP definitions disabled, personal agent
overrides), a working-tree copy of `onehealth-connector` and a data directory
outside this repository. Nothing here touched the owner's running app or
configuration.

## Tooling that landed with Phase 0

- `packages/web/server/lib/opencode/runtime-selection.js`: every managed
  launch records `opencode-runtime-selection.json` (runtime generation, kind,
  binary, channel, OpenCode data directory, database, config directory).
  Database maintenance and the git sandbox sync act on that record; the
  newest-by-mtime guess is a read-only fallback. Maintenance positively
  refuses an OpenCode 2 database (`kv` table) and any file that is not
  recognisably v1 before opening it read-write.
- `scripts/qa/profile-preparation.mjs`: opt-in `mirrorPersonalSetup`; the
  default executable follows `resolveQaTargetOpenCodeVersion()`.
- `scripts/qa/runtime-target.mjs` and `DEVRYAN_QA_OPENCODE_VERSION`: QA can
  target a candidate runtime version before the host pin moves; evidence
  records `runtimeTarget: { version, source }`.
- `scripts/agent-evals` paired factor `runtime` with a non-inferiority verdict.
- `scripts/qa/parity-manifest.mjs`: catalog capture and diff (agents, tools,
  commands, skills, MCP, Slim behaviour checklist).
- `scripts/perf/ledger-benchmark.mjs`: `--seed-calls`, `--same-session`,
  `--deferred-cleanup`, `--profile --parallel`.
- Dead UI SDK code removed (`packages/ui/src/sync/submit.ts`, 21 unused
  `OpencodeService` methods).

## Files

| File | What it is |
| --- | --- |
| `parity-manifest.1.18.33.json` | `scripts/qa/parity-manifest.mjs` capture of the mirrored profile on 1.18.33 |
| `live-cases.mjs` | the journey prompts and expectations that produced `live-journeys.md` |
| `live-journeys.md` | outcomes, dispatch structure, tool timings and first-token proxy per journey |
| `cache-usage.md`, `cache-usage.<run>.json` | `scripts/qa/cache-usage-report.mjs` over each host's journal (cache-read ratio, continuity) and the per-case summary |
| `ledger-benchmark.json` | seeded, same-session, deferred-cleanup ledger benchmark on the 12k-file fixture |

## Numbers to beat or match (1.18.33 companion 2.1.2, Node 26, darwin-arm64)

**Ledger benchmark** (`node scripts/perf/ledger-benchmark.mjs --fixture-files 12000 --prewarm --seed-calls 2000 --parallel 8 --same-session --deferred-cleanup --iterations 2 --warm-calls 3`), ledger seeded to 42,238 entries (comparable to the owner's 41.7k–47.8k production ledgers):

| Metric | p50 | Notes |
| --- | --- | --- |
| Cold ledger build (prewarm, 12,002 files) | 170 s | matches the live hosts' 219–303 s warm under three-host load |
| Direct receipt at 42k entries | 245 ms | `seedLastCallMs`; 2000 seeds took 496 s |
| Warm confined call: begin / finish / cleanup | 3.5 s / 1.55 s / 1.3 s | |
| Same-session 8-call burst: span / begin p50 / finish p50 | 29.1 s / 16.1 s / 5.0 s | the number the v2 in-process write path must beat |
| Control call (no confinement) | 1.1 s | |
| Deferred cleanup drain after the burst | 5.4 s | |
| Benchmark RSS | 401 MiB | |

**Parity manifest**: 15 agents (9 DevRyan roles incl. `devryan-*` helpers, plus `build`, `plan`, `compaction`, `summary`), 27 tool ids (incl. Slim's `ast_grep_*`, `task_*`, `wait_for_user`, `webfetch`, `websearch`; DevRyan's `devryan_task`, `devryan_document`, `council_session`; `todowrite`), 56 commands (skills registered as commands, Slim's four, Ponytail's six), 50 skills, 6 MCP definitions (mirrored disabled), Slim 2.2.25 checklist with 14 live-confirmed items. `lsp` disabled by the managed overlay, no formatter, no `default_agent`.

**Live journeys** (`live-journeys.md`, 12 of 13 cases on the fixed fixture; l6 pending): every case settled without questions or timeouts; dispatch structure matched expectations (direct fix with zero children; Explorer+Librarian, two Fixers, Fixer+Designer, four Explorers, three-way overlaps; parent resume on result delivery). Confined `apply_patch` per edit: 6–9 s p50 on a quiet machine (p0d), 12–27 s with three hosts warming concurrently. First-token proxy p50: root 2.8–6.4 s, child 2.8–6.2 s. Overall cache-read ratio 0.861 (`cache-usage.md`; Astra 0.77–0.92, Sol 0.71–0.93, Opus 0.87–0.93, DeepSeek 0.54–0.87), two warm-gap continuity breaks in 15 case runs (l8, l13) plus the aborted Stop case.

**Fixture defects found and fixed during the run**: the golden `onehealth-connector` copy was missing 44 top-level `node_modules` packages (e.g. `tinyglobby`) and had 63 tracked files deleted (`tsconfig.app.json`, vitest setup files, design rules); the first l1/l4/l5 runs therefore report "tests unverified" and were rerun on host p0d. l11 (Oracle + Council) and the first l5 rerun hit an Anthropic `provider_usage_limit` during the owner's Claude quota window and are rerun on host p0e; l6 (Implement Plan) runs with Builder substituted to `openai/gpt-6.1-sol (high)` because the copied xAI access token had expired — a v2 comparison of l6 must use the same substitution.
