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

Publication is pending. The tag-triggered `desktop-macos-arm64` workflow must
verify signed Bot images, topology, the packaged native runtime and DMG, exact
public asset inventory and packaging digest, and hosted Supabase migrations and
schema marker before publishing.
