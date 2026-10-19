# Identity compatibility

DevRyan began as a fork of OpenChamber. DevRyan names are now canonical, and the
OpenChamber names stay accepted so installed apps, saved data, user scripts and
older clients keep working. New code writes DevRyan names and reads both.

## Accepted aliases

| Canonical | Accepted alias | Where the alias is handled |
|---|---|---|
| `DEVRYAN_*` environment variables | `OPENCHAMBER_*` | `packages/shared-runtime/lib/legacy-environment.js`: every process entry adopts unset aliases, writers set both names, login-shell filters judge an alias as its DevRyan name |

Readers keep accepting an alias indefinitely; removing one needs its own
migration and a release note.

## Kept unchanged

- The app bundle ID `dev.openchamber.desktop` and everything bound to it: the
  updater, keychain items, the SMAppService/launchd label and plist names,
  macOS preferences and the `dev.openchamber.desktop.macos-speech-helper` ID.
- The frozen legacy Tauri package `packages/desktop`.
- Environment names sent to an SSH host's DevRyan CLI: `ssh-managed-probe.mjs`
  sends both names, because the remote CLI may be an older release.
