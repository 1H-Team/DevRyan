import { describe, expect, it, vi } from 'vitest';

import { createVSCodeToolsAPI } from './tools';

describe('VS Code tools runtime API', () => {
  it('matches the web tool manifest shape with VS Code runtime metadata', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(['patch', 'invalid', 'task', 'patch', {}, '']), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    try {
      const api = createVSCodeToolsAPI({ getDirectory: () => '/workspace' });

      await expect(api.getAvailableTools()).resolves.toEqual(['patch', 'task']);
      await expect(api.getToolManifest()).resolves.toEqual({
        tools: [
          { id: 'patch', aliases: ['edit', 'write', 'patch', 'apply_patch'], sourceRuntime: 'vscode', directory: '/workspace' },
          { id: 'task', aliases: ['task'], sourceRuntime: 'vscode', directory: '/workspace' },
        ],
        aliases: {
          patch: ['edit', 'write', 'patch', 'apply_patch'],
          task: ['task'],
        },
        sourceRuntime: 'vscode',
        directory: '/workspace',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects HTTP failures and malformed payloads through the bridged fetch contract', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
      new Response(JSON.stringify({ tools: ['task'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift() as Response) as unknown as typeof fetch;

    try {
      const api = createVSCodeToolsAPI();
      await expect(api.getAvailableTools()).rejects.toThrow('Tools API returned 403 Forbidden');
      await expect(api.getToolManifest()).rejects.toThrow('Tools API returned invalid data format');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
