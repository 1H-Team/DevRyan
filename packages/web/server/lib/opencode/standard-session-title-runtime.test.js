import { afterEach, describe, expect, it, vi } from 'vitest';

import { __resetZenModelCooldowns } from '../text/summarization.js';
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

const idleEvent = (sessionID = 'ses_1') => ({
  type: 'session.status',
  properties: { sessionID, status: { type: 'idle' } },
});

const createRuntime = (options = {}) => createStandardSessionTitleRuntime({
  ...options,
  fetchImpl: vi.fn(async (...args) => {
    if (String(args[0]).includes('/session/status')) return response({});
    return options.fetchImpl(...args);
  }),
});

describe('standard session title runtime', () => {
  afterEach(() => {
    // Zen rate-limit cooldowns are module-level by design (they must outlive a
    // single generation), so they have to be cleared between cases.
    __resetZenModelCooldowns();
  });

  it.each(['openai', 'anthropic'])('waits for authoritative session idle before patching a generated %s title', async (providerID) => {
    const events = [];
    let statusReads = 0;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) {
        events.push('messages');
        return response(messageRecords('Repair Claude title race'));
      }
      if (target.includes('/session/status')) {
        statusReads += 1;
        events.push(statusReads === 1 ? 'status-busy' : 'status-idle');
        return response(statusReads === 1 ? { ses_1: { type: 'busy' } } : {});
      }
      if (options.method === 'PATCH') {
        events.push('patch');
        return response({ id: 'ses_1', title: 'Repair Claude Title Race' });
      }
      events.push('session');
      return response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => {
        events.push('generated');
        return 'Repair Claude Title Race';
      }),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      sleep: vi.fn(async () => events.push('sleep')),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID });

    expect(events).toEqual([
      'messages',
      'session',
      'generated',
      'status-busy',
      'sleep',
      'status-idle',
      'session',
      'patch',
    ]);
  });

  it.each([
    ['openai', 'Repair OpenAI plan titles', 'Repair OpenAI Plan Titles'],
    ['anthropic', 'Repair Claude plan titles', 'Repair Claude Plan Titles'],
  ])('retains a generated %s title after the bounded idle wait and patches on the later idle event', async (
    providerID,
    prompt,
    generatedTitle,
  ) => {
    let clock = 0;
    const patches = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords(prompt));
      if (target.includes('/session/status')) {
        return response({ ses_1: { type: 'busy' }, ses_2: { type: 'busy' } });
      }
      if (options.method === 'PATCH') {
        patches.push(JSON.parse(String(options.body)));
        return response({ id: 'ses_1', title: generatedTitle });
      }
      return response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => generatedTitle),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      now: () => clock,
      sleep: vi.fn(async (delayMs) => { clock += delayMs; }),
      sessionIdlePollIntervalMs: 5,
      sessionIdleWaitTimeoutMs: 10,
      logger: { warn: vi.fn() },
    });

    const scheduled = await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID,
    });

    expect(scheduled).toBe(false);
    expect(patches).toEqual([]);

    const finalized = await runtime.processOpenCodeEvent(idleEvent());

    expect(finalized).toBe(true);
    expect(patches).toEqual([{ title: generatedTitle }]);
  });

  it('preserves a manual rename that arrives while a generated title is deferred', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords('Repair long plan titles'));
      if (target.includes('/session/status')) {
        return response({ ses_1: { type: 'busy' }, ses_2: { type: 'busy' } });
      }
      if (options.method === 'PATCH') return response({ id: 'ses_1' });
      return response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Repair Long Plan Titles'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      now: () => clock,
      sleep: vi.fn(async (delayMs) => { clock += delayMs; }),
      sessionIdlePollIntervalMs: 5,
      sessionIdleWaitTimeoutMs: 10,
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID: 'anthropic' });
    await runtime.processOpenCodeEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'My Manual Session Name' } },
    });
    await runtime.processOpenCodeEvent(idleEvent());

    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  it('coalesces duplicate idle finalization and clears deleted deferred sessions', async () => {
    let clock = 0;
    let patchCount = 0;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords('Repair long plan titles'));
      if (target.includes('/session/status')) {
        return response({ ses_1: { type: 'busy' }, ses_2: { type: 'busy' } });
      }
      if (options.method === 'PATCH') {
        patchCount += 1;
        return response({ id: 'ses_1' });
      }
      return response({ id: 'ses_1', title: 'Untitled Session' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Repair Long Plan Titles'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      now: () => clock,
      sleep: vi.fn(async (delayMs) => { clock += delayMs; }),
      sessionIdlePollIntervalMs: 5,
      sessionIdleWaitTimeoutMs: 10,
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID: 'openai' });
    await Promise.all([
      runtime.processOpenCodeEvent(idleEvent()),
      runtime.processOpenCodeEvent(idleEvent()),
    ]);
    expect(patchCount).toBe(1);

    await runtime.schedule({ sessionID: 'ses_2', directory: '/tmp/project', providerID: 'openai' });
    await runtime.processOpenCodeEvent({
      type: 'session.deleted',
      properties: { info: { id: 'ses_2' } },
    });
    await runtime.processOpenCodeEvent(idleEvent('ses_2'));
    expect(patchCount).toBe(1);
  });

  it('bounds deferred title candidates and expires stale entries', async () => {
    let clock = 0;
    const patches = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords('Repair bounded plan titles'));
      if (target.includes('/session/status')) {
        return response({ ses_1: { type: 'busy' }, ses_2: { type: 'busy' } });
      }
      if (options.method === 'PATCH') {
        patches.push(target);
        return response({});
      }
      const sessionID = target.includes('/ses_2') ? 'ses_2' : 'ses_1';
      return response({ sessionID, title: 'Untitled Session' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Repair Bounded Plan Titles'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      now: () => clock,
      sleep: vi.fn(async (delayMs) => { clock += delayMs; }),
      sessionIdlePollIntervalMs: 5,
      sessionIdleWaitTimeoutMs: 10,
      deferredTitleMaxSessions: 1,
      deferredTitleTtlMs: 20,
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID: 'openai' });
    await runtime.schedule({ sessionID: 'ses_2', directory: '/tmp/project', providerID: 'openai' });
    await runtime.processOpenCodeEvent(idleEvent('ses_1'));
    expect(patches).toEqual([]);

    clock += 21;
    await runtime.processOpenCodeEvent(idleEvent('ses_2'));
    expect(patches).toEqual([]);
  });

  it('patches a generated Grok title mid-turn, then verifies it survived the turn without re-patching', async () => {
    const events = [];
    let statusReads = 0;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) {
        events.push('messages');
        return response(messageRecords('Reduce Grok startup delay'));
      }
      if (target.includes('/session/status')) {
        statusReads += 1;
        events.push(statusReads === 1 ? 'status-busy' : 'status-idle');
        return response(statusReads === 1 ? { ses_1: { type: 'busy' } } : {});
      }
      if (options.method === 'PATCH') {
        events.push('patch');
        return response({ id: 'ses_1', title: 'Reduce Grok Startup Delay' });
      }
      events.push('session');
      const titled = events.includes('patch');
      return response({ id: 'ses_1', title: titled ? 'Reduce Grok Startup Delay' : 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => {
        events.push('generated');
        return 'Reduce Grok Startup Delay';
      }),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      sleep: vi.fn(async () => events.push('sleep')),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID: 'xai',
    });

    expect(events).toEqual([
      'messages',
      'session',
      'generated',
      'patch',
      'status-busy',
      'sleep',
      'status-idle',
      'session',
    ]);
  });

  it('re-applies the Grok title when a busy-turn write reverts it to a placeholder', async () => {
    const events = [];
    const patches = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) {
        events.push('messages');
        return response(messageRecords('Reduce Grok startup delay'));
      }
      if (target.includes('/session/status')) {
        events.push('status-idle');
        return response({});
      }
      if (options.method === 'PATCH') {
        events.push('patch');
        patches.push(JSON.parse(String(options.body)));
        return response({ id: 'ses_1' });
      }
      events.push('session');
      // Every GET observes the placeholder: the busy PATCH got clobbered.
      return response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const warn = vi.fn();
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Reduce Grok Startup Delay'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn },
    });

    await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID: 'grok',
    });

    expect(events).toEqual([
      'messages',
      'session',
      'patch',
      'status-idle',
      'session',
      'patch',
    ]);
    expect(patches).toEqual([
      { title: 'Reduce Grok Startup Delay' },
      { title: 'Reduce Grok Startup Delay' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Re-applying title'));
  });

  it('re-verifies a busy-patched Grok title on the idle event after the bounded wait expires', async () => {
    let clock = 0;
    const patches = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords('Repair long Grok plan titles'));
      if (target.includes('/session/status')) return response({ ses_1: { type: 'busy' } });
      if (options.method === 'PATCH') {
        patches.push(JSON.parse(String(options.body)));
        return response({ id: 'ses_1' });
      }
      return response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Repair Long Grok Plan Titles'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      now: () => clock,
      sleep: vi.fn(async (delayMs) => { clock += delayMs; }),
      sessionIdlePollIntervalMs: 5,
      sessionIdleWaitTimeoutMs: 10,
      logger: { warn: vi.fn() },
    });

    const scheduled = await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID: 'xai',
    });
    expect(scheduled).toBe(true);
    expect(patches).toEqual([{ title: 'Repair Long Grok Plan Titles' }]);

    await runtime.processOpenCodeEvent(idleEvent());

    expect(patches).toEqual([
      { title: 'Repair Long Grok Plan Titles' },
      { title: 'Repair Long Grok Plan Titles' },
    ]);
  });

  it('keeps a real title that appeared during the Grok turn instead of overwriting it', async () => {
    let patchCount = 0;
    let sessionReads = 0;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords('Reduce Grok startup delay'));
      if (target.includes('/session/status')) return response({});
      if (options.method === 'PATCH') {
        patchCount += 1;
        return response({ id: 'ses_1' });
      }
      sessionReads += 1;
      // First GET: placeholder. Post-idle GET: the provider runtime produced
      // its own real title, which must win over a re-patch.
      return response({
        id: 'ses_1',
        title: sessionReads === 1 ? 'Untitled Session' : 'Provider Generated Title',
      });
    });
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Reduce Grok Startup Delay'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn: vi.fn() },
    });

    await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID: 'xai-oauth',
    });

    expect(patchCount).toBe(1);
  });

  it('logs the status code when the title PATCH is rejected', async () => {
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/message')) return response(messageRecords('Reduce Grok startup delay'));
      if (target.includes('/session/status')) return response({});
      if (options.method === 'PATCH') return { ok: false, status: 409, json: vi.fn(async () => ({})) };
      return response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' });
    });
    const warn = vi.fn();
    const runtime = createStandardSessionTitleRuntime({
      generateTitle: vi.fn(async () => 'Reduce Grok Startup Delay'),
      fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: { warn },
    });

    const result = await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('409'));
  });

  it('generates and persists an AI title from the earliest visible user text', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Fix OpenAI Session Titles' }));
    const generateTitle = vi.fn(async () => 'Fix OpenAI Session Titles');
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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

  it('leaves the placeholder untouched when model summarization is unavailable', async () => {
    const zenFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn(async () => ({})),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prompt = 'Investigate and repair the unexpectedly slow Grok model startup behavior today';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords(prompt)))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }));
    const runtime = createRuntime({
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

    // Naming the session after the prompt is the failure this guards against.
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });

  // Behaviour change (2026-08-21): a rate-limited model is no longer retried
  // while another model is available. Live logs showed the fallback answering
  // 429 on attempts 2 AND 3 of all 23 title generations that day, so the retry
  // was pure waste; rotating to a different model is both faster and likelier
  // to succeed.
  it('advances to the next rotation model on a rate limit', async () => {
    const zenCalls = [];
    const zenFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      zenCalls.push(JSON.parse(String(options?.body ?? '{}')));
      if (zenCalls.length === 1) return { ok: false, status: 429, json: vi.fn(async () => ({})) };
      return {
        ok: true,
        json: vi.fn(async () => ({ choices: [{ message: { content: 'Repair slow Grok startup' } }] })),
      };
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords('Investigate the unexpectedly slow Grok model startup')))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1' }));
    const runtime = createRuntime({
      resolveZenModel: async () => 'deepseek-v4-flash-free',
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

    expect(zenCalls).toHaveLength(2);
    expect(zenCalls.map((call) => call.model)).toEqual(['deepseek-v4-flash-free', 'big-pickle']);
    const patchCall = fetchImpl.mock.calls.find(([, options]) => options?.method === 'PATCH');
    expect(JSON.parse(patchCall?.[1]?.body)).toEqual({ title: 'Repair slow Grok startup' });
  });

  it('falls back to a second model when the primary one has left the catalog', async () => {
    const zenCalls = [];
    const zenFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      zenCalls.push(JSON.parse(String(options?.body ?? '{}')));
      if (zenCalls.length === 1) {
        return {
          ok: false,
          status: 404,
          json: vi.fn(async () => ({ error: { message: 'The model `retired-free` is not found' } })),
        };
      }
      return {
        ok: true,
        json: vi.fn(async () => ({ choices: [{ message: { content: 'Repair slow Grok startup' } }] })),
      };
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords('Investigate the unexpectedly slow Grok model startup')))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'New session - 2026-07-12T12:00:00.000Z' }))
      .mockResolvedValueOnce(response({ id: 'ses_1' }));
    const runtime = createRuntime({
      resolveZenModel: async () => 'retired-free',
      resolveZenFallbackModel: () => 'deepseek-v4-flash-free',
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

    expect(zenCalls.map((call) => call.model)).toEqual(['retired-free', 'deepseek-v4-flash-free']);
    const patchCall = fetchImpl.mock.calls.find(([, options]) => options?.method === 'PATCH');
    expect(JSON.parse(patchCall?.[1]?.body)).toEqual({ title: 'Repair slow Grok startup' });
  });

  it('preserves an explicit or historical raw-prompt title without requesting a generated title', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(messageRecords()))
      .mockResolvedValueOnce(response({ id: 'ses_1', title: 'Fix OpenAI session title summarization' }));
    const generateTitle = vi.fn(async () => 'Ignored AI Title');
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
    const runtime = createRuntime({
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
