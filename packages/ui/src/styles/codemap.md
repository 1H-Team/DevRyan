# packages/ui/src/styles/

## Responsibility
Contains global CSS layers and styling entrypoints for the UI package.

## Design
Centralized style composition with theme variables and Tailwind-driven utility layers.
`mobile.css` scopes session-row action and leading-title clearance to the same
non-desktop, coarse-pointer widths as its 36px touch targets, excluding drawer
rows. Invisible menu anchors explicitly opt out of that touch minimum.
Project headers reserve space for their actual action count and separate the
trailing New Draft Session button at these same touch widths, including drawers.

## Flow
App bootstrap loads these files once; class tokens and CSS vars cascade to all components.

## Integration
Integrated by app entry modules and theme utilities in lib/theme.
