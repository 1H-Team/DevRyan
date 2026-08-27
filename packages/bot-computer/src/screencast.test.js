import { describe, expect, test } from 'bun:test';
import { createScreencastBroker } from './screencast.js';

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);

describe('ephemeral JPEG computer screencast', () => {
  test('fans out frames without retaining frame bytes', () => {
    const broker = createScreencastBroker({ now: () => 1234 });
    const received = [];
    const unsubscribe = broker.subscribe((event) => received.push(event));
    const frame = jpeg();
    broker.publishJpeg(frame, { width: 800, height: 600 });
    unsubscribe();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ frame, width: 800, height: 600, capturedAt: 1234 });
    expect(broker.snapshot()).toEqual({
      subscribers: 0,
      frameCount: 1,
      lastFrameAt: 1234,
      retainedFrames: 0,
    });
    expect(Object.values(broker).some((value) => Buffer.isBuffer(value))).toBe(false);
  });

  test('rejects non-JPEG and oversized frame inputs', () => {
    const broker = createScreencastBroker();
    expect(() => broker.publishJpeg(Buffer.from('not jpeg'))).toThrow('bounded JPEG');
  });
});
