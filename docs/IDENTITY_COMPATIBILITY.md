# Identity compatibility

DevRyan began as a fork of OpenChamber. DevRyan names are now canonical, and the
OpenChamber names stay accepted so installed apps, saved data, user scripts and
older clients keep working. New code writes DevRyan names and reads both.

## Accepted aliases

| Canonical | Accepted alias | Where the alias is handled |
|---|---|---|
| `DEVRYAN_*` environment variables | `OPENCHAMBER_*` | `packages/shared-runtime/lib/legacy-environment.js`: every process entry adopts unset aliases, writers set both names, login-shell filters judge an alias as its DevRyan name |
| `~/.config/devryan` data folder | `~/.config/openchamber` | `packages/harness-runtime/lib/data-root-migration.js` moves it once at startup and leaves a link; `packages/shared-runtime/lib/data-root.js` resolves the root everywhere |

## Data folder migration

Electron main (before its first data-root reader), the web server entry (outside
Electron) and the CLI run `migrateDataRootAtStartup`
(`packages/web/server/lib/opencode/runtime-host/data-root-startup.js`). It does
nothing when `DEVRYAN_DATA_DIR` names another folder, on Windows, or under a test
runner. Otherwise, under `<XDG_STATE_HOME>/devryan/migrations/data-root.lock`:

1. A marker (`.devryan-migration.json`) is written into the old folder, the folder
   is renamed to `~/.config/devryan`, and `~/.config/openchamber` becomes the
   relative link `devryan`. A crash after the rename is finished at the next start.
2. When both folders exist, old entries move in; names that already exist go to
   `~/.config/devryan/legacy-openchamber-<time>/`. A failed move is rolled back.
3. When the folder cannot move (`EXDEV`, `EBUSY`, `EPERM`, `EACCES`, `EROFS`; a
   Docker bind mount, for example), it stays in use and the open app shows a
   notice.

Until the move succeeds, `resolveDevRyanDataRoot` keeps returning the old folder
while it is a real directory, so an old install keeps working. Older DevRyan
processes still running keep working through the link. Records sealed with the
old path (a bundle's `reviewed-native.json` `protectedRoots`) are not rewritten:
their consumers canonicalise paths. The legacy launchd plist is not rewritten:
launchd reads it only at bootstrap, its log paths resolve through the link, and a
new registration writes the resolved root.

Readers keep accepting an alias indefinitely; removing one needs its own
migration and a release note.

## Kept unchanged

- The app bundle ID `dev.openchamber.desktop` and everything bound to it: the
  updater, keychain items, the SMAppService/launchd label and plist names,
  macOS preferences and the `dev.openchamber.desktop.macos-speech-helper` ID.
- The Electron package name `@openchamber/electron`. The packaged
  `package.json` has no `productName`, so Electron derives the Chromium profile
  folder (`~/Library/Application Support/@openchamber/electron`, with the
  `-runtime-service` sibling) from this name before `app.setName('DevRyan')`
  runs; cookies, localStorage, IndexedDB and their Safe Storage key live there.
- The frozen legacy Tauri package `packages/desktop`.
- Environment names sent to an SSH host's DevRyan CLI: `ssh-managed-probe.mjs`
  sends both names, because the remote CLI may be an older release.
