# DevRyan 2.0.3 release evidence

The candidate includes the 29 local commits after `e5a9b16d`: QA/test/benchmark
payload cleanup, cache reporting and retention, and removal of the duplicate
native runtime from Electron packaging. Release metadata and the workspace
lockfile are synchronized to 2.0.3. The Windows preview contract test now checks
that preview packaging preserves the current stable version rather than
hard-coding 2.0.2.
The cache scanner also tolerates entries removed during enumeration; other
filesystem errors still fail. This was found while the prune preview overlapped
disposable test cleanup. All 26 storage regression tests passed, including
disappearance and permission-failure cases.

## Local checks

- Production web/Electron build: passed.
- Startup bundle budgets: passed; web startup gzip 1,440,395 bytes against a
  1,456,388-byte limit.
- Full validation coverage: passed. The first attempt failed the hard-coded
  preview version test. The retry passed lint, type checks, docs validation and
  every deterministic package before web; the user interruption stopped the
  command during web tests. Resuming `bun run --cwd packages/web test` passed
  all 6,518 tests in 534 Vitest files and all 14 native-host tests. The UI suite
  passed 4,062 tests in 589 files. The final storage correction was separately
  checked with all 26 storage tests, and final docs validation passed. The
  interrupted full command itself is not reported as a successful exit.
- [Runtime parity](runtime-parity.json): all 13 checks passed, with no console
  errors. The run manifest reports `passed`; its Chromium profile was removed.
- [Isolated web chat](qa-web.json): failed before any UI check with
  `native_runtime_configuration_unsupported`; the runner supplies retired
  external-runtime flags. No diagnostic journal was created before bootstrap
  rejection.
- [Isolated Electron chat](qa-electron.json): failed before any chat check with
  `Timed out waiting for CDP Runtime.evaluate`. Both QA attempts report no
  cleanup errors. These failures are not platform or chat acceptance.

The QA results identify pre-release commit `2553fd8b` with a dirty working tree
containing the release preparation. They do not identify a published installer.
No live-provider journey, physical-device check, installed-app update, Windows
qualification or notarization was performed for this release. macOS retains its
existing ad-hoc signing class.

## Publication

Release preparation commit `61b88a653df3ab506ce48644e163c8e5d97332af` and all 29
pending commits were pushed to `main`. The [hosted migration workflow](https://github.com/1H-Team/DevRyan/actions/runs/37773555540)
passed from that commit: both dry-run and deployment reported the remote
database up to date, migration history matched, and the Bot schema marker was
`20260908182901`. No pending migration needed application. The [native input
verification](https://github.com/1H-Team/DevRyan/actions/runs/37773552679) also passed.

[DevRyan v2.0.3](https://github.com/1H-Team/DevRyan/releases/tag/v2.0.3) was
published at `2026-10-08T12:26:52Z` from immutable tag `v2.0.3` on
`ec3a04a9e9e23fd3fe8964f9fb8786a4d847b15f`. [Release CI](https://github.com/1H-Team/DevRyan/actions/runs/37775444286)
passed signed Bot image verification, topology, packaged native runtime and DMG
checks, exact asset inventory and packaging digest, and hosted migration/schema
verification. The final database deployment also reported up to date. npm
publication was skipped for the desktop scope.

The [release verification](release-verification.json) records a published,
non-prerelease release with exactly one public asset:
`DevRyan-2.0.3-arm64.dmg`, 381,223,618 bytes. Its downloaded SHA-256
`5c259614162ccc8db6af48234b6aec14485489977d32654b02c53dabd70acae9` matches both
GitHub and the [CI packaging receipt](macos-arm64-asset.json).
Compared with the 550,335,790-byte 2.0.2 DMG, this is about 31% smaller;
this is an installer-size comparison, not a runtime performance claim.

[Read-only DMG inspection](dmg-verification.json) confirms version 2.0.3,
bundle identifier `dev.openchamber.desktop`, arm64 architecture and passing
`codesign --verify --deep --strict`. The app is ad-hoc signed. The native
OpenCode 2.0.24 resource passes manifest, payload, launcher and signature
verification, with manifest SHA-256
`42a0ceb778e911dc17875d71baabb59149a526727cc92785d8d754e69a070dcb`.
No platform runtime remains inside `app.asar` or the unpacked web package;
the unpacked web server remains present. The image was not used to launch or
update the installed app. Downloaded installer and CI artifacts were removed
after copying these small receipts, and the read-only image was detached.
