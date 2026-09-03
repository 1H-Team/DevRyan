# packages/web/server/lib/orchestration/

## Responsibility

Web/Electron owner adapter for the transport-neutral DevRyan-managed task scheduler.

## Files

- `runtime.js`: composes one scheduler, overlays the durable root owner's
  personal-or-host agent execution before admission and retry/resume agent
  changes, preserves explicit plan-safe and Model Recovery attempts, rejects
  unsupported read-only providers and implementation-only Designer dispatch,
  acquires cross-process persistence ownership before bridge/recovery startup,
  suppresses non-owner recovery, safely projects ownership conflicts, handles
  validated 25-second maximum wait slices, eager/reference result projection
  and scoped stateless `read_result` paging, barrier inspection and confirmed
  agent handoff, atomic parent-recovery continuation claims, external-runtime gating, event publication, and exact-owner
  shutdown. It wires the scheduler's automatic-resume hooks (`resolveOwnerKey`,
  `resolveBackupExecution`, `resolveProviderReset`, and an `attempt` that re-enters
  the acknowledge RPC under an internal context), exposes the scoped
  `set_auto_resume` RPC, and cancels plans on `session.deleted` events. Optional `auxiliaryRpcHandlers` dispatch named bridge methods before
  scheduler initialization or availability gating, so lightweight private
  integrations can reuse the loopback bridge without touching managed-task state.
- `atomic-ledger.js`: private atomic JSON persistence with an exclusive heartbeat owner lock, dead-process recovery regardless of heartbeat age, per-operation token fencing, legacy dispatch-group hydration, and corrupt-ledger quarantine.
- `open-code-executor.js`: managed OpenCode HTTP transport and Cursor SDK routing for the shared executor state machine, including per-executor exact-URL status single-flight and cross-owner stale-child abort/deletion cleanup.
- `private-host.js`: authenticated IPv4-loopback RPC listener with bounded bodies and deterministic close.
- `provider-reset-probe.js`: the scheduler's `resolveProviderReset` hook for Anthropic-routed children — resolves the loopback Meridian proxy (shared quota resolver, per-directory cache) and reads its raw quota buckets into `{ limited, resetAt }`, cached per proxy for 60 s with single-flight; null for external runtimes, other providers, or failures.
- `routes.js`: authenticated UI snapshot, task, cancellation, acknowledgement, auto-resume toggle, and Orchestrator-to-Builder handoff endpoints.
- `*.test.js`: focused owner, transport, persistence, security, and lifecycle coverage.

## Integration

`packages/web/server/index.js` creates this runtime before OpenCode bootstrap, registers its UI routes, supplies its private environment to `lib/opencode/lifecycle.js`, publishes synthetic managed events, and disposes the owner through `lib/opencode/shutdown-runtime.js`.
