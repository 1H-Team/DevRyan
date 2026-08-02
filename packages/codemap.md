# packages/

## Responsibility
Monorepo package boundary for DevRyan runtimes. It organizes shared UI/runtime implementations plus shell-specific hosts (Electron primary, Tauri legacy, VS Code extension).

## Design
- **Workspace segmentation by runtime**:
  - `electron/`: primary desktop shell with in-process web server host.
  - `desktop/`: legacy Tauri shell for migration/compatibility.
  - `vscode/`: extension-host + webview runtime.
  - `cursor-sdk-runtime/`: shared Cursor SDK execution/auth helper package used by web/Electron and VS Code.
  - `orchestration-runtime/`: dependency-free DevRyan-managed task contracts and scheduler policy shared by web/Electron and VS Code.
  - `harness-runtime/`: dependency-free durable operation, diagnostic, lifecycle, and turn-evidence primitives shared by web/Electron and VS Code.
  - `ui/` and `web/` (outside this task scope) provide shared renderer/server layers consumed by runtimes.
- **Compatibility-first API contracts**: runtime shells expose equivalent command/event semantics so shared UI remains mostly shell-agnostic.

## Flow
1. Runtime package starts its host process (Electron main, Tauri main, or VS Code extension host).
2. Host wires a bridge to shared UI runtime APIs.
3. UI requests flow through host-specific bridge handlers into local filesystem/process/network capabilities.
4. Runtime emits lifecycle/connection/status events back to UI for synchronization.

## Integration
- **Build integration**: root scripts orchestrate package-local build/type-check/lint commands.
- **Cross-package dependencies**: runtime packages consume shared UI assets, the Cursor SDK runtime for Cursor model execution, the managed orchestration runtime for DevRyan-owned task policy, and, for desktop, the web server package.
- **Primary shell policy**: Electron is forward path; Tauri remains maintenance-only until cutover completion.
