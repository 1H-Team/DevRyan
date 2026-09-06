# DevRyan cleanup, performance and QA — 2026-09-05

Current candidate `YJDmZ4` / UI `OVdoR6` passes settled-source full lint/type/test validation, builds, packaging/native smoke and unchanged web bundle limits. Direct mobile coverage passes all nine checks with 91 reviewed images. Six fresh typing runs show no clear change; session-memory and remaining interaction timings are unverified after repeated pagination failures. The manual native regression is verified by independent review; the natural objective stopped after repeated QA failures with its second boundary unverified. OpenAI core coverage closes at 12 verified settings, one failed and three unrun after the repeated Plan-card visibility failure. Full acceptance is not achieved; Anthropic/xAI access is blocked. [Current acceptance](coding-agents-acceptance.md), [complete coverage map](coding-agents-coverage.json), [performance](performance.md) and [memory decision](memory-decision.md) record the final disposition.

## Historical checkpoints

Everything below preserves earlier candidate results and the work status at those checkpoints. Current outcomes above and in the linked acceptance report supersede earlier pending work, failed bundle budgets and unavailable typing measurements.

The [macro review](macro-review.md) maps delivered work and remaining acceptance to the approved goals and records the correction toward current-candidate verification.

The latest [resume plan](resume-plan.md) records the user's one-model-per-provider scope, the added Spark Explorer investigation, and the order of work after `/compact`.

The [Fable second opinion and coordinator decisions](second-opinion-review.md) move performance measurements earlier and identify specific QA coverage corrections and a restoration-race hypothesis to verify.

Implemented a focused cleanup/performance batch and reusable web/Electron QA tooling. **The complete audit plan is not yet accepted:** final live-provider scenarios and operational compaction remain open. The current application source passes the quiet full validation gate; applicable packaged native checks and deterministic fixture visual review are complete, with original failed attempts retained. Later QA-only corrections receive separate scoped qualification. VS Code runtime acceptance is excluded at the user's request.

The focused Spark Explorer correction is verified by a passing Spark/Sol control pair. Fresh current-graph backend measurements reduce median cold discovery by 12.19% and median per-arm maximum health delay from about 3,386 to 3 ms. Current one-stream CPU and four-stream memory limits pass; four-stream CPU changes +1.64% and GPU −1.62%, missing their reduction targets. Typing and memory-after-session-closure comparisons remain unavailable. The earlier manual project representative failed at its unobserved first native compaction boundary; its other 95 configured scenarios remain unrun. Fresh manual and natural representatives must complete before broad execution. [Current acceptance and qualifications](coding-agents-acceptance.md), [measured values](performance.md).

The tables below preserve the initial cleanup batch's results. The subsequent expanded work, newer candidate identities, corrected bundle result and fresh validation are tracked in [Coding Agents acceptance](coding-agents-acceptance.md); its final live matrices and compaction/performance checks remain in progress.

The selected production changes remove repeated reducer history scans, replace a pass-through selector export and shallow tests with real store subscription coverage, reduce title-case test memory, and correct mobile drawer offsets during viewport changes. Repository instructions and module maps now match these changes. The evaluation graph test also has enough scheduling headroom to test graph behavior without accidentally asserting a 100 ms machine-speed requirement; the dedicated hung-cleanup deadline test remains intact.

- **Reducer measurement:** 2,000-message histories improved from 23.76 to 7.00 µs/delta (one session) and 30.79 to 7.41 µs/snapshot (four sessions). Three fresh runs per variant; ranges separate. These are reducer costs, not app latency. [All scenarios and variability](performance.md), [reviewed measurements](measurements.json).
- **Test memory:** title-case audit peak RSS median fell from 408.61 to 213.03 MiB (−47.9%). Isolated elapsed times regressed under the measured load; no speed claim. The full-suite title-case scan subsequently passed in 468 ms.
- **Test cleanup:** removed one trivial export and replaced two implementation-level tests with one real Zustand subscription test. A deliberate notification fault fails the replacement. Policy, packaging, native, security and regression tests were retained.
- **Debugging/QA:** `bun run qa` selects an isolated web/Electron fixture journey, records sanitized evidence, preserves the journal, prints inspection details, and cleans up owned processes. Responsive captures and an explicit real-provider HTTP smoke reuse installed tooling. [Commands and limits](../../QA.md).

## Validation

| Check | Result / evidence |
|---|---|
| Baseline | Initial clean HEAD `ff7abd116ca37db53a56981d7de76100f2a97690`. Baseline full validation took 3m56.81s and failed in two web tests: diagnostic export HTTP status and OpenCode version allowlist. The diagnostic test passed in isolation. Concurrent version/SDK work began during the audit, so later builds cannot be attributed solely to this batch. |
| Focused reducer/selectors | 78 passed; deliberate subscription fault failed as intended, then was restored. |
| QA/process/CDP/fixture and evaluation client | 36 focused Node tests passed before the final fixture refinements; all nine final QA/fixture contracts passed after those refinements. Owned-process test verifies a second child remains alive when the first is stopped. |
| Affected validation | Lint/type checks passed; first expanded run stopped on title-case audit timeout. Memory retention was reduced without removing the policy checks. |
| `bun run validate:full` | Final rerun **passed**, including all workspace suites, lint and type checking (3,436 UI and 3,560 web tests). First final attempt hit the evaluation graph test's accidental 100 ms deadline; focused rerun passed, then graph scheduling headroom was corrected. Final log: `.cache/audit/devryan-2026-09-05/final-validation-recheck.log`. |
| Builds | `bun run build` passed (90.59s); web rebuilt after the mobile change; Electron web assets rebuilt successfully from the updated UI. Existing large-chunk, `import.meta`/CJS and ONNX eval warnings remain. |
| `bun run bundle:check` | **Failed**, limits unchanged. Web startup raw 5,048,720 > 4,962,877; gzip 1,481,202 > 1,456,388. The gate also reports the existing VS Code graph overage; no VS Code runtime optimization was attempted. |
| Electron/web/mobile fixture | **Passed implemented journeys**: selection, four-session streaming, draft preservation, submit, cancel, reconnect/reload, exact completed text and no duplicate user rows. Six responsive theme/viewport states and touch drawer toggles passed. All ten final PNGs inspected; [visual review and limitations](visual-review.md), [reviewed check timings](acceptance.json). |
| Real-provider HTTP smoke | **Passed** on the configured loopback host (observed OpenCode 1.18.27): completed reply, second streamed reply, reconnect, abort-to-idle, two distinct user messages, zero diagnostic gaps, and clean owned-session/logout cleanup. First reply 6.84s; second stream observed in 1.76s; 37 deltas observed. This host is not the candidate build and this is not live UI acceptance. `.cache/qa/live-DNN3Of/result.json`. |
| Native packaging/device | No native production code changed. Packaged pointer/updater/quit acceptance and physical-device keyboard behavior remain unverified. |

The complete package/category disposition and remaining work are in [findings.md](findings.md). The [inventory](inventory.json) covers all 15 workspaces; review was representative and codemap-led, not exhaustive line-by-line inspection. Use the [reusable checklist](../reusable-cleanup-checklist.md) for the next repository.

All bulky logs, screenshots, journals and traces remain in ignored `.cache/`. Reviewed measurement aggregates and visual acceptance notes live here. No release was published or production configuration changed. Concurrent SDK/version/provider-recovery edits belong to another task and were preserved.
