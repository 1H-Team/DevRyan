import { describe, expect, test } from 'bun:test';
import type { I18nKey } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import {
  formatSessionLifecycleLines,
  resolveSessionLifecyclePresentation,
} from './sessionLifecyclePresentation';

const t = (key: I18nKey, params?: Record<string, string | number>): string => (
  dict[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
);
const formatTime = (timestamp: number): string => `t${timestamp}`;

describe('session lifecycle presentation', () => {
  test('shows nothing before the first finished run', () => {
    expect(resolveSessionLifecyclePresentation({})).toBeNull();
    expect(resolveSessionLifecyclePresentation({ busy: 100 })).toBeNull();
    expect(formatSessionLifecycleLines(null, t, formatTime)).toEqual([]);
  });

  test('shows the outcome, idle time and duration when idle is at or after busy', () => {
    const presentation = resolveSessionLifecyclePresentation({ busy: 1_000, idle: 4_000, outcome: 'succeeded' });

    expect(presentation).toEqual({ outcome: 'succeeded', idleAt: 4_000, durationMs: 3_000 });
    expect(formatSessionLifecycleLines(presentation, t, formatTime)).toEqual([
      'Last run succeeded',
      'Idle since t4000',
      'Ran for 3.0s',
    ]);
  });

  test('omits the duration while a newer run has started and never reports running', () => {
    const presentation = resolveSessionLifecyclePresentation({ busy: 5_000, idle: 4_000, outcome: 'failed' });

    expect(presentation?.durationMs).toBeNull();
    expect(formatSessionLifecycleLines(presentation, t, formatTime)).toEqual([
      'Last run failed',
      'Idle since t4000',
    ]);
  });

  test('labels a finished run without a native outcome', () => {
    expect(formatSessionLifecycleLines(
      resolveSessionLifecyclePresentation({ idle: 4_000 }),
      t,
      formatTime,
    )).toEqual(['Last run finished', 'Idle since t4000']);
  });
});
