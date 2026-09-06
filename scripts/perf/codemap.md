# scripts/perf/

## Responsibility

Owns reproducible, benchmark-only Electron measurements and focused web-host
checks. It does not change runtime scheduling, caching, persistence, or OpenCode
behavior.

## Design

- `loopback-opencode-fixture.mjs` serves one selected parent and three child
  sessions with deterministic message/status/SSE fixtures on loopback.
  Seeded responses use numbered ASCII segments and retain their configured byte
  size through the production fetched-text normalizer, so history workloads
  measure the full payload instead of deduplicated repeated filler.
- `electron-resource-benchmark.mjs` launches a packaged DevRyan binary with
  isolated app and Chromium data, controls the renderer through CDP, samples
  Electron app metrics through `/api/debug/memory`, and captures Chromium
  traces. `--package-evidence <package-evidence.json>` selects an unsigned QA
  package built by `../qa/package-electron.mjs`, verifies the archive, shipped
  UI and recorded unpacked native binaries before and after the benchmark,
  and creates the same owned credential-free home/profile as fixture matrix
  cells. It records source/archive/UI hashes and each run's actual packaged
  bootstrap evidence. This option is mutually exclusive with
  `--electron-binary`; neither native signing/updater acceptance nor live
  provider behavior is measured by this deterministic fixture.
- Defaults are three fresh runs, a 5-second warm-up, a 30-second measured
  interval, and 500 ms samples. The first CPU sample is excluded from medians.
- `electron-run-evidence.mjs` captures bounded, sanitized renderer exceptions,
  console errors and Chromium error logs from CDP attachment, including buffered
  startup events. Every run saves `run-evidence.json` on success or failure:
  diagnostics status, fixture unknown routes and activity, the post-shutdown
  journal gap/error scan, and explicit owned-process/fixture cleanup results.
  Expected fixture HTTP failures remain reviewable evidence; they do not become
  automatic blanket failures. Missing diagnostics and evidence truncation are
  explicit. This collection occurs after timing except for passive listeners.
- All Electron scenarios use `../qa/process.mjs` for the same retained OS
  ancestry/start-identity tracking as QA and web-host measurements. Shutdown
  preserves the journal drain, closes the fixture, then audits the owned
  descendants again; observation gaps or remaining children fail cleanup.
  The common protocol hash includes the fixture and process helpers. The
  initial package-evidence bytes, archive, shipped UI and native files are
  checked again after success or failure; a newly valid replacement package
  cannot substitute for the originally pinned artifact.
- Every launch records `startup.json` before the benchmark's forced session
  navigation: parent-clock spawn-to-CDP/origin/host/usable-UI milestones and
  observed native document transitions and navigation/paint evidence. Normal
  native splash/boot navigation remains part of launch-to-usable-UI latency;
  benchmark-forced navigation is blocked until startup ends. The isolated Git
  workspace and private settings pin the initial fixture model; readiness checks
  the live selected IDs against both UI and fixture catalogs. This measures a fresh profile against the already
  running deterministic OpenCode fixture, not cold OS caches, provider
  initialization, native signing or updater behavior.
- The importable `runElectronResourceBenchmark({ argv, startupMode, interactiveScope })`
  accepts opt-in `startupMode: 'foreground'` for resource scenarios and the
  explicitly scoped typing-only interactive scenario described below.
  Each arm requests `Page.bringToFront` exactly once after the existing
  host/catalog/DOM/model/SSE prerequisites, even if already visible, and must
  pass all original checks in a later visible snapshot within the same 45-second
  admission deadline. Request/acknowledgement evidence, normalized mode and a
  mode-specific protocol hash are retained. No navigation, activation retry,
  timeout extension or visibility emulation is added. The default command
  remains natural; foreground-controlled startup timing is not natural launch
  latency. A new cohort must declare this mode for every arm, retain failures
  and stop on the first failed prerequisite; stopped cohorts cannot resume or
  contribute measurements to it.
- The synthetic plan-skeleton workload additionally binds post-startup fixture
  navigation to its returned new top-frame loader, exact session URL and new
  document time origin. The requested document must be complete with a connected
  body within the existing 45-second navigation deadline; cumulative fixture
  traffic and the previous document cannot admit insertion. Frame identity is
  checked around the readiness snapshot and document identity/body are checked
  again inside the insertion evaluation. Successful metrics retain this evidence
  under `forcedNavigation.documentReadiness`. This changes the protocol identity;
  a stopped cohort remains stopped and any corrected cohort starts afresh.
- `electron-lifecycle-benchmark.mjs` owns the opt-in `session-memory` scenario.
  It requires a verified QA package/private profile, seeds four independent
  180-turn histories with 4 KiB responses, and uses actual sidebar/history,
  New Chat, Archive, confirmation and Delete controls. The initial, loaded,
  inactive and deleted checkpoints each settle for at least 6 seconds before
  the configured sampling window. CDP renderer heap/DOM counters accompany
  one explicitly identified Electron Tab working set; each natural window is
  followed by one separately recorded forced-GC checkpoint. Every actual Load
  Older click must extend fresh contiguous cursor coverage and visibly commit
  that returned page's first message ID and canonical text in the selected
  session. The existing UI driver may reveal the row before sampling; scroll
  height and mounted-row counts are not completion evidence. Page accounting
  starts before the actual sidebar selection, excluding stale earlier reads.
  The canonical single-message lookup never adds page coverage. A final Debug Panel snapshot, taken
  after every memory measurement, requires deleted IDs to be absent from the
  renderer cache. Failed/unsupported controls or CDP diagnostics fail with
  partial evidence and a screenshot. No prompt is submitted.
- `electron-interactive-benchmark.mjs` owns the opt-in `interactive` scenario
  and its matched comparison. It drives fixed-cadence typing during a background
  stream, two complete paginated histories, draft/session switching, wheel
  scrolling, reasoning expansion, canonical cancel/reconnect and repeated
  New Chat/menu navigation. Browser-captured trusted-event timestamps measure
  render-ready latency; actual Event Timing, long tasks and frame intervals stay
  separate. Natural heap/DOM windows bracket repeated navigation. Fixed action
  counts, exact draft/stream content, contiguous UI pagination and the 2 px
  history anchor bound remain correctness gates. See `INTERACTIVE.md` for the
  declared primary metrics, evidence, limitations and three-fresh-run comparison
  requirements. A short smoke is not performance acceptance.
- The importable `interactiveScope: 'typing'` option requires only the
  `interactive` scenario. After completed startup it performs one ordinary
  same-origin navigation to the control-session URL, then requires that exact
  selected session and a visible, enabled, connected composer before installing
  the probe. It rechecks the control session/composer immediately before and
  after the inputs. The full protocol keeps its original sidebar admission;
  this typing-only setup change does not resolve the earlier sidebar failure.
  It retains the existing prepared sessions, warmup,
  trusted-event/two-frame probe and one advancing background stream, then ends
  after exactly 60 distinct passed trusted inputs at the unchanged 75 ms
  cadence. The exact unsent draft, zero submitted/active prompts and canonical
  background text advancement are mandatory. It uses the shared trace and
  probe finalization path; trace loss/overflow, incomplete observations or
  failed probe cleanup fail the arm. Only typing latency and actually observed
  browser data are reported; histories stay unopened and navigation/retention
  metrics and duration-based measurement windows are absent. Scope and actual
  startup mode both enter the protocol identity and comparison contract.
  The default remains `interactiveScope: 'full'` with natural startup and all
  existing action groups/checks. No CLI scope or startup-mode flag is added.
- `web-update-check-benchmark.mjs` is an importable native Node core for three
  fresh web-host before/after pairs in AB/BA/AB order. It substitutes only the
  pinned package-manager module at its original URL and records matching
  source, scripts, UI, executable and loaded dependency identities. The actual
  cold update route performs read-only local package discovery while independent
  health requests measure latency; V8 CPU and event-loop evidence retain their
  separate clocks. CPU attribution preserves raw bytes, stable-sorts timestamp/
  sample pairs and uses forward durations with an average terminal interval,
  recording reordering explicitly. Cached selection proof runs after profiling ends. Every arm
  retains bounded sanitized diagnostics/journal and exact owned-process cleanup
  evidence; failures cannot be dropped from the comparison. See
  `WEB_UPDATE_CHECK.md` for the fixed protocol and its scope.
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
For an isolated QA package, use:

```sh
bun run perf:electron -- --label candidate \
  --package-evidence .cache/qa/packaged-electron-EXAMPLE/package-evidence.json
```

Add `--baseline .cache/perf/BASELINE/summary.json` for comparison gates. Default
scenarios are `idle,one-stream,four-stream,plan-skeleton`; `--scenarios`,
`--runs`, `--warmup-ms` and `--measure-ms` support explicitly labelled smoke
runs. A short smoke verifies the harness but does not establish the default
resource comparison. Preserve fixture version, runtime, measurement parameters
and physical display/window conditions across baseline/current runs, and inspect
the recorded package source/archive/UI identities. Package mode keeps the QA
bootstrap's native exclusions; see `docs/QA.md` for the packaging contract.

For one predeclared fresh foreground-controlled resource arm, use the existing
runner through its structured API (there is no new CLI flag):

```sh
node --input-type=module <<'NODE'
import { runElectronResourceBenchmark } from './scripts/perf/electron-resource-benchmark.mjs';
await runElectronResourceBenchmark({
  startupMode: 'foreground',
  argv: ['--package-evidence', '.cache/qa/packaged-electron-EXAMPLE/package-evidence.json',
    '--label', 'fresh-foreground-idle-baseline-1', '--scenarios', 'idle', '--runs', '1',
    '--warmup-ms', '5000', '--measure-ms', '30000'],
});
NODE
```

Use the same mode and fresh isolated invocations for every declared baseline and
candidate arm. Natural and foreground summaries cannot be compared or pooled.

Use `--scenarios session-memory --package-evidence <path>` for the separate
lifecycle comparison. Its startup/retention deltas are descriptive and do not
reuse the six existing resource acceptance thresholds. Inactive sessions may
legitimately remain cached (the session LRU holds 40); Archive preserves
reversible history, while Delete exercises permanent retirement. A working-set
or heap delta alone is not a leak diagnosis. Baseline/current lifecycle
comparisons require matching fixture/protocol hashes, Chromium runtime, run
count and sampling parameters; historical summaries without lifecycle evidence
cannot establish these measurements.

Use `--scenarios interactive --package-evidence <path>` for the interactive
protocol. Its comparator additionally requires matched backend, shell/bootstrap
and native-file fingerprints, exact workload counts and successful correctness
for every run. Final matched measurements follow a separate frozen protocol
after all live/build/test workloads stop; ongoing script edits cannot overlap
the QA matrix runner's existing all-script freeze.

For a separately declared typing cohort, import the runner with
`interactiveScope: 'typing'`, `startupMode: 'foreground'`, and the existing
`--scenarios interactive --package-evidence <path>` arguments. Use three fresh
arms per package in prospective AB/BA/AB order after package qualification and
script freeze. Each arm measures one fixed 60-input sequence (180 raw inputs
per package), with at least 5 seconds of warmup; it does not measure for 30
seconds. Retain per-run p50/p95 values and their medians/ranges, exact draft and
stream evidence, trace/probe failures and cleanup. Full-protocol prefixes and
earlier natural-startup runs cannot be pooled into this cohort. Session-memory
retention remains its own scenario with the unchanged full workload and
measurement windows. Its corrected per-click canonical commit prerequisite
also changes the source protocol hash; earlier failed cohorts remain failed
and cannot be pooled into either fresh study.

For a live workload measurement run
`node scripts/perf/multi-session-sampler.mjs --label <name>` while the
installed app is running, then
`node scripts/perf/multi-session-report.mjs .cache/perf/multi-session/<name>`.
To see what a session tree spent (tools, skills, tokens per model) run
`bun run perf:pipeline -- --session <ses_id> --run <name> [--preflight --turn-timing]`;
it reads the live database read-only and is safe while the app is running.

- `streaming-reducer-benchmark.mjs` measures the production reducer directly in Bun across one/four sessions, 50/500/2000 messages, and delta/snapshot events. It reports 50 batch samples per scenario and a reducer content hash; this excludes React/network costs. Shared CDP and port discovery live in `../qa/`.

The shared fixture now models directory-scoped sessions, distinct provider catalog/config contracts, valid host session IDs, and prompt/abort/reconnect behavior. Historical resource summaries made with the older fixture are not comparable without a fresh baseline using this fixture version.

QA controls also seed paginated histories and configure the next prompt's rejection, hold/release, delayed or empty reasoning, and completed/failed tool output. Permission/question requests use SDK-shaped list/reply routes, todos use canonical snapshots/events, and captured sends retain explicit model/agent/variant/tool policy. Unknown routes fail with 404 and remain visible in `getState().unknownRoutes`; these transport fixtures do not simulate managed scheduler acceptance. Preserve one fixture hash across resource baseline/candidate runs, including its catalog.
