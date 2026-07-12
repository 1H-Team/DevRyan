# packages/orchestration-runtime/

## Responsibility

Transport-neutral DevRyan-managed task contracts and scheduler policy shared by web/Electron and VS Code runtime owners.

## Design

- No third-party runtime dependencies.
- Only `owner: "devryan"` records with `dvr_*` identities enter this boundary.
- Full queued prompt input remains bounded and private to the durable ledger; broadcast projections omit prompt and idempotency content.
- Scheduler policy, persistence limits, transitions, cancellation, recovery, and result envelopes belong here rather than in UI or runtime adapters.

## Entrypoints

- `index.js` / `index.d.ts`: runtime exports and JSON-compatible TypeScript contract.
- `contract.js`: task validation, bounds, status helpers, safe task projection, and identity-only compaction removal projection.
- `open-code-executor.js`: injected canonical child create/prompt/observe/abort/reconcile state machine, including first-retry stop control and same-child manual model continuation.
- `provider-prompt-tools.js`: shared minimal provider-specific tool-surface overrides used by normal UI prompts and managed child prompts.
- `transitions.js`: immutable terminal records and the explicit lifecycle graph.
- `scheduler.js`: serialized admission, hard three-slot accounting, mode ownership, dispatch, cancellation, timeouts, result actions, and restart reconciliation.
- `result-envelope.js`: idempotent terminal handoff records for the parent orchestrator.
- `persistence.js`: count/age/UTF-8 byte compaction that protects live work and attempt lineage.
- `*.test.js`: dependency-free Bun contract and scheduler conformance tests.

## Integration

Web/Electron and VS Code each own one scheduler instance and inject provider execution, persistence, clocks, identifiers, and event publication. Shared UI imports the public provider prompt-tool policy; UI presentation consumes only safe task projections and authoritative compaction removals.
