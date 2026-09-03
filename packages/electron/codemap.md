# packages/electron/

## Responsibility
Primary desktop shell and packaged background-runtime executable. App-bound mode
boots the DevRyan web server in-process; service-client mode connects to the
fenced launchd owner; `--runtime-service` creates no window and owns the server,
Production Bots, routines, memory, computer supervision, and Docker management.
The foreground app owns native OS integration and exposes constrained renderer
and desktop-host broker bridges.

## Design
- **Fenced owner model**: `main.mjs` imports `@openchamber/web/server/index.js` in
  app-bound or `--runtime-service` mode. A private owner-generation lock permits
  one server per data directory. A migrated foreground app bootstraps an
  HttpOnly/SameSite runtime cookie and becomes a client instead of starting a
  second server.
- **Bridge/shim pattern**: `preload.mjs` exposes `__OPENCHAMBER_ELECTRON__` and a `__TAURI__` compatibility surface so shared UI code can run on both Electron and legacy Tauri.
- **Origin policy**: `origin-policy.mjs` centralizes privileged-local vs allowed-content origin rules used by `main.mjs`, `preload.mjs`, init-script injection, navigation handlers, and IPC gates.
- **Capability gating**: sensitive commands are enforced in main-process handlers (`openchamber:invoke`), with remote/local origin checks.
  The preload keeps an early Bot-runtime rejection when its immutable local-origin
  boot argument is available; startup-splash windows created before port selection
  defer to the authoritative main-process live-URL gate instead of denying the
  eventual local renderer.
- **Manager modules**: `ssh-manager.mjs` and `speech-manager.mjs` encapsulate long-running native integrations and emit structured status events.
- **Responsive startup**: foreground app-bound launch asks the in-process web
  server to listen with OpenCode deferred, activates the renderer, and only then
  resumes OpenCode plus Bot preparation in the background. Automatic runtime-
  service preflight persists an app-bound fallback and is used directly, so an
  unavailable signed service cannot trigger the stale 20-second connection wait.
  Packaged startup leaves Chromium caches intact; the existing explicit cache-
  clear command remains available. Window hangs, recoveries, renderer exits,
  and main-frame load failures are recorded as content-free lifecycle logs.
- **Native state controllers**: `keep-awake-controller.mjs` wraps `powerSaveBlocker` with idempotent apply/stop semantics for the desktop Keep Awake setting.
- **Bot key ownership**: `bot-secret-store.mjs` creates one 32-byte deployment
  key, seals it with Electron `safeStorage`, and exposes only a defensive-copy
  callback to the in-process server. A validated recovery restore may atomically
  replace the sealed key through a separate in-process callback and then repairs
  the derived Bot runtime; key bytes never cross renderer IPC, HTTP, ambient
  environment variables, or logs.
- **Background runtime ownership**: `runtime-service.mjs` owns the versioned
  instance/port/protocol/health/owner-generation descriptor, OS-sealed rotating
  one-time bootstrap, 12-hour renderer session, and short desktop-host lease.
  `runtime-service-registration.mjs` uses an Electron-loaded N-API bridge so
  `SMAppService` runs inside the calling DevRyan bundle on macOS 13+ when macOS
  recognizes the bundled definition. Unsigned builds that report `not_found`
  despite carrying that definition, plus older supported hosts, use the private
  mode-0600 per-user LaunchAgent. An existing managed legacy agent takes
  precedence so upgrades never create competing registrations. First launch
  automatically registers the service; approval and safely recoverable failure
  retain app-bound Bot execution. Transactional enable/disable/update handoffs checkpoint and
  drain before ownership changes; stale/current+1 protocols fail closed while
  current and previous protocols remain rollout-compatible.
  Source-development launches explicitly report the signed service as
  unavailable so a reused packaged shell cannot register stale bundled code.
  `scripts/build-runtime-service-control.mjs` cross-compiles the bridge for the
  Electron matrix target, while `scripts/verify-runtime-service-package.mjs`
  opens the ZIP and DMG, executes the packaged status probe, and rejects
  artifacts missing the bridge, target architecture, valid agent plist,
  Developer ID signature, notarization prerequisites, or matching Team identity.
- **Desktop-host broker**: `desktop-host-broker.mjs` projects only short-lived
  focus, notification, browser/CDP, and browser-observation capabilities from the foreground app to
  the service. App absence returns `desktop_host_unavailable`; it does not stop
  server, routine, memory, or computer ownership.
- **Bot recovery ownership**: `bot-recovery-dialog.mjs` owns native `.drbr`
  save/open dialogs. Export streams authenticated loopback ciphertext to a
  private sibling temporary file, fsyncs, and atomically renames it. Restore
  rejects links/oversize files, keeps bounded encrypted bytes in main memory,
  and returns metadata only. `desktop_export_bot_recovery` and
  `desktop_restore_bot_recovery` are local-origin-only preload commands.
- **Bot Docker ownership**: `bot-runtime-manifest.mjs` validates fixed local
  development tags or selects architecture-matched immutable digests from the
  complete signed-image release manifest. Release builds download, verify, and
  bundle that manifest as `bot-runtime/images.release.json`; local development
  reads only `resources/bot-runtime/images.dev.json`, verifies that every fixed
  local image already exists, and never pulls mutable development tags;
  `bot-runtime-manager.mjs` resolves a validated Docker executable and owns
  fixed-project setup, health, repair, staged update, and rollback through
  argv-only process calls. `ensureReady` is the authoritative, single-flight
  background operation: it checks, sets up, updates, or repairs within three
  state transitions and one 15-minute deadline while retaining the two-minute
  cap on each Docker command. After Compose starts the fixed topology, it polls
  for up to 90 seconds of service-health convergence without recreating
  containers and commits installation state only after health succeeds; failed
  updates retain the prior manifest plus staged candidate. Health also checks
  the `devryan-bots-host-control` bridge for two retired topologies. A bridge
  still carrying the no-masquerade policy (unroutable on Docker Desktop after a
  VM restart) marks the runtime degraded, and repair recreates it by removing
  the attached fixed services, gracefully stopping and removing the
  supervisor-created reasoning and computer containers (their named volumes
  survive and the supervisor recreates them on demand), dropping the bridge,
  and letting Compose rebuild it. A reasoning or computer container still
  attached to a current bridge holds a retired route to the host and the public
  internet; that also marks the runtime degraded, and repair stops and removes
  just those containers, leaving the bridge and the first-party services that
  publish loopback ports through it untouched. It emits only
  sanitized phase/count/code snapshots with terminal `ready`/`failed` guarantees
  through runtime capability state. Docker Desktop's virtualized socket group
  and native Linux's resolved socket group are supplied only to the engine-proxy
  container; the supervisor has no socket mount. Server callbacks accept only fixed
  scoped ensure/inspect/stop contracts, discover only Compose-published
  loopback service ports, and verify host-derived config/auth paths before the
  supervisor is called; no callback accepts raw Docker input. Reasoning
  containers publish no host port: the manager converts the supervisor's
  in-memory scoped runtime capability into a loopback host/port/path endpoint
  for the in-process server without exposing that capability to the renderer. It
  purpose-derives supervisor/engine-proxy/egress-signing/egress-control/indexer credentials and
  a public deployment ID from the OS-sealed key, wiping the defensive key copy
  immediately; only those scoped values enter Compose. Named runtime/index
  volumes survive repair and quit. Its indexer callback accepts only the fixed
  status/upsert/delete/search/rebuild verbs, resolves the Compose-published
  loopback port, and supplies the derived bearer only inside Electron. For reasoning starts it signs the exact
  validated model-host allowlist, starts the scoped container, and then attests
  the current Bot/revision through the separately authenticated egress control
  route; failed attestation stops the container. Electron injects status and
  fixed control callbacks beside the key callback into the in-process server so
  `/api/bots/capabilities` can distinguish Docker/setup/update health without
  exposing Docker mutations outside the main process. The manager also exposes
  typed server-only workspace-write and Shared-import callbacks. They validate
  Bot/channel/message/file/content/hash bounds and forward only fixed supervisor
  operations; renderer IPC cannot invoke them and no callback accepts a host
  path. Shared import targets the deterministic Bot-wide volume and verifies
  exact bytes before readiness. Before reasoning starts,
  the same manager recursively validates the fixed private per-run artifact
  staging tree and its manifest without following links, then allows only the
  supervisor-derived read-only `/workspace/.devryan` mount. It separately walks
  the compiled revision's bounded Skill tree, rejects links/special files/hard
  links/private-mode drift, and verifies every file digest before the supervisor
  derives the read-only `/workspace/.opencode/skills` mount. Fixed reset verbs
  remove only the selected scoped reasoning/profile/scratch/Shared volume.
  Ordinary replacement and repair retain Shared. Recovery
  profile export/restore inventories exact deployment/Bot/scope labels, uses a
  no-network capability-dropped helper container, verifies archive hashes, and
  never accepts a renderer-selected Docker name or argument.
  Agent-endpoint requests and Chromium networking also receive
  purpose-separated egress capabilities. Browser tokens bind `public_only` or
  exact-host allowlist policy and rotate through the computer's loopback relay,
  reached over the supervisor's scoped runtime proxy because the computer
  publishes no host port of its own.
  `runsc` activation requires both a declared Docker runtime and a disposable
  owned smoke container; failure blocks publication/startup with no downgrade.
- **Quit-risk projection**: `quit-risk.mjs` converts server scheduler, tunnel,
  active Bot run/approval, due app-bound Bot routine, routine-scheduler, and
  checkpoint status into an atomic desktop warning snapshot, distinguishes
  future pending schedules from merely enabled historical records, and reports
  verification failures without retaining stale counts. Scheduler status is
  refreshed against authoritative owner/branch access immediately before the
  projection.
- **Operational hardening**: single-instance lock, persistent logging via
  `electron-log`, stale log pruning, and unthrottled renderer paints for chat
  windows so packaged streaming/status updates stay responsive. Development
  launches isolate Electron `userData`. Ordinary startup waits only for bounded
  local HTTP/control readiness and activates the renderer before the 15-minute
  Docker `ensureReady` work begins in the background. A Bot-only failure remains
  an explicit fail-closed capability without blocking the coding UI. In service
  mode, SIGTERM/SIGINT checkpoint and stop the owned runtime; closing foreground
  windows releases the desktop broker but leaves the launchd owner running.
- **Cache maintenance**: `cache-maintenance.mjs` measures and clears Electron HTTP/code caches for the app session, the agent-browser partition, and every registered isolated manual-browser partition during startup maintenance and Settings/Help cleanup actions, without touching current app storage such as localStorage, cookies, or IndexedDB.
- **Browser surface ownership**: `browser-surface-manager.mjs` owns manual and lease `WebContentsView` instances. Ordinary agent leases retain the dedicated legacy partition; configured branch previews use a main-derived persistent partition hashed from authoritative owner ID plus exact preview origin, while manual surfaces use a separate hash of canonical DevRyan origin plus authenticated renderer principal ID. `branch-preview-browser.mjs` validates that identity and injects Cloudflare Access headers only for matching HTTPS requests and WSS handshakes to the authoritative preview origin; the Electron host's network performs that egress. The main process resolves `/auth/session`, enforces the Browser capability for local and configured remote renderers, periodically revalidates active contexts, and destroys manual surfaces on logout, account change, or revocation. A one-time migration clears the former shared profile because its cookies cannot safely be assigned to one user; an Electron-owned registry retains only hashed partition names for cache maintenance. Renderer IPC names allowlisted surface/workspace IDs, and the manager validates the requesting window, authenticated context, and clamped bounds before navigation, layout, capture, inspection, DevTools, viewport emulation, pop-out, dock, focus, activation, or release. Element inspection removes its overlay, waits for the clean frame, then returns bounded rendered markup and an immediate PNG page capture in one correlated result; shared UI crops that frame to the padded visible element bounds. Token-free snapshots carry the sanitized Responsive/Desktop/Mobile mode plus length-capped page favicon metadata; navigation clears stale favicons before the next `page-favicon-updated` event. Fixed modes use Electron device emulation with centered, no-upscale bounds and are reapplied whenever a surface is attached or laid out. Manual surfaces are grouped by opaque workspace ID so one pop-out hosts the active page while sibling views remain parked; switching pages preserves DOM/history/cookies within that user's profile.
- **Navigation outcomes**: `browser-navigation-error.mjs` classifies Electron's benign `ERR_ABORTED` result so superseded or redirected app-window and browser-surface navigations do not surface as failures; all other navigation errors remain rejected.
- **Browser DevTools**: `browser-devtools-controller.mjs` idempotently opens or closes Chromium DevTools in a caller-owned `WebContentsView`, clamps its dock bounds, and can rehost the same dock with its browser surface across pop-out/dock transitions. Electron's custom host uses `detach` mode while view bounds provide the physical dock.
- **Session-scoped agent browser leases**: `browser-cdp-bridge.mjs` owns one asynchronous loopback WebSocket listener and a fenced map of per-lease capability token, main-owned surface contents, debugger session, client, in-flight commands, and orphan timer. The renderer batch-claims exact `(directory, rootSessionId)` ownership when it has the session locally. For authoritative managed ownership, `main.mjs` may instead broker the remote account through the single privileged workstation main window, without requiring that renderer to log into the remote owner. It creates and binds the surface before returning the private capability URL and publishes token-free metadata plus a surface ID only to the host window. Moving or popping the surface does not change lease ownership, CDP attachment, context claims, or menu presence. Agent input is projected through one isolated-world 28×32 system-arrow overlay whose hotspot is its tip, whose pressed state scales subtly, and which hides after four idle seconds. Agent screenshots temporarily suppress the overlay, while observation frames retain it.
- **Demand-driven browser observation**: `browser-surface-manager.mjs` owns one shared capture loop per observed lease. It permits one capture in flight, caps output at 1280×720, emits JPEG quality 65 at no more than eight frames per second, drops frames for backpressured subscribers, retains no frame history, and stops immediately with the final subscriber. App-bound server callbacks consume it directly; runtime-service callbacks relay the same multipart stream through the authenticated foreground desktop-host broker. Endpoint absence or foreground-host loss is a view-only availability failure and does not mutate CDP control or lease lifecycle.
- **Managed agent-browser runtime**: Electron lazily provisions the packaged `agent-browser` skill and exact pinned CLI under the active `OPENCHAMBER_DATA_DIR` only from the managed-child launch callback. Configured external/remote OpenCode runtimes are not mutated. The three private child variables are supplied through that injected lifecycle callback instead of ambient `process.env`. Local-only `desktop_agent_browser_status|install|repair` IPC supports Settings without exposing mutation over HTTP; failures are nonfatal to desktop startup.
- **Diagnostics export**: `desktop_export_diagnostics` owns the native save
  dialog and streams the in-process server ZIP through a private sibling
  temporary file, fsync, and atomic rename.
- **Release authority**: packaged update discovery and `electron-updater`
  publishing both target the canonical `1H-Team/DevRyan` GitHub repository.

## Flow
1. Electron establishes process guards, protocol registration, logging, and the
   data-directory runtime owner mode.
2. `--runtime-service` acquires the service generation, starts the loopback web
   runtime without a window, marks the versioned handshake healthy, and begins
   Bot/Docker preparation asynchronously.
3. A migrated foreground app reads the descriptor, consumes its rotating
   bootstrap into a renderer cookie, connects the desktop-host broker, and
   activates its window. App-bound compatibility mode instead acquires the
   in-process owner and starts that same server locally.
4. The renderer activates after bounded HTTP/control readiness. Bot preparation
   reconciles gateway/indexer/memory/routine/recovery services and warms the
   model catalog in the background; per-run adapters/credentials and scoped
   containers remain lazy.
5. `preload.mjs` injects shell flags/global values and wires IPC invoke/listen
   channels. Service-mode Bot runtime verbs use the authenticated loopback
   contract; foreground-only capabilities use the short desktop broker.
6. Closing the foreground app persists window state, closes native browser
   leases/broker state, and exits without stopping the service. Service disable
   or update explicitly checkpoints, drains, proves owner release, and then
   unregisters/re-registers as required.

## Integration
- **Depends on**: `@openchamber/web` server entrypoint, Electron runtime APIs, `electron-updater`, OS facilities.
- **Consumes/hosts**: web UI bundle served from local web server; startup splash and boot metadata are injected from main process.
- **Contract with shared UI**: `__TAURI__` invoke commands and emitted `openchamber:*` events. Browser surfaces use local-only `desktop_browser_surface_*` operations plus surface-ID capture and DevTools commands; manual groups add local-only `desktop_browser_workspace_*` activate/pop-out/dock/focus operations. Window-scoped token-free `browser-surface-updated` snapshots include manual workspace/tab identity. Agent leases use snapshot, exact context claims, observed-lease selection, `desktop_agent_browser_*`, window-scoped `browser-agent-leases`, and global-count-only `browser-agent-lease-total`; the old bind command remains a compatibility status read instead of accepting renderer `webContentsId` ownership.
- **Packaging/release hooks**: `packages/electron/scripts/*` for bundling the main process, native bridge build/signing, archive verification, and release metadata finalization.
- **Window-state persistence**: `window-state-persistence.mjs` snapshots native `BrowserWindow` values before queued settings writes, so shutdown never retains a destroyed native window.
- **Quit cleanup**: `quit-cleanup.mjs` checkpoints Bot runs, stops Bot
  dispatcher/index requests, then orders normal app quit after general
  owned-resource cleanup; it deduplicates the main-process stop promise and
  bounds a genuinely hung cleanup at ten seconds without deleting named Bot
  volumes.
- **Native packaging verification**: `scripts/native-module-paths.mjs` resolves workspace/transitive native modules without assuming Bun hoisting, while `scripts/packaged-native-modules.mjs` rejects artifacts missing required Electron ABI bindings or Cursor SDK platform artifacts (`rg`, `cursorsandbox`, and both tree-sitter bindings). `scripts/verify-runtime-service-package.mjs` separately enforces the in-process background bridge and LaunchAgent contract in the unpacked app, ZIP, and DMG for both release architectures; unsigned artifacts must expose the usable private-agent fallback and may not probe as `not_found`. Cursor SDK 1.0.28 uses Node's built-in SQLite, so no transitive Cursor `sqlite3` ABI rebuild is performed.
- **Regression suite**: `bun run test` recursively discovers Electron `*.test.*` files outside generated/package output and runs them under Bun; the suite contract rejects missed files, and the root full and affected validation gates invoke this package suite.
- **Browser inspection acceptance**: `tests/browser-inspection/run.mjs` explicitly
  launches the pinned Electron runtime with an isolated temporary profile and
  network-blocked in-memory tooltip fixture. It executes the managed browser
  plugin's generated inspection script in Chromium and verifies present,
  dismissed, ambiguous, invalid-selector, and escaped-selector results without
  loading the production runtime or touching its journal; see the fixture README.
- **Native pointer acceptance**: `scripts/bot-catalog-native-pointer-smoke.mjs`
  launches the current source Electron runtime with isolated DevRyan and Chromium
  data, signs in through the loopback-only Test Administrator endpoint, locates
  the enabled Bots Catalog create control through CDP, then delegates the actual
  click to `macos-pointer-click.swift` as a CoreGraphics HID event. CDP is used
  only to locate the control and assert/capture the resulting dialog, so the
  smoke exercises AppKit draggable-region hit testing instead of bypassing it.
  Run it explicitly with `bun run electron:test:native-pointer` on an
  interactive, Accessibility-authorized macOS verification host; it is not a
  skipped substitute in the platform-neutral unit suite.
