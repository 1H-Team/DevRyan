# packages/web/server/lib/harness/

## Responsibility

Web/Electron host composition for the shared harness runtime. It owns the web
data-root injection, always-on journal, prompt admission/drain gate, durable
worktree records, and the host adapter for persisted shell-command deadline
recovery. Feature modules receive these capabilities by dependency injection.
- `provider-recovery.js` composes shared primary-session recovery and reauthorization, plus Express middleware. `runtime.js` feeds canonical events before journal trimming and drains the controller. See `docs/PROVIDER_RECOVERY.md`.
