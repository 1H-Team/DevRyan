# Startup lockout from a never-started process lease

## Incident

The installed 2.0.9 desktop app refused to open with
`bundle_execution_unsettled`. **Prepare recovery for restart** then failed with
`bundle_reboot_recovery_inventory_invalid`, and a computer restart changed
nothing. The state below was read without modifying it. No prompts, tool input,
file contents or credentials were copied.

The selected bundle was revision 12, `native-da0024416be697594c01bee3-r11`.
One of its two session-mutation ledgers (`8a7eca4f…`) held 40,837 records and
eleven leases. Ten were settled control leases. One was a process lease:

- `executionKind: "process"`, `state: "ready"`, token `ac1af5a2-…`, reserved
  2026-10-11 23:11:31 (UTC+4), for a Cursor worker call in session
  `ses_ed39ff41…`.
- Its view held only `worktree/` and `scratch/`. There was no
  `termination.json`. Its execution-owner lock was free.
- `recovery/reboot.json` did not exist.

## Log and journal correlation

`~/Library/Logs/DevRyan/main.log` (UTC+4), from the 2.0.7 session that left it:

```
[2026-10-11 23:12:26.338] [warn]  [ManagedOrchestration] Provider abort cleanup was not confirmed { … primaryReason: 'Parent session stopped' … }
[2026-10-11 23:17:22.323] [error] [CursorSDK] persist failed: Error: native_managed_task_lease_invalid
[2026-10-12 01:54:57.362] [info]  Starting graceful shutdown...
[2026-10-12 02:36:55.327] [error] [electron] startup failed { message: 'bundle_execution_unsettled', … }
```

The bundle's journal agrees: `turn_started` at 23:11:22, `turn_failed` with
`CursorPersistenceError` at 23:17:22, and an unexpected `opencode_process_exit`
at 01:54:54. Nothing is journaled afterwards.

Every later launch, including the one after the restart at 13:08:22 on
2026-10-13, logged:

```
[runtime-bundle] abandoned control leases not settled: bundle_lease_recovery_failed
[runtime-bundle] startup upgrade not applied: bundle_execution_unsettled
[electron] startup failed { message: 'bundle_execution_unsettled', … }
```

Each **Prepare recovery** attempt logged artifact verification and then nothing.

## Causes

1. **The lease leaked.** `session-execution-owner.js` awaited the supervisor's
   result outside its settlement `try`. When the launcher ended without creating
   its receipt, the rejection skipped `finish`, `cancelLease` and
   `cancelUnstartedCall`. Graceful shutdown joins only in-flight work, so the
   lease outlived the runtime. Which event ended the launcher early was not
   established; a cancellation between the Cursor grant recheck and the
   launcher's receipt creation fits the lease shape and the log.
2. **Cold recovery could not settle it.** It required a termination receipt for
   every process lease, and the missing file was reported only as
   `bundle_lease_recovery_failed`.
3. **Restart recovery could not prepare.** Its inventory read refused any ledger
   with 32,768 or more records or more than 64 MiB. It threw before writing the
   fence, so the restart had nothing to finish. The refusal was not logged.

## Changes

- The execution owner cancels and cleans a lease whose launcher could not be
  created or closed without a receipt.
- Cold startup recovery cancels a claimed `ready` process lease as never started
  when its owner lock is free, no owner of the bundle is alive, the receipt file
  is absent and the lease was reserved more than ten minutes earlier. The native
  supervisor creates the receipt exclusively before it forks, and the sandbox
  profile denies the confined command writes beside its view. Empty or invalid
  receipts stay held.
- Restart recovery digests ledgers and views as streams with no limits. The
  ledger digest is byte-identical to the 2.0.9 one, so existing fences still
  verify. A fence whose evidence changed can be replaced by preparing again.
- Refused preparations are logged and keep the action available. The unsettled
  refusal logs the ledger prefix and each held lease's token, state and kind.

- The upgrade bundle copy skips the ledger's `module-overlays/` directory.

## Second blocker on the affected installation

The fixed cold recovery was run against the installed state through
`recoverSelectedBundleLeasesAtStartup`, under `bootstrap.lock`, by the owner. It
reported `recovered`, and the lease read back as `cancelled`,
`cancelledBeforeStart`, `cleaned`. The installed 2.0.9 app then passed the lease
gate and began the pending runtime upgrade, which failed at 14:23:53 and again
at 14:24:18 (UTC+4):

```
[runtime-bundle] startup phase {"phase":"bundle_data_copy","outcome":"failed",…}
[runtime-bundle] startup upgrade not applied: bundle_symlink_source
```

The same ledger held `module-overlays/` with 698 symlinks, created on
2026-10-11 by `node_modules` execution inputs. The upgrade copy refuses every
symlink and ignored only `context-cache/`. No other symlink or special file
existed in the bundle. The directory was moved out of the bundle, intact, to
unblock the installed 2.0.9 app; the copy now ignores it.

## Third blocker, after installing 2.0.10

With 2.0.10 installed, the runtime upgrade completed at 17:43:00 (selection
revision 13, bundle `native-6e75eefd835a150e4e499166-r12`, cloned from r11).
Runtime recovery then failed:

```
[runtime-bundle] startup phase {"phase":"native_recovery","outcome":"failed",…}
[electron] deferred OpenCode startup failed { code: 'native_cursor_recovery_owner_mismatch' … }
```

`harness/native-cursor/` held one write-ahead intent for the same Cursor turn,
phase `bound` to lease `ac1af5a2-…`. Intents are stamped with the bundle ID that
wrote them, and the upgrade copied it into the new bundle unchanged, so the new
bundle rejected it. The intent's owner was rewritten by hand to the new bundle
ID on the affected installation, with a backup. `createNativeCursorRecovery`
now accepts intents of the verified source bundle and re-stamps them under its
lock (`native-cursor-recovery.test.js`).

## Fourth blocker, after installing 2.0.11

The 2.0.11 startup upgrade refused at 20:00:23 and 20:01:06 (UTC+4) with
`bundle_native_removal_invalid`. Two sessions deleted that afternoon were child
sessions created by `registerChild`, whose ledger records carry no `directory`.
`session-mutations.js` treats that field as optional, but
`bundle-harness-integrity.js` required it to equal the ledger directory for
every removed member. Both records were given the ledger directory on the
affected installation, under the ledger lock with no runtime owner alive, and
the verifier now accepts an absent directory
(`bundle-harness-integrity.test.js`). Whether the app then opened is not yet
confirmed.

## Design change after the fourth blocker

All four blockers were one pattern: each release clones the runtime bundle, and
a strict verifier or recovery step refused the whole launch over one record it
did not expect. Startup now refuses only for in-flight or foreign state and
isolates defects in finished or derived records, and a refused same-version
upgrade opens the existing runtime. The contract is in
`packages/web/server/lib/opencode/runtime-host/DOCUMENTATION.md`.

`runtime-bundle.test.js` now upgrades one ledger carrying this incident's
shapes together: a settled process lease without its receipt, a deleted child
session with no directory and no hold, `.DS_Store`, `module-overlays` links, a
cache link and FIFO, and a stray evidence file. It asserts the upgrade applies,
the exact findings, and that a `committed` removal and a `ready` lease in the
same ledger still refuse. Native recovery against a real controller is not part
of that test; Cursor isolation is covered in `native-cursor-recovery.test.js`.

Verification of the design change: `bun run validate:full`, `bun run build`,
`bun run bundle:check`, `bun run docs:validate` and `bun run test:startup`
passed. The isolated web QA smoke (`bun run qa`, fresh native artifacts) booted
the real server and native runtime through the changed startup path and passed
its seven chat checks. Not run: the Electron QA lane, a host seeded with
leftover records (the in-app warning is covered by a mounted component test
only), Windows inspection, and a packaged upgrade.

## Outcome on the affected installation

After the three repairs, the installed 2.0.10 app opened at 17:57:36 (UTC+4):
`native_recovery` and `native_open` completed, the owner confirmed the UI, and
the Cursor intent file was gone, settled by recovery.

## Verification

Local, on disposable fixtures:

- `runtime-bundle.test.js`: a startup upgrade with a link overlay in the ledger
  succeeds and the new bundle has no `module-overlays/`. The test fails with
  `bundle_symlink_source` against the previous code.

- `native-bundle-reboot-recovery.test.js`: a 34,000-record ledger with a FIFO in
  the view prepares and completes, with the digest equal to the 2.0.9 formula; a
  changed fence is superseded; an aged receiptless process lease is cancelled
  and cleaned, while a young one, one with a live owner and one with an empty
  receipt stay held.
- `session-execution-owner.test.js`: a launcher that exits before creating its
  receipt is settled as never started. The test fails against the previous code.
- `startup-splash.test.mjs`: a refused preparation is logged and stays
  preparable.

## Not done or not verified

- The fix for the third blocker has not been run as a packaged build; the
  affected installation was unblocked by the manual re-stamp described above.
- Restart recovery after an actual OS reboot remains unverified.
- No shutdown-time sweep of a host's own never-started leases was added; the
  owner fix and cold recovery cover the observed path.
- The launcher installs its signal handlers after creating the receipt. A
  cancellation in that window leaves an empty receipt, which stays held by
  design. The native launcher was not changed.
- Unsettled lease shapes other than the one above (for example a prepared,
  unclaimed lease whose owner died) are still left to the strict gate.
- The signed-baseline release scenario `unsettled-process-upgrade` passed in the
  v2.0.10 release run; see the [release record](../release-2.0.10/README.md).
