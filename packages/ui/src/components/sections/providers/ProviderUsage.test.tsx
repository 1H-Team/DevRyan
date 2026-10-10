import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult, UsageWindow } from '@/types';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));

const { ProviderUsageMeter, ProviderUsageSection, UsageOnlyProviderView } = await import('./ProviderUsage');

const initialQuotaState = useQuotaStore.getState();
const initialServerQuotaState = { ...useQuotaStore.getInitialState() };

const usageWindow = (usedPercent: number): UsageWindow => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowSeconds: 5 * 60 * 60,
  resetAfterSeconds: 3600,
  resetAt: Date.now() + 3600_000,
  resetAtFormatted: '4:00 PM',
  resetAfterFormatted: '4:00 PM',
});

const result = (providerId: ProviderResult['providerId'], windows: Record<string, UsageWindow>): ProviderResult => ({
  providerId,
  providerName: providerId,
  ok: true,
  configured: true,
  usage: { windows },
  fetchedAt: Date.now(),
  usageUpdatedAt: Date.now(),
});

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe('provider usage in Settings → Providers', () => {
  beforeEach(() => {
    const state: Partial<ReturnType<typeof useQuotaStore.getState>> = {
      results: [result('claude', { '5h': usageWindow(58), '7d': usageWindow(27) })],
      configuredProviderIds: ['claude'],
      providerRefreshState: {},
      dropdownProviderIds: ['claude'],
      displayMode: 'usage',
      showPredictionValues: false,
      isLoading: false,
      error: null,
    };
    useQuotaStore.setState(state);
    // Static rendering reads the store's server snapshot (its initial state).
    Object.assign(useQuotaStore.getInitialState(), state);
  });

  afterEach(() => {
    useQuotaStore.setState(initialQuotaState, true);
    Object.assign(useQuotaStore.getInitialState(), initialServerQuotaState);
  });

  test('renders an inline Usage section for a provider whose usage has a different id', () => {
    const markup = render(<ProviderUsageSection providerId="anthropic" />);

    expect(markup).toContain('Usage');
    expect(markup).toContain('5-Hour Limit');
    expect(markup).toContain('Weekly Limit');
    expect(markup).toContain('58%');
    expect(markup).toContain('Show in Header Menu');
    expect(markup).toContain('aria-label="Usage Options"');
    expect(markup).toContain('data-settings-readonly-allowed="true"');
  });

  test('renders nothing for providers without a usage source or result', () => {
    expect(render(<ProviderUsageSection providerId="ollama" />)).toBe('');
    expect(render(<ProviderUsageSection providerId="openai" />)).toBe('');
  });

  test('renders Codex account identity, weekly limits, and unknown reset inventory', () => {
    const codex: ProviderResult = { ...result('codex', { '7d': usageWindow(27) }), source: 'codex-app-server',
      connectionId: 'usage-account', account: { email: 'usage@example.test', planType: 'pro' },
      usage: { windows: { '7d': usageWindow(27) }, resetCredits: null } };
    const state: Partial<ReturnType<typeof useQuotaStore.getState>> = { results: [codex], configuredProviderIds: ['codex'] };
    useQuotaStore.setState(state); Object.assign(useQuotaStore.getInitialState(), state);
    const markup = render(<ProviderUsageSection providerId="openai" connected />);
    expect(markup).toContain('Usage source: Codex');
    expect(markup).toContain('usage@example.test');
    expect(markup).toContain('7-Day Limit');
    expect(markup).toContain('Reset Bank');
    expect(markup).toContain('Unavailable');
    expect(markup).not.toContain('0 available');
  });

  test('shows nothing for a connected provider that simply has no usage source', () => {
    expect(render(<ProviderUsageSection providerId="openai" connected />)).toBe('');
  });

  test('shows the failure and a retry for a connected provider while usage discovery is failing', () => {
    const state: Partial<ReturnType<typeof useQuotaStore.getState>> = {
      configuredProviderIds: null,
      error: 'native_runtime_not_ready',
    };
    useQuotaStore.setState(state);
    Object.assign(useQuotaStore.getInitialState(), state);

    const markup = render(<ProviderUsageSection providerId="openai" connected />);

    expect(markup).toContain('No usage data available yet.');
    expect(markup).toContain('native_runtime_not_ready');
    expect(render(<ProviderUsageSection providerId="openai" connected={false} />)).toBe('');
    expect(render(<ProviderUsageSection providerId="ollama" connected />)).toBe('');
  });

  test('stays hidden while discovery is merely pending', () => {
    const state: Partial<ReturnType<typeof useQuotaStore.getState>> = { configuredProviderIds: null, error: null };
    useQuotaStore.setState(state);
    Object.assign(useQuotaStore.getInitialState(), state);

    expect(render(<ProviderUsageSection providerId="openai" connected />)).toBe('');
  });

  test('shows the most-used window as a sidebar meter', () => {
    const markup = render(<ProviderUsageMeter quotaProviderId="claude" />);

    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="58"');
    expect(markup).toContain('58% of 5-Hour Limit Used');
    expect(render(<ProviderUsageMeter quotaProviderId="codex" />)).toBe('');
    expect(render(<ProviderUsageMeter quotaProviderId={null} />)).toBe('');
  });

  test('renders a usage-only provider view with its own header', () => {
    const markup = render(<UsageOnlyProviderView quotaProviderId="claude" />);

    expect(markup).toContain('Claude');
    expect(markup).toContain('without a matching provider');
    expect(markup).toContain('5-Hour Limit');
  });
});
