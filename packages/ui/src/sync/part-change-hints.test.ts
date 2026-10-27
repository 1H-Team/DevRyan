import { expect, test } from 'bun:test';
import { getPartChangeHints, hintPartChange, invalidatePartChangeHints } from './part-change-hints';
import type { State } from './types';

test('part receipts hold predecessor maps weakly and overflow/invalidation fail back to scans', () => {
  const original = globalThis.WeakRef;
  let weakBases = 0;
  class ObservedWeakRef<T extends WeakKey> extends original<T> {
    constructor(value: T) { super(value); weakBases++; }
  }
  globalThis.WeakRef = ObservedWeakRef;
  try {
    const previous: State['part'] = {}, next: State['part'] = {};
    hintPartChange(next, previous, 'first');
    hintPartChange(next, next, 'second');
    expect(weakBases).toBe(1);
    expect([...getPartChangeHints(next, previous) ?? []]).toEqual(['first', 'second']);
    expect(getPartChangeHints(next, {})).toBeUndefined();
    invalidatePartChangeHints(next);
    expect(getPartChangeHints(next, previous)).toBeUndefined();
    const bounded: State['part'] = {};
    hintPartChange(bounded, previous, 'zero');
    for (let index = 0; index < 513; index++) hintPartChange(bounded, bounded, String(index));
    expect(getPartChangeHints(bounded, previous)).toBeUndefined();
  } finally { globalThis.WeakRef = original; }
});
