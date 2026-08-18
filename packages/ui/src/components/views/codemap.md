# packages/ui/src/components/views/

## Responsibility
Top-level view containers used by app routes/tabs (chat, settings, git, etc.).

## Design
Container components coordinate layout regions and feature module composition. `lazyViews.tsx` is the single recovery-aware lazy registry and Suspense/error boundary for heavyweight top-level views shared by web and VS Code shells. `SettingsView.tsx` owns the full local/administrator settings shell, while `ManagedSettingsView.tsx` exposes its smaller policy-filtered catalog; both route the managed-only Bug Reports page through a recovery-aware lazy boundary and both expose pending configuration-apply status. `config-apply/ConfigApplyControls.tsx` projects the revisioned pending/waiting/applying/failed/external states into Settings surfaces and exposes wait-until-idle, administrator force, retry, and external acknowledgement without embedding restart policy in UI. `config-apply/useConfigApplyStatusLifecycle.ts` refreshes on Settings visibility and window focus, then keeps the one-second transient-state poll alive from the always-mounted web/Electron and VS Code shells until the host reaches a stable state. `planViewLoader.ts` owns the shared recoverable Plan import so the saved-plan status action can warm only that chunk without importing the full lazy-view registry. `PierreDiffViewer.tsx` keeps unchanged regions collapsed initially; activating any omitted-lines separator switches the selected file revision to full-file rendering in both unified and split layouts. The one-way `DeferredLazyView` gate keeps Multi Run out of initial startup, then preserves the mounted controlled-dialog lifecycle after first activation.

## Flow
Navigation selects a view; view binds data hooks and renders feature sections.

## Integration
Connected to router/state stores and feature component trees.
