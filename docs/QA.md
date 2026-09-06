# Isolated Electron and web QA

Run from the repository root using the Node and Bun versions declared in `package.json`. Install the lockfile dependencies with `bun install --frozen-lockfile`. No extra QA dependency is required; the browser driver reuses Electron and `ws` already installed in its workspace.

```sh
bun run build:ui
bun run build:web
bun run --cwd packages/electron build:web-assets
bun run qa
DEVRYAN_QA_RUNTIME=electron bun run qa
DEVRYAN_QA_SCENARIO=mobile bun run qa
```

Without `--config`, `qa` defaults to `web` / `chat`. Supported runtimes are `web` and `electron`; `mobile` is web-only. Web launches the actual Express server and shared UI in a sandboxed Chromium window. Electron launches the actual repository main process and preload with the in-process server. These are development-binary checks; they do not replace packaged native pointer/updater/quit verification. The explicit matrix below uses actual packaged Electron.

Each run creates a private `.cache/qa/<runtime>-<scenario>-<random>/runtime/` with a Git workspace, data directory, and browser profile. It connects only to its deterministic loopback provider fixture. The browser profile is seeded with the same workspace preference as the isolated server before shared stores mount. It prints the evidence directory and CDP inspection URL. `DEVRYAN_QA_HOLD_MS=120000` keeps the owned runtime inspectable for two minutes after checks finish, including on failure. An interrupt exits the hold and proceeds to cleanup. Use the printed CDP target or the launched window to inspect the exact failing state.

The runner records revision, dirty state, runtime/scenario, check timings, sanitized errors, screenshot paths, fixture request counts/canonical IDs, diagnostic health when available, and cleanup errors in `result.json`. `process-logs.json` keeps bounded sanitized child logs. The sanitized journal is preserved as `journal/` before temporary runtime data is removed. Only children created by this invocation are stopped; shutdown failures retain temporary data and fail the run. A missing build, executable, connection, or assertion is a failure with evidence, not a skipped success.

Current coverage: select a fixture session; connect event transport; receive four concurrent streams; preserve typed composer text; submit through the composer and reconcile; cancel a second active prompt; reconnect/reload without resubmission or lost completed text. The mobile scenario captures 390×844, 844×390, and 768×1024 in both themes before the stream journey and checks composer/viewport bounds plus touch-driven session drawer open/close at the mobile breakpoints. `passed` describes these automated checks only. A human or agent must inspect every PNG and write a reviewed summary under `docs/audits/`; screenshot creation alone is not visual acceptance. Reviewed results and missing journeys are tracked in the September audit register.

The default smoke does not cover new-session creation, attachments, queue policy, permission dialogs, tool expansion or old-history anchoring; use the matrix fixture for those journeys. Drawer swipes, native dialogs, long idle recovery and closed-session memory still need separate verification. Physical-device keyboard behavior remains unverified until exercised on a device.

## Local packaged Electron candidate

The opt-in macOS arm64 packager consumes a chosen web build and the matching native binaries from an existing repository-local `packages/electron/dist/mac-arm64/DevRyan.app`:

```sh
DEVRYAN_QA_DIST_DIR=/absolute/path/inside/DevRyan/.cache/qa/candidate-web-EXAMPLE bun scripts/qa/package-electron.mjs
```

It writes a new `.cache/qa/packaged-electron-*/` app and `package-evidence.json`. The app contains the current bundled Electron main, server dependencies, preload and the supplied UI. Evidence compares shipped workspace source and UI bytes, verifies Electron/native package versions, and runs SQLite and PTY under the packaged executable. It uses no signing, publication or shared native rebuild step.

Launch the returned executable directly with the existing fixture/live profile's environment and CDP flags; omit the development `isolated-host.mjs` argument. Its packaged entrypoint requires `DEVRYAN_QA_RUNTIME=electron`, the owned `DEVRYAN_QA_RUNTIME_ROOT`/`DEVRYAN_QA_HOME` marker, and private data/profile paths. Before importing production main, this QA-only bootstrap fixes packaged resource mode, isolates logs and shell configuration, uses Chromium's mock keychain, suppresses global protocol registration, and disables the private profile's background Bot service. These exclusions are recorded in `runtime/packaged-host.json`; signing, updater installation, OS keychain, protocol registration, background service and legacy Tauri acceptance remain separate.

## Fresh-checkout packaged bootstrap

This is a source-checked recipe, not a completed clean-room build. It uses the existing Bun, Electron rebuild and electron-builder dependencies. The current QA packager supports macOS arm64 only. Prerequisites are Git, Bun 1.3.14, Node >=22.13 with npm and Node N-API headers, and Xcode Command Line Tools providing `xcrun swiftc`, `xcrun clang++`, `lipo`, and the macOS SDK. Python and a working native compiler toolchain are needed if the existing native rebuild cannot use a prebuilt binding. Network access is needed for locked dependencies, Electron/native headers and the pinned OpenCode npm archive.

Run from the root of a clean, committed DevRyan checkout. Use a separate disposable worktree with its own copied dependencies for the Electron ABI rebuild. Rebuilding native modules in the checkout used by web QA would replace its Node bindings with Electron bindings.

```sh
bun install --frozen-lockfile --backend=copyfile
bun run build:ui
bun run build:web
bun run --cwd packages/electron build:native-helpers

mkdir -p .cache/qa
qaNativeRoot="$PWD/.cache/qa/native-bootstrap"
git worktree add --detach "$qaNativeRoot" HEAD
(
  cd "$qaNativeRoot"
  bun install --frozen-lockfile --backend=copyfile --cache-dir "$qaNativeRoot/.cache/bun-install"
  DEVRYAN_BOT_RUNTIME_REQUIRE_RELEASE_MANIFEST=0 bun run --cwd packages/electron bundle:main
  ELECTRON_BUILDER_ARCH=arm64 bun run --cwd packages/electron rebuild:native
  CSC_IDENTITY_AUTO_DISCOVERY=false node --input-type=module <<'NODE'
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const projectDir = path.resolve('packages/electron');
const load = createRequire(path.join(projectDir, 'package.json'));
const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
const { build, Platform, Arch } = load('electron-builder');
const configPath = path.resolve('.cache/qa/native-donor-builder.cjs');
await mkdir(path.dirname(configPath), { recursive: true });
const config = {
  ...pkg.build,
  extends: null,
  electronVersion: load('electron/package.json').version,
  directories: { ...pkg.build.directories, output: path.join(projectDir, 'dist') },
  extraResources: [],
  extraFiles: [],
  asarUnpack: ['**/*.node', '**/spawn-helper'],
  npmRebuild: false,
  afterPack: null,
  publish: null,
  mac: { ...pkg.build.mac, target: ['dir'], identity: null, hardenedRuntime: false, notarize: false },
};
await writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`);
await build({ projectDir, config: configPath, targets: Platform.MAC.createTarget('dir', Arch.arm64), publish: 'never' });
NODE
)

mkdir -p packages/electron/dist/mac-arm64
cp -R "$qaNativeRoot/packages/electron/dist/mac-arm64/DevRyan.app" packages/electron/dist/mac-arm64/

qaWebDist="$(mktemp -d "$PWD/.cache/qa/candidate-web-XXXXXX")"
cp -R packages/web/dist/. "$qaWebDist/"
DEVRYAN_QA_DIST_DIR="$qaWebDist" bun scripts/qa/package-electron.mjs
```

The first app is only a native-binary donor and must not be launched or treated as an acceptance artifact. Its recipe deliberately omits release resources and the release afterPack hook. The real QA packager subsequently checks the donor's Electron version, module versions, arm64 architecture and copied hashes, packages the current source plus selected UI, and runs actual SQLite and PTY ABI smoke checks. Retain the final emitted `package-evidence.json` path for QA/performance commands. The donor worktree and its local dependency tree may be retained until verification is complete; do not reuse that dependency tree for Node/web runs. No signing, notarization, publication, installed-app replacement or global runtime installation is requested. The production `bun run electron:build` is unsuitable here because it requires a verified Bot release manifest and invokes the release packaging path.

Install the exact live-QA OpenCode runtime only in the ignored path expected by profile preparation:

```sh
mkdir -p .cache/qa/opencode-1.18.29
npm pack opencode-darwin-arm64@1.18.29 \
  --pack-destination "$PWD/.cache/qa/opencode-1.18.29" --json \
  > .cache/qa/opencode-1.18.29/pack-metadata.json

node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('.cache/qa/opencode-1.18.29');
const metadata = JSON.parse(await readFile(path.join(directory, 'pack-metadata.json'), 'utf8'));
assert.equal(metadata.length, 1);
const entry = metadata[0];
assert.equal(entry.name, 'opencode-darwin-arm64');
assert.equal(entry.version, '1.18.29');
assert.equal(path.basename(entry.filename), entry.filename);
const archive = path.join(directory, entry.filename);
assert.equal(`sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`, entry.integrity);
execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' });
const pkg = JSON.parse(await readFile(path.join(directory, 'package/package.json'), 'utf8'));
assert.equal(pkg.name, 'opencode-darwin-arm64');
assert.equal(pkg.version, '1.18.29');
const version = execFileSync(path.join(directory, 'package/bin/opencode'), ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, '1.18.29');
console.log(`Verified cached OpenCode ${version}`);
NODE
```

The archive's integrity is checked against npm pack's retained metadata, and the installed package identity and executable version are checked after extraction. This does not modify the user's OpenCode installation or install a package globally. The package identity and layout match the current retained `.cache/qa/opencode-1.18.29/package/package.json` and `profile-preparation.mjs` contract.

A fresh checkout alone still cannot run live-provider QA. `prepareQaProfile` also requires the user's existing supported OpenCode configuration directory, its installed dependency tree/package manifest and managed provider/agent configuration. It copies those installed dependencies into each owned private profile and provisions candidate defaults there. It projects only supported unexpired access credentials without refresh tokens; Anthropic requires the existing Claude CLI credential source. Establish these through their canonical owners. Fixture QA needs no provider credentials or cached OpenCode executable. Do not suggest hand-written credential files or a global install as a bootstrap substitute.

Validation performed for this proposal: read root/workspace package scripts, both native-helper builders, native rebuild resolver, bundler and QA packager; checked installed Bun's `--frozen-lockfile`, `--backend=copyfile`, `--cache-dir` syntax and npm's `pack --pack-destination --json` syntax. Builder options and explicit config-file behavior match the existing QA packager. No dependency install, native rebuild, donor package build or provider request was executed for this task.

## Interpreting an incomplete acceptance run

Grade recorded checks and evidence, not just the process exit code or screenshot filename. A partial fixture run does not qualify later steps. Direct use of an existing shared scenario can supply separately labeled coverage; retain the failed original and record the exact source, helper and served artifact identities before/after. Inspect every original screenshot, correlate journal records, and independently verify retained PID/start identities are absent before removing a private profile.

Give a QA-only objective one focused correction and a separately identified retry. If QA machinery prevents that objective again, stop expanding the helper and use an existing direct route or report it unverified. Keep network/provider failures separately classified. A transient startup retry uses a fresh run ID/evidence root and never replaces its original failed attempt. Do not refresh credentials to manufacture available coverage.

Closed-session memory requires complete canonical/rendered history coverage before loaded, inactive and deleted checkpoints. An initial-only sample or successful pagination HTTP response cannot qualify retention. Typing requires normal selection of the exact control session, sixty trusted inputs during proven background progress and an unchanged unsent draft. Keep natural samples separate from forced GC, use three fresh baseline/candidate runs in B1/C1/C2/B2/B3/C3 order, and stop a cohort at its failed prerequisite. See `scripts/perf/INTERACTIVE.md` and the [current acceptance report](audits/2026-09-05-cleanup/coding-agents-acceptance.md) for scope and retained evidence.

## Explicit UI matrix

Before broad live-provider matrix execution, complete a representative manual-compaction journey and a representative natural-compaction journey. Each must pass two verified native boundaries, resume implementation, pass the independent application and browser checks, and reconcile managed tasks, results and dispositions. Use the [reusable cleanup and QA checklist](audits/reusable-cleanup-checklist.md) for the next repository.

Before submitting any live prompt, each cell records the native tool inventory and requires `devryan_task` to be registered. This proves actual runtime plugin loading separately from the packaged-config asset smoke.

The separate matrix schema pins runtime, provider, model, primary agent, Plan mode and thinking choice for each cell. Run it through the existing entrypoint:

```sh
DEVRYAN_QA_DIST_DIR=/absolute/path/inside/DevRyan/.cache/qa/candidate-web-EXAMPLE \
  bun scripts/qa/run.mjs --config .cache/qa/matrix.json
```

This minimal `.cache/qa/matrix.json` runs two credential-free web journeys:

```json
{
  "schemaVersion": 1,
  "evidenceRoot": ".cache/qa/example-matrix",
  "cells": [
    {
      "id": "fixture-web-builder-default",
      "runtime": "web",
      "transport": "fixture",
      "providerId": "fixture",
      "modelId": "fixture-model",
      "agent": "builder",
      "planMode": false,
      "variant": null,
      "scenarioIds": ["core-journey", "mobile"],
      "repetitions": 1,
      "timeoutMs": 420000
    }
  ]
}
```

All shown fields are required; unknown fields fail validation. The optional `projectCompaction` composition is described below. Cell IDs must be unique. `variant: null` selects provider Default explicitly; a string selects an advertised variant such as `"high"`. Agents are `builder` or `orchestrator`; `planMode` is a boolean. The fixture accepts only `fixture/fixture-model` with `null`, `"low"` or `"high"` variants. Live cells accept `openai`, `anthropic` or `xai` and require an exact configured model ID and connected provider. No fallback model or effort is selected when a pinned choice is unavailable.

| Scenario | Supported execution | Graded behavior |
| --- | --- | --- |
| `core-journey` | Fixture or live; web or Electron | Actual UI selection, submission, streaming, cancellation and reload; the fixture adds deterministic queue, attachment, tool, permission, rejected-send, reasoning and history cases. |
| `mobile` | Web | Viewport/theme and touch checks with the core journey; it is not a physical-device test. |
| `project-work` | Live; web or Electron | Attached project requirements, revisions, Plan approval, independent domain/API/restart probes and browser behavior. |
| `compaction-manual` | Live; web or Electron | Two composer `/compact` boundaries, current saved-plan restoration and approved implementation. |
| `compaction-natural` | Live; Electron | Two automatic native boundaries reached by ordinary project context growth, followed by restoration and approved implementation. |

To cover manual Electron compaction within selected existing project journeys, set `"projectCompaction": "manual"` on a live Electron cell whose `scenarioIds` is exactly `["project-work"]`. This opt-in keeps one run, owned project, session and pinned model/agent/Plan/thinking selection. It uses the manual adapter's attached diagnosis, two saved plan revisions and unfinished implementation pause, then two actual composer `/compact` boundaries with steering and reload before approval and implementation. It retains the project's seeded-failure gate and final canonical task/browser graders. Each boundary has a separate continuation record for its restored native summary, independently checked paused project and exact revised state. `projectComposition` requires both distinct ordered native cycles, both continuation records, one session through implementation, operational continuity and the independent implementation grade. The browser grade remains separate and mandatory. Omitting the option leaves existing project journeys unchanged; adding `compaction-manual` to `scenarioIds` instead would create another fresh run. Make prospective configurations with an appropriate full-journey timeout; do not relabel historical results or count an unexecuted composition as coverage.

`repetitions` accepts 1–100 and `timeoutMs` accepts 1,000–86,400,000 ms per expanded run. A matrix has 1–500 cells and may expand to at most 10,000 runs. Runs execute sequentially. The evidence root must resolve below the repository's `.cache/`, without a symlink escape. Interrupts clean up the owned run and stop expansion; failures and incomplete matrices exit nonzero.

For any Electron cell, provide the packager's evidence file. The runner resolves its executable and packaged UI from that file; `DEVRYAN_QA_DIST_DIR` selects only the web cells' build:

```sh
DEVRYAN_QA_DIST_DIR=/absolute/path/inside/DevRyan/.cache/qa/candidate-web-EXAMPLE \
DEVRYAN_QA_PACKAGE_EVIDENCE=/absolute/path/inside/DevRyan/.cache/qa/packaged-electron-EXAMPLE/package-evidence.json \
  bun scripts/qa/run.mjs --config .cache/qa/matrix.json
```

Before and after an Electron cell, the loader verifies the app archive, shipped UI and recorded unpacked SQLite/PTY binaries against the package evidence. Runtime evidence must confirm `isPackaged: true`. Web artifacts must also remain inside the repository and include `.vite/manifest.json`; the served entry and artifact hashes are recorded and artifact changes fail the run. Source fingerprints and `sourceDrift` are recorded separately, so review them before attributing a result to the current working tree. Keep source and artifact bytes stable through a matrix.

Initial low-level health readiness does not imply that native plugins, providers, and agents have finished initializing. Only the first cold reload therefore has a separate 180-second bootstrap ceiling, additionally capped by the cell's remaining deadline. The gate requires initialized UI provider/agent state, visible enabled composer and New Chat controls, populated model/agent controls, and the exact pinned model and requested primary agent in the real connected native catalogs. Five-second bounded catalog requests retry transient startup failures; unavailable selections and permanent API failures fail explicitly. `initial-bootstrap.json` retains phase timings, request attempts, and the last UI snapshot, including on failure. All subsequent ordinary reloads keep their 30-second limit, and the later exact provider, agent, variant, and canonical submission checks still run.

Each cell receives an owned Git project, private home marker, managed data directory and Chromium profile. Live profile preparation provisions candidate defaults and plugins into that private installation, copies installed dependencies from the existing OpenCode configuration, and pins primary and delegated agent models. It expects the verified OpenCode 1.18.29 executable at `.cache/qa/opencode-1.18.29/package/bin/opencode`. Available API credentials or unexpired OAuth access credentials are projected into private files; refresh tokens and personal skills are not copied. Claude access comes from the existing CLI credential source. Do not put credentials in matrix JSON or handcraft the profile environment. The runner records credential availability and installed/plugin fingerprints without exposing secret values; missing dependencies, unsupported credentials or unavailable model access fail explicitly. Immediately after preparing each fresh live profile and before starting any host, the runner requires the copied selected-provider OAuth/Claude access expiry to cover the configured cell timeout plus ten minutes. It records the successful admission timestamp and budget; unavailable, expired, insufficient or unknown OAuth/Claude expiry fails the cell and follows normal private-profile cleanup. Existing OpenAI/xAI API-key admission is preserved with `expiryCheck: 'not-applicable-to-api-key'`; this makes no credential-lifetime guarantee. Other providers do not determine admission, and this check never refreshes credentials.

For focused specialist diagnostics, the `prepareQaProfile` / `pinQaAgents` APIs accept an optional `agentAssignments` map for known specialist roles, for example `{ explorer: { providerId: 'openai', modelId: 'gpt-5.3-codex-spark', variant: 'high' } }`. Assignments require the primary provider and an explicit nullable variant; malformed, ambiguous or cross-provider assignments fail before profile writes. Explicitly assigning a disabled specialist also fails instead of recording an ineffective assignment. Primary defaults remain pinned to the original cell. Profile evidence records the actual `agentModels` map and each role's model and nullable variant in `agentSelections`. This API option is not a matrix JSON field and does not establish availability or successful specialist execution: a focused run must separately check the live catalog, effective child selection, actual child results and parent reconciliation. It changes only the owned QA profile.

After primary-agent selection, the runner checks the actual selected provider, model and native agent against the pinned cell and usable catalog before opening effort controls or submitting a prompt. An available pinned model elsewhere in the catalog is insufficient. The private fixture profile must pin the same model and inherited Low choice through the application's actual standalone agent-config path; the UI then explicitly selects each cell's Default or High choice.

The fixture matrix checks shared UI and canonical transport behavior. Its synthetic compaction records specifically test Default/High restoration and saved Plan-card approval after reload; they do not prove native compaction or managed scheduler execution. Plan screenshots require the exact current or disabled historical approval control to be visible. Only successfully written, safe relative PNG basenames from the screenshot callback are preserved after result-content sanitization; arbitrary metadata does not receive that exception. Live project grading requires actual native tool results, unchanged protected tests, independent behavioral probes and, for Orchestrator, exact managed dispatch, child and disposition evidence. Model prose and session idleness cannot satisfy those grades.

Project instructions require the agent to run the native causal failing/passing test sequence, the full test suite, HTTP API checks, and server restart persistence checks inside its fixture. Both Builder and Orchestrator must pass the native causal repair grader. Its source read and edit must target regular files in the owned `src/` or `public/` tree; the original test file/script must remain intact, test exits must be numeric native metadata, and the selected tool intervals must not overlap. Orchestrator may distribute the chain across its verified root/child task graph, with exact managed disposition checks still required. Plan/README edits, opaque execution, prose exit claims and final independent behavior alone do not establish this chain. The independent QA browser then inspects the resulting UI; that mandatory grader remains separate from the agent's verification report. The agent must report that browser check as pending and must not discover or install browser tooling or request external-directory access to perform it. This keeps the same verification contract executable in standalone web profiles, which do not receive Electron's managed browser capability.

A rejected native permission can end a QA turn before its deadline only when the observer's typed request/reply IDs match a failed canonical tool in the completed assistant directly parented by the current submitted request. The same completed assistant and canonical idle state must appear in two fresh polls. The runner records the correlation evidence and fails explicitly; it never grants permission or resumes the agent. Error prose, historical rejections, active work and unproven continuation parents cannot trigger this guard.

The live observer records whitelisted controls at native `chat.message` and final `chat.params` hooks after configured plugins and before the provider adapter. The grader correlates the tracked user-message IDs, provider/model and explicit variant selection with the advertised control values. Default must arrive as an explicit cleared variant; native adapter defaults are reported separately. These records are not provider wire capture. Inspect `reasoningControls.turns` for the exact graded turn set, including any declared gaps.

Manual compaction requires both canonical summary linkage and independently observed native lifecycle events at each boundary. It verifies revision 2 remains saved, the paused project stays unchanged, and implementation resumes from the current approval surface. With Plan enabled, the reference is the app's saved session revision, identified by its original human request, source message, session directory, creation time and slug. Its raw path, byte count and hash remain pinned. Every exact revision read must stay inside the project-plan directory derived from the prepared runtime's own data root, reject symlinks and match the file's bytes to the API response. With Plan disabled, the reference remains the existing `.opencode/plans/qa-current.md` file in the owned project. Both references are checked at every paused boundary and before approval; a later Plan card cannot replace the baseline. Fresh approval requests contain the existing path and require an observed successful native read before a new full canonical Plan response. The harness does not copy the file, refeed its contents or count an unreadable reference as continuity. Natural compaction additionally requires OpenCode 1.18.29's unchanged configured model limits, measured usage at the threshold, `auto: true` and no provider-overflow substitute. It sends labelled synthetic project audit data through the ordinary composer, bounded to 256 KiB per batch, 40 batches per boundary and 32 MiB total, within the cell deadline. Reaching a workload bound without two verified boundaries fails; one boundary, a forced summary or a fixture result cannot stand in for natural coverage.

Manual Orchestrator coverage keeps its mixed first-boundary policy: two distinct seeded task/child/dispatch identities, one actually running child and one completed result with its exact undispositioned envelope. Both must be observed across native start and canonical summary completion. The active child may finish naturally during compaction while its result stays pending. Collection follows that exit observation; both exact results must remain completed through the second boundary. Missing, failed, consumed, replaced or ambiguous witnesses fail coverage.

Natural Orchestrator coverage uses two explicit phases instead: one active domain-review Oracle witness at boundary one, then one completed browser-location Explorer result awaiting disposition at boundary two. Each existing investigation marker is dispatched exactly once, near its own threshold; the first result is collected after its summary exit and reload, and remains completed through the second boundary. The second result is collected only after its own summary exit and reload. Native automatic collection remains authoritative: an already collected exact result is not dispositioned again, and a result consumed before its required pending observation fails coverage. Tasks finish their bounded work naturally; the harness never holds, prolongs or recreates a witness. Ordinary prefill before each seed shares the unchanged 40-batch per-boundary and 32-MiB total bounds. Its headroom estimate schedules work only. The original compaction observation start is preserved throughout; second-phase prefill excludes only the exact already-recorded first boundary and its native events. Any other early boundary is retained and rejected. Growth after either seed is input-only because the native Orchestrator dispatch barrier blocks ordinary tools. Each Plan-mode witness separately proves the canonical read-only child permissions.

Each required manual or natural witness uses the nearest managed snapshots whose entire HTTP request windows fall strictly before and after the native `compacting` timestamp. They must preserve the exact task, child, dispatch, attempt, execution kind and recovery lineage; a completed witness must retain the same unique unacknowledged envelope. The nearest wholly-after-canonical-summary observation proves the required pending state survived the summary. An active witness may finish naturally by that exit, with its result still unacknowledged. Earlier pre-request state, a later convenient sample or a late observer-delivery timestamp cannot replace these observations. Later reload and collection checks accept a disposition only when one canonical continue call starts strictly after summary completion and brackets the envelope acknowledgement. These are bracketed inferences from authoritative task state, not atomic native-hook snapshots. Natural evidence retains a separate `witnesses` record per phase, including its cohort, start bracket, summary exit, reload and collection request intervals. Final grading also checks global dispatch/child/attempt/result identity across all retained snapshots and canonical actions, including baseline work and implementation; an initially null child ID may bind once, but an observed identity cannot be rebound or silently disappear in a later wholly-after snapshot. Action identity conflicts remain sticky across context captures. Missing observations or evidence gaps prevent a complete continuity claim. No production scheduling, thresholds, wake rules or permissions are changed to make a cell pass.

New manual/natural evidence stores `managedSnapshots` as schema 2: `{ schemaVersion: 2, limits, projections, stages, reads }`. Each read is `[stageIndex, projectionIndex, requestStartedAt, responseCompletedAt]`; array order preserves actual completion order, including equal-time ties. Identical immutable projections are stored once, but every actual read keeps its exact interval, including unavailable observations. `decodeQaCompactionSnapshots` in `scripts/qa/compaction-snapshot-evidence.mjs` accepts legacy arrays or this compact format and returns the original row shape for the unchanged graders. Expanded rows are not serialized back into evidence. Bounds are 500 distinct projections, 100,000 reads, 256 stage labels and 8 MiB of minified JSON for the compact data; malformed input or overflow leaves a sticky `managedSnapshotGap`. The existing 100 ms readiness delay and 500 ms background sampling stay unchanged. The 120-minute natural budget admits 86,400 nominal reads from those schedules before request overhead; real count or byte exhaustion still fails explicitly. Action-count audit rows coalesce only when stage and counts are unchanged, retaining their first/last times and observation count under 500-row/256-KiB minified-JSON bounds; canonical action records are unchanged. Compression never repairs an older failed run or backfills dropped task observations from journal events.

Per-run `result.json` and matrix `summary.json` retain automated outcomes with visual review initially pending. Evidence includes source/artifact/package provenance, screenshots, sanitized journal and native observer records, saved plans, project changes and independent grades. Inspect every captured PNG and record an explicit visual review before claiming visual acceptance. A run can preserve evidence after failure; cleanup errors retain the owned project and fail the run. These commands define checks, not a statement that the full matrix has passed.

## Resource benchmark with the same package

Use the exact QA package for reproducible resource measurements:

```sh
bun run perf:electron -- --label candidate \
  --package-evidence .cache/qa/packaged-electron-EXAMPLE/package-evidence.json
```

This path creates private credential-free fixture profiles, verifies the package before and after measurement, and records its source/archive/UI identity plus the actual packaged-host bootstrap evidence. Do not combine `--package-evidence` with `--electron-binary`. The default is three fresh runs each of `idle`, `one-stream`, `four-stream` and `plan-skeleton`, with 5 seconds warm-up, 30 seconds measurement and 500 ms sampling. Use `--scenarios`, `--runs`, `--warmup-ms` and `--measure-ms` for an explicitly labelled smoke; it does not replace the default measured comparison. Add `--baseline .cache/perf/BASELINE/summary.json` to apply comparison gates. Keep fixture version, runtime, display/window conditions and measurement parameters consistent across baseline/candidate runs, and inspect the recorded package identities. Results are written under `.cache/perf/`; see `scripts/perf/codemap.md` for the other profiling tools.

Each fresh launch also writes `startup.json` before any benchmark navigation. Its parent-clock milestones distinguish spawn-to-CDP, loopback origin, host readiness and the first usable app UI. The composer, populated model control, New Chat control, fixture provider catalog and SSE connection must be ready. The benchmark pins the private profile to the fixture model before launch and reads the selected provider/model IDs from the live config store; readiness requires that selection to resolve in both the UI catalog and connected fixture catalog. The first observed selection and visible label are recorded. Every observed native document/transition is retained: normal splash-to-UI navigation is part of startup, while a guard rejects benchmark-forced navigation or reload until startup ends. Browser navigation and paint entries use their own document clock and are supplementary. The later resource-session navigation is timed separately. This fixture measurement excludes real provider initialization and does not claim cold operating-system caches.

Run the separate session-memory protocol with the same verified package:

```sh
bun run perf:electron -- --label candidate-session-memory \
  --package-evidence .cache/qa/packaged-electron-EXAMPLE/package-evidence.json \
  --scenarios session-memory
```

This scenario opens four owned, independent fixture sessions and loads each complete 180-turn history with 4 KiB assistant responses through the UI. It measures initial, loaded, inactive-after-New-Chat and permanently-deleted states in the same renderer. Each checkpoint waits at least six seconds for the five-second background-trim debounce, samples naturally for the configured window, then records a separate explicit-GC heap/DOM checkpoint. Memory records distinguish renderer heap bytes, renderer working-set bytes converted from Electron's KiB, and the separate main/server process. The Debug Panel stays closed during measurement; its final cache snapshot confirms exact deleted IDs are absent. Archive and Delete both use the actual controls and any confirmation dialogs presented by the profile's settings; the fixture must acknowledge each transition. No provider prompt is sent.

“Close Sessions” collapses the sidebar; it does not retire sessions. New Chat measures retained inactive history, Archive preserves reversible caches, and Delete invokes permanent cleanup. Four sessions do not exceed the 40-session cache limit, so retained inactive memory is not itself a leak. Compare three fresh runs per package under the same idle machine/display conditions, with the same runner/fixture/runtime and history parameters. Do not run the final measurements alongside builds, validation or live-provider workloads. `--baseline` reports matched startup and lifecycle deltas without assigning new pass/fail thresholds; the existing six resource gates remain unchanged. Short windows or one-run exercises only verify the harness, and historical resource summaries cannot establish startup or session-retention results.

The independent interactive workload uses that same packaged runner:

```sh
bun run perf:electron -- --label candidate-interactive \
  --package-evidence .cache/qa/packaged-electron-EXAMPLE/package-evidence.json \
  --scenarios interactive
```

It measures trusted typing during a background stream, two complete histories and pagination, session/draft switching, scrolling, reasoning expansion, reconnect/cancel and repeated navigation with natural heap/DOM samples. Each input measurement ends when the expected DOM state and two animation frames have completed: this is render-ready latency, not compositor presentation. Chromium Event Timing, long tasks and a bounded compressed trace are retained separately. Read [the exact protocol](../scripts/perf/INTERACTIVE.md) before running a matched comparison. Three fresh runs per package with at least five seconds of warmup and thirty-second memory windows are required. Every measured action retains its correctness gate, including the unchanged two-pixel pagination bound. A baseline that fails a correctness gate cannot support a complete performance comparison; retain its failure and report the unavailable phases rather than repairing or relabelling the preserved baseline.

## Cold web update-check comparison

The focused [update-check protocol](../scripts/perf/WEB_UPDATE_CHECK.md) compares
three fresh hosts per source version, in AB/BA/AB order, with the same final UI,
runtime, dependencies and instrumentation. It measures the actual cold route,
concurrent health latency, event-loop delay and synchronous package-discovery
CPU samples. Run it after builds, validation and other QA have stopped. This
benchmark specifically requires Node's [`module.registerHooks`](https://nodejs.org/api/module.html#moduleregisterhooksoptions)
(added in Node 22.15.0 and 23.5.0); the recorded comparison runtime is Node 26.0.0.

From a fresh checkout, recover the exact historical module and copy the current
module into ignored evidence storage. The benchmark validates both byte hashes
before launching; a different revision fails instead of changing the baseline.

```sh
mkdir -p .cache/perf/update-check-inputs
git show ff7abd116ca37db53a56981d7de76100f2a97690:packages/web/server/lib/package-manager.js > .cache/perf/update-check-inputs/package-manager.before.js
cp packages/web/server/lib/package-manager.js .cache/perf/update-check-inputs/package-manager.after.js
node --input-type=module <<'JS'
import path from 'node:path';
import { runWebUpdateCheckBenchmark } from './scripts/perf/web-update-check-benchmark.mjs';
const inputs = path.resolve('.cache/perf/update-check-inputs');
const result = await runWebUpdateCheckBenchmark({
  beforeSource: path.join(inputs, 'package-manager.before.js'),
  afterSource: path.join(inputs, 'package-manager.after.js'),
  uiDirectory: path.resolve('.cache/qa/REPLACE_WITH_FINAL_VERIFIED_WEB_CANDIDATE'),
  label: 'cold-discovery',
});
process.stdout.write(JSON.stringify({ outcome: result.outcome, resultFile: result.resultFile }) + '\n');
if (result.outcome !== 'passed') process.exitCode = 1;
JS
```

Replace the UI path with the verified candidate built using the procedure above.
The benchmark uses ordinary Node module options and retains all six outcomes.
It measures one historical module inside the otherwise fixed current host;
it does not represent an entire historical build or live-provider performance.

## Configured live-provider smoke

This opt-in command makes two minimal real-provider requests through an existing loopback DevRyan host. Set the origin explicitly; the runner never discovers or stops the user's app.

```sh
DEVRYAN_QA_LIVE_ORIGIN=http://127.0.0.1:PORT node scripts/qa/live.mjs
```

It uses the documented password-free administrator agent-test endpoint, the host's configured default OpenAI model and existing Builder agent, and an isolated Git workspace. It disables the enumerated tools and denies permissions, creates one QA session, verifies a completed answer, observes a second streamed answer, reconnects the SSE transport, cancels, and checks for two distinct user turns. It deletes only its own session and logs out its own in-memory cookie. No passwords or provider credentials are supplied or written. Unsupported authentication, missing agent/model/tool inventory, or unavailable provider access fails explicitly. The runner preserves canonical correlation IDs and sanitized health counts without storing provider output.

This is HTTP/host acceptance, separate from live UI send/cancel/reconnect acceptance. The existing host binary may differ from the working tree; record its version alongside the result. Failed cleanup is actionable and retains the workspace. Do not rerun paid smoke requests to substitute for investigating a deterministic fixture failure.

## Start investigations from evidence

For an Error Log UUID, first open the authenticated administrator detail surface/API. Record session ID, timestamp, action/kind, and available call/tool/message/task IDs. The UUID indexes the Error Log store; it is not expected in the execution journal. Query with the strongest correlation ID, then inspect gaps:

```sh
bun scripts/journal.mjs show SESSION_ID --grep CALL_ID --dir .cache/qa/RUN/journal
bun scripts/journal.mjs gaps --dir .cache/qa/RUN/journal
```

Fall back to tool/message/task ID or a bounded timestamp window. Read `GET /api/diagnostics/status` through the authenticated app context for queue/write/gap counts and last error. Use the existing diagnostic export/sanitize endpoints for support evidence. The journal intentionally omits deltas and coalesces repeated snapshots; those trims are not gaps. Missing/expired host journals, overflow, parse failures, and sanitization failures qualify any conclusion. Never reconstruct missing detail from the Error Log summary.

See `packages/harness-runtime/DOCUMENTATION.md` and `packages/web/server/lib/diagnostics/DOCUMENTATION.md` for storage, sanitization, authenticated export, and retention contracts.

## Matched retrieval diagnostics

The scenarios **compaction-retrieval-control** and **compaction-retrieval-compacted** investigate retrieval and inference after one manually requested native summary. They require live packaged Electron, Builder and Plan off. They do not establish retention, natural-compaction or automatic-continuation acceptance.

Generate the reviewed six-arm order (control/compacted, compacted/control, control/compacted):

~~~sh
node --input-type=module <<'JS'
import { mkdir, writeFile } from 'node:fs/promises';
import { createQaRetrievalDiagnosticMatrix } from './scripts/qa/compaction-retrieval-diagnostic.mjs';
await mkdir('.cache/qa', { recursive: true });
const config = createQaRetrievalDiagnosticMatrix({
  evidenceRoot: '.cache/qa/retrieval-study',
  providerId: 'xai', modelId: 'grok-4.6', timeoutMs: 1200000,
});
await writeFile('.cache/qa/retrieval-study.json', JSON.stringify(config, null, 2));
JS
DEVRYAN_QA_PACKAGE_EVIDENCE=/absolute/path/to/package-evidence.json \
  bun scripts/qa/run.mjs --config .cache/qa/retrieval-study.json
~~~

Freeze the candidate package, production source and all scripts before starting paid runs. Each arm starts with a fresh owned profile/project/session and the same attachments, diagnosis, revision-2 input and one 256-KiB ordinary audit batch. The runner verifies the saved revised plan, unchanged paused implementation, observed source read and initial native failed test, no prior compaction, and measured usage below the unchanged native threshold. It records differing model-generated plan hashes; mismatched or failed prerequisites remain visible as incomparable arms.

Only the compacted arm sends the actual composer command /compact. Both arms then receive exactly “Continue with the next permitted step from the current state.” A pending question stops the arm without a reply or repair. Question evidence must link the current root assistant and exact pending call; an unresolved historical/unmatched request is classified separately. Provider, native or permission failures remain separate from retrieval evidence. Every arm still receives the normal owned-session cleanup after its evidence and failure screenshot have been captured.

The per-arm retrieval-diagnostic.json preserves canonical summary, tool input/output, exact read/glob/claim ordering, question IDs, before/after saved plans, ordinary input hashes, profile/candidate identity and journal health. Any bounded text truncation is marked. Empty glob output alone is insufficient: a missing-path inference candidate requires a subsequent absence claim, the unchanged saved file, and no successful exact-path recovery. This is human-review triage; a candidate alone records **review-required**, not a proven functional or compaction-induced failure. Questions, changed paused files and repeated completed inspections still fail automated checks.

Aggregate all six records without dropping failed arms:

~~~sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeQaRetrievalStudy } from './scripts/qa/compaction-retrieval-diagnostic.mjs';
const root = '.cache/qa/retrieval-study';
const summary = JSON.parse(await readFile(path.join(root, 'summary.json'), 'utf8'));
const arms = [];
for (const run of summary.runs) {
  const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
  let diagnostic = null;
  try { diagnostic = JSON.parse(await readFile(path.join(run.output, 'retrieval-diagnostic.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  arms.push({ id: result.cell.id, outcome: run.outcome, diagnostic });
}
await writeFile(path.join(root, 'paired-diagnostic.json'),
  JSON.stringify(summarizeQaRetrievalStudy(arms), null, 2));
JS
~~~

Inspect every captured PNG and the exact claim/read/question evidence. The pair report separates comparable and incomparable states, generic interruptions and compacted-only/control-only/both/neither retrieval candidates. It preserves differing plans and failed matrix outcomes. Its three acceptance flags always remain false, including when all observation checks pass. Human classification is required before attributing any loss to compaction or proposing a retrieval or memory change.
