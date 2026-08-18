import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { RateLimitGroup } from './types';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId, className }: { providerId: string; className?: string }) => (
    <span className={className} data-provider-logo={providerId} />
  ),
}));

const { UsageProviderTabs } = await import('./UsageProviderTabs');

const group = (providerId: string, providerName: string): RateLimitGroup => ({
  providerId,
  providerName,
  entries: [],
});

const groups: RateLimitGroup[] = [
  group('gemini', 'Gemini'),
  group('cursor', 'Cursor'),
  group('claude', 'Claude'),
  group('github-copilot', 'GitHub Copilot'),
  group('codex', 'ChatGPT'),
];

const expectProviderLabelsInAlphabeticalOrder = (markup: string) => {
  const labelPositions = ['ChatGPT', 'Claude', 'Cursor', 'Gemini', 'GitHub Copilot']
    .map((label) => markup.indexOf(label));

  expect(labelPositions.every((position) => position >= 0)).toBe(true);
  expect(labelPositions).toEqual([...labelPositions].sort((left, right) => left - right));
};

const renderTabs = (mobile = false) => renderToStaticMarkup(
  <I18nProvider>
    <UsageProviderTabs
      groups={groups}
      activeProviderId="cursor"
      onSelectProvider={() => {}}
      mobile={mobile}
    />
  </I18nProvider>
);

describe('UsageProviderTabs', () => {
  test('renders desktop provider tabs as a wrapped three-column grid', () => {
    const markup = renderTabs();

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('grid-cols-3');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('Cursor');
    expectProviderLabelsInAlphabeticalOrder(markup);
    expect(markup).not.toContain('overflow-x-auto');
    expect(markup).not.toContain('scrollbar-none');
  });

  test('renders mobile provider tabs as a wrapped two-column grid', () => {
    const markup = renderTabs(true);

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('grid-cols-2');
    expect(markup).toContain('GitHub Copilot');
    expectProviderLabelsInAlphabeticalOrder(markup);
    expect(markup).not.toContain('overflow-x-auto');
    expect(markup).not.toContain('scrollbar-none');
  });
});
