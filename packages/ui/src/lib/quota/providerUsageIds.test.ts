import { describe, expect, test } from 'bun:test';

import { QUOTA_PROVIDERS, getSortedQuotaProviders } from './providers';
import {
  getQuotaProviderIdForProvider,
  getUsageOnlyQuotaProviders,
  parseUsageOnlyProviderSelection,
  toUsageOnlyProviderSelection,
} from './providerUsageIds';
import { getPeakUsageWindow } from './utils';

const window = (usedPercent: number | null) => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

describe('provider usage ids', () => {
  test('maps Providers catalog ids onto the quota ids that report their usage', () => {
    expect(getQuotaProviderIdForProvider('anthropic')).toBe('claude');
    expect(getQuotaProviderIdForProvider('anthropic-oauth')).toBe('claude');
    expect(getQuotaProviderIdForProvider('openai')).toBe('codex');
    expect(getQuotaProviderIdForProvider('opencode')).toBe('opencode');
    expect(getQuotaProviderIdForProvider('cursor-acp')).toBe('cursor-acp');
    expect(getQuotaProviderIdForProvider('grok')).toBe('xai');
    expect(getQuotaProviderIdForProvider('copilot')).toBe('github-copilot');
    expect(getQuotaProviderIdForProvider('zai')).toBe('zai-coding-plan');
    expect(getQuotaProviderIdForProvider(' Anthropic ')).toBe('claude');
  });

  test('maps every registered quota id to itself and unknown providers to null', () => {
    for (const provider of QUOTA_PROVIDERS) {
      expect(getQuotaProviderIdForProvider(provider.id)).toBe(provider.id);
    }
    expect(getQuotaProviderIdForProvider('ollama')).toBeNull();
    expect(getQuotaProviderIdForProvider('')).toBeNull();
    expect(getQuotaProviderIdForProvider(undefined)).toBeNull();
  });

  test('lists usage sources that no Providers row covers', () => {
    const visible = getSortedQuotaProviders().filter((provider) => (
      ['claude', 'codex', 'cursor-acp', 'opencode'].includes(provider.id)
    ));

    expect(getUsageOnlyQuotaProviders(visible, ['anthropic', 'openai']).map((provider) => provider.id).sort())
      .toEqual(['cursor-acp', 'opencode']);
    expect(getUsageOnlyQuotaProviders(visible, ['anthropic', 'openai', 'cursor-acp', 'opencode'])).toEqual([]);
  });

  test('round-trips usage-only selections and rejects unknown ids', () => {
    expect(parseUsageOnlyProviderSelection(toUsageOnlyProviderSelection('claude'))).toBe('claude');
    expect(parseUsageOnlyProviderSelection('__usage__:unknown')).toBeNull();
    expect(parseUsageOnlyProviderSelection('anthropic')).toBeNull();
    expect(parseUsageOnlyProviderSelection('__add_provider__')).toBeNull();
  });
});

describe('getPeakUsageWindow', () => {
  test('returns the most-used overall window', () => {
    expect(getPeakUsageWindow({ windows: { '5h': window(58), '7d': window(27) } }))
      .toEqual({ label: '5h', usedPercent: 58 });
  });

  test('falls back to model windows and skips value-only rows', () => {
    expect(getPeakUsageWindow({
      windows: { credits: window(null) },
      models: { 'gemini-pro': { windows: { daily: window(12) } }, 'gemini-flash': { windows: { daily: window(40) } } },
    })).toEqual({ label: 'daily', usedPercent: 40 });
  });

  test('returns null without progress windows', () => {
    expect(getPeakUsageWindow(null)).toBeNull();
    expect(getPeakUsageWindow({ windows: { credits: window(null) } })).toBeNull();
  });
});
