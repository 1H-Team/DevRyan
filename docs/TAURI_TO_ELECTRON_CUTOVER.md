# Tauri to Electron cutover: decision record

Whether and when to retire the legacy Tauri shell is a separate user decision.
This record states what is already true, what a cutover would still require, and
the constraints any plan must keep. It is not an executable playbook: the
workflow-level steps of the original design targeted a release pipeline that no
longer exists and are in git history.

## What is already true

- Electron (`packages/electron`) is the only desktop shell that receives
  features. `packages/desktop` is the legacy Tauri shell, retained for installed
  app compatibility. Its source identity migration does not establish a working
  installed-app update path; see
  [`packages/desktop/README.md`](../packages/desktop/README.md).
- Releases publish exactly one asset, the branded `DevRyan-<version>-arm64.dmg`.
  There is no web tarball, and the per-architecture update manifests, ZIPs,
  blockmaps and manifest-merge jobs are gone. Release assets are governed by
  [Release pipeline](RELEASE_PIPELINE.md).
- Installed Electron apps update through the in-app, verified DMG updater
  (`packages/electron/desktop-updater.mjs`, `desktop-updater-macos.mjs`,
  `desktop-update-install.mjs`), not through a manifest-driven updater.
- Both shells are meant to resolve the same user settings file (`settings.json`
  under the DevRyan data directory, overridable with `DEVRYAN_DATA_DIR`)
  so a migrated install keeps its hosts, default host and history. Re-audit
  `settings_file_path` in the Tauri sources against the Electron settings module
  before any cutover; if they diverge, the migration loses user data.
- New Tauri and Electron manifests use `dev.devryan.desktop`. Released Tauri
  apps used `ai.opencode.openchamber`, and released Electron apps used
  `dev.openchamber.desktop`. Those installed identities remain migration inputs;
  changing source manifests does not migrate an installed app. See
  [Identity compatibility](IDENTITY_COMPATIBILITY.md).

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
   secrets must still be valid. Run a dry run (`gh workflow run release.yml`)
   before the real tag; `bun run release:tag` requires one. Never push a test
   tag: every `vX.Y.Z` tag push publishes.
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
2. On an isolated host, point that install at a private test feed serving the
   transition build from a dry run. Never publish it to this repository to test
   it: a published release is final, and installed apps discover it.
3. Use the app's "Check for updates", accept, and confirm download, verify,
   extract and restart.
4. After restart, confirm the identifier is now the Electron one, settings are
   intact and "Check for updates" reports up to date.
5. Serve a later Electron-only build from the same test feed and confirm the
   next update works.

If any step fails, fix it and test again on the test feed. Nothing has been
published, so nothing needs undoing.

## Rollback

A published release is final: its assets and its `devryan-release/` ledger tag
are never deleted, edited or replaced ([Release pipeline](RELEASE_PIPELINE.md)).
If the transition update bricks installs, roll forward: publish a new patch
version whose Tauri manifest offers no transition payload, so Tauri updaters
see "up to date". Tell affected users to download the DMG and drag-replace it
(their settings survive). Fix the workflow before retrying under another new
version.

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
