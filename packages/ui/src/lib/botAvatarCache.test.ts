import { describe, expect, test } from 'bun:test';
import { createBotAvatarCache, type BotAvatarIdentity } from './botAvatarCache';

const identity = (botId = 'a', source = '/avatar?v=1'): BotAvatarIdentity => ({ principalId: 'member', botId, source });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const image = (url: string, bytes = 10) => ({ url, bytes, dispose() {} });

describe('private Bot avatar cache', () => {
  test('deduplicates consumers, retains warm images, and isolates identities', async () => {
    let requests = 0;
    const cache = createBotAvatarCache({ load: async (id) => { requests++; return image(id.botId); } });
    const sidebar = cache.subscribe(identity(), () => {});
    const header = cache.subscribe(identity(), () => {});
    await flush();
    expect(requests).toBe(1);
    expect(cache.peek(identity())).toBe('a');
    sidebar(); header();
    const remount = cache.subscribe(identity(), () => {});
    expect(cache.peek(identity())).toBe('a');
    await flush();
    expect(requests).toBe(1);
    expect(cache.peek({ ...identity(), principalId: 'other' })).toBeNull();
    expect(cache.peek(identity('a', '/avatar?v=2'))).toBeNull();
    remount(); cache.clear();
  });
  test('late completions cannot restore invalidated or replaced images', async () => {
    let finish: (value: ReturnType<typeof image>) => void = () => {};
    let aborted = false;
    let disposed = false;
    const cache = createBotAvatarCache({ load: (_id, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise((resolve) => { finish = resolve; });
    } });
    cache.prefetch(identity());
    await flush();
    cache.invalidateBot('a');
    finish({ url: 'old', bytes: 10, dispose() { disposed = true; } });
    await flush();
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
    expect(cache.peek(identity())).toBeNull();
    expect(cache.bytes).toBe(0);
  });
  test('prioritizes selection and limits loading to four requests', async () => {
    const started: string[] = [];
    const cache = createBotAvatarCache({ load: async (id, signal) => {
      started.push(id.botId);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } });
    for (let i = 0; i < 8; i++) cache.prefetch(identity(String(i)), 0);
    cache.prefetch(identity('7'), 2);
    await flush();
    expect(started).toEqual(['7', '0', '1', '2']);
    cache.clear(); await flush();
  });
  test('evicts unused LRU entries within count and byte limits; protects mounted images', async () => {
    const disposed: string[] = [];
    const cache = createBotAvatarCache({ maxEntries: 2, maxBytes: 20, load: async (id) => ({
      ...image(id.botId), dispose() { disposed.push(id.botId); },
    }) });
    const release = cache.subscribe(identity('a'), () => {});
    cache.prefetch(identity('b')); await flush();
    cache.prefetch(identity('c')); await flush();
    expect(cache.peek(identity('a'))).toBe('a');
    expect(cache.peek(identity('b'))).toBeNull();
    expect(cache.peek(identity('c'))).toBe('c');
    expect(cache.size).toBe(2); expect(cache.bytes).toBe(20);
    expect(disposed).toEqual(['b']);
    release(); cache.clear();
    expect(cache.bytes).toBe(0);
  });
  test('a later consumer retries failure without a retry loop', async () => {
    let attempts = 0;
    const cache = createBotAvatarCache({ load: async () => { if (++attempts === 1) throw new Error('offline'); return image('ok'); } });
    const release = cache.subscribe(identity(), () => {}); await flush();
    expect(attempts).toBe(1); expect(cache.peek(identity())).toBeNull();
    release();
    cache.prefetch(identity()); await flush();
    expect(cache.peek(identity())).toBe('ok');
    expect(attempts).toBe(2); cache.clear();
  });
});

test('legacy photos are decoded at avatar size for retention and every object URL is released', async () => {
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const { spyOn } = await import('bun:test');
  const requests: RequestInit[] = [];
  const revoked: string[] = [];
  const draws: number[][] = [];
  let images = 0;
  let urls = 0;
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    src = '';
    readonly naturalWidth = ++images === 1 ? 512 : 256;
    readonly naturalHeight = this.naturalWidth / 2;
    decode() { return Promise.resolve(); }
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement() { return {
      width: 0, height: 0,
      getContext() { return { drawImage(_image: object, ...dimensions: number[]) { draws.push(dimensions); } }; },
      toBlob(callback: BlobCallback, type: string) { callback(new Blob(['png'], { type })); },
    }; },
  } });
  const fetchImage = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init) requests.push(init);
    return new Response(new Blob(['old photo'], { type: 'image/png' }));
  });
  const createUrl = spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++urls}`);
  const revokeUrl = spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url); });
  const cache = createBotAvatarCache();
  try {
    cache.prefetch(identity());
    // Response.blob() settles through the host event loop as well as microtasks.
    for (let i = 0; i < 30 && !cache.peek(identity()); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.peek(identity())).toBe('blob:2');
    expect(requests[0].credentials).toBe('same-origin');
    expect(requests[0].cache).toBe('no-store');
    expect(draws).toEqual([[0, 0, 256, 128]]);
    expect(cache.bytes).toBe(3 + 256 * 128 * 4);
    expect(revoked).toEqual(['blob:1']);
    cache.clear();
    expect(revoked).toEqual(['blob:1', 'blob:2']);
  } finally {
    cache.clear(); fetchImage.mockRestore(); createUrl.mockRestore(); revokeUrl.mockRestore();
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage); else Reflect.deleteProperty(globalThis, 'Image');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
