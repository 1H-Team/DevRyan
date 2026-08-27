import { describe, expect, test } from 'bun:test';

import type { I18nKey } from '@/lib/i18n';
import type { I18nParams } from '@/lib/i18n/store';
import { botRuntimeProgressLabel } from './useBotRuntimeOperation';

const translate = (key: I18nKey, values?: I18nParams): string => (
  values ? `${key}:${values.current}/${values.total}` : key
);

describe('Bot runtime operation presentation', () => {
  test('projects authoritative image counts and safe phases', () => {
    expect(botRuntimeProgressLabel({
      id: 'operation-1',
      action: 'ensure_ready',
      phase: 'downloading_image',
      completed: 1,
      total: 5,
      code: null,
      startedAt: '2026-08-26T00:00:00.000Z',
    }, translate)).toBe('bots.runtime.progress.downloading:2/5');

    expect(botRuntimeProgressLabel({
      id: 'operation-1',
      action: 'ensure_ready',
      phase: 'verifying_health',
      completed: null,
      total: null,
      code: null,
      startedAt: '2026-08-26T00:00:00.000Z',
    }, translate)).toBe('bots.runtime.progress.verifying_health');
  });
});
