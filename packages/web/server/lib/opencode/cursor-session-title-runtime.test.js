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
  it('retains a generated title when the metadata reread fails before saving', async () => {
    const generateTitle = vi.fn(async () => 'Cursor usage accounting');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sessionResponse('Untitled Session'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(sessionResponse('Untitled Session'))
      .mockResolvedValueOnce(sessionResponse('Untitled Session'))
      .mockResolvedValueOnce(sessionResponse('Cursor usage accounting'));
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle },
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl,
    });
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).toBe(false);
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).toBe(true);
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(1);
  });

  it('retries a failed title save with the generated result instead of another inference', async () => {
    let title = 'Untitled Session';
    let patches = 0;
    const generateTitle = vi.fn(async () => 'Cursor usage accounting');
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle },
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl: async (_url, options) => {
        if (options.method === 'PATCH') {
          if (++patches === 1) return { ok: false };
          title = JSON.parse(options.body).title;
        }
        return sessionResponse(title);
      },
    });
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).toBe(false);
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).toBe(true);
    expect(title).toBe('Cursor usage accounting');
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(patches).toBe(2);
  });

  it('invalidates an unsaved title when the source or project changes and preserves manual names', async () => {
    let text = 'First source';
    let title = 'Untitled Session';
    const generateTitle = vi.fn(async () => 'Generated title');
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(text), generateTitle },
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl: async (_url, options) => options.method === 'PATCH' ? { ok: false } : sessionResponse(title),
    });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture-a' });
    text = 'Changed source';
    await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture-a' });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture-b' });
    expect(generateTitle).toHaveBeenCalledTimes(3);
    title = 'User supplied title';
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture-b' })).toBe(false);
    expect(generateTitle).toHaveBeenCalledTimes(3);
    title = 'Untitled Session';
    await runtime.schedule({ sessionID: 'ses_1', directory: '/fixture-b' });
    expect(generateTitle).toHaveBeenCalledTimes(4);
  });

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
      sessionID: 'ses_1',
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
