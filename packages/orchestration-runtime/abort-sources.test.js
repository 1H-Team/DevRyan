import { describe, expect, test } from 'bun:test';
import {
  ABORT_SOURCE_HEADER,
  ABORT_SOURCE_TTL_MS,
  ABORT_SOURCES,
  createAbortSourceRegistry,
  normalizeAbortSource,
} from './index.js';

describe('abort sources', () => {
  test('normalizes only known sources', () => {
    for (const source of ABORT_SOURCES) expect(normalizeAbortSource(source)).toBe(source);
    expect(normalizeAbortSource('rm -rf')).toBe('unknown');
    expect(normalizeAbortSource(undefined)).toBe('unknown');
    expect(normalizeAbortSource(['stop_button'])).toBe('unknown');
  });

  test('is a frozen contract with a stable header name', () => {
    expect(Object.isFrozen(ABORT_SOURCES)).toBe(true);
    expect(ABORT_SOURCE_HEADER).toBe('X-DevRyan-Abort-Source');
  });
});

describe('abort source registry', () => {
  test('keeps the latest known source per session until its TTL', () => {
    let clock = 1_000;
    const registry = createAbortSourceRegistry({ now: () => clock });
    expect(registry.record({ sessionId: 'ses_1', source: 'stop_button' })).toEqual({
      sessionId: 'ses_1', source: 'stop_button', recordedAt: 1_000,
    });
    registry.record({ sessionId: 'ses_1', source: 'provider_retry' });
    expect(registry.read('ses_1')).toBe('provider_retry');
    expect(registry.read('ses_2')).toBeNull();
    clock += ABORT_SOURCE_TTL_MS;
    expect(registry.read('ses_1')).toBe('provider_retry');
    clock += 1;
    expect(registry.read('ses_1')).toBeNull();
    expect(registry.size).toBe(0);
  });

  test('an unattributed abort clears the previous source', () => {
    const registry = createAbortSourceRegistry();
    registry.record({ sessionId: 'ses_1', source: 'stall_watchdog' });
    expect(registry.record({ sessionId: 'ses_1', source: 'rm -rf' })).toBeNull();
    expect(registry.read('ses_1')).toBeNull();
    expect(registry.record({ sessionId: '', source: 'stop_button' })).toBeNull();
    expect(registry.record()).toBeNull();
  });

  test('withdraw removes only its own entry and clear drops the session', () => {
    let clock = 1;
    const registry = createAbortSourceRegistry({ now: () => clock });
    const first = registry.record({ sessionId: 'ses_1', source: 'abort_guard' });
    clock += 1;
    const second = registry.record({ sessionId: 'ses_1', source: 'provider_retry' });
    expect(registry.withdraw(first)).toBe(false);
    expect(registry.read('ses_1')).toBe('provider_retry');
    expect(registry.withdraw(second)).toBe(true);
    expect(registry.read('ses_1')).toBeNull();
    expect(registry.withdraw(null)).toBe(false);
    registry.record({ sessionId: 'ses_1', source: 'stop_button' });
    expect(registry.clear('ses_1')).toBe(true);
    expect(registry.read('ses_1')).toBeNull();
  });

  test('is bounded by session count and validates its options', () => {
    const registry = createAbortSourceRegistry({ maximumSessions: 2 });
    for (const sessionId of ['ses_1', 'ses_2', 'ses_3']) registry.record({ sessionId, source: 'stop_button' });
    expect(registry.size).toBe(2);
    expect(registry.read('ses_1')).toBeNull();
    expect(registry.read('ses_3')).toBe('stop_button');
    expect(() => createAbortSourceRegistry({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => createAbortSourceRegistry({ maximumSessions: 0 })).toThrow(RangeError);
  });
});
