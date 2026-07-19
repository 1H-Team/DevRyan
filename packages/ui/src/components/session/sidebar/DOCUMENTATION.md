# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar is now a single multi-project tree: `recent` top section, then projects, then worktrees/archived groups, then sessions.
- `NavRail` is no longer part of sidebar/navigation flow.
- Project headers now own root sessions directly; there is no separate rendered `project root` subgroup.
- Active/hover row styling is text-first; selected sessions use primary text instead of background fills.
- Archived groups are collapsed by default on cold load/refresh, preserve their collapsed state when sessions are archived into them, and support bulk deletion at group/folder level.
- Archived project ownership is resolved once from registered project roots and known worktrees. An explicit session directory maps to the deepest matching registered directory; project/worktree metadata is a fallback, and no-directory child sessions inherit their parent's owner. Archived lists, auto-folders, and folder cleanup consume the same ownership map so nested projects cannot duplicate or delete each other's folder entries.
- Session rows support compact inline dates in minimal mode and simplified metadata in default mode.
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI for add-project, session search, and display mode.
- `SidebarActivitySections.tsx`: Global top section renderer; currently used for the `recent` section only.
- `SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, and about actions.
- `SidebarProjectsList.tsx`: Main scrollable tree renderer for projects, root sessions, worktrees/groups, and empty/search states.
- `SessionGroupSection.tsx`: Renders a single worktree/archived group, collapse/expand, folder subtree, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, nested children, and leaf subscriptions to its creation-time directory routing hint and manual managed-child recovery. Middle-click archives active sessions and permanently deletes genuine archived sessions through the existing confirmation-aware hard-delete path; archived structural ancestor rows remain inert. The routing hint wins over a server-returned textual path alias before the row selects a child store; sessions without a hint retain the server/group-directory fallbacks. Explicit-directory row subscriptions may read a passive cached sync store but do not bootstrap an inactive directory. Managed-child recovery uses the existing red leading error dot and intentionally takes precedence over selected/read/working state and the `notifyOnSubtasks` preference until the failed result is acknowledged; a later failed manual retry restores it.
- `sessionRowAuxAction.ts`: Pure resolver for active/archive/ancestor middle-click behavior, kept outside the component module so the row remains a React fast-refresh-safe boundary.
- `sidebarChildHydration.ts`: Pure target selection for root-session child discovery. Automatic targets are capped and restricted to the current directory before a sync child store can be bootstrapped.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Prefetches messages for nearby/active sessions to improve perceived load speed.
- `hooks/useSidebarUserActivityHydration.ts`: Restores historical user-message recency for root sessions in the current directory; inactive projects use deterministic session metadata until selected or updated live.
- `hooks/useSidebarArchivedAssistantActivityHydration.ts`: Restores archived assistant-response recency from any safe cached messages, but performs network hydration only for the current directory.
- `hooks/useDirectoryStatusProbe.ts`: Probes and caches directory existence status for session/path indicators.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useGroupOrdering.ts`: Applies persisted/custom group order with stable fallback ordering; archived groups are reorderable.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/pinned/group order/active session) to storage + desktop settings.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Builds live and archived session lists for a given project (including worktrees + dedupe); archived lists consume the shared deepest-project ownership map.
- `hooks/useSessionFolderCleanup.ts`: Cleans stale folder session IDs by reconciling known sessions/archived scopes.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `activitySections.ts`: Persisted top-section storage/helpers for the current `recent` session list.
- `utils.tsx`: Shared sidebar utilities (path normalization and hint-first session routing, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting).

## Directory activation boundary

OpenCode runtime state is directory-owned, and the first scoped API request for a
directory can initialize configured local MCP servers. Sidebar enrichment must
therefore not activate every project/worktree merely to improve ordering or
prefetch data. Historical activity fetches, child discovery, and automatic
neighbor prefetch are restricted to the current directory using normalized,
case-insensitive path comparison. Global session metadata and existing cached
state, including passive row subscriptions, still render inactive projects.
Provider setup and reconnect/replay recovery also select only the current store.
Selecting a project/session changes the current directory and is the explicit
edge that enables its normal bootstrap.
