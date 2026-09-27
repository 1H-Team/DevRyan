# packages/ui/src/components/sections/shared/

## Responsibility
Reusable section primitives used across Settings subsections.

## Design
Common form rows, labels, toggles, and wrappers enforce consistent settings UX.
`SettingsSidebarHeader` renders a titled block (title actions, a controls slot
for search or project selection, count and add button); `SidebarGroup` is the
flat, persisted, collapsible top-level group. Detail pages compose
`SettingsDetailHeader` (icon, title, badges, subtitle, wrapping actions),
`SettingsDetailSection` (plain or card body), `SettingsBadge` (theme status
tones) and `SettingsEmptyState` (sidebar or page placeholder).

## Flow
Feature sections compose shared primitives, pass values/actions, and render standardized layouts.

## Integration
Imported by most components/sections/* modules and tied to theme/ui primitives.
