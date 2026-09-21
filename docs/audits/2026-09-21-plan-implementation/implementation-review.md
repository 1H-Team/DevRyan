# DevRyan implementation review

**Historical review verdict: repairs were required before release.**
The subsequently requested implementation is tracked in [repairs and verification](repairs.md). Passing implementation suites
did not cover several preparation, retention and cleanup races found in this
review. No product repair, commit, release or deployment was made during the
review. The existing implementation and concurrent work were preserved.

The deleted Claude planning conversation was reconstructed from the saved plan,
implementation report, incident evidence and working-tree changes. Review took
place through Claude Desktop in **DevRyan implementation review**, using
**Fable 5.1 / Extra**, with repeated challenges and focused reproductions in the
same replacement conversation over three review rounds. Scope remained bundles **1–8, 10, 11, 12 and 15**
plus the subtask-start timeout repair.

## Findings and repair order

IDs match the review conversation. “Demonstrated” means a disposable fixture
exercised the condition. “Trace” means the conclusion follows the code path;
it does not imply native, provider or remote acceptance testing.

| Priority | Finding | Evidence and consequence | Required repair |
| --- | --- | --- | --- |
| High | **F1: observation can repeat until the 15-minute cap** | Demonstrated with two files and a log appended every 5 ms. Preparation remained pending while writes continued and completed after the writer stopped. Repeated inspections keep reporting progress. | Bound both file-stamp/observation failures and concurrent ledger changes. Preserve both installation guards; return a typed retryable `workspace_changing` failure when a complete coherent base cannot be obtained. |
| High | **F2: healthy shared preparation can stall its waiting callers** | Demonstrated with 1,000 files and a scaled 8-second watchdog: the joining lease failed while the pass creator continued and completed. The normal watchdog is 60 seconds. | Share real progress with joiners and across copied admission contexts. Preserve each caller's cancellation and overall deadline, and retain a real stall watchdog. |
| Medium; high with deletion enabled | **F3: the displayed session can lose retention protection** | Demonstrated with the actual selection helper and server gate. A sticky requested ID discards later draft-promotion observations. A pending click can also overwrite newer draft navigation. | Clear only the matching completed request; recheck authoritative selection; fence all navigation with a monotonic epoch or synchronous invalidation. Preserve protection of both old and new sessions during acknowledgement. |
| High for the current Intel package; medium for other missing-artifact cases | **F9: a required artifact failure prevents server startup** | Missing-artifact rejection is demonstrated. An uncaught module-level await makes full server failure a code-trace conclusion. The inspected tarball has arm64 artifacts but the contract also lists Intel. No Intel run was performed. | Preserve a distinct required-but-unavailable capture state, block affected execution, and expose a repair diagnostic. Never silently fall back to uncaptured execution. Gate distribution support on the verified paired artifacts. |
| Medium | **F4: abandoned preparation leaks its private view and pin** | Demonstrated: cancelled lease, existing view/ref, no `cleaned` marker, and zero active leases. The startup scan cannot rediscover this terminal lease. | Make unfinished cleanup durably discoverable. After owned work settles, invoke the existing guarded cleanup and retain retry state on failure. |
| Medium | **F10: cleanup failure masks successful publication** | Demonstrated: a read-only directory causes `EACCES` after files are durably published. The host and owner await cleanup before returning the publication result. | Return the durable publication outcome even if cleanup fails; report and retry cleanup separately through durable pending work. |
| Medium | **F5: failed owner initialization remains cached** | Trace: a rejected promise is memoized, and shutdown can throw before draining other owners/runtime work. | Reset only the failed current attempt, preserve single-flight creation, and continue independent shutdown paths. Terminate and reap the failed keeper before allowing a replacement. Sending a kill signal alone is insufficient proof. |
| Medium | **F6a: one uncertain lease prevents unrelated recovery** | Trace: one per-project catch encloses all lease recovery. A missing termination receipt aborts the remaining loop. | Isolate failures per lease while retaining fail-closed retention readiness whenever uncertainty remains. |
| Medium | **F12: an owned SSH server with an older version cannot be stopped** | Trace: reuse rejects the version mismatch, while signed shutdown is also conditional on equal versions. The UI tells the user to stop the server. | Allow shutdown after verified ownership independently of version, await absence, then install/start. Real SSH acceptance remains required. |
| Low | **F7: a crash can leave a permanent snapshot pin** | Trace: the Git pin can be installed before its identity is durably associated with the lease. Cleanup checks the missing field. | Persist the deterministic ref identity before installation, or recover it safely; release must tolerate an absent ref. |
| Low | **F13: performance scripts use the old authentication cookie** | Trace: two authenticated samplers still construct the unscoped cookie name, so standalone instance authentication fails. | Use the actual instance cookie identity and update the scripts' documentation. Do not assume a proxy's public port equals the server's listening port. |
| Low | **Abort before spawn: a cancelled request can still launch a worker** | Trace identified in round 3: cancellation after claim, including while skill bytes are resolved, is not checked immediately before spawn. The signal is checked only afterward and the worker is then terminated. | Check the signal immediately before spawn and route the failure through `cancel-before-start`. Preserve owned settlement and native termination evidence. |

For F3, a newly promoted session is initially protected by its age and usually
the recent-five rule. The destructive case requires retention enabled, the age
threshold and recent-five protection to lapse, and no other blocker. Archive is
the default action; permanent deletion requires the delete policy.

### Source locations

Line numbers describe the reviewed working tree, not a committed release.

| Findings | Main locations |
| --- | --- |
| F1/F2 | `packages/harness-runtime/lib/session-mutations.js:229–286`; `packages/harness-runtime/lib/execution-admission.js:13,72,80–84` |
| F3 | `packages/ui/src/lib/retentionSelection.ts:8–27`; `packages/ui/src/sync/session-ui-store.ts:1859–1866,1979,2053,2118,2201`; `packages/ui/src/hooks/useSessionAutoCleanup.ts:128` |
| F4 | `packages/web/server/lib/opencode/execution-preparations.js:15–28`; `packages/harness-runtime/lib/session-mutations.js:974–980` |
| F5/F6a | `packages/web/server/lib/opencode/session-execution-host.js:40–41,241–264`; `packages/harness-runtime/lib/execution-host-owner.js:16–25` |
| F7 | `packages/harness-runtime/lib/session-mutations.js:468–471,667`; `packages/harness-runtime/lib/session-changes-store.js:171–175` |
| F9 | `packages/web/server/lib/opencode/execution-artifacts.js:21–47`; `packages/web/server/index.js:622`; companion `manifest.json` and packed runtime contents |
| F10 | `packages/harness-runtime/lib/session-mutations.js:653–673`; `packages/harness-runtime/lib/session-execution-owner.js:58–60`; `packages/web/server/lib/opencode/session-execution-host.js:228–231` |
| F12 | `packages/electron/ssh-managed-probe.mjs:64–75`; `packages/electron/ssh-manager.mjs:958–964` |
| F13 | `scripts/perf/multi-session-sampler.mjs:48,367`; `scripts/perf/session-pipeline-profile.mjs:41,621` |
| Abort before spawn | `packages/web/server/lib/opencode/companion/legacy-conversation-revert.patch:2150–2188,2274–2308` |

## Corrections reached through the review

- **Keep the observation guards.** The original suggestion to skip unstable
  rows was withdrawn: it could omit new paths or expose stale bytes. Two scratch
  alternatives also removed the required fresh file-stamp guard and were rejected
  as drop-in repairs. A later experiment preserves both guards and bounds retry
  causes. Its optional read-under-lock fallback still needs total-count/byte
  limits and concurrent-ledger-churn coverage before adoption.
- **Use genuine progress.** Fable's shared-meter experiment preserved joiner
  cancellation and overall timeout, completed healthy shared work, and detected
  a hung pass. These are experiments, not implemented corrections.
- **Selection equality is not a navigation fence.** A proposed repair still let
  an old click apply after draft A → draft B → draft A. An independently written
  counterexample failed that version. Fable's next experiment uses a monotonic
  navigation epoch and passes its nine focused cases. Integration with every
  store navigation path remains required.
- **Keep uncertain work protected.** A missing receipt, process ID, heartbeat or
  missing in-memory entry does not prove writer termination. Cleanup must retain
  its terminal-state, settled-consumer and termination-evidence checks.
- **F8 is an accepted availability limit.** An unresolved retention mutation
  stays protected until authoritative acknowledgement or runtime reconciliation.
  No failure to reconcile after the examined restart paths was established.
- **F11 is an availability tradeoff.** Session navigation currently waits for
  retention acknowledgement even when retention is disabled. Network failures
  can prevent switching. A generic client-side fail-open fallback is unsafe if
  the connected server still believes the previously selected session is current.
  Any relaxation needs an explicit fail-closed server protocol.
- **Do not overstate the original incident.** The retained journal contained
  177 records with zero gaps, two skill admissions and one task admission spending
  about 25 seconds mainly in reconciliation, and no observed child launch.
  Project size, root equality and concurrent fan-out were not established.

## Acceptance gaps and review limits

The approved frozen-worker-input requirement does not record a Cursor exemption.
The Cursor path reads session state before its owned start, but serializes the
payload afterward and has no 16 MiB preflight or final-size check
(`packages/cursor-sdk-runtime/index.js:2331–2389`). An uncapped reader avoids
truncation; it does not establish compliance with a pre-start payload bound.
This remains an acceptance/scope gap until the implementation or an explicitly
revised contract resolves it. Actual shared-mutable-input risk requires separate
call-site evidence: the session transcript is a fresh disk read and several inputs
are per-run locals, but whether the agent-definition producer can return a mutable
shared object was not established. There is no recorded Cursor exemption.

The last round checked selected-skill validation and cancellation directly in the
companion patch. Before tool execution, the worker verifies canonical source,
skill name and the digest of the mapped skill bytes. Begin, polls and claim carry
the abort signal; failure runs an independent bounded cancellation request, and a
cancel arriving before reservation leaves a durable cancellation fence. No defect
was found in those checks. The subsequent pre-spawn gap remains open. A cancelled
receipt prevents normal file publication; this review did not establish that all
possible tool side effects are impossible in the brief launch window.

Terminal serialization below an upward-moved cursor and alternate-screen restore
limitations predate the change. The serializer has no production caller; product
restoration uses server replay. Its fixture results do not establish complete
production terminal restoration. The vendored core was not reviewed line by line.

Other residuals include cold observation cost, full-tree reconciliation during
Revert under the project lock, coarse filesystem timestamps, and external writers
racing an editor version check/rename. Git index queues use the canonical requested
directory; serialization between root and subdirectory aliases was not established.
Existing platform gates remain: Intel,
signed installation/update, real remote SSH, live providers, mobile and screen
readers. No unavailable check is treated as passing.

| Area | Review depth and result |
| --- | --- |
| Execution, storage, host ownership and retention | Detailed code review and focused reproductions; findings above require repairs. |
| Companion skills and cancellation | Final-round code review covered source/name/digest validation, begin/poll/claim abort propagation, and cancel-before-start ordering. Pre-spawn cancellation gap remains. |
| Cursor and Revert/Redo | Partial-outcome handling and activity ownership reviewed. Cursor payload enforcement remains an acceptance gap; no new partial-publication defect was demonstrated. |
| Git bundles 1/2 | Code review; no additional demonstrated defect. Root/subdirectory queue identity remains a residual. |
| Demand loading 3, quota 4, editor 5 | Code review; no new demonstrated defect. Provider behavior uses existing fixtures, not live accounts. |
| Replay 7, authentication 8 and lazy imports 12 | Code review; replay and lazy imports had no demonstrated defect. Authentication consumer and artifact-startup findings remain. |
| Electron 10 | Probe, identity, manager, updater cleanup and bundled script reviewed. SSH mismatch finding is by trace; native update/remote acceptance remains outstanding. |
| Sidebar 11 | Limited code review; interaction evidence rests on the existing browser fixture. |
| Terminal 15 | Integration, transport and serializer reviewed; prior WASM/browser evidence inspected. No new demonstrated defect; core and platform limits above remain. |

## Verification from this review

Reproductions use disposable local fixtures. No live provider or installed-app
state was used. Product code was unchanged; the tracked diff statistics matched
the review-start snapshot before these documentation edits.

| Evidence | Result |
| --- | --- |
| Independent poller-loss rerun | One passing defect demonstration: cancelled, view/ref retained, zero active leases. |
| Independent selection rerun | Eight passing cases and two expected failures on the current helper; failures demonstrate the missing protection and stale navigation. |
| Independent proposed-repair counterexample | One expected failure in proposed helper v2; draft round-trip defeats origin-key equality. |
| Independent missing-artifact rerun | Three checks passed; helper rejection and source/manifest conditions verified. Packed runtime listing independently checked. |
| Independent cleanup/publication rerun | One passing defect demonstration: publication durable, cleanup `EACCES`, lease still published and uncleaned. |
| Fable repair experiments | Guarded observation: eight comparison cases; shared progress: two scenario groups; selection v3: nine focused cases. Scratch copies only. |
| Documentation validation | `bun run docs:validate` passed; existing warnings about generated or missing references elsewhere remain. |

The full implementation checks remain recorded in [the implementation report](README.md).
They were not repeated for this read-only audit and do not supersede these findings.
Future product repairs require focused regressions, applicable full validation,
and the native/build/browser checks relevant to their changed contracts.

The reconstructed handoff, raw review rounds, scratch experiments and command
logs are preserved locally under `.cache/agent-handoffs/fable-review/` and
`.cache/agent-handoffs/2026-09-21-fable-implementation-review.md`. Those local
artifacts are supporting evidence; this report is the durable review summary.
Round 3 supersedes unsafe or overstated remedy suggestions in earlier raw rounds.
