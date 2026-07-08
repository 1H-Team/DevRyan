import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const headerSource = () => readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');

describe('Header usage dropdown', () => {
  test('renders usage as provider tabs with a selected provider panel', () => {
    const source = headerSource();

    expect(source).toContain("import { UsageProviderTabs } from '@/components/layout/usage/UsageProviderTabs'");
    expect(source).toContain("import { UsageProviderPanel } from '@/components/layout/usage/UsageProviderPanel'");
    expect(source).toContain('activeUsageProviderId');
    expect(source).toContain('resolvedActiveUsageProviderId');
    expect(source).toContain('<UsageProviderTabs');
    expect(source).toContain('<UsageProviderPanel');
  });

  test('preserves Antigravity as model-only usage rows before rendering the selected provider', () => {
    const source = headerSource();

    expect(source).toContain("const isAntigravityProvider = provider.id === 'antigravity'");
    expect(source).toContain('const entries = isAntigravityProvider ? [] : Object.entries(windows)');
    expect(source).toContain('group.modelRows = [...(group.modelRows ?? []), ...familyModels]');
  });
});
