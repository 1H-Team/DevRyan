import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { createNativeSessionRemoval } from '../../packages/web/server/lib/opencode/runtime-host/native-session-removal.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { assertNativeCancellationSettled, waitFor } from './process-lanes.mjs';
import { assertWriterOutcome, snapshotFiles } from './assertions.mjs';

const tables = ['session_v2', 'session_message', 'session_inbox', 'session_pending'];

/** Attach the competing request before removal enters its private DELETE scope. */
export function stageIndependentRemovalRace(action, matches) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const settled = gate.then(async run => {
    if (run) await assert.rejects(action(), matches,
      'Removal admitted a child after capturing its held subtree');
  });
  return { run: () => release(true), cancel: () => release(false), settled };
}

/** Independent inspection of the fixture database; never alters native rows. */
export async function readNativeRemovalRows({ databasePath, sessions }) {
  assert.ok(Array.isArray(sessions) && sessions.length > 0 && sessions.length <= 128);
  assert.equal(new Set(sessions).size, sessions.length, 'Removal identity set contains duplicates');
  for (const id of sessions) assert.match(id, /^ses_[A-Za-z0-9]+$/, 'Invalid native removal identity');
  const ids = sessions.map(id => `'${id}'`).join(',');
  const expressions = tables.map(table => `'${table}',json((SELECT COALESCE(json_group_array(json_object('id',id,'sessionID',${table === 'session_v2' ? 'id' : 'session_id'})),'[]') FROM (SELECT * FROM ${table} WHERE ${table === 'session_v2' ? 'id' : 'session_id'} IN (${ids}) ORDER BY id)))`);
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  let result;
  try {
    db.pragma('busy_timeout=5000');
    const row = db.prepare(`SELECT json_object(${expressions.join(',')}) AS rows;`).get();
    assert.ok(typeof row?.rows === 'string' && Buffer.byteLength(row.rows) <= 1024 * 1024,
      'Native removal inspection exceeded its output bound');
    result = JSON.parse(row.rows);
  } finally { db.close(); }
  for (const table of tables) {
    assert.ok(Array.isArray(result[table]), `Missing native ${table} rows`);
    for (const row of result[table]) assert.ok(typeof row.id === 'string' && sessions.includes(row.sessionID), 'Native removal row escaped captured subtree');
  }
  return result;
}

export function assertNativeRemovalAbsent(rows) {
  for (const table of tables) assert.deepEqual(rows[table], [], `Native removal retained ${table} rows`);
}

export function assertCompletedRemoval(intent, sessions) {
  assert.equal(intent?.state, 'completed', 'Removal did not reach its durable terminal decision');
  assert.equal(intent.members.length, sessions.length, 'Removal duplicated a captured member');
  assert.equal(intent.removed.length, sessions.length, 'Removal duplicated a member acknowledgement');
  assert.deepEqual(new Set(intent.members.map(member => member.id)), new Set(sessions), 'Removal changed its captured member set');
  assert.deepEqual(new Set(intent.removed), new Set(sessions), 'Removal omitted a captured member acknowledgement');
  assert.equal(intent.dispositions.length, sessions.length, 'Removal omitted native input dispositions');
  assert.deepEqual(new Set(intent.dispositions.map(row => row.sessionID)), new Set(sessions));
}

export async function runNativeRemovalCases({ client, admissionOwner, ownerID, executionHost, managed, managedCase,
  begin, configureFormatter, bun, directory, databasePath, environment, observations, getNativeControl, restartNative, trackSession, onPassedCase }) {
  const runtime = executionHost.runtime;
  const read = sessions => readNativeRemovalRows({ databasePath, environment, sessions });
  const make = ({ inspect, beforeRemoveLeaf, removeLeaf } = {}) => createNativeSessionRemoval({ runtime, admissionOwner, ownerID,
    inspectRemovalOwned: async input => {
      const snapshot = (await getNativeControl().call({ action: 'inspect-removal-owned', ...input })).result;
      await inspect?.(input, snapshot); return snapshot;
    },
    removeLeafOwned: async input => {
      await beforeRemoveLeaf?.(input);
      const result = (await getNativeControl().call({ action: 'remove-leaf-owned', ...input })).result;
      await removeLeaf?.(input, result); return result;
    },
    cancelManaged: input => managed.getManagedRuntime().cancelSessionsForRemoval(input),
    cancelAndWait: input => executionHost.executions.cancelAndWait(input),
  });
  const remove = (coordinator, sessionID) => admissionOwner.withWebOperation({ operation: 'sessions.remove', method: 'DELETE',
    path: `/api/session/${encodeURIComponent(sessionID)}`, directory }, () => coordinator.remove({ sessionID, directory }));
  const cases = [];
  const passed = row => { cases.push(row); onPassedCase?.(row); };
  const sessions = [managedCase.rootSessionID, managedCase.childSessionID];
  assert.equal(managedCase.conversationRevertRedo, null, 'Removal requires a fresh managed lifecycle, not reverted primary or child lineage');
  const activeSessionID = managedCase.childSessionID;
  assert.equal((await client.sessions.get(managedCase.rootSessionID, { directory })).parentID ?? null, null);
  assert.equal((await client.sessions.get(activeSessionID, { directory })).parentID, managedCase.rootSessionID);
  sessions.forEach(trackSession);
  const retainedFiles = ['managed-child.txt', managedCase.childWriterFile, 'sequential.txt'];
  const retainedBytes = await snapshotFiles(directory, retainedFiles);
  assert.ok(retainedBytes[managedCase.childWriterFile], 'Fresh managed subtree has no previously published file');
  const id = 'remove-active-writer', callID = `native_${id}`, file = 'remove-active-writer.nativecancel';
  const marker = 'native-removal-formatter-started.txt', formatter = 'native-removal-formatter.mjs';
  await fs.writeFile(path.join(directory, file), 'original removal bytes\n');
  await fs.writeFile(path.join(directory, formatter), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nsetInterval(()=>{},1000);\n`);
  const before = await snapshotFiles(directory, [file, marker]);
  let intentID, formatterPID, raced = false;
  await configureFormatter({ removal: { command: [bun, `./${formatter}`, '$FILE'], extensions: ['.nativecancel'] } });
  try {
    await begin({ id, tool: 'write', input: { path: file, content: 'private removal bytes\n' } }, { sessionID: activeSessionID });
    const lease = await waitFor(() => runtime.leaseForCall({ directory, sessionID: activeSessionID, callID }),
      value => value?.state === 'ready' && value.executionKind === 'process', 'Removal writer did not acquire its real supervised lease');
    formatterPID = await waitFor(async () => {
      try { return Number(await fs.readFile(path.join(lease.viewDirectory, marker), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, value => Number.isSafeInteger(value) && value > 1, 'Removal writer did not enter its formatter');
    assert.doesNotThrow(() => process.kill(formatterPID, 0));
    assert.equal(await fs.readFile(path.join(lease.viewDirectory, file), 'utf8'), 'private removal bytes\n');
    assert.deepEqual(await snapshotFiles(directory, [file, marker]), before);
    const pendingID = createV2MessageId();
    await client.prompts.prompt(activeSessionID, { messageID: pendingID, model: { providerID: 'sim', modelID: 'm1' },
      parts: [{ type: 'text', text: 'Owned queued input must receive removal disposition.' }] },
    { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30000 });
    const queued = await read(sessions);
    assert.ok([...queued.session_inbox, ...queued.session_pending].some(row => row.id === pendingID && row.sessionID === activeSessionID),
      'Removal fixture did not queue the exact accepted native input');
    observations.push({ phase: 'native_removal_pending_input_observed', sessions, activeSessionID, pendingID, rows: queued });
    const childRace = stageIndependentRemovalRace(() => client.sessions.create({ title: 'Child racing owned removal',
      parentID: sessions[0], model: { providerID: 'sim', modelID: 'm1' } }, { directory }), error => {
      observations.push({ phase: 'native_removal_child_create_refusal',
        code: typeof error.code === 'string' && /^[a-z_]{1,128}$/.test(error.code) ? error.code : null,
        status: Number.isInteger(error.statusCode) ? error.statusCode : null });
      return /native_session_held|native_removal/.test(error.message);
    });
    const coordinator = make({
      inspect: async (_input, snapshot) => {
        if (raced) return;
        raced = true;
        assert.deepEqual(new Set(snapshot.members.map(member => member.id)), new Set(sessions));
        assert.equal(snapshot.states.some(state => state.sessionID === activeSessionID && state.active), true);
        childRace.run();
        await childRace.settled;
        assert.deepEqual((await read(sessions)).session_v2, queued.session_v2);
      },
      beforeRemoveLeaf: async input => {
        if (input.sessionID !== activeSessionID) return;
        await assertNativeCancellationSettled({ databasePath, environment, sessionID: activeSessionID, callID, observations });
        await assertWriterOutcome({ runtime, directory, sessionID: activeSessionID, callID, observations,
          before, files: [file, marker], succeeded: false });
      },
      removeLeaf: async input => { intentID = input.intentID; },
    });
    try { assert.equal(await remove(coordinator, sessions[0]), true); }
    finally {
      childRace.cancel();
      await childRace.settled;
    }
    await assertWriterOutcome({ runtime, directory, sessionID: activeSessionID, callID, observations,
      before, files: [file, marker], succeeded: false });
    await waitFor(async () => {
      try { process.kill(formatterPID, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, Boolean, 'Owned removal left the native formatter alive', 5000);
    assertNativeRemovalAbsent(await read(sessions));
    const intent = await runtime.nativeRemoval({ directory, intentID });
    assertCompletedRemoval(intent, sessions);
    assert.ok(intent.dispositions.some(row => row.sessionID === activeSessionID
      && [...row.inboxIDs, ...row.pendingIDs].includes(pendingID)), 'Removal lost the queued native input identity');
    assert.deepEqual(await snapshotFiles(directory, retainedFiles), retainedBytes, 'Conversation removal reverted published project bytes');
    const snapshot = await managed.getManagedRuntime().getSnapshot({ rootSessionId: sessions[0] });
    assert.ok(snapshot.tasks.every(task => !['queued', 'running'].includes(task.status)), 'Removal left managed work nonterminal');
    passed({ id: 'native-owned-active-writer-removal', status: 'passed', intentID, sessions, activeSessionID, callID, formatterPID });
    passed({ id: 'native-owned-managed-pending-disposition', status: 'passed', intentID, activeSessionID, pendingID, taskID: managedCase.taskID });
    passed({ id: 'native-owned-child-create-removal-race', status: 'passed', intentID, sessions });
  } finally { await configureFormatter(false); }

  const root = await client.sessions.create({ title: 'Native interrupted removal root', model: { providerID: 'sim', modelID: 'm1' } }, { directory });
  const children = [];
  for (let index = 0; index < 2; index++) children.push(await client.sessions.create({ title: `Native removal child ${index}`, parentID: root.id,
    model: { providerID: 'sim', modelID: 'm1' } }, { directory }));
  const capturedIDs = [root.id, ...children.map(child => child.id)]; capturedIDs.forEach(trackSession);
  assert.deepEqual(new Set((await read(capturedIDs)).session_v2.map(row => row.id)), new Set(capturedIDs));
  let lostID, interruptedIntentID;
  const interrupted = make({ removeLeaf: async (input, result) => {
    if (lostID) return;
    assert.equal(result.removed, true); lostID = result.sessionID; interruptedIntentID = input.intentID;
    observations.push({ phase: 'native_removal_leaf_ack_lost', intentID: input.intentID, sessionID: result.sessionID });
    throw Object.assign(new Error('fixture_native_removal_ack_lost'), { code: 'fixture_native_removal_ack_lost' });
  } });
  await assert.rejects(remove(interrupted, root.id), error => error.code === 'fixture_native_removal_ack_lost');
  const committed = await runtime.nativeRemoval({ directory, intentID: interruptedIntentID });
  assert.equal(committed.state, 'committed');
  assert.deepEqual(new Set(committed.members.map(member => member.id)), new Set(capturedIDs));
  assert.deepEqual(committed.removed, [], 'Lost acknowledgement was falsely recorded as durable');
  assert.ok(committed.dispositions.some(row => row.sessionID === lostID), 'Native input disposition was not durable before deletion');
  const remainingIDs = capturedIDs.filter(id => id !== lostID);
  assert.deepEqual(new Set((await read(capturedIDs)).session_v2.map(row => row.id)), new Set(remainingIDs));
  const controller = await restartNative({ crash: true });
  assert.equal(controller.remainingProcessIds.length, 0);
  const retained = await runtime.nativeRemoval({ directory, intentID: interruptedIntentID });
  assert.deepEqual(retained, committed, 'Controller replacement changed the committed removal identity');
  await make().recover({ directory });
  assertNativeRemovalAbsent(await read(capturedIDs));
  const completed = await runtime.nativeRemoval({ directory, intentID: interruptedIntentID });
  assertCompletedRemoval(completed, capturedIDs);
  await make().recover({ directory });
  assert.deepEqual(await runtime.nativeRemoval({ directory, intentID: interruptedIntentID }), completed, 'Repeated recovery changed removal disposition');
  assert.deepEqual(await snapshotFiles(directory, retainedFiles), retainedBytes);
  passed({ id: 'native-owned-removal-commit-restart', status: 'passed', intentID: interruptedIntentID,
    sessions: capturedIDs, lostAcknowledgementSessionID: lostID, remainingIDsBeforeRestart: remainingIDs, controller });
  return cases;
}
