import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCursorChangeOutbox } from './cursor-session-changes.js';
import { normalizeInteractionUpdateToSdkMessage } from './interaction-update-normalize.js';
import { mergeCursorNativeTaskActivity } from './cursor-native-task.js';
import { createCursorSdkRuntime } from './index.js';

let base;
beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-change-outbox-')); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });
const patch = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+' + 'x'.repeat(5000) + '\n';
const nested = (index) => normalizeInteractionUpdateToSdkMessage({ type: 'tool-call-delta', callId: 'task_1',
  taskUpdate: { type: 'tool-call-completed', callId: `edit_${index}`, toolCall: { type: 'edit', args: { path: 'file.txt', ignored: 'not a receipt' },
    result: { status: 'success', value: { diffString: patch, transcriptPath: 'private-transcript', conversationSteps: ['not a receipt'] } } } } });

test('full execution diffs survive string and row preview limits without expanding the projection', () => {
  let projection;
  const receipts = [];
  for (let i = 0; i < 32; i++) {
    const message = nested(i);
    receipts.push(message.sessionChange);
    projection = mergeCursorNativeTaskActivity(projection, message);
    expect(message.update.result.value.diffString.length).toBeLessThan(patch.length);
  }
  expect(projection.entries).toHaveLength(24);
  expect(receipts).toHaveLength(32);
  for (const receipt of receipts) {
    expect(receipt.metadata.diff).toBe(patch);
    expect(receipt).toMatchObject({ parentCallID: 'task_1', tool: 'edit', state: 'completed' });
    expect(JSON.stringify(receipt)).not.toContain('private-transcript');
    expect(JSON.stringify(receipt)).not.toContain('not a receipt');
  }
});

test('unacknowledged receipts survive restart, delivery is ordered and acknowledged records stop replaying', async () => {
  const identity = { sessionID: 'ses_one', messageID: 'msg_one', directory: base };
  const initial = createCursorChangeOutbox({ directory: base, deliver: async () => { throw new Error('offline'); } });
  await initial.append({ ...identity, ...nested(1).sessionChange });
  await initial.append({ ...identity, phase: 'run-settled' });
  expect(await initial.replay('ses_one')).toEqual({ pending: false, reasons: ['execution_delivery_failed'] });
  await initial.drain();
  const received = [];
  const restarted = createCursorChangeOutbox({ directory: base, deliver: async (input) => { received.push(input); return { acknowledged: true }; } });
  expect(await restarted.replay('ses_one')).toEqual({ pending: false, reasons: [] });
  expect(received.map((value) => value.phase)).toEqual(['tool', 'run-settled']);
  expect(received[0].metadata.diff).toBe(patch);
  await restarted.replay('ses_one'); expect(received).toHaveLength(2);
  await restarted.remove('ses_one'); expect(await restarted.has('ses_one')).toBe(false);
});

test('delivery in progress does not block durable appends or cross session boundaries', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const received = [];
  const outbox = createCursorChangeOutbox({ directory: base, deliver: async (input) => {
    if (input.callID === 'first') await waiting;
    received.push(input.callID); return { acknowledged: true };
  } });
  await outbox.append({ sessionID: 'ses_one', callID: 'first' });
  const delivery = outbox.replay('ses_one');
  await outbox.append({ sessionID: 'ses_one', callID: 'second' });
  await outbox.append({ sessionID: 'ses_two', callID: 'foreign' });
  release(); await delivery; await outbox.replay('ses_one');
  expect(received).toEqual(['first', 'second']);
  await outbox.drain();
});

test('the runtime persists every native edit separately and exposes only bounded task activity', async () => {
  const received = [], publicEvents = [];
  let idle;
  const done = new Promise((resolve) => { idle = resolve; });
  const runtime = createCursorSdkRuntime({ storageDir: base, env: {}, readAuth: () => ({ 'cursor-acp': { key: 'fixture-key' } }),
    getWorkspaceDiff: async () => '', onSessionChangeExecution: async (input) => { received.push(input); return { acknowledged: true }; },
    emitEvent: (event) => { publicEvents.push(event); if (event.type === 'session.status' && event.properties.status.type === 'idle') idle(); },
    createPromptRun: async () => ({ cancel: async () => {}, stream: async function* () {
      yield { type: 'message', message: { type: 'tool_call', name: 'task', call_id: 'task_1', status: 'running' } };
      for (let i = 0; i < 32; i++) yield { type: 'message', message: nested(i) };
      yield { type: 'message', message: { type: 'tool_call', name: 'task', call_id: 'task_1', status: 'completed' } };
      yield { type: 'message', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'Finished.' }] } } };
    } }),
  });
  try {
    await runtime.handlePromptAsync({ sessionID: 'ses_one', directory: base, body: {
      model: { providerID: 'cursor-acp', modelID: 'composer-2.5' }, messageID: 'msg_one', parts: [{ type: 'text', text: 'Edit files.' }],
    } });
    await done;
    expect(await runtime.reconcileSessionChanges({ sessionID: 'ses_one', directory: base })).toEqual({ pending: false, reasons: [] });
    const edits = received.filter((value) => value.parentCallID);
    expect(edits).toHaveLength(32);
    expect(edits.every((value) => value.sessionID === 'ses_one' && value.metadata.diff === patch)).toBe(true);
    expect(received.some((value) => value.phase === 'run-settled')).toBe(true);
    const records = await runtime.getSessionMessages('ses_one');
    expect(records.find((record) => record.info.role === 'assistant').parts.find((part) => part.tool === 'task').state.metadata.cursorNativeTask.entries).toHaveLength(24);
    expect(JSON.stringify(records)).not.toContain(patch);
    expect(JSON.stringify(publicEvents)).not.toContain('sessionChange');
    expect(JSON.stringify(publicEvents)).not.toContain(patch);
  } finally { await runtime.dispose(); }
}, 20_000);
