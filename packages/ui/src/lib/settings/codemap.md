# packages/ui/src/lib/settings/

## Responsibility
Settings-domain helpers for defaults, migration, and persistence shaping.

## Design
Separates settings schema logic from view components. `navigation-icons.ts` owns the lightweight, exhaustive settings-page icon map shared by Settings and command navigation so consumers do not import the heavyweight Settings view. `permissions.ts` owns the canonical policy catalog and inheritance helpers; `permission-context.tsx` projects the active page's Edit state into a read-only boundary, with the hook/context isolated in `permission-state.ts` for stable Fast Refresh boundaries.

## Flow
Settings UI reads defaults/current values, applies edits, then persists normalized payloads.

## Integration
Integrated with settings sections, stores, and API endpoints. The exhaustive
metadata/navigation maps expose the cross-runtime `about` page, which hosts
diagnostics health and export controls through `AboutSettings`. They also own
the managed, non-VS-Code-only `bug-reports` page and its Development placement
directly after User Management; the permission catalog defaults its Read/Edit
cell on for every managed role while preserving normal sparse overrides.
