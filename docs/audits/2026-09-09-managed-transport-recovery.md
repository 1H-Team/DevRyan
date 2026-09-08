# Managed response interruption investigation — September 9, 2026

Administrator Error Log `d2e83e0b-d087-5f17-ae70-14c8d3108a72` resolved to
root session `ses_f7c846c54ffeFx9TD0svbe3gjz` and Designer child
`ses_f7c75f485ffeWSb4Z1iG6qHOoD`, using Anthropic Claude Opus 5 on attempt 2
(`resume`). At 02:00:49.337 UTC the journal records a connection-closed error.
The failed assistant is `msg_083e559b4001jd2k38ORhDbc5Y`; its pending edit
`toolu_01MrM5r79GqkL6Pow949X7By` had empty input and settled as aborted before
execution. The assistant finalized at 02:00:50.703 UTC. Earlier edits and tool
results were retained. No quota exhaustion appears in the incident error.

The full journal gap scan found 33 Bot computer network gaps, all before the
incident and none attached to either incident session. Provider wire traces and
the underlying reason for the connection closure are unavailable. The Error Log
had redacted task IDs; correlation used the child session, timestamp, assistant
message and tool call instead.

A later manual model switch at 02:04:43.690 UTC inserted an inaccurate
“after a provider usage limit” notice. The notice was unconditional in code.
A disposable executor fixture also demonstrated that transcript-only failure
recovered with one continuation, whereas supplying the same live `session.error`
returned failed with zero continuations. The live terminal-error fast path
bypassed transport recovery.

The implementation unifies settlement, reserves recovery durably before dispatch,
allows one same-model continuation and then one configured backup, and reports
the actual cause. It preserves the canonical child and completed work, refuses
uncertain tool execution, and never resends an ambiguously delivered recovery.
It does not change the running application's state or replay this historical task.

## Verification

All incident reproductions use disposable injected transports or local fixtures
without live provider credentials.

- `bun run validate:full` passed: workspace lint, type checks, documentation
  validation and every deterministic package suite. The UI suite passed 3,591
  tests; the final web suite passed 3,907 tests across 372 files.
- The dedicated transport executor suite passed 19 cases, including incident
  ordering, delayed teardown, duplicate events, uncertain delivery, restart from
  reserved/submitted receipts, cancellation before/after dispatch, shutdown,
  newer input, and backup success/failure. Existing executor tests also passed.
- Scheduler tests cover one backup, quota/authentication failure on that backup,
  missing or identical backups, cancellation during host selection, restart
  before backup parking, and unchanged historical failures without receipts.
- The real web scheduler/executor/event-registry fixtures passed primary →
  same-model → backup success, backup failure, and unavailable-backup scenarios.
  They verify one canonical child, durable reservations before dispatch, the
  configured backup thinking level, retained work, and zero quota probes/breakers.
- Isolated task-card and store checks passed for connection recovery wording,
  backup/manual recovery, and monotonic receipt projection without changing
  references for unchanged state.
- `bun run build` passed for web and Electron. `bun run bundle:check` passed
  with the web startup gzip bundle at 1,384,153 bytes against a 1,456,388-byte
  budget. The build emitted dependency annotation, mixed-import and chunk-size
  warnings; these did not fail the build or budget check.

An initial full run exposed a legacy timeout-continuation regression; its prior
terminal outcome was restored and the final gate passed. A separate run during
the build hit an unrelated 30 ms local HTTP fixture timeout (one extra retry);
that test passed unchanged in isolation and in the final full run.

No live provider, installed-app, native UI, signing, or release acceptance check
was performed. The running app was not restarted, and the historical incident
was not replayed.
