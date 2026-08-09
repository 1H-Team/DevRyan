import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

import { MetricTrendChart, type MetricTrendPoint } from './MetricTrendChart';
import { resolveMetricTrendHover } from './metricTrendState';

const series: MetricTrendPoint[] = [
  { date: '2026-08-01', estimatedActiveMinutes: 120, prompts: 8, filesOpened: 4, copies: 2, settingsChanges: 1 },
  { date: '2026-08-02', estimatedActiveMinutes: 45, prompts: 3, filesOpened: 0, copies: 1, settingsChanges: 0 },
  { date: '2026-08-03', estimatedActiveMinutes: 0, prompts: 0, filesOpened: 0, copies: 0, settingsChanges: 0 },
  { date: '2026-08-04', estimatedActiveMinutes: 210, prompts: 15, filesOpened: 9, copies: 5, settingsChanges: 2 },
];

describe('MetricTrendChart rendering', () => {
  test('renders one line per default-enabled metric with themed colors and axes', () => {
    const markup = renderToStaticMarkup(React.createElement(MetricTrendChart, { series }));
    // Default enabled metrics are prompts + active time → two polylines.
    expect(markup.match(/<polyline/g)).toHaveLength(2);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('var(--chart-1)'); // active time
    expect(markup).toContain('var(--chart-2)'); // prompts
    // Left (count) and right (minutes) axis tick labels are present.
    expect(markup).toContain('aria-pressed');
    // Right axis (active minutes, peak 210) caps tightly at 250, not 500.
    expect(markup).toContain('>250<');
    // Screen-reader data table lists every day with formatted values.
    expect(markup).toContain('Aug 4');
    expect(markup).toContain('3h 30m');
  });

  test('shows an empty state when there is no data', () => {
    const markup = renderToStaticMarkup(React.createElement(MetricTrendChart, { series: [] }));
    expect(markup).toContain('No activity in the selected range.');
    expect(markup).not.toContain('<polyline');
  });

  test('highlights the selected day with the primary accent', () => {
    const markup = renderToStaticMarkup(
      React.createElement(MetricTrendChart, { series, selectedDate: '2026-08-04' }),
    );
    expect(markup).toContain('var(--primary-base)'); // highlight band + guide line
    expect(markup).toContain('stroke-dasharray="3 3"'); // dashed guide on the selected day
  });

  test('renders no selection accent when no day is selected', () => {
    const markup = renderToStaticMarkup(
      React.createElement(MetricTrendChart, { series, selectedDate: null }),
    );
    expect(markup).not.toContain('var(--primary-base)');
  });

  test('drops a hovered date that is absent after the series shrinks', () => {
    expect(resolveMetricTrendHover(series, '2026-08-04')).toEqual({ index: 3, point: series[3] });
    expect(resolveMetricTrendHover(series.slice(0, 2), '2026-08-04')).toBeNull();
  });
});
