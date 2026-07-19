import { describe, expect, test } from 'bun:test';
import { isExplicitDesktopSurface } from './device';

describe('explicit embedded desktop surface', () => {
  test('recognizes only the explicit desktop surface parameter', () => {
    expect(isExplicitDesktopSurface('?surface=desktop&ocPanel=session-chat')).toBe(true);
    expect(isExplicitDesktopSurface('?ocPanel=session-chat')).toBe(false);
    expect(isExplicitDesktopSurface('?surface=mobile')).toBe(false);
    expect(isExplicitDesktopSurface('')).toBe(false);
  });
});
