// Toy tests of the replayer's own toy family (toy-relay.mjs): the replayer's
// self-test records them and replays the recording against the module. Run
// only by the harness (their name keeps them out of every suite's discovery).
import { describe, expect, test } from 'bun:test';
import { ids, label, pair, relay, settle, share, stamp, tally } from './toy-relay.mjs';

describe('toy relay', () => {
  test('relays in a microtask, two calls before either job runs', async () => {
    expect(relay([1, 2])).toBe('queued');
    expect(relay([3])).toBe('queued');
    await Promise.resolve();
    await Promise.resolve();
  });

  test('relays after a chain of promise jobs, longer than one microtask', async () => {
    expect(settle([1, 2, 3])).toBe('later');
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });

  test('counts calls in hidden module state', () => {
    expect(tally('a')).toBe('a:1');
    expect(tally('b')).toBe('b:2');
  });

  test('a later test sees the count the earlier test left', () => {
    expect(tally('c')).toBe('c:3');
  });

  test('makes two port calls in one step', () => {
    expect(pair('x', 'y')).toEqual(['first:x', 'second:y']);
  });

  test('returns one object twice and its argument', () => {
    const event = { kind: 'k', extra: undefined };
    const shared = share(event);
    expect(shared.left).toBe(shared.right);
    expect(shared.event).toBe(event);
  });

  test('trims and measures UTF-16 text, a lone surrogate included', () => {
    expect(label('﻿ hi  ')).toEqual({ text: 'hi', units: 6 });
    expect(label('a\uD800')).toEqual({ text: 'a\uD800', units: 2 });
    expect(() => label(null)).toThrow(TypeError);
  });

  test('draws two ids in order', () => {
    const [first, second] = ids();
    expect(first).not.toBe(second);
  });

  test('stamps a draft copy-on-write, the test changing it between calls', () => {
    const draft = { items: {}, count: 0, keep: { untouched: true } };
    expect(stamp(draft, 'a')).toBe(1);
    const kept = draft.keep;
    draft.note = 'added by the test';
    delete draft.keep;
    draft.keep = kept;
    expect(stamp(draft, 'b')).toBe(2);
    const next = { ...draft, items: { ...draft.items } };
    expect(stamp(next, 'c')).toBe(3);
    expect(next.keep).toBe(kept);
  });
});
