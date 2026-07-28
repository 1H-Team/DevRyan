import { describe, expect, it, vi } from 'vitest';

import { createStandardSessionTitleRuntime } from './standard-session-title-runtime.js';

const response = (payload) => ({
  ok: true,
  json: vi.fn(async () => payload),
});

const messageRecords = (text = 'Fix OpenAI session title summarization') => ([{
  info: { id: 'msg_1', role: 'user' },
  parts: [
    { type: 'text', text: 'Hidden instruction', synthetic: true },
    { type: 'text', text },
  ],
}]);

describe('standard session title runtime', () => {
  it('generates and persists an AI title from the earliest visible user text', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Fix OpenAI Session Titles' }));
    const generateTitle = vi.fn(async () => 'Fix OpenAI Session Titles');
    const runtime = createStandardSessionTitleRuntime({
      generateTitle,
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(generateTitle).toHaveBeenCalledWith({
      text: 'Fix OpenAI session title summarization',
      directory: '/tmp/project',
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://opencode.test/session/ses_1?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Fix OpenAI Session Titles' }),
      }),
    );
  });

  it('uses the accepted prompt text when the upstream message list has not materialized yet', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Fix OpenAI Session Titles' }));
    const generateTitle = vi.fn(async () => 'Fix OpenAI Session Titles');
    const runtime = createStandardSessionTitleRuntime({
      generateTitle,
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      text: 'Fix OpenAI session title summarization',
    });

    expect(generateTitle).toHaveBeenCalledWith({
      text: 'Fix OpenAI session title summarization',
      directory: '/tmp/project',
    });
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true);
  });

  it('persists a meaningful prompt-based title when model summarization is unavailable', async () => {
    const zenFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn(async () => ({})),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords('Repair Anthropic title fallback')))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: '<!--plan-->' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: '<!--plan-->' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Repair Anthropic title fallback' }));
    const runtime = createStandardSessionTitleRuntime({
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    try {
      await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    } finally {
      zenFetch.mockRestore();
      consoleError.mockRestore();
    }

    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://opencode.test/session/ses_1?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Repair Anthropic title fallback' }),
      }),
    );
  });

  it('preserves an explicit or historical raw-prompt title without requesting a generated title', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Fix OpenAI session title summarization' }));
    const generateTitle = vi.fn(async () => 'Ignored AI Title');
    const runtime = createStandardSessionTitleRuntime({
      generateTitle,
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(generateTitle).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('deduplicates in-flight jobs and preserves a title renamed during generation', async () => {
    let resolveTitle;
    const titlePromise = new Promise((resolve) => { resolveTitle = resolve; });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Untitled Session' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Renamed by user' }));
    const generateTitle = vi.fn(() => titlePromise);
    const runtime = createStandardSessionTitleRuntime({
      generateTitle,
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
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it.each(['<!--plan-->', '<-----plan------>'])('replaces an existing plan control title: %s', async (controlTitle) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords('Plan the Anthropic title repair')))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: controlTitle }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: controlTitle }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Repair Anthropic Session Titles' }));
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Repair Anthropic Session Titles'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://opencode.test/session/ses_1?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Repair Anthropic Session Titles' }),
      }),
    );
  });

  it('replaces a plan control title that arrives while generation is in flight', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords('Plan the Anthropic title repair')))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Untitled Session' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: '<!--plan-->' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Repair Anthropic Session Titles' }));
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Repair Anthropic Session Titles'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true);
  });

  it('backfills and persists generated titles for historical marker sessions', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([
        { id: 'ses_marker', title: '<!--plan-->' },
        { id: 'ses_manual', title: 'Manual Session Title' },
      ]))
      .mockResolvedValueOnce(response(messageRecords('Plan the Anthropic title repair')))
      .mockResolvedValueOnce(response({ id: 'ses_marker', title: '<!--plan-->' }))
      .mockResolvedValueOnce(response({ id: 'ses_marker', title: '<!--plan-->' }))
      .mockResolvedValueOnce(response({ id: 'ses_marker', title: 'Repair Anthropic Session Titles' }));
    const generateTitle = vi.fn(async () => 'Repair Anthropic Session Titles');
    const runtime = createStandardSessionTitleRuntime({
      generateTitle,
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.scheduleMarkerBackfill({ directory: '/tmp/project' });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://opencode.test/session?directory=%2Ftmp%2Fproject',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://opencode.test/session/ses_marker?directory=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Repair Anthropic Session Titles' }),
      }),
    );
  });

  it('deduplicates concurrent historical marker scans by directory', async () => {
    let resolveSessions;
    const sessionsPromise = new Promise((resolve) => { resolveSessions = resolve; });
    const fetchImpl = vi.fn(() => sessionsPromise);
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    const first = runtime.scheduleMarkerBackfill({ directory: '/tmp/project' });
    const second = runtime.scheduleMarkerBackfill({ directory: '/tmp/project' });
    resolveSessions(response([]));
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not persist a generated plan control title', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords('Plan the Anthropic title repair')))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Untitled Session' }));
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => '<!--plan-->'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it('retries on a later prompt after title generation fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Untitled Session' }))
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Untitled Session' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Untitled Session' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Recovered Session Title' }));
    const generateTitle = vi.fn()
      .mockRejectedValueOnce(new Error('title unavailable'))
      .mockResolvedValueOnce('Recovered Session Title');
    const warn = vi.fn();
    const runtime = createStandardSessionTitleRuntime({
      generateTitle,
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
