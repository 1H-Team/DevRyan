# packages/web/server/lib/harness/

## Responsibility

Web/Electron host composition for the shared harness runtime. It owns the web
data-root injection, always-on journal, prompt admission/drain gate, durable
worktree records, and the host adapter for persisted shell-command deadline
recovery. Feature modules receive these capabilities by dependency injection.
