# packages/ui/src/components/sections/providers/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code authentication is displayed as structured installation/authentication state; configuration is enabled only after a non-billable status check succeeds, and the unofficial OpenCode proxy relationship is disclosed explicitly.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
