import { describe, expect, test } from 'bun:test';

import { getSdkErrorMessage } from './sdk-error';

describe('getSdkErrorMessage', () => {
  test('reads Error and SDK message values', () => {
    expect(getSdkErrorMessage(new Error('Network unavailable'))).toBe('Network unavailable');
    expect(getSdkErrorMessage({ message: 'Provider unavailable' })).toBe('Provider unavailable');
  });

  test('reads server error values and nested server errors', () => {
    expect(getSdkErrorMessage({ error: 'Directory is outside your assigned workspace' }))
      .toBe('Directory is outside your assigned workspace');
    expect(getSdkErrorMessage({ error: { error: 'Nested failure' } })).toBe('Nested failure');
  });

  test('serializes otherwise unknown objects without object coercion', () => {
    expect(getSdkErrorMessage({ code: 'bad_request' })).toBe('{"code":"bad_request"}');
  });

  test('uses a readable fallback for circular objects', () => {
    const circular: { error?: unknown } = {};
    circular.error = circular;

    expect(getSdkErrorMessage(circular)).toBe('Unknown error');
  });
});
