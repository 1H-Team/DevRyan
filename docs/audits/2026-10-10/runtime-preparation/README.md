# Runtime preparation stall — 2026-10-10

The installed DevRyan 2.0.6 launch at 22:29:38 Asia/Dubai upgraded its
selected bundle, then failed at 22:30:43 with `runtime_bundle_binding_invalid`.
Its `prepared.json` was 4,735,160 bytes with a matching selected digest.
Storage/native validation accepted up to 32 MiB, but early binding capped
documents at 4 MiB. The startup error renderer then re-read settings through
the failing binding, throwing again and leaving the preparation splash visible.

Authorized read-only inspection found zero journal gaps, but the selected
journal's latest records preceded this launch. The Electron startup log supplies
the failure evidence. An in-memory experiment changing only the binding limit
accepted the existing revision 6; it did not launch or modify the installed app.

Binding now uses `BUNDLE_DOCUMENT_MAX_BYTES` and checks both metadata and actual
bytes. The error renderer uses default appearance when settings lookup throws,
while retaining the original error and Retry. No selector, schema, credential,
conversation or migration change is required.

## Verification

The [verification summary](verification.json) records command outcomes and reruns.

- The 69-test runtime-bundle suite and 11-test Electron splash suite passed.
  Coverage includes a sealed document above 4 MiB, size rejection above 32 MiB,
  changed hashes, symlinks, and error navigation when post-upgrade settings fail.
- Build and startup bundle budgets passed. Packaged SQLite and PTY checks passed;
  [package identity](package-identity.json) pins the exact verified archive.
- [Packaged regression evidence](evidence.json) passed with private credential-free
  profiles and local model transport. A 5,246,352-byte sealed manifest reached
  usable chat with the exact fixture model, composer and global event-stream
  readiness. Selection revision remained unchanged. A bad pinned hash displayed
  the error and Retry. Both screenshots were visually inspected:
  [usable chat](large-manifest.png), [failure screen](invalid-manifest.png).
- The packaged invalid-hash check covers initial binding failure; the Electron
  regression separately exercises settings becoming unreadable after initial
  binding. The packaged run used owned foreground activation and does not claim
  natural launch latency or live-provider acceptance.

The first full-validation attempt stopped at an unrelated Windows compatibility
fixture's `spawnSync bun ETIMEDOUT`; all three tests in that file passed on an
unchanged isolated rerun. Full validation was restarted with script concurrency
2. That run passed lint, type checks, documentation, scripts/native graphs and
all packages through UI (4,091 tests). Web Vitest passed 6,626 tests and failed
one unchanged `native-process.test.js` bounded-recovery case with
`native_process_exit_unconfirmed`. All 12 tests in that file passed on an
unchanged isolated rerun, and the separate web native test batch passed.
The full command did not exit zero; all required suites were completed with
these focused reruns. No assertions or time limits were weakened.

An initial QA package was rejected because documentation changed while packaging;
the frozen retry passed. The first custom smoke attempt checked a display label
too early and used the legacy fixture label rather than the native model ID.
The final runner reuses the existing exact-model usable-chat verifier. These
preliminary attempts are not passing evidence and their payloads were removed.

No installed app replacement, restart, release, signing or live-provider check
was performed. Passing QA profiles and owned processes were cleaned up; the
verified QA package remains available for reproduction.

Before the replacement v2.0.6 release, a fresh full-validation invocation with
`DEVRYAN_SCRIPT_TEST_CONCURRENCY=2` exited zero without focused reruns. All 4,091
UI tests, 6,627 web Vitest tests and 14 native web tests passed. A fresh production
build, bundle budgets, documentation validation and `git diff --check` also
passed. The two production-file hashes in `package-identity.json` still matched
the packaged regression evidence. No migration source changed; hosted migration
deployment and release packaging are verified separately by GitHub Actions.

`cache:report` and preview-only `cache:prune` completed after packaged QA. The
report measured 34.28 GiB against the 50 GiB budget; the preview was not applied
to unrelated artifacts. No worktree was created. Final documentation validation
and `git diff --check` passed.
