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
});
