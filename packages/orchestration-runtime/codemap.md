# packages/orchestration-runtime/

## Responsibility

Transport-neutral DevRyan-managed task contracts and scheduler policy shared by web/Electron and VS Code runtime owners.

## Design

- No third-party runtime dependencies.
- Only `owner: "devryan"` records with `dvr_*` identities enter this boundary.
- Full queued prompt input and optional parent-message `dispatchGroupId` remain bounded and private to the durable ledger. The originating managed-tool `dispatchCallId` is durable and safely projected so a provisional chat row can reconcile to its exact task without label heuristics; broadcast projections still omit prompt, idempotency, and dispatch-group content.
- Scheduler policy, persistence limits, transitions, cancellation, recovery, and result envelopes belong here rather than in UI or runtime adapters.

## Entrypoints

- `index.js` / `index.d.ts`: runtime exports and JSON-compatible TypeScript contract.
- `contract.js`: task validation, bounds, status helpers, safe task projection, and identity-only compaction removal projection.
- `open-code-executor.js`: injected canonical child create/prompt/observe/abort/delete/reconcile state machine, including lease-ownership checkpoints, stale fresh-child cleanup, live provider-retry observation, transient polling and reconciliation recovery, retained interruption output, bounded same-child recovery after normalized transport failures or missing final output, same-child manual model continuation, and exact shared recognition of its transcript-recorded transport continuation prompts.
- `provider-prompt-tools.js`: shared minimal provider-specific tool-surface overrides used by normal UI prompts and managed child prompts.
- `provider-retry-policy.js`: shared provider policy classifiers for definite usage/quota exhaustion, verified provider prompt rejection, and normalized request/header/stream-idle/connection transport failures, with auth/model/certificate/abort precedence.
- `transitions.js`: immutable terminal records and the explicit lifecycle graph.
- `scheduler.js`: serialized immediate admission without an artificial concurrency cap, boolean child/acceptance lease checkpoints, mode ownership, terminal or bounded-slice task waits, dispatch-group barriers, explicit Orchestrator-to-Builder cleanup handoff, cancellation, execution timeouts, result actions, and deadline-bounded same-child restart reconciliation retries.
- `result-envelope.js`: idempotent terminal handoff records for the parent orchestrator.
- `persistence.js`: count/age/UTF-8 byte compaction that protects live work, unacknowledged grouped results, and attempt lineage.
- `*.test.js`: dependency-free Bun contract and scheduler conformance tests.

## Integration

Web/Electron and VS Code each own one scheduler instance and inject provider execution, persistence, clocks, identifiers, and event publication. Shared UI imports the public provider prompt-tool policy; UI presentation consumes only safe task projections and authoritative compaction removals.
