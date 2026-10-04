import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertCompletedRemoval, assertNativeRemovalAbsent, readNativeRemovalRows, stageIndependentRemovalRace } from './removal-lanes.mjs';
import { managedTaskTurn } from './assertions.mjs';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';

const sessions = ['ses_root', 'ses_child'];
test('competing child creation keeps its own request scope when removal releases the rendezvous', async () => {
  const context = new AsyncLocalStorage();
  let held = false, calls = 0;
  const race = context.run('independent-create', () => stageIndependentRemovalRace(async () => {
    calls++;
    assert.equal(context.getStore(), 'independent-create');
    assert.equal(held, true);
    throw new Error('native_session_held');
  }, error => error.message === 'native_session_held'));
  assert.equal(calls, 0);
  await context.run('outer-delete', async () => { held = true; race.run(); await race.settled; });
  assert.equal(calls, 1);
  const wrong = stageIndependentRemovalRace(async () => { throw new Error('native_web_authorization_required'); },
    error => error.message === 'native_session_held');
  wrong.run();
  await assert.rejects(wrong.settled, /Removal admitted a child/);
  const cancelled = stageIndependentRemovalRace(async () => { throw new Error('Cancelled fixture launched a child'); }, () => true);
  cancelled.cancel(); await cancelled.settled;
});
test('fresh managed removal driver has separate file and call identities from original Revert acceptance', () => {
  const original = managedTaskTurn('managed-child', 'fixer');
  const fresh = managedTaskTurn('managed-removal', 'fixer');
  const tools = ['write', 'devryan_task'].map(name => ({ function: { name } }));
  const writeFor = turn => {
    turn.responder({ body: { messages: [{ role: 'user', content: turn.marker }], tools } });
    return turn.responder({ body: { messages: [{ role: 'user', content: turn.childMarker }], tools } }).items[0];
  };
  const oldWrite = writeFor(original), freshWrite = writeFor(fresh);
  assert.equal(oldWrite.input.path, 'managed-child.txt');
  assert.equal(freshWrite.input.path, 'managed-managed-removal.txt');
  assert.notEqual(oldWrite.id, freshWrite.id);
  assert.notEqual(original.callIDs.startID, fresh.callIDs.startID);
  assert.notEqual(original.callIDs.waitID, fresh.callIDs.waitID);
  assert.notEqual(original.marker, fresh.marker);
});
test('completed removal requires every exact member and terminal native input disposition', () => {
  const intent = { state: 'completed', members: sessions.map(id => ({ id })), removed: [...sessions],
    dispositions: sessions.map(sessionID => ({ sessionID, inboxIDs: [], pendingIDs: [] })) };
  assertCompletedRemoval(intent, sessions);
  for (const changed of [
    { state: 'committed' }, { members: [{ id: 'ses_root' }, { id: 'ses_foreign' }] },
    { removed: ['ses_root'] }, { removed: [...sessions, 'ses_child'] },
    { dispositions: [{ sessionID: 'ses_root' }] },
    { dispositions: [{ sessionID: 'ses_root' }, { sessionID: 'ses_foreign' }] },
  ]) assert.throws(() => assertCompletedRemoval({ ...intent, ...changed }, sessions));
});

test('native row disposal checks pending input and history as well as the session row', () => {
  const absent = { session_v2: [], session_message: [], session_inbox: [], session_pending: [] };
  assertNativeRemovalAbsent(absent);
  for (const table of Object.keys(absent)) assert.throws(() => assertNativeRemovalAbsent({ ...absent,
    [table]: [{ id: 'remaining', sessionID: 'ses_child' }] }), new RegExp(table));
});

test('independent read-only SQLite inspection scopes every table to the exact subtree', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const tmp = path.join(root, '.cache/v2-validation/tmp'); await fs.mkdir(tmp, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(tmp, 'removal-oracle-'));
    const databasePath = path.join(fixture, 'native.db');
    const environment = { PATH: '/usr/bin:/bin', HOME: fixture, TMPDIR: fixture };
    try {
      const statements = ['CREATE TABLE session_v2(id TEXT PRIMARY KEY);',
        ...['session_message', 'session_inbox', 'session_pending'].map(table => `CREATE TABLE ${table}(id TEXT PRIMARY KEY,session_id TEXT);`),
        "INSERT INTO session_v2 VALUES('ses_root'),('ses_child'),('ses_foreign');",
        "INSERT INTO session_message VALUES('msg_history','ses_child'),('msg_foreign','ses_foreign');",
        "INSERT INTO session_inbox VALUES('msg_queued','ses_child');",
        "INSERT INTO session_pending VALUES('msg_pending','ses_root');"];
      await fs.writeFile(databasePath, '');
      const db = resolveSqliteDriver().open(databasePath);
      try { db.exec(statements.join('\n')); } finally { db.close(); }
      const readonly = resolveSqliteDriver().open(databasePath, { readonly: true });
      try {
        assert.throws(() => readonly.exec('DELETE FROM session_v2'), /readonly|read.only/i);
      } finally { readonly.close(); }
      const observed = await readNativeRemovalRows({ databasePath, environment, sessions });
      assert.deepEqual(observed.session_v2.map(row => row.id), ['ses_child', 'ses_root']);
      assert.deepEqual(observed.session_message, [{ id: 'msg_history', sessionID: 'ses_child' }]);
      assert.deepEqual(observed.session_inbox, [{ id: 'msg_queued', sessionID: 'ses_child' }]);
      assert.deepEqual(observed.session_pending, [{ id: 'msg_pending', sessionID: 'ses_root' }]);
      await assert.rejects(readNativeRemovalRows({ databasePath, environment, sessions: ["ses_root'; DELETE FROM session_v2;"] }));
      await assert.rejects(readNativeRemovalRows({ databasePath, environment, sessions: ['ses_root', 'ses_root'] }));
      assert.deepEqual(await readNativeRemovalRows({ databasePath, environment, sessions }), observed, 'Read oracle or rejected identity changed native data');
      assertNativeRemovalAbsent(await readNativeRemovalRows({ databasePath, environment, sessions: ['ses_absent'] }));
    } finally { await fs.rm(fixture, { recursive: true, force: true }); }
  });
