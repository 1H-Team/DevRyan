# Startup refused with `bundle_execution_unsettled`

## Incident

The desktop app refused to open with `bundle_execution_unsettled
(bundle_execution_unsettled)`. The Electron main log at 21:09 (UTC+4) recorded
`[runtime-bundle] startup upgrade not applied: bundle_execution_unsettled`
during `bundle_candidate_preparation`, followed by an `application_import`
failure with the same code from the launch verification.

The selected bundle was revision 11, `native-e6eec1c26f54b657891ccce6-r10`
(transition `activate`, no reconciliation required). Read-only inspection of
its two session-mutation ledgers found eight leases in one ledger. Seven were
`published`. One was a `control` lease with `preparation: 'none'`, state
`ready`, no `ownerID` and no cleanup marker. It belonged to `devryan_task`
call `call_aa687b1b…` in session `ses_ed473ce2…`. No prompts, tool input or
credentials were copied.

## Journal correlation

The selected bundle's journal shows, for that call (times UTC+4):

- 19:21:09: lease reservation (`reservedAt`). Admission phases were slow;
  `lease_preparation` took 4,618 ms and the admission completed after 6,231 ms.
- 19:21:39: `managed_model_validation_failed` with reason
  `native_permit_invalid`, then `tool_completed` with status `error` and the
  tool error "The operation timed out."
- 19:21:53: a `session_removal` stop control, `turn_aborted` and `session_idle`.

No `finish` or settlement record exists for the call. `journal.mjs gaps
--verify` on the selected journal reported no gap records.

## Cause

`devryan_task start` runs under a 25-second `AbortSignal.timeout`. When it
fired, the tool permit was retired. The owner's `finally` then sent the
protocol-3 `finish`, which rechecks that permit before reaching the ledger.
The recheck failed, so the lease stayed `ready`.

Two further defects made this permanent. The protocol-3 `begin` reserved the
lease without an owner, and `recoverExecutionLeases` refuses owner-less leases
(`mutation_termination_unconfirmed`). In-runtime recovery also runs only after
launch, while the startup upgrade and the launch verification refuse every
unsettled lease first.

## Fix

- A refused native managed `finish` cancels and cleans the exact
  scope-matched `ready` control lease, then rethrows the original failure.
  Protocol-3 `begin` records the execution-host owner.
- `recoverExecutionLeases` settles owner-less, never-spawned control leases
  from earlier builds.
- `native-bundle-lease-recovery.js` settles the selected bundle's abandoned
  control leases inside the bootstrap lock, before setup-source removal, the
  startup upgrade and launch verification. It refuses while a live process
  owns the bundle and qualifies only views inside the ledger's own `views/`.
  Process leases and the strict `inspectBundleHarness` gate are unchanged.

The affected installation is repaired on the first launch of a build that
contains this fix. The installed bundle was not modified during the
investigation.

## Verification

New deterministic regressions:

- `bundle-harness-integrity.test.js`: `preparing`, `ready`, and cleanup-pending
  leases refuse with `bundle_execution_unsettled`; a cancelled, cleaned lease
  passes.
- `session-execution-host.test.js`: a `finish` refused with
  `native_permit_invalid` cancels and cleans the exact lease. Another token, a
  published lease, a process lease or another message stays untouched. A failed
  settlement never replaces the original failure. `begin` records the owner.
- `execution-preparations.test.js`: owner-less control leases are cancelled and
  cleaned without an owner probe; owner-less process leases are still reported.
- `runtime-bundle.test.js`: a selected bundle seeded with this incident's lease
  shape launches through `provisionDefaultNativeBundle`. The lease ends
  `cancelled` and cleaned, its view is removed, and the startup upgrade
  selects revision 2. With a live orchestration owner, cold recovery refuses
  (`bundle_upgrade_owner_active`) and the lease stays `ready`. A `ready`
  process lease is left alone and still refuses with
  `bundle_execution_unsettled`.

`bun run validate:full` passed lint, type checks and documentation validation.
Its test chain stopped at one harness-runtime test, "background packing keeps
the ledger exact, including while a call runs concurrently", with a transient
`capture_git_failed` during concurrent repacking. That package is unchanged here,
and the test passed when rerun alone. The remaining chained suites were then run
directly and passed: orchestration, Cursor SDK, Electron, desktop and UI
(4,103 tests), and web (6,616 Vitest tests and 14 Bun tests). Harness-runtime
had 702 of 703 passing in the full run.

Not run: a packaged or native-controller launch against a seeded profile. No
verified native artifact was built for this change. The startup regression
exercises the real provisioning, ledger and verification code with fixture
artifacts.

## v2.0.7 replacement release qualification

The current startup-recovery changes are included in the replacement v2.0.7
source. Production build and bundle budgets passed. Full validation passed
lint, type checks and docs checks but stopped in three separate script fixtures;
[retry evidence](verification-retries.json) records their isolated/serial passing
reruns. The 1,322 Node script tests are covered by the serial run plus the
three-test importer rerun. All remaining Bun script and workspace suites passed,
including 4,103 UI tests, 6,616 web Vitest tests and 14 native web Bun tests.
No assertions or deadlines were weakened.

[Fresh compiled native qualification](native-qualification.json) passed all
52 cases with no source changes or cleanup failures. The initial run timed out
in the human-queue fixture and cleanup; its journal gap scan found no gaps.
[Web QA](qa-web.json) and [Electron QA](qa-electron.json) passed all seven
chat checks. The initial Electron run captured a bootstrap path.get 503; the
isolated retry passed. Both passing screenshots were inspected: transcript,
sidebar and composer fit. Expected SSE disconnection during reconnect was the
only console error in the passing runs.

[Hosted migration verification](migration-verification.json) found no pending
migrations and schema marker 20260908182901. No local migration files are
modified or untracked. The replacement release keeps the exact desktop allowlist
DevRyan-2.0.7-arm64.dmg and all existing signing, image, anonymous-pull, topology,
packaging and hosted migration gates. Its requested title is DevRyanv2.0.7.

No installed-app replacement, new live-provider acceptance, Windows release
or notarization was checked. macOS retains its existing ad-hoc signing class.
