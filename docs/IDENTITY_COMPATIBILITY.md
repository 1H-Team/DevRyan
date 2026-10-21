# Identity compatibility

DevRyan names are canonical. New installations, records and registrations use
DevRyan names; old OpenChamber names remain migration inputs and accepted aliases.
The 2026-10-20 Stage 6 follow-up explicitly authorizes identity changes previously
frozen by AGENTS.md. A legacy literal in a reader, migration, golden fixture or
provenance record is intentional and must not be removed by a bulk replacement.

## Runtime and public interfaces

| Canonical | Accepted legacy input | Compatibility owner |
| --- | --- | --- |
| `DEVRYAN_*` | `OPENCHAMBER_*` | Shared-runtime environment helpers adopt unset aliases. Launchers targeting an older child may set both; the canonical value wins. |
| `@devryan/*` workspace packages | Old installed package/profile paths | Package manifests and lockfile use DevRyan. CLI package-manager detection recognizes both installed scopes and executable names. |
| `devryan` CLI | `openchamber` | Both bins remain shipped; new help, replay commands, update targets and installer text use DevRyan. |
| `/api/devryan/*` | `/api/openchamber/*` | First middleware rewrites aliases before admission, auth, multi-user and tunnel policy. |
| `devryan:*` synthetic events | `openchamber:*` journal/wire records | New emitters use DevRyan. Shared-runtime canonicalizes old reader inputs. `event-dialect.js` rewrites only the leading serialized type: current UI requests `events=devryan`; no-query cached clients retain the legacy wire spelling. Properties and event ordering are unchanged. |
| `x-devryan-message-id`, `X-DevRyan-Warning`, `x-devryan-ui-session` | `x-openchamber-*` | Readers/preview stripping accept both; compatibility warning headers may be returned under both names. |
| `__DEVRYAN_*__`, `__devryan*`, `devryan:*` desktop events | Old globals and desktop event spellings | Main/preload expose compatibility aliases for older remote UIs. |
| `devryan://` | `openchamber://` | Both registered/accepted. Retry, diagnostics and incoming links accept old installed links. |
| `devryanVersion` in health/system information | `openchamberVersion` | New clients prefer canonical, old response field remains available. |
| `devryan-browser` CDP context | `openchamber-browser` | New browser-control context uses canonical identity; legacy ID is accepted by matching readers. |
| `devryan_write_pty` | `openchamber_write_pty` | Embedded Ghostty callback trampoline imports DevRyan; the host provides both function names for legacy artifacts. The vendored terminal Wasm is unchanged. |
| `devryan/<name>` worktree branches | Existing branches of either prefix | New branch defaults are canonical. Existing/explicit branches retain their names. |

## Saved settings and managed configuration

- Browser local/session-storage keys migrate once to the DevRyan prefix before
  stores hydrate. Canonical values win; old keys remain for stale tabs/downgrades.
- Saved SSH records write `remoteDevryan` and `auth.devryanPassword`; readers also
  accept `remoteOpenchamber`, `remote_openchamber` and `auth.openchamberPassword`.
  Secret values are not logged or included in migration diagnostics.
- New plan prompts write `devryanPlanMode`; transcript, notification, admission
  and UI readers also accept `openchamberPlanMode`.
- Synthetic plan-action text writes `[devryan-plan-action:v1]`. Readers accept
  the old prefix with the same payload validation and reject duplicate markers,
  including a mixed canonical/legacy pair.
- OpenCode's synthetic DevRyan config key is `devryan`, with managed sidecars
  under `.devryan/`. The old top-level key and `.openchamber/` tree are migration
  inputs. Legacy files remain intact, existing canonical files win, config writes
  are atomic, and invalid/conflicting entries fail visibly. Neither synthetic key
  is written into OpenCode's own schema-validated config file.
- The default data folder is `~/.config/devryan`. Startup migration moves the old
  `~/.config/openchamber` folder and leaves a relative link. Existing collisions
  are preserved in a legacy conflict directory. A failed cross-volume/bind-mount
  move keeps the old root in use and surfaces a notice; it never deletes data to
  force canonical spelling. Explicit custom data roots remain explicit.
- New CLI daemons write `run/devryan-<port>.{pid,json}` and
  `logs/devryan-<port>.log`. Discovery accepts both prefixes and validates process
  identity before treating a record as owned. A running legacy daemon keeps its
  original records until it stops; log readers fall back to its old filename.
- Newly created passkey display names and push VAPID subjects use `devryan-ui`
  and `mailto:devryan@localhost`. Existing passkey IDs/credentials and saved VAPID
  key records remain unchanged.

## Desktop identity and existing installations

New Electron and Tauri source manifests use `@devryan/electron`,
`@devryan/desktop` and the canonical bundle ID `dev.devryan.desktop`.
The legacy Electron ID `dev.openchamber.desktop` remains an accepted installed
source identity for update and recovery. Updater discovery still uses the
canonical repository's `/releases/latest` and the public release remains exactly
one `DevRyan-<version>-arm64.dmg`.

Electron selects an existing `@openchamber/electron` Chromium profile before
acquiring the single-instance lock or initializing its main runtime. New profiles
use `@devryan/electron`. This preserves the old cookies, localStorage and IndexedDB
in place. Browser partitions likewise use canonical
names for new profiles and retain existing legacy partitions when present.
Changing a spelling never discards a browser session to produce an empty profile.

The background runtime service is retired and nothing registers it any more.
Both plists (`dev.devryan.desktop.runtime-service` and the legacy
`dev.openchamber.desktop.runtime-service`) and the native control still ship:
installed 2.x updaters require them in a candidate bundle, and the first launch
of this version uses the native control's canonical and legacy lookups to
unregister any remaining registration once (`runtime-service/retired.v1`). Unit tests inject
native control, keychain, updater and app operations; they do not register an OS
service or modify an installed app.

The Tauri source branding/settings fallback is updated, but the old installed
Tauri updater transition is **unqualified**: this repository's one-DMG public
release does not include a signed Tauri update manifest/archive. Source changes
alone cannot prove that deployment transition. New desktop features still belong
in `packages/electron`; the Tauri package remains legacy compatibility code.

## Immutable legacy inputs

These records are accepted or retained rather than rewritten in place:

- Selected runtime bundle descriptors, prepared manifests and their hashes,
  including an existing `config/openchamber` directory. New readers must validate
  legacy paths with the same containment and integrity rules as canonical paths.
- The pre-rename orchestration event golden fixture. Both legacy and canonical
  wire payload bytes are pinned; ledger and cursor formats are unchanged.
- Existing browser databases are selected in place when found; new databases
  use DevRyan names. When database enumeration is unavailable, the reader falls
  back to the old name to avoid losing attachments or cursor state. Theme IDs
  normalize to DevRyan through the versioned catalog while retaining old aliases.
  The managed Claude Code status-line path embedded in user settings remains
  an accepted command identity.
- The legacy Tauri sidecar argv/stdout markers used to identify a released
  process, provenance URLs, upstream credits and detection of legacy-branded
  release assets. Historical changelog text describes the release that shipped.
- Docker's `/home/openchamber` compatibility link and the existing
  `./data/openchamber` host bind source. The container user/home and mount targets
  are DevRyan; the UID stays 1000 with an old username alias, and an old mount target resolves into the same
  home. Keeping the host source prevents a Compose upgrade from silently creating
  an empty data volume.

Readers accept aliases indefinitely. Removing an alias requires its own migration
and release note. A documented fallback is compatibility coverage, not a claim
that a native upgrade or a live account was exercised in this task.
