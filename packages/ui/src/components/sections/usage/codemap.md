# packages/ui/src/components/sections/usage/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code session-limit results use a dedicated warning state instead of appearing as authentication or generic provider failures.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
