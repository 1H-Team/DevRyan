# packages/ui/src/components/sections/providers/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. Claude Code authentication is displayed as structured installation/authentication state; configuration is enabled only after a non-billable status check succeeds, and the unofficial OpenCode proxy relationship is disclosed explicitly. Claude providers also expose the persistent managed-runtime compatibility switch: combined prompting is normal, while Claude-only prompting is an explicit fallback for Anthropic's third-party-usage classifier. `ManagedQuotaCredentials.tsx` keeps OpenCode Zen workspace/cookie setup non-prefilled and reuses the cross-runtime managed credential routes. `providerOAuth.ts` normalizes provider OAuth responses, preserves OpenCode's automatic-vs-code callback contract, and provides catalog-readiness helpers used by the settings flow.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs. Automatic provider OAuth starts the callback request immediately, waits for browser or device authorization, reloads OpenCode, and only reports success after both global and active-directory provider catalogs expose models. `providerConnectionState.ts` is the shared sidebar/detail source of truth: Google and the retired Antigravity entry require an actual auth/config source, disconnect removes global plus the explicitly supplied active-project source, and a revision-keyed pending state keeps the stale catalog row visible but disabled until OpenCode applies the provider invalidation. After apply, source and catalog refreshes move disconnected providers into Connect Provider while the existing model-selection resolver preserves a valid selection.

## Integration
Integrated with views, lib adapters, and settings/auth stores.

- `providerCatalogConnection.ts` owns credential-free pending API-key connections and the bounded catalog-readiness loop shared with OAuth. Settings keep a pending row visible, retry after configuration application, and clear pending state after readiness or disconnect. `useConfigStore.loadProviders` treats explicit `directory: null` as global and prevents older requests from overwriting a forced refresh.
- `OpenCodeZenCredentials.tsx` connects OpenCode Zen usage through OpenCode Console device sign-in (start, interval-paced poll, cancel on abandon), shows only the connected workspace ID, and asks retired dashboard credentials to reconnect. `managedQuotaCredentialSupport.ts` holds the shared status type, safe error parsing, and post-change quota refresh.
- `ManagedQuotaCredentials.tsx` routes `opencode` to `OpenCodeZenCredentials` and separates saved/validated status from usage-refresh errors, displays safe server errors inline, and preserves existing credentials on rejected replacements. Its mounted fixture tests exercise save, discovery, refresh failure/recovery, and remount without reading user credentials.

Antigravity (`opencode-antigravity-auth`) is retired: it is no longer an addable provider, Google models are no longer split into a virtual Antigravity provider, and its quota surfaces are gone. `retiredProviders.ts` appends a model-less Antigravity entry to the provider list only so leftover account files or plugin-written config can still be disconnected; it stays hidden while its sources load and whenever none remain.
