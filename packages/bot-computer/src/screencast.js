const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class ComputerScreencastError extends Error {
  constructor(message, code = 'DEVRYAN_BOT_SCREENCAST_INVALID') {
    super(message);
    this.name = 'ComputerScreencastError';
    this.code = code;
    this.statusCode = 400;
  }
}

export function createScreencastBroker({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new ComputerScreencastError('Screencast clock is invalid');
  const subscribers = new Set();
  let frameCount = 0;
  let lastFrameAt = null;

  const subscribe = (subscriber) => {
    if (typeof subscriber !== 'function') throw new ComputerScreencastError('Subscriber is invalid');
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  };

  const publishJpeg = (frame, metadata = {}) => {
    if (!Buffer.isBuffer(frame) || frame.byteLength < 4 || frame.byteLength > MAX_FRAME_BYTES
      || frame[0] !== 0xff || frame[1] !== 0xd8 || frame[frame.length - 2] !== 0xff
      || frame[frame.length - 1] !== 0xd9) {
      throw new ComputerScreencastError('Screencast frame must be a bounded JPEG');
    }
    const event = Object.freeze({
      frame,
      width: Number.isInteger(metadata.width) ? metadata.width : null,
      height: Number.isInteger(metadata.height) ? metadata.height : null,
      deviceScaleFactor: Number.isFinite(metadata.deviceScaleFactor)
        ? metadata.deviceScaleFactor
        : null,
      capturedAt: now(),
    });
    frameCount += 1;
    lastFrameAt = event.capturedAt;
    for (const subscriber of subscribers) subscriber(event);
  };

  return Object.freeze({
    subscribe,
    publishJpeg,
    snapshot: () => Object.freeze({
      subscribers: subscribers.size,
      frameCount,
      lastFrameAt,
      retainedFrames: 0,
    }),
  });
}
