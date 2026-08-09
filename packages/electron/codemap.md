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
- **Operational hardening**: single-instance lock, persistent logging via `electron-log`, stale log pruning, and unthrottled renderer paints for chat windows so packaged streaming/status updates stay responsive. A failed local-server startup keeps the main window open on a retryable, theme-aware error surface and logs the nested dependency cause instead of immediately exiting. `quit-cleanup.mjs` keeps the main process alive until owned web/OpenCode/SSH cleanup settles, with a bounded force-exit fallback.
- **Cache maintenance**: `cache-maintenance.mjs` measures and clears Electron HTTP/code caches for the app session, the agent-browser partition, and every registered isolated manual-browser partition during startup maintenance and Settings/Help cleanup actions, without touching current app storage such as localStorage, cookies, or IndexedDB.
- **Browser surface ownership**: `browser-surface-manager.mjs` owns manual and lease `WebContentsView` instances. Agent leases retain the dedicated legacy partition; manual surfaces use a main-derived persistent partition hashed from canonical DevRyan origin plus authenticated principal ID. The main process resolves `/auth/session`, enforces the Browser capability for local and configured remote renderers, periodically revalidates active contexts, and destroys manual surfaces on logout, account change, or revocation. A one-time migration clears the former shared profile because its cookies cannot safely be assigned to one user; an Electron-owned registry retains only hashed partition names for cache maintenance. Renderer IPC names allowlisted surface/workspace IDs, and the manager validates the requesting window, authenticated context, and clamped bounds before navigation, layout, capture, inspection, DevTools, pop-out, dock, focus, activation, or release. Manual surfaces are grouped by opaque workspace ID so one pop-out hosts the active page while sibling views remain parked; switching pages preserves DOM/history/cookies within that user's profile.
- **Navigation outcomes**: `browser-navigation-error.mjs` classifies Electron's benign `ERR_ABORTED` result so superseded or redirected app-window and browser-surface navigations do not surface as failures; all other navigation errors remain rejected.
- **Browser DevTools**: `browser-devtools-controller.mjs` idempotently opens or closes Chromium DevTools in a caller-owned `WebContentsView`, clamps its dock bounds, and can rehost the same dock with its browser surface across pop-out/dock transitions. Electron's custom host uses `detach` mode while view bounds provide the physical dock.
- **Session-scoped agent browser leases**: `browser-cdp-bridge.mjs` owns one asynchronous loopback WebSocket listener and a fenced map of per-lease capability token, main-owned surface contents, debugger session, client, in-flight commands, and orphan timer. The renderer batch-claims exact `(directory, rootSessionId)` ownership; `main.mjs` waits only for that claim, creates and binds the surface before returning the private capability URL, and publishes token-free metadata plus a surface ID only to the owner window. Moving or popping the surface does not change lease ownership, CDP attachment, context claims, or menu presence. Agent input is projected through a page overlay owned by the surface manager, and screenshot commands temporarily suppress it.
- **Managed agent-browser runtime**: Electron lazily provisions the packaged `agent-browser` skill and exact pinned CLI under the active `OPENCHAMBER_DATA_DIR` only from the managed-child launch callback. Configured external/remote OpenCode runtimes are not mutated. The three private child variables are supplied through that injected lifecycle callback instead of ambient `process.env`. Local-only `desktop_agent_browser_status|install|repair` IPC supports Settings without exposing mutation over HTTP; failures are nonfatal to desktop startup.
- **Diagnostics export**: `desktop_export_diagnostics` owns the native save
  dialog and streams the in-process server ZIP through a private sibling
  temporary file, fsync, and atomic rename.
- **Release authority**: packaged update discovery and `electron-updater`
  publishing both target the canonical `1H-Team/DevRyan` GitHub repository.

## Flow
1. Electron app starts (`main.mjs`) and establishes process-level guards (single instance, protocol registration, logging).
2. Main process starts web runtime and creates BrowserWindow pointed at local origin.
3. `preload.mjs` injects shell flags/global values and wires IPC invoke/listen channels.
4. Renderer calls `window.__TAURI__.core.invoke(...)` for desktop actions; main process handles command routing and side effects.
5. Main process emits lifecycle/update/SSH/speech events back to renderer via `openchamber:emit`.
6. A managed browser tool call acquires a server lease; Electron creates a main-owned surface, binds its `webContents` to the lease, emits a token-free `browser-agent-leases` snapshot, and only then returns the private capability URL to the managed server.
7. On normal quit, main process persists window state, awaits managed web/OpenCode and SSH cleanup, closes browser leases, then exits. Update installation retains its updater-owned shutdown path.

## Integration
- **Depends on**: `@openchamber/web` server entrypoint, Electron runtime APIs, `electron-updater`, OS facilities.
- **Consumes/hosts**: web UI bundle served from local web server; startup splash and boot metadata are injected from main process.
- **Contract with shared UI**: `__TAURI__` invoke commands and emitted `openchamber:*` events. Browser surfaces use local-only `desktop_browser_surface_*` operations plus surface-ID capture and DevTools commands; manual groups add local-only `desktop_browser_workspace_*` activate/pop-out/dock/focus operations. Window-scoped token-free `browser-surface-updated` snapshots include manual workspace/tab identity. Agent leases use snapshot, exact context claims, observed-lease selection, `desktop_agent_browser_*`, window-scoped `browser-agent-leases`, and global-count-only `browser-agent-lease-total`; the old bind command remains a compatibility status read instead of accepting renderer `webContentsId` ownership.
- **Packaging/release hooks**: `packages/electron/scripts/*` for bundling main process, native helper build/signing, release metadata finalization.
- **Window-state persistence**: `window-state-persistence.mjs` snapshots native `BrowserWindow` values before queued settings writes, so shutdown never retains a destroyed native window.
- **Quit cleanup**: `quit-cleanup.mjs` orders normal app quit after owned-resource cleanup, deduplicates the main-process stop promise, and bounds a genuinely hung cleanup at ten seconds.
- **Native packaging verification**: `scripts/native-module-paths.mjs` resolves workspace/transitive native modules without assuming Bun hoisting, while `scripts/packaged-native-modules.mjs` rejects artifacts missing required Electron ABI bindings or Cursor ripgrep.
- **Regression suite**: `bun run test` recursively discovers Electron `*.test.*` files outside generated/package output and runs them under Bun; the suite contract rejects missed files, and the root full and affected validation gates invoke this package suite.
