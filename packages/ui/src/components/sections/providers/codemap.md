# packages/ui/src/components/sections/providers/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code authentication is displayed as structured installation/authentication state; configuration is enabled only after a non-billable status check succeeds, and the unofficial OpenCode proxy relationship is disclosed explicitly. `providerOAuth.ts` normalizes provider OAuth responses, preserves OpenCode's automatic-vs-code callback contract, and provides catalog-readiness helpers used by the settings flow.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs. Automatic provider OAuth starts the callback request immediately, waits for browser or device authorization, reloads OpenCode, and only reports success after both global and active-directory provider catalogs expose models. Provider disconnect mutations include the shared-host CSRF proof and delegate Google alias and synthetic Antigravity cleanup to the host runtime.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
