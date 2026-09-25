import { describe, expect, test } from 'bun:test';

import { shouldShowConnectedProvider, type ProviderSources } from './providerConnectionState';
import { isRetiredProviderId, withRetiredProviderEntries } from './retiredProviders';

const sources = (overrides: Partial<ProviderSources> = {}): ProviderSources => ({
  auth: { exists: false },
  user: { exists: false },
  project: { exists: false },
  custom: { exists: false },
  ...overrides,
});

describe('retired provider entries', () => {
  test('appends a model-less Antigravity entry once and never splits Google models', () => {
    const google = { id: 'google', name: 'Google', models: [{ id: 'antigravity-gemini-3-pro' }] };
    const withRetired = withRetiredProviderEntries([google]);

    expect(withRetired.map((provider) => provider.id)).toEqual(['google', 'antigravity']);
    expect(withRetired[0]).toBe(google);
    expect(withRetired[1]?.models).toEqual([]);
    expect(withRetiredProviderEntries(withRetired)).toBe(withRetired);
    expect(isRetiredProviderId('Antigravity')).toBe(true);
    expect(isRetiredProviderId('google')).toBe(false);
  });

  test('shows the retired entry only when leftover sources exist', () => {
    expect(shouldShowConnectedProvider('antigravity', undefined, false)).toBe(false);
    expect(shouldShowConnectedProvider('antigravity', sources(), false)).toBe(false);
    expect(shouldShowConnectedProvider('antigravity', sources({ auth: { exists: true } }), false)).toBe(true);
    expect(shouldShowConnectedProvider('antigravity', undefined, true)).toBe(true);
    // Non-retired providers keep their loading behavior.
    expect(shouldShowConnectedProvider('openai', undefined, false)).toBe(true);
  });
});
