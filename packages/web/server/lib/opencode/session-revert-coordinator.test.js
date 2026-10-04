import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { git } from '../../../../harness-runtime/lib/session-changes-git.js';
import { registerScopedSessionRevertRoute } from './session-scoped-revert.js';
import { createNativeRevertConversation, createScopedRevertConversation, createScopedRevertCoordinator } from './session-revert-coordinator.js';

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
  const client = { generation: () => 2, sessions: { get: async () => session } };
  const nativeConversation = createNativeRevertConversation({ openCodeClient: client, isReady: async () => true,
    privilegedClient: { revert: {
      stage: async (_id, body) => { expect(body.files).toBe(false); session = { ...session, revert: { messageID: body.messageID, files: [] } }; },
      clear: async () => { session = { id: 'a', directory: project }; },
    } }, admissionOwner: { withRevertOperation: async (_input, action) => action(), releaseTransactionHolds: async () => {}, recoverTransactionHolds: async () => {} } });
  const cancellations = [];
  const coordinator = createScopedRevertCoordinator({ runtime, openchamberDataDir: directory, openCodeClient: client, nativeConversation,
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
  expect(await runtime.capturedSessionState({ directory: project, sessionID: 'a' })).toEqual({ captured: true, pending: false, generation: 0 });
  expect(await runtime.capturedSessionState({ directory: project, sessionID: 'legacy' })).toEqual({ captured: false, pending: false });

  const guarded = [];
  const assertLegacyRevertAllowed = async (input) => {
    guarded.push(input.sessionID);
    const state = await runtime.capturedSessionState(input);
    if (state.captured) throw Object.assign(new Error('owned by the companion'), { code: 'mutation_history_captured' });
  };
  const app = express(); registerScopedSessionRevertRoute(app, { openCodeClient: { generation: () => 2 }, assertLegacyRevertAllowed });
  const base = await listen(app);
  for (const [route, body] of [['scoped-revert', { messageID: 'pa' }], ['scoped-unrevert', {}]]) {
    const response = await fetch(`${base}/api/openchamber/session/a/${route}?directory=${encodeURIComponent(project)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('capability_absent');
  }
  expect(guarded).toEqual([]);
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=2');
}, 60_000);

it('keeps imported receipt history inspectable but refuses mutation without a native ledger transaction', async () => {
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
  const client = { generation: () => 2, sessions: { get: async () => session, children: async () => [],
    message: async () => ({ info: { id: 'pL', role: 'user', time: { created } }, parts: [] }) } };
  const nativeConversation = createNativeRevertConversation({ openCodeClient: client, isReady: async () => true,
    privilegedClient: { revert: {
      stage: async (_id, body) => { expect(body.files).toBe(false); session = { ...session, revert: { messageID: body.messageID, files: [] } }; },
      clear: async () => { session = { id: 'L', directory: project }; },
    } }, admissionOwner: { withRevertOperation: async (_input, action) => action(), releaseTransactionHolds: async () => {}, recoverTransactionHolds: async () => {} } });
  const cancellations = [];
  const coordinator = createScopedRevertCoordinator({ runtime, openchamberDataDir: directory, openCodeClient: client, nativeConversation,
    legacy: { history: (input) => changes.legacyHistory(input), blob: (input) => changes.legacyBlob(input) },
    executions: { isConfined: async () => true, cancelAndWait: async ({ sessions }) => { cancellations.push(sessions); return { terminated: true, sessions }; } } });
  const app = express(); registerScopedSessionRevertRoute(app, { sessionRevertCoordinator: coordinator });
  const base = await listen(app);
  const post = (route, body) => fetch(`${base}/api/openchamber/session/L/${route}?directory=${encodeURIComponent(project)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Imported receipts remain readable, but have no native ledger transaction.
  const imported = await changes.legacyHistory({ directory: project, sessionIDs: ['L'], since: created });
  expect(imported.map(file => file.path).sort()).toEqual(['x', 'y']);
  const before = await Promise.all(['x', 'y'].map(file => fs.readFile(path.join(project, file), 'utf8')));
  const response = await post('scoped-revert', { messageID: 'pL' });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('mutation_history_unavailable');
  expect(await Promise.all(['x', 'y'].map(file => fs.readFile(path.join(project, file), 'utf8')))).toEqual(before);
  expect(session.revert).toBeUndefined(); expect(cancellations).toEqual([]);
  await changes.drain();
}, 90_000);

// ---------------------------------------------------------------------------
// Generation 2 (DESIGN.md E item 13c): reads go through `openCodeClient`; the
// companion's conversation revert is a typed absence until the Phase 3 coordinator.

const createFakeClient = (generation = 2) => {
  const calls = [];
  const record = (op) => vi.fn(async (...args) => { calls.push([op, ...args]); return op === 'children' ? [{ id: 'child' }] : { id: args[0], op }; });
  return { calls, generation: () => generation, sessions: { get: record('get'), children: record('children'), message: record('message') } };
};

it('reads the conversation through the client on generation 2 and reports revert as capability absent', async () => {
  const client = createFakeClient();
  const fetchImpl = vi.fn(async () => { throw new Error('unexpected raw fetch'); });
  const conversation = createScopedRevertConversation({ buildOpenCodeUrl: (route) => `http://opencode.test${route}`, fetchImpl, openCodeClient: client });

  expect(await conversation.capabilities({ directory: '/repo' })).toEqual({ capability_absent: true, capability: 'conversation_revert', generation: 2 });
  expect(await conversation.get({ directory: '/repo', sessionID: 'ses_a' })).toEqual({ id: 'ses_a', op: 'get' });
  expect(await conversation.children({ directory: '/repo', sessionID: 'ses_a' })).toEqual([{ id: 'child' }]);
  expect(await conversation.message({ directory: '/repo', sessionID: 'ses_a', messageID: 'msg_1' })).toEqual({ id: 'ses_a', op: 'message' });
  expect(client.calls).toEqual([
    ['get', 'ses_a', { timeoutMs: 15_000, directory: '/repo' }],
    ['children', 'ses_a', { timeoutMs: 15_000, directory: '/repo' }],
    ['message', 'ses_a', 'msg_1', { timeoutMs: 15_000, directory: '/repo' }],
  ]);
  for (const action of ['revert', 'unrevert']) {
    await expect(conversation[action]({ directory: '/repo', sessionID: 'ses_a', messageID: 'msg_1' }))
      .rejects.toMatchObject({ code: 'capability_absent', status: 409, capability: 'conversation_revert', generation: 2 });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('maps generation-2 read failures to the rollback failure and rejects a malformed tree', async () => {
  const client = createFakeClient();
  client.sessions.get = vi.fn(async () => { throw Object.assign(new Error('gone'), { statusCode: 404, code: 'opencode_not_found' }); });
  client.sessions.children = vi.fn(async () => null);
  const conversation = createScopedRevertConversation({ buildOpenCodeUrl: (route) => route, openCodeClient: client });
  await expect(conversation.get({ directory: '/repo', sessionID: 'ses_a' })).rejects.toMatchObject({ code: 'conversation_rollback_failed', status: 404 });
  await expect(conversation.children({ directory: '/repo', sessionID: 'ses_a' })).rejects.toMatchObject({ code: 'invalid_session_tree', status: 503 });
});

it('uses native conversation-only staging and clear under an exact ledger capability', async () => {
  let session = { id: 'ses_a', directory: '/repo' }, ready = true;
  const calls = [];
  const client = createFakeClient(); client.sessions.get = async () => session;
  const conversation = createNativeRevertConversation({ openCodeClient: client, isReady: async () => ready,
    privilegedClient: { revert: {
      stage: async (sessionID, input) => { calls.push(['stage', sessionID, input]); session = { ...session, revert: { messageID: input.messageID, files: [] } }; },
      clear: async sessionID => { calls.push(['clear', sessionID]); session = { id: 'ses_a', directory: '/repo' }; },
    } }, admissionOwner: { withRevertOperation: async (input, action) => { calls.push(['permit', input]); return action(); } } });
  const scope = { sessionID: 'ses_a', directory: '/repo', transactionID: 'tx_1' };
  expect(await conversation.capabilities()).toEqual({ conversationOnlyRevert: 1 });
  expect(await conversation.revert({ ...scope, messageID: 'msg_a', files: false })).toMatchObject({ revert: { messageID: 'msg_a', fileRestore: false } });
  expect(calls[0]).toEqual(['permit', { ...scope, messageID: 'msg_a', files: false, operation: 'session.revert.stage' }]);
  expect(calls[1]).toEqual(['stage', 'ses_a', { messageID: 'msg_a', files: false }]);
  expect(await conversation.unrevert(scope)).not.toHaveProperty('revert');
  session.revert = { messageID: 'old', snapshot: 'native_snapshot', files: [] };
  await expect(conversation.unrevert(scope)).rejects.toMatchObject({ code: 'conversation_rollback_failed' });
  expect(calls).toHaveLength(4);
  ready = false;
  await expect(conversation.revert({ ...scope, messageID: 'msg_a', files: false })).rejects.toMatchObject({ code: 'capability_absent' });
});

it.each([undefined, {}, createFakeClient(1), createFakeClient(3)])('refuses unsupported conversation identity before any transport: %j', async openCodeClient => {
  const fetchImpl = vi.fn(); const conversation = createScopedRevertConversation({ fetchImpl, openCodeClient });
  await expect(conversation.capabilities({ directory: '/repo' })).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('refuses Revert and Redo on generation 2 before any conversation or file mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-v2-revert-')); roots.push(root);
  const directory = await fs.realpath(root); const project = path.join(directory, 'project'); await fs.mkdir(project);
  await git(project, ['init', '--quiet']); await fs.writeFile(path.join(project, 'x'), 'a=1');
  const runtime = createSessionMutationRuntime({ directory: path.join(directory, 'ledger') });
  const client = createFakeClient();
  const cancellations = [];
  const coordinator = createScopedRevertCoordinator({ runtime, openchamberDataDir: directory, openCodeClient: client,
    buildOpenCodeUrl: () => { throw new Error('unexpected raw request'); },
    executions: { isConfined: async () => true, cancelAndWait: async ({ sessions }) => { cancellations.push(sessions); return { terminated: true, sessions }; } } });
  const app = express(); registerScopedSessionRevertRoute(app, { sessionRevertCoordinator: coordinator });
  const base = await listen(app);
  for (const [route, body] of [['scoped-revert', { messageID: 'msg_1' }], ['scoped-unrevert', {}]]) {
    const response = await fetch(`${base}/api/openchamber/session/ses_a/${route}?directory=${encodeURIComponent(project)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('mutation_runtime_unsupported');
  }
  expect(client.calls).toEqual([]);
  expect(cancellations).toEqual([]);
  expect(await fs.readFile(path.join(project, 'x'), 'utf8')).toBe('a=1');
}, 60_000);
