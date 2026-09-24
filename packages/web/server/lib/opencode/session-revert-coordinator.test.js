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

it('refuses the legacy revert path for ledger-owned conversations when no coordinator is available', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-legacy-guard-')); roots.push(root);
  const directory = await fs.realpath(root); const project = path.join(directory, 'project'); await fs.mkdir(project);
  await git(project, ['init', '--quiet']); await fs.writeFile(path.join(project, 'x'), 'a=1');
  const runtime = createSessionMutationRuntime({ directory: path.join(directory, 'ledger') });
  // No ledger exists yet: nothing is owned and the lookup must not create one.
  expect(await runtime.capturedSessionState({ directory: project, sessionID: 'a' })).toEqual({ captured: false, pending: false });
  await expect(fs.readdir(path.join(directory, 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
  const a = await runtime.begin({ directory: project, sessionID: 'a', userMessageID: 'pa', messageID: 'ma', callID: 'ca' });
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=2');
  await runtime.finish({ directory: project, token: a.token });
  expect(await runtime.capturedSessionState({ directory: project, sessionID: 'a' })).toEqual({ captured: true, pending: false });
  expect(await runtime.capturedSessionState({ directory: project, sessionID: 'legacy' })).toEqual({ captured: false, pending: false });

  const guarded = [];
  const assertLegacyRevertAllowed = async (input) => {
    guarded.push(input.sessionID);
    const state = await runtime.capturedSessionState(input);
    if (state.captured) throw Object.assign(new Error('owned by the companion'), { code: 'mutation_history_captured' });
  };
  const app = express(); registerScopedSessionRevertRoute(app, { assertLegacyRevertAllowed });
  const base = await listen(app);
  for (const [route, body] of [['scoped-revert', { messageID: 'pa' }], ['scoped-unrevert', {}]]) {
    const response = await fetch(`${base}/api/openchamber/session/a/${route}?directory=${encodeURIComponent(project)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('mutation_history_captured');
  }
  expect(guarded).toEqual(['a', 'a']);
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=2');
}, 60_000);

it('adopts Revert and Redo for a conversation that ran without the companion, never overwriting newer bytes', async () => {
  const { createSessionChangeRuntime } = await import('../../../../harness-runtime/lib/session-changes.js');
  const { finishFixtureMutation } = await import('../../../../harness-runtime/test/session-change-fixture.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-legacy-adopt-')); roots.push(root);
  const directory = await fs.realpath(root); const project = path.join(directory, 'project'); await fs.mkdir(project);
  await git(project, ['init', '--quiet']); await git(project, ['config', 'user.email', 't@example.invalid']); await git(project, ['config', 'user.name', 'T']);
  await fs.writeFile(path.join(project, 'x'), 'a=1\n'); await fs.writeFile(path.join(project, 'y'), 'b=1\n');
  await git(project, ['add', '.']); await git(project, ['commit', '-qm', 'base']);
  const changeStorage = path.join(directory, 'changes');
  const changes = createSessionChangeRuntime({ directory: changeStorage });
  const runtime = createSessionMutationRuntime({ directory: path.join(directory, 'ledger') });
  // The legacy conversation edits x and y while no companion runs.
  const created = Date.now() - 1; let call = 0;
  for (const [file, text] of [['x', 'a=2\n'], ['y', 'b=2\n']]) {
    const op = { directory: project, sessionID: 'L', messageID: 'mL', userMessageID: 'pL', callID: `c${++call}` };
    await changes.begin(op); await fs.writeFile(path.join(project, file), text); await finishFixtureMutation(changes, op, changeStorage);
  }
  let session = { id: 'L', directory: project };
  const native = express(); native.use(express.json());
  native.get('/session/revert-capabilities', (_req, res) => res.json({ legacyConversationRevert: 1 }));
  native.get('/session/L', (_req, res) => res.json(session));
  native.get('/session/L/children', (_req, res) => res.json([]));
  native.get('/session/L/message/pL', (_req, res) => res.json({ info: { id: 'pL', role: 'user', time: { created } }, parts: [] }));
  native.post('/session/L/revert', (req, res) => {
    expect(req.body.files).toBe(false); session = { ...session, revert: { messageID: req.body.messageID, fileRestore: false } }; res.json(session);
  });
  native.post('/session/L/unrevert', (_req, res) => { session = { id: 'L', directory: project }; res.json(session); });
  const upstream = await listen(native); const cancellations = [];
  const coordinator = createScopedRevertCoordinator({ runtime, openchamberDataDir: directory, buildOpenCodeUrl: (route) => upstream + route,
    legacy: { history: (input) => changes.legacyHistory(input), blob: (input) => changes.legacyBlob(input) },
    executions: { isConfined: async () => true, cancelAndWait: async ({ sessions }) => { cancellations.push(sessions); return { terminated: true, sessions }; } } });
  const app = express(); registerScopedSessionRevertRoute(app, { sessionRevertCoordinator: coordinator });
  const base = await listen(app);
  const post = (route, body) => fetch(`${base}/api/openchamber/session/L/${route}?directory=${encodeURIComponent(project)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Another writer changed y after the legacy conversation: y is a conflict, x reverts.
  await fs.writeFile(path.join(project, 'y'), 'b=3\n');
  const response = await post('scoped-revert', { messageID: 'pL' }); const reverted = await response.json();
  expect(response.status).toBe(200);
  expect(reverted.reverted.files).toEqual([{ path: 'x', status: 'modified' }]);
  expect(reverted).toMatchObject({ outcome: 'partial', conflicts: [{ path: 'y' }], redoAvailable: true });
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=1\n');
  expect(await fs.readFile(path.join(project, 'y'), 'utf8')).toBe('b=3\n');
  expect(session.revert).toEqual({ messageID: 'pL', fileRestore: false });
  expect(cancellations).toEqual([['L']]);

  const redo = await post('scoped-unrevert', {}); const restored = await redo.json();
  expect(redo.status).toBe(200);
  expect(restored.restored).toEqual([{ path: 'x', status: 'modified' }]);
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=2\n');
  expect(await fs.readFile(path.join(project, 'y'), 'utf8')).toBe('b=3\n');
  expect(session.revert).toBeUndefined();
  // Redo is single-use.
  expect((await post('scoped-unrevert', {})).status).toBe(409);

  // A crash after the conversation marker but before files resumes forward.
  expect((await post('scoped-revert', { messageID: 'pL' })).status).toBe(200);
  const { changeKey } = await import('../../../../harness-runtime/lib/session-changes-store.js');
  const record = path.join(directory, 'harness', 'revert-transactions', changeKey(await runtime.projectDirectory({ directory: project })), 'legacy', `${changeKey('L')}.json`);
  const committed = JSON.parse(await fs.readFile(record, 'utf8'));
  await fs.writeFile(record, JSON.stringify({ ...committed, phase: 'files', result: null }));
  await fs.writeFile(path.join(project, 'x'), 'a=2\n');
  await coordinator.recover({ directory: project });
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=1\n');
  expect(JSON.parse(await fs.readFile(record, 'utf8')).phase).toBe('committed');
  await changes.drain();
}, 90_000);
