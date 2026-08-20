import { describe, expect, test } from 'bun:test';
import {
  assertCursorSdkNodeCompatibility,
  isCursorSdkNodeVersionSupported,
} from './node-version.js';

describe('Cursor SDK Node compatibility', () => {
  test('accepts the exact minimum and newer releases', () => {
    expect(isCursorSdkNodeVersionSupported('22.13.0')).toBe(true);
    expect(isCursorSdkNodeVersionSupported('v22.14.1')).toBe(true);
    expect(isCursorSdkNodeVersionSupported('24.0.0')).toBe(true);
  });

  test('rejects older and malformed versions with an actionable error', () => {
    expect(isCursorSdkNodeVersionSupported('22.12.9')).toBe(false);
    expect(isCursorSdkNodeVersionSupported('20.19.0')).toBe(false);
    expect(isCursorSdkNodeVersionSupported('unknown')).toBe(false);
    expect(() => assertCursorSdkNodeCompatibility('22.12.9')).toThrow(
      'Cursor SDK requires Node.js 22.13.0 or newer; detected 22.12.9.',
    );
  });
});
