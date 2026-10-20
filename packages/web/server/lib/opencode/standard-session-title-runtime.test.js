import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {NativeCommandRefusal} from './runtime-host/native-command-refusal.js';

import { createFileSessionTitleOutbox, createMemorySessionTitleOutbox } from './session-title-outbox.js';
import { buildV2PromptContent, buildDevryanPromptMetadata } from './v2/admission.js';
import { toV1UserParts } from './v2/projection/messages.js';
import { loadPlanModeInstruction } from '../../../../../scripts/agent-evals/plan-mode.mjs';
import {
  SESSION_TITLE_HELPER_SESSION_TITLE,
  MAX_DEFERRED_TITLE_RETRIES,
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
    verifyAcceptedTitleInput: async () => true,
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
  it('preserves an outboxed model candidate through known startup reads without renewing its source or inference',async()=>{
    vi.useFakeTimers();const fake=createFakeOpenCode({status:'idle',completed:true}),outbox=createMemorySessionTitleOutbox();
    const client=createFakeOpenCodeClient(fake);let blocked=false;
    const get=client.sessions.get.getMockImplementation();
    client.sessions.get.mockImplementation(async(...args)=>{if(blocked)throw Object.assign(Error('startup'),{code:'native_startup_held'});return get(...args);});
    const generator=vi.fn(async()=>{blocked=true;return 'Reliable Session Title Summaries';});
    const deadline=Date.now()+20_000;
    const runtime=createRuntime({fake,outbox,openCodeClient:client,watchdogEnabled:true,generateSessionModelTitle:generator,isStartupReadinessPending:()=>Date.now()<deadline});
    try{await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});await vi.advanceTimersByTimeAsync(10_000);
      expect((await outbox.list())[0]).toMatchObject({state:'pending_idle',attemptCount:0});expect(generator).toHaveBeenCalledOnce();
      blocked=false;await vi.advanceTimersByTimeAsync(5_000);expect(await outbox.list()).toEqual([]);expect(generator).toHaveBeenCalledOnce();
    }finally{await runtime.dispose();}
  });
  it.each(['startup','busy'])('positively known %s defers title persistence without consuming failure cycles or renewing inference',async kind=>{
    vi.useFakeTimers();const fake=createFakeOpenCode({status:'idle',completed:true}),outbox=createMemorySessionTitleOutbox();
    let blocked=true;const generator=vi.fn(async()=> 'Reliable Session Title Summaries');
    const renameGeneratedTitle=vi.fn(async request=>{
      if(blocked)throw kind==='startup'?Object.assign(Error('startup'),{code:'native_runtime_not_ready'}):new NativeCommandRefusal('native_process_busy',503,'not-dispatched');
      fake.state.sessions.get(request.sessionID).title=request.title;
    });
    const deadline=Date.now()+20_000;
    const runtime=createRuntime({fake,outbox,watchdogEnabled:true,generateSessionModelTitle:generator,renameGeneratedTitle,isStartupReadinessPending:()=>Date.now()<deadline});
    try{await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});await vi.advanceTimersByTimeAsync(10_000);
      expect((await outbox.list())[0]).toMatchObject({state:'pending_idle',attemptCount:0});expect(generator).toHaveBeenCalledTimes(1);
      blocked=false;await vi.advanceTimersByTimeAsync(5_000);expect(await outbox.list()).toEqual([]);expect(generator).toHaveBeenCalledTimes(1);
    }finally{await runtime.dispose();}
  });
  it('a session that stays busy pauses its title job after the deferral bound instead of retrying forever',async()=>{
    vi.useFakeTimers();const fake=createFakeOpenCode({status:'idle',completed:true}),outbox=createMemorySessionTitleOutbox(),diagnostics=[];
    const generator=vi.fn(async()=> 'Reliable Session Title Summaries');
    const renameGeneratedTitle=vi.fn(async()=>{throw new NativeCommandRefusal('native_process_busy',503,'not-dispatched');});
    const runtime=createRuntime({fake,outbox,diagnostics,watchdogEnabled:true,generateSessionModelTitle:generator,renameGeneratedTitle,busyRecheckDelayMs:1_000});
    try{
      await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});
      await vi.advanceTimersByTimeAsync((MAX_DEFERRED_TITLE_RETRIES+5)*1_000);
      expect((await outbox.list())[0]).toMatchObject({state:'paused',attemptCount:0,deferredRetries:MAX_DEFERRED_TITLE_RETRIES});
      const calls=renameGeneratedTitle.mock.calls.length;expect(calls).toBeLessThanOrEqual(MAX_DEFERRED_TITLE_RETRIES+1);
      await vi.advanceTimersByTimeAsync(10*60_000);expect(renameGeneratedTitle).toHaveBeenCalledTimes(calls);
      expect(diagnostics.filter(row=>row.payload.outcome==='retry_scheduled').length).toBeLessThan(MAX_DEFERRED_TITLE_RETRIES);
      expect(generator).toHaveBeenCalledOnce();
    }finally{await runtime.dispose();}
  });
  it.each(['absent','false','failed','expired','replaced'])('persistent startup failure with %s readiness authority consumes the original three-cycle budget',async state=>{
    vi.useFakeTimers();const fake=createFakeOpenCode({status:'idle',completed:true}),outbox=createMemorySessionTitleOutbox();
    const deadline=Date.now()+20_000;let active=true;
    const generator=vi.fn(async()=> 'Reliable Session Title Summaries');
    const renameGeneratedTitle=vi.fn(async()=>{throw Object.assign(Error('not ready'),{code:'native_runtime_not_ready'});});
    const runtime=createRuntime({fake,outbox,watchdogEnabled:true,generateSessionModelTitle:generator,renameGeneratedTitle,
      ...(state==='absent'?{}:{isStartupReadinessPending:()=>active&&state!=='false'&&Date.now()<deadline})});
    try{
      await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});
      if(['failed','expired','replaced'].includes(state)){
        await vi.advanceTimersByTimeAsync(10_000);expect((await outbox.list())[0]).toMatchObject({state:'pending_idle',attemptCount:0});
        if(state!=='expired')active=false;
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await outbox.list())[0]).toMatchObject({state:'paused',attemptCount:3});expect(generator).toHaveBeenCalledOnce();
      const calls=renameGeneratedTitle.mock.calls.length;await vi.advanceTimersByTimeAsync(60_000);expect(renameGeneratedTitle).toHaveBeenCalledTimes(calls);
    }finally{await runtime.dispose();}
  });
  it.each(['unknown','reply','unprovedBusy'])('an %s persistence refusal still pauses after three cycles',async kind=>{
    vi.useFakeTimers();const fake=createFakeOpenCode({status:'idle',completed:true}),outbox=createMemorySessionTitleOutbox();
    const renameGeneratedTitle=vi.fn(async()=>{throw kind==='reply'?new NativeCommandRefusal('native_process_busy',503,'reply')
      : Object.assign(Error('refused'),{code:kind==='unprovedBusy'?'native_process_busy':'unknown'});});
    const runtime=createRuntime({fake,outbox,watchdogEnabled:true,renameGeneratedTitle});
    try{await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});await vi.advanceTimersByTimeAsync(60_000);
      expect((await outbox.list())[0]).toMatchObject({state:'paused',attemptCount:3});expect(renameGeneratedTitle).toHaveBeenCalledTimes(3);
    }finally{await runtime.dispose();}
  });
  it('pauses unknown status after three cycles rather than treating it as known busy',async()=>{
    vi.useFakeTimers();const fake=createFakeOpenCode({status:'unknown',completed:true}),outbox=createMemorySessionTitleOutbox();
    const runtime=createRuntime({fake,outbox,watchdogEnabled:true});
    try{await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});await vi.advanceTimersByTimeAsync(60_000);
      expect((await outbox.list())[0]).toMatchObject({state:'paused',attemptCount:3});expect(fake.state.patches).toEqual([]);
    }finally{await runtime.dispose();}
  });
  it('titles the complete real request after the current multipart Plan prompt round-trip', async () => {
    const preface = loadPlanModeInstruction();
    const requests = ['Fix mobile chat positioning and dark tab selection.', 'Match certification fills and remove scrolling breadcrumb backgrounds.'];
    const content = buildV2PromptContent([{ type: 'text', text: preface, synthetic: true }, ...requests.map(text => ({ type: 'text', text }))]);
    const metadata = { devryan: buildDevryanPromptMetadata({ origin: 'user', planMode: content.planMode, parts: content.segments }, { text: content.text }) };
    const parts = toV1UserParts({ id: 'msg_plan', text: content.text, metadata }, 'ses_1');
    expect(parts.map(part => [part.text, part.synthetic === true])).toEqual([[preface, true], ...requests.map(text => [text, false])]);
    const fake = createFakeOpenCode({ status: 'idle', completed: true });
    fake.state.messages.set('ses_1', [{ ...userMessage(''), parts }, completedAssistantMessage()]);
    const generated = vi.fn(async () => 'Public Profile Visual Corrections');
    const projected = [];
    const runtime = createRuntime({ fake, projected, generateSessionModelTitle: generated });
    try {
      await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
      expect(generated).toHaveBeenCalledWith(expect.objectContaining({ text: requests.join(' ') }));
      expect(projected[0]).toMatchObject({ title: 'Public Profile Visual Corrections', source: 'session_model' });
    } finally { await runtime.dispose(); }
  });

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

  it('fences a late timed-out answer and never dispatches another model after unconfirmed settlement', async () => {
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
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ title: 'Reliable Session Title Summaries', source: 'derived' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generator).toHaveBeenCalledOnce();
    expect(projected[0]?.title).not.toBe('Late Answer Must Not Win');
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
      providerID: 'opencode',
      modelID: 'deepseek-v4.1-flash',
      selectionMode: 'configured',
      timeoutMs: expect.any(Number),
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
    expect(projected[0]).toMatchObject({ source: 'derived' });
    expect(diagnostics.map(({ payload }) => payload)).toContainEqual(expect.objectContaining({
      stage: 'session_model',
      outcome: 'failed',
      reason: 'unsettled',
      attempt: 1,
    }));
    expect(timers.filter(({ delay }) => delay === 60_000)).toHaveLength(0);
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

  it('tries the configured helper then authorized active model within one total budget', async () => {
    let clock = 100;
    const fake = createFakeOpenCode(), projected = [], diagnostics = [];
    const resolver = vi.fn(async ({ selectionMode }) => selectionMode === 'configured'
      ? { providerID: 'opencode', modelID: 'flash', selectionRevision: 'revision-1' }
      : { providerID: 'anthropic', modelID: 'active', variant: 'high', selectionRevision: 'active-session' });
    const generator = vi.fn(async input => { clock += 7_000; return input.selectionMode === 'configured' ? null : 'Authorized Active Model Title'; });
    const runtime = createRuntime({ fake, projected, diagnostics, now: () => clock, resolveHelperSelection: resolver, generateSessionModelTitle: generator });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', providerID: 'foreign', modelID: 'untrusted-history' });
    expect(generator.mock.calls.map(([input]) => [input.selectionMode, input.providerID, input.modelID, input.timeoutMs])).toEqual([
      ['configured', 'opencode', 'flash', 30_000], ['active', 'anthropic', 'active', 23_000],
    ]);
    // Default helper reasoning stays variant-free; the active fallback keeps the session's own variant.
    expect(generator.mock.calls[0][0]).not.toHaveProperty('variant');
    expect(generator.mock.calls[1][0]).toHaveProperty('variant', 'high');
    expect(projected[0]).toMatchObject({ title: 'Authorized Active Model Title', source: 'session_model' });
    expect(stageOutcomes(diagnostics, 'session_model')).toEqual(['session_model:failed', 'session_model:complete']);
    await runtime.dispose();
  });

  it.each(['selection','request','result'])('does not acquire fallback authority after a helper selection change during %s', async stage => {
    const fake=createFakeOpenCode(),diagnostics=[],projected=[];
    const error=()=>Object.assign(Error('selection changed'),{code:'native_helper_selection_changed',statusCode:403});
    const resolver=vi.fn(async()=>{if(stage==='selection')throw error();return {providerID:'opencode',modelID:'flash',selectionRevision:'revision-1'};});
    const generator=vi.fn(async()=>{if(stage==='request')throw error();return {title:null,reason:'selection_changed'};});
    const runtime=createRuntime({fake,diagnostics,projected,resolveHelperSelection:resolver,generateSessionModelTitle:generator});
    try{
      await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});
      expect(resolver).toHaveBeenCalledOnce();expect(generator).toHaveBeenCalledTimes(stage==='selection'?0:1);
      expect(diagnostics.map(row=>row.payload)).toContainEqual(expect.objectContaining({reason:'selection_changed'}));
      expect(projected[0]).toMatchObject({source:'derived'});
    }finally{await runtime.dispose();}
  });

  it('derives only after both settled attempts fail and refuses a third attempt', async () => {
    const fake = createFakeOpenCode(), projected = [];
    const generator = vi.fn(async () => null);
    const resolver = vi.fn(async ({ selectionMode }) => ({ providerID: selectionMode, modelID: 'valid', selectionRevision: '1' }));
    const runtime = createRuntime({ fake, projected, generateSessionModelTitle: generator, resolveHelperSelection: resolver });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generator).toHaveBeenCalledTimes(2);
    expect(projected[0]).toMatchObject({ title: 'Reliable Session Title Summaries', source: 'derived' });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generator).toHaveBeenCalledTimes(2);
    await runtime.processOpenCodeEvent(idleEvent());
    expect(fake.state.sessions.get('ses_1').title).toBe('Reliable Session Title Summaries');
    await runtime.dispose();
  });

  it('preserves a human rename during the authorized fallback request', async () => {
    const fake = createFakeOpenCode({ status: 'idle', completed: true }), projected = [];
    const resolver = vi.fn(async ({ selectionMode }) => ({ providerID: selectionMode, modelID: 'valid', selectionRevision: '1' }));
    const generator = vi.fn(async input => {
      if (input.selectionMode === 'configured') return null;
      fake.state.sessions.get('ses_1').title = 'User Typed Session Name';
      return 'Authorized Active Model Title';
    });
    const runtime = createRuntime({ fake, projected, resolveHelperSelection: resolver, generateSessionModelTitle: generator });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generator).toHaveBeenCalledTimes(2);
    expect(projected).toEqual([]);
    expect(fake.state.patches).toEqual([]);
    expect(fake.state.sessions.get('ses_1').title).toBe('User Typed Session Name');
    await runtime.dispose();
  });

  it('shares one budget across concurrent schedules and never requests fallback after budget exhaustion', async () => {
    let clock = 0, finish;
    const fake = createFakeOpenCode(), projected = [];
    const resolver = vi.fn(async ({ selectionMode }) => ({ providerID: selectionMode, modelID: 'valid', selectionRevision: '1' }));
    const generator = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const runtime = createRuntime({ fake, projected, now: () => clock, generateSessionModelTitle: generator, resolveHelperSelection: resolver });
    const first = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    const second = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(generator).toHaveBeenCalledOnce());
    clock = 30_000; finish(null); await first;
    expect(resolver).toHaveBeenCalledOnce();
    expect(generator).toHaveBeenCalledOnce();
    expect(projected[0]).toMatchObject({ source: 'derived' });
    await runtime.dispose();
  });

  it('pauses after three failed persistence cycles, survives restart, and reopens once for canonical accepted human input', async () => {
    vi.useFakeTimers();
    const fake = createFakeOpenCode({ status: 'idle', completed: true, patchFailures: 20 });
    const outbox = createMemorySessionTitleOutbox();
    let runtime = createRuntime({ fake, outbox, watchdogEnabled: true });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: 'Fix reliable session title summaries', acceptedInputID: 'msg_user' });
    await vi.advanceTimersByTimeAsync(0);
    expect((await outbox.list())[0]).toMatchObject({ attemptCount: 1, sourceMessageID: 'msg_user' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await outbox.list())[0].attemptCount).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await outbox.list())[0]).toMatchObject({ state: 'paused', attemptCount: 3, nextAttemptAt: 0 });
    expect(fake.state.patches).toHaveLength(3);
    await runtime.dispose();
    runtime = createRuntime({ fake, outbox, watchdogEnabled: true });
    await runtime.schedulePlaceholderRecovery({ directory: '/tmp/project' });
    await runtime.processOpenCodeEvent(idleEvent());
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: 'Unverified new input', acceptedInputID: 'msg_missing' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.state.patches).toHaveLength(3);
    const next = userMessage('Accepted next human request'); next.info.id = 'msg_next';
    fake.state.messages.get('ses_1').push(next);
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: 'Accepted next human request', acceptedInputID: 'msg_next' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.state.patches).toHaveLength(6);
    expect((await outbox.list())[0]).toMatchObject({ state: 'paused', attemptCount: 3, sourceMessageID: 'msg_user', lastAcceptedInputID: 'msg_next' });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', text: 'Accepted next human request', acceptedInputID: 'msg_next' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.state.patches).toHaveLength(6);
    fake.state.sessions.get('ses_1').title = 'Manual Rename Wins';
    await runtime.processOpenCodeEvent({ type: 'session.updated', properties: { info: fake.state.sessions.get('ses_1') } });
    expect(await outbox.list()).toEqual([]);
    await runtime.dispose();
  });

  it('records native mismatch and bounded refusal metadata without titles, hashes or private errors', async () => {
    const fake = createFakeOpenCode({ status: 'idle', completed: true }), diagnostics = [], warnings = [];
    const runtime = createRuntime({ fake, diagnostics, logger: { warn: (...args) => warnings.push(args) },
      renameGeneratedTitle: async () => { throw Object.assign(new Error('private generated title must never escape'), { code: 'native_helper_title_conflict' }); } });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    for (let index = 0; index < 20 && !diagnostics.some(row => row.payload.stage === 'rename_refused'); index++) await Promise.resolve();
    expect(diagnostics.map(row => row.payload)).toContainEqual(expect.objectContaining({ stage: 'rename_refused', refusalCode: 'native_helper_title_conflict',
      nativeEqualsCandidate: false, nativeEqualsExpected: true, nativeLength: PLACEHOLDER.length, candidateLength: 'Reliable Session Title Summaries'.length,
      sourceMessageID: 'msg_user', sourceIdentityPresent: true }));
    const serialized = JSON.stringify({ diagnostics, warnings });
    expect(serialized).not.toContain('private generated title');
    expect(serialized).not.toContain('Reliable Session Title Summaries');
    expect(serialized).not.toContain('sourceHash');
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
    const generator = vi.fn(async () => 'Reliable Session Title Summaries');
    const runtime = createRuntime({
      fake,
      projected,
      generateSessionModelTitle: generator,
      outbox: {
        ...backing,
        upsert: vi.fn(async () => {
          throw new Error('disk unavailable');
        }),
      },
    });

    await expect(runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).resolves.toBe(false);
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generator).toHaveBeenCalledOnce();
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

  it('pauses missing idle evidence after the bounded observation ladder and retains its candidate across restart', async () => {
    vi.useFakeTimers();
    const fake = createFakeOpenCode({ status: null });
    const startedAt = Date.now();
    const outbox = createMemorySessionTitleOutbox({
      initialJobs: [pendingJob({ attemptCount: 17, nextAttemptAt: startedAt })],
    });
    let runtime = createRuntime({ fake, outbox, watchdogEnabled: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fake.state.patches).toEqual([]);
    expect(await outbox.list()).toEqual([
      expect.objectContaining({
        attemptCount: 17,
        inactiveObservationCount: 6,
        state: 'paused',
        nextAttemptAt: 0,
      }),
    ]);
    const reads = fake.state.calls.length;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fake.state.calls).toHaveLength(reads);

    const paused = await outbox.list();
    await runtime.dispose();runtime = createRuntime({ fake, outbox, watchdogEnabled: true });
    await runtime.processOpenCodeEvent(idleEvent());await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.state.patches).toEqual([]);expect(await outbox.list()).toEqual(paused);
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

  it('only a new accepted human input reopens a bounded missing-idle cycle', async () => {
    vi.useFakeTimers();
    const fake=createFakeOpenCode({status:null}),outbox=createMemorySessionTitleOutbox();
    const generateSessionModelTitle=vi.fn(async()=> 'Reliable Session Title Summaries');
    const runtime=createRuntime({fake,outbox,watchdogEnabled:true,generateSessionModelTitle});
    try{
      await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'});await vi.advanceTimersByTimeAsync(60_000);
      const paused=(await outbox.list())[0];expect(paused).toMatchObject({state:'paused',attemptCount:0,inactiveObservationCount:6});
      const next=userMessage('Accepted next request');next.info.id='msg_next';fake.state.messages.get('ses_1').push(next);
      await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project',text:'Accepted next request',acceptedInputID:'msg_next'});
      await vi.advanceTimersByTimeAsync(0);
      expect((await outbox.list())[0]).toMatchObject({state:'pending_idle',attemptCount:0,inactiveObservationCount:1,
        sourceHash:paused.sourceHash,sourceMessageID:paused.sourceMessageID,candidateTitle:paused.candidateTitle,lastAcceptedInputID:'msg_next'});
      await vi.advanceTimersByTimeAsync(60_000);expect((await outbox.list())[0].state).toBe('paused');
      const calls=fake.state.calls.length;
      await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project',text:'Accepted next request',acceptedInputID:'msg_next'});
      const afterSchedule=fake.state.calls.length;expect(afterSchedule).toBeGreaterThan(calls);
      await vi.advanceTimersByTimeAsync(60_000);expect(fake.state.calls).toHaveLength(afterSchedule);expect(generateSessionModelTitle).toHaveBeenCalledOnce();
    }finally{await runtime.dispose();}
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

  it('uses the configured helper independently of prompt and history selection with Default reasoning', async () => {
    const selection = { providerID: 'opencode', modelID: 'deepseek-v4.1-flash' };
    const generateHelperText = vi.fn(async (request) => {
      if (request.providerID !== selection.providerID || request.modelID !== selection.modelID || Object.hasOwn(request, 'variant')) {
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

  it('forwards the saved helper reasoning variant and journals the helper refusal code', async () => {
    const resolveHelperSelection = vi.fn(async ({ selectionMode }) => selectionMode === 'configured'
      ? { providerID: 'openai', modelID: 'gpt-6-astra', variant: 'low', selectionMode, selectionRevision: 'saved' } : null);
    const generateHelperText = vi.fn(async () => { throw Object.assign(new Error('refused'), { code: 'native_provider_resolution_scope_required', statusCode: 503 }); });
    const fake = createFakeOpenCode(), projected = [], diagnostics = [];
    const runtime = createRuntime({ fake, projected, diagnostics, generateSessionModelTitle: null, generateHelperText, resolveHelperSelection,
      openCodeClient: createFakeOpenCodeClient(fake) });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generateHelperText).toHaveBeenCalledWith(expect.objectContaining({ providerID: 'openai', modelID: 'gpt-6-astra', variant: 'low',
      selectionMode: 'configured', selectionRevision: 'saved', agent: 'devryan-title' }));
    const failures = diagnostics.map(({ payload }) => payload).filter(payload => ['helper_create', 'session_model'].includes(payload.stage));
    expect(failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'helper_create', status: 503, code: 'native_provider_resolution_scope_required' }),
      expect.objectContaining({ stage: 'session_model', outcome: 'failed', code: 'native_provider_resolution_scope_required' }),
    ]));
    // Only bounded native identifiers are journaled, never provider text.
    expect(JSON.stringify(diagnostics)).not.toContain('refused');
    await runtime.dispose();
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

const createManagedTitleFake = (options = {}) => createFakeOpenCode({ ...options, sessions: [{ id: 'ses_1', parentID: 'ses_root', agent: 'fixer', directory: '/tmp/project', title: 'Managed Fixer Task', time: { updated: 1 } }] });
const titleUserEvent = messageID => ({ type: 'message.updated', properties: { info: { id: messageID, sessionID: 'ses_1', role: 'user' } } });
const managedSource = recheck => ({ sessionID: 'ses_1', directory: '/tmp/project', sourceMessageID: 'msg_user', recheck });

it.each(['native_managed_title_source_invalid','untrusted_private_code'])('records bounded managed input refusal %s without raw source or exception content',async code=>{
 const fake=createManagedTitleFake(),diagnostics=[],generator=vi.fn();
 const runtime=createRuntime({fake,diagnostics,generateSessionModelTitle:generator,
  captureManagedTitleInput:async()=>{throw Object.assign(Error('private source text and title must not escape'),{code});}});
 try{
  expect(await runtime.schedule({sessionID:'ses_1',directory:'/tmp/project'})).toBe(false);
  expect(await runtime.processOpenCodeEvent(titleUserEvent('msg_user'))).toBe(false);
  const input=diagnostics.filter(row=>row.payload.stage==='input');expect(input).toHaveLength(2);
  expect(input.every(row=>row.payload.sourceMessageID==='msg_user'&&row.payload.sourceIdentityPresent)).toBe(true);
  expect(input.every(row=>row.payload.refusalCode===(code==='native_managed_title_source_invalid'?code:'request_failure'))).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain('private source');expect(JSON.stringify(diagnostics)).not.toContain('untrusted_private_code');
  expect(generator).not.toHaveBeenCalled();
 }finally{await runtime.dispose();}
});

it.each(['root','synthetic'])('keeps expected %s input probes out of managed title failure diagnostics',async kind=>{
 const fake=kind==='root'?createFakeOpenCode():createManagedTitleFake(),diagnostics=[];
 if(kind==='synthetic')fake.state.messages.get('ses_1').push({info:{id:'msg_synthetic',role:'user'},parts:[{type:'text',text:'Maintenance',synthetic:true}]});
 const runtime=createRuntime({fake,diagnostics,captureManagedTitleInput:async()=>{throw Object.assign(Error('refused'),{code:'native_managed_title_source_invalid'});}});
 try{expect(await runtime.processOpenCodeEvent(titleUserEvent(kind==='root'?'msg_user':'msg_synthetic'))).toBe(false);expect(diagnostics).toEqual([]);}
 finally{await runtime.dispose();}
});

it('records a known child input refusal when its projected source row is unavailable',async()=>{
 const fake=createManagedTitleFake(),diagnostics=[];fake.state.messages.set('ses_1',[]);
 const runtime=createRuntime({fake,diagnostics,captureManagedTitleInput:async()=>{throw Object.assign(Error('refused'),{code:'native_managed_title_source_invalid'});}});
 try{await runtime.processOpenCodeEvent(titleUserEvent('msg_user'));expect(diagnostics.map(row=>row.payload)).toContainEqual(expect.objectContaining({stage:'input',sourceMessageID:'msg_user',refusalCode:'native_managed_title_source_invalid'}));}
 finally{await runtime.dispose();}
});

it('enrolls an initial managed title only after the exact accepted user event and does not regenerate on replay', async () => {
  const fake = createManagedTitleFake({ status: 'idle', completed: true });
  let accepted = false; const generator = vi.fn(async () => 'Resolved Child Task Title');
  const runtime = createRuntime({ fake, generateSessionModelTitle: generator,
    captureManagedTitleInput: async ({ messageID }) => { if (!accepted || messageID && messageID !== 'msg_user') throw Error('No accepted source'); return managedSource(async () => {}); } });
  try {
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).toBe(false);
    expect(generator).not.toHaveBeenCalled(); accepted = true;
    expect(await runtime.processOpenCodeEvent(titleUserEvent('msg_user'))).toBe(true);
    await vi.waitFor(() => expect(fake.state.sessions.get('ses_1').title).toBe('Resolved Child Task Title'));
    await runtime.processOpenCodeEvent(titleUserEvent('msg_user'));
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generator).toHaveBeenCalledOnce();
  } finally { await runtime.dispose(); }
});
it('does not dispatch a model after its managed witness consumes the shared deadline', async () => {
  const fake = createManagedTitleFake(); let clock = 0, checks = 0;
  const generator = vi.fn(async () => 'Late Title');
  const runtime = createRuntime({ fake, now: () => clock, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => managedSource(async () => { if (++checks === 2) clock = 30_000; }) });
  try { await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' }); expect(generator).not.toHaveBeenCalled(); }
  finally { await runtime.dispose(); }
});
it('retains the consumed model budget when permissions are revoked after generation and restored before reschedule', async () => {
  const fake = createManagedTitleFake(); let allowed = true;
  const generator = vi.fn(async () => { allowed = false; return 'Resolved Child Task Title'; });
  const projected = [], outbox = createMemorySessionTitleOutbox();
  const runtime = createRuntime({ fake, outbox, projected, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => managedSource(async () => { if (!allowed) throw Error('Owner revoked'); }) });
  try {
    expect(await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' })).toBe(false);
    allowed = true; await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    expect(generator).toHaveBeenCalledOnce(); expect(projected).toEqual([]); expect(await outbox.list()).toEqual([]);
  } finally { await runtime.dispose(); }
});
it('uses a fresh human source during the remaining pending child persistence cycle without resetting attempts or model budget', async () => {
  vi.useFakeTimers();
  const fake = createManagedTitleFake({ status: 'idle', completed: true }); const outbox = createMemorySessionTitleOutbox();
  const generator = vi.fn(async () => 'Resolved Child Task Title'); let first = true, entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const renames = []; let secondJob;
  const runtime = createRuntime({ fake, outbox, watchdogEnabled: true, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => managedSource(async () => {}),
    captureAcceptedHumanTitleInput: async ({ messageID }) => { if (messageID !== 'msg_next') throw Error('Not human'); return { ...managedSource(async () => {}), sourceMessageID: messageID, text: 'Accepted next request' }; },
    renameGeneratedTitle: async input => { renames.push(input); if (first) { first = false; entered(); await gate; throw Error('Retry'); } secondJob = (await outbox.list())[0]; fake.state.sessions.get('ses_1').title = input.title; } });
  try {
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' }); await started;
    const next = userMessage('Accepted next request'); next.info.id = 'msg_next'; fake.state.messages.get('ses_1').push(next);
    expect(await runtime.processOpenCodeEvent(titleUserEvent('msg_next'))).toBe(true); release();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondJob).toMatchObject({ attemptCount: 2, lastAcceptedInputID: 'msg_next', sourceMessageID: 'msg_user' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generator).toHaveBeenCalledOnce(); expect(renames).toHaveLength(2);
    expect(renames[1].sourceMessageID).toBe('msg_next'); expect(await outbox.list()).toEqual([]);
  } finally { release(); await runtime.dispose(); }
});
it('only a new human can reopen a paused child cycle and manual rename still wins', async () => {
  vi.useFakeTimers(); const fake = createManagedTitleFake({ status: 'idle', completed: true, patchFailures: 20 });
  const outbox = createMemorySessionTitleOutbox(), generator = vi.fn(async () => 'Resolved Child Task Title');
  const runtime = createRuntime({ fake, outbox, watchdogEnabled: true, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => managedSource(async () => {}),
    captureAcceptedHumanTitleInput: async ({ messageID }) => { if (messageID !== 'msg_next') throw Error('Not human'); return { ...managedSource(async () => {}), sourceMessageID: messageID, text: 'Accepted next request' }; } });
  try {
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' }); await vi.advanceTimersByTimeAsync(3_000);
    expect((await outbox.list())[0]).toMatchObject({ state: 'paused', attemptCount: 3 });
    expect(await runtime.processOpenCodeEvent(titleUserEvent('msg_synthetic'))).toBe(false);
    const next = userMessage('Accepted next request'); next.info.id = 'msg_next'; fake.state.messages.get('ses_1').push(next);
    await runtime.processOpenCodeEvent(titleUserEvent('msg_next')); await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.state.patches).toHaveLength(6);
    await runtime.processOpenCodeEvent(titleUserEvent('msg_next')); await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.state.patches).toHaveLength(6); expect(generator).toHaveBeenCalledOnce();
    fake.state.sessions.get('ses_1').title = 'Manual Rename Wins';
    await runtime.processOpenCodeEvent({ type: 'session.updated', properties: { info: fake.state.sessions.get('ses_1') } });
    expect(await outbox.list()).toEqual([]);
  } finally { await runtime.dispose(); }
});

for (const manual of [false, true]) it(`serializes a held human source verifier against idle persistence${manual ? ' and manual removal' : ''}`, async () => {
  const fake = createManagedTitleFake({ status: 'idle', completed: true, patchFailures: 20 });
  const outbox = createMemorySessionTitleOutbox(), generator = vi.fn(async () => 'Resolved Child Task Title');
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const runtime = createRuntime({ fake, outbox, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => managedSource(async () => {}),
    verifyAcceptedTitleInput: async () => { entered(); await gate; return true; } });
  try {
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await vi.waitFor(async () => expect((await outbox.list())[0]?.attemptCount).toBe(1));
    const next = userMessage('Accepted next request'); next.info.id = 'msg_next'; fake.state.messages.get('ses_1').push(next);
    const adoption = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', acceptedInputID: 'msg_next', text: 'Accepted next request' });
    await began;
    const idle = runtime.processOpenCodeEvent(idleEvent());
    if (manual) { fake.state.sessions.get('ses_1').title = 'Manual Rename Wins'; await runtime.processOpenCodeEvent({ type: 'session.updated', properties: { info: fake.state.sessions.get('ses_1') } }); }
    expect(fake.state.patches).toHaveLength(1); release(); await adoption; await idle;
    if (manual) { expect(await outbox.list()).toEqual([]); expect(fake.state.patches).toHaveLength(1); }
    else { await vi.waitFor(async () => expect((await outbox.list())[0]?.attemptCount).toBe(2)); expect(fake.state.patches).toHaveLength(2); }
    expect(generator).toHaveBeenCalledOnce();
  } finally { release(); await runtime.dispose(); }
});

it('adopts the latest human B after a held human A schedule without buying another model or persistence budget', async () => {
  const fake = createManagedTitleFake({ status: 'idle', completed: true }), outbox = createMemorySessionTitleOutbox();
  const generator = vi.fn(async () => 'Resolved Child Task Title'); let latest = 'msg_user', entered, release, thirdJob;
  const began = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const renames = [];
  const runtime = createRuntime({ fake, outbox, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => managedSource(async () => {}),
    captureAcceptedHumanTitleInput: async ({ messageID }) => ({ ...managedSource(async () => { if (latest !== messageID) throw Error('Stale human'); }), sourceMessageID: messageID, text: messageID === 'msg_B' ? 'Accepted human B' : 'Accepted human A' }),
    verifyAcceptedTitleInput: async ({ messageID }) => { if (messageID === 'msg_A') { entered(); await gate; } return true; },
    renameGeneratedTitle: async input => {
      renames.push(input); if (renames.length === 1 || input.sourceMessageID !== latest) throw Error('Refused');
      thirdJob = (await outbox.list())[0]; fake.state.sessions.get('ses_1').title = input.title;
    } });
  try {
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' });
    await vi.waitFor(async () => expect((await outbox.list())[0]?.attemptCount).toBe(1));
    const A = userMessage('Accepted human A'); A.info.id = 'msg_A'; fake.state.messages.get('ses_1').push(A); latest = 'msg_A';
    const adoptingA = runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project', acceptedInputID: 'msg_A', text: 'Accepted human A' }); await began;
    const B = userMessage('Accepted human B'); B.info.id = 'msg_B'; fake.state.messages.get('ses_1').push(B); latest = 'msg_B';
    const acceptingB = runtime.processOpenCodeEvent(titleUserEvent('msg_B'));
    release(); await adoptingA; expect(await acceptingB).toBe(true);
    await vi.waitFor(() => expect(fake.state.sessions.get('ses_1').title).toBe('Resolved Child Task Title'));
    expect(renames).toHaveLength(3); expect(renames[2].sourceMessageID).toBe('msg_B');
    expect(thirdJob).toMatchObject({ attemptCount: 3, sourceMessageID: 'msg_user', lastAcceptedInputID: 'msg_B' });
    expect(generator).toHaveBeenCalledOnce(); expect(await outbox.list()).toEqual([]);
  } finally { release(); await runtime.dispose(); }
});
it('retains and pauses a reloaded delegated candidate when its original controller proof cannot renew', async () => {
  vi.useFakeTimers();
  const fake = createManagedTitleFake({ status: 'busy', completed: true }), outbox = createMemorySessionTitleOutbox();
  const generator = vi.fn(async () => 'Resolved Child Task Title'), diagnostics = [];
  let controller = 'original', renameCalls = 0;
  const source = managedSource(async () => {
    if (controller !== 'original') throw Object.assign(Error('native_managed_title_source_invalid'), { code: 'native_managed_title_source_invalid' });
  });
  const options = { fake, outbox, diagnostics, generateSessionModelTitle: generator,
    captureManagedTitleInput: async () => source,
    renameGeneratedTitle: async input => { renameCalls++; await source.recheck(); fake.state.sessions.get('ses_1').title = input.title; } };
  let runtime = createRuntime(options);
  try {
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' }); await vi.advanceTimersByTimeAsync(0);
    const pending = (await outbox.list())[0]; expect(pending).toMatchObject({ state: 'pending_idle', attemptCount: 0, sourceMessageID: 'msg_user' });
    expect(renameCalls).toBe(0); await runtime.dispose();
    controller = 'replacement'; fake.state.statuses.set('ses_1', 'idle');
    runtime = createRuntime({ ...options, watchdogEnabled: true });
    await runtime.schedule({ sessionID: 'ses_1', directory: '/tmp/project' }); await vi.advanceTimersByTimeAsync(3_000);
    expect((await outbox.list())[0]).toMatchObject({ state: 'paused', attemptCount: 3, sourceMessageID: pending.sourceMessageID, candidateTitle: pending.candidateTitle, sourceHash: pending.sourceHash });
    expect(renameCalls).toBe(3); expect(generator).toHaveBeenCalledOnce();
    expect(fake.state.sessions.get('ses_1').title).toBe('Managed Fixer Task');
    expect(diagnostics.some(row => row.payload.refusalCode === 'native_managed_title_source_invalid')).toBe(true);
    await runtime.processOpenCodeEvent(idleEvent()); await vi.advanceTimersByTimeAsync(60_000); expect(renameCalls).toBe(3);
  } finally { await runtime.dispose(); }
});
