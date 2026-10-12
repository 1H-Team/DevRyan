# DevRyan v2.0.9 release preparation

This candidate contains the [startup repair](../../2026-10-12/startup-repair/README.md)
and matching 2.0.9 package metadata. Its release workflow preserves final-DMG
startup qualification. At the user's explicit request, independent actual-reboot
qualification and its installer-staging workflow were removed. Local development
receipts do not satisfy the remaining final-DMG release gate.

## Local verification

Workspace lint, type checks, all deterministic package suites, production build
and bundle budgets passed. The initial `validate:full` invocation failed on two
native-process fixture deadlines after the other packages passed. An unchanged
isolated rerun passed all 12 tests; the subsequent whole-web rerun still hit the
fixture's 500 ms shared startup/recovery budget. The fixture now allows 3 seconds
for startup and bounded recovery, and 15 seconds for its multi-process cases.
Its refusal, unsettled cleanup, release and owned-exit assertions are unchanged.

The final whole-web rerun passed 6,702 Vitest tests and 14 Bun tests. The final
script suite passed 1,364 Node tests and all native graph tests after removal of
the reboot gate. Changed-file lint, documentation validation and diff whitespace
checks passed. The completed initial run also passed all 4,117 UI tests and every
other test-owning workspace. These rechecks complete the failed invocation's
coverage; the original `validate:full` invocation is not reported as a pass.

## First release candidate

The [first qualification receipt](qualification-attempt-1.json) belongs to source
`abbb535526ce2d527fffced7224af55f23c37ecb` and
[workflow 38317426952](https://github.com/1H-Team/DevRyan/actions/runs/38317426952).
Packaging, signed Bot images and topology checks passed. The final-DMG gate
passed GUI prerequisites and fifty compiled cases, then failed while waiting
120 seconds for the parent-death child to reach its actual compiled-tool barrier.
No GUI startup scenario ran, and the release remained a draft.

That child log and its journal roots were not retained in the CI artifact;
their gap checks are unavailable. No conclusion about that child's internal
runtime failure is claimed. The exact failed DMG was downloaded, hash-checked,
mounted read-only and copied into a private repository fixture. Its isolated
parent-death lane passed in 66.8 seconds, including real confined supervisor
termination receipts, descendant exit, empty registry and no publication.
The [sanitized reproduction receipt](parent-death-reproduction.json) records
122 journal records, ten sealed chunks, reconciled writer evidence and a
successful `gaps --verify` command with zero gaps.

The fixture readiness allowance now includes up to five minutes of cold sealed
bundle provisioning. Actual-tool, owner-death, termination, publication and
journal assertions are unchanged, including the fifteen-second termination
deadlines. This is a fixture timing correction; it does not establish the cause
of the missing CI child evidence or qualify the entire installer locally.
The corrected source must receive a fresh complete release qualification.
The full script suite and documentation validation passed after the readiness
budget correction; no assertions or qualification cases were removed.

## Hosted migrations

The [migration receipt](migration-verification.json) records the successful
[hosted workflow](https://github.com/1H-Team/DevRyan/actions/runs/38314829074).
Dry-run and deployment both reported that the database was up to date. All 56
history entries matched and the schema marker was `20260908182901`. No migrations
were applied. This workflow used the previous main commit; the candidate has
exactly the same tracked migration files.

## Verification limits

The final-DMG gate still requires all eleven startup scenarios, screenshots,
saved history, completed fixture responses, journal checks and cleanup on a
disposable GitHub-hosted macOS ARM64 runner. The user's installed application and
running runtime are outside this verification path. Recovery preparation and
same-boot refusal are checked; recovery after an actual OS reboot remains
unverified. No performance improvement is claimed.
