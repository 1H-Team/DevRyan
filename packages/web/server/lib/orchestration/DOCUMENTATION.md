# Web Managed Orchestration

## Purpose

This module owns the single DevRyan-managed scheduler for the web server process. Electron inherits the same owner because it starts this web server in-process. Provider-native task events do not enter this module and are never counted or cancelled here.

## Ownership and startup

`runtime.js` composes the shared `@openchamber/orchestration-runtime` scheduler with the web OpenCode transport, atomic ledger, synthetic-event publisher, and private tool host. `lifecycle.js` asks the runtime for bridge environment immediately before spawning managed OpenCode. Only `DEVRYAN_ORCHESTRATION_URL` and `DEVRYAN_ORCHESTRATION_TOKEN` are injected; configured external OpenCode runtimes keep managed orchestration unavailable.

The private host binds `127.0.0.1:0`, requires a random bearer token, caps JSON input, exposes only `/rpc`, and is stopped before provider runtimes during graceful shutdown. URL/token values are never returned by diagnostics, UI routes, events, or routine logs.

## Persistence and recovery

`atomic-ledger.js` writes `OPENCHAMBER_DATA_DIR/orchestration/ledger.json` through a private mode-0600 temp file, file sync, atomic rename, and best-effort directory sync. Saves are serialized. Invalid JSON, oversized input, duplicate identity, and task/result contradictions are moved to a timestamped `.corrupt-*` file before the scheduler starts from an explicit empty state. Only the recovery warning, never ledger content or quarantine path, reaches the UI snapshot.

The shared executor records a child session before sending one queue-time provider/model/agent/variant snapshot. Web transport routes normal providers to managed OpenCode and Cursor to the existing Cursor SDK owner. The same shared prompt-tool policy used by the UI is applied to managed children, including both OpenCode names for Copilot's optional Resend MCP namespace. Restart reconciliation observes existing children and never blindly replays prompts.

## Contracts

- Private tool RPC methods: `submit`, `status`, `wait`, `cancel`, `snapshot`, and `acknowledge`.
- Authenticated UI routes: `GET /api/orchestration/snapshot`, `GET /api/orchestration/task/:taskId`, `POST /api/orchestration/task/:taskId/cancel`, and `POST /api/orchestration/task/:taskId/acknowledge`. A `retry_in_place` acknowledgement carries the user-selected provider/model/variant and continues the canonical child only after its prior retry loop settles.
- Events: safe `openchamber:managed-task` projections omit prompt, idempotency key, and lease token; identity-only `openchamber:managed-task-removed` events mirror durable compaction so connected UIs release history immediately.
- Packaged OpenCode surface: one `devryan_task` tool multiplexes start/status/wait/cancel/continue/retry/resume/abandon to minimize provider tool-count pressure. When the runtime agent catalog is available, its configured provider/model/variant is authoritative for starts and agent-targeted retries; model-supplied IDs cannot bypass Settings. Explicit provider/model input remains only as a compatibility fallback when no catalog is available.

The packaged orchestrator alone receives `devryan_task`. Builder, Council, Plan, and specialists explicitly deny it. Council's locally owned fanout uses the private RPC when present, so its parallel children share the three managed slots while its existing output contract remains unchanged. Without bridge environment, Council retains its existing direct behavior for external compatibility.

Managed OpenCode launches intentionally omit `--pure` and do not set `OPENCODE_DISABLE_DEFAULT_PLUGINS`: either switch suppresses the bundled managed tool itself. The generated runtime overlay remains the plugin allowlist owner, while prompt-scoped provider rules bound only the reproduced provider-specific tool surface.

## Testing

Run the module files under `packages/web/server/lib/orchestration/*.test.js`, the packaged managed-tool and Council plugin tests, the OpenCode lifecycle/shutdown tests, and `bun test packages/orchestration-runtime`. Runtime tests cover one/three/five admission, root scope, safe projection, corrupt-ledger quarantine, atomic overlapping saves, bearer/body rejection, normal/Cursor transports, external-runtime unavailability, and deterministic cleanup.
