# Tauri to Electron cutover: decision record

Whether and when to retire the legacy Tauri shell is a separate user decision.
This record states what is already true, what a cutover would still require, and
the constraints any plan must keep. It is not an executable playbook: the
workflow-level steps of the original design targeted a release pipeline that no
longer exists and are in git history.

## What is already true

- Electron (`packages/electron`) is the only desktop shell that receives
  features. `packages/desktop` is the legacy Tauri shell, retained only so that
  already-installed Tauri apps keep a working auto-update path. Add nothing
  there; see [`packages/desktop/README.md`](../packages/desktop/README.md).
- Releases publish only the branded `DevRyan-<version>-arm64.dmg` (plus the web
  tarball in the `full` scope). The per-architecture update manifests, ZIPs,
  blockmaps and manifest-merge jobs are gone. Release assets are governed by
  [Release pipeline](RELEASE_PIPELINE.md).
- Installed Electron apps update through the in-app, verified DMG updater
  (`packages/electron/desktop-updater.mjs`, `desktop-updater-macos.mjs`,
  `desktop-update-install.mjs`), not through a manifest-driven updater.
- Both shells are meant to resolve the same user settings file (`settings.json`
  under the OpenChamber data directory, overridable with `OPENCHAMBER_DATA_DIR`)
  so a migrated install keeps its hosts, default host and history. Re-audit
  `settings_file_path` in the Tauri sources against the Electron settings module
  before any cutover; if they diverge, the migration loses user data.
- The Tauri bundle identifier (`ai.opencode.openchamber`, in
  `packages/desktop/src-tauri/tauri.conf.json`) and the Electron `appId`
  (`packages/electron/package.json`) differ.

## What a cutover would still need

The only migration mechanism that needs no action from Tauri users is a
one-shot "transition release": Tauri's updater downloads whatever signed
`.tar.gz` its manifest points at and unpacks it over the existing `.app`
without inspecting the payload. Repackaging the signed, notarized Electron app
as that payload, signed with the existing Tauri minisign key, turns the Tauri
install into the Electron app in place. Updates then flow through the Electron
updater. The migration is one-way.

That design predates the DMG-only release and must be requalified before any
decision:

1. **Release pipeline.** The Tauri build jobs and the Tauri update manifest are
   no longer produced. A transition release would have to reintroduce a signed
   Tauri-format payload and manifest for that one release only, and it must
   respect the release asset allowlist in `AGENTS.md` and
   [Release pipeline](RELEASE_PIPELINE.md); the allowlist rejects extra assets,
   so the allowlist and its verification need an explicit, reviewed exception.
2. **Updater parity.** Confirm the Electron DMG updater, not a legacy
   manifest updater, is what the migrated app will use next.
3. **Secrets.** The Tauri minisign key and Apple signing and notarization
   secrets must still be valid. Run a dry-run workflow with a test tag before the
   real tag.
4. **Stability.** The Electron update path should have shipped stably for at
   least two releases, with a real auto-update observed, before stacking risk.
5. **Cleanup in a separate change.** After the transition release has been out
   for at least two weeks with no rollback, remove `packages/desktop`, dead
   `isTauriShell()` branches in `packages/ui` (audit each, since the preload
   exposes a compatibility shim) and this record. Never fold the cleanup into the
   transition release.

## Validation required before tagging

Test with a real Tauri install, not a simulation:

1. Install the last Tauri release; confirm its bundle identifier in
   `Contents/Info.plist`.
2. Publish the transition build under a test tag and let the workflow finish.
3. Use the app's "Check for updates", accept, and confirm download, verify,
   extract and restart.
4. After restart, confirm the identifier is now the Electron one, settings are
   intact and "Check for updates" reports up to date.
5. Publish a dummy Electron-only release and confirm the next update works.

If any step fails, delete the test tag and release; do not remove assets from a
real tag until the rollback below.

## Rollback

If the transition update bricks installs: delete the transition payload and its
Tauri manifest from the release (keep the DMGs so manual download works),
re-publish the previous version's manifest so Tauri updaters see "up to date",
and tell affected users to download the DMG and drag-replace (their settings
survive). Fix the workflow and retry under a new version.

## Known risks

- **Changed bundle identifier at the same path.** LaunchServices rebuilds its
  cache on next launch; `killall Dock` or a re-login fixes odd states.
- **Notification permission** is per bundle identifier, so the first
  notification re-prompts.
- **Deep-link protocol** registration moves to the new identifier on first
  launch; test it after migration.
- **Gatekeeper "damaged app"** can occur if the extractor corrupts extended
  attributes; test on a pristine macOS install.
- **Very old Tauri builds** that cannot fetch-verify-extract stay on their
  version until manually updated.
- **No per-user rollback** after migration: the Tauri updater is gone.

Surface only the business decision (cut over this release, or hold another
cycle); make the technical calls in the plan itself.
