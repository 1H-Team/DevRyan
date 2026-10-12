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
