# Identity compatibility

DevRyan began as a fork of OpenChamber. DevRyan names are now canonical, and the
OpenChamber names stay accepted so installed apps, saved data, user scripts and
older clients keep working. New code writes DevRyan names and reads both.

## Accepted aliases

| Canonical | Accepted alias | Where the alias is handled |
|---|---|---|
| `DEVRYAN_*` environment variables | `OPENCHAMBER_*` | `packages/shared-runtime/lib/legacy-environment.js`: every process entry adopts unset aliases, writers set both names, login-shell filters judge an alias as its DevRyan name |
| `@devryan/*` workspace packages | none (renamed) | `@openchamber/electron` and `@openchamber/desktop` keep their names (below); the import checkers accept both scopes |
| `devryan` CLI | `openchamber` | `packages/web/package.json` ships both bins; `bin/cli-entry.js` accepts either name |
| `/api/devryan/*` REST routes | `/api/openchamber/*` | `packages/web/server/lib/legacy-api-path.js` rewrites `req.url` and `req.originalUrl` as the first middleware of every composition, before admission, auth, multi-user and tunnel policy; guard regexes also match both. Electron main's status probes fall back to the alias for an older runtime service |
| `devryan:*` server event types on the wire | `openchamber:*` | Per connection: a client sending `?events=devryan` or `X-DevRyan-Events: devryan` gets `devryan:*` (`lib/event-stream/event-dialect.js`, a prefix swap on the shared payload serialization); others keep `openchamber:*`. Payloads, journals and the orchestration contract keep the `openchamber:*` literal. The UI canonicalises incoming types (`packages/ui/src/lib/eventTypes.ts`) |
| `x-devryan-message-id`, `X-DevRyan-Warning`, `x-devryan-ui-session` headers | `x-openchamber-*` | The server reads both message-id names and sets both warning headers; the preview proxy strips both session headers |
| `__DEVRYAN_*__` / `__devryan*` globals | `__OPENCHAMBER_*__` / `__openchamber*` | Preload and the main-process init script set both names for the desktop globals, for a remote DevRyan of an older version; other globals are bundle-internal |
| `devryan:*` Electron IPC channels, desktop DOM events and `--devryan-*` preload flags | `openchamber:*` | Main and preload ship together; preload and the menu re-dispatch each `devryan:*` desktop event under its alias for older remote UIs; UI error-text matching reads both |
| `devryan`-prefixed browser storage keys | `openchamber`-prefixed keys | `packages/ui/src/lib/legacyStorageMigration.ts` (and the inline script in `packages/web/index.html`) copies each old key once, before stores hydrate; old keys stay |
| `application/x-devryan-file-path` drag type, `devryan-preview-*` bridge sources | `openchamber` forms | Readers accept both; the preview bridge answers a pre-rename parent in its names |
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
- The frozen legacy Tauri package `packages/desktop` (`@openchamber/desktop`).
- The npm registry package `@openchamber/web` that `package-manager.js` updates
  a global CLI from and that `ssh-manager.mjs` installs on SSH hosts, and the
  remote `openchamber` binary those hosts run: they are external, not this
  workspace. `scripts/install.sh` is upstream's installer for that package.
- Persisted or wire-contract literals: journaled `openchamber:managed-task(-removed)`
  and other synthetic event payloads (the wire rename is per connection), the
  orchestration codec golden bytes, the `[openchamber-plan-action:v1]` message
  marker, the project action id `__openchamber_auto_discover_preview__`, theme
  ids such as `openchamber-dark`, the project-local `openchamber.json` file,
  IndexedDB database names and the in-bundle `config/openchamber` folder of
  runtime bundles (sealed into each bundle's descriptor and manifest hash).
- The `openchamber://` deep-link scheme stays registered.
- CLI daemon records `run/openchamber-<port>.{pid,json}`: a newer CLI must find
  daemons an older one started.
- Environment names sent to an SSH host's DevRyan CLI: `ssh-managed-probe.mjs`
  sends both names, because the remote CLI may be an older release.
