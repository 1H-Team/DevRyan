# packages/ui/src/components/session/sidebar/hooks/

## Responsibility
Sidebar-specific hooks for session lists, filters, ordering, and selection behavior.

## Design
Hook utilities keep list logic out of sidebar presentational components.
`useSidebarUserActivityHydration.ts` restores missing root prompt recency only
for the active directory with bounded pagination/concurrency and passive child
store writes, so historical ordering never activates inactive runtimes.

## Flow
Hooks subscribe to session stores, derive visible rows, and expose actions/callbacks.
Repository-status hooks debounce root-branch refreshes and resolve only projects whose path or known branch changed.

## Integration
Used by session/sidebar components and fed by sync/session stores.
