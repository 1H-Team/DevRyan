import express from 'express';
import { expect, test, vi } from 'vitest';
import request from '../../test-supertest.js';
import { createClaudeUpdateController, registerClaudeUpdateRoutes } from './claude-update-routes.js';

function fixture({ administrator = true, supported = true } = {}) {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const lifecycle = { inspect: async () => ({ revision: 7, state: 'ready', restartRequired: false, rollbackAvailable: true }),
    upgradeClaude: vi.fn(() => pending), rollback: vi.fn(() => pending), recompose: vi.fn(async () => {}) };
  const controller = createClaudeUpdateController({ lifecycle, supported }), app = express();
  registerClaudeUpdateRoutes(app, { controller, isAdministrator: () => administrator });
  return { app, controller, lifecycle, finish };
}
test('About update routes require administrator and CSRF without invoking lifecycle', async () => {
  const unauthorized = fixture({ administrator: false });
  await request(unauthorized.app).get('/api/config/claude-update').expect(403);
  await request(unauthorized.app).post('/api/config/claude-update/install').send({ expectedRevision: 7 }).expect(403);
  expect(unauthorized.lifecycle.upgradeClaude).not.toHaveBeenCalled();
  const f = fixture();
  await request(f.app).post('/api/config/claude-update/install').send({ expectedRevision: 7 }).expect(403);
  expect(f.lifecycle.upgradeClaude).not.toHaveBeenCalled();
});
test('one host operation survives its HTTP response and rejects concurrent requests', async () => {
  const f = fixture();
  const response = await request(f.app).post('/api/config/claude-update/install').set('x-devryan-csrf', '1').send({ expectedRevision: 7 }).expect(202);
  expect(response.body.busy).toBe(true);
  f.controller.setPhase('waiting-for-idle');
  expect((await request(f.app).get('/api/config/claude-update').expect(200)).body.phase).toBe('waiting-for-idle');
  await request(f.app).post('/api/config/claude-update/rollback').set('x-devryan-csrf', '1').send({ expectedRevision: 7 }).expect(409);
  f.finish({ restartAvailable: true }); await f.controller.settled();
  expect(f.lifecycle.upgradeClaude).toHaveBeenCalledWith({ expectedRevision: 7 });
  expect(f.lifecycle.recompose).toHaveBeenCalledTimes(1);
});
test('paths, URLs and non-integer revisions are not accepted from clients', async () => {
  const f = fixture();
  for (const input of [{ expectedRevision: 7, url: 'https://evil.test' }, { expectedRevision: '7' }, null]) {
    await request(f.app).post('/api/config/claude-update/install').set('x-devryan-csrf', '1').send(input).expect(409);
  }
  expect(f.lifecycle.upgradeClaude).not.toHaveBeenCalled();
});
test('failure is finite and retryable; unsupported platforms cannot mutate', async () => {
  const f = fixture();
  f.lifecycle.upgradeClaude.mockRejectedValueOnce(Object.assign(new Error('private detail'), { code: 'bundle_selection_revision_conflict' }));
  await f.controller.start('install', { expectedRevision: 6 }); await f.controller.settled();
  expect(await f.controller.inspect()).toMatchObject({ phase: 'failed', busy: false, reason: 'bundle_selection_revision_conflict' });
  const unsupported = fixture({ supported: false });
  await request(unsupported.app).post('/api/config/claude-update/install').set('x-devryan-csrf', '1').send({ expectedRevision: 7 }).expect(409);
});
