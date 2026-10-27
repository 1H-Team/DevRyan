import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { PaceInfo } from '@/lib/quota';
import { PaceIndicator } from './PaceIndicator';

const pace = (predictedFinalPercent: number, overrides: Partial<PaceInfo> = {}): PaceInfo => ({
  elapsedRatio: 0.5,
  usageRatio: 0.1,
  predictedFinalPercent,
  remainingSeconds: 3600,
  isExhausted: false,
  elapsedSeconds: 3600,
  totalSeconds: 7200,
  status: 'on-track',
  paceRateText: '1%/h',
  predictText: `${predictedFinalPercent}%`,
  dailyAllocationPercent: null,
  predictionConfidence: 'high',
  ...overrides,
});

const render = (info: PaceInfo) => renderToStaticMarkup(
  createElement(I18nProvider, null, createElement(PaceIndicator, { paceInfo: info, compact: true })),
);

describe('PaceIndicator', () => {
  test('uses muted foreground for zero-percent predictions', () => {
    const html = render(pace(0));
    expect(html).toContain('background-color:var(--muted-foreground)');
    expect(html).toContain('color:var(--muted-foreground)');
  });

  test('keeps a non-zero low prediction on the success tone, not muted', () => {
    const html = render(pace(20));
    expect(html).toContain('color:var(--status-success)');
    expect(html).not.toContain('var(--muted-foreground)');
  });
});
