# Managed harness optimization

DevRyan keeps OpenCode as the execution engine. The shared orchestration and harness runtimes own durable task state, continuation reservations, verification evidence and recovery. Web and Electron supply the same private bridge; no second scheduler, feature backend, database or child launch cap is introduced.

## Configuration and ownership

Standard roles in this repository come from `packages/web/server/default-config/agents`. Project `AGENTS.md`, custom roles, explicit model/effort choices, Council model companions, providers, MCP and LSP remain authoritative in their existing scopes. `.opencode/README.md` describes the migration of obsolete standard-role copies.

Preflight and run-start diagnostics record resolved runtime version, provider/model/variant, role source and content hashes, configured plugin identities, observed plugin factory loads, catalog hash and policy flags. Configured names alone do not prove a duplicate load. Unknown or unavailable catalog/factory evidence stays explicit. No plugin entry is deleted based on a similar name.

The existing primary recovery controller owns managed continuation reservations across providers. Collection, Orchestrator TODO and Builder TODO wakes must match its real-user anchor, model selection, cancellation generation and canonical settled state. Reservations persist before submitting a synthetic prompt. Unknown ownership fails closed; project auto-resume and Slim cannot submit a competing managed turn. Standalone use retains its own hooks. Collection and compaction do not refill repair or TODO budgets. Provider-specific transport recovery, role deadlines and Designer/Fixer's existing 150-plus-20 turn safeguards remain separate.

Managed ownership applies independently of the four optional switches. A root without a retained owner record, including a pre-upgrade root, needs a new real user instruction before automatic continuation; history cannot recreate spent budgets. This condition reports `managed_objective_unavailable`. An obsolete private-bridge token reports `managed_bridge_authentication_failed` with managed-runtime reconnect guidance. These diagnostics do not silently repair credentials or permit workspace mutations when the bridge is unavailable.

## Independent rollout switches

All four optimizations default off. Set a switch to exactly `1` in the owned managed host environment and restart that host to enable its behavior. Unset it to roll back; durable tasks, envelopes, history, receipts and decision provenance remain valid.

| Environment switch | Negotiated capability | Behavior |
| --- | --- | --- |
| `DEVRYAN_MANAGED_READ_OVERLAP` | `readOverlap` | Host-approved native reads and known retrieval tools while grouped children run or await disposition. |
| `DEVRYAN_MANAGED_WAIT_ANY` | `waitAny` | `devryan_task` `wait_any` with explicit `task_ids` and optional `after_cursor`. |
| `DEVRYAN_COMPACT_MANAGED_RESULTS` | `compactResults` | Version-1 canonical result header before selectively retrieved detail; declared required-check observation. |
| `DEVRYAN_TASK_CONTEXT_PROJECTION` | `contextProjection` | Bounded task checkpoints, project decisions, exact duplicate observation masking and native compaction context. |

Legacy eager/reference result clients and single-task `wait` remain supported. `DEVRYAN_MANAGED_RESULT_MODE=eager` retains its existing rollback behavior. No optional optimization is promoted solely because deterministic tests pass.

## Reads, waits and result delivery

The host allowlist in `harness-policies.js` is independent of session-change capture. Arbitrary shell/code execution, tool annotations and unfamiliar MCP tools cannot authorize overlap. Workspace writes, dependent execution and final completion remain gated. Native read identities captured while child writes are possible are provisional. Before a later existing-target edit/write/patch, the host requires a fresh unchanged identity; unknown, oversized, raced or evicted identities require another read. Legitimate new-file creation remains possible. Native freshness enforcement still applies; file sampling is not an atomic filesystem transaction.

`wait_any` returns only committed terminal envelopes. Scheduled recovery and manual attention are separate states, not ordinary collectable successes. Version-2 persisted cursors include the exact selected task set: foreign-root cursors fail; expired, version-1 and changed-selection cursors reset to an authoritative snapshot, including when a large selection shrinks. Request-size limits remain at the private transport boundary. Registration and snapshot capture share the scheduler's mutation queue, closing the completion-before-wait gap. Timeout/abort cleanup removes subscriptions without cancelling children.

Meaningful collection changes advance the existing persisted envelope sequence. Repeated recovery scheduling within the same state does not. Snapshots retain full attention, pending and unacknowledged state while identifying changed tasks, dispositions, retry follow-ups and other ready same-root tasks. Unchanged attention stays inside the attached wait while selected work runs; all-parked or fully dispositioned selections return explicit next-step guidance. An own `continue` disposition does not produce an empty wake while another selected child runs. The host projects manual-recovery authority; legacy clients retain compatible fallback classification.

One directory-scoped envelope commit watch triggers the existing collection scan. An idle root receives one claimed owner reservation; a busy root waits for a safe native boundary. Unchanged private wait slices do not produce model turns. Terminal state and envelope persistence precede notifications and dispositions.

## Required checks and compact results

A dispatch can declare up to eight named checks, each with an exact native command and project-relative relevant files. Before execution, the observer atomically reserves every check matched by that command, clearing earlier passes even if canonical message lookup is unavailable. It then binds the actual native call's assistant-message identity and captures bounded file manifests. An explicit command working directory must resolve to the task directory. Only a numeric canonical exit and matching final content can prove `passed`; nonzero exits prove `failed`. Missing calls, missing/wrong checks, absent exit metadata, stale leases and unavailable or changed content are `not-observed`. A pass followed by a relevant edit is unverified until rerun. Coverage is explicitly limited to declared files and checks.

Start, identity binding and completion each commit all matched check names together. Completion must match the current call and non-null message identity. Conflicting canonical identities invalidate the group with `canonical_check_identity_conflict`; late older completions cannot replace newer evidence. Duplicate calls cannot reconstruct lost pre-execution hashes from post-execution files. Reservation failures stop the observed native command; after a durable unknown reservation, unavailable identity or a lost completion remains unverified.

Failed capability negotiation is retried after the connection recovers, rather than cached as disabled. Until policy is known, or when an enabled reservation cannot be confirmed, the plugin fences native bash with `managed_check_observer_unavailable`. This deliberately also affects commands without declared checks during a bridge outage: the plugin cannot independently prove they are outside the check contract. Explicitly negotiated disabled policies remain inert.

The version-1 compact result header carries canonical outcome/partial status, critical failures, recovery restrictions, check evidence, coverage and detail references. A separate non-authoritative `reported` field parses the retained child's terminal Status and Routing markers outside code fences. A blocked, missing or ambiguous marker, truncated preview, partial outcome, recovery restriction, failure or missing/pending/failed required check requires all retained detail pages before any disposition. Only a complete, fully verified header permits selective retrieval. Legacy clients still read every retained page. Reading detail allows reconciliation of partial work without claiming successful verification.

## Task and project context

Task checkpoints are derived from the real-user anchor, selected-plan references, canonical native TODOs, active or undispositioned children, checks and recovery state. They are bounded, regenerable records in the existing harness storage. Missing or truncated context names the canonical reference and valid retrieval action. It cannot authorize a write or recovery.

Project decisions require an exact quote from a canonical real-user message in the same project, with source identity and optional content/expiry validity. Retrieval separates active, stale, expired and superseded decisions and considers relevance before recency. Non-Git global projects remain directory-scoped. There is no personal or cross-project memory.

Provider request projection retains the first exact compatible managed terminal observation and masks later duplicates, so appending another observation leaves the earlier projected prefix unchanged. It preserves tool-call/result structure, signed/opaque provider fields, attachments and native canonical history. Explicit checkpoint retrieval and native compaction supply the task checkpoint and critical references; no per-request checkpoint RPC or changing system suffix is injected. Native pruning or compaction may still change the native prefix. No summarization model or recursive memory graph is added.

Declared input/context limits and the last matching request's input/cache usage inform a labelled headroom estimate on checkpoint and compaction results; current active-context tokens remain unknown. Bytes and cumulative usage are never presented as exact active context.

## Progress and failures

Durable progress counts new authoritative tool evidence, child completion, changed artifacts and observed required-check outcomes. A newly started check durably replaces an older pass with `not-observed` before execution; that pending receipt does not count as useful progress. Completion must match the current check's call and message identity. Late older completions cannot replace newer pending, failed or passed evidence, and a duplicate start cannot reset that same invocation. Lost completion hooks and restarts therefore cannot resurrect the older pass. Token output and elapsed time remain liveness signals only. Broad semantic stagnation is report-only.

Managed Builder TODO continuation additionally requires current canonical open TODOs to match a completed native `todowrite` after the real-user anchor. The existing objective record stores task/progress hashes, progress-count watermarks and a stagnation count. After two unchanged nudges, another is denied; changed TODOs, verified artifact changes, observed required checks or completed children clear stagnation without refilling the existing twelve-continuation objective budget. Generic tool output, including changed durations in repeated failed tests, cannot reset this guard. TODO echo alone is not useful tool progress. Missing or mismatched current TODO evidence cannot authorize a nudge.

For identical deterministic pre-execution input/binary-read rejection within one objective, the first response asks for corrected input, the second permits one corrective replan and the third pauses automatic continuation. Reordered duplicate call observations cannot consume extra attempts. Failed commands and ambiguous possibly executed writes do not enter this counter. Transport, quota, authentication, unavailable model and prompt rejection use shared classification without converting unknown delivery into success or replaying a possibly executed write.

## Diagnostics and evaluation

The existing diagnostics ZIP includes `DevRyan-trace.json`. The authenticated `POST /api/diagnostics/export` also accepts `format: "chrome-trace"` with its existing runtime/task scope. Open the JSON in [Perfetto](https://perfetto.dev/docs/getting-started/other-formats). Root/task lanes correlate retained ledger, message, call and recovery identifiers. Export is bounded to 100,000 events and 32 MiB per projection stage; overflow is explicit.

Observed queue, tool, workspace-gating, disposition, native turn, objective and recovery durations retain missing timestamps as null. Workspace gating is not parent idle time, observed first activity is not wire time to first response, overlapping duration sums are not a critical path, and cost is labelled native-runtime-reported or unavailable. A runtime-reported cost does not establish a provider bill or a provider-reported charge. Input/output/cache usage is deduplicated by canonical message. Structural metadata excludes private reasoning, opaque provider blobs and raw tool arguments/output. Repeated identical known diagnostics aggregate by identity/cause/generation; retention writes age/size eviction reasons before deletion. These additions do not establish why older historical evidence was already missing.

Task exports attribute exact DevRyan-owned managed-task events to their root and preserve the recorded child relation even when the corresponding native session-created event has expired. The sanitizer preserves only the fixed `owner: devryan` marker needed for this attribution. Historical records whose owner marker was already dropped cannot establish that ownership. Unknown ownership, conflicting explicit roots and unrelated same-directory tasks cannot widen the export scope.

The existing `agent:eval` CLI accepts a deterministic 30-case golden catalog and live paired mode; see `scripts/agent-evals/codemap.md`. Golden selections fail when no tests actually run. Paired mode alternates three trials per arm, freezes fixture/environment/model/effort and nonexperimental fingerprint dimensions, and retains interrupted/failed outcomes. Disagreements require investigation and ten pairs. Unknown metrics, unavailable models, configuration mismatch, failed outcomes or no reduction in the declared target cannot qualify promotion. Models are never silently replaced.

Run `bun run validate:full`, `bun run build`, `bun run bundle:check`, and applicable isolated checks from `QA.md`. Fixture compaction and UI replay do not prove live native compaction. A complete memory/performance comparison requires the repaired canonical-to-visible long-history witness, matched baseline measurements and inspection of every captured PNG.

The [2026-09-10 implementation audit](audits/2026-09-10-harness-optimization.md) records the completed local checks, matched whole-package observations and unresolved native acceptance gates. Optional policies remain off by default.
