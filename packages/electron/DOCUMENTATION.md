# Electron startup ownership

## Bots retirement

Bots are disabled by the shared product capability. Main wires no Bot IPC,
runtime manager, key store, recovery dialog or Docker launcher, and packaging no
longer requires or ships Bot manifests, Compose or SQL. Startup never calls
Electron `safeStorage`, so no launch reads the "DevRyan Safe Storage" keychain
item (ad-hoc signed builds otherwise prompt for it after every update).

After normal foreground startup and update acceptance, `bot-retirement.mjs`
runs until it succeeds once. If `bots/keys/deployment-key.v1` exists it stops
containers labelled `devryan.runtime=production-bots`, disables their Docker
restart policy, deletes `bots/keys` and writes `bots/retired.v1`; without a key,
or without a Docker CLI, it only writes the marker. It never reads the keychain,
starts Docker, removes a container/volume, or blocks startup. A stopped Docker
daemon is a sanitized `unavailable` status retried at the next launch. Later
launches cost one stat.

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

Older Bot lifecycle descriptions below document the retained Bot implementation
(server, UI and image tooling); they are not active product behavior.


The repository's `bun run build` builds the web UI through `build:web-assets`, which stages the same assets into `resources/web-dist`, then bundles Electron's main process. Full validation uses this explicit build before tests; it does not rely on install-time preparation for packaged web assets.

Automatic Bot maintenance and catalog acquisition/context reads inspect their
owned installation state before probing Docker. A profile with no installation
returns the existing unavailable/setup-required outcome without Docker commands;
explicit Setup/status controls and maintenance of existing installations retain
their original behavior. Existing installations still get the catalog startup
needed for retention. The server then suppresses dormant retries after typed
Docker unavailability while preserving owned active work and explicit controls.

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

A release is one tag push: `.github/workflows/release.yml` builds, packages and publishes
the single branded `DevRyan-<version>-arm64.dmg` asset. See
[release pipeline](../../docs/RELEASE_PIPELINE.md) for the job graph, retries and
updater contract.
