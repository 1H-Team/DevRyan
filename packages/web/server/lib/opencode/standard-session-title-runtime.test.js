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

// Persistence cases use one resolved model title; no intermediate title is projected.
const createRuntime = ({
  fake,
  outbox,
  generateSessionModelTitle = vi.fn(async () => 'Reliable Session Title Summaries'),
  projected = [],
  diagnostics = [],
  now,
  ...options
}) => (
  createStandardSessionTitleRuntime({
    openCodeClient: createFakeOpenCodeClient(fake),
    fetchImpl: fake.fetchImpl,
    buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    generateSessionModelTitle,
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

const captureTimers = () => {
  const timers = [];
  const setTimer = vi.fn((callback, delay) => {
    const handle = { callback, delay, cleared: false, unref: vi.fn() };
    timers.push(handle);
    return handle;
  });
  const clearTimer = vi.fn((handle) => {
    handle.cleared = true;
  });
  return { timers, setTimer, clearTimer };
};

const settleAfterPatches = async (fake, count) => {
  for (let index = 0; index < 50 && fake.state.patches.length < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const stageOutcomes = (diagnostics, ...stages) => diagnostics
  .map(({ payload }) => `${payload.stage}:${payload.outcome}`)
  .filter((entry) => stages.some((stage) => entry.startsWith(`${stage}:`)));

const pendingJob = (overrides = {}) => ({
  key: 'a'.repeat(64),
  sessionID: 'ses_1',
  directory: '/tmp/project-a',
  sourceHash: 'b'.repeat(64),
  candidateTitle: 'Reliable Session Title Summaries',
  source: 'derived',
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
  vi.useRealTimers();
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('standard session title runtime', () => {
  it('refuses the retired blocking helper-session path and derives the title without admission or retry', async () => {
    const fake = createFakeOpenCode();
    const projected = [], diagnostics = [];
    const { timers, setTimer, clearTimer } = captureTimers();
    const runtime = createRuntime({ fake, projected, diagnostics, setTimer, clearTimer, generateSessionModelTitle: null });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.dispose();
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(fake.state.sessions.has('ses_helper')).toBe(false);
    expect(timers.filter(({ delay }) => delay === 60_000)).toEqual([]);
    expect(projected[0]).toMatchObject({ title: 'Reliable Session Title Summaries', source: 'derived' });
    expect(diagnostics.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({ stage: 'helper_create', reason: 'capability_unavailable' }));
  });

  it('cancels generation on shutdown and ignores its late answer', async () => {
    const fake = createFakeOpenCode();
    let finish;
    let signal;
    const projected = [];
    const generator = vi.fn((input) => {
      signal = input.signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    const runtime = createRuntime({ fake, projected, generateSessionModelTitle: generator });
    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await vi.waitFor(() => expect(generator).toHaveBeenCalledOnce());
    await runtime.dispose();
    expect(signal.aborted).toBe(true);
    finish('Late Answer Must Not Win');
    await scheduled;
    expect(projected).toEqual([]);
    expect(fake.state.patches).toEqual([]);
  });

  it('fences a late timed-out answer while preserving the delayed retry', async () => {
    vi.useFakeTimers();
    const fake = createFakeOpenCode();
    let finish;
    const projected = [];
    const generator = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce('Recovered Sidebar Title Summaries');
    const runtime = createRuntime({ fake, projected, generateSessionModelTitle: generator });
    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await vi.advanceTimersByTimeAsync(30_000);
    await scheduled;
    finish('Late Answer Must Not Win');
    await vi.advanceTimersByTimeAsync(1);
    expect(projected).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(projected[0]?.title).toBe('Recovered Sidebar Title Summaries');
    await runtime.dispose();
  });


  it('does not classify root titles, explicit child labels, or another agent name as generated placeholders', async () => {
    const fake = createFakeOpenCode({ sessions: [
      { id: 'root', title: 'Managed Explorer Task', agent: 'explorer' },
      { id: 'custom', title: 'Review Profile Navigation', agent: 'designer', parentID: 'root' },
      { id: 'mismatch', title: 'Managed Explorer Task', agent: 'designer', parentID: 'root' },
    ] });
    const generateSessionModelTitle = vi.fn();
    const runtime = createRuntime({ fake, generateSessionModelTitle });
    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    expect(generateSessionModelTitle).not.toHaveBeenCalled();
    expect(fake.state.patches).toEqual([]);
    await runtime.dispose();
  });

  it('preserves a managed child renamed manually while its title is pending', async () => {
    const fake = createFakeOpenCode({ sessions: [{ id: 'ses_1', parentID: 'ses_root', agent: 'explorer', title: 'Managed Explorer Task' }] });
    const runtime = createRuntime({ fake });
    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    fake.state.sessions.get('ses_1').title = 'My Deliberate Child Name';
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('My Deliberate Child Name');
    expect(fake.state.patches).toEqual([]);
    await runtime.dispose();
  });

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

  it('publishes only the resolved session-model title', async () => {
    const prompt = 'Repair provider neutral title generation';
    const fake = createFakeOpenCode({ prompt });
    const projected = [];
    const diagnostics = [];
    const outbox = createMemorySessionTitleOutbox();
    const generateSessionModelTitle = vi.fn(async () => 'Neutral Title Generation Pipeline');
    const runtime = createRuntime({ fake, projected, diagnostics, outbox, generateSessionModelTitle });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: prompt })).resolves.toBe(true);

    expect(projected.map(({ source, title }) => ({ source, title }))).toEqual([
      { source: 'session_model', title: 'Neutral Title Generation Pipeline' },
    ]);
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(generateSessionModelTitle).toHaveBeenCalledWith(expect.objectContaining({
      text: prompt,
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      timeoutMs: 30_000,
    }));
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Neutral Title Generation Pipeline',
      source: 'session_model',
      replacesTitle: PLACEHOLDER,
    })]);
    expect(stageOutcomes(diagnostics, 'derived', 'session_model', 'free_zen')).toEqual([
      'session_model:complete',
    ]);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Neutral Title Generation Pipeline');
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it.each(['anthropic', 'opencode-with-claude'])('publishes one model title for %s sessions too', async (providerID) => {
    const fake = createFakeOpenCode();
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const generateSessionModelTitle = vi.fn(async () => 'Upgraded Session Model Title');
    const runtime = createRuntime({ fake, projected, outbox, generateSessionModelTitle });

    await expect(runtime.schedule({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      providerID,
      modelID: 'claude-model',
    })).resolves.toBe(true);

    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(projected).toEqual([expect.objectContaining({ source: 'session_model', title: 'Upgraded Session Model Title' })]);
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Upgraded Session Model Title',
      source: 'session_model',
    })]);
    expect(fake.state.calls.some(({ method }) => method === 'POST')).toBe(false);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Upgraded Session Model Title');
    await runtime.dispose();
  });

  it('keeps the placeholder until the session-model promise resolves', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    let resolveGeneration;
    const generateSessionModelTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const runtime = createRuntime({ fake, projected, outbox, generateSessionModelTitle });

    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 20 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(resolveGeneration).toBeTypeOf('function');
    expect(projected).toEqual([]);
    expect(fake.state.sessions.get('ses_1').title).toBe(PLACEHOLDER);
    expect(await outbox.list()).toEqual([]);

    resolveGeneration('Upgraded Session Model Title');
    await expect(scheduled).resolves.toBe(true);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(expect.objectContaining({ source: 'session_model', title: 'Upgraded Session Model Title' }));
    await runtime.dispose();
  });

  it('bounds stalled generation without publishing an intermediate title', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const diagnostics = [];
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(() => new Promise(() => {}));
    const runtime = createRuntime({ fake, projected, diagnostics, generateSessionModelTitle, setTimer, clearTimer });

    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    const boundTimer = () => timers.find(({ delay, cleared }) => delay === 30_000 && !cleared);
    for (let index = 0; index < 20 && !boundTimer(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(projected).toEqual([]);

    boundTimer().callback();
    await expect(scheduled).resolves.toBe(true);
    expect(projected).toHaveLength(0);
    expect(diagnostics.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({
      stage: 'session_model',
      outcome: 'failed',
      reason: 'timeout',
      attempt: 1,
    }));
    expect(timers.filter(({ delay }) => delay === 60_000)).toHaveLength(1);
    await runtime.dispose();
  });

  it('does not create a retired hidden helper when no native generator is supplied', async () => {
    const fake = createFakeOpenCode(), projected = [];
    const runtime = createRuntime({ fake, projected, generateSessionModelTitle: null });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(fake.state.sessions.has('ses_helper')).toBe(false);
    expect(projected[0]).toMatchObject({ source: 'derived', title: 'Reliable Session Title Summaries' });
    await runtime.dispose();
  });

  it('publishes a final fallback only after both model attempts fail', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const diagnostics = [];
    const outbox = createMemorySessionTitleOutbox();
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(async () => null);
    const runtime = createRuntime({ fake, projected, diagnostics, outbox, generateSessionModelTitle, setTimer, clearTimer });
    const retryTimers = () => timers.filter(({ delay }) => delay === 60_000);

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).resolves.toBe(true);
    expect(projected).toEqual([]);
    expect(await outbox.list()).toEqual([]);
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(retryTimers()).toHaveLength(1);

    // A re-entrant schedule (the next prompt) must not spend the retry early.
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);

    retryTimers()[0].callback();
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(2);
    expect(retryTimers()).toHaveLength(1);

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(2);
    expect(projected.length).toBeGreaterThan(0);
    expect(new Set(projected.map(({ title }) => title))).toEqual(new Set(['Reliable Session Title Summaries']));
    expect(projected.every(({ source }) => source === 'derived')).toBe(true);
    expect(stageOutcomes(diagnostics, 'session_model', 'generation_retry')).toEqual([
      'session_model:failed',
      'generation_retry:retry_scheduled',
      'session_model:failed',
    ]);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('publishes only the successful retry title, even when the session is idle', async () => {
    const fake = createFakeOpenCode({ status: 'idle', completed: true });
    const outbox = createMemorySessionTitleOutbox();
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(async () => null);
    const runtime = createRuntime({ fake, outbox, generateSessionModelTitle, setTimer, clearTimer });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(fake.state.patches).toEqual([]);
    expect(fake.state.sessions.get('ses_1').title).toBe(PLACEHOLDER);
    expect(await outbox.list()).toEqual([]);

    generateSessionModelTitle.mockResolvedValue('Upgraded Session Model Title');
    timers.find(({ delay }) => delay === 60_000).callback();
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(2);
    await settleAfterPatches(fake, 1);
    expect(fake.state.patches).toEqual([
      { sessionID: 'ses_1', title: 'Upgraded Session Model Title' },
    ]);
    expect(fake.state.sessions.get('ses_1').title).toBe('Upgraded Session Model Title');
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('never upgrades a user-typed title', async () => {
    const fake = createFakeOpenCode({ status: 'idle', completed: true });
    const outbox = createMemorySessionTitleOutbox();
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(async () => null);
    const runtime = createRuntime({ fake, outbox, generateSessionModelTitle, setTimer, clearTimer });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(fake.state.patches).toEqual([]);
    fake.state.sessions.get('ses_1').title = 'User Typed Session Name';

    generateSessionModelTitle.mockResolvedValue('Upgraded Session Model Title');
    timers.find(({ delay }) => delay === 60_000).callback();
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(fake.state.patches).toHaveLength(0);
    expect(fake.state.sessions.get('ses_1').title).toBe('User Typed Session Name');
    expect(await outbox.list()).toEqual([]);
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
      openCodeClient: createFakeOpenCodeClient(fake),
    fetchImpl: fake.fetchImpl,
      buildOpenCodeUrl: (requestPath) => `http://opencode.test${requestPath}`,
      generateSessionModelTitle: vi.fn(async () => 'Reliable Session Title Summaries'),
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
      generateSessionModelTitle: vi.fn(async () => {
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

  it('preserves a manual rename that lands while the session model is still running', async () => {
    const fake = createFakeOpenCode();
    let resolveGeneration;
    const generateSessionModelTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, generateSessionModelTitle, projected, outbox });
    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 20 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(projected).toEqual([]);
    fake.state.sessions.get('ses_1').title = 'Manual Rename During Generation';
    resolveGeneration('Upgraded Session Model Title');

    await scheduled;

    expect(projected).toHaveLength(0);
    expect(await outbox.list()).toEqual([]);
    expect(fake.state.patches).toEqual([]);
    expect(fake.state.sessions.get('ses_1').title).toBe('Manual Rename During Generation');
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toEqual([]);
    await runtime.dispose();
  });

  it('drops generated work when the parent session is deleted during generation', async () => {
    const fake = createFakeOpenCode();
    let resolveGeneration;
    const generateSessionModelTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, generateSessionModelTitle, projected, outbox });
    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 20 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.state.sessions.delete('ses_1');
    fake.state.messages.delete('ses_1');
    fake.state.statuses.delete('ses_1');
    resolveGeneration('Upgraded Session Model Title');

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
    const generateSessionModelTitle = vi.fn(async () => 'Reliable Session Title Summaries');
    const runtime = createRuntime({ fake, generateSessionModelTitle });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());
    await runtime.processOpenCodeEvent({
      type: 'session.updated',
      properties: {
        info: { id: 'ses_1', title: PLACEHOLDER, directory: '/tmp/project' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('deduplicates scheduling and removes pending work for deleted sessions', async () => {
    const fake = createFakeOpenCode();
    let resolveGeneration;
    const generateSessionModelTitle = vi.fn(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox, generateSessionModelTitle });
    const first = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    const second = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 20 && !resolveGeneration; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    resolveGeneration('Reliable Session Title Summaries');
    await Promise.all([first, second]);
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
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
    const generateSessionModelTitle = vi.fn(async ({ text }) => deriveLocalSessionTitle(text));
    const runtime = createRuntime({ fake, projected, generateSessionModelTitle });
    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(25);
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
      openCodeClient: { generation: () => 2, sessions: { get: vi.fn(async () => { throw clientError(503); }), status: vi.fn(async () => { throw clientError(503); }) } },
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
    const approvedBrief = 'Implement approved plan: Feedback Chat Greeting and Form Reveal. First inspect relevant module docs.';
    expect(deriveLocalSessionTitle(approvedBrief)).toBe('Feedback Chat Greeting and Form Reveal');
    expect(normalizeGeneratedSessionTitle('Approved plan: Feedback Chat Greeting and Form', approvedBrief))
      .toBe('Feedback Chat Greeting and Form');
    expect(deriveLocalSessionTitle('Approved plan: Feedback Chat Greeting and Form'))
      .toBe('Feedback Chat Greeting and Form');
    expect(normalizeGeneratedSessionTitle('Approved Plan Approval Workflow', 'Fix the approved plan approval workflow'))
      .toBe('Approved Plan Approval Workflow');
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

// Gen 2 (DESIGN C.1, E item 13b): the same fake OpenCode state behind an
// openCodeClient, as the gen-2 client returns it (v1 domain shapes; statuses
// omit idle sessions; refusals are errors carrying `statusCode`).
const clientError = (statusCode) => Object.assign(new Error(`client failure ${statusCode}`), { statusCode });

const createFakeOpenCodeClient = (fake, { generation = 2 } = {}) => {
  const { state } = fake;
  const record = (operation, ...args) => state.calls.push({ target: `client:${operation}`, method: operation, args });
  const readSession = (sessionID) => {
    const session = state.sessions.get(sessionID);
    if (!session) throw clientError(404);
    return { ...session };
  };
  return {
    generation: typeof generation === 'function' ? generation : () => generation,
    sessions: {
      get: vi.fn(async (sessionID, options) => {
        record('get', sessionID, options);
        if (state.sessionReadHangs > 0) {
          state.sessionReadHangs -= 1;
          return new Promise(() => {});
        }
        if (state.sessionReadFailures > 0) {
          state.sessionReadFailures -= 1;
          throw clientError(503);
        }
        return readSession(sessionID);
      }),
      list: vi.fn(async (query, options) => {
        record('list', query, options);
        return [...state.sessions.values()].map((session) => ({ ...session }));
      }),
      status: vi.fn(async (query, options) => {
        record('status', query, options);
        return Object.fromEntries([...state.statuses]
          .filter(([, value]) => value && value !== 'idle')
          .map(([id, value]) => [id, { type: value }]));
      }),
      messages: vi.fn(async (sessionID, page, options) => {
        record('messages', sessionID, page, options);
        readSession(sessionID);
        return { records: state.messages.get(sessionID) || [], cursor: undefined };
      }),
      update: vi.fn(async (sessionID, patch, options) => {
        record('update', sessionID, patch, options);
        state.patches.push({ sessionID, ...patch });
        if (state.patchFailures > 0) {
          state.patchFailures -= 1;
          throw clientError(503);
        }
        const session = state.sessions.get(sessionID);
        if (!session) throw clientError(404);
        session.title = patch.title;
        return { ...session };
      }),
      remove: vi.fn(async (sessionID, options) => {
        record('remove', sessionID, options);
        if (!state.sessions.delete(sessionID)) throw clientError(404);
        state.messages.delete(sessionID);
        state.statuses.delete(sessionID);
        return true;
      }),
    },
  };
};

const waitForPatches = async (fake, count) => {
  for (let index = 0; index < 20 && fake.state.patches.length < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('standard session title runtime on OpenCode 2 (openCodeClient)', () => {
  it('persists the resolved title through the client without URL requests', async () => {
    const fake = createFakeOpenCode();
    const openCodeClient = createFakeOpenCodeClient(fake);
    const outbox = createMemorySessionTitleOutbox();
    const projected = [];
    const runtime = createRuntime({ fake, outbox, projected, openCodeClient });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());

    expect(fake.state.patches).toEqual([{ sessionID: 'ses_1', title: 'Reliable Session Title Summaries' }]);
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    expect(projected[0]).toMatchObject({ title: 'Reliable Session Title Summaries', source: 'session_model' });
    expect(await outbox.list()).toEqual([]);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.update).toHaveBeenCalledWith(
      'ses_1',
      { title: 'Reliable Session Title Summaries' },
      expect.objectContaining({ directory: '/tmp/project', signal: expect.any(AbortSignal) }),
    );
    await runtime.dispose();
  });

  it('retries a refused client PATCH without losing the durable job', async () => {
    const fake = createFakeOpenCode({ patchFailures: 1 });
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, outbox, retryDelaysMs: [20], openCodeClient: createFakeOpenCodeClient(fake) });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toHaveLength(2);
    expect(await outbox.list()).toEqual([]);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('drops the job when the client reports the session missing (404)', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const diagnostics = [];
    const runtime = createRuntime({ fake, outbox, diagnostics, openCodeClient: createFakeOpenCodeClient(fake) });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(await outbox.list()).toHaveLength(1);
    fake.state.sessions.delete('ses_1');
    await runtime.processOpenCodeEvent(idleEvent());
    expect(await outbox.list()).toEqual([]);
    expect(stageOutcomes(diagnostics, 'persistence')).toContain('persistence:session_deleted');
    await runtime.dispose();
  });

  it('times out and retries a stalled client read', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({
      fake, outbox, retryDelaysMs: [1], openCodeRequestTimeoutMs: 5, openCodeClient: createFakeOpenCodeClient(fake),
    });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 10 && !fake.state.calls.some(({ target }) => target === 'client:status'); index += 1) {
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

  it('recovers from completed history when the client status map omits the idle session', async () => {
    const fake = createFakeOpenCode({ status: 'idle', completed: true });
    const runtime = createRuntime({ fake, openCodeClient: createFakeOpenCodeClient(fake) });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await waitForPatches(fake, 1);
    expect(fake.state.patches).toHaveLength(1);
    expect(fake.state.calls.some(({ target }) => target === 'client:messages')).toBe(true);
    await runtime.dispose();
  });

  it('reports the built-in helper generator as unavailable and settles on the derived title', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const diagnostics = [];
    const { timers, setTimer, clearTimer } = captureTimers();
    const runtime = createRuntime({
      fake, projected, diagnostics, setTimer, clearTimer, generateSessionModelTitle: null,
      openCodeClient: createFakeOpenCodeClient(fake),
    });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID: 'openai', modelID: 'gpt-5.6-sol' });
    expect(projected[0]).toMatchObject({ title: 'Reliable Session Title Summaries', source: 'derived' });
    expect(timers.filter(({ delay }) => delay === 60_000)).toEqual([]);
    expect(diagnostics.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({ stage: 'helper_create', outcome: 'failed', reason: 'capability_unavailable' }),
    );
    expect(fake.state.sessions.has('ses_helper')).toBe(false);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('admits the native title helper with the session variant from the prompt and from history', async () => {
    // Mirrors the native admission owner: a title helper must use the session's exact selection.
    const selection = { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium' };
    const generateHelperText = vi.fn(async (request) => {
      if (request.providerID !== selection.providerID || request.modelID !== selection.modelID || request.variant !== selection.variant) {
        throw Object.assign(new Error('native_title_selection_changed'), { code: 'native_title_selection_changed', status: 403, statusCode: 403 });
      }
      return { text: 'Native Helper Session Title' };
    });
    for (const scheduled of [
      { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium' },
      {},
    ]) {
      generateHelperText.mockClear();
      const fake = createFakeOpenCode();
      fake.state.messages.get('ses_1')[0].info.model.variant = 'medium';
      const projected = [];
      const diagnostics = [];
      const runtime = createRuntime({
        fake, projected, diagnostics, generateSessionModelTitle: null, generateHelperText,
        openCodeClient: createFakeOpenCodeClient(fake),
      });
      await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', ...scheduled });
      expect(generateHelperText).toHaveBeenCalledWith(expect.objectContaining({ ...selection, agent: 'devryan-title' }));
      expect(diagnostics.map(({ payload }) => payload)).not.toContainEqual(expect.objectContaining({ reason: 'unauthorized' }));
      expect(projected[0]).toMatchObject({ title: 'Native Helper Session Title', source: 'session_model' });
      await runtime.dispose();
    }
  });

  it('removes only idle legacy helper sessions through the client', async () => {
    const fake = createFakeOpenCode({
      sessions: [
        { id: 'ses_helper_idle', title: SESSION_TITLE_HELPER_SESSION_TITLE },
        { id: 'ses_helper_busy', title: SESSION_TITLE_HELPER_SESSION_TITLE },
        { id: 'ses_visible', title: 'Visible Session' },
      ],
    });
    fake.state.statuses.set('ses_helper_idle', 'idle');
    fake.state.statuses.set('ses_helper_busy', 'busy');
    const openCodeClient = createFakeOpenCodeClient(fake);
    const runtime = createRuntime({ fake, openCodeClient });
    await expect(runtime.cleanupStaleHelpers({ directory: '/tmp/project' })).resolves.toBe(1);
    expect(fake.state.sessions.has('ses_helper_idle')).toBe(false);
    expect(fake.state.sessions.has('ses_helper_busy')).toBe(true);
    expect(fake.state.sessions.has('ses_visible')).toBe(true);
    expect(openCodeClient.sessions.list).toHaveBeenCalledWith({ directory: '/tmp/project' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('refuses generation 1 without reading or patching', async () => {
    const fake = createFakeOpenCode();
    const openCodeClient = createFakeOpenCodeClient(fake, { generation: 1 });
    const runtime = createRuntime({ fake, openCodeClient });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.patches).toEqual([]);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(fake.state.calls.some(({ target }) => target.startsWith('client:'))).toBe(false);
    await runtime.dispose();
  });

  it('sends no request and keeps the job when the client generation is unknown (fail closed)', async () => {
    const fake = createFakeOpenCode();
    const outbox = createMemorySessionTitleOutbox();
    const openCodeClient = createFakeOpenCodeClient(fake, {
      generation: () => { throw clientError(503); },
    });
    const runtime = createRuntime({ fake, outbox, openCodeClient });
    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).resolves.toBe(false);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
    expect(fake.state.calls).toEqual([]);
    expect(fake.state.patches).toEqual([]);
    await runtime.dispose();
  });
});
