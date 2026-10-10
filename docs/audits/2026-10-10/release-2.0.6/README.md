# DevRyan v2.0.6 release qualification

The candidate includes the pending [provider repairs](../provider-repairs/README.md)
and [startup diagnostics](../startup-imports/README.md), with synchronized
v2.0.6 package metadata. Startup import trial patches remain unapplied.

The distribution scope is `desktop-macos-arm64`: exactly one public asset,
`DevRyan-2.0.6-arm64.dmg`. The production release workflow requires signed Bot
images, anonymous access, isolated topology, native preparation, packaged runtime
verification, and the exact public asset allowlist and packaging digest.

No migration source changed in this candidate. Hosted migration
[workflow 38065409720](https://github.com/1H-Team/DevRyan/actions/runs/38065409720)
passed on `4f3da907b66e55927f9fa3bbcb2dd51a033a8126`.
The [migration receipt](migration-verification.json) records both dry run and
deployment reporting the remote database up to date, matching migration history
and Bot schema marker `20260908182901`. No migration needed applying. The final
release gate also verifies migrations on the tagged source before publication.

## Local acceptance

The fresh [native build](native-build.json), production web/Electron build,
Electron web staging and bundle budgets passed. The lockfile changed only its
workspace versions; no dependency version changed.

Isolated [web QA](qa-web.json) and [Electron QA](qa-electron.json) each passed all
ten checks without unexpected console errors or cleanup failures. All eight
captures were inspected: weekly usage, source/account labels and reset inventory
states remain readable at 1280×800. Representative captures show
[web available](web-provider-usage-available.png),
[Electron available](electron-provider-usage-available.png),
[unknown](electron-provider-usage-unknown.png) and
[zero](electron-provider-usage-zero.png). These checks use synthetic local quota
data, not a personal Codex profile or live provider.

The [first](packaged-startup-first-attempt.json) and
[second](packaged-startup-second-attempt.json) natural packaged startup probes
timed out because the renderer was hidden. Both reached native readiness,
composer/model availability and the event-stream acknowledgment, with no
renderer exceptions, journal gaps or remaining owned processes. The runner
removed their private runtime journals during cleanup; the bounded receipts and
sanitized startup logs were inspected before drawing this conclusion.

Three [foreground-controlled packaged launches](packaged-startup.json) passed
the unchanged usable-chat predicate, expected model/agent and event-stream
readiness. All journal gap scans and process cleanup checks passed. All three
captures were inspected; the [final view](packaged-startup.png) shows a usable
composer and the expected fixture model. This qualifies controlled startup,
not natural startup timing or an optimization claim.

Three [direct packaged service launches](packaged-service.json) passed owner
identity, unauthenticated handshake/bootstrap refusal and physical shutdown,
with zero model-provider requests and no cleanup failures. This does not qualify
native-model readiness, service registration or authenticated desktop leases.

## Deterministic qualification

`DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full` passed workspace
lint, types, documentation and every test package before web, including 4,091
UI main-batch tests. Web passed 6,625 tests across 540 passing files but failed
one bounded credential-settlement test with `native_process_exit_unconfirmed`.
The [initial failure report](initial-web-failure.txt) is retained. The unchanged
native-process file passed all 12 tests in isolation. The complete unchanged
web-package rerun passed all **6,626 Vitest tests across 541 files**, followed
by **14 native Bun tests**. [Local receipts](local-checks.json) record this
segmented qualification; the original full invocation exited one. No assertion
or failure gate was changed.

Earlier audits establish their tested snapshots only. Live Codex enrollment,
authenticated provider turns through the UI, installed-app replacement,
notarization and Windows acceptance remain unqualified.

GitHub reported 42 existing default-branch dependency advisories at push time
(two critical, 25 high, 13 moderate and two low). This release task did not
investigate or remediate them.

## Publication

[DevRyan v2.0.6](https://github.com/1H-Team/DevRyan/releases/tag/v2.0.6) was
published on October 10, 2026 at 20:16:55 Asia/Dubai
(`2026-10-10T16:16:55Z`) from immutable annotated tag `v2.0.6`, source
`4f3da907b66e55927f9fa3bbcb2dd51a033a8126` (`release v2.0.6`).
[Release CI](https://github.com/1H-Team/DevRyan/actions/runs/38065814246) passed
all 16 required jobs, including signed images, anonymous access, isolated
topology, native preparation, packaged runtime, exact assets, hosted migrations
and publication. npm and announcements were not published for this desktop scope.

[Independent verification](release-verification.json) confirms the release is
latest, non-draft and non-prerelease, with exactly one public asset:
`DevRyan-2.0.6-arm64.dmg`, 380,613,714 bytes. Its GitHub SHA-256,
`02af395ccba4bae982a63f1023ab4025f553682005c6f6d451759415f6c796d2`, matches
the [CI packaging receipt](macos-arm64-asset.json), whose source, version,
platform and size also match. The remote annotated tag's peeled source was
independently checked. The final migration dry run and push both reported the
database up to date; migration-history and schema-marker verification passed.

No independent local release DMG download, mount or installed-app update was
performed. Production packaging/signature checks are CI evidence; macOS remains
ad-hoc signed without notarization. This audit update is a documentation-only
commit after publication and does not move the release tag.

## Cleanup

[Cleanup receipts](cleanup.json) record removal of task-owned superseded QA
packages and startup retry directories, and the downloaded CI receipt after its
sanitized copy was preserved. Current QA/native inputs remain for reproduction.
Successful fixture runs cleaned their runtime payloads and all owned processes.
No worktree was created. Cache report and prune preview passed; no bulk prune
was applied to unrelated artifacts. The report before CI metadata retrieval
recorded 33.11 GiB of cache usage and about 178 GiB free.
