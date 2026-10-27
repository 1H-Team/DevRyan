import { createNativeConsumerFixture } from './test-native-consumer-client.js';
const createCursorSessionTitleRuntime = (options = {}) => createCursorSessionTitleRuntimeNative({
  ...options, openCodeClient: options.openCodeClient ?? createNativeConsumerFixture({
    readFixture: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)), headers: options.getOpenCodeAuthHeaders,
  }),
});
import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createCursorSessionTitleRuntime as createCursorSessionTitleRuntimeNative } from './cursor-session-title-runtime.js';

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
  it('scheduled title callbacks retain the original request context and cannot borrow a later caller after revocation', async () => {
    const requests = new AsyncLocalStorage();
    const original = { id: 'original', allowed: true }, replacement = { id: 'replacement', allowed: true };
    let releaseRead;
    const read = new Promise(resolve => { releaseRead = resolve; });
    const captured = [], patches = [], physical = [];
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: {
        getSessionMessages: async () => cursorRecords(),
        generateTitle: async input => {
          const caller = requests.getStore();captured.push({ caller, input });
          if (!caller?.allowed) throw new Error('original caller revoked');
          physical.push(caller.id);return 'Owned title';
        },
      },
      buildOpenCodeUrl: requestPath => `http://opencode.test${requestPath}`,
      fetchImpl: async (_url, options) => {
        if (options.method === 'PATCH') { patches.push(options.body);return { ok: true }; }
        await read;return sessionResponse('Untitled Session');
      },
      logger: { warn: vi.fn() },
    });
    const job = requests.run(original, () => runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' }));
    original.allowed = false;
    await requests.run(replacement, async () => { releaseRead();expect(await job).toBe(false); });
    expect(captured).toEqual([{ caller: original, input: { sessionID: 'ses_1', directory: '/fixture', text: 'Fix the Cursor provider session title summarization' } }]);
    expect(physical).toEqual([]);expect(patches).toEqual([]);
  });

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

// Gen 2 (DESIGN C.1, E item 13b): the session read and title PATCH go through openCodeClient.
describe('Cursor session title runtime on OpenCode 2 (openCodeClient)', () => {
  const createClient = ({ generation = 2, titles = ['Untitled Session'], update } = {}) => {
    let title = titles[0];
    let reads = 0;
    return {
      generation: typeof generation === 'function' ? generation : () => generation,
      sessions: {
        get: vi.fn(async (sessionID) => {
          title = titles[Math.min(reads, titles.length - 1)] ?? title;
          reads += 1;
          return { id: sessionID, title, directory: '/fixture' };
        }),
        update: update ?? vi.fn(async (sessionID, patch) => ({ id: sessionID, title: patch.title })),
      },
    };
  };

  it('reads and renames the session through the client', async () => {
    const fetchImpl = vi.fn();
    const openCodeClient = createClient();
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle: async () => 'Cursor usage accounting' },
      fetchImpl,
      openCodeClient,
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).resolves.toBe(true);
    expect(openCodeClient.sessions.get).toHaveBeenCalledWith('ses_1', { directory: '/fixture' });
    expect(openCodeClient.sessions.update).toHaveBeenCalledWith('ses_1', { title: 'Cursor usage accounting' }, { directory: '/fixture' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the generated title for the next run when the client refuses the PATCH', async () => {
    const generateTitle = vi.fn(async () => 'Cursor usage accounting');
    const update = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 409 }))
      .mockImplementation(async (sessionID, patch) => ({ id: sessionID, title: patch.title }));
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle },
      openCodeClient: createClient({ update }),
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).resolves.toBe(false);
    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).resolves.toBe(true);
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a title renamed during generation', async () => {
    const openCodeClient = createClient({ titles: ['Untitled Session', 'Manual rename'] });
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle: async () => 'Cursor usage accounting' },
      openCodeClient,
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).resolves.toBe(false);
    expect(openCodeClient.sessions.update).not.toHaveBeenCalled();
  });

  it('refuses generation 1 without reading or patching', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sessionResponse('Untitled Session'))
      .mockResolvedValueOnce(sessionResponse('Untitled Session'))
      .mockResolvedValueOnce({ ok: true, json: vi.fn(async () => ({})) });
    const openCodeClient = createClient({ generation: 1 });
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle: async () => 'Cursor usage accounting' },
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl,
      openCodeClient,
      logger: { warn: vi.fn() },
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.get).not.toHaveBeenCalled();
  });

  it('sends no request when the client generation is unknown (fail closed)', async () => {
    const fetchImpl = vi.fn();
    const generateTitle = vi.fn(async () => 'Cursor usage accounting');
    const openCodeClient = createClient({ generation: () => { throw Object.assign(new Error('unknown'), { statusCode: 503 }); } });
    const runtime = createCursorSessionTitleRuntime({
      cursorSdkRuntime: { getSessionMessages: async () => cursorRecords(), generateTitle },
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      fetchImpl,
      openCodeClient,
      logger: { warn: vi.fn() },
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/fixture' })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.get).not.toHaveBeenCalled();
    expect(generateTitle).not.toHaveBeenCalled();
  });
});
