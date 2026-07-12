# packages/web/server/lib/orchestration/

## Responsibility

Web/Electron owner adapter for the transport-neutral DevRyan-managed task scheduler.

## Files

- `runtime.js`: composes one scheduler, safe RPC projection, external-runtime gate, event publication, and shutdown.
- `atomic-ledger.js`: private atomic JSON persistence plus corrupt-ledger quarantine.
- `open-code-executor.js`: managed OpenCode HTTP transport and Cursor SDK routing for the shared executor state machine.
- `private-host.js`: authenticated IPv4-loopback RPC listener with bounded bodies and deterministic close.
- `routes.js`: authenticated UI snapshot, task, cancellation, and acknowledgement endpoints.
- `*.test.js`: focused owner, transport, persistence, security, and lifecycle coverage.

## Integration

`packages/web/server/index.js` creates this runtime before OpenCode bootstrap, registers its UI routes, supplies its private environment to `lib/opencode/lifecycle.js`, publishes synthetic managed events, and disposes the owner through `lib/opencode/shutdown-runtime.js`.
