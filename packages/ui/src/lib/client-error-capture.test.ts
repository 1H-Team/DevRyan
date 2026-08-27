import { afterEach, describe, expect, test } from 'bun:test';

import {
  fingerprintError,
  initClientErrorCapture,
  reportBoundaryError,
  resetClientErrorCaptureForTests,
  shouldIgnoreClientError,
} from './client-error-capture';

interface CapturedBatch {
  errors: {
    fingerprint: string;
    name: string;
    message: string;
    stack?: string;
    componentStack?: string;
    source: string;
    route?: string;
    occurrenceCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }[];
}

const collector = () => {
  const batches: CapturedBatch[] = [];
  return {
    batches,
    send: async (batch: unknown) => {
      batches.push(batch as CapturedBatch);
      return true;
    },
  };
};

afterEach(() => {
  resetClientErrorCaptureForTests();
});

describe('client error capture', () => {
  test('ignores only the benign global ResizeObserver notification', () => {
    expect(shouldIgnoreClientError(
      'ResizeObserver loop completed with undelivered notifications.',
      'window_error',
    )).toBe(true);
    expect(shouldIgnoreClientError(
      'ResizeObserver loop completed with undelivered notifications.',
      'error_boundary',
    )).toBe(false);
    expect(shouldIgnoreClientError('ResizeObserver crashed', 'window_error')).toBe(false);
  });

  test('stays silent until initialized so unmanaged scopes never report', async () => {
    const sink = collector();
    reportBoundaryError(new Error('before init'));

    const teardown = initClientErrorCapture({ send: sink.send });
    teardown();

    expect(sink.batches).toHaveLength(0);
  });

  test('coalesces repeats of one fault into a single counted report', async () => {
    const sink = collector();
    const teardown = initClientErrorCapture({ send: sink.send });

    const error = new Error('render exploded');
    error.stack = 'Error: render exploded\n    at Widget (Widget.tsx:12:3)\n    at App (App.tsx:4:1)';
    for (let index = 0; index < 5; index += 1) reportBoundaryError(error, '\n    in Widget');

    teardown();
    await Promise.resolve();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0].errors).toHaveLength(1);
    const report = sink.batches[0].errors[0];
    expect(report.name).toBe('Error');
    expect(report.message).toBe('render exploded');
    expect(report.source).toBe('error_boundary');
    expect(report.componentStack).toBe('\n    in Widget');
    expect(report.occurrenceCount).toBe(5);
  });

  test('flushes automatically once a batch fills up', async () => {
    const sink = collector();
    initClientErrorCapture({ send: sink.send });

    for (let index = 0; index < 10; index += 1) reportBoundaryError(new Error(`distinct ${index}`));
    await Promise.resolve();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0].errors).toHaveLength(10);
  });

  test('fingerprints by fault identity, not by occurrence', () => {
    const stack = 'Error: boom\n    at a (a.ts:1:1)\n    at b (b.ts:2:2)\n    at c (c.ts:3:3)';
    expect(fingerprintError('TypeError', 'boom', stack)).toBe(fingerprintError('TypeError', 'boom', stack));
    expect(fingerprintError('TypeError', 'boom', stack)).not.toBe(fingerprintError('TypeError', 'bang', stack));
    expect(fingerprintError('TypeError', 'boom', stack)).not.toBe(
      fingerprintError('TypeError', 'boom', 'Error: boom\n    at z (z.ts:9:9)'),
    );
  });

  test('stops reporting after the endpoint rejects a batch', async () => {
    const batches: unknown[] = [];
    const teardown = initClientErrorCapture({
      send: async (batch) => {
        batches.push(batch);
        return false;
      },
    });

    reportBoundaryError(new Error('first'));
    teardown();
    await Promise.resolve();

    reportBoundaryError(new Error('second'));
    await Promise.resolve();

    expect(batches).toHaveLength(1);
  });
});
