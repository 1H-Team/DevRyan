# packages/web/server/lib/harness/

## Responsibility

Web/Electron host composition for the shared harness runtime. It owns the web
data-root injection, always-on journal, prompt admission/drain gate, durable
worktree records, and the host adapter for persisted shell-command deadline
recovery. Feature modules receive these capabilities by dependency injection.
- `provider-recovery.js` composes shared primary-session recovery and reauthorization over the required native client, plus Express middleware; it has no legacy HTTP fallback. `runtime.js` feeds canonical events before journal trimming and drains the controller. See `docs/PROVIDER_RECOVERY.md`.

- `runtime.js` feeds canonical events with authoritative envelope directories, scoped failure diagnostics and drain into the shared session-change host, independent of optional turn evidence and journal trimming. `server/index.js` wires the private `session_changes` RPC and `/api/openchamber/session/:id/changes` routes.

- `command-deadline-runtime.js` resolves only an explicitly identified native client for exact-message reads, abort and active-session checks. Missing/legacy identities produce no upstream request; the shared deadline controller retains restart and confirmation policy.
