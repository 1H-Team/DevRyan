# Repository Atlas: DevRyan

## Project Responsibility

DevRyan is a Bun/Node monorepo that provides web, desktop, and VS Code UI runtimes for interacting with an OpenCode server. The shared React UI lives in `packages/ui`; `packages/web` owns the Express server, browser bootstrap, and CLI; `packages/cursor-sdk-runtime` owns shared Cursor SDK execution/auth helpers for web and VS Code; `packages/electron` is the primary desktop shell; `packages/desktop` is the legacy Tauri shell; `packages/vscode` hosts the same experience inside VS Code.

## System Entry Points

- `package.json`: workspace manifest and top-level build/validation/dev commands.
- `packages/web/server/index.js`: Express/OpenCode server bootstrap and runtime composition root.
- `packages/web/bin/cli.js`: `openchamber` CLI entrypoint for serving, auth, tunnels, and operator workflows.
- `packages/web/src/main.tsx`: standalone web bootstrap that injects runtime APIs before loading shared UI.
- `packages/cursor-sdk-runtime/index.js`: shared Cursor SDK model execution, virtual provider discovery, split SDK/usage credential helpers, and the public pending-question contract.
- `packages/cursor-sdk-runtime/cursor-question-runtime.js`: authenticated loopback MCP question bridge for primary Cursor Builder/Orchestrator runs.
- `packages/ui/src/main.tsx`: shared React UI mount and provider initialization.
- `packages/electron/main.mjs`: primary desktop main process; boots web server in-process and hosts native integrations.
- `packages/electron/preload.mjs`: Electron renderer bridge and `__TAURI__` compatibility shim.
- `packages/desktop/src-tauri/src/main.rs`: legacy Tauri command host and sidecar launcher.
- `packages/vscode/src/extension.ts`: VS Code extension activation and provider registration.
- `packages/vscode/webview/main.tsx`: VS Code webview bootstrap for shared UI.
- `scripts/validate.mjs`: changed-file-aware validation planner used by quick/affected/full checks.
- `scripts/check-bundle-budgets.mjs`: deterministic Vite-manifest startup graph and bundle-budget verifier for web and VS Code builds.

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `packages/` | Workspace package boundary for runtime packages and shared UI/server layers. | [packages/codemap.md](packages/codemap.md) |
| `packages/ui/` | Shared React UI runtime, feature components, Zustand stores, and event-sync pipeline used by all shells. | [packages/ui/codemap.md](packages/ui/codemap.md) |
| `packages/web/` | Browser app, Express/OpenCode server runtime, and `openchamber` CLI. | [packages/web/codemap.md](packages/web/codemap.md) |
| `packages/cursor-sdk-runtime/` | Shared Cursor SDK execution runtime used by web/Electron and VS Code; quota credentials remain deliberately separate in each surface's quota module. | [packages/cursor-sdk-runtime/codemap.md](packages/cursor-sdk-runtime/codemap.md) |
| `packages/orchestration-runtime/` | Dependency-free DevRyan-managed task contract, dispatch-barrier, and scheduler policy shared by web/Electron and VS Code owners. | [packages/orchestration-runtime/codemap.md](packages/orchestration-runtime/codemap.md) |
| `packages/electron/` | Primary desktop shell with in-process web server, native OS integrations, and IPC bridge. | [packages/electron/codemap.md](packages/electron/codemap.md) |
| `packages/desktop/` | Legacy Tauri desktop shell retained for existing-install migration compatibility. | [packages/desktop/codemap.md](packages/desktop/codemap.md) |
| `packages/vscode/` | VS Code extension host, bridge router, OpenCode manager, and webview runtime. | [packages/vscode/codemap.md](packages/vscode/codemap.md) |
| `packages/vscode/webview/` | VS Code-specific webview adapter that exposes bridge-backed runtime APIs to shared UI. | [packages/vscode/webview/codemap.md](packages/vscode/webview/codemap.md) |
| `scripts/` | Repository automation for validation, dev orchestration, release/build smoke checks, and utility tasks. | [scripts/codemap.md](scripts/codemap.md) |

## Where To Change Things

- **Shared UI, views, stores, hooks, theme, chat, settings** → start in `packages/ui/codemap.md`, then the relevant `packages/ui/src/**/codemap.md`.
- **Server routes, OpenCode integration, terminal/git/GitHub/quota/TTS/skills APIs** → start in `packages/web/codemap.md`, then `packages/web/server/codemap.md` and `packages/web/server/lib/codemap.md`.
- **Web browser bootstrap or web runtime API adapters** → `packages/web/src/codemap.md` and `packages/web/src/api/codemap.md`.
- **CLI commands, prompts, output modes, tunnel/auth operator flows** → `packages/web/bin/codemap.md`.
- **Electron desktop behavior, IPC, menus, dialogs, notifications, updater, deep links** → `packages/electron/codemap.md`.
- **Legacy Tauri compatibility only** → `packages/desktop/codemap.md`; do not add new desktop features there unless explicitly required for released Tauri users.
- **VS Code extension host or webview bridge behavior** → `packages/vscode/codemap.md`, `packages/vscode/src/codemap.md`, and `packages/vscode/webview/codemap.md`.
- **DevRyan-managed task identity, admission, dispatch barriers, cancellation, recovery, or persistence policy** → `packages/orchestration-runtime/codemap.md` and `packages/orchestration-runtime/DOCUMENTATION.md`.
- **Web/Electron managed scheduler ownership, private tool/barrier bridge, ledger, OpenCode transport, or UI routes** → `packages/web/server/lib/orchestration/codemap.md` and `packages/web/server/lib/orchestration/DOCUMENTATION.md`.
- **VS Code managed scheduler ownership, private tool bridge, ledger, OpenCode/Cursor transport, or webview routes** → `packages/vscode/src/codemap.md`, `packages/vscode/src/DOCUMENTATION.md`, and `packages/vscode/webview/api/codemap.md`.
- **Shared managed-task cards, snapshot/event projection, recovery controls, or primary-agent handoff UI** → `packages/ui/src/stores/codemap.md`, `packages/ui/src/stores/DOCUMENTATION.md`, `packages/ui/src/sync/DOCUMENTATION.md`, and `packages/ui/src/components/chat/codemap.md`.
- **Validation/build/dev scripts** → `scripts/codemap.md` and the specific script file.
- **Generated/bundled asset folders** → treat their codemaps as ownership pointers; change source packages instead of editing generated output.

## Cross-Runtime Flow

1. A host runtime starts or connects to OpenCode: web CLI/server, Electron main process, legacy Tauri sidecar, or VS Code extension host.
2. The host exposes runtime APIs over HTTP, WebSocket/SSE, IPC, or VS Code webview messaging.
3. Shared UI initializes providers and stores, consumes runtime APIs, and renders session/chat/settings/tooling surfaces.
4. Live OpenCode events flow through server/extension bridges into UI sync stores; user actions flow back through runtime adapters into host-owned capabilities.
5. Packaging scripts build the shared UI/server outputs into Electron, legacy Tauri, VS Code, or standalone web deployments.

## Integration Notes

- The web server is the feature backend for web and Electron; native shells should stay thin and capability-focused.
- Electron is the forward desktop path. Tauri remains present for auto-update migration and compatibility.
- Shared UI is runtime-agnostic by contract; branch on capability APIs rather than shell identity wherever possible.
- High-frequency session/message state is handled through the UI sync pipeline rather than broad Zustand store fanout.
- Keep this root atlas and the nearest subdirectory `codemap.md` updated when moving entrypoints, package ownership, or cross-runtime contracts.

## Operational Evidence

- [ECC performance and agent-evaluation pass](docs/audits/2026-07-15-ecc-performance-and-agent-eval-pass.md): sanitized startup-graph measurements, live provider/evaluation coverage, Electron UI evidence, explicit unavailable checks, and final verification for the context-efficiency and agent-evaluation workstream.
