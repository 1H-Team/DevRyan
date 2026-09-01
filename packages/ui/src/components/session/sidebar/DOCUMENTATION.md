# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar is now a single multi-project tree: `recent` top section, then projects, then worktrees/archived groups, then sessions.
- `NavRail` is no longer part of sidebar/navigation flow.
- Git projects render the primary checkout branch as a normal icon-bearing group; non-Git sessions remain directly under the project without a synthetic group label.
- Worktree group headers are branch-only. They never fetch, render, link, or decorate GitHub pull requests; pull-request presentation belongs exclusively to the right-sidebar PR tab.
- The worktree-group cleanup action archives every active session and descendant in that branch while preserving the worktree and both local and remote branches. If the active session is archived, navigation returns to the registered project root, and partial archive failures remain visible for retry.
- Runtime controls (collapse/expand, New Chat, New Multi-Run, Scheduled Tasks, and worktree creation) are independent of project-registry administration. Managed developers receive runtime controls while Add Project and project rename/remove remain administrator-only.
- In desktop Bot mode, the Agents/Bots switcher clears the native controls with the compact `--oc-bot-chrome-height` inset instead of inheriting the taller, content-driven conversation header. Mobile drawers keep their existing header and safe-area offsets.
- Managed worktree discovery keeps assigned base branches plus non-root worktrees referenced by the current user's sessions or drafts, so generated Multi-Run branches stay visible without re-exposing an ungranted primary checkout. The root group is hidden unless its real checked-out branch is granted; hidden root sessions therefore cannot become the cold-load selection.
- The footer keeps the assigned GitHub profile as its leftmost control, retries transient startup status failures, retains the last valid avatar on refresh failure, and falls back to the GitHub glyph while an assigned profile is loading or has no usable image. Hover, keyboard focus, or pointer-down on Settings warms only the principal-appropriate settings shell; cold startup remains unchanged.
- Active/hover row styling is text-first; selected sessions use primary text instead of background fills.
- Archived groups are collapsed by default on cold load/refresh, preserve their collapsed state when sessions are archived into them, and support bulk deletion at group/folder level.
- Archived project ownership is resolved once from registered project roots and known worktrees. An explicit session directory maps to the deepest matching registered directory; project/worktree metadata is a fallback, and no-directory child sessions inherit their parent's owner. Archived lists, auto-folders, and folder cleanup consume the same ownership map so nested projects cannot duplicate or delete each other's folder entries.
- Session rows do not render elapsed-time metadata or run row-local clocks. Pinned precedence remains stable, and active root sessions within each pinned/unpinned partition use their latest visible user-prompt timestamp. Assistant streaming, status/title updates, and `session.time.updated` churn do not move rows. Missing prompt history falls back to creation time and then session ID.
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
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, nested children, and leaf subscriptions to its creation-time directory routing hint plus primary/managed recovery attention. Managed child icons use the scheduler's exact latest-task agent leaf before falling back to provider session metadata, so sidebar colors stay aligned with Agent Dispatch without subscribing rows to streaming child messages. Mobile active rows reveal explicit Pin/Unpin and Archive actions after a decisive horizontal left swipe while vertical scrolling and short gestures remain unchanged. Mobile session rows block the parent drawer drag recognizer so row gestures never translate the whole sidebar; non-row drawer space remains swipe-to-close. Middle-click archives active sessions and permanently deletes genuine archived sessions through the existing confirmation-aware hard-delete path; archived structural ancestor rows remain inert. The routing hint wins over a server-returned textual path alias before the row selects a child store; sessions without a hint retain the server/group-directory fallbacks. Explicit-directory row subscriptions may read a passive cached sync store but do not bootstrap an inactive directory. Pending primary recovery and managed-child manual recovery use the existing red leading error dot on the parent/root row. A managed child suppresses its own recovery-related dot, including a generic unread-error duplicate when subtask notifications are enabled; otherwise child rows keep their configured unread error/completion indicators. Acknowledging recovery clears the parent indicator, and a later failed manual retry restores it.
- `subtaskAgentIdentity.ts`: Resolves managed-child icon identity from authoritative scheduler metadata with a provider-session fallback for unmanaged or compacted child tasks.
- `sessionRowAuxAction.ts`: Pure resolver for active/archive/ancestor middle-click behavior, kept outside the component module so the row remains a React fast-refresh-safe boundary.
- `sidebarChildHydration.ts`: Pure target selection for root-session child discovery. Automatic targets are capped and restricted to the current directory before a sync child store can be bootstrapped.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete, branch-session archive, and folder delete flows.
- `branchSessionCleanup.ts`: Typed branch-session archive adapter plus the branch-only group-label resolver.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Runs the active-directory-only intent queue: 180 ms hover, immediate keyboard focus, and previous/next neighbors after a stable 600 ms selection. It cancels abandoned timers, permits one request at a time, and caps pending work at six.
- `hooks/useSidebarUserActivityHydration.ts`: Restores historical root user-prompt recency only for the current directory with bounded pagination/concurrency; inactive directories remain cache-only.
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
- `utils.tsx`: Shared sidebar utilities (path normalization and hint-first session routing, prompt-recency sorting, dedupe, archived scope keys, project relation checks, text highlight, and date labels used outside session rows).

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
