import { BOT_PREVIEW_IMAGE_TYPES } from './botResultImageSources';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 12;

type PreviewEntry = {
  controller: AbortController;
  promise: Promise<string>;
  url: string | null;
  refs: number;
  bytes: number;
};

export const verifyBotImageBlob = (blob: Blob, expectedType?: string): Blob => {
  const type = blob.type.toLowerCase();
  if (!BOT_PREVIEW_IMAGE_TYPES.has(type) || (expectedType && type !== expectedType.toLowerCase())) {
    throw new Error('unsupported_image');
  }
  return blob;
};

export const createBotImagePreviewCache = ({
  maxBytes = DEFAULT_MAX_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  createObjectURL = (blob: Blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url: string) => URL.revokeObjectURL(url),
} = {}) => {
  const entries = new Map<string, PreviewEntry>();
  let totalBytes = 0;

  return Object.freeze({
    acquire(
      key: string,
      load: (signal: AbortSignal) => Promise<Blob>,
      expectedType?: string,
    ): Promise<string> {
      const existing = entries.get(key);
      if (existing) {
        existing.refs += 1;
        return existing.promise;
      }
      if (entries.size >= maxEntries || totalBytes >= maxBytes) {
        return Promise.reject(new Error('preview_capacity'));
      }
      const controller = new AbortController();
      const entry: PreviewEntry = {
        controller,
        promise: Promise.resolve(''),
        url: null,
        refs: 1,
        bytes: 0,
      };
      entry.promise = load(controller.signal).then((loaded) => {
        const blob = verifyBotImageBlob(loaded, expectedType);
        if (blob.size > maxBytes || totalBytes + blob.size > maxBytes) {
          throw new Error('preview_capacity');
        }
        entry.bytes = blob.size;
        totalBytes += blob.size;
        entry.url = createObjectURL(blob);
        if (entry.refs === 0) {
          revokeObjectURL(entry.url);
          totalBytes -= entry.bytes;
          entries.delete(key);
        }
        return entry.url;
      }).catch((error) => {
        entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },

    release(key: string): void {
      const entry = entries.get(key);
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0) return;
      entry.controller.abort();
      if (entry.url) {
        revokeObjectURL(entry.url);
        totalBytes = Math.max(0, totalBytes - entry.bytes);
        entries.delete(key);
      }
    },

    get size() { return entries.size; },
    get bytes() { return totalBytes; },
  });
};
