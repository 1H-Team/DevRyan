# packages/orchestration-runtime/

## Responsibility

Transport-neutral DevRyan-managed task contracts and scheduler policy shared by web/Electron runtime owners.

## Design

- No third-party runtime dependencies.
- Only `owner: "devryan"` records with `dvr_*` identities enter this boundary.
- Full queued prompt input and optional parent-message `dispatchGroupId` remain bounded and private to the durable ledger. The originating managed-tool `dispatchCallId` is durable and safely projected so a provisional chat row can reconcile to its exact task without label heuristics; broadcast projections still omit prompt, idempotency, and raw dispatch-group content while exposing only a `dispatchGrouped` policy boolean.
- Scheduler policy, persistence limits, transitions, cancellation, recovery, and result envelopes belong here rather than in UI or runtime adapters.

## Entrypoints

- `index.js` / `index.d.ts`: runtime exports and JSON-compatible TypeScript contract.
- `contract.js`: task validation, bounds, status helpers, safe task projection, identity-only compaction removal projection, and canonical parent/agent recognition of generated child-title placeholders shared by server/UI.
- `single-flight.js`: dependency-free pending-only keyed request coalescing, instantiated by each host executor rather than shared globally.
- `managed-result-projection.js`: pure eager/reference projection plus stateless UTF-8 result paging and cursor validation; it never mutates scheduler records or durable envelopes.
- `open-code-executor.js`: injected canonical child create/prompt/observe/abort/delete/reconcile state machine, including lease-ownership checkpoints, stale fresh-child cleanup, live provider-retry observation, transient polling and reconciliation recovery, retained interruption output, bounded same-child recovery after normalized transport failures or missing final output, same-child manual model continuation, exact shared recognition of its transcript-recorded transport continuation prompts, and an initial-only writable/read-only Context Mode routing contract that is never repeated on continuations.
- `provider-capabilities.js`: shared managed read-only provider and agent compatibility predicates, including the implementation-only Designer boundary and stable pre-admission failure contracts.
- `provider-prompt-tools.js`: shared provider, UI Plan Mode, and managed read-only tool profiles. Plan Mode restricts only Context Mode execution/administration while preserving the parent's other capabilities; verified managed health opens `ctx_index`. Managed children retain wildcard-deny inspection policy with the safe direct/MCP Context aliases.
- `xai-tool-catalog.js`: dependency-free Grok catalog reduction policy. It disables an MCP-prefixed alias only when the canonical tool has the same normalized description and parameter schema, then caches that evidence under an exact directory/provider/model key.
- `provider-retry-policy.js`: shared provider policy classifiers for definite usage/quota exhaustion, verified provider prompt rejection, and normalized request/header/stream-idle/connection transport failures, with auth/model/certificate/abort precedence.
- `transitions.js`: immutable terminal records and the explicit lifecycle graph.
- `scheduler.js`: serialized FIFO admission with no built-in concurrency cap but an optional host `admitLaunch` hook (capacity / system-pressure holds stamp a queued-only `waitingReason`, one shared retry timer, fail-open; no DevRyan host wires `admitLaunch`: sub-agent launches are never capped or held, user requirement 2026-09-04), boolean child/acceptance lease checkpoints, mode ownership, terminal or bounded-slice task waits, dispatch-group barriers, explicit Orchestrator-to-Builder cleanup handoff, cancellation, execution timeouts, result actions, deadline-bounded same-child restart reconciliation retries, and automatic resume of results parked on a definite provider usage limit (timers, per-provider/owner breakers, `setResultAutoResume`, `cancelAutoResumeForSession`, and the host `autoResume.attempt` hook).
- `auto-resume-policy.js`: pure automatic-resume planner — eligibility, state inheritance, rejection windows, backup-or-original target selection, reset/backoff scheduling, attempt/time/rejection caps, and the exact acknowledgement params one attempt makes.
- `single-flight.js`: keyed promise coalescing shared by host status observers and quota probes.
- `result-envelope.js`: idempotent terminal handoff records for the parent orchestrator.
- `persistence.js`: count/age/UTF-8 byte compaction that protects live work, unacknowledged grouped results, and attempt lineage.
- `*.test.js`: dependency-free Bun contract and scheduler conformance tests.

## Integration

Web/Electron each own one scheduler instance and inject provider execution, persistence, clocks, identifiers, and event publication. Shared UI imports the public provider prompt-tool policy; UI presentation consumes only safe task projections and authoritative compaction removals.
