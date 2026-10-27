import { describe, expect, test } from 'bun:test';

import { createKeyedSingleFlight } from './single-flight.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('keyed single-flight', () => {
  test('shares only overlapping operations with the same key', async () => {
    const flight = createKeyedSingleFlight();
    const pending = deferred();
    let calls = 0;
    const operation = () => {
      calls += 1;
      return pending.promise;
    };

    const first = flight.run('http://127.0.0.1:4096/session/status?directory=%2Fa', operation);
    const second = flight.run('http://127.0.0.1:4096/session/status?directory=%2Fa', operation);

    expect(second).toBe(first);
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    pending.resolve({ ses_a: { type: 'idle' } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ses_a: { type: 'idle' } },
      { ses_a: { type: 'idle' } },
    ]);
  });

  test('keeps distinct full URL keys independent', async () => {
    const flight = createKeyedSingleFlight();
    const first = deferred();
    const second = deferred();
    let calls = 0;

    const left = flight.run('http://127.0.0.1:4096/session/status?directory=%2Fa', () => {
      calls += 1;
      return first.promise;
    });
    const right = flight.run('http://127.0.0.1:4097/session/status?directory=%2Fa', () => {
      calls += 1;
      return second.promise;
    });
    await Promise.resolve();

    expect(calls).toBe(2);
    first.resolve('left');
    second.resolve('right');
    await expect(Promise.all([left, right])).resolves.toEqual(['left', 'right']);
  });

  test('does not cache a settled response', async () => {
    const flight = createKeyedSingleFlight();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return calls;
    };

    await expect(flight.run('status', operation)).resolves.toBe(1);
    await expect(flight.run('status', operation)).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  test('fans out a rejection, cleans it up, and permits retry', async () => {
    const flight = createKeyedSingleFlight();
    const pending = deferred();
    const failure = new Error('status unavailable');
    let calls = 0;
    const operation = () => {
      calls += 1;
      return pending.promise;
    };

    const first = flight.run('status', operation);
    const second = flight.run('status', operation);
    await Promise.resolve();
    pending.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(flight.run('status', async () => {
      calls += 1;
      return 'recovered';
    })).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  test('cleans up a synchronous operation failure', async () => {
    const flight = createKeyedSingleFlight();
    const failure = new Error('synchronous failure');
    let calls = 0;

    const first = flight.run('status', () => {
      calls += 1;
      throw failure;
    });
    const second = flight.run('status', () => {
      calls += 1;
      return 'must not run';
    });

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(calls).toBe(1);
    await expect(flight.run('status', async () => {
      calls += 1;
      return 'retry';
    })).resolves.toBe('retry');
    expect(calls).toBe(2);
  });

  test('a cancelled waiter detaches without cancelling or duplicating another waiter’s read', async () => {
    const flight = createKeyedSingleFlight(), pending = deferred();
    const controller = new AbortController(), failure = new Error('first observer stopped');
    let calls = 0;
    const operation = () => { calls++; return pending.promise; };
    const first = flight.run('status', operation, { signal: controller.signal });
    const second = flight.run('status', operation);
    await Promise.resolve();
    controller.abort(failure);
    await expect(first).rejects.toBe(failure);
    expect(calls).toBe(1);
    // The stalled read remains pending and a later observer joins it.
    const third = flight.run('status', operation);
    expect(third).toBe(second);
    pending.resolve('idle');
    await expect(second).resolves.toBe('idle');
    expect(calls).toBe(1);
  });

  test('pre-cancelled observers start no work and detached failures still release the key', async () => {
    const flight = createKeyedSingleFlight(), pending = deferred(), controller = new AbortController();
    let calls = 0;
    controller.abort(new Error('cancelled'));
    await expect(flight.run('status', () => { calls++; }, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(calls).toBe(0);
    const active = new AbortController();
    const first = flight.run('status', () => { calls++; return pending.promise; }, { signal: active.signal });
    await Promise.resolve();
    active.abort(new Error('detached'));
    await expect(first).rejects.toThrow('detached');
    pending.reject(new Error('late request failure'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(flight.run('status', () => { calls++; return 'retry'; })).resolves.toBe('retry');
    expect(calls).toBe(2);
  });
});
