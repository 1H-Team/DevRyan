import { describe, expect, it, vi } from 'vitest';

import { createCursorSessionTitleRuntime } from './cursor-session-title-runtime.js';

const sessionResponse = (title) => ({
  ok: true,
  json: vi.fn(async () => ({ id: 'ses_1', title })),
});

const cursorRecords = (text = 'Fix the Cursor provider session title summarization') => ([{
  info: { id: 'msg_1', role: 'user', providerID: 'cursor-acp' },
  parts: [
    { type: 'text', text: 'Hidden plan instruction', synthetic: true },
    { type: 'text', text },
  ],
}]);

describe('Cursor session title runtime', () => {
  it('generates and persists an AI title from the earliest visible Cursor user text', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sessionResponse('New session - 2026-07-10T12:00:00.000Z'))
      .mockResolvedValueOnce(sessionResponse('New session - 2026-07-10T12:00:00.000Z'))
      .mockResolvedValueOnce(sessionResponse('Fix Cursor Session Titles'));
    const generateTitle = vi.fn(async () => 'Fix Cursor Session Titles');
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: {
        getSessionMessages: vi.fn(async () => cursorRecords()),
        generateTitle,
      },
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(generateTitle).toHaveBeenCalledWith({
      text: 'Fix the Cursor provider session title summarization',
      directory: '/tmp/project',
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://opencode.test/session/ses_1?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Fix Cursor Session Titles' }),
      }),
    );
  });

  it('does not generate a title for a custom session name', async () => {
    const fetchImpl = vi.fn(async () => sessionResponse('Hand-written session title'));
    const generateTitle = vi.fn(async () => 'Ignored AI Title');
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: {
        getSessionMessages: vi.fn(async () => cursorRecords()),
        generateTitle,
      },
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(generateTitle).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deduplicates in-flight jobs and preserves a title renamed while generation runs', async () => {
    let resolveTitle;
    const titlePromise = new Promise((resolve) => { resolveTitle = resolve; });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sessionResponse('Untitled Session'))
      .mockResolvedValueOnce(sessionResponse('Renamed by user'));
    const generateTitle = vi.fn(() => titlePromise);
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: {
        getSessionMessages: vi.fn(async () => cursorRecords()),
        generateTitle,
      },
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    const first = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    const second = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    resolveTitle('Generated Title');
    await Promise.all([first, second]);

    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it('repairs a legacy truncated raw-prompt title on the next Cursor interaction', async () => {
    const text = 'Investigate why Cursor sessions keep the complete prompt instead of a concise generated summary';
    const legacyTitle = `${text.slice(0, 45)}...`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sessionResponse(legacyTitle))
      .mockResolvedValueOnce(sessionResponse(legacyTitle))
      .mockResolvedValueOnce(sessionResponse('Summarize Cursor Session Titles'));
    const generateTitle = vi.fn(async () => 'Summarize Cursor Session Titles');
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: {
        getSessionMessages: vi.fn(async () => cursorRecords(text)),
        generateTitle,
      },
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true);
  });

  it('allows a later Cursor prompt to retry after title generation fails', async () => {
    const fetchImpl = vi.fn(async () => sessionResponse('cursor-acp error: Provider Error'));
    const generateTitle = vi.fn()
      .mockRejectedValueOnce(new Error('title unavailable'))
      .mockResolvedValueOnce('Recovered Cursor Title');
    const warn = vi.fn();
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: {
        getSessionMessages: vi.fn(async () => cursorRecords()),
        generateTitle,
      },
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(generateTitle).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true);
  });
});
