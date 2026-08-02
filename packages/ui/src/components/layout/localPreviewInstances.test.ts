import { describe, expect, test } from 'bun:test';

import type { DirectoryTerminalState, TerminalTab } from '@/stores/useTerminalStore';
import {
  fetchReachableLocalInstanceOrigins,
  projectLocalPreviewInstances,
} from './localPreviewInstances';

const createTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab-1',
  terminalSessionId: 'terminal-1',
  lifecycle: 'running',
  label: 'Action: web',
  iconKey: null,
  bufferChunks: [],
  bufferLength: 0,
  isConnecting: false,
  createdAt: 1,
  previewUrl: 'http://localhost:3001/docs?tab=api',
  previewAutoOpened: false,
  previewUrlLocked: false,
  ...overrides,
});

const createDirectoryState = (tabs: TerminalTab[]): DirectoryTerminalState => ({
  tabs,
  activeTabId: tabs[0]?.id ?? null,
});

describe('local preview instance projection', () => {
  test('keeps running loopback previews in terminal order and preserves their paths', () => {
    const instances = projectLocalPreviewInstances(createDirectoryState([
      createTab(),
      createTab({
        id: 'tab-2',
        terminalSessionId: 'terminal-2',
        label: 'devryan-live',
        previewUrl: 'http://127.0.0.1:5180/',
      }),
    ]), 'Local server');

    expect(instances).toEqual([
      {
        id: 'tab-1',
        terminalSessionId: 'terminal-1',
        label: 'web',
        url: 'http://127.0.0.1:3001/docs?tab=api',
        origin: 'http://127.0.0.1:3001',
        port: '3001',
      },
      {
        id: 'tab-2',
        terminalSessionId: 'terminal-2',
        label: 'devryan-live',
        url: 'http://127.0.0.1:5180/',
        origin: 'http://127.0.0.1:5180',
        port: '5180',
      },
    ]);
  });

  test('requires a live running terminal and rejects public previews', () => {
    const instances = projectLocalPreviewInstances(createDirectoryState([
      createTab({ id: 'idle', lifecycle: 'idle' }),
      createTab({ id: 'exited', lifecycle: 'exited' }),
      createTab({ id: 'detached', terminalSessionId: null }),
      createTab({ id: 'missing-url', previewUrl: null }),
      createTab({ id: 'public', previewUrl: 'https://example.com/' }),
    ]), 'Local server');

    expect(instances).toEqual([]);
  });

  test('deduplicates normalized origins and supplies fallback labels and default ports', () => {
    const instances = projectLocalPreviewInstances(createDirectoryState([
      createTab({ label: 'Action:   ', previewUrl: 'http://localhost/path' }),
      createTab({ id: 'duplicate', previewUrl: 'http://127.0.0.1/other' }),
      createTab({
        id: 'secure',
        terminalSessionId: 'terminal-secure',
        label: 'Secure preview',
        previewUrl: 'https://127.0.0.1/account',
      }),
    ]), 'Local server');

    expect(instances.map(({ label, port, url }) => ({ label, port, url }))).toEqual([
      { label: 'Local server', port: '80', url: 'http://127.0.0.1/path' },
      { label: 'Secure preview', port: '443', url: 'https://127.0.0.1/account' },
    ]);
  });
});

describe('local instance liveness client', () => {
  test('returns only origins confirmed reachable by the server', async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('/api/preview/local-instances/status');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        urls: ['http://127.0.0.1:3001/', 'http://127.0.0.1:5180/'],
      });
      return Response.json({
        results: [
          { url: 'http://127.0.0.1:3001/', origin: 'http://127.0.0.1:3001', status: 'reachable' },
          { url: 'http://127.0.0.1:5180/', origin: 'http://127.0.0.1:5180', status: 'unreachable' },
        ],
      });
    };

    const reachable = await fetchReachableLocalInstanceOrigins([
      'http://127.0.0.1:3001/',
      'http://127.0.0.1:5180/',
    ], undefined, fetchImpl as typeof fetch);
    expect(reachable).toEqual(new Set(['http://127.0.0.1:3001']));
  });

  test('rejects failed status responses so callers can retain their last result', async () => {
    const fetchImpl = async () => new Response('{}', { status: 503 });
    let error: unknown;
    try {
      await fetchReachableLocalInstanceOrigins(
        ['http://127.0.0.1:3001/'],
        undefined,
        fetchImpl as typeof fetch,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 503');
  });
});
