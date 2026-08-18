# packages/web/server/lib/orchestration/

## Responsibility

Web/Electron owner adapter for the transport-neutral DevRyan-managed task scheduler.

## Files

- `runtime.js`: composes one scheduler, rejects unsupported read-only providers and implementation-only Designer dispatch before durable admission, acquires cross-process persistence ownership before bridge/recovery startup, suppresses non-owner recovery, safely projects ownership conflicts, handles validated 25-second maximum wait slices, barrier inspection and confirmed agent handoff, external-runtime gating, event publication, and exact-owner shutdown. Optional `auxiliaryRpcHandlers` dispatch named bridge methods before scheduler initialization or availability gating, so lightweight private integrations can reuse the loopback bridge without touching managed-task state.
- `atomic-ledger.js`: private atomic JSON persistence with an exclusive heartbeat owner lock, dead-process recovery regardless of heartbeat age, per-operation token fencing, legacy dispatch-group hydration, and corrupt-ledger quarantine.
- `open-code-executor.js`: managed OpenCode HTTP transport and Cursor SDK routing for the shared executor state machine, including cross-owner stale-child abort/deletion cleanup.
- `private-host.js`: authenticated IPv4-loopback RPC listener with bounded bodies and deterministic close.
- `routes.js`: authenticated UI snapshot, task, cancellation, acknowledgement, and Orchestrator-to-Builder handoff endpoints.
- `*.test.js`: focused owner, transport, persistence, security, and lifecycle coverage.

## Integration

`packages/web/server/index.js` creates this runtime before OpenCode bootstrap, registers its UI routes, supplies its private environment to `lib/opencode/lifecycle.js`, publishes synthetic managed events, and disposes the owner through `lib/opencode/shutdown-runtime.js`.
