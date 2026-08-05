import { describe, expect, test } from 'bun:test';

import {
  PREVIEW_CONSOLE_EVENT_LIMIT,
  formatPreviewConsoleText,
  getPreviewConsoleFilterMatch,
  isPreviewDiagnosticsState,
  type PreviewConsoleEvent,
} from './previewDiagnosticsState';

const event = (level: PreviewConsoleEvent['level']): PreviewConsoleEvent => ({
  id: 1,
  level,
  message: `${level} message`,
  ts: Date.UTC(2026, 0, 1),
});

describe('shared preview diagnostics', () => {
  test('keeps the console contract bounded and serializable', () => {
    expect(PREVIEW_CONSOLE_EVENT_LIMIT).toBe(200);
    expect(isPreviewDiagnosticsState({
      consoleEvents: [event('log')],
      consoleOpen: true,
      consoleFilter: 'all',
      inspectMode: false,
    })).toBe(true);
    expect(isPreviewDiagnosticsState({ consoleEvents: [], consoleOpen: true })).toBe(false);
    expect(isPreviewDiagnosticsState({
      consoleEvents: [{ ...event('log'), level: 'unknown' }],
      consoleOpen: false,
      consoleFilter: 'all',
      inspectMode: false,
    })).toBe(false);
  });

  test('filters errors, warnings, and regular logs consistently', () => {
    expect(getPreviewConsoleFilterMatch(event('runtime'), 'errors')).toBe(true);
    expect(getPreviewConsoleFilterMatch(event('resource'), 'errors')).toBe(true);
    expect(getPreviewConsoleFilterMatch(event('warn'), 'warnings')).toBe(true);
    expect(getPreviewConsoleFilterMatch(event('debug'), 'logs')).toBe(true);
    expect(getPreviewConsoleFilterMatch(event('warn'), 'logs')).toBe(false);
  });

  test('formats console attachments with URL, timestamps, and details', () => {
    const text = formatPreviewConsoleText([{
      ...event('runtime'),
      details: 'stack line',
    }], 'http://localhost:4173/docs');
    expect(text).toContain('Preview URL: http://localhost:4173/docs');
    expect(text).toContain('Events: 1');
    expect(text).toContain('[runtime] runtime message');
    expect(text).toContain('stack line');
  });
});
