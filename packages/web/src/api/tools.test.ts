import { describe, expect, it, vi } from 'vitest';

import { createWebToolsAPI } from './tools';

describe('web tools runtime API', () => {
  it('deduplicates and sorts discovery while adding directory-attributed manifest entries', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(['write', 'invalid', 'read', 'edit', 'read', 42, '']), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    try {
      const api = createWebToolsAPI({ getDirectory: () => '/repo' });

      await expect(api.getAvailableTools()).resolves.toEqual(['edit', 'read', 'write']);
      await expect(api.getToolManifest()).resolves.toEqual({
        tools: [
          { id: 'edit', aliases: ['edit', 'write', 'patch', 'apply_patch'], sourceRuntime: 'web', directory: '/repo' },
          { id: 'read', aliases: ['read'], sourceRuntime: 'web', directory: '/repo' },
          { id: 'write', aliases: ['edit', 'write', 'patch', 'apply_patch'], sourceRuntime: 'web', directory: '/repo' },
        ],
        aliases: {
          edit: ['edit', 'write', 'patch', 'apply_patch'],
          read: ['read'],
          write: ['edit', 'write', 'patch', 'apply_patch'],
        },
        sourceRuntime: 'web',
        directory: '/repo',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects HTTP failures and malformed payloads deterministically', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }),
      new Response(JSON.stringify({ tools: ['read'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift() as Response) as unknown as typeof fetch;

    try {
      const api = createWebToolsAPI();
      await expect(api.getAvailableTools()).rejects.toThrow('Tools API returned 503 Service Unavailable');
      await expect(api.getToolManifest()).rejects.toThrow('Tools API returned invalid data format');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
