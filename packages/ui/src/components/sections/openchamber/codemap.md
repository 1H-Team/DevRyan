# packages/ui/src/components/sections/openchamber/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, desktop native settings, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs. Desktop-only components such as `DesktopKeepAwakeSettings.tsx` and `DesktopNetworkSettings.tsx` appear only for the local desktop origin.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
