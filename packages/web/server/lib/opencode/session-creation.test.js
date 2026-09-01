import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import path from 'node:path';
import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';
import { registerOpenCodeProxy } from './proxy.js';
import { beginSessionCreationTrace } from './session-creation.js';

const servers = [];
const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});
const proxy = (url, { ready = true, records = [], intercept, preparationMs = 0 } = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', (req, _res, next) => { beginSessionCreationTrace(req, (record) => records.push(record)); next(); });
  if (preparationMs) app.use('/api/session', (_req, _res, next) => setTimeout(next, preparationMs));
  if (intercept) app.post('/api/session', intercept);
  registerOpenCodeProxy(app, { fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: Number(new URL(url).port), isOpenCodeReady: ready,
      openCodeNotReadySince: 0, isRestartingOpenCode: !ready }),
    buildOpenCodeUrl: (requestPath) => url + requestPath, getOpenCodeAuthHeaders: () => ({}), ensureOpenCodeApiPrefix: () => {} });
  return app;
};
const create = (url, extraHeaders = {}) => fetch(url + '/api/session?directory=%2Fsynthetic', {
  method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify({ title: 'private title' }),
});

describe('session creation route contract', () => {
  it('does not dispatch when local preparation consumed the remaining creation budget', async () => {
    let calls = 0;
    const upstream = express();
    upstream.post('/session', (_req, res) => { calls++; res.json({ id: 'ses_bad' }); });
    const url = await listen(proxy(await listen(upstream), { preparationMs: 20 }));
    const response = await create(url, { 'x-devryan-creation-budget-ms': '1' });
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: 'session_create_not_dispatched', retryable: false });
    expect(calls).toBe(0);
  });
  it('preserves successful payloads, directory scope, and content-free attempt timing', async () => {
    const upstream = express();
    upstream.use(express.json());
    let calls = 0;
    upstream.post('/session', (req, res) => {
      calls++;
      expect(req.query.directory).toBe('/synthetic');
      expect(req.body.title).toBe('private title');
      res.status(200).json({ id: 'ses_confirmed', title: req.body.title, directory: '/synthetic' });
    });
    const records = [];
    const url = await listen(proxy(await listen(upstream), { records }));
    const attemptId = 'b3973915-8eb4-4880-a7a2-a6ccad72e3d5';
    const response = await create(url, { 'x-devryan-creation-attempt': attemptId });
    expect(await response.json()).toEqual({ id: 'ses_confirmed', title: 'private title', directory: '/synthetic' });
    expect(calls).toBe(1);
    expect(records.map((record) => record.mark)).toEqual(['session.creation.request_received', 'session.creation.upstream_create_started', 'session.creation.acknowledged']);
    expect(records.every((record) => record.payload.operationID === attemptId)).toBe(true);
    const sanitizer = createDiagnosticSanitizer();
    expect(records.map((record) => sanitizer.sanitizeRecord({ ...record, at: 1 }))).toEqual(records.map((record) => ({ ...record, at: 1 })));
    expect(JSON.stringify(records)).not.toContain('private title');
    expect(JSON.stringify(records)).not.toContain('/synthetic');
  });
  it('rejects a known restart before any upstream mutation', async () => {
    let calls = 0;
    const upstream = express();
    upstream.post('/session', (_req, res) => { calls++; res.json({ id: 'ses_bad' }); });
    const response = await create(await listen(proxy(await listen(upstream), { ready: false })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'session_create_restart_rejected', retryable: true });
    expect(calls).toBe(0);
  });
  it.each(['reset', '5xx', 'timeout'])('never retries an ambiguous %s after dispatch', async (failure) => {
    let calls = 0;
    const upstream = express();
    upstream.post('/session', (req, res) => {
      calls++;
      if (failure === 'reset') req.socket.destroy();
      if (failure === '5xx') res.status(503).json({ retryable: true });
      // Timeout deliberately leaves the disposable connection pending.
    });
    const url = await listen(proxy(await listen(upstream)));
    const response = await create(url, { 'x-devryan-creation-budget-ms': '40' });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.json()).toMatchObject({ code: 'session_create_outcome_unknown', retryable: false });
    expect(calls).toBe(1);
  });
  it('keeps durable ownership interception before generic creation while retaining early timing', async () => {
    const records = [];
    const url = await listen(proxy('http://127.0.0.1:1', { records, intercept: (req, res) => {
      beginSessionCreationTrace(req).mark('ownership_committed', 'ses_owned');
      res.json({ id: 'ses_owned' });
    } }));
    expect(await (await create(url)).json()).toEqual({ id: 'ses_owned' });
    expect(records.map((record) => record.mark)).toEqual(['session.creation.request_received', 'session.creation.ownership_committed']);
  });
});
