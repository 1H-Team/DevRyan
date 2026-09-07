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

// The default prompt derives to 'Reliable Session Title Summaries', so a
// session-model stub returning the same string leaves the upgrade a no-op and
// the persistence-focused cases see exactly one projection.
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
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('standard session title runtime', () => {
  it.each(['explorer', 'designer'])('recovers the reserved %s child placeholder using the brief, then persists on idle', async (agent) => {
    const placeholder = `Managed ${agent} task`;
    const fake = createFakeOpenCode({ sessions: [{ id: 'ses_1', parentID: 'ses_root', agent, title: placeholder }] });
    const brief = 'Fix profile review summaries and return navigation';
    fake.state.messages.set('ses_1', [userMessage([
      '[devryan-agent-contract:v1] Runtime instructions.\nDo not summarize these rules.',
      '[devryan-context-mode-routing:v1] Tool routing instructions.',
      '[devryan-managed-read-only:v1] Inspect only.',
      brief,
    ].join('\n\n'))]);
    const generateSessionModelTitle = vi.fn(async () => 'Profile Reviews and Return Navigation');
    const projected = [];
    const outbox = createMemorySessionTitleOutbox();
    const runtime = createRuntime({ fake, projected, outbox, generateSessionModelTitle });
    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledWith(expect.objectContaining({ text: brief }));
    expect(projected.at(-1).title).toBe('Profile Reviews and Return Navigation');
    expect(fake.state.patches).toEqual([]);
    // The original placeholder remains canonical while busy, including restart.
    const persisted = await outbox.list();
    await runtime.dispose();
    const restored = createRuntime({ fake, outbox: createMemorySessionTitleOutbox({ initialJobs: persisted }) });
    await restored.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Profile Reviews and Return Navigation');
    await restored.dispose();
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

  it('projects the derived placeholder immediately, then upgrades with the session model', async () => {
    const prompt = 'Repair provider neutral title generation';
    const fake = createFakeOpenCode({ prompt });
    const projected = [];
    const diagnostics = [];
    const outbox = createMemorySessionTitleOutbox();
    const generateSessionModelTitle = vi.fn(async () => 'Neutral Title Generation Pipeline');
    const runtime = createRuntime({ fake, projected, diagnostics, outbox, generateSessionModelTitle });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: prompt })).resolves.toBe(true);

    expect(projected.map(({ source, title }) => ({ source, title }))).toEqual([
      { source: 'derived', title: 'Provider Neutral Title Generation' },
      { source: 'session_model', title: 'Neutral Title Generation Pipeline' },
    ]);
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(generateSessionModelTitle).toHaveBeenCalledWith(expect.objectContaining({
      text: prompt,
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      timeoutMs: 10_000,
    }));
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Neutral Title Generation Pipeline',
      source: 'session_model',
      replacesTitle: 'Provider Neutral Title Generation',
    })]);
    expect(stageOutcomes(diagnostics, 'derived', 'session_model', 'free_zen')).toEqual([
      'derived:complete',
      'session_model:complete',
    ]);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Neutral Title Generation Pipeline');
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it.each(['anthropic', 'opencode-with-claude'])('keeps the derived title for %s sessions without a session-model call', async (providerID) => {
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

    expect(generateSessionModelTitle).not.toHaveBeenCalled();
    expect(projected).toEqual([expect.objectContaining({ source: 'derived', title: 'Reliable Session Title Summaries' })]);
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Reliable Session Title Summaries',
      source: 'derived',
    })]);
    expect(fake.state.calls.some(({ method }) => method === 'POST')).toBe(false);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('projects the derived title before the session-model promise resolves', async () => {
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
    expect(projected).toEqual([expect.objectContaining({ source: 'derived', title: 'Reliable Session Title Summaries' })]);
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Reliable Session Title Summaries',
      source: 'derived',
    })]);

    resolveGeneration('Upgraded Session Model Title');
    await expect(scheduled).resolves.toBe(true);
    expect(projected).toHaveLength(2);
    expect(projected[1]).toEqual(expect.objectContaining({ source: 'session_model', title: 'Upgraded Session Model Title' }));
    await runtime.dispose();
  });

  it('bounds the session-model upgrade and keeps the derived title when it stalls', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const diagnostics = [];
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(() => new Promise(() => {}));
    const runtime = createRuntime({ fake, projected, diagnostics, generateSessionModelTitle, setTimer, clearTimer });

    const scheduled = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    const boundTimer = () => timers.find(({ delay, cleared }) => delay === 10_000 && !cleared);
    for (let index = 0; index < 20 && !boundTimer(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(projected).toEqual([expect.objectContaining({ source: 'derived' })]);

    boundTimer().callback();
    await expect(scheduled).resolves.toBe(true);
    expect(projected).toHaveLength(1);
    expect(diagnostics.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({
      stage: 'session_model',
      outcome: 'failed',
      reason: 'timeout',
      attempt: 1,
    }));
    expect(timers.filter(({ delay }) => delay === 60_000)).toHaveLength(1);
    await runtime.dispose();
  });

  it('uses a hidden no-tools helper without inheriting the session variant', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const runtime = createRuntime({
      fake,
      projected,
      generateSessionModelTitle: null,
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
    expect(projected.map(({ source, title }) => ({ source, title }))).toEqual([
      { source: 'derived', title: 'Reliable Session Title Summaries' },
      { source: 'session_model', title: 'Selected Model Session Title' },
    ]);
    expect(fake.state.sessions.has('ses_helper')).toBe(false);
    await runtime.dispose();
  });

  it('keeps the derived title when the session model fails and retries once after sixty seconds', async () => {
    const fake = createFakeOpenCode();
    const projected = [];
    const diagnostics = [];
    const outbox = createMemorySessionTitleOutbox();
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(async () => null);
    const runtime = createRuntime({ fake, projected, diagnostics, outbox, generateSessionModelTitle, setTimer, clearTimer });
    const retryTimers = () => timers.filter(({ delay }) => delay === 60_000);

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).resolves.toBe(true);
    expect(projected).toEqual([expect.objectContaining({ source: 'derived', title: 'Reliable Session Title Summaries' })]);
    expect(await outbox.list()).toEqual([expect.objectContaining({
      candidateTitle: 'Reliable Session Title Summaries',
      source: 'derived',
    })]);
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

  it('upgrades its own persisted derived title on retry', async () => {
    const fake = createFakeOpenCode({ status: 'idle' });
    const outbox = createMemorySessionTitleOutbox();
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(async () => null);
    const runtime = createRuntime({ fake, outbox, generateSessionModelTitle, setTimer, clearTimer });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await settleAfterPatches(fake, 1);
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    expect(await outbox.list()).toEqual([]);

    generateSessionModelTitle.mockResolvedValue('Upgraded Session Model Title');
    timers.find(({ delay }) => delay === 60_000).callback();
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(2);
    await settleAfterPatches(fake, 2);
    expect(fake.state.patches).toEqual([
      { sessionID: 'ses_1', title: 'Reliable Session Title Summaries' },
      { sessionID: 'ses_1', title: 'Upgraded Session Model Title' },
    ]);
    expect(fake.state.sessions.get('ses_1').title).toBe('Upgraded Session Model Title');
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('never upgrades a user-typed title', async () => {
    const fake = createFakeOpenCode({ status: 'idle' });
    const outbox = createMemorySessionTitleOutbox();
    const { timers, setTimer, clearTimer } = captureTimers();
    const generateSessionModelTitle = vi.fn(async () => null);
    const runtime = createRuntime({ fake, outbox, generateSessionModelTitle, setTimer, clearTimer });

    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await settleAfterPatches(fake, 1);
    fake.state.sessions.get('ses_1').title = 'User Typed Session Name';

    generateSessionModelTitle.mockResolvedValue('Upgraded Session Model Title');
    timers.find(({ delay }) => delay === 60_000).callback();
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateSessionModelTitle).toHaveBeenCalledTimes(1);
    expect(fake.state.patches).toHaveLength(1);
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
    expect(projected).toEqual([expect.objectContaining({ source: 'derived' })]);
    fake.state.sessions.get('ses_1').title = 'Manual Rename During Generation';
    resolveGeneration('Upgraded Session Model Title');

    await scheduled;

    expect(projected).toHaveLength(1);
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

    expect(projected).toEqual([expect.objectContaining({ source: 'derived' })]);
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
      fetchImpl: vi.fn(),
      buildOpenCodeUrl: vi.fn(() => {
        throw new Error('OpenCode port is not available');
      }),
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
