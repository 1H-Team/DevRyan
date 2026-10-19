import { describe, expect, test, vi, afterEach } from 'vitest';

import { createWebFilesAPI } from './files';
import type { FileReadOptions } from '@devryan/ui/lib/api/types';

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
});
