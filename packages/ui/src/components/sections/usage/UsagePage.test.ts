import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../../../..');
const source = (fileName: string) => readFileSync(resolve(testDir, fileName), 'utf8');
const repoSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), 'utf8');

describe('UsagePage model rows', () => {
  test('shows model names as model row titles while keeping window labels for calculations', () => {
    const cardSource = source('UsageCard.tsx');
    const pageSource = source('UsagePage.tsx');

    expect(cardSource).toContain('displayTitle?: string');
    expect(pageSource).toContain('displayTitle={modelDisplay.displayName}');
    expect(pageSource).toContain('subtitle={modelDisplay.contextLabel}');
  });

  test('renders optional usage window descriptions below usage titles', () => {
    const cardSource = source('UsageCard.tsx');

    expect(cardSource).toContain('description?: string');
    expect(cardSource).toContain('window.description');
  });

  test('hides provider-level summary windows for Antigravity usage', () => {
    const pageSource = source('UsagePage.tsx');

    expect(pageSource).toContain("selectedProviderId !== 'antigravity'");
  });

  test('keeps Cursor selectable in Usage while its usage token is missing', () => {
    const pageSource = source('UsagePage.tsx');
    const sidebarSource = source('UsageSidebar.tsx');

    expect(pageSource).toContain("selectedProviderId === 'cursor-acp'");
    expect(sidebarSource).toContain("provider.id === 'cursor-acp'");
    expect(sidebarSource).toContain('configuredByProviderId.has(provider.id)');
  });

  test('renders Antigravity model rows as a flat selected model list', () => {
    const pageSource = source('UsagePage.tsx');

    expect(pageSource).toContain("selectedProviderId === 'antigravity'");
    expect(pageSource).toContain('renderModelCard(model)');
    expect(pageSource).toContain('providerModels.map((model) => renderModelCard(model))');
  });

  test('Usage card source gates PaceIndicator on prediction visibility', () => {
    const cardSource = source('UsageCard.tsx');

    expect(cardSource).toContain('showPredictionValues');
    expect(cardSource).toContain('showPredictionValues && displayState.paceInfo');
    expect(cardSource).toContain('<PaceIndicator paceInfo={displayState.paceInfo} displayMode={displayMode} />');
  });

  test('sidebar source persists usageShowPredValues', () => {
    const sidebarSource = source('UsageSidebar.tsx');

    expect(sidebarSource).toContain('setShowPredictionValues');
    expect(sidebarSource).toContain('usageShowPredValues: enabled');
    expect(sidebarSource).toContain('settings.usage.sidebar.field.showPredictionRows');
    expect(sidebarSource).toContain('resolveUsageDisplayModeLabel');
    expect(sidebarSource).toContain('settings.usage.sidebar.field.displayModeUsage');
  });

  test('quota store source defaults prediction visibility to true', () => {
    const storeSource = repoSource('packages/ui/src/stores/useQuotaStore.ts');

    expect(storeSource).toContain('showPredictionValues: boolean');
    expect(storeSource).toContain('data?.usageShowPredValues');
    expect(storeSource).toContain(': true');
  });

  test('sanitizers accept boolean usageShowPredValues', () => {
    const webSettingsSource = repoSource('packages/web/server/lib/opencode/settings-helpers.js');
    const vscodeSettingsSource = repoSource('packages/vscode/src/bridge-settings-runtime.ts');
    const persistenceSource = repoSource('packages/ui/src/lib/persistence.ts');

    expect(webSettingsSource).toContain('typeof candidate.usageShowPredValues === \'boolean\'');
    expect(webSettingsSource).toContain('result.usageShowPredValues = candidate.usageShowPredValues');
    expect(vscodeSettingsSource).toContain('typeof restChanges.usageShowPredValues !== \'boolean\'');
    expect(persistenceSource).toContain('typeof candidate.usageShowPredValues === \'boolean\'');
    expect(persistenceSource).toContain('result.usageShowPredValues = candidate.usageShowPredValues');
  });

  test('sanitizers reject non-boolean usageShowPredValues', () => {
    const webSettingsSource = repoSource('packages/web/server/lib/opencode/settings-helpers.js');
    const vscodeSettingsSource = repoSource('packages/vscode/src/bridge-settings-runtime.ts');
    const persistenceSource = repoSource('packages/ui/src/lib/persistence.ts');

    expect(webSettingsSource).not.toContain('result.usageShowPredValues = candidate.usageShowPredValues ??');
    expect(vscodeSettingsSource).toContain('delete restChanges.usageShowPredValues');
    expect(persistenceSource).not.toContain('result.usageShowPredValues = candidate.usageShowPredValues ??');
  });

  test('Providers page uses the reusable managed quota credential controls', () => {
    const providersPageSource = repoSource('packages/ui/src/components/sections/providers/ProvidersPage.tsx');
    const managedCredentialsSource = repoSource('packages/ui/src/components/sections/providers/ManagedQuotaCredentials.tsx');
    const messages = repoSource('packages/ui/src/lib/i18n/messages/en.settings.ts');

    expect(providersPageSource).toContain('ManagedQuotaCredentials');
    expect(managedCredentialsSource).toContain('/api/quota/credentials/');
    expect(managedCredentialsSource).toContain("'opencode-go' | 'ollama-cloud' | 'cursor-acp'");
    expect(messages).toContain('settings.providers.page.auth.openCodeGoUsageTitle');
    expect(messages).toContain('settings.providers.page.auth.ollamaCloudUsageTitle');
  });
});
