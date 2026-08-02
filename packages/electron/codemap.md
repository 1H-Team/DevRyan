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
- **Operational hardening**: single-instance lock, persistent logging via `electron-log`, stale log pruning, and unthrottled renderer paints for chat windows so packaged streaming/status updates stay responsive. `quit-cleanup.mjs` keeps the main process alive until owned web/OpenCode/SSH cleanup settles, with a bounded force-exit fallback.
- **Cache maintenance**: `cache-maintenance.mjs` measures and clears Electron HTTP/code caches for both the app session and the persistent in-app-browser partition during startup maintenance and Settings/Help cleanup actions, without touching app storage such as localStorage, cookies, or IndexedDB.
- **Browser DevTools**: `browser-devtools-controller.mjs` idempotently opens or closes native Chromium DevTools for an in-app browser guest after `main.mjs` validates the requesting window, guest type, persistent browser partition, and renderer-supplied dock bounds. Because Electron's internal dock for a `<webview>` has no visible host geometry, the controller assigns DevTools to a `WebContentsView` attached to the owning `BrowserWindow`, clamps it to the browser pane, and destroys it on close/guest teardown; the UI keeps that bottom dock aligned and resizable. Electron's custom-DevTools-host contract uses `detach` mode for the caller-owned `WebContents`, while the view bounds provide the physical bottom dock. Opening DevTools intentionally takes precedence over the CDP agent client; Electron detaches it and the bridge remains ready for reconnection.
- **Session-scoped agent browser leases**: `browser-cdp-bridge.mjs` owns one asynchronous loopback WebSocket listener and a fenced map of per-lease capability token, guest, debugger session, client, in-flight commands, and orphan timer. The renderer batch-claims exact `(directory, rootSessionId)` ownership for every authoritative known session family and active managed task; `main.mjs` briefly waits for that exact claim before assigning a lease, never falls back across roots, directories, focus, or windows, publishes only token-free metadata to that window, and emits a separate token-free global active-count event to privileged full windows. Claims are additive/LRU-bounded and are removed when their owning window closes. It validates the renderer's explicit lease-to-`webContents.id` binding and withholds the capability URL from the server until the hidden guest is attached. Input events carry `leaseId` and are emitted only for the lease that window is observing; hidden leases receive no cursor IPC stream. Guest presentation metadata is throttled and cannot extend the activity clock. Guest destruction, session lifecycle release, setting disable, orphan timeout, restart, and quit destroy only their intended lease guest (or all leases for the explicit global lifecycle edge).
- **Managed agent-browser runtime**: Electron lazily provisions the packaged `agent-browser` skill and exact pinned CLI under the active `OPENCHAMBER_DATA_DIR` only from the managed-child launch callback. Configured external/remote OpenCode runtimes are not mutated. The three private child variables are supplied through that injected lifecycle callback instead of ambient `process.env`. Local-only `desktop_agent_browser_status|install|repair` IPC supports Settings without exposing mutation over HTTP; failures are nonfatal to desktop startup.
- **Diagnostics export**: `desktop_export_diagnostics` owns the native save
  dialog and streams the in-process server ZIP through a private sibling
  temporary file, fsync, and atomic rename.
- **Release authority**: packaged update discovery and `electron-updater`
  publishing both target the canonical `zoubenr/DevRyan` GitHub repository.

## Flow
1. Electron app starts (`main.mjs`) and establishes process-level guards (single instance, protocol registration, logging).
2. Main process starts web runtime and creates BrowserWindow pointed at local origin.
3. `preload.mjs` injects shell flags/global values and wires IPC invoke/listen channels.
4. Renderer calls `window.__TAURI__.core.invoke(...)` for desktop actions; main process handles command routing and side effects.
5. Main process emits lifecycle/update/SSH/speech events back to renderer via `openchamber:emit`.
6. A managed browser tool call acquires a server lease; Electron emits a token-free `browser-agent-leases` snapshot, the always-mounted renderer fleet binds one hidden webview, and only then does Electron return the private capability URL to the managed server.
7. On normal quit, main process persists window state, awaits managed web/OpenCode and SSH cleanup, closes browser leases, then exits. Update installation retains its updater-owned shutdown path.

## Integration
- **Depends on**: `@openchamber/web` server entrypoint, Electron runtime APIs, `electron-updater`, OS facilities.
- **Consumes/hosts**: web UI bundle served from local web server; startup splash and boot metadata are injected from main process.
- **Contract with shared UI**: `__TAURI__` invoke commands and emitted `openchamber:*` events. Agent browser leases use `desktop_browser_lease_snapshot` (initial/reload replay), `desktop_browser_lease_claim_context` / `desktop_browser_lease_claim_contexts`, `desktop_browser_lease_bind_guest`, `desktop_browser_lease_set_observed`, `desktop_agent_browser_*`, window-scoped `browser-agent-leases`, global-count-only `browser-agent-lease-total`, and observed-only `browser-agent-input`. Installer mutations return `applied` and `restartSucceeded`; a failed managed OpenCode restart returns `state: restart-failed` plus an actionable issue without changing the binary-integrity meaning of `ok`.
- **Packaging/release hooks**: `packages/electron/scripts/*` for bundling main process, native helper build/signing, release metadata finalization.
- **Window-state persistence**: `window-state-persistence.mjs` snapshots native `BrowserWindow` values before queued settings writes, so shutdown never retains a destroyed native window.
- **Quit cleanup**: `quit-cleanup.mjs` orders normal app quit after owned-resource cleanup, deduplicates the main-process stop promise, and bounds a genuinely hung cleanup at ten seconds.
- **Native packaging verification**: `scripts/native-module-paths.mjs` resolves workspace/transitive native modules without assuming Bun hoisting, while `scripts/packaged-native-modules.mjs` rejects artifacts missing required Electron ABI bindings or Cursor ripgrep.
- **Regression suite**: `bun run test` recursively discovers Electron `*.test.*` files outside generated/package output and runs them under Bun; the suite contract rejects missed files, and the root full and affected validation gates invoke this package suite.
