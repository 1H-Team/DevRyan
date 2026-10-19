# Isolated Electron and web QA

QA runs use private data, a Git fixture workspace and loopback fixtures; they never touch the installed app. Passing means the automated checks passed; inspect screenshots yourself before calling a visual change reviewed. Failed runs keep their evidence. Live-account and journal investigation: [Agent runtime verification](AGENT_RUNTIME_VERIFICATION.md). Release steps: [Release pipeline](RELEASE_PIPELINE.md).

## Run directories and disk use

Runners create one run directory per invocation through `scripts/qa/run-root.mjs`, under `<os tmpdir>/devryan-<family>`, with a `run.json` (`status`: `running`, `passed`, `failed`, `interrupted`; `pinned`). The directory is removed on pass, failure and interruption unless `--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1` is set; the runner prints the evidence path when it keeps one. The one exception is the QA packager's `.cache/qa/packaged-electron-current` (below). A packaged QA app is about 1.8 GB: check `df -h .` first and see [STORAGE_CLEANUP.md](STORAGE_CLEANUP.md).

## Isolated QA runner

```sh
bun run type-check:ui
bun run build:web
bun run --cwd packages/electron build:web-assets
bun run qa                                   # web / chat
DEVRYAN_QA_RUNTIME=electron bun run qa
DEVRYAN_QA_SCENARIO=mobile bun run qa        # web only
bun run qa --config <matrix.json>            # cells of runtime x provider x model x scenario
```

`scripts/qa/run.mjs` launches the real Express server and shared UI in a sandboxed Chromium (`web`) or the repository's Electron main process and preload (`electron`) on a private data directory and browser profile, against a deterministic loopback provider fixture. Electron QA rejects a stale staged UI: rerun `build:web-assets` after rebuilding web assets. These are development-binary checks, not packaged-app checks.

| Variable | Meaning |
| --- | --- |
| `DEVRYAN_QA_RUNTIME` | `web` (default) or `electron` |
| `DEVRYAN_QA_SCENARIO` | `chat` (default), `mobile`, `recovery`, `thinking`, `grok-plan`, `session-changes`, `execution-failure`, `skill-loading`, `navigation`, `provider-usage` |
| `DEVRYAN_QA_HOLD_MS` | Keep the runtime up this long after the checks, even on failure, so you can attach to the printed CDP URL |
| `DEVRYAN_QA_RUNTIME_SERVICE=1` | With `electron` + `navigation`: run the Background Runtime Service |

`result.json` records revision, dirty state, scenario, check timings, sanitized errors, screenshot paths, fixture request counts, diagnostic health and cleanup errors; `process-logs.json` has bounded child logs and `journal/` the sanitized journal. A missing build, executable, connection or assertion is a failure, not a skip.

Scenarios beyond `chat` (which selects a session, connects events, runs four concurrent streams, preserves composer text, submits, cancels, and reconnects without resubmission):

- `mobile`: 390x844, 844x390 and 768x1024 in both themes, composer and viewport bounds, touch drawer open/close.
- `recovery`: replays failure/recovery records, checks the recovery card, saved Plan Markdown, Explorer/Designer titles, reload and narrow layouts.
- `thinking`, `grok-plan`, `session-changes`, `skill-loading`, `navigation`: the named feature journeys.
- `execution-failure`: a session error after idle without an assistant, its persistent notice after reload, and failed grouped tools.
- `provider-usage`: weekly usage, native sign-in source, reset expiries and empty inventories in the Providers UI.

The default smoke does not cover new-session creation, attachments, queue policy, permission dialogs, tool expansion or old-history anchoring. Physical-device keyboard and drawer swipes are unverified.

### Matrix configuration

`--config` reads `QA_SCENARIO_IDS` from `scripts/qa/matrix-config.mjs` (`core-journey`, `project-work`, `compaction-manual`, `compaction-natural`, `mobile`, `compaction-retrieval-control`, `compaction-retrieval-compacted`); read that file for the cell fields. Configured live profiles can set `preserveOrchestration: true` (keeps the saved role graph, effort, presets and fallbacks in the private profile; select the orchestrator model in the composer) and `mirrorPersonalSetup` (`true` or `{ plugins, skills, mcp: 'off' | 'definitions' | 'live' }`, requires `preserveOrchestration`; MCP definitions are written disabled and auth state is never copied; see `scripts/qa/live-setup-mirror.mjs`). A run that needs an unavailable provider fails; it never substitutes another model.

### Candidate OpenCode runtime

Live QA expects the runtime to report the host pin (`TARGET_OPENCODE_VERSION` in `packages/web/server/lib/opencode/version-policy.js`). To qualify a candidate first, set an exact version (no `-devryan.N` suffix, no ranges): `DEVRYAN_QA_OPENCODE_VERSION=<version> <usual QA command>`. Evidence records `runtimeTarget: { version, source }`; `source: DEVRYAN_QA_OPENCODE_VERSION` qualifies the candidate only, not the pin.

### Parity manifest

`scripts/qa/parity-manifest.mjs` captures the effective agent runtime catalog of a running isolated host (`scripts/qa/isolated-host.mjs`; take `origin` from its `ready.json`) using GET requests only: health, agents, commands, allowlisted config, MCP status, tools, skills and Slim status. Bodies are stored as sha256 plus length.

```sh
node scripts/qa/parity-manifest.mjs --origin http://127.0.0.1:<port> --directory <workspace> \
  --qa-home <private QA home> --out <baseline.json>
node scripts/qa/parity-manifest.mjs --diff <baseline.json> --origin ... --directory ... --qa-home ... --out <candidate.json>
# or compare saved captures: --diff <baseline.json> --candidate <candidate.json>
```

Use `DEVRYAN_QA_OPENCODE_VERSION` or `--expect-runtime <v>` for a candidate. `--diff` exits 0 only when every section matches; a 404 route is `skipped`, any other failure is `error` (exit 1).

## OpenCode 2 native verification

```sh
node scripts/verify-opencode-v2-native.mjs
```

Darwin arm64. Exercises the native transport (pinned by `TARGET_OPENCODE_VERSION`) and product host against the real web bridge, execution supervisor and mutation ledger in a private directory with no live provider: direct reads, supervised grep, write/edit/patch workers, ambiguous and failed patches, eight concurrent writers, protected paths, BOM/CRLF, cancellation, interrupted publication, controller restart, and managed child completion with Revert/Redo. Output goes to a new `native-*` directory under `.cache/v2-validation/`; `result.json` lists lanes that did not complete.

## OpenCode 2 compiled package

Build a fresh candidate with pinned Bun on Darwin arm64, then qualify it with Node (the entrypoint refuses Bun):

```sh
bun scripts/build-native-runtime.mjs --output-root .cache/v2-validation/native-artifact-candidate
node scripts/verify-opencode-v2-package.mjs --artifact-root .cache/v2-validation/native-artifact-candidate
```

The output directory must be new. Qualification uses the compiled controller and writer with the real web admission owner, scheduler, ledger and supervisor; only HTTP model responses are fixtures. Results land in `.cache/v2-validation/package-*/result.json`; incomplete lanes or changed source keep the exit nonzero. It does not activate a bundle in the installed app. To qualify an upgrade from a retained release, add `--baseline-artifact-root <retained-release-artifacts>` (repository-owned). Lane contracts and case IDs are in [OpenCode 2 native verification scripts](../scripts/opencode-v2-native/DOCUMENTATION.md).

## Packaged Electron QA

`scripts/qa/package-electron.mjs` (macOS arm64, run with Bun) packages a chosen web build with the native binaries from an existing `packages/electron/dist/mac-arm64/DevRyan.app`. Without signing, publishing or a shared native rebuild:

```sh
DEVRYAN_QA_DIST_DIR=/absolute/path/inside/DevRyan/<web-dist> bun scripts/qa/package-electron.mjs
```

It keeps one fixed slot, `.cache/qa/packaged-electron-current/`, replaced by each run, containing the app and `package-evidence.json`. Evidence compares shipped source and UI bytes, checks Electron and native package versions, and runs SQLite and PTY under the packaged executable. The packaged QA host uses fixed packaged resource mode, isolated logs, Chromium's mock keychain, no protocol registration and no Bot background service (recorded in `runtime/packaged-host.json`); signing, updater install, OS keychain and launchd registration are not exercised. The smokes below take `--package-evidence <that file>`.

### First-launch smokes

```sh
node scripts/qa/first-launch-smoke.mjs --package-evidence <abs package-evidence.json> --scenario owner-shaped
```

Provisions the first native bundle on a private HOME, one launch at a time. Scenarios: `owner-shaped` (synthetic v1 tree: 8 project records, 608 plans, Finder files, fake `qa-fixture-*` keys), `v200-half-seed` and `v200-selected` (both need `--v200-source <abs v2.0.0 checkout with node_modules>`; `v200-selected` accepts `--v200-artifacts <dir>`). Other flags: `--timeout-ms`, `--keep-runtime`, `--shell-exports` (checks the app ignores `OPENCODE_*`/`DEVRYAN_RUNTIME_BUNDLE_ROOT` exported by login shell files). PASS requires the loopback app document, `/api/health` `ok` with `isOpenCodeReady`, and `selection.json`; the v1 source tree must be unchanged. FAIL is the first `[electron] startup failed`, the startup or recovery page, an exit, or the timeout. A pre-2.0.0 package is expected to fail `owner-shaped` with `native_setup_json_invalid`.

### Release upgrade lane

```sh
node scripts/qa/release-upgrade-lane.mjs --candidate-artifacts <abs native runtime dir> [--chain v2.0.12,v2.0.15,v2.1.0]
```

Headless, no Electron. It ages one private profile through the previous published releases, oldest first (default: the newest three, from `gh release list`). Each release's own source (`git archive` of its tag, `bun install`) starts its server against the native runtime from its published DMG. That runs the release's own provisioning or startup upgrade, then creates one session and deletes another. Finally this checkout's server cold-starts with the candidate runtime (`packages/web/runtime/darwin-arm64` locally; in `release.yml` the packaged DMG's `revert-runtime`). PASS requires the candidate upgrade to apply, the candidate to be the selected bundle, the production verifier and native readiness to pass, every kept session to survive and every deleted one to stay gone. A refused upgrade in an older hop is recorded, not failed: installed users stay on the runtime it left. After a passing candidate hop, the held-recovery fixture marks the upgraded selection as requiring rollback reconciliation and cold-starts the candidate again: it must start only the recovery composition (`/api/health` 503 with a held runtime, `/api/runtime/bundle` held at the same revision, never ready) and leave the selection unchanged; with the exact selection restored, a normal start must be ready on the same bundle with every kept session. Needs `gh` auth, `hdiutil`, Bun and network; the run root is under `scratchParent('release-upgrade')` and is removed unless `--keep-artifacts`.

### Packaged service smoke

```sh
bun --tsconfig-override "$PWD/packages/ui/tsconfig.json" scripts/qa/packaged-service-smoke.mjs \
  --package-evidence <abs package-evidence.json> --artifact-root <abs native artifact root>
```

Three direct headless launches of the packaged `--runtime-service` in a private fixture: PID and start identity, owner and descriptor generation, unauthenticated refusal, physical drain and restart. It never registers a launchd job.

### Native startup benchmark

```sh
bun scripts/qa/native-startup-benchmark.mjs --package-evidence <abs> --artifact-root <abs> [--baseline-artifact-root <abs>]
bun scripts/qa/native-startup-benchmark.mjs --baseline-package-evidence <abs> --candidate-package-evidence <abs> --artifact-root <abs> [--startup-mode foreground] [--gate no-regression]
```

Three fresh packaged launches through usable chat (native catalog, exact fixture model and agent, composer, sessions and the renderer's event-stream readiness), first document only, no reloads. `--baseline-artifact-root` instead measures first launches after a production startup upgrade from the older native artifacts. The second form runs interleaved baseline/candidate pairs and accepts only a median reduction of at least 5% with all pairs faster. With `--gate no-regression` it runs five interleaved pairs, records (rather than restricts) the changed files, and fails when median time to usable chat grows by more than max(5%, 50 ms). Run benchmarks alone, not beside builds or tests. `DEVRYAN_QA_CATALOG_CONFIG` can point at a sanitized `providers.json` to require specific Cursor models in the catalog.

### Resource benchmark

```sh
bun run perf:electron -- --label candidate --package-evidence <abs package-evidence.json>
bun run perf:electron -- --label candidate --package-evidence <abs> --scenarios session-memory   # or interactive
bun run perf:resource-gate -- --scenarios idle,twelve-stream --baseline <B1/summary.json> --candidate <C1/summary.json> --candidate <C2/summary.json> --baseline <B2/summary.json>
bun run perf:reducer:compare -- --baseline <baseline checkout> [--pairs 10]
```

Private credential-free fixture profiles. Defaults: three runs of `idle`, `one-stream`, `four-stream` and `plan-skeleton`, 5 s warm-up, 30 s measurement, 500 ms sampling. `--scenarios`, `--runs`, `--warmup-ms`, `--measure-ms` and `--output` change that (label shortened runs a smoke), and `--baseline <summary.json>` applies comparison gates. Do not combine `--package-evidence` with `--electron-binary`. Each launch writes `startup.json` with parent-clock milestones. Protocols: `session-memory` loads four 180-turn histories and measures initial, loaded, inactive and deleted states; `interactive` is described in [INTERACTIVE.md](../scripts/perf/INTERACTIVE.md). The opt-in `twelve-stream` scenario seeds eight extra root sessions before launch and streams all twelve. Every streaming run records how many sessions actually streamed through the measurement window and fails when fewer than its workload did.

`perf:resource-gate` is the no-regression gate over separate single-package benchmark runs taken alternately (B C C B …) with identical options and `--output` under the OS temp dir. It fails on median total-app CPU growth above max(5%, 1 percentage point) or median/p95 total working-set growth above max(5%, 16 MiB), and refuses mismatched protocols, Chromium runtimes, process types, unpaired or non-interleaved runs. `perf:reducer:compare` runs the reducer benchmark alternately from a baseline checkout (a worktree under `.cache/worktrees/`) and this one, and per scenario allows max(5% of the baseline median p95, 3 × its median absolute deviation); an allowance above 15% is reported as too noisy to qualify. Other profiling tools live in `scripts/perf/`.

## Configured live-provider smoke

`bun scripts/qa/provider-access-smoke.mjs --allow-live <bundle-root> <output> [openai|xai]` sends one short direct request per provider using the current token in memory (OpenAI also three tool-bearing requests). It uses real provider credentials: only run it when the user has authorized it for that provider.

## Investigations

Read the journal first: `bun scripts/journal.mjs show SESSION_ID --grep CALL_ID --dir <run>/journal` and `bun scripts/journal.mjs gaps --dir <run>/journal`. Layout, retention and Error Log correlation: [Agent runtime verification](AGENT_RUNTIME_VERIFICATION.md). Storage, sanitizer and export contracts: `packages/harness-runtime/DOCUMENTATION.md` and `packages/web/server/lib/diagnostics/DOCUMENTATION.md`.

`node scripts/qa/native-profile-factory-diagnostic.mjs --artifact-root <abs>` starts a credential-free disposable host (add `--hold-chatgpt-signin` to keep it up for a human sign-in; it prints the loopback origin and journal directory and waits for SIGINT).
