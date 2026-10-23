# DevRyan Testing

## Commands

| Command | Use |
| --- | --- |
| `bun run validate` | The local gate before every push and release tag. Diffs against the upstream branch (override with `VALIDATE_BASE`) and runs only what the change touches. |
| `bun run validate:full` | Lint, import boundaries, the browser graph, type-check, `docs:validate`, build (once), `bundle:check` and `test:full`. CI runs these same checks across its build and test lanes. |
| `bun run test:startup` | Curated startup and user-data contract. |
| `bun run test:full` | Scripts, the visual fixture and every package suite, as one bounded concurrent pool (`node scripts/test-full.mjs [--suite=web,ui]`). |
| `bun run docs:validate` | Markdown links and inline-code paths. |

`bun run validate` runs:

- oxlint on changed files;
- type-check of changed packages and their dependents (everything when root `package.json`, `bun.lock`, `.oxlintrc.json`, `tsconfig.json`, `vite-theme-plugin.ts` or `.opencode/opencode.json` change);
- tests of changed packages and their dependents;
- `test:scripts` when `scripts/`, `.github/` or `.opencode/agents|plugins` change;
- `docs:validate` when Markdown changes;
- import boundaries and the browser graph when package code changes (every importer when a package manifest, `scripts/import-boundaries.json` or a checker changes);
- `test:startup`, always: each startup group whose owner suite already runs in the same plan runs there instead of twice.

A change confined to the `version` fields that `scripts/bump-version.mjs` writes (package manifests, workspace versions in `bun.lock`, the legacy Tauri `tauri.conf.json`, `Cargo.toml` and the `devryan-desktop` entry in `Cargo.lock`) runs `node scripts/release.mjs check-versions` (every version file and `bun.lock` workspace agrees) instead of every package's lint, type-check and tests. Any other change to those files keeps the full shared-configuration plan. CI still runs everything for the bump commit before release admission.

Independent static checks run concurrently and all report, and any failure stops before tests. In `validate:full` the build and bundle budgets then run in order beside the test pool, and `scripts/built-web-assets.test.mjs` (the only test that reads the build output) runs after the build; in `validate` (fast) the build chain still precedes tests. Test commands run as one weighted pool of independent processes within a capacity of `DEVRYAN_TEST_CONCURRENCY` (default: half the cores, between 2 and 4). A unit reserves its `weight` (default 1): the Vitest `web` project and the harness suite start their own workers and weigh 2. Local runs split the serial `node --test` script batch into three timing-balanced shards and the web runtime-host project into two (`localTestUnits` in `scripts/test-ci-lanes.mjs`; CI lanes use their own inventory). While the host's 1-minute load average is above its core count, the pool starts no further unit (one always runs), so concurrent runs on one machine (other worktrees, a build) queue instead of driving timeouts; `DEVRYAN_TEST_LOAD_LIMIT` sets the ceiling as a multiple of the cores and `0` disables it. Every unit has a wall-clock budget (`DEVRYAN_TEST_UNIT_TIMEOUT_MS`, default 20 minutes) after which its process group is killed and it fails as timed out; script `node --test` files also get `--test-timeout=300000` and `--test-force-exit`. Each Bun package run gets the cores the pool leaves it (`--parallel=<cores / DEVRYAN_TEST_CONCURRENCY>`, at least two, scaled by a heavy unit's weight; `DEVRYAN_TEST_WORKERS` overrides), each unit's output printed whole when it ends, a heartbeat naming running units every minute, every unit run to completion and every failure listed. Native graph test files share one exclusive pool resource: they build and spawn the pinned runtime, and the shared fixture's browser OAuth callback binds localhost:1455. Independent units keep running alongside them. Interrupting stops every owned process group and removes the run's scratch. Both modes end with per-command and slowest-unit timings.

`scripts/check-import-boundaries.mjs` resolves static, re-export, `require` and literal dynamic imports between packages. Application packages (web, Electron, the Bot services) expose only their `main`/`exports`; a package that declares `exports` exposes only those targets, by package name or relative path. Tests (`*.test.*`, `*.spec.*` and files under a `tests/` directory) may import another package's private files, since parity and integration tests exercise both sides; they are still refused a package-name import that the target's `exports` omit. Each temporary exception in `scripts/import-boundaries.json` (production code only; currently none) is one exact importer/target pair with the plan stage that removes it (`unscheduled` when none does yet); an exception that no longer matches fails, so the list only shrinks. No exception covers a package-name import of a subpath the target's `exports` omits, because Node refuses that import at runtime. `scripts/check-browser-graph.mjs` walks the web Vite entry points with the build's aliases and fails on Node builtins, `adm-zip`, or a web-server, Electron, Bot-service or Node-only shared-runtime file.

A docs-only change runs only `docs:validate`. Both validate modes fail if the run left new entries in `.cache/` (see [STORAGE_CLEANUP.md](STORAGE_CLEANUP.md)).

## CI

`.github/workflows/ci.yml` runs on every main push and pull request. Every job starts at once; none waits for another and no artifacts move between them:

- `static` (Ubuntu): `node scripts/validate.mjs static` — lint, import boundaries, the browser graph, type-check and `docs:validate`, run concurrently.
- `build` (Ubuntu): `node scripts/validate.mjs build` — the build, bundle budgets and the tests of the built assets (`BUILD_JOB_TESTS` in `scripts/test-ci-lanes.mjs`, such as `scripts/built-web-assets.test.mjs`).
- `tests` (two Ubuntu lanes): `node scripts/validate.mjs ci:<lane>` with the normal scratch guard.
- `native-tests` (three macOS lanes): build and verify the native v2 runtime in-lane (cheaper than shipping it between jobs), then run their lane. GitHub Free runs five macOS jobs at a time and a release holds two while it waits for CI, so three is the most CI may use.

`scripts/test-ci-lanes.mjs` expands the full suite into files before assigning platforms; it keeps macOS sandbox, native binary, case-insensitive filesystem and platform-gated checks on macOS. Units are packed onto lanes longest first from the recorded durations in `scripts/test-unit-timings.json` (a unit without a recording costs the median); the web runtime-host Vitest project runs as two shards. Every lane uploads its unit timings as the `test-timings-<lane>` artifact; refresh the recordings with `bun run test:timings:update <files...>`. The native-stream file has two disjoint case shards (ordinary local runs register every case); `test-suite-contract.test.mjs` checks the complete inventory and shard union, and that a case-sharded file registers every test through its shard filter. CI runs Bun package suites in randomized order seeded with the workflow run number (`DEVRYAN_TEST_SEED`). Main-push concurrency is unique to the commit SHA and never cancels a different main commit; superseded PRs still cancel. Release preparation overlaps CI, but publication requires the exact main-push workflow to pass. `bun run validate:full` remains the equivalent complete local gate. `release-cache.yml` is manual-only; see [Release pipeline](RELEASE_PIPELINE.md).

Measured and deliberately not adopted (2026-10): caching `tsbuildinfo` or the Vitest module cache in CI (TypeScript 7 type-checks every package in about 10 s and transforms are 1–2% of Vitest time), parallel `node --test` for the script suite (no speedup; deadline-sensitive tests fail under contention), and moving hazard-free web tests to `bun test` (they rely on Vitest APIs such as `vi.waitFor`, and parallel Vitest already runs them in under a minute).

## Startup contract

`scripts/test-startup-contract.mjs` runs the startup and user-data tests: runtime bundle startup, selection and upgrade, ledger and session integrity, Retry, cancellation, delayed bootstrap, event subscription, and Electron startup and ownership. It uses disposable fixtures only: no installed-app data, live accounts or OS service registration. `STARTUP_CONTRACT_GROUPS` names each group's owner suite (`electron`, `scripts`, `shared`, `harness`, `ui`, `web`); `--covered-by=<suite,...>` skips groups already covered elsewhere in the same run.

## Suites and runners

`test:full` runs every suite below, including the bundled Plan Mode contract in the frozen legacy Tauri package. Cargo tests are not run because they require native build assets. `FULL_TEST_SUITES` in `scripts/test-full.mjs` is the inventory. The pool splits three suites without changing what they run: one process per script Bun test file, the two Vitest projects of the web suite (`test:vitest --project=web|web-runtime-host`) beside its Bun native files (`test:native`), and the harness suite with Bun file workers (`bun test --parallel=4`). `scripts/test-suite-contract.test.mjs` checks every split runs each file exactly once.

Set `DEVRYAN_TEST_TIMINGS=<file.json>` to record each unit's duration and status. Set `DEVRYAN_TEST_SEED=<n>` to run Bun package suites in randomized order (`--randomize --seed=<n>`); a failure reproduces with the same seed. Tests must not depend on the order of other tests: reset shared stores, module-level mocks and globals in `beforeEach`, not only `afterEach`.

Expensive invariants are tested at the smallest size that crosses the boundary. Production limits that tests must exceed (ledger install batches, the change-store listing bound, the admission dedupe cache) are constructor options with unchanged defaults, so a test crosses them with a few hundred records instead of tens of thousands. Create test Git repositories with `initGitRepository()` from `scripts/test-git-template.mjs` (a copied template, about ten times faster than `git init`).

| Suite | Command | Runner |
| --- | --- | --- |
| Scripts, `.opencode/agents` and `.opencode/plugins` tests, reviewed runtime inputs | `bun run test:scripts` | `scripts/test-scripts.mjs`: files importing `bun:test` run one per `bun test` process (never sharing Bun's resolver), the rest in one `node --test` run, all through the bounded pool. `DEVRYAN_SCRIPT_TEST_CONCURRENCY` sets Node concurrency (default: one file at a time inside the outer pool). |
| Visual fixture | `bun run test:visual-fixture` | `bun test` |
| Shared UI | `bun run --cwd packages/ui test` | `scripts/test-ui.mjs`: one `bun test --parallel` run; every file gets its own global and module registry, so `mock.module` and global replacements cannot leak |
| Web | `bun run --cwd packages/web test` | `test:vitest` (`vitest.config.ts`: project `web` file-parallel with a 15 s test budget; project `web-runtime-host` with two workers for the native runtime-host suites; no app build plugins), then `test:native`: three native-host files and the native integration directory under `bun test`. Native host scripts: `bun run --cwd packages/web test:native-host`. |
| Electron | `bun run --cwd packages/electron test` | `scripts/test-electron.mjs` routes by import: `node:test` to Node (concurrent files), `bun:test` to one `bun test --parallel` run; any other framework is refused |
| Legacy Tauri JavaScript contract | `bun run --cwd packages/desktop test:managed-orchestration` | `bun test` |
| `bots-runtime`, `bot-supervisor`, `bot-engine-proxy`, `bot-egress`, `bot-computer`, `bot-db`, `shared-runtime`, `harness-runtime`, `orchestration-runtime`, `cursor-sdk-runtime` | `bun run --cwd packages/<name> test` | `bun test` |
| `bot-indexer` | `bun run --cwd packages/bot-indexer test` | `node --test` |

Runner and discovery changes belong in `scripts/`. Feature tests live beside their source unless a contract spans packages.

## Policies enforced by lint

Module-graph rules that used to be source-text tests (a component must not import an eager dialog, a removed surface, or a heavy renderer; a file must not own timers) live in `.oxlintrc.json` `overrides` as path-scoped `no-restricted-imports` and `no-restricted-globals` rules, so `bun run lint` enforces them once instead of a test reading the source. Tests assert behaviour: rendered markup, calls and state, not the text of the implementation. Keep a source read only for a genuine text contract (CSS rules, generated assets, documentation).

## Test-suite contract

`scripts/test-suite-contract.test.mjs` fails when a test file is not discovered by its package runner, when a deterministic test uses `skip` or `todo`, or when the feature matrix is stale. Do not silence a scenario: delete tests for removed behavior or rewrite them for the current contract. Opt-in gates below are reported as not run, never skipped.

`scripts/feature-test-matrix.mjs` maps feature families to source and test anchors; the contract test checks that every anchor exists. Add a row when you add a feature family. Tool tests describe stable policy and presentation families, not every plugin tool; a new tool must stay visible through the generic fallback.

## Fixture rules

- Use temporary directories in the OS temp dir, injected dependencies or loopback-only fakes. Never require credentials, live providers, external network, the user's configuration or installed-app state.
- `packages/web` Vitest gives every test file its own empty `DEVRYAN_DATA_DIR` under `<os tmpdir>/devryan-web-test/run-*` (`test/isolated-data.global.mjs`, `test/isolated-data.setup.mjs`), removed when the run ends. A guard fails any test file whose process creates, writes, moves or removes a path inside the real `~/.config/devryan`, `~/.config/openchamber` or `~/.config/opencode`, even when the code swallows the refusal. Child processes and the Bun `test:native` suites are not intercepted.
- The web `server/test-supertest.js` helper owns unbound loopback listeners until every sharing request finishes; already-bound servers remain caller-owned.
- Clean up temp files and child processes on pass, failure and interruption. Never write scratch under `.cache/`.
- `scripts/qa/run-root.mjs` `createRunRoot` removes a run directory (`<os tmpdir>/devryan-<family>`) unless `--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1` is set.
- DevRyan names are canonical; the installed OpenChamber identities and accepted aliases are listed in [identity compatibility](IDENTITY_COMPATIBILITY.md). DevRyan branding assertions apply to public release filenames and metadata.

## Opt-in groups

Docker, Chromium and native installer tests are excluded from the deterministic gate. Run them on a host with a healthy Docker Engine, or macOS for the installer; they use disposable containers and volumes (`devryan-it-<hex>` Compose projects) and refuse production resource names.

```sh
DEVRYAN_RUN_DOCKER_TESTS=1 bun test packages/bot-supervisor
DEVRYAN_RUN_BROWSER_TESTS=1 bun test packages/bot-computer/src/browser.test.js
DEVRYAN_RUN_BOT_INDEXER_DOCKER_TESTS=1 bun run --cwd packages/bot-indexer test
DEVRYAN_RUN_BOT_DB_DOCKER_TESTS=1 bun test --cwd packages/electron tests/bot-catalog.docker.test.mjs --timeout 600000
bun run --cwd packages/electron build:runtime-service-control
DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS=1 bun run --cwd packages/electron test
```

| Group | Covers |
| --- | --- |
| Supervisor | Docker-socket round trip through the engine proxy, owned-resource confinement, internal/public network split, egress failure closure, runsc replacement when gVisor is available |
| Browser | Chromium fixture image: authenticated proxying, network policy, token rotation, login persistence, ref fencing, control contention, profile reset |
| Bot indexer | Pinned offline-model image: namespace isolation, persistence across container replacement, `rebuild_required` after volume loss |
| Bot catalog | Local PostgreSQL/PostgREST catalog: migrations, backup, validated swap and rollback, newer-schema refusal, Start Empty, restart, hosted-catalog import. Build the dev images first: `docker build -f packages/bot-db/docker/database/Dockerfile -t devryan/bot-database:dev .` (and the same for `rest`). |
| DMG installer (macOS only) | Native atomic install/rollback exchanges and identity-based recovery with synthetic app data. It does not launch a packaged DMG. |

Never stop the user's Docker Engine to run these. Operational and security boundaries are in [BOTS_RUNTIME.md](BOTS_RUNTIME.md).

Production Bots visual fixture (test-only, not in the app bundle): `bun run visual:bots:capture -- --output <dir>` drives the real Bot UI through Electron CDP and writes screenshots and JSON; `visual:bots:capture:packaged` and `visual:bots:acceptance` use a packaged test shell and also run a native pointer smoke that needs macOS Accessibility access. Pass an `--output` outside `.cache/`.

Live multi-user checks use the password-free accounts in [Agent runtime verification](AGENT_RUNTIME_VERIFICATION.md). Database migration checks run on an isolated local Supabase stack only: `supabase db reset`, then `supabase db lint --local`. Never use `--linked`.

## Isolated QA and releases

[QA.md](QA.md) covers the isolated web and Electron runner, packaged-app smokes and benchmarks. Release handoff is in [Release pipeline](RELEASE_PIPELINE.md): `scripts/release.test.mjs` covers stage, the single-PATCH publish, the ledger, dry runs, moved tags, the asset allowlist and updater discovery; `release-state.test.mjs` the same-version states and the shipped-discovery matrix; `release-github.test.mjs` client retries, pagination and upload reconcile; `release-preflight.test.mjs` preflight; `release-candidate.test.mjs` the manifest and build reuse; `release-ci-wait.test.mjs` CI re-runs; `release-packaging.test.mjs` and `release-workflow.test.mjs` the packaging and workflow contracts; `release-artifacts.test.mjs` and `release-ci.test.mjs` the web and prepared-tree handoffs and Bot image reuse.
