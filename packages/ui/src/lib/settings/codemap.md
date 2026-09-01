# packages/ui/src/lib/settings/

## Responsibility
Settings-domain helpers for defaults, migration, and persistence shaping.

## Design
Separates settings schema logic from view components. `navigation-icons.ts` owns the lightweight, exhaustive settings-page icon map shared by Settings and command navigation so consumers do not import the heavyweight Settings view. `permissions.ts` owns the canonical policy catalog and inheritance helpers; `permission-context.tsx` projects the active page's Edit state into a read-only boundary, with the hook/context isolated in `permission-state.ts` for stable Fast Refresh boundaries. `notificationTemplates.ts` owns the total six-event renderer shape and preserves valid entry identities while repairing sparse or malformed persisted snapshots.

## Flow
Settings UI reads defaults/current values, applies edits, then persists normalized payloads.

## Integration
Integrated with settings sections, stores, and API endpoints. The exhaustive
metadata/navigation maps expose the cross-runtime `about` page, which hosts
diagnostics health and export controls through `AboutSettings`. They also own
the managed, non-VS-Code-only `bug-reports` page and its Development placement
directly after User Management; the permission catalog defaults its Read/Edit
cell on for every managed role while preserving normal sparse overrides.
The same maps keep the stable `mcp` slug/deep links while displaying **MCP
Servers** and place it immediately after Plugins in Workflow navigation.
`navigation.ts` also models grouped sidebar destinations without merging their
permission identities: Providers contains the `providers` and `usage` tabs,
while Remote Connections contains `tunnel` and `remote-instances`, making the
tunnel the default child. Runtime and
permission filtering selects the first available child, and the existing child
slugs remain the persistence/deep-link contract. About is the final Development
destination after Projects.
Global Coding Agent Skills/MCP visibility remains governed here and in
`components/views/SettingsView.access.ts`. Bot-specific Skills live only in the
Bot Resources tab; Bots have no MCP assignment destination.
