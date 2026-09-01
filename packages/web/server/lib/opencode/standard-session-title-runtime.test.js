import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileSessionTitleOutbox, createMemorySessionTitleOutbox } from './session-title-outbox.js';
import {
  SESSION_TITLE_HELPER_SESSION_TITLE,
  createStandardSessionTitleRuntime,
  deriveLocalSessionTitle,
  normalizeGeneratedSessionTitle,
} from './standard-session-title-runtime.js';

const PLACEHOLDER = 'New session - 2026-08-28T12:00:00.000Z';
const response = (payload, { ok = true, status = ok ? 200 : 500 } = {}) => ({
  ok,
  status,
  json: vi.fn(async () => payload),
});

const userMessage = (text, providerID = 'openai', modelID = 'gpt-5.6-sol') => ({
  info: { id: 'msg_user', role: 'user', model: { providerID, modelID } },
  parts: [
    { type: 'text', text: 'User has requested to enter plan mode.', synthetic: true },
    { type: 'text', text },
  ],
});

const completedAssistantMessage = (finish = 'stop') => ({
  info: {
    id: 'msg_assistant',
    role: 'assistant',
    finish,
    time: { created: 2, completed: 3 },
  },
  parts: [{ type: 'text', text: 'Done.' }],
});

const createFakeOpenCode = ({
  sessions = [{ id: 'ses_1', title: PLACEHOLDER, time: { updated: 1 } }],
  prompt = 'Fix reliable session title summaries',
  status = 'busy',
  completed = false,
  patchFailures = 0,
} = {}) => {
  const state = {
    sessions: new Map(sessions.map((session) => [session.id, { ...session }])),
    messages: new Map(sessions.map((session) => [
      session.id,
      [userMessage(prompt), ...(completed ? [completedAssistantMessage()] : [])],
    ])),
    statuses: new Map(sessions.map((session) => [session.id, status])),
    calls: [],
    patches: [],
    patchFailures,
    sessionReadFailures: 0,
    sessionReadHangs: 0,
  };

  const fetchImpl = vi.fn(async (url, options = {}) => {
    const target = new URL(String(url));
    const method = options.method || 'GET';
    state.calls.push({ target: target.pathname, method, body: options.body });
    if (target.pathname === '/session/status') {
      return response(Object.fromEntries(
        [...state.statuses].filter(([, value]) => value).map(([id, value]) => [id, { type: value }]),
      ));
    }
    if (target.pathname === '/session' && method === 'GET') {
      return response([...state.sessions.values()]);
    }
    if (target.pathname === '/session' && method === 'POST') {
      const helper = { id: 'ses_helper', title: SESSION_TITLE_HELPER_SESSION_TITLE };
      state.sessions.set(helper.id, helper);
      state.messages.set(helper.id, []);
      state.statuses.set(helper.id, 'idle');
      return response(helper);
    }
    const messageMatch = target.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (messageMatch && method === 'GET') return response(state.messages.get(messageMatch[1]) || []);
    if (messageMatch && method === 'POST') {
      const generated = { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Selected Model Session Title' }] };
      state.messages.set(messageMatch[1], [generated]);
      return response(generated);
    }
    const sessionMatch = target.pathname.match(/^\/session\/([^/]+)$/);
    if (!sessionMatch) return response(null, { ok: false, status: 404 });
    const sessionID = sessionMatch[1];
    if (method === 'DELETE') {
      const existed = state.sessions.delete(sessionID);
      state.messages.delete(sessionID);
      state.statuses.delete(sessionID);
      return response(existed);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(options.body));
      state.patches.push({ sessionID, ...body });
      if (state.patchFailures > 0) {
        state.patchFailures -= 1;
        return response({ error: 'temporary' }, { ok: false, status: 503 });
      }
      const session = state.sessions.get(sessionID);
      if (!session) return response(null, { ok: false, status: 404 });
      session.title = body.title;
      return response(session);
    }
    if (state.sessionReadHangs > 0) {
      state.sessionReadHangs -= 1;
      return new Promise(() => {});
    }
    if (state.sessionReadFailures > 0) {
      state.sessionReadFailures -= 1;
      return response({ error: 'temporary' }, { ok: false, status: 503 });
    }
    const session = state.sessions.get(sessionID);
    return session ? response(session) : response(null, { ok: false, status: 404 });
  });

  return { state, fetchImpl };
};

const createRuntime = ({
  fake,
  outbox,
  generateTitle = vi.fn(async () => 'Reliable Session Title Summaries'),
  projected = [],
  diagnostics = [],
  now,
  ...options
}) => (
  createStandardSessionTitleRuntime({
    fetchImpl: fake.fetchImpl,
    buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    generateTitle,
    outbox: outbox || createMemorySessionTitleOutbox({ now }),
    onTitleGenerated: vi.fn(async (input) => projected.push(input)),
    recordDiagnostic: vi.fn(async (input) => diagnostics.push(input)),
    watchdogEnabled: false,
    now,
    logger: { warn: vi.fn() },
    ...options,
  })
);

const idleEvent = (sessionID = 'ses_1', type = 'session.status') => (
  type === 'session.idle'
    ? { type, properties: { sessionID } }
    : { type, properties: { sessionID, status: { type: 'idle' } } }
);

const pendingJob = (overrides = {}) => ({
  key: 'a'.repeat(64),
  sessionID: 'ses_1',
  directory: '/tmp/project-a',
  sourceHash: 'b'.repeat(64),
  candidateTitle: 'Reliable Session Title Summaries',
  source: 'free_zen',
  state: 'pending_idle',
  attemptCount: 1,
  nextAttemptAt: 2_000,
  createdAt: 1,
  updatedAt: 1,
  idleConfirmedAt: 0,
  inactiveObservationCount: 0,
  lastInactiveObservedAt: 0,
  providerID: 'openai',
  modelID: 'gpt-5.6-sol',
  ...overrides,
});

const tempDirectories = [];
afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('standard session title runtime', () => {
  it.each(['openai', 'anthropic', 'xai'])('uses the same idle-only persistence flow for %s', async (providerID) => {
    const fake = createFakeOpenCode();
    const projected = [];
    const runtime = createRuntime({ fake, projected });

    await expect(runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID,
      modelID: `${providerID}-model`,
    })).resolves.toBe(true);
    expect(projected).toHaveLength(1);
    expect(fake.state.patches).toEqual([]);

    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toEqual([{ sessionID: 'ses_1', title: 'Reliable Session Title Summaries' }]);
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    expect(fake.state.calls.some(({ method }) => method === 'POST')).toBe(false);
    await runtime.dispose();
  });

  it.each(['session.status', 'session.idle'])('accepts %s as an authoritative idle event', async (eventType) => {
    const fake = createFakeOpenCode();
    const runtime = createRuntime({ fake });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent('ses_1', eventType));
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('uses the selected session model when every free model attempt fails', async () => {
    const prompt = 'Please fix durable title persistence without modifying files';
    const fake = createFakeOpenCode({ prompt });
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({
      fake,
      projected,
      outbox,
      generateTitle: vi.fn(async () => ({ title: null, attempts: 3 })),
      generateSessionModelTitle: vi.fn(async () => 'Durable Title Persistence'),
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: prompt });
    expect(projected[0].source).toBe('session_model');
    expect(projected[0].title).toBe('Durable Title Persistence');
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Durable Title Persistence',
      source: 'session_model',
    })]);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Durable Title Persistence');
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('builds the retry rotation only from the live zero-cost catalog', async () => {
    const fake = createFakeOpenCode();
    const summarizeTitle = vi.fn(async ({ zenModel }) => zenModel === 'free-b'
      ? { summary: 'Live Catalog Session Titles', summarized: true, model: zenModel, attempts: 1 }
      : { summary: '', summarized: false, reason: 'Unavailable', attempts: 1 });
    const runtime = createRuntime({
      fake,
      generateTitle: null,
      fetchFreeZenModels: vi.fn(async () => [{ id: 'free-a' }, { id: 'free-b' }]),
      zenModelRotation: ['paid-selected-model'],
      summarizeTitle,
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(summarizeTitle).toHaveBeenNthCalledWith(1, expect.objectContaining({
      zenModel: 'free-a',
      zenModelRotation: [],
      transientRetries: 0,
    }));
    expect(summarizeTitle).toHaveBeenNthCalledWith(2, expect.objectContaining({
      zenModel: 'free-b',
      generationTimeoutMs: 4_500,
    }));
    await runtime.dispose();
  });

  it('uses the selected session model instead of a configured paid Zen rotation when the live catalog is empty', async () => {
    const fake = createFakeOpenCode({ prompt: 'Repair provider neutral title generation' });
    const projected = [];
    const summarizeTitle = vi.fn();
    const runtime = createRuntime({
      fake,
      projected,
      generateTitle: null,
      fetchFreeZenModels: vi.fn(async () => []),
      zenModelRotation: ['paid-selected-model'],
      summarizeTitle,
      generateSessionModelTitle: vi.fn(async () => 'Provider Neutral Title Generation'),
    });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(summarizeTitle).not.toHaveBeenCalled();
    expect(projected[0]).toEqual(expect.objectContaining({
      source: 'session_model',
      title: 'Provider Neutral Title Generation',
    }));
    await runtime.dispose();
  });

  it('bounds a stalled live catalog independently from per-model generation', async () => {
    const fake = createFakeOpenCode({ prompt: 'Repair bounded catalog title generation' });
    const projected = [];
    const runtime = createRuntime({
      fake,
      projected,
      generateTitle: null,
      fetchFreeZenModels: vi.fn(() => new Promise(() => {})),
      catalogTimeoutMs: 5,
      generateSessionModelTitle: vi.fn(async () => 'Bounded Catalog Title Generation'),
    });
    const startedAt = Date.now();

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(projected[0]).toEqual(expect.objectContaining({
      source: 'session_model',
      title: 'Bounded Catalog Title Generation',
    }));
    await runtime.dispose();
  });

  it('uses a hidden no-tools helper without inheriting the session variant', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const runtime = createRuntime({
      fake,
      projected,
      generateTitle: vi.fn(async () => ({ title: null, attempts: 8 })),
    });

    await runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'high',
    });

    const helperPrompt = fake.state.calls.find((call) => call.target === '/session/ses_helper/message' && call.method === 'POST');
    const body = JSON.parse(String(helperPrompt?.body));
    expect(body).toMatchObject({
      agent: 'devryan-title',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      tools: {},
    });
    expect(body.variant).toBeUndefined();
    expect(projected[0]).toEqual(expect.objectContaining({ source: 'session_model', title: 'Selected Model Session Title' }));
    expect(fake.state.sessions.has('ses_helper')).toBe(false);
    await runtime.dispose();
  });

  it('keeps the placeholder when both free Zen and the selected model fail', async () => {
    const prompt = 'In dashboard/professional/profile update the published profile shortcut';
    const fake = createFakeOpenCode({ prompt });
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({
      fake,
      projected,
      outbox,
      generateTitle: vi.fn(async () => ({ title: null, attempts: 8 })),
      generateSessionModelTitle: vi.fn(async () => null),
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).resolves.toBe(false);
    expect(projected).toEqual([]);
    expect(await outbox.list()).toEqual([]);
    expect(fake.state.sessions.get('ses_1').title).toBe(PLACEHOLDER);
    await runtime.dispose();
  });

  it('persists the candidate before projecting it', async () => {
    const fake = createFakeOpenCode();
    const events = [];
    const backing = createMemorySessionTitleOutbox();
    const outbox = {
      ...backing,
      async upsert(job) {
        events.push('outbox');
        return backing.upsert(job);
      },
    };
    const runtime = createRuntime({
      fake,
      outbox,
      projected: [],
      onTitleGenerated: undefined,
    });
    const directRuntime = createStandardSessionTitleRuntime({
      fetchImpl: fake.fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      generateTitle: vi.fn(async () => 'Reliable Session Title Summaries'),
      outbox,
      onTitleGenerated: vi.fn(async () => events.push('projection')),
      watchdogEnabled: false,
      logger: { warn: vi.fn() },
    });
    await directRuntime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(events.slice(0, 2)).toEqual(['outbox', 'projection']);
    await runtime.dispose();
    await directRuntime.dispose();
  });

  it('never projects a candidate that could not be written to the outbox', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const backing = createMemorySessionTitleOutbox();
    const runtime = createRuntime({
      fake,
      projected,
      outbox: {
        ...backing,
        upsert: vi.fn(async () => {
          throw new Error('disk unavailable');
        }),
      },
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).resolves.toBe(false);
    expect(projected).toEqual([]);
    expect(fake.state.patches).toEqual([]);
    await runtime.dispose();
  });

  it('rehydrates, reprojects, and persists a pending title after restart', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-title-restart-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'session-title-outbox.json');
    const fake = createFakeOpenCode();
    const firstProjected = [];
    const first = createRuntime({
      fake,
      projected: firstProjected,
      outbox: createFileSessionTitleOutbox({ filePath }),
    });
    await first.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await first.dispose();
    expect(await fs.readFile(filePath, 'utf8')).not.toContain('Fix reliable session title summaries');

    const secondProjected = [];
    const second = createRuntime({
      fake,
      projected: secondProjected,
      outbox: createFileSessionTitleOutbox({ filePath }),
      generateTitle: vi.fn(async () => {
        throw new Error('must not regenerate');
      }),
    });
    await second.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    expect(secondProjected).toHaveLength(1);
    fake.state.statuses.set('ses_1', null);
    fake.state.messages.get('ses_1').push(completedAssistantMessage());
    await second.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).jobs).toEqual([]);
    await second.dispose();
  });

  it('retries a rejected PATCH without losing the durable job', async () => {
    const fake = createFakeOpenCode({ patchFailures: 1 });
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox, retryDelaysMs: [20] });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(2);
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('retries a failed authoritative session read before PATCHing', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox, retryDelaysMs: [1] });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && !fake.state.calls.some(({ target }) => target === '/session/status'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.state.sessionReadFailures = 1;
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toEqual([]);
    expect(await outbox.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(1);
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('times out and retries a stalled authoritative read', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({
      fake,
      outbox,
      retryDelaysMs: [1],
      openCodeRequestTimeoutMs: 5,
    });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && !fake.state.calls.some(({ target }) => target === '/session/status'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.state.sessionReadHangs = 1;
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toEqual([]);
    expect(await outbox.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(1);
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('does not treat repeated missing statuses as idle without a completed initiating turn', async () => {
    const fake = createFakeOpenCode({ status: null });
    const runtime = createRuntime({
      fake,
      inactiveConfirmationWindowMs: 1,
      retryDelaysMs: [1],
    });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.state.patches).toEqual([]);

    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.state.patches).toEqual([]);

    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.state.patches).toEqual([]);

    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(1);
    await runtime.dispose();
  });

  it('preserves a meaningful manual rename while the title is pending', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    fake.state.sessions.get('ses_1').title = 'My Manual Session Name';
    await runtime.processOpenCodeEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'My Manual Session Name' } },
    });
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toEqual([]);
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('preserves a manual rename that lands while generation is still running', async () => {
    const fake = createFakeOpenCode();
    let resolveGeneration;
    const generateTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, generateTitle, projected, outbox });
    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.state.sessions.get('ses_1').title = 'Manual Rename During Generation';
    resolveGeneration('Reliable Session Title Summaries');

    await scheduled;

    expect(projected).toEqual([]);
    expect(await outbox.list()).toEqual([]);
    expect(fake.state.sessions.get('ses_1').title).toBe('Manual Rename During Generation');
    await runtime.dispose();
  });

  it('drops generated work when the parent session is deleted during generation', async () => {
    const fake = createFakeOpenCode();
    let resolveGeneration;
    const generateTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, generateTitle, projected, outbox });
    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.state.sessions.delete('ses_1');
    fake.state.messages.delete('ses_1');
    fake.state.statuses.delete('ses_1');
    resolveGeneration('Reliable Session Title Summaries');

    await scheduled;

    expect(projected).toEqual([]);
    expect(await outbox.list()).toEqual([]);
    expect(fake.state.patches).toEqual([]);
    await runtime.dispose();
  });

  it('does not mistake its projected title for a manual rename', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'Reliable Session Title Summaries' } },
    });
    expect(await outbox.list()).toHaveLength(1);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('ignores a late placeholder update after authoritative persistence', async () => {
    const fake = createFakeOpenCode();
    const generateTitle = vi.fn(async () => 'Reliable Session Title Summaries');
    const runtime = createRuntime({ fake, generateTitle });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());
    await runtime.processOpenCodeEvent({
      type: 'session.updated',
      properties: {
        info: { id: 'ses_1', title: PLACEHOLDER, directory: '/tmp/project' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('deduplicates scheduling and removes pending work for deleted sessions', async () => {
    const fake = createFakeOpenCode();
    let resolveGeneration;
    const generateTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox, generateTitle });
    const first = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    const second = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    resolveGeneration('Reliable Session Title Summaries');
    await Promise.all([first, second]);
    expect(generateTitle).toHaveBeenCalledTimes(1);
    await runtime.processOpenCodeEvent({ type: 'session.deleted', properties: { sessionID: 'ses_1' } });
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('recovers every placeholder instead of truncating at twenty', async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      id: `ses_${index + 1}`,
      title: PLACEHOLDER,
      time: { updated: index + 1 },
    }));
    const fake = createFakeOpenCode({ sessions });
    const projected = [];
    const generateTitle = vi.fn(async ({ text }) => deriveLocalSessionTitle(text));
    const runtime = createRuntime({ fake, projected, generateTitle });
    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    expect(generateTitle).toHaveBeenCalledTimes(25);
    expect(projected).toHaveLength(25);
    expect(fake.state.calls.some(({ method }) => method === 'POST')).toBe(false);
    await runtime.dispose();
  });

  it('runs one watchdog per directory and clears it when that directory has no jobs', async () => {
    const fake = createFakeOpenCode();
    const timers = [];
    const setTimer = vi.fn((callback, delay) => {
      const handle = { callback, delay, cleared: false, unref: vi.fn() };
      timers.push(handle);
      return handle;
    });
    const clearTimer = vi.fn((handle) => {
      handle.cleared = true;
    });
    const outbox = createMemorySessionTitleOutbox({
      initialJobs: [
        pendingJob(),
        pendingJob({
          key: 'c'.repeat(64),
          sessionID: 'ses_2',
          directory: '/tmp/project-b',
          sourceHash: 'd'.repeat(64),
        }),
      ],
      now: () => 1_000,
    });
    const runtime = createRuntime({
      fake,
      outbox,
      now: () => 1_000,
      watchdogEnabled: true,
      setTimer,
      clearTimer,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.filter(({ cleared }) => !cleared)).toHaveLength(2);

    await runtime.processOpenCodeEvent({ type: 'session.deleted', properties: { sessionID: 'ses_1' } });
    expect(timers.filter(({ cleared }) => !cleared)).toHaveLength(1);
    await runtime.processOpenCodeEvent({ type: 'session.deleted', properties: { sessionID: 'ses_2' } });
    expect(timers.filter(({ cleared }) => !cleared)).toHaveLength(0);
    await runtime.dispose();
  });

  it('backs off without spinning while the managed OpenCode port is unavailable at startup', async () => {
    const timers = [];
    const setTimer = vi.fn((callback, delay) => {
      const handle = { callback, delay, cleared: false, unref: vi.fn() };
      timers.push(handle);
      return handle;
    });
    const clearTimer = vi.fn((handle) => {
      handle.cleared = true;
    });
    const logger = { warn: vi.fn() };
    const outbox = createMemorySessionTitleOutbox({
      initialJobs: [pendingJob({ nextAttemptAt: 1_000 })],
      now: () => 1_000,
    });
    const runtime = createStandardSessionTitleRuntime({
      fetchImpl: vi.fn(),
      buildOpenCodeUrl: vi.fn(() => {
        throw new Error('OpenCode port is not available');
      }),
      generateTitle: vi.fn(),
      outbox,
      watchdogEnabled: true,
      retryDelaysMs: [1_000],
      now: () => 1_000,
      setTimer,
      clearTimer,
      logger,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstWatchdog = timers.find(({ cleared }) => !cleared);
    expect(firstWatchdog?.delay).toBe(1);

    firstWatchdog.cleared = true;
    firstWatchdog.callback();
    for (let index = 0; index < 10; index += 1) {
      const [job] = await outbox.list();
      if (job?.attemptCount === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(await outbox.list()).toEqual([
      expect.objectContaining({ attemptCount: 2, nextAttemptAt: 2_000 }),
    ]);
    expect(timers.filter(({ cleared }) => !cleared)).toEqual([
      expect.objectContaining({ delay: 1_000 }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('removes only idle legacy helper sessions', async () => {
    const fake = createFakeOpenCode({
      sessions: [
        { id: 'ses_helper_idle', title: SESSION_TITLE_HELPER_SESSION_TITLE },
        { id: 'ses_helper_busy', title: SESSION_TITLE_HELPER_SESSION_TITLE },
        { id: 'ses_visible', title: 'Visible Session' },
      ],
    });
    fake.state.statuses.set('ses_helper_idle', null);
    fake.state.statuses.set('ses_helper_busy', 'busy');
    const runtime = createRuntime({ fake });
    await expect(runtime.cleanupStaleHelpers({ directory: '/tmp/project' })).resolves.toBe(1);
    expect(fake.state.sessions.has('ses_helper_idle')).toBe(false);
    expect(fake.state.sessions.has('ses_helper_busy')).toBe(true);
    expect(fake.state.sessions.has('ses_visible')).toBe(true);
    await runtime.dispose();
  });

  it('uses completed message history to recover when the live status map is empty', async () => {
    const fake = createFakeOpenCode({ status: null, completed: true });
    const runtime = createRuntime({ fake });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && fake.state.patches.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fake.state.patches).toHaveLength(1);
    await runtime.dispose();
  });

  it.each(['abort', 'error'])('accepts a completed %s turn during inactive recovery', async (finish) => {
    const fake = createFakeOpenCode({ status: null });
    fake.state.messages.get('ses_1').push(completedAssistantMessage(finish));
    const runtime = createRuntime({ fake });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && fake.state.patches.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fake.state.patches).toHaveLength(1);
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('validates model titles and derives safe local Plan-mode fallbacks', () => {
    expect(normalizeGeneratedSessionTitle(
      'Plan Reliable Session Title Persistence',
      'Make a plan to fix reliable session title persistence',
    )).toBe('Reliable Session Title Persistence');
    expect(normalizeGeneratedSessionTitle('Fix this', 'Fix this')).toBeNull();
    expect(normalizeGeneratedSessionTitle('```markdown\nBad title\n```', 'source')).toBeNull();
    expect(deriveLocalSessionTitle('Make an implementation plan to fix reliable session title persistence'))
      .toBe('Reliable Session Title Persistence');
    expect(deriveLocalSessionTitle('Builder mode: explain idempotent retry behavior without using tools'))
      .toBe('Idempotent Retry Behavior');
    expect(deriveLocalSessionTitle(
      'Explain why idempotent cache invalidation matters in one sentence, without using tools.',
    )).toBe('Idempotent Cache Invalidation Matters');
  });
});
