# Session navigation stall investigation

## Acceptance status

The navigation correctness changes do not establish that the installed-runtime
stall is fixed. Root-cause attribution and before/after reproduction remain a
separate diagnostic gate. No timeout reduction or client-side retention shortcut
is used.

## Existing incident evidence

- Installed 1.2.19 runtime-service PID 39371 logged event-loop maxima of 59,056 ms
  at 2026-09-29 12:40:56 +0400 and 24,579 ms at 13:02:52 +0400. The foreground
  process did not show comparable pauses.
- Those samples had `pressure: false`, heap use approximately 231 MB and 167 MB,
  and a 4 GB heap limit. `active`, `queued` and response counters describe
  **session-change reads**, not all HTTP traffic.
- A five-second native process sample at 13:03:12 did not identify the responsible
  JavaScript function. Six open Chromium HTTP connections are evidence to examine,
  not proof that socket contention caused either event-loop delay.
- The diagnostic journal gap check was clear. The client timeout had no Error Log
  UUID, and the journal did not contain its missing browser timing.
- During candidate validation, this 16 GB machine had approximately 20 GB of swap
  in use. This is a current confounder, not attribution of the earlier incident.

## Implemented contract

`setCurrentSession(id, directoryHint, options?)` accepts optional `onApplied` and
`expectedNavigationRevision`. Explicit navigation supersedes previous intent;
create, fork, restore and rollback capture a revision before asynchronous work.
Deletion/archive invalidation targets the invalid session without cancelling an
unrelated pending selection. Data restoration is independent of navigation.

Non-null navigation stages protection before application. Null applies immediately.
A newer selection cancels obsolete client requests without queuing behind a commit.
Each stage precedes its own commit; the server rejects older revisions. Staging
unions protected IDs, while commit replaces them. Failed/superseded requests never
become reusable acknowledgements. Matching observers join an operation or reuse its
acknowledgement; reconnect invalidates reuse and restages pending intent.

Cleanup awaits a confirmed commit and checks navigation again before dispatch.
Supersession returns `selection_superseded`; failed protection cannot start cleanup.
The existing server holds remain authoritative. Requests retain their individual
15-second timeout. Settings, recency and the newest-five rule do not bypass protection.

Sidebar project/mobile callbacks, fork composer restoration and other dependent
side effects run only after application. The central selection action owns directory
and OpenCode client routing. Pending rows remain interactive, errors distinguish
server supersession, cleanup conflicts, authentication and timeout, and Retry is
explicit user intent. New text uses i18n; protection and commit outcomes extend
`session.load.*` metrics.

## Reproduction and evidence

Run the isolated fixture with `DEVRYAN_QA_SCENARIO=navigation bun run qa`; add
`DEVRYAN_QA_RUNTIME=electron` after staging the candidate web assets for Electron.
The navigation scenario uses a disposable data directory, home, profile and Git
workspace. It captures a host CPU profile, independent health timings, timestamped
clicks, Chromium request initiators/phases, and event-loop delay while switching
real sidebar rows during four concurrent streams, cold history reads and one minute of repeated switches.

`selection-timing.js` records initial Express ingress, completion of authentication,
arrival after middleware, time around `gate.select`, and response finish/close.
Only opaque correlation IDs, numeric revisions, status, phases and durations are
logged. Request bodies, credentials, session IDs and conversation content are omitted.
Use `navigation-timings.json` and `selection-server-timings.json` together; CPU
profiles and screenshots are saved under the run's `.cache/qa` directory.

A passing disposable workload proves that workload's navigation behavior. It cannot
by itself identify the original stall or substitute for a reproduced root-cause
correction. The measured candidate runs are recorded below.


## Caller audit

- Explicit selection: sidebar (including keyboard through its action), router,
  application open-session event, completion toast, command palette, mobile status,
  message/task links, managed task rows/list, parent-session button, creation-status
  button, agent-group selection and Retry use the central selection API.
- Deferred completion: session creation/fork, assistant-message creation, draft
  promotion, worktree creation, project-note magic prompt and multi-run completion
  carry the revision captured before asynchronous work. Initial embedded/mini-chat
  and agent-group restoration do the same. Draft target preparation updates its
  owned persisted draft even when its visible application is superseded.
- Delete/archive rollback restores data independently and guards only navigation.
  Authoritative deletion events and sidebar archive use target-specific invalidation.
- Multi-run creation accepts an explicit project ID without changing the displayed
  project. Session creation and prompts use explicit directory routing, avoiding
  the shared client's temporary `withDirectory` mutation during background work.

## Measured candidate runs

| Measure | Web fixture | Electron fixture |
| --- | --- | --- |
| Artifact directory | `.cache/qa/web-navigation-qfogXo` | `.cache/qa/electron-navigation-bAFED9` |
| Applied sidebar switches | 50/50 | 50/50 |
| Click to observed application | 74–430 ms | 70–349 ms |
| Selection requests | 100 (stage + commit) | 100 (stage + commit) |
| Maximum Chromium pre-send phase | 1.206 ms | 1.916 ms |
| Maximum response waiting phase | 15.804 ms | 5.552 ms |
| Maximum ingress-to-finish duration | 14.246 ms | 2.814 ms |
| Maximum `gate.select` duration | 0.439 ms | 0.166 ms |
| Independent health response | 0.82–62.26 ms | 0.95–18.12 ms |
| Maximum profiled host event-loop delay | 88.48 ms | 65.38 ms |

The Electron screenshot confirms the selected child transcript and composer loaded;
its fixture additionally waits for the target's message DOM. The default native fixture
runs the web server inside the isolated Electron main process. The additional
runtime-service run below separates the background server and foreground client. Raw CDP phases
are retained; the pre-send measurement is not a claim to have separately measured
every DevTools Queueing/Stalled subphase.

The Electron CPU profile covered 60.9 seconds, including approximately 54.2 seconds
idle and 2.65 seconds in native `spawn`, with Git-backed session-change operations
in its stacks. Its `[runtime-memory]` sample at 14:19:37 +0400 reported 707 ms
maximum delay across a broader interval that included startup, `pressure: false`,
heap use 73.6 MB, and session-change-read counters `active: 1`, `queued: 0`.
The narrower click/profile window above had no comparable long delay.
These short subprocess costs do not attribute the historical 24–59 second stalls.
Selection route timing and health stayed responsive during this workload. No
historical JavaScript CPU profile exists for the reported long pauses, and this
fixture did not reproduce them. A root-cause correction and its before/after
verification therefore remain **unresolved**, not passed. The journal gap check
was clear again after the isolated runs.


One preliminary sustained Electron run failed before its first click because its
parent row was collapsed during startup reconciliation. The fixture now reveals
the requested child through the accessible expansion control before timing the
click. The failure's health and CPU evidence showed no selection stall; it is
retained in `.cache/qa/electron-navigation-UgEEEM`. Earlier short web/Electron
runs passed five switches each. The user confirmed several sessions/agents were
active during the original incident; the sustained fixture covers four streaming
sessions but does not run live model providers or the user's original tool workload.


### Background runtime-service reproduction

`DEVRYAN_QA_RUNTIME_SERVICE=1 DEVRYAN_QA_RUNTIME=electron DEVRYAN_QA_SCENARIO=navigation bun run qa`
starts an owned background service and a real foreground Electron client against the
same disposable data root. The foreground performs the normal authenticated service
bootstrap. The fixture does not register a persistent OS service or restart the
installed runtime. The JavaScript profiler targets the background process.

`.cache/qa/electron-navigation-OU8qDi` passed **55/55** switches over 65 seconds
with four concurrent streams: 85–476 ms to observed application, 110 selection
requests, maximum pre-send 22.815 ms, response waiting 14.225 ms, server handling
13.977 ms, `gate.select` 0.024 ms, and independent health 10.214 ms. The profiled
background event-loop maximum was 58.491 ms. Its CPU profile sampled 59.7 seconds
idle and 1.73 seconds in native `spawn`.

The broader runtime log window at 14:33:08 +0400 recorded 337 ms maximum delay in
the background process and 90 ms in the foreground at 14:33:09. Background heap
use was 93.8 MB, `pressure: false`, and session-change-read counters were `active: 1`,
`queued: 0`, peak response bytes 474,056. Journal gaps and owned-process cleanup
were clear. This matches the incident's process roles but still did not reproduce
its 24–59 second pauses. No root-cause correction can be claimed from these results.

Two setup-only service attempts are retained: `electron-navigation-G0cZpV` exposed
the need to pin the disposable desktop port; `electron-navigation-DJueyk` correctly
rejected the unauthenticated generic browser shell. The final fixture uses the
real foreground client's bootstrap instead of bypassing service authentication.

## Verification outcome

- `DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full`: **passed, exit 0**.
  Workspace lint/type checks, docs and all deterministic package suites completed;
  the UI batch passed 3,976 tests (plus isolated UI suites), and the web backend
  passed 4,665 tests across 421 files. Assertions and suite coverage were retained.
- `bun run build`: **passed**. Final UI staging with
  `bun run --cwd packages/electron build:web-assets` also passed. Dependencies
  emitted bundler annotation/eval warnings; these did not fail the build.
- Final UI type check, targeted caller lint, QA-run contract test, docs validation
  and `git diff --check`: **passed**. Docs validation retains warnings about missing
  files referenced in older planning documents.
- Regression coverage includes the real activity gate with out-of-order delivery,
  stalled commits, rapid/same-current/null navigation, observer reuse/reconnect,
  failed/superseded directory and project preservation, delayed creation/fork/draft
  completion, mutation rollback, timeout/retry, code-based errors and confirmed
  cleanup. The instrumentation test preserves authentication-error forwarding.
- Isolated web, app-bound Electron and background-service Electron: **155/155**
  timed switches passed in total. Each used one stage/commit pair per click.
  All owned QA processes shut down cleanly; no installed runtime was restarted.
- Earlier validation attempts exposed test-fixture typing mistakes (corrected) and
  a transient `ENOTEMPTY` in script-fixture cleanup. Its focused recheck and the
  final full run passed. No production credentials or live model providers were
  used for deterministic or isolated verification.

The navigation correctness work and diagnostic instrumentation are implemented.
The overall incident is **not verified fixed**: a responsible function for the
historical stall, a reproduced underlying failure, and a demonstrated root-cause
correction remain outstanding. The instrumented runtime-service fixture is ready
for the original failing tool/provider workload when that workload can be reproduced.
