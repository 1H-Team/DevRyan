# Subtask deadlines and answered question replay

## Incident evidence

The retained desktop journal and the running DevRyan UI were inspected on
2026-09-14. A verified scan of retained journal chunks found zero gap records.
No provider prompt, migration, or recovery action was replayed during this audit.

- Root `ses_f6513f3d6ffep6glA2siDrudp0`, **Booking manager package queue dialog**:
  task `dvr_task_83cbed189b2242029f997e49666494e5` started at
  2026-09-13T18:02:27.661Z and failed at 19:02:26.459Z with
  `Managed task timed out at 1789326146024`. Its canonical child was
  `ses_f6410a9e5fferCDNUE008Bu7jw`. The journal retained completed patch/shell
  activity at approximately 18:54 and a running shell part at 19:02:24.662Z.
  This was the scheduler's fixed execution deadline, not proof that the
  implementation or its verification had finished.
- Same-child resume `dvr_task_d5a1eb829a1240feb537b3d54bc56741` failed seconds
  later. At 19:03:06.733Z the child emitted `CursorProviderError` with
  `Authentication error If you are logged in, try logging out and back in.`
  The journal establishes provider rejection; it does not establish whether
  credentials expired, were revoked, or failed for another provider-side reason.
- Root `ses_f649ec2a1ffeJU8OwA5fcHtD0P`, **Support message identity and claim history**:
  question `que_09fc73239001K2Rwn6LGnAe1rh` was asked at
  2026-09-14T11:57:07.370Z. A `question.replied` event carrying **Finish locally**
  arrived at 11:57:28.709Z, followed by further task work. The UI still showed
  **Input needed** while the live `/api/question` endpoint returned an empty
  array. Refreshing only the renderer cleared the card and showed the ongoing
  task. The answer was not resubmitted and the runtime was not restarted.
- The old diagnostic sanitizer omitted `requestID` from settlement events.
  Exact request-level replay ordering therefore cannot be reconstructed from
  that event alone. The fix retains this identifier for future investigations.

## Corrections

Confirmed question replies and Skip now remove only the matching request from
its captured directory/session store. Failed or unconfirmed replies retain the
card. Both bootstrap and reconnect question snapshots preserve per-session
question arrays changed during the fetch, preventing an old pending snapshot
from resurrecting an answered question or overwriting a newer one. These failure
paths were reproduced in deterministic tests before applying the correction.

Writable Fixer and Designer tasks receive a renewable execution deadline. When
actual transcript progress occurs with ten minutes or less remaining, the
scheduler durably extends the deadline to fifteen minutes after that observation.
The first historical snapshot and unchanged busy status cannot renew it. Renewal
is fenced by the execution lease, active status, cancellation, timestamp bounds,
and successful persistence. Old timer callbacks wait for pending persistence so
both successful renewal and rollback preserve a valid cancellation decision.
Shutdown prevents a late persistence completion from re-arming a deadline timer.
No new streaming subscription or transcript fetch was added. Review, exploration,
Council, and read-only deadlines remain fixed. Silent-provider recovery and
resumable partial-result handling remain in force.

This removes the unnecessary fixed-hour cancellation of a progressing
implementation. Code inspection also found that direct and persistent Cursor
Agent cache identities omitted the SDK credential. A deterministic test reproduced
reuse of the original Agent after changing a fixture credential. Both paths now
include a process-local keyed credential identity, so a changed key resumes the
retained Agent with current credentials while unchanged keys retain cache reuse.
The real persistent worker is tested against a disposable SDK stub, including
verification that its output contains no fixture credentials. The incident
journal does not establish that credentials changed during the failed recovery;
this closes a separately reproduced recovery defect.

These corrections cannot make expired or rejected provider credentials valid;
a real authentication rejection still requires provider/account recovery or a
user-selected working model. No credentials were inspected or changed.

## Verification

Focused regression suites cover confirmed/unconfirmed replies, delayed complete
and partial snapshots, reconnect races, startup versus live progress, deadline
renewal and expiration, stale timestamps, fixed review deadlines, terminal
immutability, shutdown, successful/failed persistence racing a deadline, and
credential changes across direct and persistent Cursor execution.

- Workspace lint, type checks, documentation validation, production web/Electron
  build, bundle budgets, test-discovery/no-skip contracts, and `git diff --check`
  passed. The build emitted existing dependency annotation/eval warnings.
- The full Harness, orchestration, Cursor SDK, Electron, legacy Tauri, shared
  runtime, and Bot package suites passed. The changed question-action and
  bootstrap/reconnect regressions passed within the UI run.
- `validate:full` first caught a typing error in a new question test; this was
  corrected before the successful lint/type-check run. The subsequent script
  gate passed 596/597 cases: an unchanged evaluation-client case exceeded its
  200 ms deadline. Its whole file subsequently passed all 28 tests without
  changing the deadline or assertions.
- The broader UI run failed only its unchanged source-wide JSX label audit:
  scanning exceeded the five-second test limit (10.66 seconds; 11.32 seconds on
  a standalone rerun). The label assertions and timeout were not changed.
- Web Cursor event tests exposed an existing synchronization race in the tests:
  transcript completion could be observed before final events and idle status
  were published. Three tests now wait for authoritative idle status before
  asserting event ordering, deduplication, and completion; all 59 web Cursor
  tests passed on rerun, with the original assertions intact.
- The full web run completed with 4,077 passing and 14 failing tests across
  381 files (377 passing files). Two failures were the Cursor event races fixed
  above, whose complete 59-test file then passed. The remaining failures were
  eight unchanged Git rebase tests exceeding five seconds, three unchanged
  scoped-revert fixtures with 100 ms deadlines (upstream not reached or HTTP
  504 received instead of the expected result), and one unchanged preflight
  test exceeding five seconds. The host was under heavy load, but this run
  does not prove that load is the sole cause. No assertions or deadlines in
  these fixtures were relaxed. The full repository gate is not recorded as
  passing.

Local verification logs are retained under `.cache/subtask-reliability/`:
`validate-full.log`, `remaining-validation.log`, `evaluation-client-rerun.log`,
`control-copy-rerun.log`, `web-cursor-rerun.log`, and `build.log`.

The installed app was inspected and its stale renderer state cleared. Runtime
code changes are in this checkout and require an updated app build to become
active; the user's running provider tasks were left undisturbed.
