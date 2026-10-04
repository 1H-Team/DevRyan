import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertCancelledNativeState, assertWriterOutcome, snapshotFiles } from './assertions.mjs';

const runFile = promisify(execFile);

export async function assertNativeCancellationSettled({ databasePath, environment, sessionID, callID, observations }) {
  assert.match(sessionID, /^ses_[A-Za-z0-9]+$/);
  assert.match(callID, /^native_[A-Za-z0-9_-]+$/);
  // Match the actual tool entry rather than an older idle in this shared session.
  const query = `WITH assistant AS (
    SELECT m.id,m.seq,m.data,tool.value AS tool FROM session_message m,
      json_each(m.data,'$.content') tool
    WHERE m.session_id='${sessionID}' AND m.type='assistant'
      AND json_extract(tool.value,'$.type')='tool' AND json_extract(tool.value,'$.id')='${callID}'
  ), idle AS (
    SELECT id,seq,data FROM session_message WHERE session_id='${sessionID}' AND type='idle'
      AND seq>(SELECT seq FROM assistant) ORDER BY seq LIMIT 1
  ) SELECT json_object('assistantID',a.id,'assistantSequence',a.seq,
    'assistantCompleted',json_extract(a.data,'$.time.completed'),
    'assistantError',json_extract(a.data,'$.error.type'),'toolError',json_extract(a.tool,'$.state.error.type'),
    'idleID',i.id,'idleSequence',i.seq,'idleOutcome',json_extract(i.data,'$.outcome'),
    'sessionOutcome',s.idle_outcome,'timeSuspended',s.time_suspended,'resumeAttempts',s.resume_attempts)
    FROM session_v2 s LEFT JOIN assistant a LEFT JOIN idle i WHERE s.id='${sessionID}';`;
  let lastState;
  const state = await waitFor(async () => {
    const { stdout } = await runFile('/usr/bin/sqlite3', ['-readonly', databasePath, query],
      { env: environment, timeout: 5000, maxBuffer: 4096 });
    const value = stdout.trim() ? JSON.parse(stdout) : null;
    lastState = value;
    try { assertCancelledNativeState(value); return value; } catch { return null; }
  }, value => value !== null, `Native cancellation did not publish interrupted idle and release claim for ${callID}`)
    .catch(error => { observations.push({ phase: 'native_cancellation_unsettled', sessionID, callID, state: lastState }); throw error; });
  assertCancelledNativeState(state);
  observations.push({ phase: 'native_cancellation_settled', sessionID, callID, ...state });
  return state;
}

export const waitFor = async (read, predicate, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

export async function runForegroundShell({ invoke, runtime, directory, sessionID, observations }) {
  const id = 'foreground-shell';
  const call = await invoke({ id, tool: 'shell', input: { command: "printf 'foreground native shell\\n' > foreground.txt" } });
  assert.equal(call.state.status, 'completed');
  await assertWriterOutcome({ runtime, directory, sessionID, observations, callID: `native_${id}`, succeeded: true });
  assert.equal(await fs.readFile(path.join(directory, 'foreground.txt'), 'utf8'), 'foreground native shell\n');
  return { id, status: 'passed' };
}

export async function runBackgroundShell({ invoke, runtime, directory, sessionID, observations }) {
  const id = 'background-shell';
  const call = await invoke({ id, tool: 'shell', input: { command: "sleep 0.5; printf 'background native shell\\n' > background.txt" } }, { background: true });
  assert.equal(call.state.status, 'completed');
  await assertWriterOutcome({ runtime, directory, sessionID, observations, callID: `native_${id}`, succeeded: true });
  assert.equal(await fs.readFile(path.join(directory, 'background.txt'), 'utf8'), 'background native shell\n');
  return { id, status: 'passed', source: 'actual-native-job-completion-wake' };
}

export async function runTrackedBackgroundShell({ invoke, client, managed, runtime, directory, observations }) {
  const id = 'tracked-primary-background';
  const session = await client.sessions.create({ title: 'Tracked native background completion', agent: 'orchestrator',
    model: { providerID: 'sim', modelID: 'm1' }, variant: 'default' }, { directory });
  await managed.admitPrimary(session.id);
  const call = await invoke({ id, tool: 'shell', input: { command: "sleep 0.5; printf 'tracked native shell\\n' > tracked-background.txt" } },
    { background: true, sessionID: session.id, agent: 'orchestrator', variant: 'default' });
  assert.equal(call.state.status, 'completed');
  await assertWriterOutcome({ runtime, directory, sessionID: session.id, observations, callID: `native_${id}`, succeeded: true });
  assert.equal(await fs.readFile(path.join(directory, 'tracked-background.txt'), 'utf8'), 'tracked native shell\n');
  const lease = await runtime.leaseForCall({ directory, sessionID: session.id, callID: `native_${id}` });
  const noticeID = lease.nativeShellJob?.deliveredID;
  assert.ok(noticeID, 'Tracked shell has no durable canonical native notice');
  const messages = (await client.sessions.messages(session.id, {}, { directory })).records;
  const objective = messages.filter(row => row.info.role === 'user'
    && row.parts?.some(part => part.type === 'text' && part.text === `[devryan-native-case:${id}]`));
  assert.equal(objective.length, 1);
  const notices = messages.filter(row => row.info.id === noticeID && row.info.role === 'user');
  assert.equal(notices.length, 1, 'Tracked background completion duplicated its native notice');
  const final = messages.filter(row => row.info.role === 'assistant' && row.info.parentID === noticeID
    && row.parts?.some(part => part.type === 'text' && part.text === `completed ${id}`));
  assert.equal(final.length, 1, 'Tracked background completion lost or duplicated its canonical assistant');
  assert.equal(final[0].turnOwnership?.source, 'native-sequence');
  assert.equal(final[0].turnOwnership?.userMessageID, noticeID);
  assert.ok(Number.isFinite(final[0].info.time?.completed));
  assert.equal(final[0].info.providerID, 'sim'); assert.equal(final[0].info.modelID, 'm1'); assert.equal(final[0].info.variant, 'default');
  const record = await waitFor(() => managed.readPrimaryRecord(session.id), value => value?.activeUserID === noticeID,
    'Tracked primary did not adopt its real shell notice');
  assert.equal(record.anchorID, objective[0].info.id);
  assert.equal(record.providerID, 'sim'); assert.equal(record.modelID, 'm1'); assert.equal(record.agent, 'orchestrator');
  assert.equal(record.variant, 'default'); assert.equal(record.executionGeneration, 2);
  const consumed = await runtime.leaseForCall({ directory, sessionID: session.id, callID: `native_${id}` });
  assert.equal(consumed.nativeShellJob?.continuedAssistantID, final[0].info.id);
  assert.equal((await runtime.nativeShellContinuations({ directory })).some(intent => intent.sessionID === session.id
    && intent.operation === `shell.complete:${consumed.nativeShellJob.jobID}`), false,
  'Native shell continuation was not durably acknowledged by the actual assistant step');
  return { id, status: 'passed', sessionID: session.id, anchorID: record.anchorID, activeUserID: record.activeUserID,
    source: 'accepted-native-selection-and-receipt-verified-shell-notice' };
}

// Each ruleset lives on an actual native session. Replies use the ordinary
// permission client and the worker's request identity, never a fixture bypass.
export async function runPermissionCases({ client, setPermissions, begin, settle, runtime, directory, observations }) {
  const outcomes = [];
  const makeSession = async effect => {
    const session = await client.sessions.create({ title: `Native permission ${effect}`, model: { providerID: 'sim', modelID: 'm1' } }, { directory });
    await setPermissions(session.id, [{ action: '*', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*', effect }]);
    return session;
  };
  const denySession = await makeSession('deny');
  const deny = { id: 'permission-deny', tool: 'write', deniedInventory: true, input: { path: 'permission-denied.txt', content: 'must not publish\n' } };
  const before = await snapshotFiles(directory, ['permission-denied.txt']);
  await begin(deny, { sessionID: denySession.id });
  const denied = await settle(deny, { sessionID: denySession.id });
  assert.equal(denied.state.status, 'error');
  assert.match(denied.state.error, /^(?:No tool named "write" is currently available\. Please use a tool from the available tool list\.|Tool is not available for this request: write|Unknown tool: write)$/,
    'Denied native tool failed outside its catalog/permission fence');
  const lease = await runtime.leaseForCall({ directory, sessionID: denySession.id, callID: `native_${deny.id}` });
  assert.equal(lease, null, 'Denied catalog invocation acquired a process lease');
  assert.equal(observations.some(row => row.callID === `native_${deny.id}` && row.phase === 'execution_requested'), false);
  assert.deepEqual(await snapshotFiles(directory, ['permission-denied.txt']), before);
  outcomes.push({ id: deny.id, status: 'passed', source: 'native-catalog-refusal', workerStarted: false });

  const askSession = await makeSession('ask');
  for (const [id, reply] of [['permission-ask-reject', 'reject'], ['permission-ask-correction', 'once']]) {
    const scenario = { id, tool: 'write', input: { path: 'permission-ask.txt', content: 'approved native writer\n' } };
    const before = await snapshotFiles(directory, ['permission-ask.txt']);
    await begin(scenario, { sessionID: askSession.id });
    const pending = await waitFor(() => client.interaction.permissions.list({ directory }, { sessionID: askSession.id }),
      requests => requests.some(request => request.sessionID === askSession.id), 'Native writer did not request permission');
    const request = pending.find(value => value.sessionID === askSession.id);
    assert.ok(request.id && request.tool?.callID === `native_${id}`, 'Permission request lost the native tool identity');
    assert.deepEqual(await snapshotFiles(directory, ['permission-ask.txt']), before, 'Writer published before permission reply');
    await assert.rejects(client.interaction.permissions.reply(`${request.id}-wrong`, { reply: 'once' }, { directory, sessionID: askSession.id }),
      'Unknown permission identity was accepted');
    await client.interaction.permissions.reply(request.id, { reply }, { directory, sessionID: askSession.id });
    const call = await settle(scenario, { sessionID: askSession.id });
    assert.equal(call.state.status, reply === 'once' ? 'completed' : 'error');
    await assertWriterOutcome({ runtime, directory, sessionID: askSession.id, callID: `native_${id}`, observations,
      before, files: ['permission-ask.txt'], succeeded: reply === 'once' });
    outcomes.push({ id, status: 'passed' });
  }
  assert.equal(await fs.readFile(path.join(directory, 'permission-ask.txt'), 'utf8'), 'approved native writer\n');
  return outcomes;
}

export async function runEscapedDescendantCancellation({ begin, nativeControl, executionHost, runtime, directory, sessionID, observations, assertCancelled, node = process.execPath }) {
  const id = 'escaped-descendant-cancel';
  // Attempt a detached spawn under the real confinement policy, which prevents
  // a process-group escape. The live descendant still requires owned cleanup.
  const childSource = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync('escaped-growth.txt','x'),20);";
  const source = `import { spawn } from 'node:child_process';\nconst child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});\nconsole.log('DEVRYAN_ESCAPE_PID:'+child.pid);\nsetInterval(()=>{},1000);\n`;
  await fs.writeFile(path.join(directory, 'escaped-descendant.mjs'), source);
  const before = await snapshotFiles(directory, ['escaped-growth.txt']);
  // Darwin deliberately refuses posix_spawn so libuv falls back to fork/exec
  // inside the same policy. Bun cannot perform that fallback; actual Node can.
  const command = `'${node.replaceAll("'", "'\\''")}' escaped-descendant.mjs`;
  await begin({ id, tool: 'shell', input: { command, timeout: 0 } });
  const output = await waitFor(async () => observations.filter(value => value.callID === `native_${id}` && value.phase === 'execution_output')
    .map(value => value.text).join(''), value => /DEVRYAN_ESCAPE_PID:\d+/.test(value), 'Escaped native descendant did not start');
  const pid = Number(output.match(/DEVRYAN_ESCAPE_PID:(\d+)/)[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.doesNotThrow(() => process.kill(pid, 0), 'Owned escaped descendant was not alive before cancellation');
  const result = await executionHost.executions.cancelAndWait({ directory, sessions: [sessionID] });
  assert.equal(result.terminated, true);
  await assertWriterOutcome({ runtime, directory, sessionID, callID: `native_${id}`, observations, before,
    files: ['escaped-growth.txt'], succeeded: false });
  await waitFor(async () => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } },
    stopped => stopped, 'Escaped native descendant survived verified cancellation', 5_000);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await snapshotFiles(directory, ['escaped-growth.txt']), before, 'Cancelled native descendant published later changes');
  await nativeControl.call({ action: 'cancelled' });
  await assertCancelled(`native_${id}`);
  const state = await runtime.nativeAdmissionState({ directory, sessionID });
  assert.equal(state.held, true, 'Cancellation discarded its durable native hold');
  await nativeControl.call({ action: 'release', sessionID });
  return { id, status: 'passed', descendantPID: pid, source: 'actual-detached-spawn-attempt-under-confinement' };
}
