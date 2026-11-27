// Toy tests of the replayer's store and timer family (toy-store.mjs, package
// C0e): the replayer's self-test records them and replays the recording.
// Timers run on fake timers the test installs, or on real timers the test
// outwaits by far (a 1 ms engine timer before a 40 ms test wait), or that the
// test leaves pending (a 200 ms timer of a test that returns at once, recorded
// as pending at its end), so what the recording holds does not depend on how
// fast the machine is.
import { describe, expect, jest, test } from 'bun:test';
import { addFromHost, fillBox, recallFromHost, rememberFromHost } from './toy-store-host.mjs';
import { cancel, chain, counterStore, later, laterThen, loadInto, makeBox, rememberLater, stamp, tickTwice } from './toy-store.mjs';

const resetStore = () => counterStore.setState({ count: 0, items: [], tags: new Set() });

describe('toy store', () => {
  test('actions replace what they change, and every change notifies in order', () => {
    resetStore();
    const seen = [];
    const first = counterStore.subscribe((state, previous) => { seen.push(['first', state.count, previous.count]); });
    const second = counterStore.subscribe((state) => { seen.push(['second', state.items.length]); });
    counterStore.getState().add('a');
    counterStore.getState().tag('x');
    counterStore.getState().keep();
    first();
    counterStore.getState().add('b');
    second();
    expect(seen).toEqual([['first', 1, 0], ['second', 1], ['first', 1, 1], ['second', 1], ['second', 2]]);
    expect(counterStore.getState().count).toBe(2);
  });

  test('the test sets the state itself, with a partial, an updater and a replacement', () => {
    resetStore();
    counterStore.setState({ count: 5 });
    counterStore.setState((state) => ({ count: state.count + 1 }));
    const kept = counterStore.getState();
    counterStore.setState({ ...kept, items: ['z'] }, true);
    expect(counterStore.getState().count).toBe(6);
    expect(counterStore.getState().tags).toBe(kept.tags);
  });

  test('a subscriber that calls back into the store makes an input inside the notification', () => {
    resetStore();
    const unsubscribe = counterStore.subscribe((state) => { if (!state.tags.has('nested')) counterStore.getState().tag('nested'); });
    counterStore.getState().add('a');
    unsubscribe();
    expect([...counterStore.getState().tags]).toEqual(['nested']);
  });

  test('module state beside the store is kept across calls and cases', () => {
    resetStore();
    counterStore.getState().remember('k', 'v1');
    expect(counterStore.getState().recall('k')).toBe('v1');
    expect(counterStore.getState().persist()).toBe('persist:0');
  });

  test('a later case sees the module state the earlier case left', () => {
    expect(counterStore.getState().recall('k')).toBe('v1');
  });

  test('a module no family maps moves the state between the test\'s own calls (unrecordable: state-moved)', () => {
    resetStore();
    addFromHost('from-host');
    counterStore.getState().add('own');
    expect(counterStore.getState().count).toBe(2);
  });

  // C0e fix round: a passed-through call moves the state only when the state differs after it.
  test('a module no family maps only reads the state between the test\'s own calls', () => {
    resetStore();
    counterStore.getState().remember('read', 'kept');
    expect(recallFromHost('read')).toBe('kept');
    counterStore.getState().add('own');
    expect(counterStore.getState().count).toBe(1);
  });

  test('a module no family maps writes the module state, with no notification, between the test\'s own calls (unrecordable: state-moved)', () => {
    resetStore();
    counterStore.getState().remember('host', 'before');
    rememberFromHost('host', 'after');
    expect(counterStore.getState().recall('host')).toBe('after');
  });

  test('a module no family maps writes a box the family handed out, through the family\'s own reference (unrecordable: handed-out-touched)', () => {
    const box = makeBox('host-box');
    fillBox('host-box', 'from-host');
    expect(box.getState().items).toEqual(['from-host']);
  });

  test('a box the family handed out, written by the test through what it was handed', () => {
    const box = makeBox('own-box');
    box.setState({ items: ['own'] });
    expect(box.getState().items).toEqual(['own']);
  });

  test('a loader answer that settles after the test ended is a late step of its case', () => {
    resetStore();
    void loadInto(() => Bun.sleep(50).then(() => 'loaded'));
    expect(counterStore.getState().count).toBe(0);
  });

  test('the next test touches no family while the late answer settles', async () => {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  });

  test('a later case starts from what the late step left', () => {
    expect(counterStore.getState().recall('host')).toBe('after');
    expect(counterStore.getState().count).toBe(1);
  });
});

describe('toy timers', () => {
  test('a real timer fires before the test outwaits it, and a clock read is nominal', async () => {
    later(1, 'real');
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(stamp('now')).toMatch(/^now@\d+$/);
  });

  test('a real timer whose callback logs before it returns and after, in the job it started', async () => {
    laterThen(1, 'split');
    await new Promise((resolve) => { setTimeout(resolve, 40); });
  });

  test('a timer still pending when the test ends is recorded as pending, and its firing is no step', () => {
    resetStore();
    rememberLater(200, 'pending');
    expect(counterStore.getState().recall('pending')).toBe(null);
  });

  test('the next test touches no family while the pending timer fires', async () => {
    await new Promise((resolve) => { setTimeout(resolve, 300); });
  });

  test('a later case starts from the module state the pending timer left (seeded in file order too)', () => {
    expect(counterStore.getState().recall('pending')).toBe('fired');
  });

  test('a clear of a timer the test set itself names its handle, not a timer of the family', () => {
    const own = setTimeout(() => {}, 1000);
    expect(cancel(own)).toBe('cancelled');
  });

  test('fake timers the test installs: a timer that sets another, an interval its own callback clears, a cancel', () => {
    jest.useFakeTimers();
    try {
      chain('c');
      tickTwice('t');
      const handle = later(50, 'never');
      jest.advanceTimersByTime(20);
      expect(cancel(handle)).toBe('cancelled');
      jest.advanceTimersByTime(100);
    } finally {
      jest.useRealTimers();
    }
  });
});
