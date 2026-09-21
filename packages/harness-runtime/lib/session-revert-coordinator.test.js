import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { createSessionRevertCoordinator } from './session-revert-coordinator.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-revert-coordinator-')); roots.push(root);
  const directory = await fs.realpath(root);
  const project = path.join(directory, 'project'); await fs.mkdir(project); await git(project, ['init', '--quiet']);
  const runtime = createSessionMutationRuntime({ directory: path.join(directory, 'ledger') });
  const sessions = new Map(['a', 'b'].map((id) => [id, { id, directory: project }]));
  const calls = [], events = [];
  const conversation = {
    capabilities: async () => ({ legacyConversationRevert: 1 }),
    get: async ({ sessionID }) => sessions.get(sessionID),
    revert: async (input) => { calls.push(input); const session = { ...sessions.get(input.sessionID),
      revert: { messageID: input.messageID, fileRestore: input.files !== false } }; sessions.set(input.sessionID, session); return session; },
    unrevert: async ({ sessionID }) => { const session = { ...sessions.get(sessionID), revert: undefined }; sessions.set(sessionID, session); return session; },
  };
  const cancellations = [];
  const executions = { isConfined: async () => true, cancelAndWait: async ({ sessions }) => {
    cancellations.push(sessions); return { terminated: true, sessions };
  } };
  const create = () => createSessionRevertCoordinator({ runtime, conversation, executions,
    directory: path.join(directory, 'coordinator'), onDiagnostic: (event) => events.push(event) });
  const begin = (sessionID) => runtime.begin({ directory: project, sessionID, userMessageID: `p${sessionID}`,
    messageID: `m${sessionID}`, callID: `c${sessionID}` });
  return { directory: project, runtime, conversation, executions, sessions, calls, events, cancellations, begin, create,
    read: () => fs.readFile(path.join(project, 'x'), 'utf8'), write: (value) => fs.writeFile(path.join(project, 'x'), value) };
}

test('revert leaves a foreign execution running and merges its late result from its immutable base', async () => {
  const f = await fixture(); await f.write('a=1; b=2');
  const a = await f.begin('a'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3; b=2');
  await f.runtime.finish({ directory: f.directory, token: a.token });
  const b = await f.begin('b'); await fs.writeFile(path.join(b.viewDirectory, 'x'), 'a=3; b=4');
  const result = await f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'pa' });
  expect(result.redoAvailable).toBe(true); expect(await f.read()).toBe('a=1; b=2');
  expect(f.cancellations).toEqual([['a']]); expect(f.calls.every((call) => call.files === false)).toBe(true);
  expect(await f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'pa' })).toEqual(result);
  expect(f.cancellations).toEqual([['a']]);
  await f.runtime.finish({ directory: f.directory, token: b.token }); expect(await f.read()).toBe('a=1; b=4');
  const redone = await f.create().redo({ directory: f.directory, sessionID: 'a' }); expect(await f.read()).toBe('a=3; b=4');
  const cancellations = f.cancellations.length;
  expect(await f.create().redo({ directory: f.directory, sessionID: 'a' })).toEqual(redone);
  expect(f.cancellations).toHaveLength(cancellations);
  await f.runtime.registerPrompt({ directory: f.directory, sessionID: 'a', userMessageID: 'new-prompt' });
  await expect(f.create().redo({ directory: f.directory, sessionID: 'a' })).rejects.toMatchObject({ code: 'redo_unavailable' });
  expect(f.events.some((event) => event.phase === 'committed' && event.transactionID)).toBe(true);
}, 60_000);

test('Revert and Redo preserve explicit partial publication conflicts in the host response', async () => {
  const f = await fixture(); await f.write(Buffer.from([0, 1]));
  const a = await f.begin('a'), b = await f.begin('b');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), Buffer.from([0, 2]));
  await fs.writeFile(path.join(b.viewDirectory, 'x'), Buffer.from([0, 3]));
  await f.runtime.finish({ directory: f.directory, token: a.token });
  await f.runtime.finish({ directory: f.directory, token: b.token });
  const coordinator = f.create();
  expect(await coordinator.revert({ directory: f.directory, sessionID: 'b', messageID: 'pb' }))
    .toMatchObject({ outcome: 'partial', conflicts: [{ path: 'x' }] });
  expect(await coordinator.redo({ directory: f.directory, sessionID: 'b' }))
    .toMatchObject({ outcome: 'partial', conflicts: [{ path: 'x' }] });
  expect(await fs.readFile(path.join(f.directory, 'x'))).toEqual(Buffer.from([0, 2]));
}, 60_000);

test('cancellation acceptance without authoritative termination cannot change files or conversation', async () => {
  const f = await fixture(); await f.write('before');
  const a = await f.begin('a'); await fs.writeFile(path.join(a.viewDirectory, 'x'), 'after');
  f.executions.cancelAndWait = async () => ({ accepted: true });
  await expect(f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'pa' }))
    .rejects.toMatchObject({ code: 'mutation_cancellation_failed' });
  expect(f.calls).toHaveLength(0); expect(await f.read()).toBe('before');
  await expect(f.runtime.finish({ directory: f.directory, token: a.token })).rejects.toMatchObject({ code: 'execution_reverted' });
  f.executions.cancelAndWait = async ({ sessions }) => ({ terminated: true, sessions });
  await f.create().recover({ directory: f.directory }); expect(f.sessions.get('a').revert.messageID).toBe('pa');
}, 60_000);

test('missing ownership and unsupported execution do not mutate conversation or files', async () => {
  const f = await fixture(); await f.write('original');
  await expect(f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'old' }))
    .rejects.toMatchObject({ code: 'mutation_history_unavailable' });
  f.executions.isConfined = async () => false;
  await expect(f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'old' }))
    .rejects.toMatchObject({ code: 'mutation_runtime_unsupported' });
  expect(f.calls).toHaveLength(0); expect(await f.read()).toBe('original');
});

test('a lost conversation response restores the previous boundary without undoing foreign writes', async () => {
  const f = await fixture(); await f.write('a=1; b=2'); const a = await f.begin('a');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'a=3; b=2');
  await f.runtime.finish({ directory: f.directory, token: a.token });
  const revert = f.conversation.revert;
  f.conversation.revert = async (input) => { await revert(input); await f.write('a=3; b=4'); throw new Error('lost response'); };
  await expect(f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'pa' })).rejects.toThrow('lost response');
  expect(f.sessions.get('a').revert).toBeUndefined(); expect(await f.read()).toBe('a=3; b=4');
  expect(await f.runtime.pendingTransactions({ directory: f.directory })).toEqual([]);
}, 60_000);

test('session directory mismatch cannot admit a revert', async () => {
  const f = await fixture(); f.sessions.set('a', { id: 'a', directory: path.dirname(f.directory) });
  await expect(f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'pa' }))
    .rejects.toMatchObject({ code: 'session_directory_mismatch' }); expect(f.cancellations).toHaveLength(0);
});

test('an unknown persisted phase cannot default to committing file changes', async () => {
  const f = await fixture(); await f.write('before'); const a = await f.begin('a');
  await fs.writeFile(path.join(a.viewDirectory, 'x'), 'after');
  await f.runtime.finish({ directory: f.directory, token: a.token });
  const readTransaction = f.runtime.transaction;
  f.runtime.transaction = async (input) => ({ ...await readTransaction(input), phase: 'unknown-version' });
  await expect(f.create().revert({ directory: f.directory, sessionID: 'a', messageID: 'pa' }))
    .rejects.toMatchObject({ code: 'mutation_recovery_required' });
  expect(f.calls).toHaveLength(0); expect(f.cancellations).toHaveLength(0);
  expect(await f.read()).toBe('after');
}, 60_000);

test('startup recovery and a subdirectory retry share the same transaction owner', async () => {
  const f = await fixture();
  const subdirectory = path.join(f.directory, 'nested'); await fs.mkdir(subdirectory);
  f.sessions.set('a', { id: 'a', directory: subdirectory });
  await f.runtime.registerPrompt({ directory: subdirectory, sessionID: 'a', userMessageID: 'pa' });
  await f.runtime.prepareRevert({ directory: subdirectory, sessionID: 'a', messageID: 'pa' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.executions.cancelAndWait = async ({ sessions }) => {
    f.cancellations.push(sessions); entered.resolve(); await release.promise;
    return { terminated: true, sessions };
  };
  const retry = f.create().revert({ directory: subdirectory, sessionID: 'a', messageID: 'pa' });
  await entered.promise;
  const recovery = f.create().recover({ directory: f.directory });
  // Allow recovery to contend while the first owner is awaiting termination.
  await new Promise((resolve) => setTimeout(resolve, 300));
  release.resolve(); await Promise.all([retry, recovery]);
  expect(f.cancellations).toEqual([['a']]);
  expect(f.calls).toHaveLength(1);
  expect(f.sessions.get('a').revert.messageID).toBe('pa');
}, 60_000);
