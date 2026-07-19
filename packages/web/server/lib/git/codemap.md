# packages/web/server/lib/git/

## Responsibility
Git service layer for repository operations, direct commit-message generation, auth credential persistence, git identity storage, and conventional commit template setup used by UI and automation routes.

## Design
- **Facade export**: `index.js` re-exports service, credential, and identity modules as a single API.
- **Separation of concerns**:
  - `service.js`: operational git commands
  - `credentials.js`: credential retrieval/storage flows
  - `identity-storage.js`: author identity persistence
  - `template-routes.js`: global commit template/hook status, install, uninstall, and content endpoints
  - `commit-message.js`: session-free direct Zen generation and conventional-subject validation
- **Route adapter**: `routes.js` maps HTTP requests to service operations.

## Flow
1. Route handlers resolve working directory and requested git operation.
2. Service module executes command flow (often via simple-git/native git).
3. Credential/identity helpers enrich command context and persist updates.
4. Structured results/errors are returned to API consumers.

## Integration
- Called by server route registration and consumed by `src/api/git.ts`.
- Works with GitHub repo parsing/auth modules for remote-aware features.
- Uses filesystem and process-level git binaries through server runtime deps.
