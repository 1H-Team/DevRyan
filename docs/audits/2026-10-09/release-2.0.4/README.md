# DevRyan 2.0.4 release qualification

This is historical evidence for the original v2.0.4 publication, replaced at the user's request. Its source SHA, workflow runs and asset digest qualify only that earlier build. The replacement includes the storage and startup-upgrade changes.


The candidate contains the OpenCode 2.0.26 upgrade, About update check, mutation
ledger baseline compaction, startup integrity scan reuse, and native provider
recovery qualification. Earlier native package and offline Bot OAuth checks are
recorded in [the runtime qualification](../opencode-2.0.26/README.md); ledger
measurements and downgrade limits are in [the ledger audit](../ledger-retention/README.md).

## Reported QA startup errors

The development Electron QA bootstrap redirected HOME without selecting
Chromium's mock keychain. Its first encryption request opened the macOS
"Keychain Not Found" dialog for "DevRyan Key". The owned QA process was stopped;
the workstation keychain was not reset or modified. Development QA now selects
the mock keychain before importing production main, matching packaged QA. A
child-process regression executes the actual bootstrap with an Electron stub
that refuses setup or production imports before that switch.

The next launch exposed `native_runtime_configuration_unsupported`: the
standalone runner still passed retired external-runtime flags. It now reuses
the existing matrix fixture's verified private native bundle, synthetic wire
facade, readiness polling and Electron host registration. Explicit native
artifacts are required before launching an app. Reconnection reads canonical
messages through the authenticated product API and waits for their rendered
text. The existing matrix grader recognizes only the exact, bounded injected
SSE disconnect after proven reconnection and canonical recovery; other console
errors remain failures.

Both corrected runs reached native readiness and passed all seven functional
checks: startup, session/composer selection, four-session streaming, draft
preservation, sending, cancellation, and reload without duplicate messages.
Neither reproduced either reported startup error. The [Electron report](qa-electron.json)
and [web report](qa-web.json) remain **failed overall**: the first local Electron
renderer recorded warmup 503s, and the first web document queried an unowned
default directory before workspace selection and recorded 403s. These were not
suppressed. Both diagnostic status checks had zero gaps and no last error;
independent archived-journal gap verification also found no gaps. Cleanup had
no errors. The [Electron capture](electron-chat.png) shows the corrected chat
journey; its interrupted-turn notice is the explicit cancellation fixture.

The reports name the pre-release HEAD with a dirty working tree. They do not
establish published installer or installed-app acceptance. Live providers,
personal keychain integration, installed-app updates, Windows, notarization and
the optional skill-data lane were not checked for this release. macOS retains
its ad-hoc signing class.

## Local release gates

Production web/Electron build, bundle budgets, native artifact verification,
docs validation, and 24 targeted QA regression tests passed. Fresh
`DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full` completed with exit 0:
workspace lint/types, script and package suites, 4,065 UI tests in 589 files,
6,534 web tests in 535 files, and 14 native-host tests. QA follow-up changes made
during that run were separately checked with the final targeted regression suite
and both recorded functional journeys. [Local gate receipts](local-checks.json)
record the validation log digests and bundle measurements.

## Release preparation

Commit `ae6c3e339d7d184ecdfac6acb071ee7d59e1a482` was pushed to `main` and frozen
as tag `v2.0.4`. [Hosted migration verification](migration-verification.json)
passed on that source: dry-run and deployment both reported the remote database
up to date, with schema marker `20260908182901`; no migration needed application.
[GitHub native input verification](native-input-verification.json) passed on
the same source.

## Publication

[DevRyan v2.0.4](https://github.com/1H-Team/DevRyan/releases/tag/v2.0.4) was
published at `2026-10-09T09:49:23Z` from that immutable source and tag.
[Release CI](https://github.com/1H-Team/DevRyan/actions/runs/37912067950)
passed all required gates: eight signed image results and anonymous-access
verification, isolated Bot topology, web/native preparation, packaged native
runtime/signature/configuration checks, exact release assets and hosted
migration/schema verification. npm and announcements were skipped for the
desktop scope and the tag-triggered run.

[Independent release verification](release-verification.json) confirms a
published, non-prerelease release with exactly one public asset:
`DevRyan-2.0.4-arm64.dmg`, 380,728,876 bytes. GitHub's SHA-256
`acbfaf3d5e8d1d25ba70f031b3ecb6cc7ef1a4cb2a346fa28357da4ced57b30a`
matches the [CI packaging receipt](macos-arm64-asset.json), whose source and
version match the tag. The remote annotated tag's peeled commit was independently
checked against the release source. The receipt was copied into this audit and
the downloaded CI artifact removed. No installed application was launched or
updated for this publication verification; signing/package acceptance is the
recorded CI evidence, and no independent local DMG mount is claimed.

The nine completed QA attempts created for this release were removed after
copying the final sanitized proof above. Cache reporting and prune preview
completed; the preview was not applied to other retained artifacts. No worktree
was created.
