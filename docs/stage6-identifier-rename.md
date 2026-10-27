# Stage 6 identifier rename and compatibility follow-up

The original Stage 6 on 2026-10-20 renamed internal Web, UI, Electron and script
identifiers in `e2ea1ab1`, `014736eb`, `7f86852e` and `5c78e727`. Its inventory
went from 1,610 to 1,071 case-insensitive OpenChamber occurrences; remaining
identities were deliberately frozen at that stage.

The follow-up explicitly overrides those freezes while requiring migration
compatibility. DevRyan is now the canonical spelling for new package manifests,
bundle/service identities, synthetic events, SSH fields, plan metadata/markers,
managed config paths, CLI records/help, Docker user/home, browser contexts,
terminal callback imports, theme IDs and new browser databases. Existing records
remain readable. See [Identity compatibility](IDENTITY_COMPATIBILITY.md) for
the exact owners, precedence and fallback behavior.

The remaining OpenChamber occurrences are intentional legacy readers and
migration sources, old golden records, process recognition, provenance/credits,
or historical release text. They are not candidates for an indiscriminate
replacement. In particular:

- Existing encrypted Chromium state, browser partitions and IndexedDB databases
  are retained in place when detected. Fresh installations use canonical names.
- The old bundle ID remains an accepted update/rollback source. The new candidate
  identity is canonical, with injected tests for installer and service behavior.
- A cached old web client still receives its old event dialect. New emitters and
  current clients use DevRyan; both exact wire fixtures remain pinned.
- A sealed historical runtime bundle is never rewritten just to change its
  config directory spelling. New bundles use `config/devryan`; strict readers
  accept either exact owned path and reject other names.
- An active old CLI daemon retains its PID/JSON/log filenames until shutdown.
  New daemons write DevRyan records; discovery validates either process identity.

The [performance audit](performance/2026-10-20-audit.md) records validation and
the separate historical comparison. Signed native upgrades, macOS Keychain ACL
behavior, and the old installed Tauri updater transition remain unqualified;
mocked migration tests are not a substitute for those checks. No release or
installed-app modification is part of this follow-up.
