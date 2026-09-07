import { describe, expect, test } from 'bun:test';

import { createBotImagePreviewCache } from './botImagePreviewCache';

describe('Bot image preview cache', () => {
  test('deduplicates concurrent fetches and revokes the URL after the final consumer', async () => {
    let loadCalls = 0;
    const load = async () => {
      loadCalls += 1;
      return new Blob(['png'], { type: 'image/png' });
    };
    const revoked: string[] = [];
    const cache = createBotImagePreviewCache({
      createObjectURL: () => 'blob:preview',
      revokeObjectURL: (url) => { revoked.push(url); },
    });
    const first = cache.acquire('object:one', load, 'image/png');
    const second = cache.acquire('object:one', load, 'image/png');
    expect(await first).toBe('blob:preview');
    expect(await second).toBe('blob:preview');
    expect(loadCalls).toBe(1);
    cache.release('object:one');
    expect(revoked).toEqual([]);
    cache.release('object:one');
    expect(revoked).toEqual(['blob:preview']);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test('aborts an unneeded request and rejects SVG payloads', async () => {
    let aborted = false;
    const cache = createBotImagePreviewCache();
    const pending = cache.acquire('object:pending', (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }));
    cache.release('object:pending');
    expect(await pending.catch((error) => error.message)).toBe('aborted');
    expect(aborted).toBe(true);
    expect(cache.size).toBe(0);

    expect(await cache.acquire(
      'object:svg',
      async () => new Blob(['svg'], { type: 'image/svg+xml' }),
    ).catch((error) => error.message)).toBe('unsupported_image');
  });

  test('reacquires immediately after release without reusing an aborted fetch', async () => {
    let rejectOld: (reason: Error) => void = () => {};
    let resolveNew: (blob: Blob) => void = () => {};
    const revoked: string[] = [];
    const cache = createBotImagePreviewCache({
      createObjectURL: () => 'blob:new',
      revokeObjectURL: (url) => { revoked.push(url); },
    });
    const old = cache.acquire('same', () => new Promise<Blob>((_resolve, reject) => {
      rejectOld = reject;
    })).catch((error: Error) => error.message);
    cache.release('same');
    const fresh = cache.acquire('same', () => new Promise<Blob>((resolve) => {
      resolveNew = resolve;
    }));
    rejectOld(new Error('aborted'));
    expect(await old).toBe('aborted');
    expect(cache.size).toBe(1);
    resolveNew(new Blob(['png'], { type: 'image/png' }));
    expect(await fresh).toBe('blob:new');
    cache.release('same');
    expect(revoked).toEqual(['blob:new']);
    expect(cache.bytes).toBe(0);
  });

  test('discards late bytes from a released loader that ignores abort', async () => {
    let finish: (blob: Blob) => void = () => {};
    let created = 0;
    const cache = createBotImagePreviewCache({
      createObjectURL: () => { created += 1; return 'blob:stale'; },
    });
    const pending = cache.acquire('old', () => new Promise<Blob>((resolve) => {
      finish = resolve;
    })).catch((error: Error) => error.message);
    cache.release('old');
    finish(new Blob(['png'], { type: 'image/png' }));
    expect(await pending).toBe('preview_aborted');
    expect(created).toBe(0);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test('enforces its byte bound before creating an object URL', async () => {
    let createCalls = 0;
    const cache = createBotImagePreviewCache({
      maxBytes: 2,
      createObjectURL: () => {
        createCalls += 1;
        return 'blob:too-large';
      },
    });
    expect(await cache.acquire(
      'object:large',
      async () => new Blob(['123'], { type: 'image/png' }),
    ).catch((error) => error.message)).toBe('preview_capacity');
    expect(createCalls).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
