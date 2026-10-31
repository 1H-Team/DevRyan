import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';

import { sanitizeWebSettings } from '@/lib/persistence';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getVisibleUsageProviders } from './usage-provider-visibility';
// Server-side sanitizer, exercised here beside its UI twin.
// @ts-expect-error -- untyped server module
import { createSettingsHelpers } from '../../../../../web/server/lib/opencode/settings-helpers.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../../../..');
const source = (fileName: string) => readFileSync(resolve(testDir, fileName), 'utf8');
const repoSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), 'utf8');

const identity = (value: unknown) => value;
const serverDependencies = {
  normalizePathForPersistence: identity, normalizeDirectoryPath: identity, normalizeTunnelBootstrapTtlMs: identity,
  normalizeTunnelSessionTtlMs: identity, normalizeTunnelProvider: identity, normalizeTunnelMode: identity,
  normalizeOptionalPath: identity, normalizeManagedRemoteTunnelHostname: identity,
  normalizeManagedRemoteTunnelPresets: () => undefined, normalizeManagedRemoteTunnelPresetTokens: () => undefined,
  sanitizeTypographySizesPartial: () => undefined, normalizeStringArray: identity, sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined, sanitizeHiddenSkills: () => undefined, sanitizeProjects: () => undefined,
};

describe('Provider usage panel rows', () => {
  test('uses shared Claude window ordering and provider-aware labels for overall usage rows', () => {
    const pageSource = source('ProviderUsagePanel.tsx');

    expect(pageSource).toContain('sortUsageEntries(quotaProviderId');
    expect(pageSource).toContain('overallUsageEntries.map');
    expect(pageSource).toContain('displayTitle={formatProviderWindowLabel(quotaProviderId, label)}');
  });

  test('the standalone Usage page renders the shared provider usage panel', () => {
    const pageSource = source('UsagePage.tsx');

    expect(pageSource).toContain('<ProviderUsagePanel key={selectedProviderId} quotaProviderId={selectedProviderId} variant="page" />');
  });

  // UsageCard's displayTitle/subtitle and description rendering: UsageCard.render.test.tsx.
  test('shows model names as model row titles while keeping window labels for calculations', () => {
    const pageSource = source('ProviderUsagePanel.tsx');

    expect(pageSource).toContain('displayTitle={modelDisplay.displayName}');
    expect(pageSource).toContain('subtitle={modelDisplay.contextLabel}');
  });

  // Value-only rows hide progress: UsageCard.render.test.tsx.
  test('retains provider rows while rendering non-fatal warnings', () => {
    const pageSource = source('ProviderUsagePanel.tsx');

    expect(pageSource).toContain('result?.warnings ?? []');
    expect(pageSource).toContain('providerWarnings.map');
  });

  test('renders the shared reset bank independently of overall usage windows', () => {
    const pageSource = source('ProviderUsagePanel.tsx');

    expect(pageSource).toContain("import { UsageResetCreditsList } from '@/components/layout/usage/UsageResetCreditsList'");
    expect(pageSource).toContain("usage?.resetCredits || result?.source === 'codex-app-server' && usage?.resetCredits === null");
    expect(pageSource).toContain('<UsageResetCreditsList resetCredits={usage?.resetCredits ?? null} />');
  });

  // The success-toned card itself: UsageSidebar.test.tsx 'supports an always-green OpenCode Credits card'.
  test('forces only the OpenCode Credits progress row to use the success tone', () => {
    const pageSource = source('ProviderUsagePanel.tsx');

    expect(pageSource).toContain("quotaProviderId === 'opencode' && label === 'credits' ? 'success' : 'adaptive'");
  });

  test('keeps Cursor selectable in Usage while its usage token is missing', () => {
    const pageSource = source('UsagePage.tsx');

    expect(pageSource).toContain("selectedProviderId === 'cursor-acp'");
    const ids = (results: Parameters<typeof getVisibleUsageProviders>[0]) => getVisibleUsageProviders(results).map((provider) => provider.id);
    expect(ids([{ providerId: 'cursor-acp', configured: false }])).toContain('cursor-acp');
    expect(ids([{ providerId: 'claude-agent', configured: false }])).not.toContain('claude-agent');
    expect(ids([])).not.toContain('cursor-acp');
  });

  test('renders every provider through model families without a retired flat-row path', () => {
    const pageSource = source('ProviderUsagePanel.tsx');

    expect(pageSource).toContain('renderModelCard(model)');
    expect(pageSource).not.toContain("'antigravity'");
  });

  test('usage options menu persists usageShowPredValues', () => {
    const optionsSource = source('UsageOptionsMenu.tsx');

    expect(optionsSource).toContain('setShowPredictionValues');
    expect(optionsSource).toContain('usageShowPredValues: enabled');
    expect(optionsSource).toContain('settings.usage.sidebar.field.showPredictionRows');
    expect(optionsSource).toContain('settings.usage.sidebar.field.displayModeUsage');
    expect(source('UsageSidebar.tsx')).toContain('<UsageOptionsMenu');
    expect(source('ProviderUsagePanel.tsx')).toContain('<UsageOptionsMenu');
  });

  describe('prediction visibility setting', () => {
    const originalFetch = globalThis.fetch;
    const initialQuota = useQuotaStore.getState();
    afterEach(() => { globalThis.fetch = originalFetch; useQuotaStore.setState(initialQuota, true); });

    const loadWith = async (settings: Record<string, unknown>): Promise<boolean> => {
      globalThis.fetch = Object.assign(async () => Response.json(settings), { preconnect: () => {} });
      useQuotaStore.setState({ showPredictionValues: !('usageShowPredValues' in settings && settings.usageShowPredValues === true) });
      await useQuotaStore.getState().loadSettings();
      return useQuotaStore.getState().showPredictionValues;
    };

    test('the quota store defaults prediction visibility to true and honours a saved boolean', async () => {
      expect(await loadWith({})).toBe(true);
      expect(await loadWith({ usageShowPredValues: false })).toBe(false);
      expect(await loadWith({ usageShowPredValues: true })).toBe(true);
      expect(await loadWith({ usageShowPredValues: 'no' })).toBe(true);
    });
  });

  test('sanitizers accept boolean usageShowPredValues', () => {
    const server = createSettingsHelpers(serverDependencies);
    for (const value of [true, false]) {
      expect(sanitizeWebSettings({ usageShowPredValues: value })?.usageShowPredValues).toBe(value);
      expect(server.sanitizeSettingsUpdate({ usageShowPredValues: value }).usageShowPredValues).toBe(value);
    }
  });

  test('sanitizers reject non-boolean usageShowPredValues', () => {
    const server = createSettingsHelpers(serverDependencies);
    for (const value of ['true', 1, null, {}]) {
      expect(sanitizeWebSettings({ usageShowPredValues: value })?.usageShowPredValues).toBeUndefined();
      expect('usageShowPredValues' in server.sanitizeSettingsUpdate({ usageShowPredValues: value })).toBe(false);
    }
  });

  test('Providers page uses the reusable managed quota credential controls', () => {
    const providersPageSource = repoSource('packages/ui/src/components/sections/providers/ProvidersPage.tsx');
    const managedCredentialsSource = repoSource('packages/ui/src/components/sections/providers/ManagedQuotaCredentials.tsx');

    expect(providersPageSource).toContain('ManagedQuotaCredentials');
    expect(managedCredentialsSource).toContain('/api/quota/credentials/');
    const managedCredentialSupportSource = repoSource('packages/ui/src/components/sections/providers/managedQuotaCredentialSupport.ts');
    expect(managedCredentialSupportSource).toContain("'ollama-cloud' | 'cursor-acp' | 'opencode'");
    expect(managedCredentialsSource).toContain('<OpenCodeZenCredentials />');
    expect(managedCredentialsSource).not.toContain('opencode-zen-auth-cookie');
    expect(managedCredentialsSource).not.toContain('opencode-go-usage-auth-cookie');
    expect((settingsDict as Record<string, string>)['settings.providers.page.auth.ollamaCloudUsageTitle']).toBeTruthy();
  });
});
