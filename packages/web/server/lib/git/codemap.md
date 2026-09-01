# packages/web/server/lib/git/

## Responsibility
Git service layer for repository operations, direct commit-message and PR-description generation, auth credential persistence, git identity storage, and conventional commit template setup used by UI and automation routes.

## Design
- **Facade export**: `index.js` re-exports service, credential, and identity modules as a single API.
- **Separation of concerns**:
  - `service.js`: operational git commands
  - `integrate.js`: server-owned commit reintegration planning, temporary
    worktree lifecycle, conflict continuation, cleanup, and the
    `isIntegrateTempPath` predicate used to keep those worktrees out of the
    managed-project registry
  - `worktree-lock-recovery.js`: bounded, identity-safe worktree index-lock recovery
  - `@openchamber/harness-runtime/lib/git-post-checkout-hook.js`: shared effective-path resolution and bounded post-checkout hook runner
  - `credentials.js`: credential retrieval/storage flows
  - `identity-storage.js`: author identity persistence
  - `template-routes.js`: global commit template/hook status, install, uninstall, and content endpoints
  - `commit-message.js`: session-free direct Zen generation and conventional-subject validation
  - `commit-message-context.js`: bounded authoritative context collection for the single-request draft route
  - `pr-description.js`: session-free direct free-Zen PR title/body generation
- **Route adapter**: `routes.js` maps HTTP requests to service operations.
- **Durable worktree host**: `service.js` injects Git/setup/project effects into
  `@openchamber/harness-runtime`; durable state and retry policy do not live in
  server-local maps.

## Flow
1. Route handlers resolve working directory and requested git operation.
2. The commit-message draft route collects status/history concurrently and selected changes with at most two bounded batch diffs inside the host; other operations delegate directly to the service module.
3. Service modules execute command flow (often via simple-git/native git), while credential/identity helpers enrich command context and persist updates.
4. Structured results/errors are returned to API consumers; commit generation also records sanitized phase timings and emits `Server-Timing`.

## Integration
- Called by server route registration and consumed by `src/api/git.ts`.
- Managed chat and scheduled-task branch attachment is orchestrated by `../multi-user/branch-target.js`, which consumes `getBranches`, `getStatus`, `getWorktrees`, and `createWorktree` without switching a shared checkout.
- Works with GitHub repo parsing/auth modules for remote-aware features.
- Uses filesystem and process-level git binaries through server runtime deps.
