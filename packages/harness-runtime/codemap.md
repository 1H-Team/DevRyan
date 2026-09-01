# packages/harness-runtime/

## Responsibility

Dependency-free shared Node runtime for durable DevRyan harness state,
diagnostics, lifecycle correlation, worktree operations, and optional turn
evidence. Web/Electron and VS Code are hosts; the renderer consumes only host
API contracts.

## Where to change things

- Primary provider liveness, durable attempt/cancellation fences and read-only recovery: `lib/provider-recovery.js`, `lib/provider-recovery-policy.js`; shared host HTTP adapter: `lib/provider-recovery-host.js`.

- Atomic private persistence and cross-process file locking: `lib/atomic-file.js`, `lib/record-store.js`
- Host storage layout: `lib/paths.js`
- Turn correlation: `lib/lifecycle.js`
- Worktree receipts: `lib/worktree-bootstrap.js`
- Worktree post-checkout execution: `lib/git-post-checkout-hook.js`
- Session attribution: `lib/session-id.js`
- Hot-event trim/coalescing policy: `lib/journal-trim.js`
- Sanitization/session-partitioned journal/export: `lib/sanitizer.js`, `lib/journal.js`, `lib/export.js`
- Git evidence: `lib/evidence-git.js`, `lib/evidence-ledger.js`,
  `lib/evidence-runtime.js`
- Diagnostic export selection/ZIP adapter: `lib/export.js`
