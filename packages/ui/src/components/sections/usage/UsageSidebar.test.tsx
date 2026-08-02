import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult, UsageWindow } from '@/types';
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
  providerName: 'Anthropic',
  ok: true,
  configured: true,
  usage: {
    windows: {
      '5h': usageWindow(31, 5 * 60 * 60),
      '7d': usageWindow(6, 7 * 24 * 60 * 60),
      '7d-sonnet': usageWindow(2, 7 * 24 * 60 * 60),
    },
  },
  fetchedAt: Date.now(),
  usageUpdatedAt: Date.now(),
};

describe('Anthropic Usage rendering', () => {
  beforeEach(() => {
    useQuotaStore.setState({
      results: [anthropicResult],
      selectedProviderId: 'claude',
      displayMode: 'usage',
      showPredictionValues: false,
    });
  });

  test('keeps a configured Anthropic result visible in the Usage sidebar', () => {
    const visibleProviders = getVisibleUsageProviders([anthropicResult]);
    expect(visibleProviders.map((provider) => provider.id)).toContain('claude');
    expect(visibleProviders.find((provider) => provider.id === 'claude')?.name).toBe('Anthropic');
  });

  test('renders Anthropic primary and model-specific quota cards', () => {
    const windows = anthropicResult.usage?.windows ?? {};
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <div>
          {Object.entries(windows).map(([label, window]) => (
            <UsageCard key={label} title={label} window={window} />
          ))}
        </div>
      </I18nProvider>,
    );

    expect(markup).toContain('5-Hour');
    expect(markup).toContain('7-Day Limit');
    expect(markup).toContain('7-Day Sonnet Limit');
    expect(markup).toContain('31%');
    expect(markup).toContain('6%');
    expect(markup).toContain('2%');
    expect(markup).toContain('Resets');
  });
});
