# scripts/

## Responsibility
Repository automation entrypoint for developer workflows: validation planning, local dev orchestration, release/build smoke checks, and utility tooling.

## Design
- **Orchestrator scripts** (`*.mjs`) spawn and supervise child processes with graceful shutdown (`SIGINT` → `SIGTERM` → `SIGKILL`) and detached-group handling on macOS. Group shutdown remains active after a wrapper leader exits, so nested watchers can finish reaping their owned runtimes before the orchestrator returns.
- **Validation planner** (`validate.mjs`): computes changed-file impact via git diff, maps files to package scopes, and selects quick/affected/full command sets. Cursor runtime changes always run the Cursor package suite; affected mode also type-checks web/VS Code and runs web integration tests.
- **Dual-mode release testing** (`test-release-build.sh`): native macOS build path plus optional `act` workflow simulation.
- **Small focused utilities**: per-purpose scripts for VS Code dev host boot, web watcher startup, version/theme/build helper tasks.

## Flow
1. Developer invokes a script via `bun run` or shell.
2. Script resolves repo paths/env, validates prerequisites, and builds an execution plan.
3. It runs one or more child commands (watchers/builds/checks), forwarding output and handling lifecycle events.
4. On failure or interrupt, script tears down subprocess trees and exits with explicit status.

## Integration
- **Depends on**: Bun, Node runtime, git CLI, and platform build toolchains (Rust/Tauri for legacy desktop release checks).
- **Invokes package scripts** across `packages/*` (especially web/vscode/electron/desktop).
- **Used by CI and local development** for consistent validation and release smoke behavior.
