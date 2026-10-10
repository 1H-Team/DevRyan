# DevRyan 2.0.5 release qualification

This is historical evidence for the superseded publication. The user authorized
replacing its release, tag and release commits with the current changes; current
qualification and publication are recorded in [the replacement release audit](../rerelease-2.0.5/README.md).

The candidate contains startup health and retry handling, stale service-owner
recovery, sanitized native catalog diagnostics, retained-bundle version handling,
and the documentation/storage cleanup. The distribution scope is macOS Apple
silicon desktop. The [startup investigation](../../2026-10-09/startup-reliability/README.md)
records the earlier isolated launch and upgrade checks. The original installed
model-catalog HTTP 500 remains unresolved; this release does not claim its repair.

## Local verification

[Local gate receipts](local-checks.json) record production web/Electron build,
bundle budgets, native runtime build and artifact
verification, workspace lint/types, documentation validation, script tests and
the deterministic packages preceding Electron passed. The first
`DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full` stopped at one stale
Electron source-evaluation fixture: it did not provide the new `runStartupPhase`
helper. The fixture now uses the actual helper without changing its assertions.
The complete Electron rerun passed, including ten splash tests; the legacy
Tauri suite passed all 39 tests, and UI passed 4,077 main-batch tests plus its
isolated batches. Web passed 6,554 Vitest tests in 535 files and 14 native-host
tests. This is a segmented full gate,
not a claim that the original invocation exited zero.

Fresh packaged QA SQLite and PTY ABI smoke checks passed. Three
[packaged app-bound launches](packaged-startup.json) reached usable chat with
native health, the exact fixture model/agent and the renderer's actual global
event-stream readiness acknowledgment. The harness forced no navigation or
reload; application document transitions are retained. The
[final capture](packaged-startup.png) was visually inspected. These local-fixture
results establish readiness, not a performance improvement or live-account parity.

Three [direct packaged service launches](packaged-service.json) passed owner
identity, unauthenticated handshake/bootstrap refusal and physical shutdown
checks. Each made zero model-provider requests. This narrower check does not
qualify native-model readiness or foreground service attachment. All six
launches cleaned their owned process trees without errors. The Bun runner
emitted its known `tsconfig.json` directory-mismatch diagnostic at exit; both
commands exited zero and completed their assertions and cleanup.

The [web QA report](qa-web.json) passed all seven functional checks, but remains
failed overall for initial unowned-directory 403 console errors. The
[development Electron report](qa-electron.json) reached native readiness but
timed out waiting for the synthetic session after wire-facade navigation; the
inspected capture showed the loading mark. Both archived journals passed the
independent gap verification with no gaps, and both cleaned their owned process
trees without errors. These failures were retained, not suppressed.

## Hosted database

[Migration workflow 37985419289](https://github.com/1H-Team/DevRyan/actions/runs/37985419289)
passed on `5dcdd16511a7a601035aee8fd1f78f4136f720ca`; its
[receipt](migration-verification.json) records dry-run and deployment, which both
reported the remote database up to date. The queried Bot schema marker was
`20260908182901`. No migration needed applying, and no migration source changed
since v2.0.4. The publication workflow also passed its migration-history and
schema verification on the final tagged source, with dry-run and deployment
both reporting the database up to date.

## Scope and limitations

Live providers, installed-app updates, OS service registration and personal
keychain integration were not checked. macOS retains its ad-hoc signing class;
no notarization or Windows qualification is claimed. GitHub reported existing
default-branch dependency advisories at push time: two critical, 25 high,
13 moderate and two low. This task did not investigate or remediate them.

## Publication

[DevRyan v2.0.5](https://github.com/1H-Team/DevRyan/releases/tag/v2.0.5) was
published on October 10, 2026 at 00:48:50 Asia/Dubai
(`2026-10-09T20:48:50Z`) from immutable tag `v2.0.5`, commit
`cee8be795d0d0f1767859a9a164cfa9f844cec64`.
[Release CI](https://github.com/1H-Team/DevRyan/actions/runs/37987428254) passed
all 16 required jobs, including signed images, anonymous access, isolated Bot
topology, native preparation, packaged-runtime verification, exact assets,
hosted migrations and publication. npm and announcements were skipped for
this desktop tag-triggered release.

[Independent verification](release-verification.json) confirms the published,
non-prerelease release is latest and has exactly one public asset:
`DevRyan-2.0.5-arm64.dmg`, 380,619,246 bytes. Its GitHub SHA-256
`c755e79bd57c8e338aff079208ca1f39a4bb78933226e0ffb55454723421f2c3`
matches the [CI packaging receipt](macos-arm64-asset.json), whose source,
version, platform and size match the tag and public asset. The remote annotated
tag's peeled source was independently checked. No independent local release
DMG download, mount or installed-app update is claimed; production signature
and packaging checks are the recorded CI evidence.

## Cleanup

[Cleanup receipts](cleanup.json) record removal of the task-owned superseded
QA package and the downloaded CI receipt after retaining its sanitized copy.
The newest verified QA package remains available for reproduction; failed QA
diagnostics were retained. No worktree was created. Cache reporting and prune
preview passed: retained cache usage was 28.79 GiB with about 216 GiB free.
The preview was not applied to other retained artifacts. Successful packaged
startup and service runs cleaned their private runtime payloads and processes.
