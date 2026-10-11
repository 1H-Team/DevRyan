# DevRyan v2.0.7 release qualification

The candidate includes the [built-in ChatGPT sign-in migration](../builtin-chatgpt-signin/README.md)
and synchronized v2.0.7 metadata. Its release notes describe the final native
flow and the outstanding live acceptance checks. Stored SIWC and legacy Codex
logins need a new sign-in; images and Bots require an OpenAI API key.

The distribution scope is `desktop-macos-arm64`: exactly one public asset,
`DevRyan-2.0.7-arm64.dmg`. Production publication requires signed Bot images,
anonymous access, isolated topology, native preparation, packaged runtime
verification, hosted migrations and the exact asset allowlist and packaging digest.

## Local verification

Production web/Electron build and bundle budgets passed. A fresh native build
and [isolated startup](native-startup.json) passed without real provider requests.
[Web QA](qa-web.json) and [Electron QA](qa-electron.json) passed all seven chat
checks with no unexpected renderer errors, journal gaps or cleanup failures.
The [web capture](qa-web.png) and [Electron capture](qa-electron.png) were inspected;
the interrupted turn is the deliberate cancellation check.

The first two web QA attempts completed the chat checks but failed the console
gate on refused bootstrap locations. The fixture now pins its home and last
directory to its owned workspace, and web starts on a blank page until workspace
storage is seeded before UI bootstrap. Eight fixture/runner contract tests passed.
No production admission checks or console assertions were relaxed.

`DEVRYAN_SCRIPT_TEST_CONCURRENCY=2 bun run validate:full` passed lint, type
checks, documentation, script suites and every workspace before web, including
all 4,095 UI tests. The web stage passed 6,580 tests and failed five assertions:
four new Disconnect cases expected `credentialID` instead of the existing `id`
mutation payload; the old SIWC catalog case expected account-model unavailability
instead of the new retired-login reauthorization reason. The assertions now
check the documented contracts without weakening credential identity or model
availability checks. All 26 focused configuration-operation tests passed.
The complete web package rerun passed all 6,585 Vitest tests across 539 files
and all 14 native tests. Every validation stage has a passing result, with the
QA fixture contract tests rerun after their correction. The original full
command is a failure, not an uninterrupted green validation run.

## Hosted database

No migration source changed. The [migration receipt](migration-verification.json)
records a successful hosted dry run and deployment on the initial release
commit. Both reported the database up to date; local/remote histories match and
the schema marker is `20260908182901`. No migration needed applying. The final
release gate verifies migrations again on the tagged source.

## Publication

[Release workflow 38118530943](https://github.com/1H-Team/DevRyan/actions/runs/38118530943)
passed all 16 required jobs on `57b1ed1df5d8d2009d14294d0291508160efc2f2`.
Signed images, anonymous access, topology, packaged runtime, exact assets and
hosted migration gates passed. npm publication was skipped for the desktop scope.

[Independent verification](release-verification.json) confirms v2.0.7 is latest,
non-draft and non-prerelease, and the tag resolves to that source. The sole asset
is `DevRyan-2.0.7-arm64.dmg`, 380,619,912 bytes, whose GitHub SHA-256 matches the
packaging output. Final migration dry run and push again reported the database
up to date; migration history and schema-marker verification passed.

No local release DMG download, mount or installed-app update was performed.
This publication receipt is committed after release without moving the tag.

## Limits

The replacement built-in ChatGPT flow has no real consent, provider request,
live tool round trip, disconnect/re-login or role-fallback acceptance. The native
fixtures prove its tool shapes and credential behavior only. macOS remains
ad-hoc signed and unnotarized. Local QA uses development binaries; production
packaging and publication are separate release workflow gates.
