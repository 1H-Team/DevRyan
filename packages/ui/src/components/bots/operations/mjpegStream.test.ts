import { describe, expect, test } from 'bun:test';

import { BotMjpegParser, botMjpegBoundary } from './mjpegStream';

const encoder = new TextEncoder();
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const join = (...parts: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const frame = (capturedAt: number): Uint8Array => join(
  encoder.encode(
    '--devryan\r\n'
    + 'Content-Type: image/jpeg\r\n'
    + `Content-Length: ${jpeg.byteLength}\r\n`
    + 'X-DevRyan-Width: 1280\r\n'
    + 'X-DevRyan-Height: 720\r\n'
    + 'X-DevRyan-Device-Scale-Factor: 1\r\n'
    + `X-DevRyan-Captured-At: ${capturedAt}\r\n\r\n`,
  ),
  jpeg,
  encoder.encode('\r\n'),
);

describe('bounded Bot MJPEG parsing', () => {
  test('extracts a quoted multipart boundary', () => {
    expect(botMjpegBoundary('multipart/x-mixed-replace; boundary="devryan"')).toBe('devryan');
    expect(() => botMjpegBoundary('image/jpeg')).toThrow(/multipart/i);
  });

  test('parses a frame fragmented at every byte and verifies viewport metadata', () => {
    const parser = new BotMjpegParser('devryan');
    const frames = [];
    for (const byte of frame(123)) frames.push(...parser.push(new Uint8Array([byte])));
    expect(frames).toHaveLength(1);
    expect({
      width: frames[0].width,
      height: frames[0].height,
      deviceScaleFactor: frames[0].deviceScaleFactor,
      capturedAt: frames[0].capturedAt,
    }).toEqual({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      capturedAt: 123,
    });
    expect([...frames[0].bytes]).toEqual([...jpeg]);
  });

  test('emits multiple complete frames from one network chunk', () => {
    const parser = new BotMjpegParser('devryan');
    expect(parser.push(join(frame(1), frame(2))).map((item) => item.capturedAt)).toEqual([1, 2]);
  });

  test('rejects missing lengths, malformed JPEGs, and oversized frames', () => {
    const missingLength = encoder.encode(
      '--devryan\r\nContent-Type: image/jpeg\r\nX-DevRyan-Width: 1280\r\n'
      + 'X-DevRyan-Height: 720\r\nX-DevRyan-Device-Scale-Factor: 1\r\n\r\n',
    );
    expect(() => new BotMjpegParser('devryan').push(missingLength)).toThrow(/length/i);

    const malformed = frame(1).slice();
    malformed[malformed.byteLength - 4] = 0;
    expect(() => new BotMjpegParser('devryan').push(malformed)).toThrow(/JPEG boundary/i);

    const oversized = encoder.encode(
      '--devryan\r\nContent-Type: image/jpeg\r\nContent-Length: 2097153\r\n'
      + 'X-DevRyan-Width: 1280\r\nX-DevRyan-Height: 720\r\n'
      + 'X-DevRyan-Device-Scale-Factor: 1\r\n\r\n',
    );
    expect(() => new BotMjpegParser('devryan').push(oversized)).toThrow(/length/i);

    const wrongViewport = frame(1).slice();
    const marker = encoder.encode('X-DevRyan-Width: 1280');
    const offset = wrongViewport.findIndex((_, index) => (
      [...marker].every((byte, markerIndex) => wrongViewport[index + markerIndex] === byte)
    ));
    wrongViewport.set(encoder.encode('X-DevRyan-Width: 0128'), offset);
    expect(() => new BotMjpegParser('devryan').push(wrongViewport)).toThrow(/viewport/i);
  });
});
