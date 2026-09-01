const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const DEVICE_SCALE_FACTOR = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder('ascii', { fatal: true });

export type BotMjpegFrame = {
  bytes: Uint8Array;
  width: number;
  height: number;
  deviceScaleFactor: number;
  capturedAt: number | null;
};

export class BotMjpegStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotMjpegStreamError';
  }
}

const sequenceIndex = (haystack: Uint8Array, needle: Uint8Array): number => {
  if (needle.byteLength === 0) return 0;
  const limit = haystack.byteLength - needle.byteLength;
  for (let index = 0; index <= limit; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
};

const concatenate = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right.slice();
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
};

const numericHeader = (
  headers: ReadonlyMap<string, string>,
  name: string,
  { integer = true }: { integer?: boolean } = {},
): number => {
  const raw = headers.get(name);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new BotMjpegStreamError(`Invalid ${name} frame header`);
  }
  return value;
};

export const botMjpegBoundary = (contentType: string | null): string => {
  if (!contentType || !/^multipart\/x-mixed-replace\s*;/iu.test(contentType)) {
    throw new BotMjpegStreamError('Screen stream is not multipart MJPEG');
  }
  const match = /(?:^|;)\s*boundary=(?:"([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70})"|([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70}))/iu
    .exec(contentType);
  const boundary = match?.[1] || match?.[2] || '';
  if (!boundary || boundary.startsWith('--')) {
    throw new BotMjpegStreamError('Screen stream boundary is invalid');
  }
  return boundary;
};

export class BotMjpegParser {
  private readonly boundary: Uint8Array;
  private readonly headerTerminator = encoder.encode('\r\n\r\n');
  private buffer = new Uint8Array();
  private expectedFrame: {
    length: number;
    width: number;
    height: number;
    deviceScaleFactor: number;
    capturedAt: number | null;
  } | null = null;

  constructor(boundary: string) {
    if (!boundary || boundary.length > 70) {
      throw new BotMjpegStreamError('Screen stream boundary is invalid');
    }
    this.boundary = encoder.encode(`--${boundary}\r\n`);
  }

  push(chunk: Uint8Array): BotMjpegFrame[] {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return [];
    this.buffer = concatenate(this.buffer, chunk);
    if (this.buffer.byteLength > MAX_FRAME_BYTES + MAX_HEADER_BYTES + this.boundary.byteLength) {
      throw new BotMjpegStreamError('Screen frame exceeds its maximum size');
    }

    const frames: BotMjpegFrame[] = [];
    while (true) {
      if (!this.expectedFrame) {
        if (this.buffer.byteLength < this.boundary.byteLength) {
          for (let index = 0; index < this.buffer.byteLength; index += 1) {
            if (this.buffer[index] !== this.boundary[index]) {
              throw new BotMjpegStreamError('Screen stream boundary is malformed');
            }
          }
          break;
        }
        for (let index = 0; index < this.boundary.byteLength; index += 1) {
          if (this.buffer[index] !== this.boundary[index]) {
            throw new BotMjpegStreamError('Screen stream boundary is malformed');
          }
        }
        const headerStart = this.boundary.byteLength;
        const headerOffset = sequenceIndex(this.buffer.subarray(headerStart), this.headerTerminator);
        if (headerOffset < 0) {
          if (this.buffer.byteLength - headerStart > MAX_HEADER_BYTES) {
            throw new BotMjpegStreamError('Screen frame headers are too large');
          }
          break;
        }
        if (headerOffset > MAX_HEADER_BYTES) {
          throw new BotMjpegStreamError('Screen frame headers are too large');
        }
        let headerText: string;
        try {
          headerText = decoder.decode(this.buffer.subarray(headerStart, headerStart + headerOffset));
        } catch {
          throw new BotMjpegStreamError('Screen frame headers are invalid');
        }
        const headers = new Map<string, string>();
        for (const line of headerText.split('\r\n')) {
          const separator = line.indexOf(':');
          if (separator < 1) throw new BotMjpegStreamError('Screen frame header is malformed');
          const name = line.slice(0, separator).trim().toLowerCase();
          const value = line.slice(separator + 1).trim();
          if (!name || !value || headers.has(name)) {
            throw new BotMjpegStreamError('Screen frame header is malformed');
          }
          headers.set(name, value);
        }
        if (headers.get('content-type')?.toLowerCase() !== 'image/jpeg') {
          throw new BotMjpegStreamError('Screen frame is not a JPEG');
        }
        const lengthRaw = headers.get('content-length') || '';
        if (!/^\d{1,10}$/u.test(lengthRaw)) {
          throw new BotMjpegStreamError('Screen frame length is missing');
        }
        const length = Number(lengthRaw);
        if (!Number.isInteger(length) || length < 4 || length > MAX_FRAME_BYTES) {
          throw new BotMjpegStreamError('Screen frame length is invalid');
        }
        const width = numericHeader(headers, 'x-devryan-width');
        const height = numericHeader(headers, 'x-devryan-height');
        const deviceScaleFactor = numericHeader(
          headers,
          'x-devryan-device-scale-factor',
          { integer: false },
        );
        if (width !== VIEWPORT_WIDTH || height !== VIEWPORT_HEIGHT
          || deviceScaleFactor !== DEVICE_SCALE_FACTOR) {
          throw new BotMjpegStreamError('Screen frame viewport metadata is invalid');
        }
        const capturedRaw = headers.get('x-devryan-captured-at');
        const capturedAt = capturedRaw === undefined ? null : Number(capturedRaw);
        if (capturedAt !== null && (!Number.isFinite(capturedAt) || capturedAt < 0)) {
          throw new BotMjpegStreamError('Screen frame timestamp is invalid');
        }
        this.expectedFrame = { length, width, height, deviceScaleFactor, capturedAt };
        this.buffer = this.buffer.slice(
          headerStart + headerOffset + this.headerTerminator.byteLength,
        );
      }

      const expected = this.expectedFrame;
      if (!expected || this.buffer.byteLength < expected.length + 2) break;
      const bytes = this.buffer.slice(0, expected.length);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8
        || bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9
        || this.buffer[expected.length] !== 0x0d || this.buffer[expected.length + 1] !== 0x0a) {
        throw new BotMjpegStreamError('Screen frame JPEG boundary is invalid');
      }
      frames.push({ bytes, ...expected });
      this.buffer = this.buffer.slice(expected.length + 2);
      this.expectedFrame = null;
    }
    return frames;
  }
}
