import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { git } from '../../../../harness-runtime/lib/session-changes-git.js';
import { registerScopedSessionRevertRoute } from './session-scoped-revert.js';
import { createScopedRevertCoordinator } from './session-revert-coordinator.js';

const roots = [], servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const listen = async (app) => {
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  servers.push(server); return `http://127.0.0.1:${server.address().port}`;
};

it('serves concurrent Revert and Redo through the existing HTTP envelopes without consulting foreign activity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-concurrent-route-')); roots.push(root);
  const directory = await fs.realpath(root); const project = path.join(directory, 'project'); await fs.mkdir(project);
  await git(project, ['init', '--quiet']); await fs.writeFile(path.join(project, 'x'), 'a=1; b=2');
  const runtime = createSessionMutationRuntime({ directory: path.join(directory, 'ledger') });
  const begin = (id) => runtime.begin({ directory: project, sessionID: id, userMessageID: `p${id}`, messageID: `m${id}`, callID: `c${id}` });
  const a = await begin('a'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3; b=2');
  await runtime.finish({ directory: project, token: a.token });
  const b = await begin('b'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=3; b=4');
  let session = { id: 'a', directory: project }; let statusReads = 0;
  const native = express(); native.use(express.json());
  native.get('/session/revert-capabilities', (_req, res) => res.json({ legacyConversationRevert: 1 }));
  native.get('/session/status', (_req, res) => { statusReads++; res.json({ b: { type: 'busy' } }); });
  native.get('/session/a', (_req, res) => res.json(session));
  native.post('/session/a/revert', (req, res) => {
    expect(req.body.files).toBe(false); session = { ...session, revert: { messageID: req.body.messageID, fileRestore: false } }; res.json(session);
  });
  native.post('/session/a/unrevert', (_req, res) => { session = { id: 'a', directory: project }; res.json(session); });
  const upstream = await listen(native); const cancellations = [];
  const coordinator = createScopedRevertCoordinator({ runtime, openchamberDataDir: directory, buildOpenCodeUrl: (route) => upstream + route,
    executions: { isConfined: async () => true, cancelAndWait: async ({ sessions }) => {
      cancellations.push(sessions); return { terminated: true, sessions };
    } } });
  const app = express(); registerScopedSessionRevertRoute(app, { sessionRevertCoordinator: coordinator });
  const base = await listen(app);
  const post = (route, body) => fetch(`${base}/api/openchamber/session/a/${route}?directory=${encodeURIComponent(project)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await post('scoped-revert', { messageID: 'pa' }); const reverted = await response.json();
  expect(response.status).toBe(200); expect(reverted.verification.ok).toBe(true); expect(reverted.redoAvailable).toBe(true);
  expect(reverted.reverted.files).toEqual([{ path: 'x', status: 'modified' }]); expect(statusReads).toBe(0);
  expect(cancellations).toEqual([['a']]);
  await runtime.finish({ directory: project, token: b.token });
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=1; b=4');
  const redo = await post('scoped-unrevert', {}); const restored = await redo.json();
  expect(redo.status).toBe(200); expect(restored.restored).toEqual([{ path: 'x', status: 'modified' }]);
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=3; b=4');
}, 60_000);
