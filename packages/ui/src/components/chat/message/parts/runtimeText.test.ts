import { describe, expect, test } from 'bun:test';
import { coerceRuntimeText } from './runtimeText';

describe('coerceRuntimeText', () => {
  test('preserves strings and stringifies primitives', () => {
    expect(coerceRuntimeText('question')).toBe('question');
    expect(coerceRuntimeText(42)).toBe('42');
    expect(coerceRuntimeText(false)).toBe('false');
  });

  test('serializes arrays and objects without exposing React to object children', () => {
    expect(coerceRuntimeText({ label: 'safe' })).toBe('{"label":"safe"}');
    expect(coerceRuntimeText(['one', 'two'])).toBe('["one","two"]');
  });

  test('uses the fallback for null and circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(coerceRuntimeText(null, 'fallback')).toBe('fallback');
    expect(coerceRuntimeText(circular, 'fallback')).toBe('fallback');
  });

  test('uses an Error message', () => {
    expect(coerceRuntimeText(new Error('provider failed'), 'fallback')).toBe('provider failed');
  });
});
