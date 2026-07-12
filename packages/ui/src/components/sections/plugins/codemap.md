# packages/ui/src/components/sections/plugins/

## Responsibility
Settings section for existing OpenCode plugin configuration and plugin files plus the explicit DevRyan-managed Slim runtime setup action.

## Design
- Split Settings section with a grouped sidebar and detail page.
- Sidebar groups user/project config entries and user/project plugin files.
- Page content displays plugin metadata only; no create, edit, delete, registry, update, or reload controls for arbitrary plugins.
- The Slim Runtime panel is a separate guarded action surface shown only for a Slim plugin selection or the no-selection setup state. Ready setup hides Install and offers Repair; unrelated plugin pages contain only their own metadata.

## Flow
Settings view loads `usePluginsStore` when the Plugins page is active. The store calls `GET /api/config/plugins` for the active directory and exposes stable read-only lists to the sidebar/page. It also calls `GET /api/config/slim/status`; install/repair buttons call the matching Slim setup endpoints and then refresh plugin status/lists.

## Integration
Consumes shared plugin API types, `usePluginsStore`, and shared Settings layout primitives. Backend parity is provided by web server routes and VS Code bridge routing.
