import { describe, expect, test } from 'bun:test';

import { resolveRootSessionID, resolveSessionLineage } from './sessionLineage';

describe('session lineage', () => {
  test('resolves a child through every known ancestor', () => {
    const sessions = [
      { id: 'root' },
      { id: 'parent', parentID: 'root' },
      { id: 'child', parentID: 'parent' },
    ];

    expect(resolveSessionLineage('child', sessions)).toEqual(['child', 'parent', 'root']);
    expect(resolveRootSessionID('child', sessions)).toBe('root');
  });

  test('retains an unloaded parent identity as the root', () => {
    const sessions = [{ id: 'child', parentID: 'root-not-loaded' }];

    expect(resolveSessionLineage('child', sessions)).toEqual(['child', 'root-not-loaded']);
    expect(resolveRootSessionID('child', sessions)).toBe('root-not-loaded');
  });

  test('falls back to the selected session for cyclic lineage', () => {
    const sessions = [
      { id: 'a', parentID: 'b' },
      { id: 'b', parentID: 'a' },
    ];

    expect(resolveSessionLineage('a', sessions)).toEqual(['a', 'b']);
    expect(resolveRootSessionID('a', sessions)).toBe('a');
  });

  test('normalizes empty input', () => {
    expect(resolveSessionLineage('  ', [])).toEqual([]);
    expect(resolveRootSessionID(null, [])).toBeNull();
  });
});
