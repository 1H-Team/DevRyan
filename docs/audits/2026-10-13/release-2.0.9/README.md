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

## Second release candidate

The [second qualification receipt](qualification-attempt-2.json) belongs to source
`cc940fadcf75419d2c8a49cb46f79cba2281e0f7` and
[workflow 38320691230](https://github.com/1H-Team/DevRyan/actions/runs/38320691230).
All 52 compiled cases passed, including real parent-death drain and the three
durable journal roots. Cleanup and source-cohort checks passed. The first GUI
scenario then timed out waiting for its empty-profile setup predicate after
native health became ready. No renderer snapshot or profile journal was retained
for that failure, so its exact renderer state and gap check are unavailable.

Inspection found a predicate mismatch: the current empty UI renders "Start new
chat" and the model control "Not selected", while the qualifier required body
text matching `connect|provider|model|welcome`. The predicate now requires the
ready document to be visible, the startup-ready flag, and visible enabled
composer, New Chat and model-picker controls. A regression checks no-account
copy, loading, hidden documents, disabled controls and hidden ancestors.
Readiness and native health requirements remain enforced. Failed launches now
capture interface fields and an artifact-bound screenshot before stopping, then
check the actual profile journal after owned shutdown. These diagnostics cannot
replace or suppress the original launch failure. A fresh complete qualification
is required; the exact cause of the unretained second-candidate renderer state
is not claimed.
The focused setup/receipt regressions, full script suite (1,365 Node tests and
native graph tests), documentation validation and whitespace checks passed after
this correction.

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

## Third candidate and diagnostic follow-up

[Workflow 38323996942](https://github.com/1H-Team/DevRyan/actions/runs/38323996942)
failed at the initial v2.0.7 baseline launch in upgrade-second-previous. The
[receipt summary](qualification-attempt-3.json) records all 52 compiled checks,
empty-profile, unchanged-reopen and upgrade-previous passing. The failure was
`native_process_boot_timeout`; its journal gap check and owned cleanup passed.
The [retained screenshot](DevRyan-startup-upgrade-second-previous-launch-failure.png)
shows the bundled runtime unavailable. No raw profile journal or host log was
retained for this attempt, so the underlying boot cause remains undetermined.

The release remains a draft at source `ff8620109c73e4642db90762b440da1365792e52`.
The diagnostic scratch branch adds a manual dry-run-only continue mode, blocked
dependent scenarios, and bounded sanitized host logs. It changes no Bot image
signature checks or input recipes, and every diagnostic receipt remains
ineligible for publication. Ordinary final-DMG qualification remains fail-fast.

## Startup reliability changes

The follow-up publishes POSIX mutation locks from a synced private file with an
exclusive hard link. Unsupported hard links alone permit the existing exclusive
write fallback. Legacy malformed locks retain their thirty-second threshold.
Foreground ownership waits within a forty-five-second budget, retrying only
ownership contention and awaiting each acquisition to completion.

Fresh and app-bound installations no longer register a background service.
Explicit service configurations retain their upgrade paths. Stray registrations
are removed and their owners must stop before foreground ownership is acquired;
recovery preserves an explicitly configured service preference.

The [recomputed image inventories](startup-image-inventories.json) show unchanged
input digests for all eight Bot images. None includes the modified atomic-file
module. Image signing, the build recipe and ordinary publication guards remain
unchanged.

The harness-only control is
[workflow 38358849025](https://github.com/1H-Team/DevRyan/actions/runs/38358849025),
at source `8ad231460347a33f984044f7f4fb3cbfe8653936`. It packages the unchanged
product with bounded navigation reads, service handoff handling, ownership
evidence and the restricted baseline relaunch allowance. Its receipt must be
inspected before drawing conclusions about the ownership-busy mechanism.

The [control evidence](harness-control.json) passed all 52 compiled cases, then
hit navigation-budget failures and stopped on malformed-lock cleanup evidence.
After the v2.0.8 same-runtime baseline stopped, its mutation lock was zero bytes,
with mtime `2026-10-13T07:18:24.088Z`. The app exited with code zero after 10.361
seconds following SIGINT; no owned processes survived. This demonstrates the
malformed-lock shutdown path in a published baseline, but does not prove that
the earlier unobserved ownership-busy failure had the same cause. No live
unrelated mutation-lock holder was observed. Tampered-app and service cases
were not reached.

The navigation observer now seeds its document identity from `Page.getFrameTree`
instead of counting a target-list URL with no loader identity. Baseline timeout
classification retains authoritative failed health evidence, since older
startup phase logs omit the terminal code. Navigation limits, candidate launch
attempts and cleanup refusal remain unchanged.

Full validation passed lint, type checks, documentation and every package except
three web fixture assertions that intercepted the previous lock publication
method. After correcting that fault injection, all 75 runtime-bundle tests and
the complete web suite (6,702 Vitest plus 14 Bun tests) passed. These rechecks
complete the failed invocation's coverage; the original invocation is not a
pass. Production build and bundle budgets passed. Focused ownership, atomic-lock,
service cleanup, navigation and baseline-policy checks passed.

The [first stability round](stability-round-1.json) has zero qualifying samples.
Runs 38362443401 and 38362443361 passed 52 compiled cases, but ordinary launch
navigation exceeded the budget. Candidate startup redundantly navigated the
adopted early splash window; this is now removed and regression-tested. The
published v2.0.8 baseline also committed one splash and three application
loader identities. Source contains separate authentication and native-readiness
reloads. With explicit user approval, the observer now allows one additional
authentication reload only after directly observing local-admin principal
initialization on the current application origin; source inference alone does
not qualify the transition.

Both runs exhausted the one allowed v2.0.7 baseline relaunch with
`native_process_boot_timeout`; the published native-controller boot deadline
expired after approximately 31–32 seconds. Both attempts remain failed evidence.
Sample 2 also left a zero-byte mutation lock after stopping v2.0.8 and halted on
cleanup failure. Sample 1 completed cleanup and continued independent cases,
but their prerequisite launches failed the navigation budget; tampered-app
integrity rejection and service handoff are therefore still unproven.
Run 38362444154 failed GUI prerequisites before qualification; its old receipt
omitted probe detail. New receipts retain the prerequisite probe result.
No candidate malformed mutation lock or live unrelated lock holder was observed.
The three-sample count must restart after corrections; no tag is authorized.

After the splash correction, a new complete `bun run validate:full` invocation
passed, including 4,117 UI tests and 6,702 Vitest plus 14 Bun web tests.
The authentication observer and receipt checks passed 25 focused harness tests;
production build, bundle checks and documentation validation passed. All eight
image input inventories were recomputed again and remain unchanged. The next
three hosted diagnostics must still demonstrate the corrected behavior.

The [second stability round](stability-round-2.json) tested parent
`5e1ad04fd1de47811a6136566ca671548bfd5c02`, tree
`fe56bf063e1bd8015944ffc96eb7535795996d50`, with distinct empty sample commits.
All three passed GUI prerequisites, all 52 compiled cases, empty-profile startup
and unchanged reopen. Each directly recorded the local-admin storage event and
its subsequent authentication reload. Candidate shutdown evidence consistently
shows the mutation lock missing; none of these observed candidate stops left
a malformed lock. This is evidence for the implemented correction, not three
complete clean samples.

| Sample | Workflow | Passed scenarios | Blocking evidence |
| --- | --- | --- | --- |
| 1 | [38368340216](https://github.com/1H-Team/DevRyan/actions/runs/38368340216) | 3 | v2.0.7 boot timed out twice; v2.0.8 left a zero-byte mutation lock in same-runtime-upgrade |
| 2 | [38368340065](https://github.com/1H-Team/DevRyan/actions/runs/38368340065) | 2 | v2.0.8 left a zero-byte mutation lock in upgrade-previous |
| 3 | [38368339944](https://github.com/1H-Team/DevRyan/actions/runs/38368339944) | 6 | v2.0.8 left a zero-byte mutation lock in interrupted-upgrade |

Sample 3 booted v2.0.7 on its first attempt and passed both upgrade baselines,
same-runtime upgrade and unsettled-process recovery. The historical v2.0.7
failure is therefore intermittent, not a demonstrated inability to boot.
All three malformed-lock stops exited with code zero and no surviving owned
processes; each lock was zero bytes and had no parseable PID. No live unrelated
lock holder was observed. Cleanup refusal stopped the remaining cases, leaving
tampered-app rejection and service handoff unverified in this round.

There are still zero complete clean samples. The strict baseline cleanup rule
remains active. A proposed baseline-only allowance would retain an observed
zero-byte lock untouched after verified shutdown and require the candidate to
recover using the existing 30-second stale threshold; candidate cleanup and
retry limits would stay strict. This changes the user's explicit requirement
and is pending their decision. No main update, tag move or publication is
approved. The cache report and cleanup preview completed without deletion.
