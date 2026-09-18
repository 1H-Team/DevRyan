# September 16 desktop crash and recovered-child stall

Investigation, implementation plan and verification record. Runtime fixes are now
implemented in this checkout; the installed application has not been changed. Times below are
America/Toronto (UTC−04:00). Source checkout: `09e743dd` / DevRyan 1.2.6.

## Findings

1. **Confirmed: DevRyan exhausted V8 memory at 09:31:59.** The macOS report
   identifies DevRyan 1.2.6, PID 84106, `EXC_BREAKPOINT` / `SIGTRAP`, on a
   `V8Worker` thread. Matching Electron 41.2.1 arm64 symbols resolve the stack
   through `V8OOMErrorCallback`, `v8::Utils::ReportOOMFailure`, and
   `v8::internal::V8::FatalProcessOutOfMemory`, followed by garbage-collector
   page-evacuation frames. This is an application-process native OOM, not merely
   an error rendered in the chat.
2. **Confirmed: an earlier 03:18:46 crash also followed V8 OOM.** That report
   identifies DevRyan 1.2.5, PID 2836, on `CrBrowserMain`; matching symbols show
   string allocation and `JsonParser` / `Builtin_JsonParse` below the OOM
   handler. This supports investigating JSON allocation and retained data, but
   does not identify the particular JSON response or its owner.
3. **Confirmed: the recovered Oracle task completed and remains uncollected.**
   The UI showed “Review Final Vocabulary Deletion Fix” complete. Its third
   attempt started at 15:45:30 and finished at 15:46:24. The durable envelope
   has `status: completed`, `action: null`, and `acknowledgedAt: null`; the root
   barrier is `awaiting_acknowledgement`. The result has not been lost.
4. **Reproduced continuation defect:** the collection wake is rejected when
   the parent's last assistant message has an error. The root last failed at
   09:30:10 after repeated API connection failures. The current continuation
   admission rejects `check.last.info.error`, including for `kind: collect`.
   An isolated fixture matching an idle failed parent and an awaiting-result
   barrier returns `managed_continuation_fenced`; removing only the error makes
   admission succeed. The incident journal has no admitted wake after child
   completion. The exact live rejection log was not retained, so the fixture
   establishes the code-path defect rather than a captured live RPC trace.
5. **Reproduced refresh feedback defect:** importing an unchanged invalid
   historical change receipt writes its unavailable state and publishes
   `session.changes.updated` again. The UI consumes that event and schedules
   another summary GET, which imports the same history. Four identical reads
   in an isolated Git fixture each emitted one update event. The incident root
   has 193 change-update records and 94 invalid-receipt diagnostic records in
   the 09:20–09:32 window, and the cycle continued after relaunch. This is a
   concrete source of repeated parsing and work; its contribution to OOM is
   not yet measured.

The API connection failure preceded the native crash by about 109 seconds.
There is no evidence that the provider error itself caused the OOM. The recovered
child stall is independently reproducible after the app is running again.

## Evidence and limitations

- macOS reports: `~/Library/Logs/DiagnosticReports/DevRyan-2026-09-16-093242.ips`
  and `DevRyan-2026-09-16-031918.ips`.
- Application log: `~/Library/Logs/DevRyan/main.log`. It shows app-bound fallback
  at 07:59 and again after the 15:44 relaunch, and recovery of the dead
  orchestration owner. The runtime-service stderr file has no incident-window
  fatal diagnostic.
- Journal root: `~/.config/openchamber/harness/journal`. Both
  `bun scripts/journal.mjs gaps` and `bun scripts/journal.mjs gaps --verify`
  returned no reported gaps. This does not guarantee the final in-memory events
  survived abrupt process termination.
- Parent: `ses_f578c8895ffeIvPMXOgQp4KhAk`; recovered child:
  `ses_f55a8baa6ffe9czm2efFLt26sP`; recovered task:
  `dvr_task_3d46079503e7458fbbde8bf50351b015`.
- Read-only ledger inspection found the unacknowledged result. The persisted
  primary objective remains `observing`, `attemptCount: 0`, with the failed
  09:30 assistant step and a child-completed progress receipt at 15:46.
- Symbols came from Electron's official
  [41.2.1 arm64 symbol archive](https://github.com/electron/electron/releases/download/v41.2.1/electron-v41.2.1-darwin-arm64-symbols.zip).
  Its framework module ID `4C4C44BE55553144A121891FBDF26DF90` matches both crash
  reports' framework UUID `4c4c44be-5555-3144-a121-891fbdf26df9`. The download was
  partial; the available compressed framework data contained the function
  records needed to resolve the OOM and JSON-parser frames. Unresolved frames
  were not used to infer a cause. The original reports' distant public-symbol
  labels were insufficient for diagnosis.
- No heap profile, allocation history, or fatal allocation-size message exists
  in the inspected evidence. The reports' large virtual-address reservations
  are not measurements of resident memory. Do not claim a particular leak,
  heap limit, or OS-wide memory shortage from these reports alone.
- No running app, provider configuration, user project, task result, or ledger
  was modified. No original prompt or failed command was replayed.

## Implementation plan

### 1. Stop unchanged receipt reads from generating more refreshes

Owners: `packages/harness-runtime/lib/session-changes.js`,
`session-changes-receipts.js`, and `session-changes-host.js`; shared UI
`packages/ui/src/stores/useSessionTreeChangesStore.ts`.

- Persist a bounded input fingerprint and normalized outcome for rejected
  historical receipts. Repeated identical input must retain the existing
  operation and diagnostic state without another write or change event.
- A changed or repaired receipt must still be revalidated, replace its own
  unavailable state, and publish a real update. Preserve partial coverage,
  verified files, path confinement, and restore guards.
- Coalesce concurrent summary/history reconciliation for the same canonical
  directory and session scope. Replace repeated client abort-and-restart
  refreshes with one active read and at most one trailing dirty refresh.
  Preserve authorization boundaries and genuine updates arriving mid-read.
- Bound retained queued read work and propagate cancellation where ownership
  permits it. Keep mutation serialization and cross-process locks intact.
- Add regressions for repeated invalid input, repaired input, unchanged valid
  input, concurrent subscribers, root/child notifications, client disconnect,
  and one real change arriving during an active request. Assert that the
  read/event/read cycle becomes quiescent.

### 2. Identify and remove the allocation source behind native OOM

Owners: Electron `main.mjs` for process telemetry; the measured host allocation
path for the actual fix. Start with session-change history parsing/reconciliation;
also measure managed-result snapshots rather than assuming either owns the leak.

- Add bounded, content-free diagnostics for process identity/role, app and
  Electron versions, V8 heap used/limit, RSS/external memory, event-loop delay,
  active reconciliation count, queued work, and response bytes. Record periodic
  samples and threshold transitions; never dump prompts or credentials.
- Build a disposable Electron fixture with synthetic long histories, large
  tool receipts, multiple children, invalid receipts, and repeated summary
  subscribers. Exercise both app-bound and service ownership without loading
  installed-app state. Measure allocation/retention before and after step 1.
- Use heap/allocation profiles only on this synthetic fixture. Existing
  per-response byte limits are not aggregate memory limits: account for
  concurrent buffers, decoded strings, parsed objects and queued closures.
  Apply paging, bounded retention, or backpressure at the measured owner.
- Separately reproduce the logged runtime-service registration failure. A
  working separate owner improves fault containment, but does not fix an OOM
  in that owner; do not use ownership changes as the memory fix.
- Consider local-only native crash capture using Electron's
  [crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter)
  with uploads disabled, bounded retention and explicit export handling.
- Acceptance: idle summary polling settles, post-GC heap plateaus under repeated
  workloads, queued work stays bounded, and a packaged-equivalent long-running
  fixture exceeds the approximately 92-minute morning app lifetime without
  monotonic retained-memory growth. Report actual metrics and unavailable
  native checks. Do not raise the default heap limit as a substitute.

### 3. Deliver a recovered child result after a parent transport failure

Owners: `packages/harness-runtime/lib/provider-recovery.js`, its host adapter,
`packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs`,
and `packages/orchestration-runtime/scheduler.js`.

- Introduce a narrowly authorized collection transition for a completed,
  unacknowledged child recovered by the user. Bind admission to task/envelope,
  root, current objective, recovery attempt, and current runtime ownership;
  a generic `kind: collect` string must not authorize bypassing recovery rules.
- Permit this transition after a finalized parent transport failure only when
  it is idle and its tool outcomes are resolved. Preserve cancellation,
  supersession, pending question/permission, read-only policy, model selection,
  repeated-rejection and unknown-outcome guards. Do not globally remove the
  failed-message check or enable automatic recovery for unrelated errors.
- Persist and reconcile delivery identity before dispatch. Reconcile ambiguous
  acceptance against the parent transcript rather than blindly resending;
  ensure restart and duplicate plugin instances cannot duplicate the wake.
- Have the parent collect and disposition the existing result, then continue
  its remaining objective. Never repeat the completed child or automatically
  perform the child review's proposed user-project changes from this task.
- Journal safe rejection reason and task/root/wake IDs. Distinguish retryable
  transport errors from a permanent admission fence; avoid an endless silent
  retry scan. If continuation remains unavailable, display the parent failure
  with a specific resume action beside the retained child result.
- Add an integrated scheduler/plugin/primary-host regression: parent API error
  → app restart → user recovers same child → child completes → exactly one
  accepted parent wake → result acknowledgement → normal continuation. Include
  missing objective, changed objective, cancellation, pending permissions,
  unresolved tools, duplicate watchers, crash around dispatch, and repeated
  provider failure. Current tests that remove the parent's error before
  collection do not cover this incident.

## Verification and completion gates

- Investigation probes used disposable fixtures under the repository's ignored
  `.cache/crash-investigation-2026-09-16/`, with mocked transport and no provider
  calls. Continuation probe: failed tail rejected; otherwise identical clean
  tail admitted. History probe: four identical reads emitted four update events.
- The implementation should first encode those reproductions in the owning
  package suites, then fix them without weakening coverage or safety assertions.
- Run `bun run validate:full` for the shared recovery/server contracts. Add
  `bun run build` and `bun run bundle:check` if diagnostics change imports or
  packaging. Use an isolated native Electron soak for memory and an isolated
  UI check for the completed-child/parent-failed presentation.
- No production retry, deployment, release, data deletion, or installed-app
  restart is part of this investigation plan.


## Implementation results (September 17)

- Historical inline receipt rejection is persisted by input fingerprint. A
  changed or repaired receipt is still revalidated. The regression that
  previously emitted four updates for four identical reads now emits one.
- Summary work shares a bounded pool (two active scopes, sixteen queued scopes,
  128 subscribers per scope), processes histories sequentially, and propagates
  the final subscriber's cancellation. Canonical aliases share reconciliation
  while responses retain the requested directory. Summary and restore
  recomputation use the same canonical scope, preserving Undo revision checks.
- The UI uses one active request and one dirty follow-up. Pending-evidence
  retries preserve their backoff; deleted sessions and released worktrees reject
  late responses.
- Recovered-result admission requires scheduler proof tied to the objective,
  dispatch group, completed envelope and current claim. It handles both the
  original observing state and a finalized connection error already marked
  `failure_not_eligible`. Other attention reasons remain fenced. Stop invalidates
  an in-flight proof immediately, before reservation. Old failure notifications
  cannot supersede the newly reserved, not-yet-persisted wake.
- The wake identity is persisted before POST. Duplicate/restarted watchers
  reconcile a canonical accepted message, or publish an explicit manual-resume
  state when acceptance cannot be proved. The parent and completed-result UI
  expose the resume action. Tests cover acknowledgement loss, repeated provider
  failure, pending requests, tool uncertainty, cancellation, objective changes,
  stale claims and normal result acknowledgement without a replacement child.
- Electron now emits fixed numerical memory/read counters once per minute and
  on pressure transitions. Telemetry failure cannot crash startup or the timer.
  Production heap limits are unchanged, and no application content is dumped.
- The runtime-service fallback fixture reproduces both recorded boundary codes:
  `runtime_service_owner_stale` and `desktop_host_registration_failed`. Safe
  fallback still waits for the service to stop before taking ownership. The
  latter code is now preserved in the sanitized recovery diagnostic. The
  original HTTP status/response that caused desktop-host registration failure
  was not retained, so its lower-level cause remains unverified. No launchd
  registration or installed-service mutation was attempted.
- Local-only crashReporter was considered and left disabled: macOS native
  reports already establish OOM, while the missing evidence is allocation
  history. The new numerical telemetry and synthetic-only profiler address
  that gap without recording real prompts, credentials or user heap contents.

### Measurements and visual verification

`node scripts/verify-crash-memory.mjs` uses Electron 41.2.1, isolated profiles,
fake transport and disposable Git/data roots. It does not run the full installed
application or exercise signing/launchd registration. Both actual coordinator
ownership modes are exercised. The history workload uses five sessions, roughly
7.4 MB of synthetic history per scope and eight simultaneous subscribers.

A baseline snapshot of this repository's `HEAD` was extracted only beneath
`.cache/crash-baseline/`; no upstream repository was accessed. Over three polling
rounds the old code emitted 72, 144 and 216 cumulative change events and made
360 upstream fixture requests. The fixed path settles at nine initial events
and makes fifteen upstream requests per eight-client round, an eightfold
reduction. A short comparison does not recreate or establish the precise cause
of the historical native OOM.

The fresh short comparison against final source measured sampled pre-GC peaks
of 43.05/43.11 MiB before the fix and 25.08/24.89 MiB afterward (app-bound/service).
These are samples at workload boundaries, not exact process high-water marks.
The baseline finished three rounds in about 138 seconds; fixed source finished
ten rounds in about 129 seconds. Post-GC heap ended at 13.17/13.16 MiB before
and 12.99 MiB afterward. The baseline's three samples are insufficient to assess
long-term retention.

Synthetic allocation profiles show that the retained history fixture is
dominated by its deliberately retained 7.4 MB response strings. A separate
60-task managed-ledger workload (14.8 MB serialized, eight simultaneous snapshot
copies per round) completed thirteen rounds over 120 seconds in each ownership
mode. Post-GC heap ended at 32.54 MiB, with a sampled transient heap peak of
87.74 MiB and a last-third versus first-third retained change of −0.54 MiB.
This did not reproduce growing retained scheduler snapshots, so no speculative
scheduler snapshot rewrite was made.

The built isolated recovery UI was checked through computer use: the completed
result and parent failure are visible together, a disconnected resume preserves
the result and displays the failure, and reconnect plus explicit resume clears
the collection notice. Mounted tests also cover duplicate clicks, cancellation
and objective replacement. This is shared-component verification, not a claim
of installed-app or native-shell end-to-end verification.

### Final validation

- `bun run validate:full` passed on final source, including 3,678 UI tests and
  4,109 web tests. An earlier run had one failure in the unchanged skill-scan
  route test (404 instead of 200); that test passed in isolation and the full
  rerun passed. The transient failure's cause was not established.
- `bun run build` and `bun run bundle:check` passed. The startup bundle remains
  within its raw and compressed size budgets.
- The isolated recovery fixture type check and build passed. Its browser check
  used synthetic state only; no installed task was resumed or changed.
- `bun run docs:validate` passed with existing historical-document warnings.

The 95-minute native Electron soak passed in both ownership modes (95.04 minutes,
413 samples each). Each mode made 6,195 upstream fixture requests and emitted
only nine initial change events. Every recorded boundary had zero active or
queued reads, tracked scopes, active responses and retained response bytes.

| Measurement | App-bound | Runtime service |
| --- | ---: | ---: |
| First-third mean post-GC heap | 13.80 MiB | 13.80 MiB |
| Last-third mean post-GC heap | 16.48 MiB | 16.48 MiB |
| Retained growth (gate: below 16 MiB) | 2.67 MiB | 2.67 MiB |
| Final post-GC heap | 17.14 MiB | 17.14 MiB |
| Sampled RSS range | 69.88–156.47 MiB | 71.20–155.97 MiB |

There is measurable upward drift; this is not a zero-growth or leak-free claim.
The final sampled allocation profiles remain dominated by approximately
7.1 MiB of deliberately retained fixture strings. Secondary allocations include
`AbortSignal.any` cancellation bookkeeping. These profiles do not establish
which allocations caused the historical production OOM. Numerical telemetry
provides a way to correlate future installed-runtime pressure with real work.

The long soak loaded the fixed receipt/read pipeline before subsequent alias
and recovery corrections. Those later corrections received final-source full
validation, build checks and the fresh short memory run above. The soak's raw
results and synthetic profiles are retained under
`.cache/crash-memory-soak/{app_bound,service}/`; short comparisons are under
`.cache/crash-memory-{before,after}-final/` and scheduler snapshot measurements
under `.cache/crash-memory-snapshots/`. These ignored local artifacts contain
synthetic evidence, not installed-app heap contents. Test processes exited
successfully, and the isolated visual fixture server was stopped.
