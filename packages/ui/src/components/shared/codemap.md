# packages/ui/src/components/shared/

## Responsibility

Small product-level components shared across feature domains but built from the
canonical primitives in `components/ui/`.

## Design

`ProductAudienceTabs.tsx` renders the Coding Agents/Bots labelled tablist with
roving focus and Arrow/Home/End keyboard navigation. Callers own the selected
audience and labelled tab panels; this folder does not own global state.

## Integration

Used by `session/sidebar/SidebarHeader.tsx` and `views/SettingsView.tsx`; the
session-only main-sidebar selection lives in
`stores/useMainSidebarAudienceStore.ts`.
