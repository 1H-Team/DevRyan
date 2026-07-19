# packages/ui/src/lib/theme/themes/

## Responsibility
Defines the DevRyan Default palettes and the pinned built-in palette catalog consumed by the UI theming engine. Catalog composition swaps the dark Default and JetBrains presentation payloads while preserving their stable IDs and metadata.

## Design
Theme-per-file exports with semantic token naming rather than component-specific colors.

## Flow
Theme loader selects a palette, resolves token maps, and injects CSS variable values.

## Integration
Used by lib/theme and rendered globally through app/style entrypoints.
