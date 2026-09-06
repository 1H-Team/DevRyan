# Fable 5.1 High review and coordinator decisions

The user requested an advisory second opinion before `/compact`, with the coordinator retaining final judgment. Fable 5.1 with High effort was confirmed in Claude. The exchange included the goal, implementation stage, a concrete diff map, measurements and their limits, outstanding acceptance, and a follow-up challenging its conclusions. The [technical brief](second-opinion-brief.md) preserves that context. No production changes, live-provider tests or performance runs were executed during this review.

## Accepted changes to the plan

| Finding | Coordinator decision |
|---|---|
| Performance evidence was unnecessarily deferred behind the full live matrix and the stopped interactive cohort. | Move independently admitted backend and idle/streaming resource measurements earlier, using fresh three-run comparisons and quiet blocks. Interleave baseline/candidate arms to limit temporal/thermal confounding. Keep interactive responsiveness as a separate requirement. |
| Homogeneous QA model pinning cannot reproduce Spark as a differently assigned Explorer. | Verify the incident's effective routing first, then provide explicit per-role assignments in the isolated QA profile for a focused differential test and real parent/result reconciliation. |
| Current manual scenarios are web-only. | Add meaningful manual Electron coverage within existing project journeys where practical, retaining two native boundaries and independent continuity evidence. Do not mechanically add another full matrix. |
| Natural Orchestrator coverage requires two child states simultaneously beyond the original plan. | Use an explicit two-phase witness policy and update all dependent graders, preserving task/dispatch lineage and exactly-once handling across the whole journey. |
| Historical model restoration lacks an explicit guard against a newer unsent choice. | Carry forward a precise reconnect/remote-hydration regression hypothesis and test it before changing code. Preserve restoration when the user has not made a newer selection. |

The QA findings were independently checked against the original approved plan and the current source. Manual coverage is missing on Electron, but the plan does not explicitly demand 12 additional standalone manual Electron cells. The current scenario-list expansion creates separate fresh runs rather than composing scenarios; any combined journey needs deliberate implementation and separate grades.

The natural correction must change readiness, native-start brackets, summary-exit checks, collection timing and final grading together. Simply deleting the simultaneous-state assertion would leave inconsistent semantics. Cover an active child at boundary one and the same declared pending-result witness around boundary two, then collect it. Preserve unique result envelopes, task/child/dispatch/attempt identities, exactly-once starts and dispositions, and no restarted investigations. An unavailable or automatically consumed witness remains failed/unobserved; it cannot be manufactured or withheld artificially.

## Hypotheses narrowed or claims rejected

- **Current configuration versus the incident:** on-disk base configuration is not evidence against the user's historical report. Effective overlays, presets and session selection must be recovered from runtime records. Fable corrected its earlier stronger wording.
- **One differential pair:** Spark/control outcomes localize possibilities; they do not prove model/adapter versus routing/ledger causality. Nondeterminism and shared task difficulty remain alternatives. Expand only when evidence makes the next comparison useful.
- **Restoration race:** an ordinary same-tab send already inserts optimistic text parts and captured effort under the client message ID. An identical later echo may be protected by the same restore key. The stronger hypothesis is a loaded remote/reconnected session whose newest user metadata lacks parts: the user selects Low, late parts reveal an unrestored historical High key, and the effect may overwrite Low. This is source-level plausibility, not a reproduced failure. The follow-up test must assert both the visible effort and next captured send, with a no-manual-change control that still restores High.
- **Pagination causality:** one passing candidate run and a failing baseline demonstrate those outcomes, not the exact mechanism or causal contribution of a particular change. Fable qualified its earlier attribution.
- **Performance evidence:** do not use old failed prefixes as the baseline of a new fresh comparison. Do not salvage an incomplete aggregate through automatic retries. If a common subset is useful, define it prospectively, run fresh matched samples and label its limited scope. Failed R5 remains stopped.
- **Evidence reuse:** neither “every code fix restarts every cell” nor “unchanged UI means all prior tests remain valid” is sufficient. Invalidation must cover actual dependencies, including backend admission/SSE behavior and harness semantics. Fable withdrew the categorical restart rule and identified server-only timing as a valid counterexample to overly narrow reuse.
- **Working-tree hygiene:** do not commit or stash the mixed shared tree to make it appear tidy. Refresh a dated local recovery snapshot while preserving attribution and existing edits.

## Next decision

After the user's continuation, begin the early independent measurement blocks on the frozen candidate, then address the focused Spark/restoration and compaction-harness items. Broad final acceptance follows validated representative operational journeys. Optimize concrete bottlenecks demonstrated by those measurements, and remeasure affected outcomes. The detailed order is in [resume-plan.md](resume-plan.md).

Full acceptance remains open. The latest candidate's startup and 148-action functional pass, existing full validation, and previously reviewed evidence remain valid within their stated scope; this review is not additional execution evidence.
