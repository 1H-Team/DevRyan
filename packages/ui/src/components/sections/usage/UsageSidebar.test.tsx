import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { formatProviderWindowLabel } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult, UsageWindow } from '@/types';
import { sortUsageEntries } from '@/components/layout/usage/usage-groups';
import { UsageCard } from './UsageCard';
import { getVisibleUsageProviders } from './usage-provider-visibility';

const usageWindow = (usedPercent: number, windowSeconds: number): UsageWindow => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowSeconds,
  resetAfterSeconds: 3600,
  resetAt: Date.now() + 3600_000,
  resetAtFormatted: '4:00 PM',
  resetAfterFormatted: '4:00 PM',
});

const anthropicResult: ProviderResult = {
  providerId: 'claude',
  providerName: 'Claude',
  ok: true,
  configured: true,
  usage: {
    windows: {
      '5h': usageWindow(31, 5 * 60 * 60),
      '7d': usageWindow(6, 7 * 24 * 60 * 60),
      '7d-fable': usageWindow(2, 7 * 24 * 60 * 60),
    },
  },
  fetchedAt: Date.now(),
  usageUpdatedAt: Date.now(),
};

describe('Claude Usage rendering', () => {
  beforeEach(() => {
    useQuotaStore.setState({
      results: [anthropicResult],
      selectedProviderId: 'claude',
      displayMode: 'usage',
      showPredictionValues: false,
    });
  });

  test('keeps a configured Claude result visible in the Usage sidebar', () => {
    const visibleProviders = getVisibleUsageProviders([anthropicResult]);
    expect(visibleProviders.map((provider) => provider.id)).toContain('claude');
    expect(visibleProviders.find((provider) => provider.id === 'claude')?.name).toBe('Claude');
  });

  test('keeps configured xAI and DeepSeek results visible in provider order', () => {
    const visibleProviders = getVisibleUsageProviders([
      providerResult('xai'),
      providerResult('deepseek'),
    ]);

    expect(visibleProviders.map((provider) => provider.id)).toEqual(['deepseek', 'xai']);
  });

  test('renders all Claude primary and Fable quota cards', () => {
    const entries = sortUsageEntries('claude', Object.entries(anthropicResult.usage?.windows ?? {}));
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <div>
          {entries.map(([label, window]) => (
            <UsageCard
              key={label}
              title={label}
              displayTitle={formatProviderWindowLabel('claude', label)}
              window={window}
            />
          ))}
        </div>
      </I18nProvider>,
    );

    const labels = ['5-Hour Limit', 'Weekly Limit', 'Weekly Fable Limit'];
    const positions = labels.map((label) => markup.indexOf(label));
    for (const label of labels) {
      expect(markup).toContain(label);
    }
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(markup).toContain('31%');
    expect(markup).toContain('6%');
    expect(markup).toContain('2%');
    expect(markup).toContain('Resets');
  });
});

function providerResult(providerId: 'xai' | 'deepseek'): ProviderResult {
  return {
    providerId,
    providerName: providerId,
    ok: true,
    configured: true,
    usage: { windows: {} },
    fetchedAt: Date.now(),
  };
}
