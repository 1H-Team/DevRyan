import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWriterOutcome, snapshotFiles } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';

export async function runWriterByteEdges({ directory, sessionID, runtime, observations, invoke, configureFormatter, bun }) {
  const cases = [];
  const run = async (scenario, expected) => {
    const files = Object.keys(expected), before = await snapshotFiles(directory, files);
    const part = await invoke(scenario);
    assert.equal(part.state.status, scenario.failed ? 'error' : 'completed', `${scenario.id}: ${part.state.error ?? 'unexpected tool status'}`);
    await assertWriterOutcome({ runtime, directory, sessionID, observations, callID: `native_${scenario.id}`,
      before, files, succeeded: !scenario.failed });
    for (const [file, bytes] of Object.entries(expected)) assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), bytes);
    cases.push({ id: scenario.id, status: 'passed', assistantMessageID: part.messageID, callID: part.callID });
  };
  const file = 'byte-edges.nativefmt';
  await fs.writeFile(path.join(directory, file), '\uFEFFalpha\r\nmiddle\r\nomega\r\n');
  await run({ id: 'bom-crlf-edit', tool: 'edit', input: { path: file, oldString: 'alpha\nmiddle', newString: 'beta\nmiddle' } },
    { [file]: '\uFEFFbeta\r\nmiddle\r\nomega\r\n' });
  // This real formatter intentionally strips BOM. Native FileMutation must
  // restore it, and duplicate update sections must format their target once.
  await fs.writeFile(path.join(directory, 'native-formatter.mjs'),
    "import fs from 'node:fs';\nconst file=process.argv[2];\nconst text=fs.readFileSync(file,'utf8').replace(/^\\uFEFF/,'').replace(/\\r?\\n/g,'\\r\\n').replace('gamma','FORMATTED');\nfs.writeFileSync(file,text);fs.appendFileSync('formatter-count.txt','run\\n');\n");
  await configureFormatter({ acceptance: { command: [bun, './native-formatter.mjs', '$FILE'], extensions: ['.nativefmt'] } });
  try {
    await run({ id: 'repeated-patch-formatter', tool: 'patch', input: { patchText:
      `*** Begin Patch\n*** Update File: ${file}\n@@\n-beta\n+intermediate\n*** Update File: ${file}\n@@\n-intermediate\n+gamma\n*** End Patch` } },
    { [file]: '\uFEFFFORMATTED\r\nmiddle\r\nomega\r\n', 'formatter-count.txt': 'run\n' });
  } finally { await configureFormatter(false); }

  const foreignFile = 'foreign-read.txt';
  await fs.writeFile(path.join(directory, foreignFile), 'match me\n');
  const read = async id => {
    const part = await invoke({ id, tool: 'read', input: { path: foreignFile } });
    assert.equal(part.state.status, 'completed');
    const lease = await runtime.leaseForCall({ directory, sessionID, callID: `native_${id}` });
    assert.equal(lease?.direct, true); assert.equal(lease.state, 'published');
  };
  await read('before-foreign-retained');
  await fs.writeFile(path.join(directory, foreignFile), 'foreign prefix\nmatch me\n');
  await run({ id: 'foreign-retained-match', tool: 'edit', input: { path: foreignFile, oldString: 'match me', newString: 'owned change' } },
    { [foreignFile]: 'foreign prefix\nowned change\n' });
  await read('before-foreign-removed');
  await fs.writeFile(path.join(directory, foreignFile), 'foreign replacement\n');
  await run({ id: 'foreign-removed-match', tool: 'edit', input: { path: foreignFile, oldString: 'owned change', newString: 'must not publish' }, failed: true },
    { [foreignFile]: 'foreign replacement\n' });
  return cases;
}

export function sameFileWriterTurn(caseID) {
  const calls = ['first', 'second'].map((label, index) => ({ id: `native_${caseID}_${index}`, index, name: 'write',
    input: { path: 'same-file.bin', content: `\0${label}\n` } }));
  const marker = `[devryan-native-case:${caseID}]`;
  let issued = false, completed = false;
  return { calls, marker,
    responder: request => {
      const messages = request.body?.messages;
      assert.ok(Array.isArray(messages), 'Missing same-file model messages');
      const results = messages.filter(message => message?.role === 'tool' && calls.some(call => call.id === message.tool_call_id));
      if (results.length) {
        assert.ok(issued && !completed, 'Same-file writer result replayed');
        assert.equal(results.length, calls.length, 'Same-file continuation omitted a tool result');
        assert.deepEqual(new Set(results.map(result => result.tool_call_id)), new Set(calls.map(call => call.id)));
        completed = true;
        return { items: [{ type: 'textDelta', text: `completed ${caseID}` }], reason: 'stop' };
      }
      assert.equal(issued, false, 'Same-file calls replayed');
      assert.ok(messages.some(message => JSON.stringify(message).includes(marker)), 'Unrelated same-file model request');
      assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'write'), 'Native write absent from registry');
      issued = true;
      return { items: calls.map(call => ({ type: 'toolCall', ...call })), reason: 'tool-calls' };
    },
    complete: () => { assert.ok(issued && completed, 'Same-file writer continuation incomplete'); return { callIDs: calls.map(call => call.id) }; },
  };
}

export async function runSameFileWriters({ client, setPermissions, begin, settle, runtime, directory, observations }) {
  const id = 'same-file-writers';
  await fs.writeFile(path.join(directory, 'same-file.bin'), '\0base\n');
  const session = await client.sessions.create({ title: 'Native same-file writers', model: { providerID: 'sim', modelID: 'm1' } }, { directory });
  await setPermissions(session.id, [{ action: '*', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*', effect: 'ask' }]);
  await begin({ id }, { sessionID: session.id, sameFile: true });
  const requests = await waitFor(() => client.interaction.permissions.list({ directory }, { sessionID: session.id }),
    values => [0, 1].every(index => values.some(value => value.sessionID === session.id && value.tool?.callID === `native_${id}_${index}`)),
    'Both native same-file workers must reach permission after preparing their views');
  for (const index of [0, 1]) {
    const request = requests.find(value => value.tool?.callID === `native_${id}_${index}`);
    await client.interaction.permissions.reply(request.id, { reply: 'once' }, { directory, sessionID: session.id });
    await waitFor(() => runtime.leaseForCall({ directory, sessionID: session.id, callID: `native_${id}_${index}` }),
      lease => lease?.state === 'published', `Same-file writer ${index} did not publish its durable disposition`);
  }
  const parts = await settle({ id }, { sessionID: session.id, sameFile: true });
  assert.equal(parts.length, 2);
  for (const index of [0, 1]) await assertWriterOutcome({ runtime, directory, sessionID: session.id,
    callID: `native_${id}_${index}`, observations, succeeded: true });
  const losing = await runtime.leaseForCall({ directory, sessionID: session.id, callID: `native_${id}_1` });
  assert.equal(losing.result.outcome, 'partial');
  assert.deepEqual(losing.result.conflicts, [{ path: 'same-file.bin' }]);
  assert.equal(await fs.readFile(path.join(directory, 'same-file.bin'), 'utf8'), '\0first\n', 'Second worker overwrote an already published binary edit');
  const second = parts.find(part => part.callID === `native_${id}_1`);
  assert.match(JSON.stringify(second.state), /conflict/i, 'Native result hid its durable publication conflict');
  return { id, status: 'passed', sessionID: session.id, calls: parts.map(part => ({ callID: part.callID, assistantMessageID: part.messageID })) };
}

export async function runInterruptedPublication({ directory, sessionID, runtime, observations, invoke, configureMaterialization }) {
  const id = 'interrupted-publication', file = 'interrupted-publication.txt';
  await fs.writeFile(path.join(directory, file), 'before interruption\n');
  let attempts = 0;
  await configureMaterialization(row => {
    if (row.path === file && ++attempts === 1) throw new Error('Native fixture materialization interruption');
  });
  try {
    const part = await invoke({ id, tool: 'write', input: { path: file, content: 'recovered publication\n' } });
    assert.equal(part.state.status, 'completed', 'Native result lost its committed publication after interrupted materialization');
    assert.equal(attempts, 2, 'Native publication did not recover its interrupted materialization exactly once');
    await assertWriterOutcome({ runtime, directory, sessionID, observations, callID: part.callID, succeeded: true });
    assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), 'recovered publication\n');
    const lease = await runtime.leaseForCall({ directory, sessionID, callID: part.callID });
    assert.deepEqual(await runtime.finish({ directory, token: lease.token }), lease.result,
      'Retry changed the durable publication identity');
    assert.equal(attempts, 2, 'Idempotent finish repeated materialization');
    assert.equal(observations.filter(value => value.callID === part.callID && value.phase === 'published').length, 1);
    return { id, status: 'passed', callID: part.callID, operationID: lease.result.operationID, materializationAttempts: attempts };
  } finally { await configureMaterialization(undefined); }
}

export async function runCancelledWriterTransforms({ directory, sessionID, runtime, observations, begin,
  executionHost, nativeControl, configureFormatter, bun, assertCancelled }) {
  // This is a real native formatter subprocess after the writer changes its
  // private file. Its marker lets cancellation target an executing transform.
  const script = 'native-cancel-formatter.mjs', marker = 'native-transform-started.txt';
  await fs.writeFile(path.join(directory, script), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nsetInterval(()=>{},1000);\n`);
  await configureFormatter({ cancellation: { command: [bun, `./${script}`, '$FILE'], extensions: ['.nativecancel'] } });
  const cases = [];
  try {
    for (const tool of ['write', 'edit']) {
      const id = `cancel-${tool}-transform`, callID = `native_${id}`, file = `${id}.nativecancel`;
      await fs.writeFile(path.join(directory, file), 'original native bytes\n');
      const files = [file, marker], before = await snapshotFiles(directory, files);
      await begin({ id, tool, input: tool === 'write' ? { path: file, content: 'private native bytes\n' }
        : { path: file, oldString: 'original', newString: 'private' } }, { sessionID });
      const lease = await waitFor(() => runtime.leaseForCall({ directory, sessionID, callID }),
        value => value?.state === 'ready' && value.executionKind === 'process', 'Native writer did not enter its supervised view');
      const pid = await waitFor(async () => {
        try { return Number(await fs.readFile(path.join(lease.viewDirectory, marker), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }, value => Number.isSafeInteger(value) && value > 1, 'Native writer never reached its formatter');
      assert.doesNotThrow(() => process.kill(pid, 0), 'Native formatter was not running before cancellation');
      assert.equal(await fs.readFile(path.join(lease.viewDirectory, file), 'utf8'), 'private native bytes\n');
      assert.deepEqual(await snapshotFiles(directory, files), before, 'Native transform escaped its private view before cancellation');
      const stopped = await executionHost.executions.cancelAndWait({ directory, sessions: [sessionID] });
      assert.equal(stopped.terminated, true);
      await assertWriterOutcome({ runtime, directory, sessionID, callID, observations, before, files, succeeded: false });
      await waitFor(async () => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      }, value => value, 'Native formatter survived verified cancellation', 5000);
      await nativeControl.call({ action: 'cancelled' });
      await assertCancelled(callID);
      assert.equal((await runtime.nativeAdmissionState({ directory, sessionID })).held, true);
      await nativeControl.call({ action: 'release', sessionID });
      cases.push({ id, status: 'passed', callID, formatterPID: pid });
    }
  } finally { await configureFormatter(false); }
  return cases;
}

export async function runProtectedRootCases({ directory, sessionID, runtime, observations, invoke, protectedDirectory }) {
  const sentinel = 'DEVRYAN_PROTECTED_READ_SENTINEL\n';
  const external = path.join(protectedDirectory, 'native-private-sentinel.txt');
  const metadata = path.join(directory, '.git', 'native-private-sentinel.txt');
  await fs.writeFile(external, sentinel); await fs.writeFile(metadata, sentinel);
  const link = path.join(directory, 'native-external-link.txt');
  await fs.symlink(external, link);
  const cases = [];
  try {
    for (const scenario of [
      { id: 'protected-read', tool: 'read', input: { path: external } },
      { id: 'protected-grep', tool: 'grep', input: { pattern: 'SENTINEL', path: protectedDirectory } },
      { id: 'protected-glob', tool: 'glob', input: { pattern: '*', path: protectedDirectory } },
      { id: 'protected-writer-preview', tool: 'edit', input: { path: external, oldString: 'SENTINEL', newString: 'must-not-publish' } },
      { id: 'protected-writer-symlink', tool: 'write', input: { path: 'native-external-link.txt', content: 'must-not-publish\n' } },
      { id: 'protected-writer-git', tool: 'write', input: { path: '.git/native-private-sentinel.txt', content: 'must-not-publish\n' } },
    ]) {
      const part = await invoke(scenario);
      assert.equal(part.state.status, 'error', `${scenario.id} read or modified a protected target`);
      assert.match(part.state.error, /native_read_root_denied/, `${scenario.id} failed before the intended protected-root guard`);
      assert.ok(!JSON.stringify(part.state).includes(sentinel.trim()), 'Protected bytes leaked through a tool result or permission preview');
      assert.ok(!observations.some(value => value.callID === part.callID && value.protectedSentinelObserved === true),
        'Protected bytes leaked through a native worker permission preview');
      assert.equal(await fs.readFile(external, 'utf8'), sentinel); assert.equal(await fs.readFile(metadata, 'utf8'), sentinel);
      const lease = await runtime.leaseForCall({ directory, sessionID, callID: `native_${scenario.id}` });
      if (lease?.executionKind === 'process') {
        assert.equal(lease.state, 'cancelled');
        const termination = observations.find(value => value.callID === part.callID && value.phase === 'termination_verified');
        assert.equal(termination?.receipt?.terminated, true); assert.equal(termination.receipt.confined, true);
      }
      cases.push({ id: scenario.id, status: 'passed', callID: part.callID, assistantMessageID: part.messageID,
        processStarted: lease?.executionKind === 'process' });
    }
  } finally { await fs.rm(link, { force: true }); }
  return cases;
}
