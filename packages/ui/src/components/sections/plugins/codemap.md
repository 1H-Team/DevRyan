# packages/ui/src/components/sections/plugins/

## Responsibility
Settings section for the three public DevRyan default plugins, existing OpenCode plugin configuration/files, and the explicit DevRyan-managed Slim runtime recovery action.

## Design
- Split Settings section with a grouped sidebar and detail page.
- Sidebar renders the read-only DevRyan defaults first, then groups user/project config entries and plugin files. Config entries/files annotated as a default identity are folded into the default row so effective pins remain visible without duplication.
- Page content displays plugin metadata only; no create, edit, delete, registry, update, or reload controls for arbitrary plugins.
- The Slim Runtime panel is a separate guarded action surface shown only for a Slim plugin selection or the no-selection setup state. Ready setup hides Install and offers Repair; unrelated plugin pages contain only their own metadata.

## Flow
Settings view loads `usePluginsStore` when the Plugins page is active. The store calls `GET /api/config/plugins` for the active directory and exposes the stable default catalog plus read-only config/file lists to the sidebar/page. It also calls `GET /api/config/slim/status`; install/repair buttons are retained as recovery actions and refresh plugin status/lists.

## Integration
Consumes shared plugin API types, `usePluginsStore`, and shared Settings layout primitives. Backend parity is provided by web server routes bridge routing.
