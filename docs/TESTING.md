# DevRyan Testing

## Commands

| Command | Use |
| --- | --- |
| `bun run validate` | The local gate before every push and release tag. Diffs against the upstream branch (override with `VALIDATE_BASE`) and runs only what the change touches. |
| `bun run validate:full` | Lint, import boundaries, the browser graph, type-check, `docs:validate`, build, `bundle:check` and `test:full`. This is what CI runs. |
| `bun run test:startup` | Curated startup and user-data contract. |
| `bun run test:full` | Scripts, the visual fixture and every package suite. |
| `bun run docs:validate` | Markdown links and inline-code paths. |

`bun run validate` runs:

- ESLint on changed files;
- type-check of changed packages and their dependents (everything when root `package.json`, `bun.lock`, `eslint.config.js`, `tsconfig.json`, `vite-theme-plugin.ts` or `.opencode/opencode.json` change);
- tests of changed packages and their dependents;
- `test:scripts` when `scripts/`, `.github/` or `.opencode/agents|plugins` change;
- `docs:validate` when Markdown changes;
- import boundaries and the browser graph when package code changes (every importer when a package manifest, `scripts/import-boundaries.json` or a checker changes);
- `test:startup`, always.

`scripts/check-import-boundaries.mjs` resolves static, re-export, `require` and literal dynamic imports between packages. Application packages (web, Electron, the Bot services) expose only their `main`/`exports`; a package that declares `exports` exposes only those targets, by package name or relative path. Each temporary exception in `scripts/import-boundaries.json` is one exact importer/target pair with the plan stage that removes it (`unscheduled` when none does yet); an exception that no longer matches fails, so the list only shrinks. No exception covers a package-name import of a subpath the target's `exports` omits, because Node refuses that import at runtime. `scripts/check-browser-graph.mjs` walks the web Vite entry points with the build's aliases and fails on Node builtins, `adm-zip`, or a web-server, Electron, Bot-service or Node-only shared-runtime file.

A docs-only change runs only `docs:validate`. Both validate modes fail if the run left new entries in `.cache/` (see [STORAGE_CLEANUP.md](STORAGE_CLEANUP.md)).

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: job `checks` (macos-26) installs and runs `bun run validate:full`; job `startup` (macos-26) runs `bun run test:startup`. The other workflows are `release.yml`, `release-cache.yml` and `supabase-migrate.yml` (see [Release pipeline](RELEASE_PIPELINE.md)).

## Startup contract

`scripts/test-startup-contract.mjs` runs the startup and user-data tests: runtime bundle startup, selection and upgrade, ledger and session integrity, Retry, cancellation, delayed bootstrap, event subscription, and Electron startup and ownership. It uses disposable fixtures only: no installed-app data, live accounts or OS service registration.

## Suites and runners

`test:full` runs everything below except the frozen legacy Tauri package (`packages/desktop`: lint and types only, its cargo tests are not run).

| Suite | Command | Runner |
| --- | --- | --- |
| Scripts, `.opencode/agents` and `.opencode/plugins` tests, reviewed runtime inputs | `bun run test:scripts` | `scripts/test-scripts.mjs`: files importing `bun:test` run one per `bun test` process, the rest in one `node --test` run. `DEVRYAN_SCRIPT_TEST_CONCURRENCY` sets node concurrency. |
| Visual fixture | `bun run test:visual-fixture` | `bun test` |
| Shared UI | `bun run --cwd packages/ui test` | `scripts/test-ui.mjs`: `bun test`, with global-mock files in isolated processes |
| Web | `bun run --cwd packages/web test` | `vitest` (one worker), plus three native-host files under `bun test`. Native host scripts: `bun run --cwd packages/web test:native-host`. |
| Electron | `bun run --cwd packages/electron test` | `scripts/test-electron.mjs` routes by import: `node:test` to Node, `vitest` to Vitest, the rest to `bun test` (isolated when they mock globals) |
| `bots-runtime`, `bot-supervisor`, `bot-engine-proxy`, `bot-egress`, `bot-computer`, `bot-db`, `shared-runtime`, `harness-runtime`, `orchestration-runtime`, `cursor-sdk-runtime` | `bun run --cwd packages/<name> test` | `bun test` |
| `bot-indexer` | `bun run --cwd packages/bot-indexer test` | `node --test` |

Runner and discovery changes belong in `scripts/`. Feature tests live beside their source unless a contract spans packages.

## Test-suite contract

`scripts/test-suite-contract.test.mjs` fails when a test file is not discovered by its package runner, when a deterministic test uses `skip` or `todo`, or when the feature matrix is stale. Do not silence a scenario: delete tests for removed behavior or rewrite them for the current contract. Opt-in gates below are reported as not run, never skipped.

`scripts/feature-test-matrix.mjs` maps feature families to source and test anchors; the contract test checks that every anchor exists. Add a row when you add a feature family. Tool tests describe stable policy and presentation families, not every plugin tool; a new tool must stay visible through the generic fallback.

## Fixture rules

- Use temporary directories in the OS temp dir, injected dependencies or loopback-only fakes. Never require credentials, live providers, external network, the user's configuration or installed-app state.
- Clean up temp files and child processes on pass, failure and interruption. Never write scratch under `.cache/`.
- `scripts/qa/run-root.mjs` `createRunRoot` removes a run directory (`<os tmpdir>/devryan-<family>`) unless `--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1` is set.
- Preserve compatibility identifiers (`@openchamber/*`, `OPENCHAMBER_*`, `openchamber://`, config paths). DevRyan branding assertions apply to public release filenames and metadata.

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

[QA.md](QA.md) covers the isolated web and Electron runner, packaged-app smokes and benchmarks. Release handoff is in [Release pipeline](RELEASE_PIPELINE.md): `scripts/release.test.mjs` covers draft creation and reuse, published-version refusal, moved tags, the asset allowlist and updater discovery; `scripts/release-artifacts.test.mjs` and `scripts/release-ci.test.mjs` cover the web and prepared-tree handoffs and Bot image reuse.
