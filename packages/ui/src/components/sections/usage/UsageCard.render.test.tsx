import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { act } from 'react';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { UsageWindow } from '@/types';
import { UsageCard } from './UsageCard';

const dict: Record<string, string> = settingsDict;

const usageWindow = (usedPercent: number | null, overrides: Partial<UsageWindow> = {}): UsageWindow => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds: 5 * 60 * 60,
  resetAfterSeconds: 3600,
  resetAt: Date.now() + 3600_000,
  resetAtFormatted: '4:00 PM',
  resetAfterFormatted: '4:00 PM',
  ...overrides,
});

const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

const initial = useQuotaStore.getState();
beforeEach(() => { useQuotaStore.setState({ displayMode: 'usage', showPredictionValues: true }); });
afterEach(() => { useQuotaStore.setState(initial, true); });

describe('UsageCard', () => {
  test('shows a model display name as the row title and its context as the subtitle', () => {
    const markup = render(<UsageCard title="gpt-5-codex" displayTitle="GPT-5 Codex" subtitle="400K context" window={usageWindow(10)} />);
    expect(markup).toContain('>GPT-5 Codex<');
    expect(markup).toContain('>400K context<');
    expect(markup).not.toContain('>gpt-5-codex<');
  });

  test('renders an optional usage window description below the title', () => {
    const markup = render(<UsageCard title="5h" window={usageWindow(10, { description: 'Rolling five hour allowance' })} />);
    expect(markup).toContain('>Rolling five hour allowance<');
  });

  test('hides the progress bar for a value-only window', () => {
    const valueOnly = usageWindow(null, { valueLabel: '$5.00 available' });
    const markup = render(<UsageCard title="credits" window={valueOnly} />);
    expect(markup).toContain('$5.00 available');
    expect(markup).not.toContain('role="progressbar"');
    expect(render(<UsageCard title="5h" window={usageWindow(40)} />)).toContain('role="progressbar"');
  });

  // Zustand renders its initial state on the server, so the store-driven
  // setting is observed through a mounted tree.
  test('renders the pace indicator only when prediction values are enabled', async () => {
    const predictionLabel = dict['settings.usage.pace.predictionLabel'] as string;
    expect(predictionLabel).toBeTruthy();
    const mountedText = async (showPredictionValues: boolean): Promise<string> => {
      useQuotaStore.setState({ showPredictionValues });
      let text = '';
      await withDom(async (container) => {
        Object.assign(globalThis.window, { location: { search: '' } });
        Object.assign(globalThis.document.documentElement, { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        try {
          await act(async () => { root.render(<I18nProvider><UsageCard title="5h" window={usageWindow(40)} /></I18nProvider>); });
          text = container.textContent;
        } finally { await act(async () => root.unmount()); }
      });
      return text;
    };
    expect(await mountedText(true)).toContain(predictionLabel);
    const disabled = await mountedText(false);
    expect(disabled).not.toContain(predictionLabel);
    expect(disabled).toContain('40%');
  });

  test('never offers prediction rows for a window without progress', () => {
    const markup = render(<UsageCard title="credits" window={usageWindow(null, { valueLabel: '$5.00 available' })} />);
    expect(markup).not.toContain(dict['settings.usage.pace.predictionLabel'] as string);
  });
});
