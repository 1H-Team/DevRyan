import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { UsageWindow } from '@/types';
import type { RateLimitGroup } from './types';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => (
    <span data-provider-logo={providerId} />
  ),
}));

const { UsageProviderPanel } = await import('./UsageProviderPanel');

const valueOnlyWindow: UsageWindow = {
  usedPercent: null,
  remainingPercent: null,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel: 'USD 12.50',
  description: 'Granted: USD 10.00',
};

const renderPanel = (group: RateLimitGroup) => renderToStaticMarkup(
  <I18nProvider>
    <UsageProviderPanel
      group={group}
      quotaTrendHistory={{}}
      handleUsageRefresh={() => {}}
      isQuotaLoading={false}
      isUsageRefreshSpinning={false}
      expandedFamilies={{}}
      toggleFamilyExpanded={() => {}}
      formatUpdatedTime={() => 'now'}
    />
  </I18nProvider>,
);

describe('UsageProviderPanel quota warnings and value rows', () => {
  test('renders and orders every Claude subscription limit with Claude-specific labels', () => {
    const progressWindow: UsageWindow = {
      ...valueOnlyWindow,
      usedPercent: 12,
      remainingPercent: 88,
      windowSeconds: 7 * 24 * 60 * 60,
    };
    const markup = renderPanel({
      providerId: 'claude',
      providerName: 'Claude',
      entries: [
        ['7d-fable', { ...progressWindow, usedPercent: 2, remainingPercent: 98 }],
        ['7d', { ...progressWindow, usedPercent: 5, remainingPercent: 95 }],
        ['5h', { ...progressWindow, windowSeconds: 5 * 60 * 60 }],
      ],
    });

    const labels = ['5-Hour Limit', 'Weekly Limit', 'Weekly Fable Limit'];
    const positions = labels.map((label) => markup.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(markup).toContain('data-provider-logo="claude"');
  });

  test('keeps a usable value-only row and its provider warning without an empty progress bar', () => {
    const markup = renderPanel({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      entries: [['USD', valueOnlyWindow]],
      warnings: ['Balance is temporarily unavailable.'],
    });

    expect(markup).toContain('USD 12.50');
    expect(markup).toContain('Granted: USD 10.00');
    expect(markup).toContain('Provider usage warning');
    expect(markup).toContain('Balance is temporarily unavailable.');
    expect(markup).not.toContain('role="progressbar"');
  });

  test('still renders progress for a reported zero-percent window', () => {
    const markup = renderPanel({
      providerId: 'xai',
      providerName: 'xAI',
      entries: [['weekly', { ...valueOnlyWindow, usedPercent: 0, remainingPercent: 100 }]],
    });

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="0"');
  });
});
