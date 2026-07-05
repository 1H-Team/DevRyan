# packages/electron/

## Responsibility
Primary desktop shell (Electron). Boots the DevRyan web server in-process, owns native OS integration (menus, dialogs, notifications, deep links, updates), and exposes a constrained IPC bridge to the shared renderer UI.

## Design
- **Single-process host model**: `main.mjs` imports and starts `@openchamber/web/server/index.js` instead of launching a separate backend process.
- **Bridge/shim pattern**: `preload.mjs` exposes `__OPENCHAMBER_ELECTRON__` and a `__TAURI__` compatibility surface so shared UI code can run on both Electron and legacy Tauri.
- **Origin policy**: `origin-policy.mjs` centralizes privileged-local vs allowed-content origin rules used by `main.mjs`, `preload.mjs`, init-script injection, navigation handlers, and IPC gates.
- **Capability gating**: sensitive commands are enforced in main-process handlers (`openchamber:invoke`), with remote/local origin checks.
- **Manager modules**: `ssh-manager.mjs` and `speech-manager.mjs` encapsulate long-running native integrations and emit structured status events.
- **Native state controllers**: `keep-awake-controller.mjs` wraps `powerSaveBlocker` with idempotent apply/stop semantics for the desktop Keep Awake setting.
- **Operational hardening**: single-instance lock, persistent logging via `electron-log`, stale log pruning, graceful/confirmed quit path, and unthrottled renderer paints for chat windows so packaged streaming/status updates stay responsive.
- **Cache maintenance**: `cache-maintenance.mjs` clears packaged Electron HTTP/code caches at startup without touching app storage such as localStorage, cookies, or IndexedDB.

## Flow
1. Electron app starts (`main.mjs`) and establishes process-level guards (single instance, protocol registration, logging).
2. Main process starts web runtime and creates BrowserWindow pointed at local origin.
3. `preload.mjs` injects shell flags/global values and wires IPC invoke/listen channels.
4. Renderer calls `window.__TAURI__.core.invoke(...)` for desktop actions; main process handles command routing and side effects.
5. Main process emits lifecycle/update/SSH/speech events back to renderer via `openchamber:emit`.
6. On quit/update install, main process runs shutdown sequence (persist window state, stop managed resources, exit).

## Integration
- **Depends on**: `@openchamber/web` server entrypoint, Electron runtime APIs, `electron-updater`, OS facilities.
- **Consumes/hosts**: web UI bundle served from local web server; startup splash and boot metadata are injected from main process.
- **Contract with shared UI**: `__TAURI__` invoke commands and emitted `openchamber:*` events.
- **Packaging/release hooks**: `packages/electron/scripts/*` for bundling main process, native helper build/signing, release metadata finalization.
