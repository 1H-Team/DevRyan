import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebHarnessRuntime } from './runtime.js';

const temporaryDirectories = [];

const createResponse = () => {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = {};
  response.body = null;
  response.setHeader = (name, value) => {
    response.headers[name] = value;
  };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('web harness prompt admission', () => {
  it('passes only canonical idle events to the native TODO observer after existing liveness observation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-idle-observer-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    const events = [];
    runtime.setPrimaryRecoveryRuntime({ observe: () => events.push('primary') });
    runtime.setNativeSessionIdleObserver(input => { events.push(input); });
    const idle = { type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'idle' } } };
    runtime.recordOpenCodeEvent(idle, directory);
    await Promise.resolve();
    expect(events).toEqual(['primary', { sessionID: 'ses_owned', directory }]);
    runtime.recordOpenCodeEvent(idle);
    runtime.recordOpenCodeEvent({ ...idle, properties: { ...idle.properties, status: { type: 'busy' } } }, directory);
    runtime.recordOpenCodeEvent({ type: 'message.updated', properties: { sessionID: 'ses_owned' } }, directory);
    await Promise.resolve();
    expect(events.slice(2)).toEqual(['primary', 'primary', 'primary']);
    await runtime.drain();
  });
  it('isolates observational failures in recordOpenCodeEvent while primary recovery runs first and may throw', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-observation-isolation-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    const order = [], recorded = [];
    const enqueue = runtime.journal.enqueue;
    runtime.journal.enqueue = (entry) => { recorded.push(entry); return true; };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runtime.setPrimaryRecoveryRuntime({ observe: () => order.push('primary') });
      runtime.setNativeSessionIdleObserver(() => { order.push('idle'); });
      // A sync throw in session-change observation still journals the event.
      runtime.setSessionChangeHost({ observe: () => { order.push('changes'); throw Object.assign(new Error('x'), { code: 'capture_broken' }); }, drain: async () => {} });
      const idle = { type: 'session.status', properties: { sessionID: 'ses_iso', status: { type: 'idle' } } };
      expect(runtime.recordOpenCodeEvent(idle, directory)).toBe(true);
      await Promise.resolve();
      expect(order).toEqual(['primary', 'changes', 'idle']);
      expect(recorded.map((entry) => entry.event ?? entry.type)).toEqual(['session_changes_observation_failed', 'open_code_event']);
      expect(recorded[0].payload.code).toBe('capture_broken');
      // An async rejection is recorded once it settles.
      recorded.length = 0;
      runtime.setSessionChangeHost({ observe: async () => { throw new Error('later'); }, drain: async () => {} });
      runtime.recordOpenCodeEvent({ type: 'message.updated', properties: { sessionID: 'ses_iso' } }, directory);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(recorded.map((entry) => entry.event ?? entry.type)).toEqual(['open_code_event', 'session_changes_observation_failed']);
      // A journal that throws synchronously never throws into the event path.
      runtime.journal.enqueue = () => { throw Object.assign(new Error('disk'), { code: 'journal_closed' }); };
      expect(runtime.recordOpenCodeEvent({ type: 'message.updated', properties: { sessionID: 'ses_iso' } }, directory)).toBe(false);
      expect(warn).toHaveBeenCalledWith('[harness] journal record failed', { type: 'open_code_event', code: 'journal_closed' });
      // Primary recovery is authority-bearing: its throw still propagates before anything else runs.
      order.length = 0;
      runtime.setPrimaryRecoveryRuntime({ observe: () => { throw new Error('recovery owner failed'); } });
      expect(() => runtime.recordOpenCodeEvent(idle, directory)).toThrow('recovery owner failed');
      expect(order).toEqual([]);
    } finally {
      warn.mockRestore();
      runtime.journal.enqueue = enqueue;
      runtime.setSessionChangeHost(null);
      await runtime.drain();
    }
  });
  it('returns retryable 503 before initialization and records only accepted prompts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({
      dataDirectory: directory,
      runtime: 'test',
    });
    const recordPromptAccepted = vi.fn();
    const middleware = runtime.promptAdmissionMiddleware({ recordPromptAccepted });
    const request = {
      method: 'POST',
      principal: { id: 'user-1', role: 'developer', scope: 'managed' },
      params: { sessionID: 'ses_1' },
      query: { directory: '/repo' },
      headers: { 'x-openchamber-message-id': 'msg_1' },
      body: { parts: [{ type: 'text', text: 'hello' }] },
    };

    const initializingResponse = createResponse();
    const initializingNext = vi.fn();
    middleware(request, initializingResponse, initializingNext);
    expect(initializingResponse.statusCode).toBe(503);
    expect(initializingResponse.headers['Retry-After']).toBe('1');
    expect(initializingResponse.body).toMatchObject({ code: 'HARNESS_INITIALIZING' });
    expect(initializingNext).not.toHaveBeenCalled();

    await runtime.initialize();
    const releaseRecoveryHold = runtime.acquirePromptAdmissionHold('runtime_recovery', {
      code: 'runtime_recovery_pending',
      error: 'Runtime recovery is pending',
      retryAfterSeconds: 1,
    });
    const recoveryResponse = createResponse();
    middleware(request, recoveryResponse, vi.fn());
    expect(recoveryResponse.statusCode).toBe(503);
    expect(recoveryResponse.headers['Retry-After']).toBe('1');
    expect(recoveryResponse.body).toEqual({
      code: 'runtime_recovery_pending',
      error: 'Runtime recovery is pending',
    });
    releaseRecoveryHold();

    const acceptedResponse = createResponse();
    const acceptedNext = vi.fn();
    middleware(request, acceptedResponse, acceptedNext);
    expect(acceptedNext).toHaveBeenCalledOnce();
    acceptedResponse.statusCode = 202;
    acceptedResponse.emit('finish');
    expect(recordPromptAccepted).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      directory: '/repo',
    });

    const rejectedResponse = createResponse();
    middleware(request, rejectedResponse, vi.fn());
    rejectedResponse.statusCode = 500;
    rejectedResponse.emit('finish');
    expect(recordPromptAccepted).toHaveBeenCalledOnce();
    await runtime.journal.flush();
    const records = await runtime.journal.readRecords();
    expect(records.find((record) => record.type === 'prompt')).toMatchObject({
      actor: { id: 'user-1', role: 'developer', scope: 'managed' },
      sessionID: 'ses_1',
    });
    await runtime.drain();
  });

  it('bounds oversized prompt audit bodies while retaining a hash and actor', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const middleware = runtime.promptAdmissionMiddleware();
    const response = createResponse();
    middleware({
      method: 'POST',
      principal: { id: 'user-large', role: 'developer', scope: 'managed' },
      params: { sessionID: 'ses_large' },
      query: { directory: '/projects/project/developer' },
      headers: {},
      body: { parts: [{ type: 'text', text: 'x'.repeat(70 * 1024) }] },
    }, response, vi.fn());
    await runtime.journal.flush();

    const prompt = (await runtime.journal.readRecords()).find((record) => record.type === 'prompt');
    expect(prompt.actor).toEqual({ id: 'user-large', role: 'developer', scope: 'managed' });
    expect(prompt.payload.body).toMatchObject({
      truncated: true,
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(prompt.payload.body.size).toBeGreaterThan(64 * 1024);
    await runtime.drain();
  });

  it('records small prompt bodies verbatim without truncation metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const middleware = runtime.promptAdmissionMiddleware();
    const body = { parts: [{ type: 'text', text: 'small prompt' }] };
    middleware({
      method: 'POST',
      principal: { id: 'user-small', role: 'developer', scope: 'managed' },
      params: { sessionID: 'ses_small' },
      query: { directory: '/repo' },
      headers: {},
      body,
    }, createResponse(), vi.fn());
    await runtime.journal.flush();

    const prompt = (await runtime.journal.readRecords()).find((record) => record.type === 'prompt');
    expect(prompt.payload.body).toEqual(body);
    expect(prompt.payload.body.truncated).toBeUndefined();
    await runtime.drain();
  });
});

describe('web harness control journal', () => {
  it('records aborts with a sanitized source attribution', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const abortRequest = (sessionID, headers) => ({
      method: 'POST',
      path: '/abort',
      principal: { id: 'user-1', role: 'admin', scope: 'local-admin' },
      params: { sessionID },
      query: { directory: '/repo' },
      headers,
      body: {},
    });
    const next = vi.fn();
    runtime.controlJournalMiddleware(abortRequest('ses_esc', { 'x-devryan-abort-source': 'double_escape' }), createResponse(), next);
    runtime.controlJournalMiddleware(abortRequest('ses_forged', { 'x-devryan-abort-source': 'rm -rf' }), createResponse(), next);
    runtime.controlJournalMiddleware(abortRequest('ses_none', {}), createResponse(), next);
    runtime.controlJournalMiddleware({
      ...abortRequest('ses_revert', { 'x-devryan-abort-source': 'revert' }),
      path: '/revert',
    }, createResponse(), next);
    expect(next).toHaveBeenCalledTimes(4);
    await runtime.journal.flush();

    const controls = (await runtime.journal.readRecords()).filter((record) => record.type === 'control');
    const bySession = Object.fromEntries(controls.map((record) => [record.sessionID, record]));
    expect(bySession.ses_esc).toMatchObject({ action: 'abort', payload: { source: 'double_escape' } });
    expect(bySession.ses_forged).toMatchObject({ action: 'abort', payload: { source: 'unknown' } });
    expect(bySession.ses_none).toMatchObject({ action: 'abort', payload: { source: 'unknown' } });
    expect(bySession.ses_revert.action).toBe('revert');
    expect('source' in bySession.ses_revert.payload).toBe(false);
    await runtime.drain();
  });
});

describe('web harness abort source attribution', () => {
  it('keeps an accepted abort source until the next accepted prompt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const abort = (sessionID, source) => ({
      method: 'POST', path: '/abort', params: { sessionID }, query: { directory: '/repo' },
      headers: source ? { 'x-devryan-abort-source': source } : {}, body: {},
    });
    const next = vi.fn();
    const accepted = createResponse();
    runtime.controlJournalMiddleware(abort('ses_retry', 'provider_retry'), accepted, next);
    expect(runtime.readAbortSource('ses_retry')).toBe('provider_retry');
    accepted.emit('finish');
    expect(runtime.readAbortSource('ses_retry')).toBe('provider_retry');

    const rejected = createResponse();
    runtime.controlJournalMiddleware(abort('ses_rejected', 'stall_watchdog'), rejected, next);
    rejected.statusCode = 409;
    rejected.emit('finish');
    expect(runtime.readAbortSource('ses_rejected')).toBeNull();

    runtime.controlJournalMiddleware(abort('ses_retry'), createResponse(), next);
    expect(runtime.readAbortSource('ses_retry')).toBeNull();

    runtime.controlJournalMiddleware(abort('ses_retry', 'abort_guard'), createResponse(), next);
    const prompt = createResponse();
    runtime.promptAdmissionMiddleware()({
      method: 'POST', params: { sessionID: 'ses_retry' }, query: { directory: '/repo' }, headers: {}, body: {},
    }, prompt, next);
    expect(runtime.readAbortSource('ses_retry')).toBe('abort_guard');
    prompt.emit('finish');
    expect(runtime.readAbortSource('ses_retry')).toBeNull();
    await runtime.drain();
  });
});

describe('web harness control observer', () => {
  it('hands accepted session controls to the server observer without letting it block the request', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const observed = [];
    runtime.setControlObserver((input) => {
      observed.push(input);
      throw new Error('observer failure is advisory');
    });
    const request = (action, method = 'POST') => ({
      method,
      path: `/${action}`,
      principal: { id: 'user-1', role: 'admin', scope: 'local-admin' },
      params: { sessionID: 'ses_child' },
      query: { directory: '/repo' },
      headers: { 'x-devryan-abort-source': 'stop_button' },
      body: {},
    });
    const next = vi.fn();
    const response = createResponse();
    runtime.controlJournalMiddleware(request('abort'), response, next);
    runtime.controlJournalMiddleware(request('revert'), createResponse(), next);
    runtime.controlJournalMiddleware(request('abort', 'GET'), createResponse(), next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(observed.map(({ action, sessionID, directory: dir, source }) => [action, sessionID, dir, source])).toEqual([
      ['abort', 'ses_child', '/repo', 'stop_button'],
      ['revert', 'ses_child', '/repo', null],
    ]);
    expect(observed[0].res).toBe(response);
    await runtime.drain();
  });

  it('journals a primary Stop that primary recovery answers locally, exactly once', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const express = (await import('express')).default;
    const request = (await import('../../test-supertest.js')).default;
    const app = express();
    // Mirrors the server's order: the journal precedes primary recovery, which
    // answers a primary abort itself and never calls next().
    app.use('/api/session/:sessionID', express.json(), runtime.controlJournalMiddleware,
      (req, res, next) => (req.path === '/abort' ? res.status(200).json(true) : next()));
    await request(app).post('/api/session/ses_primary/abort?directory=%2Frepo')
      .set('X-DevRyan-Abort-Source', 'stop_button').send({}).expect(200);
    await runtime.journal.flush();
    const controls = (await runtime.journal.readRecords()).filter((record) => record.type === 'control');
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ sessionID: 'ses_primary', action: 'abort', payload: { source: 'stop_button' } });
    await runtime.drain();
  });
});

describe('web harness session execution diagnostics', () => {
  it('journals execution and revert diagnostics with the production lifecycle mapping', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    expect(runtime.recordSessionExecution({ event: 'session_execution', sessionID: 'ses_exec', phase: 'finish', state: 'completed' })).toBe(true);
    expect(runtime.recordSessionExecution({ event: 'session_revert', sessionID: 'ses_revert', phase: 'recovery_failed' })).toBe(true);
    expect(runtime.recordSessionExecution({ event: 'other', phase: 'unattributed' })).toBe(true);
    await runtime.journal.flush();
    const rows = (await runtime.journal.readRecords()).filter((record) => record.type === 'lifecycle');
    const bySession = Object.fromEntries(rows.map((record) => [record.sessionID ?? 'runtime', record]));
    expect(bySession.ses_exec).toMatchObject({ event: 'session_execution', runtime: 'test', payload: { phase: 'finish', state: 'completed' } });
    expect(bySession.ses_revert).toMatchObject({ event: 'session_revert', payload: { phase: 'recovery_failed' } });
    expect(bySession.runtime).toMatchObject({ event: 'session_revert', payload: { phase: 'unattributed' } });
    await runtime.drain();
    expect(runtime.recordSessionExecution({ event: 'session_execution', sessionID: 'ses_late' })).toBe(false);
  });
});


it('awaits mandatory control preparation and fails closed while observers remain advisory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-control-prepare-'));
  temporaryDirectories.push(directory);
  const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
  const request = { method: 'POST', path: '/abort', params: { sessionID: 'ses_child' }, query: { directory: '/repo' }, headers: { 'x-devryan-abort-source': 'stop_button' } };
  const next = vi.fn(), order = [];
  runtime.setControlPreparation(async input => { await Promise.resolve(); order.push(['durable', input.directory]); });
  runtime.setControlObserver(() => { order.push(['observer']); throw new Error('advisory'); });
  const accepted = runtime.controlJournalMiddleware(request, createResponse(), () => { order.push(['forward']); next(); });
  expect(next).not.toHaveBeenCalled();
  await accepted;
  expect(order).toEqual([['durable', '/repo'], ['observer'], ['forward']]);
  runtime.setControlPreparation(async () => { throw new Error('private failure'); });
  const rejected = createResponse();
  await runtime.controlJournalMiddleware(request, rejected, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(rejected.statusCode).toBe(503);
  expect(rejected.body).toEqual({ code: 'control_preparation_failed', error: 'Control request could not be prepared' });
  await runtime.drain();
});
