# scripts/

## Responsibility
Repository automation entrypoint for developer workflows: validation planning, local dev orchestration, release/build smoke checks, and utility tooling.

## Design
- **Orchestrator scripts** (`*.mjs`) spawn and supervise child processes with graceful shutdown (`SIGINT` → `SIGTERM` → `SIGKILL`) and detached-group handling on macOS. Group shutdown remains active after a wrapper leader exits, so nested watchers can finish reaping their owned runtimes before the orchestrator returns.
- **Development data isolation** (`dev-data-directory.mjs`): derives a stable temporary `OPENCHAMBER_DATA_DIR` from the checkout path and launcher mode while preserving any explicit override. The web-stack, HMR, full-web, direct server watcher, and Electron launchers pass that value to every process that shares their runtime so development cannot silently reuse an installed app's production ledger.
- **Validation planner** (`validate.mjs`): computes changed-file impact via git diff, maps files to package scopes, and selects quick/affected/full command sets. Cursor runtime changes always run the Cursor package suite; affected mode also type-checks web/VS Code and runs web integration tests. Rust/Cargo/Tauri compatibility changes select the locked desktop Cargo suite.
- **Full-suite discovery** (`test-scripts.mjs`, `test-electron.mjs`, `test-ui.mjs`): recursively discovers deterministic tests for runner-owned surfaces, including repository scripts and project-owned `.opencode` agent/plugin contracts. `test-suite-contract.test.mjs` rejects undiscovered files, skipped/todo declarations, omitted test-owning workspaces, and stale feature-matrix paths. `feature-test-matrix.mjs` is the checked coverage index; usage and fixture policy live in `docs/TESTING.md`.
- **Bundle budget checker** (`check-bundle-budgets.mjs` + `bundle-budgets.config.mjs`): reads existing web/VS Code Vite manifests, traverses entry static imports, then resolves explicitly configured immediate dynamic roots in order across the graph accumulated so far. This permits an explicitly measured render root beneath an earlier app root without treating sibling lazy imports as startup. It sums unique raw/default-gzip JavaScript bytes and rejects `.bun` output chunks, configured exact emitted startup chunk identities, or budget regressions with stable report/JSON output. Proven lazy view/dialog boundaries are guarded by their stable Vite manifest names, while byte budgets retain 5% headroom over the measured graph without exceeding historical baselines. It does not infer source-module or worker exclusion from generic chunk labels.
- **Agent evaluation harness** (`agent-evals/`): external-dependency-free, non-interactive schema-v1 runner for pinned loopback DevRyan/OpenCode sessions, deterministic inspect/repair/managed-change cases, bounded focused/deep Oracle review cases with safe semantic graders, exact Git fixture restoration, whitelist-only aggregate reports, shared provider prompt-tool policy, and the macOS Electron process-tree retry-memory profile. See [agent-evals/codemap.md](agent-evals/codemap.md).
- **Dual-mode release testing** (`test-release-build.sh`): native macOS build path plus optional `act` workflow simulation.
- **Small focused utilities**: per-purpose scripts for VS Code dev host boot, web watcher startup, version/theme/build helper tasks.
- **Browser-parity fixture** (`fixtures/browser-parity-app.mjs`): zero-dependency loopback app used for multi-user visual checks of relative assets, API/cookie traffic, console levels, selectable DOM metadata, navigation, and a WebSocket/HMR-like connection.
- **Diagnostic journal inspector** (`journal.mjs`): zero-dependency list/show/gaps/blob/path CLI for session manifests, gzip/open chunks, runtime records, and transitional legacy segments.
- **Packaged default-config gates**: `verify-default-config-artifact.mjs` SHA-verifies the canonical asset inventory and rejects prohibited files in managed roots. `smoke-packaged-orchestration-config.mjs` provisions a temporary clean user and runtime overlay from an extracted artifact, checking dependencies, agents, manifests, plugin bytes, and the absence of bundled user-profile skills without touching user configuration.

## Flow
1. Developer invokes a script via `bun run` or shell.
2. Script resolves repo paths/env, validates prerequisites, and builds an execution plan.
3. It runs one or more child commands (watchers/builds/checks), forwarding output and handling lifecycle events.
4. On failure or interrupt, script tears down subprocess trees and exits with explicit status.

## Integration
- **Depends on**: Bun, Node runtime, git CLI, and platform build toolchains (Rust/Tauri for legacy desktop release checks).
- **Invokes package scripts** across `packages/*` (especially web/vscode/electron/desktop).
- **Used by CI and local development** for consistent validation and release smoke behavior.
- **Full-gate contract**: `bun run test:full` includes every test-owning workspace, including locked Cargo tests for legacy Tauri; PR CI installs the Tauri v2 Linux toolchain prerequisites and caches Cargo inputs.
- **Bundle-check contract**: `bun run bundle:check` reads existing `dist` manifests only and writes no source artifact; unit tests use temporary manifests/files, so normal test runs do not require a prior build.
- **Agent-eval contract**: `bun run agent:eval -- --config <path>` accepts no other flags, never infers credentials, and writes schema-v1 reports only to the configured directory. Live provider execution is an explicit operator action; unit tests use temporary Git fixtures and fake loopback servers.
- **Artifact-gate contract**: release workflows unpack npm, Electron `app.asar`, VSIX, and the legacy Tauri app resource artifacts before release/publish, then run both default-config gates. The smoke requires the exact manifest-owned local plugin registrations, reviewed dependency versions and installed entrypoints, curated skills, bundled runtime plugins, and no duplicate profile-owned registration in the runtime overlay. Electron relies on packaged `@openchamber/web` defaults; Tauri stages the canonical filtered tree because its compiled sidecar cannot rely on adjacent package files.
