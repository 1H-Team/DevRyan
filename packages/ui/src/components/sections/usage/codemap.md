# packages/ui/src/components/sections/usage/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code session-limit results use a dedicated warning state instead of appearing as authentication or generic provider failures. OpenCode Zen renders one always-green Credits progress row comparing current-month spend with the available balance; monthly-limit and auto-reload details are intentionally hidden. Provider reset inventories use the shared `UsageResetCreditsList`, so Settings, header, surfaces present the same available count and expiry summary.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
