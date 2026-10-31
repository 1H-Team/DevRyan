# Isolated Electron and web QA

QA runs use private data, a Git fixture workspace and loopback fixtures; they never touch the installed app. Passing means the automated checks passed; inspect screenshots yourself before calling a visual change reviewed. Use `--keep-artifacts` to retain failed-run evidence. Live-account and journal investigation: [Agent runtime verification](AGENT_RUNTIME_VERIFICATION.md). Release steps: [Release pipeline](RELEASE_PIPELINE.md).

## Run directories and disk use

Runners create one run directory per invocation through `scripts/qa/run-root.mjs`, under `<os tmpdir>/devryan-<family>`, with a `run.json` (`status`: `running`, `passed`, `failed`, `interrupted`; `pinned`). The directory is removed on pass, failure and interruption unless `--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1` is set; the runner prints the evidence path when it keeps one. The one exception is the QA packager's `.cache/qa/packaged-electron-current` (below). A packaged QA app is about 1.8 GB: check `df -h .` first and see [STORAGE_CLEANUP.md](STORAGE_CLEANUP.md).

A live run carries a constructor-owned scope tied to its canonical directory and
device/inode through fixture and native preparation. The token cannot authorize
a sibling run, a replaced root or a symlink escape. Native inputs and compiled
artifacts retain their pinned repository-owned verification. Retained provider
handoff profiles use private `.cache/qa`: registration and later resume processes
need the existing pinned-file readers, rather than an in-memory scope token.

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

`result.json` records revision, dirty state, scenario, check timings, sanitized errors, screenshot paths, fixture request counts, diagnostic health and cleanup errors; `process-logs.json` has bounded child logs and `journal/` the sanitized journal. A missing build, executable, connection or assertion is a failure, not a skip.

Scenarios beyond `chat` (which selects a session, connects events, runs four concurrent streams, preserves composer text, submits, cancels, and reconnects without resubmission):

- `mobile`: 390x844, 844x390 and 768x1024 in both themes, composer and viewport bounds, touch drawer open/close.
- `recovery`: replays failure/recovery records, checks the recovery card, saved Plan Markdown, Explorer/Designer titles, reload and narrow layouts. Completed task execution is shown separately from pending, stale, failed and passed checks; a scoped fixture also exercises the current root-objective verification panel and objective changes on desktop and mobile. Fixture-owned managed task updates enter the isolated page through scoped app WebSocket/SSE wire frames, with matching snapshot reads; they do not qualify native OpenCode event projection, actual check execution or scheduler execution. The saved-plan route uses the production file owner with a fixture-scoped simulated source identity and settlement; it does not establish native plan authority. The saved plan is from a separate human follow-up; a receipt-backed plan continued from a synthetic wake is not qualified. Child title checks use the production title coordinator with a scoped simulated source and deterministic fixture model, not native helper authorization.
- `session-changes`: exercises isolated capture and disabled Undo for unowned evidence. A narrowly scoped UI transport simulates stale proof rejection, refresh and fresh Undo/Redo proof revisions; it does not mutate files or qualify a native restore. Native ownership and restore are covered by the compiled package lanes.
- `thinking`, `grok-plan`, `skill-loading`, `navigation`: the named feature journeys.
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

It keeps one fixed slot, `.cache/qa/packaged-electron-current/`, replaced by each run, containing the app and `package-evidence.json`. Evidence compares shipped source and UI bytes, checks Electron and native package versions, and runs SQLite and PTY under the packaged executable. The packaged QA host uses fixed packaged resource mode, isolated logs, Chromium's mock keychain, no protocol registration and no background runtime service (recorded in `runtime/packaged-host.json`); signing, updater install, OS keychain and launchd registration are not exercised. The smokes below take `--package-evidence <that file>`.

### First-launch smokes

```sh
node scripts/qa/first-launch-smoke.mjs --package-evidence <abs package-evidence.json> --scenario owner-shaped
```

Provisions the first native bundle on a private HOME, one launch at a time. Scenarios: `owner-shaped` (synthetic v1 tree: 8 project records, 608 plans, Finder files, fake `qa-fixture-*` keys), `v200-half-seed` and `v200-selected` (both need `--v200-source <abs v2.0.0 checkout with node_modules>`; `v200-selected` accepts `--v200-artifacts <dir>`). Other flags: `--timeout-ms`, `--keep-runtime`, `--shell-exports` (checks the app ignores `OPENCODE_*`/`DEVRYAN_RUNTIME_BUNDLE_ROOT` exported by login shell files). PASS requires the loopback app document, `/api/health` `ok` with `isOpenCodeReady`, and `selection.json`; the v1 source tree must be unchanged. FAIL is the first `[electron] startup failed`, the startup or recovery page, an exit, or the timeout. A pre-2.0.0 package is expected to fail `owner-shaped` with `native_setup_json_invalid`.

### Release upgrade lane

```sh
node scripts/qa/release-upgrade-lane.mjs --candidate-artifacts <abs native runtime dir> [--direct-baseline previous|vX.Y.Z | --chain vA,vB]
```

Headless, no Electron. Upgrades are supported from v2.0.0 (`SUPPORTED_UPGRADE_FLOOR`) on; the lane refuses an older baseline, and for the floor release itself, with no published baseline, it records `skipped: first-supported-release` and passes. By default it prepares one private profile with the previous supported release: the newest published release from the floor up to this checkout's version (from `gh release list`). `--chain` ages the profile through several supported releases, oldest first. Each release's own source (`git archive` of its tag, `bun install`) starts its server against the native runtime from its published DMG. That runs the release's own provisioning or startup upgrade, then creates one session and deletes another. Finally this checkout's server cold-starts with the candidate runtime (`packages/web/runtime/darwin-arm64` locally; in `release.yml` the packaged DMG's `revert-runtime`). PASS requires the candidate upgrade to apply, the candidate to be the selected bundle, the production verifier and native readiness to pass, every kept session to survive and every deleted one to stay gone. The lane seeds the profile's `~/.config/openchamber` (an installed app always has it); the first aging release or candidate that supports the data-root migration must move it whole to `~/.config/devryan` and leave `~/.config/openchamber` as a link to `devryan`. If an aging release already migrated the root, the candidate must preserve that link and every entry in the DevRyan folder (evidence `dataRoots`). A refused upgrade in an older hop is recorded, not failed: installed users stay on the runtime it left. After a passing candidate hop, the held-recovery fixture marks the upgraded selection as requiring rollback reconciliation and cold-starts the candidate again: it must start only the recovery composition (`/api/health` 503 with a held runtime, `/api/runtime/bundle` held at the same revision, never ready) and leave the selection unchanged; with the exact selection restored, a normal start must be ready on the same bundle with every kept session. Needs `gh` auth, `hdiutil`, Bun and network; the run root is under `scratchParent('release-upgrade')` and is removed unless `--keep-artifacts`.

### Direct supported release upgrades and immutable DMG observation

Installed Electron qualification is separate from the headless runtime lane below. `node scripts/qa/release-installed-upgrades.mjs X.Y.Z <absolute DMG> <absolute release-manifest.json> <absolute report.json> candidate` runs serial isolated upgrades from v2.0.0 and the previous release; each lane qualifies only the upgrade, since `visual-qa` already checked the candidate's own launch. Every lane checks the baseline's startup and version, the offer, download, native installer restart and retained private settings; a skipped upgrade fails the matrix. Installer preparation runs inside the restart IPC; the main-process observer records its outcome, so a refused preparation fails the lane at once with its product code and sanitized diagnostic (for example `native_runtime_artifacts_unverified` with stage, reason and purpose) instead of a five-minute missing-receipt timeout. `candidate` pins the exact unchanged DMG through a loopback transport fixture injected only into the isolated app's paused main-process inspector. It leaves the shipping feed and updater untouched. `public` repeats only the previous-release lane through the real canonical GitHub feed after publication. Both modes require a disposable macOS arm64 GitHub runner, public baseline downloads and Electron CDP/inspector support; they never run alongside the owner's app or use `/Applications`. Visual QA and candidate installed upgrades must pass before tagging; public installed upgrades are a read-only post-publication gate. Reports/screenshots survive cleanup; private profiles do not. See [Release visual QA](RELEASE_PIPELINE.md#release-visual-qa) for the transport and isolation contract.

`release.yml` starts `scripts/qa/release-preaged-upgrades.mjs <absolute report directory>` independently of packaging. It prepares the previous-supported-release profile (`upgrade-previous.json`) before waiting for the candidate. Aging lanes are retired: upgrades from releases older than v2.0.0 are out of scope. Baseline GitHub installer digests and pinned source revisions are recorded; verified baseline inputs are shared only within this run. The coordinator then polls the exact workflow run's package producer and artifacts within one shared 60-minute deadline across baseline preparation and acquisition retries (the cold web/package path allows 55 minutes plus five minutes for queues; the qualification job has an 85-minute cap), verifies source/run/producer-attempt identity and DMG bytes, and extracts the runtime once. Each profile's candidate hop, migration/history checks and held recovery run sequentially. A before/after tree digest rejects mutation of the candidate runtime. No profile or passing qualification result is cached or uploaded.

Local single-lane use accepts `--direct-baseline vX.Y.Z` (v2.0.0 or later) with `--candidate-artifacts`. The existing `release-upgrade-lanes.mjs --candidate-artifacts <dir> --report-dir <dir> --sequential` command remains available when a candidate already exists. Every direct baseline must start and create/delete fixture sessions; an empty provisioned profile cannot pass.

Setup failures are classified by `scripts/qa/release-qualification-failure.mjs`. `infra` (a failed `gh`, `git`, `tar`, `ditto`, `bun` or `hdiutil` command, a network error or timeout, a busy disk image, a corrupt baseline download) is retried once inside the job; `product` (a candidate hop, migration, history or held-recovery failure, a changed candidate runtime, a failed producer) is never retried, and an unknown failure counts as `product`. The job log and the lane report carry the class and the bounded error text (`failureClass`, `error`), not only a code.

Each `upgrade-<lane>.json` report contains sanitized evidence and phase timings for baseline downloads/installations, historical hops, candidate hops, held recovery, report writing and profile deletion. `qualification-timings.json` includes shared-input cleanup and candidate waiting/extraction. CLI process-exit time is logged. Reports are updated after measured cleanup; `--fallback-reports` creates failing incomplete reports if setup never reached a lane. Only reports leave the qualification runner. Interruption stops owned subprocesses and detaches owned DMGs before scratch deletion; private profiles and source/install scratch are removed on success, failure and interruption unless explicitly retained locally. The CI workflow never enables retention of private scratch.

The separate `scripts/qa/release-final-dmg-smoke.mjs --dmg <absolute DMG> --report <absolute JSON>` refuses local execution: it launches the production bundle only on a disposable macOS arm64 GitHub runner with the same console user. It mounts the unchanged DMG read-only, uses a private HOME/profile, and checks ready health plus a visible composer within 120 seconds. It imports an ordinary private custom-provider configuration pointing only to the credential-free loopback fixture, registers the private workspace as a project (Electron starts in HOME, so an unregistered folder is not a native location) and pins the helper model to the fixture, so session titles never reach the default hosted helper. It then requires a real native read, published write, and final assistant response within a further 60 seconds; the fixture answers only the shipped title helper's own prompt outside that tool turn. On failure the report keeps bounded, sanitized evidence: the error code and message (run paths replaced, opaque tokens removed), refusal status codes, provider request and error codes, the session's message and tool states, diagnostic counters, a journal gap count with recent record identifiers, a `failure.png` screenshot, and which cleanup step failed. A fixture failure rethrown by the provider's close is round-trip evidence, not a cleanup failure. A CDP screenshot and physical shutdown are required. It performs no paid model request and uses no constructor-only QA configuration hook. Evidence is uploaded even when prerequisites or setup fail; scratch is removed on normal completion and interruption. This is a startup smoke, not proof of updater installation or native service migration. It is no longer a workflow job: it failed every release run because Builder's shipped model was unavailable in the private profile ([Release pipeline](RELEASE_PIPELINE.md#final-dmg-smoke-retired-from-the-workflow)). The required `scripts/qa/release-visual-qa.mjs` replaces it on dry runs ([Release visual QA](RELEASE_PIPELINE.md#release-visual-qa)): it copies the DMG's app with `ditto` into a private run root, launches it on a private HOME/XDG profile over CDP, screenshots the splash, the ready window and About, and checks for an update against the real feed, optionally updating the previous release in place once the candidate is published. It refuses to run beside the owner's app.

Qualification commands wait in a POSIX shell until OS process ownership is
observed, then exec with the same PID. Even instant commands retain cleanup
evidence. Failed-command reports include the executable basename and exit
code plus a bounded stderr tail with run paths replaced and opaque tokens removed,
never arguments.
The dedicated DMG mount scope owns attach/detach and its disk-image helpers;
ordinary command cleanup must not stop those helpers before extraction finishes.
The final-DMG profile pins the helper model and saves Builder model and thinking
level selections before UI submission; saved agent selections apply only to managed
users, which is the quarantined smoke defect.

### Native startup benchmark

```sh
bun scripts/qa/native-startup-benchmark.mjs --package-evidence <abs> --artifact-root <abs> [--baseline-artifact-root <abs>]
bun scripts/qa/native-startup-benchmark.mjs --baseline-package-evidence <abs> --candidate-package-evidence <abs> --artifact-root <abs> [--startup-mode foreground] [--gate no-regression]
```

Three fresh packaged launches through usable chat (native catalog, exact fixture model and agent, sessions and event readiness, plus a trusted pointer click focusing an unobstructed composer and exact unsent draft entry), first document only, no reloads. `--baseline-artifact-root` instead measures first launches after a production startup upgrade from the older native artifacts. The second form runs interleaved baseline/candidate pairs and accepts only a median reduction of at least 5% with all pairs faster. With `--gate no-regression` it runs five interleaved pairs, records (rather than restricts) the changed files, and fails when median time to usable chat grows by more than max(5%, 50 ms). Run benchmarks alone, not beside builds or tests. `DEVRYAN_QA_CATALOG_CONFIG` can point at a sanitized `providers.json` to require specific Cursor models in the catalog.

### Resource benchmark

The resource runner boots its private native host normally, waits for native readiness, focuses only its owned window through the preload acknowledgement, seeds its private last-directory storage for every scenario, and registers/navigates to the existing loopback wire facade before fixture checks. Its `startup.json` reports **fixture-ready latency**, including this controlled setup; it does not qualify natural first-document native startup. Use the separate native startup benchmark for that claim. Resource sampling still starts after fixture checks and warm-up, and visible-document admission remains required. OS-temp facade paths require the exact live constructor-owned run scope; arbitrary temp paths, symlinks and expired or foreign scopes remain refused. Memory history witnesses use authenticated v2 reads and core message projection without fetching extra pages into the independent UI pagination proof. The runner fingerprints these launch/facade owners, so results from the earlier legacy launch protocol cannot be pooled with these runs.

```sh
bun run perf:electron -- --label candidate --package-evidence <abs package-evidence.json>
bun run perf:electron -- --label candidate --package-evidence <abs> --scenarios session-memory   # or interactive
bun run perf:resource-gate -- --scenarios idle,twelve-stream --baseline <B1/summary.json> --candidate <C1/summary.json> --candidate <C2/summary.json> --baseline <B2/summary.json>
bun run perf:reducer:compare -- --baseline <baseline checkout> [--pairs 10]
```

Private credential-free fixture profiles. Defaults: three runs of `idle`, `one-stream`, `four-stream` and `plan-skeleton`, 5 s warm-up, 30 s measurement, 500 ms sampling. `--scenarios`, `--runs`, `--warmup-ms`, `--measure-ms` and `--output` change that (label shortened runs a smoke), and `--baseline <summary.json>` applies comparison gates. Do not combine `--package-evidence` with `--electron-binary`. Each launch writes `startup.json` with parent-clock milestones. Protocols: `session-memory` loads four 180-turn histories and measures initial, loaded, inactive and deleted states; `interactive` is described in [INTERACTIVE.md](../scripts/perf/INTERACTIVE.md). The opt-in `twelve-stream` scenario seeds eight extra root sessions before launch and streams all twelve. Every streaming run records how many sessions actually streamed through the measurement window and fails when fewer than its workload did.

The wire facade archives only IDs owned by its disposable fixture, through the existing serialized client archive contract; it cannot archive real native sessions. Packaged history measurements boot the native host but render synthetic sessions without model prompts, so they do not qualify live-provider initialization or controller retention. `--package-evidence` pins the retained packaged source identity and immutable payload hashes; later worktree edits are not part of that snapshot. Driver protocol changes require separate results, not cross-protocol comparisons.

`perf:resource-gate` is the no-regression gate over separate single-package benchmark runs taken alternately (B C C B …) with identical options, `QA_NATIVE_ARTIFACT_ROOT` set to the verified native artifacts, and the default `--output` under `scratchParent('perf')` (fixture profiles carry their exact owned run scope; the benchmark removes them). It fails on median total-app CPU growth above max(5%, 1 percentage point) or median/p95 total working-set growth above max(5%, 16 MiB), and refuses mismatched protocols, Chromium runtimes, process types, unpaired or non-interleaved runs. `perf:reducer:compare` runs the reducer benchmark alternately from a baseline checkout (an isolated worktree, for example under a canonical OS-temp audit root) and this one, and per scenario allows max(5% of the baseline median p95, 3 × its median absolute deviation); an allowance above 15% is reported as too noisy to qualify. Other profiling tools live in `scripts/perf/`.

## Focused Claude and Cursor regression

The Claude (`anthropic`) arm below was built on the removed Meridian proxy: `live-credential-owner.mjs` now refuses it with `qa_live_anthropic_retired`, and its five-hour budget does not fit `claude-agent`, whose usage arrives only with each reply. Until an attended `claude-agent` flow exists, qualify Claude with an isolated host whose `CLAUDE_CONFIG_DIR` login you create and remove yourself (`runtime-host/DOCUMENTATION.md`, "Claude Code through claude-agent"). The Cursor arm is unchanged.

`focused-provider` is an opt-in live Builder scenario with Plan off and one repetition. It runs a short prompt, reload, a follow-up that must recall the original assistant reply without repeating it in the new prompt, cancellation after a correlated physical provider request with a canonical aborted assistant, browser disconnection/reconnection and successful continuation, then a native source read and confined, receipt-backed proof-file publication. It does not run project implementation or delegation. Use one exact model/effort per provider for both hosts; discover Claude's advertised default in the isolated account catalog and freeze that tuple before preparing inputs. Cursor's existing QA tuple is `cursor-acp/grok-4.6` / `medium`; unavailable selections fail.

First run the credential-free factory diagnostic:

```sh
node scripts/qa/native-profile-factory-diagnostic.mjs --artifact-root <absolute-artifact-root>
```

Its final JSON includes `advertisedClaudeDefault` from `GET /api/provider?directory=<private-workspace>`: `default.anthropic` must name a model in `all[id=anthropic].models` with `capabilities.toolcall: true`. A null result means discovery did not establish a choice; do not guess one. The provider list's default is the native configured default when that provider is selected, otherwise its first enabled model in native catalog order. Discovery requires no Claude login or inference. Use that exact returned model ID below and require actual account availability during the live preflight.

Prepare each provider separately with the current verified native artifact and a new private directory below `.cache/qa`:

```sh
node scripts/qa/focused-provider-inputs.mjs <absolute-artifact-root> <absolute-new-output-root> anthropic <exact-model-id> default
node scripts/qa/focused-provider-inputs.mjs <absolute-artifact-root> <different-absolute-new-output-root> cursor-acp grok-4.6 medium
```

The helper creates credential-free reviewed configuration, pins all packaged role and Council routes and the helper model to the selected provider, resolves the actual saved graph through the compiled native configuration owner, rejects foreign provider routes, and removes its temporary graph probe. An owned run directory removes partial output on failure or interruption; only successfully prepared handoff inputs are retained. It reads no personal profile and performs no inference. `default` means the provider default reasoning policy (`variant: null`), not an unpinned model. Each generated matrix runs web then Electron sequentially. Its JSON output supplies the mirror/matrix hashes and evidence root for:

```sh
node scripts/qa/live-credential-owner.mjs --artifact-root <absolute-artifact-root> \
  --mirror <preparationFile> --mirror-sha256 <mirrorSha256> \
  --matrix <matrixFile> --matrix-sha256 <matrixSha256> --evidence-root <evidenceRoot>
```

Keep the attended launcher terminal open. The human opens its single-use owner link and signs in only to the independent provider account using the isolated Providers flow (Claude's explicit isolated vendor login command is also printed). Send one JSON command per line: `{"command":"hold-and-verify"}`, then `{"command":"run"}`, then `{"command":"close"}`. Native credentials use the existing held source and canonical candidate CAS owner; Claude uses its access-only platform-store owner. Cursor-only runs do not require Claude login or candidate admission. No credential file is manually copied.

The attended source owns a private `claude-budget.json` with the initial five-hour usage, reset identity, last sample and in-flight/stopped state. It captures the initial values from the first fresh canonical `/api/quota/claude` read and reads quota again before and in a finally block after each generation in both host cells. Matrix calls must receive this owner-held budget; they cannot create a replacement. Reusing the source preserves the same baseline, and reopening an interrupted in-flight budget refuses traffic. Routine work stops at six percentage points, preserving four of the ten authorized points for deliberate retests; when account headroom is smaller, routine admission is reduced to preserve four remaining account points and refuses entirely at 96% used. Missing/stale quota, a changed reset, decreasing usage or usage changes between turns refuse further requests. The bounded constructor `createQaClaudeBudget({baseline, retest: true})` requires the original `{usedPercent, resetAt}` for a retest; the ordinary launcher never spends the reserve automatically. Do not start another launcher with a fresh baseline to bypass this limit. Percentage reporting cannot guarantee a single in-flight request will not overshoot; outputs are bounded and traffic is serial. Coordinate the first baseline with any earlier paid probes in the same authorization window.

Evidence includes canonical turn/tool IDs, native observation completeness, publication operation and confinement receipt, cancellation/recovery witnesses and budget samples. Require zero journal gaps and review screenshots separately. Runtime profiles remain private to the attended owner; its close summary lists provider sign-out and isolated platform-store cleanup obligations. The original shared saved-graph and source identity checks remain enforced.

## Configured live-provider smoke

`bun scripts/qa/provider-access-smoke.mjs --allow-live <bundle-root> <output> [openai|xai]` sends one short direct request per provider using the current token in memory (OpenAI also three tool-bearing requests). It uses real provider credentials: only run it when the user has authorized it for that provider.

## Investigations

Read the journal first: `bun scripts/journal.mjs show SESSION_ID --grep CALL_ID --dir <run>/journal` and `bun scripts/journal.mjs gaps --dir <run>/journal`. Layout, retention and Error Log correlation: [Agent runtime verification](AGENT_RUNTIME_VERIFICATION.md). Storage, sanitizer and export contracts: `packages/harness-runtime/DOCUMENTATION.md` and `packages/web/server/lib/diagnostics/DOCUMENTATION.md`.

`node scripts/qa/native-profile-factory-diagnostic.mjs --artifact-root <abs>` starts a credential-free disposable host (add `--hold-chatgpt-signin` to keep it up for a human sign-in; it prints the loopback origin and journal directory and waits for SIGINT).
