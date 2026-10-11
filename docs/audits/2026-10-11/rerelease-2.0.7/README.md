# Replacement DevRyan v2.0.7

This replacement combines the original v2.0.7 source and the pending native
Codex chat/usage, dedicated Claude enrollment and session archive changes.
The public release name is `DevRyanv2.0.7`; its desktop scope permits exactly
`DevRyan-2.0.7-arm64.dmg`.

Production build, bundle budgets and the fresh native candidate build passed.
[Web QA](qa-web.json) and [Electron QA](qa-electron.json) passed all seven
chat checks, with no unexpected renderer errors, journal gaps or cleanup
failures. Both captures were inspected: sidebar, transcript and composer fit,
and the interruption banner is the deliberate cancellation case.

[Compiled native qualification](native-qualification.json) passed all implemented
mandatory cases with no pending gate. Full validation passed workspace lint, type checks, documentation checks,
all deterministic workspace suites, 4,095 UI tests, 6,577 web tests and 14
final native backend tests. Publication verification passed; receipts are linked below. The release workflow must verify signed Bot images, anonymous access,
isolated topology, packaged runtime, hosted migrations and the exact asset
allowlist and packaging digest before publication.

No installed-app update or new live-provider acceptance was performed.
macOS remains ad-hoc signed and unnotarized.

## Hosted database and publication

[Hosted migration verification](migration-verification.json) passed on
`8f497f187476ad47299332524f688d00893f17f4` before tag recreation. Both dry run
and deployment reported up to date; no migration needed applying. Local and
remote histories match and the schema marker is `20260908182901`.

[Release workflow 38126717474](https://github.com/1H-Team/DevRyan/actions/runs/38126717474)
passed every required gate on that same source. Final migration checks also
reported up to date. npm publication was skipped for the desktop scope.

[Independent publication verification](release-verification.json) confirms
`DevRyanv2.0.7` is latest, non-draft and non-prerelease, with the tag resolving
to the replacement source. Its only asset is `DevRyan-2.0.7-arm64.dmg`,
380,617,455 bytes, whose SHA-256 matches the packaging receipt:
`15f07a502baf1e79cc20b2a35738342349e0ebd08546dd3827c4419e8d24788e`.

The old GitHub Release and tag were deleted; the three prior v2.0.7 commits
were replaced in main history with one `release v2.0.7` commit. A local backup
branch retains the former history for recovery. This publication evidence is
committed after release without moving its tag. No local release DMG download,
mount or installed-app update was performed. Disposable candidate artifacts
were removed; cache reporting and cleanup preview completed.
