# packages/ui/src/lib/worktrees/

## Responsibility
Worktree/repository-context helpers for multi-directory workflows.

## Design
Utilities normalize worktree identifiers, switching semantics, and cached primary-root/root-branch lookups.

## Flow
Directory context changes are processed and propagated to session/navigation state.
Git root and root-branch reads use bounded in-memory caches with explicit invalidation after worktree mutations.
`useWorktreeDiscovery` lists project worktrees through the revisioned discovery cache (`worktreeDiscovery.ts`). Mutations read through the cache. A grant change re-filters the last listing without any git work. A forced `git worktree list` runs in three cases:
- on the main window's 90-second poll while the window is visible;
- when a window returns after 60 seconds;
- when the network comes back online.

A requested forced listing stays pending until one runs, and a refresh that was skipped while the window was hidden runs on return. Persisted worktree history is merged once per mount. Directory switches never list worktrees, and the mini chat passes `{ poll: false }`.

## Integration
Integrated with git/session modules and project selectors.
