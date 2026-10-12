# Startup repair and qualification

This change preserves the original startup upgrade error, adds guarded macOS
restart recovery for abandoned process leases without termination receipts, and
keeps strict current-artifact checks. It also moves the existing splash ahead of
the large Electron import, overlaps provider and agent HTTP reads without
resolving defaults early, and avoids redundant source verification within one
upgrade operation.

## Incident and recovery boundary

The authorized read-only inspection found DevRyan 2.0.8 shipping Claude 2.1.280
while the retained selected bundle contained Claude 2.1.251. A ready process lease
without a termination receipt blocked the upgrade. The later current-pin check
masked that error. Retained journal gap checks found no gaps, but the exact call's
execution evidence was unavailable; absence of a receipt did not prove that the
process never started.

Recovery records exact selection, ledger, private view and boot evidence under
bootstrap, selection and ledger locks. A different macOS boot identity is
required before settlement. The result remains uncertain: private views and Git
pins are retained, project changes are not applied, and no termination receipt
is invented. Changed evidence, live owners, pending materialization and same-boot
retries remain refusals. Partial recovery can resume after another reboot.

The installed application and personal data were not modified or restarted.

## Verification

- Startup contract suite passed, including 217 web tests.
- Recovery-specific verification passed 49 web and 71 harness tests.
- The final UI request ordering regressions passed all 23 tests; lint and type
  checks passed after preserving synchronous request initiation.
- Production build and bundle budget checks passed.
- The final full script suite passed after the observer and QA changes; its
  focused observer/startup coverage also passed all 29 tests.
- Local packaged recovery UI passed: actual preparation action, unchanged
  selector/database, same-boot refusal, and owned process/payload cleanup.
- Full validation initially exposed an existing platform skip declaration. It
  now asserts unsupported-host refusal instead; the script suite passed on rerun.
- All workspace test commands passed on the subsequent sequential run, including
  6,702 web Vitest tests, 14 web Bun tests, and 4,117 UI Bun tests. The initial
  `validate:full` invocation stopped at the script-policy failure; its remaining
  package suites and corrected checks were completed separately.
- The first compiled native qualification passed its individual cases but was
  rejected because source changed during the run. The
  [final-source native qualification](native-qualification.json) passed with
  unchanged source, no cleanup failures and no remaining native mandatory gates.
  Four matched performance attempts failed in the main-process visibility
  observer: promise collection, early unavailable Electron APIs, and a reopen
  inspector identity mismatch, and an early-context visibility timeout. They
  provide no speed claim. The observer now uses read-only macOS on-screen window
  metadata for the exact owned process. The subsequent comparison did not qualify,
  as detailed below.

The [sanitized UI receipt](recovery-ui.json) binds the working-source digest and
packaged application. Its commit field is the base commit; these changes were
uncommitted during local QA. Visual review confirmed readable, unclipped recovery
instructions and actions on the [failure screen](DevRyan-startup-recovery-failure.png),
[prepared screen](DevRyan-startup-recovery-prepared.png), and
[same-boot refusal](DevRyan-startup-recovery-same-boot-refusal.png).
Local QA uses unsigned development packaging and cannot qualify a release.
The recovery failure occurs before the server diagnostic journal is imported, so
the local recovery UI run has no pre-import journal evidence. Its screen and
state checks do not replace the release journal gate.

The [standalone startup diagnostic](startup-diagnostic.json) passed the actual
same-version native upgrade, event-stream readiness, fixture response, populated
history and exact-conversation restoration after reopen. It observed an on-screen
window at 1.052 seconds, usable chat at 40.378 seconds, and completed response at
1.178 seconds after submission. These are one-run diagnostic observations, not a
speed comparison. Window timing is an OS-observation upper bound, not first paint;
the response's time from launch includes creation of 200 synthetic history entries.
Visual review passed the [splash](DevRyan-startup-splash.png),
[progress](DevRyan-startup-progress.png), [response](DevRyan-startup-response.png)
and [restored conversation](DevRyan-startup-reopen.png). No recording was captured
or reviewed.

## Performance acceptance failed

The [matched comparison receipt](startup-comparison.json) retains the planned
B1/C1/C2/B2/B3/C3 order. All five completed arms passed real response, restored
conversation, journal and owned-process cleanup checks. The third candidate's
window-observation command failed before a valid timing could be admitted; its
original stderr, exit code and signal were not retained, so the exact cause is
unavailable. This is an incomplete cohort, not a passing speed comparison.

| Pair | Baseline usable chat | Candidate usable chat | Result |
| --- | ---: | ---: | --- |
| 1 | 47.724 s | 35.688 s | Candidate faster |
| 2 | 40.224 s | 40.700 s | Candidate slower by 0.476 s |
| 3 | 47.093 s | Unavailable | Observer command failed |

The required all-three-faster condition already failed in pair 2. No three-pair
median improvement is reported and no rerun was selected to replace these results.
The observed phases confirm the intended changes ran: source artifact verification
count fell from 11 to 10, candidate bundle preparation took 16.77–16.90 seconds
versus 18.17–18.44 seconds in the baseline, and provider/agent readiness overlapped.
These phase observations do not establish accepted end-to-end improvement.
In pair 2 the candidate reached the loopback origin 1.166 seconds earlier, then
lost that gain while waiting for native health and UI readiness. The evidence
does not identify a missing planned optimization or establish the cause of that
later timing variation.

The first candidate's [completed response](DevRyan-comparison-response.png) and
[restored conversation](DevRyan-comparison-reopen.png) were visually reviewed.
Performance acceptance remains unmet.

The observer now retains bounded failure metadata and retries only a killed
SIGTERM timeout within the same 45-second overall deadline. Other failures still
refuse admission; exact owned-process visibility remains mandatory. The
[final standalone recheck](final-observer-check.json) passed launch, response and
reopen with these diagnostics. It does not replace the failed comparison.

Disposable packages, native build copies and superseded retry directories were
removed after the sanitized receipts and screenshots were saved here. No
worktree was created. Storage reporting and pruning preview are read-only;
unrelated retained runs were not deleted.

## Release gate

Publication requires the exact final installer, source and runtime manifest,
complete startup/reopen/history/response checks, screenshots, journal checks,
and successful cleanup. On 2026-10-13 the user explicitly removed the independent
actual-reboot publication gate and its staging workflow. Recovery preparation
and same-boot refusal remain required; recovery after a real OS reboot remains
unverified.

The disposable GitHub-hosted macOS runner prerequisite was unavailable on this
workstation. Actual reboot, final signed-DMG qualification, native service
registration, and clicking the relaunching Retry action have not been verified
here. No release was published. Synthetic boot UUID tests and local UI evidence
do not satisfy those gates.

The early-window design was informed by the read-only inspection of
[OpenChamber's entrypoint at the pinned commit](https://github.com/openchamber/openchamber/blob/041b8f7bdd880a60f680a892f92d65beb8aaf0e7/packages/electron/entry.mjs#L91).
No upstream checkout or dependency was imported.
