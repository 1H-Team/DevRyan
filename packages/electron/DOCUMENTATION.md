# Electron startup ownership

Automatic Bot maintenance and catalog acquisition/context reads inspect their
owned installation state before probing Docker. A profile with no installation
returns the existing unavailable/setup-required outcome without Docker commands;
explicit Setup/status controls and maintenance of existing installations retain
their original behavior. Existing installations still get the catalog startup
needed for retention. The server then suppresses dormant retries after typed
Docker unavailability while preserving owned active work and explicit controls.

The production package enters `dist-bundle/entry.mjs`. This small Electron and standard-library entry configures the profile and single-instance lock, queues deep links, and shows the existing splash before importing the main-process bundle. Runtime-service and status-probe launches skip window creation. Closing the early splash cancels startup. After showing, the entry yields two renderer animation frames before importing main; this gives the compositor a scheduling opportunity, while actual visible timing remains a native benchmark requirement. Failed foreground imports keep bounded diagnostics and Retry on this window; failed headless imports exit without a dialog. `early-startup.mjs` owns this temporary window until `main.mjs` adopts it and attaches the normal navigation, guest, lifecycle and quit handlers; startup creates only one window.

`createStartupWindowOptions` is shared by early and ordinary windows so preload isolation and runtime capability arguments remain consistent. Adoption keeps the already committed early splash document instead of loading a second splash. The early splash has no runtime authority: native artifact, ownership, service and renderer readiness gates still run before usable chat. Local theme and retained geometry are applied when the main module takes ownership.

The bundler copies the entry, early startup and splash modules alongside `main.mjs`, keeps the early startup module external so both entries share one window, and records their hashes in `main.inputs.json`. Packaging includes these exact files; Windows preview keeps its existing dedicated bootstrap.

On macOS, an authoritative `bundle_execution_unsettled` startup failure exposes **Prepare recovery for restart**. Only navigation from the exact native failure page can invoke it. The main process rereads the selected binding and sends its control root and revision to `beginNativeBundleRebootRecovery`; renderer URLs never choose ledger or lease paths. Preparation preserves retained data and requires a subsequent computer boot. It does not reboot the machine. After preparation the native screen explains why restarting only DevRyan cannot finish recovery. A refused preparation is logged and shown with the action still available, and `bundle_reboot_recovery_changed` offers the same action so a stale fence can be replaced. The web runtime owns the guarded startup completion and boot identity checks.

`tests/early-startup.test.mjs` covers window adoption, security guards, early close and deferred links. `startup-splash.test.mjs` covers recovery presentation and action authority. Native GUI first-paint and final signed installer verification remain separate acceptance gates.

Relaunch temporarily restores the shell-owned data root and original explicit runtime root. An automatically injected runtime root is omitted from the child, while an explicitly supplied root is preserved. Parent runtime variables are restored even if scheduling relaunch fails.

Runtime ownership acquisition has a 45-second budget, passed through to each mutation-lock attempt. Only `runtime_service_owner_busy` is retried; each pending acquisition is awaited to settlement. The splash reports “Waiting for the previous DevRyan to finish closing…”. Other ownership failures and the existing forced-exit deadline are unchanged.

Background service is opt-in through `enableBackgroundBots`. Fresh and app-bound startup never register it. Explicit service installations retain upgrade/re-registration and their stored configuration during guarded app-bound recovery. Non-service startup removes a stray registration left by an interrupted handoff and proves its owner stopped before app-bound acquisition. Uncertain owner absence fails closed. Registration inspection and app-bound startup do not depend on Docker availability.

`runtime-service-connection.mjs` owns the foreground connection to this app's background runtime service: renderer-session bootstrap, the desktop-host broker and lease with its 10-second refresh, reconnecting to a replaced owner and reloading windows attached to it, retiring a service from another app version, and detaching. `main.mjs` builds it with injected dependencies and delegates `connectToRuntimeService` and `stopDesktopHostBroker` to it; it adds no backend process. Each connection has a local generation and an `AbortController`. A new connection or a disconnect aborts the previous connection's in-flight bootstrap and lease requests. After every await the connection rechecks its identity before it installs the renderer cookie, publishes `state.runtimeServiceClient`/`sidecarUrl`, arms the refresh timer, reconnects or calls `loadURL`. A replaced connection rejects with the non-retryable `runtime_service_connection_superseded` and leaves the broker to its replacement. A deferred reconnect keeps refreshing the replaced owner, so the next failed refresh retries it. The remote checks are unchanged: protocol, descriptor owner, app version, the lease handshake's instance, owner generation and protocol, and the reconnect instance. `tests/runtime-service-connection.test.mjs` exercises the owner directly.

The shell imports web code only through `@openchamber/web` `exports` (see `packages/web/server/lib/opencode/runtime-host/DOCUMENTATION.md`); `bundle-main.mjs` keeps those imports external, so Node resolves them in the packaged app. It inspects the native selection with the pure `readRuntimeBundleBinding`/`readNativeShellBundleBinding`; only the in-process web launcher binds it.

Connect Remote remains available for connecting the desktop interface to an existing remote DevRyan server.

A release is one tag push: `.github/workflows/release.yml` builds, packages and publishes
the single branded `DevRyan-<version>-arm64.dmg` asset. See
[release pipeline](../../docs/RELEASE_PIPELINE.md) for the job graph, retries and
updater contract.
