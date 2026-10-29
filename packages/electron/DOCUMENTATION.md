# Electron startup ownership

## Electron runtime version

The shell runs Electron 44.9.3 (Chromium 152, Node 24.22, `NODE_MODULE_VERSION`
149), pinned exactly in the root and `packages/electron` manifests. It requires
macOS 13 or later; the bundled `Electron.app` declares `LSMinimumSystemVersion`
13.0. Changes that follow from the 42–44 majors:

- The `electron` package no longer downloads its binary at install; it
  downloads on the first resolution of `require('electron')`. The
  `postinstall` script `scripts/sign-dev-electron.mjs` resolves it that way
  before ad-hoc signing the dev binary with the stable `dev.devryan.desktop`
  identifier, and skips signing (without failing the install) when the
  download is unavailable. Packaging is unaffected: electron-builder fetches
  its own Electron distribution.
- `clipboard` methods return Promises. Main-process writes catch the
  rejection; the context menu uses `electron-context-menu` 5.x, which writes
  links through `ClipboardItem`.
- `scripts/rebuild-native.mjs` rebuilds `node-pty` and `better-sqlite3`
  against the pinned version through `@electron/rebuild`, whose `node-abi`
  must know the target ABI (4.36.0 or later for Electron 44).
- macOS notifications use `UNNotification`, which needs a code-signed app; an
  unsigned app gets the existing `failed` handler.

## Removed Bots and the retired runtime service

Bots were removed: the app has no Bot code, IPC, Docker use or Bot packaging, and
startup does no Bot or Docker work. Startup never calls Electron `safeStorage`,
so no launch reads the "DevRyan Safe Storage" keychain item (ad-hoc signed
builds otherwise prompt for it after every update).

The background runtime service (`--runtime-service`) existed only for Bots and
is retired. The bundle still ships both LaunchAgent plists and
`DevRyanRuntimeServiceControl.node`: installed 2.x updaters verify them in a
candidate bundle, and the native bridge also performs the updater's exclusive
rename/swap. A launch with `--runtime-service` exits 0 in `early-startup.mjs`
(the plist's `KeepAlive` restarts only on failure). Before the initial URL,
`retireRuntimeServiceRegistration` (`runtime-service-startup.mjs`) checks
`runtime-service/retired.v1`; without it, it unregisters an enabled or pending
registration, proves its owner stopped, clears the old `productionBots*Runtime*`
settings and writes the marker. Failure is logged and retried next launch.
`runtime-service.mjs` keeps only the app-bound owner lock and reclaims a stopped
legacy `service` owner; acquisition deletes the old sealed `handshake.v1.json`.

The repository's `bun run build` builds the web UI through `build:web-assets`, which stages the same assets into `resources/web-dist`, then bundles Electron's main process. Full validation uses this explicit build before tests; it does not rely on install-time preparation for packaged web assets.

The production package enters `dist-bundle/entry.mjs`. This small Electron and standard-library entry configures the profile and single-instance lock, queues deep links, and shows the existing splash before importing the main-process bundle. Retired runtime-service launches exit at once; status-probe launches skip window creation. Closing the early splash cancels startup. After showing, the entry yields two renderer animation frames before importing main; this gives the compositor a scheduling opportunity, while actual visible timing remains a native benchmark requirement. Failed foreground imports keep bounded diagnostics and Retry on this window; failed headless imports exit without a dialog. `early-startup.mjs` owns this temporary window until `main.mjs` adopts it and attaches the normal navigation, guest, lifecycle and quit handlers; startup creates only one window.

`createStartupWindowOptions` is shared by early and ordinary windows so preload isolation and runtime capability arguments remain consistent. Adoption keeps the already committed early splash document instead of loading a second splash. The early splash has no runtime authority: native artifact, ownership, service and renderer readiness gates still run before usable chat. Local theme and retained geometry are applied when the main module takes ownership.

The bundler copies the entry, early startup and splash modules alongside `main.mjs`, keeps the early startup module external so both entries share one window, and records their hashes in `main.inputs.json`. Packaging includes these exact files; Windows preview keeps its existing dedicated bootstrap.

On macOS, an authoritative `bundle_execution_unsettled` startup failure exposes **Prepare recovery for restart**. Only navigation from the exact native failure page can invoke it. The main process rereads the selected binding and sends its control root and revision to `beginNativeBundleRebootRecovery`; renderer URLs never choose ledger or lease paths. Preparation preserves retained data and requires a subsequent computer boot. It does not reboot the machine. After preparation the native screen explains why restarting only DevRyan cannot finish recovery. A refused preparation is logged and shown with the action still available, and `bundle_reboot_recovery_changed` offers the same action so a stale fence can be replaced. The web runtime owns the guarded startup completion and boot identity checks.

`tests/early-startup.test.mjs` covers window adoption, security guards, early close and deferred links. `startup-splash.test.mjs` covers recovery presentation and action authority. Native GUI first-paint and final signed installer verification remain separate acceptance gates.

`main.mjs` first imports `../shared-runtime/lib/adopt-legacy-environment.js` (accepted `OPENCHAMBER_*` aliases), then, after the login-shell data-root merge and before any data-root reader, runs the one-time `~/.config/openchamber` → `~/.config/devryan` move through `@devryan/web`'s `data-root-startup.js`. The host data root comes from the shared resolver. Main and preload use `devryan:*` IPC channels and `--devryan-*` preload flags; preload and the menu also deliver each `devryan:*` desktop event, and the desktop globals, under their `openchamber` aliases for a remote DevRyan of an older version. Both `devryan://` and `openchamber://` deep links are registered and accepted. The quit-risk status probes call `/api/devryan/*` and fall back to the `/api/openchamber/*` alias of an older runtime service. The package is `@devryan/electron`. Before the single-instance lock, `early-startup.mjs` keeps an existing `@openchamber/electron` Chromium profile at its original path so cookies and IndexedDB remain readable; a fresh install uses `@devryan/electron`. Existing browser partitions keep their old names only when the profile or partition directory predates the rename. Fresh partitions use `persist:devryan-browser*`.

The macOS bundle ID and new runtime-service label are `dev.devryan.desktop`. The updater verifier accepts a signed 2.0 bundle with the old ID as the installed source and requires the canonical ID for a newly staged candidate. An old update intent may still recover using its recorded identity. The packaged native bridge can inspect and unregister the old SMAppService registration; the old plist stays in the bundle for that migration. The registration owner must be stopped before the new label is registered. Actual installed-app upgrade remains a release qualification gate.

Relaunch temporarily restores the shell-owned data root (both `DEVRYAN_DATA_DIR` and its alias, exactly) and original explicit runtime root. An automatically injected runtime root is omitted from the child, while an explicitly supplied root is preserved. Parent runtime variables are restored even if scheduling relaunch fails.

Runtime ownership acquisition has a 45-second budget, passed through to each mutation-lock attempt. Only `runtime_service_owner_busy` is retried; each pending acquisition is awaited to settlement. The splash reports “Waiting for the previous DevRyan to finish closing…”. Other ownership failures and the existing forced-exit deadline are unchanged.

The shell imports web code only through `@devryan/web` `exports` (see `packages/web/server/lib/opencode/runtime-host/DOCUMENTATION.md`); `bundle-main.mjs` keeps those imports external, so Node resolves them in the packaged app. It inspects the native selection with the pure `readRuntimeBundleBinding`/`readNativeShellBundleBinding`; only the in-process web launcher binds it.

Connect Remote remains available for connecting the desktop interface to an existing remote DevRyan server.

`build.files` keeps out everything the packaged app never loads: source maps, tests, TypeScript and C/C++ sources, native build objects, Linux prebuilds, natives of other targets, `@devryan/web`'s own `dist` (the shell serves `Resources/web-dist`) and its `runtime/` tree (executables run from `Resources/revert-runtime`). Vendored `v2/openapi-*.json` documents and captured `v2/__vectors__/` responses are build and test inputs only and stay out of the package; the generated route table, readiness checks and route policy remain shipped. Natives of other targets are dropped with electron-builder's target macros: `${arch}` and `${os}` (`mac`, `win`) select which `*-darwin-*` / `*-win32-*` platform packages and `prebuilds/` and `bin/` native folders (with or without an ABI suffix) stay, so an arm64 Mac app ships no x64 or Windows natives, an x64 Mac build keeps its own and the Windows preview keeps its `win32-<arch>` prebuilds. The `[!${os}]in32` / `d[!${os}]rwin` character classes match `win32` / `darwin` only when the target is another OS; `packaging-payload.test.mjs` runs these patterns through electron-builder's own matcher. Universal Mac builds are not supported by these patterns. Nothing loads `.ts` from the app: Electron's Node refuses type stripping under `node_modules`, Bun processes cannot read inside `app.asar`, and the runtime-host sources are compiled into the native runtime. `@devryan/web` and `@devryan/harness-runtime` stay unpacked because out-of-process consumers (the confined Claude transport, OpenCode plugins, the session-mutation worker) read them from disk. The `afterPack` hook runs `scripts/check-packaged-app.mjs` before signing: it reads the `app.asar` header and the rest of `Resources`, and fails on forbidden content or on growth past the ceilings in `scripts/packaged-app.config.mjs`, which can only be lowered. The check takes the app's arch (afterPack passes the target's) so its `foreign-native` rule forbids the other Mac arch and Windows natives. `bun run app:check [-- --app <DevRyan.app>] [--arch x64]` runs the same check on a built app (arm64 by default).

A release is one tag push: `.github/workflows/release.yml` builds, packages and publishes
the single branded `DevRyan-<version>-arm64.dmg` asset. See
[release pipeline](../../docs/RELEASE_PIPELINE.md) for the job graph, retries and
updater contract.

## Managed browser activity

The managed installer pins agent-browser 0.39.2. Bun installs the package with
scripts disabled; Electron and confined workers invoke its native executable
rather than the Node shim (the package's shim requires Node 24). No additional
browser engine or backend is launched: commands attach through the fenced CDP
bridge to the lease's existing surface.

The Browser control shows the selected root chat's leases, including children.
Its first click opens a sole lease directly; while that lease is already visible,
the control offers the existing menu, including manual browsing. Multiple leases
use the chooser. The panel never opens from an activity event. The activity dot
respects reduced motion and keeps the existing accessible active-browser label.

Input observation starts at CDP dispatch, after compositor readiness and command
expiry checks. Coordinates must be finite numbers; keyboard metadata contains no
key or text contents. The non-interactive cursor has a 650 ms blue click pulse
that survives mouse release, and is recreated on the next input after navigation.
Capture suppression removes both cursor and pulse; restoring the cursor does not
replay the click. The ordinary web observation stream captures the same surface.
Recording capture retains its own cursor behavior and suppression contract.

`tests/browser-inspection/upgrade-install.mjs` verifies fresh/no-op/repair and
0.38.1 upgrades against the registry. `upgrade-run.mjs` exercises the native CLI,
actual Chromium input, visual pulse, recording, observation and confined workers.
`scripts/qa/browser-live.mjs` exercises the full desktop/native-runtime path with
local deterministic model decisions. See the inspection README for invocation
and evidence-retention details.
