# packages/ui/src/lib/settings/

## Responsibility
Settings-domain helpers for defaults, migration, and persistence shaping.

## Design
Separates settings schema logic from view components. `navigation-icons.ts` owns the lightweight, exhaustive settings-page icon map shared by Settings and command navigation so consumers do not import the heavyweight Settings view.

## Flow
Settings UI reads defaults/current values, applies edits, then persists normalized payloads.

## Integration
Integrated with settings sections, stores, and API endpoints. The exhaustive
metadata/navigation maps expose the cross-runtime `about` page, which hosts
diagnostics health and export controls through `AboutSettings`.
