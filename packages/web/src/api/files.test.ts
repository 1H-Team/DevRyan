import { describe, expect, test, vi, afterEach } from 'vitest';

import { createWebFilesAPI, parseFileWatchEvent } from './files';
import type { FileReadOptions, FileWatchEvent } from '@devryan/ui/lib/api/types';

const originalFetch = globalThis.fetch;
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

describe('createWebFilesAPI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('passes directory options through text reads', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(getRequestUrl(input));
      return new Response('hello', { status: 200 });
    }) as typeof fetch;

    await createWebFilesAPI().readFile?.('/repo/file.txt', { directory: '/repo-worktree' });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0], 'http://127.0.0.1');
    expect(url.pathname).toBe('/api/fs/read');
    expect(url.searchParams.get('path')).toBe('/repo/file.txt');
    expect(url.searchParams.get('directory')).toBe('/repo-worktree');
  });

  test('reads binary files through the raw endpoint with read options', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(getRequestUrl(input));
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }) as typeof fetch;

    const result = await createWebFilesAPI().readFileBinary?.('/repo/image.png', {
      allowOutsideWorkspace: true,
      directory: '/repo-worktree',
    });

    expect(result?.path).toBe('/repo/image.png');
    expect(result?.dataUrl).toBe('data:image/png;base64,AQID');
    const url = new URL(calls[0], 'http://127.0.0.1');
    expect(url.pathname).toBe('/api/fs/raw');
    expect(url.searchParams.get('path')).toBe('/repo/image.png');
    expect(url.searchParams.get('allowOutsideWorkspace')).toBe('true');
    expect(url.searchParams.get('directory')).toBe('/repo-worktree');
  });

  test('includes directory options in download URLs', async () => {
    const click = vi.fn();
    const appended: Array<{ href: string; download: string; click: () => void }> = [];
    const mockAnchor = { href: '', download: '', click };
    const mockDocument = {
      createElement: () => mockAnchor,
      body: {
        appendChild: <T extends Node>(node: T): T => {
          appended.push(node as unknown as { href: string; download: string; click: () => void });
          return node;
        },
        removeChild: <T extends Node>(node: T): T => node,
      },
    } as unknown as Document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: mockDocument,
    });

    await (createWebFilesAPI().downloadFile as (path: string, options?: FileReadOptions) => Promise<void>)(
      '/repo/file.txt',
      { directory: '/repo-worktree' },
    );

    const anchor = appended[0];
    expect(anchor).toBeTruthy();
    const url = new URL(anchor.href, 'http://127.0.0.1');
    expect(url.pathname).toBe('/api/fs/raw');
    expect(url.searchParams.get('path')).toBe('/repo/file.txt');
    expect(url.searchParams.get('download')).toBe('true');
    expect(url.searchParams.get('directory')).toBe('/repo-worktree');
    expect(click).toHaveBeenCalledTimes(1);
  });

  const streamResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  test('streams watch hints over same-origin fetch and parses split SSE frames', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: getRequestUrl(input), init });
      return streamResponse([
        'data: {"type":"ready","epoch":7}\n\n:heartbeat\n\n',
        'data: {"type":"invalidate","epoch":7,"slot":{"kind":"expanded","index":1}}\r\n',
        '\r\ndata: {"type":"invalidate","epoch":7,"slot":{"kind":"selected"}}\n\ndata: {"type":"resync","ep',
        'och":7}\n\ndata: {"type":"invalidate","epoch":7,"slot":{"kind":"secret","name":".env"}}\n\n',
      ]);
    }) as typeof fetch;

    const events: FileWatchEvent[] = [];
    const controller = new AbortController();
    await createWebFilesAPI().watch?.(
      { directory: 'C:\\repo', expandedDirectories: ['src', 'src\\lib'], selectedFile: 'docs/readme.md' },
      (event) => events.push(event),
      controller.signal,
    );

    expect(events).toEqual([
      { type: 'ready', epoch: 7 },
      { type: 'invalidate', epoch: 7, slot: { kind: 'expanded', index: 1 } },
      { type: 'invalidate', epoch: 7, slot: { kind: 'selected' } },
      { type: 'resync', epoch: 7 },
    ]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url, 'http://127.0.0.1');
    expect(calls[0].url.startsWith('/api/fs/watch?')).toBe(true);
    expect(url.searchParams.get('directory')).toBe('C:/repo');
    expect(url.searchParams.getAll('expanded')).toEqual(['src', 'src/lib']);
    expect(url.searchParams.get('selected')).toBe('docs/readme.md');
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect(calls[0].init?.cache).toBe('no-store');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('maps a 4xx to unavailable without retry and rejects server failures for retry', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'File not found' }), { status: 404 })) as typeof fetch;
    const events: FileWatchEvent[] = [];
    await createWebFilesAPI().watch?.({ directory: '/repo', expandedDirectories: [] }, (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: 'unavailable', epoch: 0, retryable: false }]);

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'fs_watch_capacity' }), { status: 503 })) as typeof fetch;
    await expect(createWebFilesAPI().watch?.({ directory: '/repo', expandedDirectories: [] }, () => {}, new AbortController().signal))
      .rejects.toThrow('status 503');

    globalThis.fetch = vi.fn(async () => { throw new TypeError('network down'); }) as typeof fetch;
    await expect(createWebFilesAPI().watch?.({ directory: '/repo', expandedDirectories: [] }, () => {}, new AbortController().signal))
      .rejects.toThrow('network down');
  });

  test('keeps polling without a request for scopes over 64 directories or 8 KB', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const events: FileWatchEvent[] = [];
    const api = createWebFilesAPI();
    await api.watch?.({ directory: '/repo', expandedDirectories: Array.from({ length: 64 }, (_, index) => `d${index}`) },
      (event) => events.push(event), new AbortController().signal);
    await api.watch?.({ directory: '/repo', expandedDirectories: [`${'x'.repeat(8_200)}`] },
      (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([
      { type: 'unavailable', epoch: 0, retryable: false },
      { type: 'unavailable', epoch: 0, retryable: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('times out a silent stream after 45 s and resolves quietly when the caller aborts', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }), { status: 200 })) as typeof fetch;
      const silent = createWebFilesAPI().watch?.({ directory: '/repo', expandedDirectories: [] }, () => {}, new AbortController().signal);
      const settled = expect(silent).rejects.toThrow('File watch timed out');
      await vi.advanceTimersByTimeAsync(45_000);
      await settled;

      const controller = new AbortController();
      const events: FileWatchEvent[] = [];
      const aborted = createWebFilesAPI().watch?.({ directory: '/repo', expandedDirectories: [] }, (event) => events.push(event), controller.signal);
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await expect(aborted).resolves.toBeUndefined();
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects malformed watch payloads', () => {
    expect(parseFileWatchEvent('not json')).toBeNull();
    expect(parseFileWatchEvent('{"type":"ready"}')).toBeNull();
    expect(parseFileWatchEvent('{"type":"invalidate","epoch":1,"slot":{"kind":"expanded","index":-1}}')).toBeNull();
    expect(parseFileWatchEvent('{"type":"unavailable","epoch":2,"retryable":true}')).toEqual({ type: 'unavailable', epoch: 2, retryable: true });
  });
});
