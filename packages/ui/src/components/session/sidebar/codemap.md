# packages/ui/src/components/session/sidebar/

## Responsibility
Session sidebar UI for listing, selecting, grouping, and managing conversations.

## Design
Composed list/item components plus hook-driven state derivation. Session rows use
the narrow creation-time routing hint before raw server directory metadata so
filesystem aliases cannot create a second passive child store. Middle-click row
behavior is resolved by `sessionRowAuxAction.ts`: active rows archive, genuine
archived rows permanently delete, and archived structural ancestors remain inert.
Managed child rows resolve their icon agent from the scheduler's exact child-task
leaf before falling back to provider session metadata, keeping task-card and
sidebar role colors consistent without subscribing the sidebar to child messages.
`lazySessionDialogs.tsx`
owns recovery-aware declarations for sidebar search, project/worktree/task management,
and confirmation dialogs. `SessionSidebar` defers their first mount until the authoritative
open/value state activates, then retains the controlled roots across close so primitive exit,
focus, and New Worktree teardown behavior remain intact.

## Flow
Session entities from stores become sidebar rows; user actions dispatch store/API updates.
Archived rows, auto-folders, and cleanup share one deepest-directory ownership map built from registered projects and known worktrees.
Worktree headers resolve their visible identity from the branch only. Their cleanup path archives sessions through `branchSessionCleanup.ts` and never calls a Git mutation API; PR discovery and presentation remain in the right-sidebar Git view.

## Integration
Integrated with session hooks/stores and navigation/layout components.
