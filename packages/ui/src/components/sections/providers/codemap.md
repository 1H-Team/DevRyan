# packages/ui/src/components/sections/providers/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code authentication is displayed as structured installation/authentication state; configuration is enabled only after a non-billable status check succeeds, and the unofficial OpenCode proxy relationship is disclosed explicitly. Claude providers also expose the persistent managed-runtime compatibility switch: combined prompting is normal, while Claude-only prompting is an explicit fallback for Anthropic's third-party-usage classifier. `ManagedQuotaCredentials.tsx` keeps OpenCode Zen workspace/cookie setup non-prefilled and reuses the cross-runtime managed credential routes. `providerOAuth.ts` normalizes provider OAuth responses, preserves OpenCode's automatic-vs-code callback contract, and provides catalog-readiness helpers used by the settings flow.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs. Automatic provider OAuth starts the callback request immediately, waits for browser or device authorization, reloads OpenCode, and only reports success after both global and active-directory provider catalogs expose models. `providerConnectionState.ts` is the shared sidebar/detail source of truth: Google and synthetic Antigravity require an actual auth/config source, disconnect removes global plus the explicitly supplied active-project source, and a revision-keyed pending state keeps the stale catalog row visible but disabled until OpenCode applies the provider invalidation. After apply, source and catalog refreshes move disconnected providers into Connect Provider while the existing model-selection resolver preserves a valid selection.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
