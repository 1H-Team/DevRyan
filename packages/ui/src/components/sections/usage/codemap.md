# packages/ui/src/components/sections/usage/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code session-limit results use a dedicated warning state instead of appearing as authentication or generic provider failures. OpenCode Zen renders one always-green Credits progress row comparing current-month spend with the available balance; monthly-limit and auto-reload details are intentionally hidden. Provider reset inventories use the shared `UsageResetCreditsList`, so Settings, header, surfaces present the same available count and expiry summary.

`ProviderUsagePanel.tsx` is the single usage view per quota provider (notices, windows, reset credits, model quotas grouped by family, Show in Header). Providers embeds it inline (`variant="section"`, model groups folded) and scopes its permission: personal usage controls stay usable on a read-only Providers page when `usage` is editable, and are blocked by a nested `usage` boundary otherwise. `UsageOptionsMenu.tsx` owns the global display preferences (faster auto-refresh and interval, used vs remaining, prediction rows). `UsagePage`/`UsageSidebar` remain as the standalone fallback for accounts that may read usage but not providers.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
