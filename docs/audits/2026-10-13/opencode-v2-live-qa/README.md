# OpenCode 2 live agent QA: findings and implementation plan

Implementation progress and independently reviewed checks: [implementation.md](implementation.md).

Date: 13 October 2026, Asia/Dubai. Observed run: 22:32–22:47 local time (18:32–18:47 UTC).

**Outcome: the plan failed before completion.** Both Explorer tasks eventually completed; the parent retained a partial implementation plan, lost its provider stream, and its next native step was refused. Implementation and its visual QA did not happen. This document proposes changes; it does not claim they are implemented or verified.

**14 October correction and supersession:** Codex and Claude completed a
source-backed consensus review. The accepted implementation is recorded in the
current task and supersedes the preliminary work packages below. In particular,
the timestamps formerly labeled model completion were host terminal metadata
queued **after** receipt draining. The first-receipt-to-task lower bounds are
104.055s (mobile) and 55.707s (dark); raw SDK/model completion was not retained.
The 1.08M input figure is cumulative SDK usage, not active context. Claude's
1,484-record sample found 1,480 records changed only in device identity, supporting
device-only cross-ledger stamp invalidation; a reboot as its cause is inference.
The implementation keeps full stamps. Native stream continuation is the
source-supported missing proof kind; it must be certified by integrated fixtures.

Evidence: [sanitized observation record](evidence.json). Source inspected: DevRyan `2.0.12`, revision `8dd32145509b08134c3a47248dd365cc6d84119e`, with pre-existing user changes. Running native bundle reported OpenCode `2.0.26`; Cursor SDK is pinned to `1.0.28`. Source and installed bundle are distinct evidence. Computer-use accessibility and screenshots were sampled during the run; this directory does not contain a continuous video or archived screenshot pixels.

## Scope and boundaries

Improve agent orchestration, OpenCode 2 compatibility, context delivery, performance, and release publication. Reuse the existing embedded native runtime, managed scheduler, result storage, journal, QA profiles, and release verification. Work belongs in shared UI, web/native owners, and Electron. Preserve compatibility identities, confinement, authorization, durable evidence, protected Revert/Redo, exact release allowlists, and existing signing checks.

No bot features, new dependencies, editor extensions, Tauri feature work, upstream merge/rebase, second runtime service, or speculative new memory framework are proposed. Release dependency receipts remain subject to current verification; their existence does not expand this task into bot development.

No harness source, configuration, provider account, runtime selection, or running user session was changed by this observer. No test prompts or aborts were sent. Only this plan and sanitized evidence were written. The user ended visual QA after the planning failures.

## What the run established

| Observation | Evidence and implication |
| --- | --- |
| Slow Cursor launch | Workers spawned about 54.4 seconds after preparation began. Preparation took 39.873/39.732 seconds; reconciliation 28.394/31.679 seconds; view materialization 9.919/6.458 seconds. These are overlapping/nested spans, not additive durations. Much of the delay preceded Grok inference. |
| Unchanged-file work | One reconciliation re-stamped 12,737 files with equal content, with 14 slow ledger commits and 13 slow transactions. Claude's cross-ledger sample found 1,480 of 1,484 records differed only in device identity. Preserve full admission stamps; use advisory refresh and batching. |
| Late task completion | First receipt to task terminal is a process-settlement tail lower bound: 104.055s mobile / 55.707s dark. Terminal metadata to task is only 28.983s / 7.275s. Mobile terminal persistence waited 22.068s in its queue. Raw model completion was not recorded; final text alone cannot authorize completion. |
| Receipt/event volume | 167 exact-tool receipt captures and 167 `session.changes.updated` events across two children. Changes events expose only session identity. Fixed 1.2-second receipt cost, global serialization, and every event being a no-op were **not** independently established. |
| Repeated result delivery | Seven `wait/read_result/continue` calls returned about 140,729 raw characters for roughly 32,803 characters of final child text. Control receipts replayed report text and canonical metadata. This is a model-facing contract issue. |
| Large context and consumption | Parent UI rose from roughly 17K initial reported tokens to approximately 101K active input, 37.1% of usable capacity. Verification reads contributed too. Dark Explorer reported 1,081,950 cumulative input and 980,352 cache-read tokens; mobile 475,671 input and 343,936 cache-read. These are not current occupancy, verified monetary cost, or interchangeable counters. |
| Extensive exploration | Mobile made 58 read/search calls; dark-mode 107, with about 160K/245K tool-output characters. Sanitized inputs omit search patterns/ranges, so identical paths do not prove duplicate queries. Evaluate useful evidence and coverage before imposing budgets. |
| Stored report corruption | Authoritative native message API already contained missing path separators, hyphens, Markdown markers, and fused text. It is not merely a Markdown renderer defect. |
| Reproducible dedupe defect | An isolated check of the actual helper in all three Cursor execution paths kept only one of two legitimate `/` fragments when each arrived through callback and stream. Content-only cross-channel deduplication can drop repeated fragments. Raw live SDK chunks were not retained, so this does not prove the cause of every damaged character in this run. |
| Final parent failure | At 18:46:29 UTC, a 5,083-character partial plan failed with `provider.transport`, HTTP 200, and “Connection lost while reading the response.” It ended mid-sentence. Retry at 18:46:32 was refused at 18:46:37 with `native_primary_step_unavailable`. Idle afterward was failure settlement, not success. |
| Recovery mismatch | Native recovery reported unsupported; both children logged `native_todo_continuation_failed/recovery_observation_unavailable`. The exact lower-level cause of the retry refusal remains unproven. |
| Journal coverage | Final queue 0, gaps 0, last error null; documented gap check found none. No runtime process exit/restart was journaled after 18:41. Administrator Error Log lookup returned 404; multi-user was disabled and no UUID accompanied the final error. |
| Resources | Spot samples showed main-process CPU 103.7% during setup, later 5.1%; renderer later 19%. One descendant-tree sample totaled 770.8 MiB RSS and 51.2% CPU. Shared pages may be double-counted. These samples do not prove a leak or sustained CPU bottleneck. |

The apparent duplicate child user text in historical journal projections resolved to **one** authoritative persisted user text part. It is not a duplicate-prompt finding.

The supplied Claude notes helped identify receipt churn and pagination overhead. This plan uses independently confirmed counts and timings, and retains their stronger unverified assertions as questions rather than facts.

## Priority order and deliverables

1. **P0: failed plan, retry, and approval consistency.** Preserve partial text, expose the true terminal outcome, prevent implementation of incomplete plans, and repair retry ownership using native evidence.
2. **P1: exact Cursor output.** Remove lossy content-based stream deduplication across every supported worker path.
3. **P1: settlement and preparation latency.** Reduce unchanged work and persistence backlog without releasing authority early.
4. **P1: compact result transport and context continuity.** Deliver required detail once and return lean disposition receipts.
5. **P1: release publication and retry integrity.** Bind source, version, assets, and promotion to one owner.
6. **P2: pinned V2 contract coverage, hot-path performance, and prompt calibration.** Use upstream findings as targeted acceptance cases and measure before adding optimizations.

The release work can proceed independently after its source is frozen. Text integrity precedes compact-report rollout because compact headers parse exact status/routing markers. Capture the baseline before changing performance behavior. A release candidate needs all applicable correctness and qualification gates before promotion.

## Work package A: partial-plan and retry correctness

Owners: native primary/admission/recovery modules, V2 projections, shared chat state and plan cards.

Relevant code:
- [primary step handoff](../../../../packages/web/server/lib/opencode/runtime-host/primary-step.ts)
- [primary step owner](../../../../packages/web/server/lib/opencode/runtime-host/primary-step-owner.js)
- [native admission owner](../../../../packages/web/server/lib/opencode/runtime-host/native-admission-owner.js)
- [provider recovery policy](../../../../packages/harness-runtime/lib/provider-recovery-policy.js)
- [V2 errors](../../../../packages/web/server/lib/opencode/v2/projection/errors.js)
- [session failure classification](../../../../packages/ui/src/sync/session-failure.ts)
- [plan action and persistence gates](../../../../packages/ui/src/components/chat/message/parts/planCardReveal.ts)

Implementation:
- Reproduce the exact sequence with a synthetic provider: accepted Plan input, partial plan text, stream failure after HTTP 200, native retry, refused step. Preserve original cause and retry refusal as separate facts.
- Trace the accepted objective/user/assistant, native durable sequence, attempt, permit, generation, cancellation fence, and primary state at retry. The generic catch in `primary-step.ts` hides the lower-level rejection; add bounded code/phase correlation through existing diagnostics, without logging tokens, credentials, prompt content, or permit handles.
- Test two source-supported hypotheses separately: failure reconciliation moved the primary objective to terminal `needs_attention` before native retry (`provider_recovery_fenced`), or retry reused a requested step without the required ownership reconciliation (`provider_retry_requires_reconciliation`). Bridge failure and canonical parent/model identity mismatch remain alternatives; the generic error cannot select among them. See [recovery owner](../../../../packages/harness-runtime/lib/provider-recovery.js).
- Classify native transport errors through their preserved `v2Type`; HTTP 200 means a stream opened, and `UnknownError` alone does not identify the cause. Keep caller abort separate from provider transport loss.
- Admit retry only through the existing accepted-operation and ownership proof. Settle the failed attempt before a successor acquires authority; never reuse stale permits or ambiguously resend the original prompt.
- Respect generation-specific recovery capabilities. Unsupported recovery must produce an actionable terminal outcome instead of an ineffective continuation or retry loop. Keep native retry, host recovery, and todo continuation distinct.
- Retain incomplete plan text as interrupted/failed, with its version and source message. Implement Plan must remain disabled in UI **and** rejected by server/core admission until a complete successful current plan exists.
- Reconcile final message, plan revision, queued input, root/descendant activity, and primary recovery states on terminal failure/reload. Make fresh authorized retry or a new message available after safe settlement; retain a specific reason while cleanup is unresolved.
- Preserve existing successful approval and interrupted-cleanup behavior. The current plan helpers already support unsuccessful generation and unsettled revisions; repair their callers/state if those predicates do not reach the card.
- Review every caller of [canonical plan context](../../../../packages/web/server/lib/opencode/harness-task-context.js): that identity helper alone establishes ownership/assistant role, not successful completion. Establish where initial plan acceptance and implementation admission prove the successful current revision; close a missing core check if found, while preserving authorized later saved-plan edits. This is a boundary review requirement, not a demonstrated approval bypass in the run.

Tests:
- Extend primary-step owner/native hold, retry/fallback, V2 projection/admission, actionable-plan and PlanCard suites.
- Cases: partial transport loss; failure before text; successful retry; stale-step refusal; expired authority; model/effort switch; user Stop during retry; reload before/after failure; competing queued input; failed sibling in a plan revision; stale older plan approval.
- Assertions: partial text persists exactly, no duplicate original input, no tool execution after refusal, one authoritative terminal outcome, no successful plan saved or approved, first cause remains visible, no indefinite “Composing” after terminal settlement.
- Use the integrated compiled native fixture; unit tests cannot establish host/native retry parity.

## Work package B: Cursor transcript integrity

Owners: `packages/cursor-sdk-runtime`, native Cursor ingress/persistence, managed report projection.

The same content-only cross-source helper exists in [runtime](../../../../packages/cursor-sdk-runtime/index.js), [one-shot worker](../../../../packages/cursor-sdk-runtime/node-worker.mjs), and [persistent worker](../../../../packages/cursor-sdk-runtime/persistent-worker.mjs). It remembers text fingerprints across channels rather than consuming a matched occurrence. A prior stream occurrence can therefore suppress a later legitimate callback occurrence with the same characters.

Implementation:
- Confirm the pinned SDK callback/stream guarantees using fixtures and the installed package contract. Prefer one authoritative channel if it provides complete output; otherwise match occurrences with identity/order, not an arbitrary recent text window.
- Fix all three execution paths together. Share only the small stream-normalization contract actually needed; avoid another general event framework.
- Preserve exact text bytes through streaming and terminal reconciliation. Do not insert guessed spaces or Markdown repairs to mask loss.
- Use the complete final result as an authoritative replacement when its SDK contract establishes completeness. Preserve tool/result ordering and explicit partial failure behavior.
- Verify exact `**Status:**` and optional routing markers before compact-header parsing. Invalid/missing markers must keep the safe detail fallback.

Tests:
- Extend existing worker/runtime/streaming suites with repeated `/`, `-`, `*`, backticks, whitespace, identical words, Unicode split boundaries, cumulative snapshots, channel reordering, duplicates, and final-only text.
- Sentinel: `<fixture>/ui/foo-bar.ts`, `/api/session/id/message`, a fenced code block, and an exact final `**Status:** complete` line.
- Compare synthetic source text → worker output → SDK transcript → native saved text → managed preview/detail → parent tool content byte-for-byte. Renderer parsing is a separate visual check.
- Exercise one-shot and persistent workers, cold and cached agents, read-only and writable tasks, abort/partial error and restart.
- Retain a sanitized small reproduction showing two legitimate fragments are preserved; remove reliance on lossy final-text heuristics only after full contract coverage.

## Work package C: admission and terminal settlement performance

Owners: harness mutation/execution ledger, native Cursor owner, SDK persistence queue, resource benchmark scripts.

Implementation:
- Attribute existing `cursor_persistence` phases and ledger timings to each critical-path wait. Distinguish queue wait, owned process receipts, record publication, local save, and cleanup. Do not sum nested spans or label this model inference time.
- Investigate why unchanged trees acquired new stamps. Reuse the existing tree-identity cache, bounded restamp batching, advisory ancestor memo, and coalesced reconciliation pass where the same fresh proof applies.
- Ensure simultaneous read-only children can share a sufficiently fresh preparation observation under current admission/cancellation contracts. Current source already has a joinable-pass mechanism; establish whether it applied to this cohort before adding caching.
- Keep symlink, content, owner, scope, revision, Git-reference, native termination, rollback, and publication checks. An age-only cache cannot substitute for a fresh mutation proof.
- Inspect read-only exact-tool receipt handling: retain required evidence for every call, but avoid full-file-history reconstruction or semantically unchanged notifications when no mutation occurred. Confirm no-change from authoritative revision/digest, not from the model naming a tool “read.”
- Keep essential durable receipt ordering; move only independent event/projection work out of the serialization path. Bound pending count/bytes and preserve terminal/error barriers and cancellation ordering.
- The SDK already coalesces replaceable pending snapshots. Find why 22 seconds of terminal queue wait survived it. Optimize the dominant source rather than adding another generic queue.
- Present observable phases such as Preparing workspace, Running model, Saving result, and Awaiting parent, using actual lifecycle records. Final text is not a completion proof.
- Avoid starting unrelated native locations/MCP servers during catalog refresh, and release idle worktree locations only after all owned work, views, requests, and recovery have settled.

Tests and measurements:
- Concurrent two-child unchanged tree; one changed file; large tree; same bytes/new stamps; changing workspace; symlink substitution; concurrent writer; external changes during read-only work; cancellation during preparation; malformed/unconfirmed receipt; restart before terminal save.
- Count preparations, hashes/restamps, commits, exact receipts, meaningful changes revisions, emitted notifications, and pending snapshot bytes.
- Use existing `perf:harness`, `perf:electron`, `perf:pipeline`, and `perf:compare` with matched source/artifact/fixture cohorts. Cold/warm, single/two-child, unchanged/mutated cases need separate results.
- At least five paired samples per case on an otherwise quiet machine. Report median and observed upper tail; a small sample is not a reliable p95 estimate. Preserve the existing acceptance rule requiring at least 5% median improvement and every candidate pair faster when that rule applies.
- Correctness and cleanup are hard gates. Performance targets are proposals, not claimed savings: eliminate duplicate unchanged preparation where proof permits; eliminate avoidable terminal backlog; no regression in event drops, memory, or task completion.
- Resource sampling should cover the owned descendant tree and unrelated workload context. Record CPU, private/aggregate RSS caveats, process count, file descriptors, event-buffer high-water marks, and return-to-idle behavior. Do not increase parallelism merely to hide serialized work.

## Work package D: result delivery and context engineering

Owners: orchestration projection/collection, native managed tool owner, harness context hooks, packaged specialist prompts.

Current mechanisms:
- [managed result projection](../../../../packages/orchestration-runtime/managed-result-projection.js)
- [compact header parser](../../../../packages/orchestration-runtime/compact-result-header.js)
- [feature policies](../../../../packages/orchestration-runtime/harness-policies.js)
- [orchestration runtime](../../../../packages/web/server/lib/orchestration/runtime.js)
- [native managed tool owner](../../../../packages/web/server/lib/opencode/runtime-host/managed-task-owner.js)
- [context plugin](../../../../packages/web/server/default-config/plugins/devryan-harness-context.mjs)

Implementation:
- Certify existing `DEVRYAN_COMPACT_MANAGED_RESULTS=1` in an isolated profile. Do not activate it in the user's current runtime as an untested fix.
- Keep one complete durable result envelope for UI, recovery and evidence. Model-facing status/wait should return compact lifecycle/check/recovery facts and stable result identity; detailed report remains cursor-addressable.
- Return a lean successful disposition receipt: task/envelope identity, status, action, barrier state and follow-up identity. Do not replay the first report page or the entire canonical-reference list after collection.
- Preserve ordered cursor/scope checks and `collection.assertDisposition`, including required detail, failed checks, partial work, recovery and manual attention. Compact mode currently still requires full detail for some successful inspection tasks; keep that gate unless a separately proven contract permits a smaller required subset.
- Remove duplicate task/envelope preview and reference fields only at the model-facing projection. Explicit rereads remain available and auditable; compaction/restart must not falsely claim content was read.
- Tune page sizing after eliminating repeats: evaluate fewer larger bounded pages for mid-size reports, while respecting UTF-8 boundaries, cancellation, byte limits and required collection. An unbounded bulk-return option is unnecessary.
- Structure specialist briefs with goal, exact scope, constraints, expected evidence and stopping condition. Reports should prioritize verified conclusions, exact files, gaps, required checks and blockers. Avoid full narration of every read.
- Preserve specialist autonomy to investigate a real ambiguity. Prompt for bounded searches and report synthesis; do not hide failures or impose arbitrary token cutoffs.
- Parent should verify findings that determine a change or resolve a conflict, without automatically replaying discovery. Preserve source references and distinguish authoritative runtime evidence from agent suggestions.
- Measure context by provenance: fixed instructions, tool schemas, original request, task/control headers, report bodies, verification reads, reasoning, summaries and maintenance. Measure actual provider usage/cache counters separately from byte estimates.
- Keep fixed instructions stable and small; load relevant skills/knowledge when needed. Preserve exact required policy across native/Cursor children and worktree changes.
- Certify checkpoint/decision and saved-plan facilities already present. Compaction must retain accepted objective/selection, task IDs, unread cursors, disposition barriers, partial plan version, pending recovery and decisions.
- Defer Code Mode for managed control until its approval, collection and cancellation semantics are certified. Ordinary read-heavy specialists are a narrower initial experiment. Keep all nested tool permission enforcement.

Tests:
- Existing projection/compact-header, RPC runtime, native collection/owner, packaged plugin and prompt-contract suites.
- Short, large and Unicode reports; wait → all required pages → continue; repeated status/disposition; interrupted reads; mismatched identity; restart/compaction; partial result; required failed check; manual recovery; cancelled task; distinct identical task results.
- Assertions: each report body is delivered once in the normal collection path; disposition returns no report text; durable details remain complete; ambiguous headers fail safely; unread required detail cannot be bypassed.
- Compare completed task quality, exact evidence recall, total model-facing bytes, round trips, latest active input, cumulative input/cache use, and wall time. Prompt revisions require their owning package's runtime-asset tests.

## OpenCode 2 and upstream compatibility review

826 remote OpenChamber commit records from 29 September through 13 October 2026 were reviewed, with selected relevant diffs inspected. No upstream checkout was cloned or accessed. Dates below are source UTC dates. Treat these changes as ideas and acceptance cases against DevRyan's owners, not a rebase plan.

| Source | Relevant behavior | DevRyan action |
| --- | --- | --- |
| [cbee6de, Oct 12](https://github.com/openchamber/openchamber/commit/cbee6de2aee48505149572c6b30d8aa93987e7cb) | Queue delivery waits for active descendants and defers unknown lineage. | Existing native subtree contract: test root idle with busy/retrying grandchild, missing lineage and queued human input. |
| [6e263a5, Oct 2](https://github.com/openchamber/openchamber/commit/6e263a57ac05b369c99e036667527f1159bbdc32) | Location-scoped catalog refresh prevents unrelated MCP startup. | Count actual location/process activation; narrow any broad refresh owner. |
| [93b8b9f, Oct 4](https://github.com/openchamber/openchamber/commit/93b8b9fc5badf550091179ceae0eec2b396c401a) | Releases abandoned idle worktree locations. | Reuse owned disposal, retaining active commands, panels, requests and recovery. Do not copy upstream delay constants without evidence. |
| [b79220d, Oct 3](https://github.com/openchamber/openchamber/commit/b79220d5c0519305056673f568739a78881ca8ac) | Upstream reconnect backoff. | Test bounded backoff plus authoritative snapshot reconciliation, cancellation and auth expiry. |
| [ab80060, Oct 12](https://github.com/openchamber/openchamber/commit/ab80060808d5b0ef12811012e4d179acf93f69e1) | Retries normalized transient reads. | Apply only to safe reads; caller abort and ambiguous dispatched writes remain distinct. |
| [83193ab, Oct 12](https://github.com/openchamber/openchamber/commit/83193ab401c2422abdd0a005d4e078c22e8d7f88) | Keeps reduced message-page behavior after relay drops. | Test capability persistence if adopting lazy result pages. |
| [c60c0ac, Oct 12](https://github.com/openchamber/openchamber/commit/c60c0acca35e25401b1b77db69a925e23c840e76) | Follows session cursor pages. | Existing client owner: test sessions beyond page one, repeated cursors, bounds and runtime replacement during traversal. |
| [4bdf993, Oct 3](https://github.com/openchamber/openchamber/commit/4bdf99394505c5801fb837fb19bfe8981f2cf4e2) | Maps retry scheduling to legacy status. | Existing mapping: test visible retry cause, attempt, next scheduled retry time and failed retry terminal state. Native retry time is not a task execution deadline. |
| [94e08f8, Oct 12](https://github.com/openchamber/openchamber/commit/94e08f8b2ff16c61c40857d580775275c28d6091) | Lazily loads completed tool bodies on expansion. | Profile network/renderer benefit; preserve errors/status/header facts. This alone does not reduce model context. |
| [6cd0903, Oct 10](https://github.com/openchamber/openchamber/commit/6cd0903a05b0120abb5c2791a772a3e6abfd5d90) | Narrow subscriptions and streaming work. | Apply measured hot-path changes under [DevRyan performance guidance](../../../AGENT_PERFORMANCE.md). |
| [e2a724d, Oct 13](https://github.com/openchamber/openchamber/commit/e2a724d2171d15ff4d7a72d2d6f958b167e57d12) | Bounded project knowledge/plan access with expected-content checks. | Certify existing checkpoint/decision/saved-plan facilities before introducing another store. |
| [63e19be, Oct 13](https://github.com/openchamber/openchamber/commit/63e19becbb3859eef6ff97571ad42cfa51adb436) | All uploads retain draft; rejects incomplete Mac updater metadata. | Stable DevRyan uploads already use draft true. Protect single promotion and fix secondary Docs Source writer. DevRyan stable scope has no Intel ZIP/latest-mac manifest. |

The [OpenCode 2 launch article](https://anoma.ly/notes/opencode-2-0/) highlights embedded SDK, the new client/server contract, Code Mode, background tasks and hot reload. Its quality/context claims are product claims, not measurements of DevRyan. DevRyan already embeds V2: adding another service would not solve this run.

Current official docs describe the following contracts; verify them against pinned `2.0.26` vectors/OpenAPI and compiled artifacts. Upstream OpenChamber's `2.0.27` pin does not alone justify an upgrade.

- [V2 client](https://dev.opencode.ai/v2/docs/build/client/): shared event connection, slow-subscriber backpressure, live-only streams without built-in replay/reconnection. DevRyan already owns replay/readiness; exercise disconnect, clean unexpected end, bounded queues, gap recovery and readiness ACK.
- [Agents](https://dev.opencode.ai/v2/docs/agents/) and [tools](https://dev.opencode.ai/v2/docs/tools/): fresh native child context and background notifications. Managed `devryan_task` remains a custom DevRyan-owned contract; replacing it would lose deliberate ownership/collection policy.
- [Compaction](https://dev.opencode.ai/v2/docs/compaction): acceptance is asynchronous, recent tail is budgeted, fixed instructions/schemas can remain oversized, and provider checkpoints bind provider/model/endpoint. Test completion and model-switch semantics; compaction is not a substitute for fixing repeats.
- [Plugin migration](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1/): distinct admission/context/generation/compaction hooks. Audit used hooks and cleanup; replayed transforms must be cheap and repeatable.
- [Instructions](https://dev.opencode.ai/v2/docs/instructions/): native AGENTS discovery differs from arbitrary configured instruction globs. Assert actual prepared policy instead of assuming legacy CLAUDE.md or instruction fallback.
- [Embedded SDK](https://dev.opencode.ai/v2/docs/build/sdk/): explicit resource cleanup. Keep host entrypoints thin and release only owned resources.
- [Warming](https://dev.opencode.ai/v2/docs/warming/): default-off and real provider requests. Defer global warming and model-cache routing heuristics until per-provider measurements justify them.

## Engineering principles and their local application

These are documented practices from primary engineering sources, rather than a formal universal harness standard.

- [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) supports focused subagents, just-in-time retrieval, concise synthesis, durable decisions and recall-preserving compaction. Here: keep detailed discovery outside repeated control receipts and retain exact references and unresolved gaps.
- [Anthropic: writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents) recommends useful concise responses, bounded pagination/filtering, realistic outcome-based evaluations, and tracking latency/tokens/tool errors. Here: fix wait/read/disposition redundancy and evaluate held-out tasks, not just this prompt.
- [Anthropic: long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) uses incremental work, persistent handoffs and real end-to-end checks. Here: preserve approved plan/decisions and grade implementation plus UI behavior after restart.
- [OpenAI: harness engineering](https://openai.com/index/harness-engineering/) emphasizes repository-local knowledge, progressive disclosure and enforceable architecture. Here: keep short entry instructions and update relevant DOCUMENTATION when contracts change; use core validation instead of adding more prose rules.
- [Anthropic: Code Mode](https://www.anthropic.com/engineering/code-execution-with-mcp) demonstrates filtering intermediate data outside model context. Its example savings are not a forecast for DevRyan; use a narrow measured experiment after correctness repairs.

## Work package E: release publication repair

Owners: GitHub workflows, existing release orchestration/asset helpers, Electron packaging and updater contracts.

### Confirmed risks

| Risk | Current evidence | Planned repair |
| --- | --- | --- |
| Retry collides with prior artifacts | [release workflow](../../../../.github/workflows/release.yml): native artifact uploads precede later failure points; DMG and receipt upload precede release upload. Named upload-artifact v4 artifacts reject a rerun by default. | Explicit rerun semantics for internal single-writer handoffs, source-bound receipts, and fail-after-upload regression. Do not blindly overwrite artifacts shared by concurrent writers. |
| Manual version/ref mismatch | Version input is independent of source ref; release creation lacks explicit immutable source admission and later writers look up by tag. No version concurrency owner. | Resolve/create tag only under reviewed policy, verify exact source SHA before writes, serialize by version without cancelling active publication, use one release ID. Refuse mismatched or already published identities. |
| Secondary writer breaks allowlist/promotion | [docs-source.yml](../../../../.github/workflows/docs-source.yml) adds docs tarball outside allowlist and its upload lacks draft preservation. Manual release_tag can target a draft/published release. | Keep docs source as branded workflow artifact only. No secondary stable asset or publish writer. |
| Full scope unavailable late | [native target verifier](../../../../scripts/verify-revert-runtime-artifacts.mjs) supports only darwin-arm64; universal web needs six targets. | Early scope preflight before draft/build/npm work. Keep unsupported scope unavailable until actual platform qualification; never weaken universal verification. |
| npm can partially publish or silently skip | Missing token can skip; existing version skip does not compare integrity; publication precedes final desktop gates. | When full scope becomes available, verify credentials and existing dist.integrity, stage immutable tarball, gate irreversible npm publish behind applicable qualification. Model partial external publication explicitly. |
| Manual DMG workflow uses retired public manifest | [manual DMG workflow](../../../../.github/workflows/build-macos-arm64-dmg.yml) expects a public runtime-image manifest absent since 2.0.1. | Reuse exact internal handoff by run/SHA and verified retained receipt; keep legacy compatibility lane explicitly separate. No extra public manifest. |
| Packaged qualification coverage | Final long DMG startup suite is deliberately manual; macOS policy is ad-hoc signed/unnotarized. | Retain current gates, add a short final-artifact fixture startup/visual smoke with explicit gating policy, and report Gatekeeper/signing class separately. Do not silently restore the removed 40-minute suite. |

### Publication contract

Reuse [release asset helpers](../../../../packages/electron/release-assets.mjs). Exact public assets:
- `desktop-macos-arm64`: only `DevRyan-<version>-arm64.dmg`.
- `full`: that DMG plus `DevRyan-web-<version>.tgz`.
- Other existing preview scopes keep their own tested contracts. No legacy prefixes, extension assets, docs archives, or extra manifests/checksums in stable release assets.

One early admission phase validates source/tag/version/scope/toolchain/prerequisites. Build once, verify signed native/package inputs, and pass source-bound artifacts and receipts. One final promotion owner stages deterministic public names, uploads to the admitted draft, verifies exact inventory and remote content, then publishes. Check inventory again after promotion to catch a secondary writer.

Retry rules:
- Same admitted source/name/digest is idempotent success.
- Wrong source/digest or unexpected published asset fails without deleting published bytes.
- Internal artifact replacement is allowed only under explicit same-run/source ownership.
- Transient API failures use bounded retries; exhausted/ambiguous outcomes remain visible and recoverable.
- Required publication cannot be reported successful if skipped.
- Since GitHub and npm cannot be one atomic transaction, a future full release needs a durable publication receipt and explicit partial outcome; do not pretend rollback can unpublish consumed packages.

Retain small provenance/signature receipts longer than bulky artifacts so manual reproduction does not depend on a one-day manifest. Keep every asset upload draft-only until the single promotion step. Stable uploads already do this; add protection for every workflow writer.

Official behavior: [upload-artifact v4 options](https://raw.githubusercontent.com/actions/upload-artifact/v4/action.yml), [softprops upload defaults](https://raw.githubusercontent.com/softprops/action-gh-release/v2.6.2/action.yml), [GitHub release creation](https://docs.github.com/en/rest/releases/releases#create-a-release), [workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). Token-created release events may not trigger Docs Source automatically, but manual dispatch still exposes its defect.

### Release tests and qualification

Extend existing workflow, release-ci, release-artifacts, asset verification, web packing, and Electron asset tests:
- Tag/SHA mismatch, unsupported scope and published-release refusal before any writer.
- Empty/corrupt/wrong/unexpected/legacy assets; exact DMG/full allowlists; docs workflow cannot attach or publish stable releases.
- Failure after each internal upload, job rerun, partial GitHub upload, retry with matching/mismatched digest, concurrent attempts, promotion failure.
- Missing npm credentials and existing-version integrity mismatch for full scope.
- Dry-run prohibits GitHub/npm/registry/database writes.
- Source/hash/signature receipts cannot be substituted with development manifests.

Artifact rehearsal uses immutable source and real verified internal inputs. Keep signed-image, runtime/config, migration and native package checks. No fake receipts. Historical release findings are fixtures and risk evidence, not claims about today's remote inventory.

macOS qualification uses final DMG bytes, mounted read-only, no re-signing, disposable GUI profile:
- Install/layout, launch/setup, ready fixture chat, saved history, reopen.
- Upgrade from the last two supported stable baselines, failed/interrupted update and recovery, rollback/tamper/runtime ownership.
- Short smoke as proposed publication gate; long full installer suite stays the separate documented qualification.
- Inspect all screenshots: DMG layout, splash/setup, chat/plan, task rows, completion, failed plan/retry, update/recovery.
- Run the existing opt-in native installer group with built bridge when prerequisites exist. Actual reboot, Developer ID/notarization, downloaded-app Gatekeeper behavior and unavailable platform/signing checks must be reported separately.
- Follow disk/retention policy: `df -h .` before packaging; repository run roots; sanitized proof in docs; cache report/prune preview; cleanup owned runs/worktrees/downloads.

## Visual and live test matrix

Use [isolated runtime verification](../../../AGENT_RUNTIME_VERIFICATION.md) and [QA profiles](../../../QA.md), with fresh private HOME/XDG/data/bundle selection and the repository credential-owner mechanism. Deterministic fixtures never use real credentials, live providers, production or installed-app state. Password-free agent-test sessions apply where managed-user authorization is exercised. Do not stop the user's app or Docker Engine.

Reuse [agent visual smoke](../../../../scripts/qa/agent-visual-smoke.mjs), existing agent-eval client/fixtures, compiled native simulations, and resource benchmark producers. Add cases only where current fixtures lack the observed failure. Do not create another general QA runner.

| Case | Prompt/scenario | Functional assertions | Visual checks |
| --- | --- | --- | --- |
| Plan with two read-only children | “In plan mode, delegate discovery of two independent fixture concerns to Explorer; return a concise complete plan with exact references. Do not edit.” | Actual configured provider/model/effort, no workspace changes, both tasks terminal, report collected once, plan succeeds. | Preparing/running/saving phases; Complete children; parent resumes; plan finishes; approval enabled only then. |
| Text sentinel | Ask Explorer to return exact fixture paths and Markdown/status sentinel. | Byte equality across worker, saved message, managed result and parent content. | Paths/link targets, code fence, bullets/status markers and Unicode render correctly. |
| Large result | Two fixture reports around the observed 8–35 KiB boundary. | Ordered paging, lean wait/disposition, required details available, body delivered once. | Expand detail, child links, stable scrolling, no runaway context rail churn. |
| Partial plan transport loss | Synthetic provider drops after plan starts, with HTTP 200. | Partial preserved, error typed, no implement admission; retry succeeds or fails safely. | Interrupted plan clearly marked; no endless Composing; cause/retry controls; reload parity. |
| Native retry refusal | Inject the actual stale-step/authority failure once causal trace is established. | Original failure preserved, no tools under stale scope, settled actionable outcome. | Both causes understandable, no false completion or enabled incomplete plan. |
| Slow settlement | Hold receipt/persistence briefly under fixture control. | Terminal not advertised prematurely; bounded progress/cleanup. | Saving-result state replaces ambiguous Composing; Stop and loading state agree. |
| Stop and resend | Stop during preparation, streaming and settlement; then fresh authorized input/model switch. | Old work cannot publish into new attempt; no leaked process/lease; no prompt replay. | Stop acknowledgment, actionable input, task statuses and reasoning settle. |
| Nested background work | Root idle while child/grandchild busy or retrying; enqueue human input. | Delivery waits for authoritative subtree settlement and acknowledgment barriers; missing lineage defers. | Queue state and active descendants remain visible; no premature parent-ready signal. |
| Reconnect/reload | Break upstream and UI event connections, including clean early EOF. | Bounded reconnect, readiness revoke/ACK, snapshot reconciliation, no duplicate/missing parts. | Saved history/task tree restores; no stale active spinner, duplicate text or scroll jump. |
| Compaction and switch | Compact with pending child/unread cursor, then model switch. | Decisions/identity/cursors survive; checkpoint scope honored; no reread claim without proof. | Correct context usage, task/result links and approval state after maintenance. |
| Approved implementation | On a disposable fixture, approve a complete plan and delegate to Fixer/Designer. | Edits confined to assigned files, real checks succeed, final evidence, no approval bypass. | Plan → implementation transition, live worker rows, final response, reopen and result history. |
| Failure during implementation | Synthetic tool/provider failure, partial write and verification failure. | Partial work explicit, recovery/check gates hold, no success suppression. | Failed tools/recovery and final outcome clear; inputs recover after safe settlement. |
| Release installer/update | Exact final DMG and supported upgrade baseline. | Same release/source/digest, real startup and fixture turn, no extra assets. | Install layout, setup/readiness, plan/delegation, update progress and recovery screenshots. |

Suggested attended live cohort after deterministic/native fixes: GPT-6 Astra orchestrator with Cursor Grok 4.6 Explorers (the original combination), then one alternative configured specialist provider to separate Cursor-specific and core behavior. Use actual selected models/efforts, not picker labels alone. Original live usage permission allows those tests; explicit credential ownership and isolation are still prerequisites. No extra live prompt was needed to establish this run's failure.

Visual pass requires inspecting screenshots and testing interaction; a screenshot's existence, an idle session, or successful API response alone is insufficient. Grade actual completed plan/implementation, persisted result and UI state together.

Nested-background cases require a canonical native fixture or a project-defined non-Orchestrator agent with nesting explicitly enabled. V2 defaults to one nesting level; packaged Orchestrator specialists intentionally deny provider-native delegation. Preserve that denial and managed root ownership rather than relaxing production permissions to manufacture a grandchild.

## Verification order and exit criteria

1. Freeze baseline source/artifact identity and preserve existing user changes. Capture this regression as deterministic fixtures first.
2. Implement A/B, then C/D in small cohesive changes; update nearest DOCUMENTATION for changed contracts and runtime prompt assets.
3. Run owning focused suites while developing. For integrated risky session/server/contracts/release changes run `bun run validate:full` once after changes settle; it includes lint/type/tests/docs. Do not repeat those separately without a reason.
4. Run `bun run build` and `bun run bundle:check` when compiled runtime, exports, dependencies, dynamic imports or packaging inputs change.
5. Qualify fresh pinned native source and compiled package using documented `verify-opencode-v2-native.mjs` and `verify-opencode-v2-package.mjs` lanes with synthetic providers. Any remaining mandatory gate stays explicit.
6. Run paired resource benchmarks on a quiet host, then isolated attended visual/live cohort. Keep builds/benchmarks separate from measured live turns.
7. Rehearse release publication without writes, then qualify final installer bytes and supported upgrade paths. Publish only under the existing release authorization after all scope gates pass.

Acceptance:
- A complete current plan is the only implementable plan; partial failure/retry/reload never grants approval.
- Exact report text and typed failures survive every supported transport and persistence path.
- No duplicate prompt, terminal outcome, managed disposition or task-result body on the normal path.
- Useful child work completes under unchanged safety/ownership/evidence guarantees.
- Preparation/persistence improvements have matched measured benefit; process/event/memory cleanup regresses nowhere.
- Context delivery declines without losing required evidence, decisions or blockers; consumption and cache counters remain clearly labeled.
- Exact branded asset set, immutable source binding, safe retry and one promotion owner hold in every release rehearsal.
- Failed, unavailable, expired and unqualified checks are reported explicitly.

## What was checked now

Completed: computer-use observation; selected-journal/API correlation and gap check; repository owner/contract review; remote upstream/article/official research; isolated actual-source reproduction of the dedupe defect; release workflow analysis; this implementation and visual-test plan.

Not performed: harness edits, fixture implementation, live retest, implementation phase, full validation/build/native package qualification, release inventory/publication, signing/notarization/Gatekeeper/reboot tests, or sustained resource profiling. The documentation validation result for this plan is reported separately in the chat.

Remaining causal limits: the provider-side reason for the original connection loss; exact inner primary-step retry refusal; source of all live text corruption; stamp invalidation cause; fixed per-receipt cost/serialization/no-op claims; accurate billable consumption. Resolve these through bounded typed diagnostics and fixtures before choosing changes that depend on them.

