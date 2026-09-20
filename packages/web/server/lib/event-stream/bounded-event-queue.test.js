import { describe, it, expect } from 'vitest';
import { createBoundedEventQueue } from './bounded-event-queue.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('bounded event delivery', () => {
  it('counts authorization-in-flight bytes and drops pending entries on overflow', async () => {
    const hold = deferred(), delivered = [], reasons = [];
    const queue = createBoundedEventQueue({ maxBytes: 100, sizeOf: () => 40,
      deliver: async (entry, signal) => { await hold.promise; if (!signal.aborted) delivered.push(entry); },
      onClose: reason => reasons.push(reason) });
    const first = queue.enqueue('one'), second = queue.enqueue('two');
    expect(queue.getStats()).toEqual({ pendingBytes: 80, pendingEvents: 2, closed: false });
    expect(await queue.enqueue('overflow')).toBe(false);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(queue.getStats()).toEqual({ pendingBytes: 0, pendingEvents: 0, closed: true });
    hold.resolve(); await Promise.resolve();
    expect(delivered).toEqual([]);
    expect(reasons).toEqual(['queue_overflow']);
  });

  it('enforces counts and combined socket/queue bytes even for small entries', async () => {
    const hold = deferred();
    const queue = createBoundedEventQueue({ maxEntries: 2, sizeOf: () => 1, deliver: () => hold.promise });
    const entries = [queue.enqueue(1), queue.enqueue(2), queue.enqueue(3)];
    expect(await Promise.all(entries)).toEqual([false, false, false]);
    hold.resolve();
    const buffered = createBoundedEventQueue({ maxBytes: 100, getBufferedBytes: () => 90, sizeOf: () => 11, deliver: () => true });
    expect(await buffered.enqueue('x')).toBe(false);
  });

  it('preserves order across async authorization and cancels without waiting for it', async () => {
    const hold = deferred(), seen = [];
    const queue = createBoundedEventQueue({ deliver: async entry => { if (entry === 1) await hold.promise; seen.push(entry); return true; } });
    const first = queue.enqueue(1), second = queue.enqueue(2);
    expect(seen).toEqual([]);
    hold.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(seen).toEqual([1, 2]);
    expect(queue.getStats().pendingEvents).toBe(0);
    const forever = createBoundedEventQueue({ deliver: () => new Promise(() => {}) });
    const waiting = forever.enqueue('x'); forever.close();
    expect(await waiting).toBe(false);
  });

  it('fails closed on rejected filters and remains bounded over successive drains', async () => {
    const failed = createBoundedEventQueue({ deliver: async () => { throw new Error('filter failed'); } });
    expect(await failed.enqueue('x')).toBe(false);
    const seen = [];
    const queue = createBoundedEventQueue({ deliver: entry => { seen.push(entry); return true; } });
    for (let batch = 0; batch < 5; batch += 1) {
      expect((await Promise.all(Array.from({ length: 1500 }, (_, i) => queue.enqueue(batch * 1500 + i)))).every(Boolean)).toBe(true);
    }
    expect(seen).toEqual(Array.from({ length: 7500 }, (_, i) => i));
    expect(queue.getStats().pendingBytes).toBe(0);
  });
});
