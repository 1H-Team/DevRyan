import * as React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DayScrubber } from './DayScrubber';
import type { UserAnalyticsRangeDay } from './types';

const day = (date: string, estimatedActiveMinutes: number, prompts: number): UserAnalyticsRangeDay => ({
  date, estimatedActiveMinutes, prompts, filesOpened: 0, copies: 0, settingsChanges: 0,
} as UserAnalyticsRangeDay);

const series = [day('2026-08-01', 30, 2), day('2026-08-02', 0, 0), day('2026-08-03', 90, 5)];

const render = (selectedDate: string | null) => renderToStaticMarkup(
  <DayScrubber series={series} selectedDate={selectedDate} onSelect={() => {}} sessionCountByDate={new Map([['2026-08-03', 2]])} />,
);

describe('DayScrubber', () => {
  test('is an accessible group of day selectors in chronological order', () => {
    const markup = render(null);
    expect(markup).toContain('role="group"');
    expect(markup.match(/<button[^>]*aria-pressed="false"/g)).toHaveLength(3);
    const labels = [...markup.matchAll(/aria-label="([^"]*)" title/g)].map((match) => match[1] ?? '');
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('30m');
    expect(labels[2]).toContain('5 prompts');
    expect(labels[2]).toContain('2 sessions');
  });

  test('marks exactly the selected day as pressed', () => {
    const markup = render('2026-08-03');
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(markup.indexOf('aria-pressed="true"')).toBeGreaterThan(markup.indexOf('aria-pressed="false"'));
  });

  test('renders nothing for an empty range', () => {
    expect(renderToStaticMarkup(<DayScrubber series={[]} selectedDate={null} onSelect={() => {}} sessionCountByDate={new Map()} />)).toBe('');
  });
});
