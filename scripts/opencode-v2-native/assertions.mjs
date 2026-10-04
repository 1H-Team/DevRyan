import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const snapshotFiles = async (directory, files) => Object.fromEntries(await Promise.all(files.map(async file => {
  const resolved = path.resolve(directory, file);
  assert.ok(resolved.startsWith(`${path.resolve(directory)}${path.sep}`), 'Fixture path escaped project');
  try {
    const stat = await fs.lstat(resolved);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Fixture file must be regular');
    const [canonicalDirectory, canonicalFile] = await Promise.all([fs.realpath(directory), fs.realpath(resolved)]);
    assert.ok(canonicalFile.startsWith(`${canonicalDirectory}${path.sep}`), 'Fixture file traversed an external link');
    return [file, { sha256: createHash('sha256').update(await fs.readFile(resolved)).digest('hex'), mode: stat.mode & 0o777 }];
  } catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
})));

export const assertTerminatedBeforeOutcome = (observations, callID, outcome) => {
  const records = observations.filter(record => record.callID === callID);
  const terminated = records.findIndex(record => record.phase === 'termination_verified');
  const settled = records.findIndex(record => record.phase === outcome);
  assert.ok(terminated >= 0, 'Missing verified native termination');
  assert.ok(settled > terminated, `${outcome} preceded verified termination`);
  assert.equal(records[terminated].receipt?.terminated, true);
  assert.equal(records[terminated].receipt?.confined, true);
};

// These fields come from the owned native database, independently of the web
// process receipt. A discarded worker does not establish native runner idleness.
export const assertCancelledNativeState = state => {
  assert.ok(state && typeof state === 'object', 'Missing native cancellation state');
  assert.ok(state.assistantID && Number.isSafeInteger(state.assistantSequence), 'Missing exact cancelled native assistant');
  assert.ok(Number.isFinite(state.assistantCompleted), 'Cancelled native assistant is not terminal');
  assert.equal(state.assistantError, 'aborted');
  assert.equal(state.toolError, 'aborted');
  assert.ok(state.idleID && Number.isSafeInteger(state.idleSequence)
    && state.idleSequence > state.assistantSequence, 'Missing canonical idle after cancelled assistant');
  assert.equal(state.idleOutcome, 'interrupted');
  assert.equal(state.sessionOutcome, 'interrupted');
  assert.equal(state.timeSuspended, null, 'Native runner claim was not released');
  assert.equal(state.resumeAttempts, 0, 'Native runner resume attempts were not reset');
};

// Observe the real ledger independently of the returned native tool result.
export const assertWriterOutcome = async ({ runtime, directory, sessionID, callID, observations, before, files, succeeded }) => {
  const lease = await runtime.leaseForCall({ directory, sessionID, callID });
  assert.ok(lease, 'Native writer bypassed the existing ledger');
  assert.equal(lease.executionKind, 'process');
  assert.equal(lease.state, succeeded ? 'published' : 'cancelled');
  assertTerminatedBeforeOutcome(observations, callID, succeeded ? 'published' : 'discarded');
  if (!succeeded) {
    assert.deepEqual(await snapshotFiles(directory, files), before, 'Failed native transform published project changes');
    assert.equal(lease.result, undefined, 'Failed native transform retained a publication');
  } else {
    assert.ok(lease.result?.operationID && Number.isSafeInteger(lease.result.sequence), 'Missing durable publication identity');
  }
};

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const toolTurn = (name, input, caseID, options = {}) => {
  const id = `native_${caseID}`;
  let issued = false;
  let completed = false;
  let toolResult;
  return {
    callID: id,
    marker: `[devryan-native-case:${caseID}]`,
    responder: request => {
      assert.ok(isRecord(request.body) && Array.isArray(request.body.messages), 'Missing model request messages');
      const messages = request.body.messages;
      const result = messages.find(message => isRecord(message) && message.role === 'tool' && message.tool_call_id === id);
      if (result) {
        assert.ok(issued && !completed, 'Unexpected or replayed native tool result');
        toolResult = result.content; completed = true;
        return { items: [{ type: 'textDelta', text: `completed ${caseID}` }], reason: 'stop' };
      }
      assert.equal(issued, false, 'Native tool continuation did not carry its exact result');
      assert.ok(messages.some(message => JSON.stringify(message).includes(`[devryan-native-case:${caseID}]`)), 'Unrelated model request');
      assert.ok(Array.isArray(request.body.tools), 'Native registry missing');
      const available = request.body.tools.some(tool => isRecord(tool) && isRecord(tool.function) && tool.function.name === name);
      assert.equal(available, options.deniedInventory !== true,
        options.deniedInventory === true ? `Native denied registry still exposed ${name}` : `Native registry did not expose ${name}`);
      issued = true;
      return { items: [{ type: 'toolCall', index: 0, id, name, input }], reason: 'tool-calls' };
    },
    complete: () => { assert.ok(issued && completed, 'Native turn did not settle through the real provider continuation'); return toolResult; },
    cancelled: () => { assert.ok(issued && !completed, 'Cancelled turn did not retain its pending exact native call'); return { callID: id }; },
  };
};

// These are native 2.0.20 names/shapes, deliberately different from v1 tools.
export const writerCases = Object.freeze([
  { id: 'fresh-write', tool: 'write', input: { path: 'sequential.txt', content: 'first\n' }, expected: { 'sequential.txt': 'first\n' } },
  { id: 'fresh-edit', tool: 'edit', input: { path: 'sequential.txt', oldString: 'first', newString: 'second' }, expected: { 'sequential.txt': 'second\n' } },
  { id: 'fresh-patch', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Update File: sequential.txt\n@@\n-second\n+third\n*** End Patch' }, expected: { 'sequential.txt': 'third\n' } },
  { id: 'fresh-removal', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Delete File: delete-target.txt\n*** End Patch' }, removed: ['delete-target.txt'] },
  { id: 'missing-edit', tool: 'edit', input: { path: 'sequential.txt', oldString: 'never existed', newString: 'must not publish' }, failed: true },
  { id: 'ambiguous-edit', tool: 'edit', input: { path: 'ambiguous.txt', oldString: 'duplicate', newString: 'must not publish' }, failed: true },
  { id: 'partial-patch-error', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Update File: sequential.txt\n@@\n-third\n+must not publish\n*** Update File: missing.txt\n@@\n-absent\n+must not publish\n*** End Patch' }, failed: true },
  { id: 'partial-removal-error', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Delete File: removalfail-target.txt\n*** Update File: missing.txt\n@@\n-absent\n+must not publish\n*** End Patch' }, failed: true },
]);

export const parallelWriterTurn = caseID => {
  const calls = Array.from({ length: 8 }, (_, index) => ({ id: `native_${caseID}_${index}`, index,
    name: 'write', input: { path: `parallel-${index}.txt`, content: `writer ${index}\n` } }));
  let issued = false;
  let completed = false;
  return {
    calls, marker: `[devryan-native-case:${caseID}]`,
    responder: request => {
      assert.ok(isRecord(request.body) && Array.isArray(request.body.messages), 'Missing parallel model messages');
      const results = request.body.messages.filter(message => isRecord(message) && message.role === 'tool'
        && calls.some(call => call.id === message.tool_call_id));
      if (results.length) {
        assert.equal(issued, true); assert.equal(completed, false);
        assert.deepEqual(new Set(results.map(result => result.tool_call_id)), new Set(calls.map(call => call.id)),
          'Native continuation omitted concurrent tool results');
        assert.equal(results.length, 8, 'Native continuation duplicated concurrent tool results');
        completed = true;
        return { items: [{ type: 'textDelta', text: `completed ${caseID}` }], reason: 'stop' };
      }
      assert.equal(issued, false, 'Parallel calls replayed');
      assert.ok(request.body.messages.some(message => JSON.stringify(message).includes(`[devryan-native-case:${caseID}]`)));
      assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'write'), 'Native write absent from registry');
      issued = true;
      return { items: calls.map(call => ({ type: 'toolCall', ...call })), reason: 'tool-calls' };
    },
    complete: () => assert.ok(issued && completed, 'Eight concurrent native calls did not finish'),
  };
};

// One real parent conversation and its real managed child share the transport.
// Session creation, scheduling and task identity stay in the product owner.
export const managedTaskTurn = (caseID, agent) => {
  assert.ok(typeof agent === 'string' && agent.length > 0, 'Managed saved agent required');
  assert.match(caseID, /^[a-z0-9-]+$/, 'Owned managed fixture case identity required');
  const childWriterFile = caseID === 'managed-child' ? 'managed-child.txt' : `managed-${caseID}.txt`;
  const marker = `[devryan-native-case:${caseID}]`;
  const childMarker = `[devryan-native-managed-child:${caseID}]`;
  const startID = `native_${caseID}_start`, waitID = `native_${caseID}_wait`, writerID = `native_${caseID}_child_write`;
  let started = false, waited = false, childIssued = false, childComplete = false, parentComplete = false;
  let taskID, startResult, waitResult;
  const parsedResult = message => {
    assert.equal(typeof message.content, 'string', 'Native managed result must be serialized content');
    const value = JSON.parse(message.content);
    assert.ok(isRecord(value) && isRecord(value.task), 'Native managed result missing task');
    return value;
  };
  return {
    marker, childMarker, callIDs: { startID, waitID, writerID },
    responder: request => {
      assert.ok(isRecord(request.body) && Array.isArray(request.body.messages), 'Missing managed model messages');
      const messages = request.body.messages;
      const childResult = messages.find(message => isRecord(message) && message.role === 'tool' && message.tool_call_id === writerID);
      if (childResult) {
        assert.ok(childIssued && !childComplete, 'Managed child result was replayed');
        childComplete = true;
        return { items: [{ type: 'textDelta', text: `managed child completed ${caseID}` }], reason: 'stop' };
      }
      // The child prompt has its own distinct marker. Parent start args contain
      // it too, so only a user message can select the child branch.
      if (messages.some(message => isRecord(message) && message.role === 'user' && JSON.stringify(message.content).includes(childMarker)
        && !JSON.stringify(message.content).includes(marker))) {
        assert.equal(childIssued, false, 'Managed child inference replayed');
        assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'write'), 'Managed child native writer missing');
        childIssued = true;
        return { items: [{ type: 'toolCall', index: 0, id: writerID, name: 'write',
          input: { path: childWriterFile, content: `managed writer ${caseID}\n` } }], reason: 'tool-calls' };
      }
      const waitedResult = messages.find(message => isRecord(message) && message.role === 'tool' && message.tool_call_id === waitID);
      if (waitedResult) {
        waitResult = parsedResult(waitedResult);
        assert.equal(waitResult.task.taskId, taskID, 'Managed wait returned another task');
        const reason = typeof waitResult.task.failureReason === 'string' ? waitResult.task.failureReason.slice(0, 256) : 'no failure reason';
        assert.equal(waitResult.task.status, 'completed', `Managed child did not complete successfully: ${reason}`);
        assert.ok(waited && childComplete && !parentComplete, 'Parent resumed before actual managed child completion');
        parentComplete = true;
        return { items: [{ type: 'textDelta', text: `completed ${caseID}` }], reason: 'stop' };
      }
      const submitted = messages.find(message => isRecord(message) && message.role === 'tool' && message.tool_call_id === startID);
      if (submitted) {
        assert.ok(started && !waited, 'Managed start result was replayed');
        startResult = parsedResult(submitted); taskID = startResult.task.taskId;
        assert.ok(typeof taskID === 'string' && taskID.length > 0, 'Product managed task identity missing');
        waited = true;
        return { items: [{ type: 'toolCall', index: 0, id: waitID, name: 'devryan_task', input: { action: 'wait', task_id: taskID } }], reason: 'tool-calls' };
      }
      assert.equal(started, false, 'Parent inference omitted exact managed result');
      assert.ok(messages.some(message => JSON.stringify(message).includes(marker)), 'Unrelated managed model request');
      assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'devryan_task'), 'Native managed task registry missing');
      started = true;
      return { items: [{ type: 'toolCall', index: 0, id: startID, name: 'devryan_task', input: { action: 'start', agent,
        prompt: `${childMarker} Write ${childWriterFile} using the native writer, then report completion.`, label: `Native ${caseID}` } }], reason: 'tool-calls' };
    },
    complete: () => {
      assert.ok(started && waited && childIssued && childComplete && parentComplete, 'Managed parent/child provider path incomplete');
      return { taskID, startResult, waitResult, childWriterCallID: writerID, childWriterFile };
    },
  };
};

export const backgroundShellTurn = (caseID, input) => {
  const id = `native_${caseID}`, marker = `[devryan-native-case:${caseID}]`;
  let issued = false, returned = false, completed = false, shellID;
  return { marker,
    responder: request => {
      assert.ok(isRecord(request.body) && Array.isArray(request.body.messages), 'Missing background model messages');
      const messages = request.body.messages;
      if (returned && messages.some(message => isRecord(message) && message.role === 'user'
        && (typeof message.content === 'string' ? message.content : Array.isArray(message.content)
          ? message.content.filter(part => isRecord(part) && part.type === 'text').map(part => part.text).join('\n') : '')
          .includes(`<shell id="${shellID}" state="completed"`))) {
        assert.equal(completed, false, 'Background completion notification replayed'); completed = true;
        return { items: [{ type: 'textDelta', text: `completed ${caseID}` }], reason: 'stop' };
      }
      const result = messages.find(message => isRecord(message) && message.role === 'tool' && message.tool_call_id === id);
      if (result) {
        assert.ok(issued && !returned, 'Background caller result replayed or completion identity missing');
        const match = String(result.content).match(/shell ID: ([^)]+)/);
        assert.ok(match, 'Native background result omitted actual shell identity'); shellID = match[1]; returned = true;
        return { items: [{ type: 'textDelta', text: `background launched ${caseID}` }], reason: 'stop' };
      }
      assert.equal(issued, false);
      assert.ok(messages.some(message => JSON.stringify(message).includes(marker)), 'Unrelated background inference');
      assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'shell'), 'Native shell absent from registry');
      issued = true;
      return { items: [{ type: 'toolCall', index: 0, id, name: 'shell', input: { ...input, background: true } }], reason: 'tool-calls' };
    },
    complete: () => { assert.ok(issued && returned && completed, 'Background tool result did not reach its owned completion wake'); return { shellID }; },
  };
};
