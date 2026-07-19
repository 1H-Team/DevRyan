import { describe, expect, test } from 'bun:test';
import { getFirstChangedModifiedLineFromPatch } from './firstChangedLine';

describe('getFirstChangedModifiedLineFromPatch', () => {
  test('skips context before the first addition', () => {
    expect(getFirstChangedModifiedLineFromPatch([
      '@@ -10,4 +20,5 @@',
      ' context one',
      ' context two',
      '+added',
    ].join('\n'))).toBe(22);
  });

  test('returns the modified-file position for deletion-only hunks', () => {
    expect(getFirstChangedModifiedLineFromPatch('@@ -4,2 +4,1 @@\n-removed\n kept')).toBe(4);
    expect(getFirstChangedModifiedLineFromPatch('@@ -1,1 +0,0 @@\n-removed')).toBe(1);
  });

  test('uses the first actual change across multiple hunks and CRLF', () => {
    expect(getFirstChangedModifiedLineFromPatch('@@ -1,2 +1,2 @@\r\n same\r\n same\r\n@@ -9,1 +12,1 @@\r\n-old\r\n+new')).toBe(12);
  });

  test('returns null for patches without an actual hunk change', () => {
    expect(getFirstChangedModifiedLineFromPatch('Binary files differ')).toBeNull();
    expect(getFirstChangedModifiedLineFromPatch('@@ -1,1 +1,1 @@\n unchanged')).toBeNull();
    expect(getFirstChangedModifiedLineFromPatch('')).toBeNull();
  });
});
