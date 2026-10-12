# DevRyan v2.0.8 release verification

This is historical evidence for the original `c2cbf167` publication. The
replacement release includes the [startup contract](../startup-contract/README.md)
and must produce a new final-DMG receipt; these original receipts cannot qualify it.

This release includes the pending Claude SDK transport and reviewed CLI upgrade,
Cursor discovery and cancellation repairs, orchestration settlement, and chat UI
changes. The desktop scope permits exactly `DevRyan-2.0.8-arm64.dmg`.

Production build, startup bundle budgets, documentation validation, and the fresh
native artifact build passed. [Compiled native qualification](native-qualification.json)
passed all 52 cases with no remaining mandatory gate or cleanup failure.
[Isolated web QA](qa-web.json) passed all seven chat checks. Its screenshot was
inspected: transcript, sidebar and composer fit; the interruption banner belongs
to the deliberate cancellation case.

The [first Electron attempt](qa-electron-attempt1.json) passed all seven chat
checks but failed the unexpected-console-error gate: initial `path.get` returned
503 before native readiness. Its journal gap check passed. This attempt overlapped
native qualification and the deterministic suites. The
[idle Electron retry](qa-electron.json) passed all seven checks, with no
unexpected renderer error or cleanup failure. Its screenshot was inspected
and the chat layout was correct. The first startup failure was not reproduced
on the idle retry; no assertion was weakened or suppressed.

[Full deterministic validation](local-validation.json) passed workspace lint,
type checks, documentation, every deterministic package suite, 4,111 UI tests,
6,682 web tests and 14 final native backend checks.
[Hosted migration deployment](migration-verification.json) passed on the frozen
release source `c2cbf1670cb87b604105ee6164eb15364f4c807c`: dry run and deployment
reported up to date, all local/remote history rows matched, and the schema marker
was `20260908182901`. No pending migration needed applying.
[Release workflow 38209153037](https://github.com/1H-Team/DevRyan/actions/runs/38209153037)
passed signed Bot image, anonymous access, topology, packaged runtime,
migration history/schema, and exact asset/digest gates. Its final migration
dry run and deployment again reported up to date.

[Independent publication verification](release-verification.json) confirms
`DevRyan v2.0.8` is latest, non-draft and non-prerelease, and the remote tag
resolves to the frozen source. Its only public asset is
`DevRyan-2.0.8-arm64.dmg`, 390,563,095 bytes, with the packaging receipt's SHA-256:
`8077227eb74f5bee1aa3be1e654737446dcf0a75ac9a1e8a7b41385e09697970`.

The disposable native candidate, superseded Electron attempt, and downloaded
packaging receipt were removed after preserving small proof. Cache reporting
and cleanup preview completed; unrelated cache contents were retained. This
publication evidence is committed after release without moving its tag.

No installed-app update or new live-provider matrix is included in this release
qualification. Existing live evidence is linked from the
[final orchestration QA record](../live-agent-qa-final.md).
macOS remains ad-hoc signed and unnotarized.
