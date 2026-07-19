# packages/ui/src/components/views/

## Responsibility
Top-level view containers used by app routes/tabs (chat, settings, git, etc.).

## Design
Container components coordinate layout regions and feature module composition. `lazyViews.tsx` is the single recovery-aware lazy registry and Suspense/error boundary for heavyweight top-level views shared by web and VS Code shells. `planViewLoader.ts` owns the shared recoverable Plan import so the saved-plan status action can warm only that chunk without importing the full lazy-view registry. The one-way `DeferredLazyView` gate keeps Multi Run out of initial startup, then preserves the mounted controlled-dialog lifecycle after first activation.

## Flow
Navigation selects a view; view binds data hooks and renders feature sections.

## Integration
Connected to router/state stores and feature component trees.
