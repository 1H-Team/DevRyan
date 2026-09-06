import assert from 'node:assert/strict';
import test from 'node:test';
import { createQaTerminalPermissionGuard, findQaTerminalPermissionDenial } from './terminal-permission.mjs';

const sample = () => {
  const user = { info: { id: 'msg_user', role: 'user', sessionID: 'ses_test', time: { created: 100 } }, parts: [] };
  const assistant = { info: { id: 'msg_answer', role: 'assistant', parentID: 'msg_user', sessionID: 'ses_test',
    finish: 'tool-calls', time: { created: 110, completed: 150 } }, parts: [
    { id: 'prt_read', type: 'tool', tool: 'read', callID: 'call_read', messageID: 'msg_answer', sessionID: 'ses_test',
      state: { status: 'error', error: 'arbitrary provider text that is never classified' } },
  ] };
  return { rows: [user, assistant], previousIds: new Set(), submittedUser: user, sessionID: 'ses_test', status: {},
    observations: [
      { kind: 'native.permission.asked', at: 120, sessionID: 'ses_test', requestID: 'per_test', messageID: 'msg_answer', callID: 'call_read' },
      { kind: 'native.permission.replied', at: 140, sessionID: 'ses_test', requestID: 'per_test', reply: 'reject' },
    ] };
};

test('terminal rejection requires the same canonical completed assistant and idle state across two fresh polls', () => {
  const guard = createQaTerminalPermissionGuard();
  assert.equal(guard(sample()), null);
  const result = guard(sample());
  assert.equal(result.requestID, 'per_test');
  assert.equal(result.callID, 'call_read');
  assert.equal(result.assistantMessageID, 'msg_answer');
  const explicitIdle = sample(); explicitIdle.status.ses_test = { type: 'idle' };
  assert.equal(findQaTerminalPermissionDenial(explicitIdle).requestID, 'per_test');
});

test('tool-error prose, stale records, unproven parents, mismatched IDs and incomplete work cannot establish terminal rejection', () => {
  const mutations = [
    input => { input.observations = []; },
    input => { input.observations[1].reply = 'once'; },
    input => { input.observations[1].reply = 'always'; },
    input => { input.observations[1].sessionID = 'other'; },
    input => { input.observations[1].requestID = 'other'; },
    input => { input.observations[0].callID = 'other'; },
    input => { input.observations[0].messageID = 'other'; },
    input => { input.observations[0].at = 90; },
    input => { input.observations[1].at = 110; },
    input => { input.observations[1].at = 160; },
    input => { input.previousIds.add('msg_answer'); },
    input => { input.previousIds.add('msg_user'); },
    input => { input.rows[1].info.parentID = 'unproven-continuation'; },
    input => { input.rows[1].info.finish = 'stop'; },
    input => { delete input.rows[1].info.time.completed; },
    input => { input.rows[1].info.summary = true; },
    input => { input.rows[1].parts[0].state.status = 'running'; },
    input => { input.rows[1].parts[0].messageID = 'other'; },
    input => { input.status.ses_test = { type: 'busy' }; },
    input => { input.rows.push({ info: { id: 'later_user', role: 'user' }, parts: [] }); },
  ];
  for (const mutate of mutations) { const input = sample(); mutate(input); assert.equal(findQaTerminalPermissionDenial(input), null); }
});

test('a busy transition or new continuation clears the first idle observation', () => {
  const guard = createQaTerminalPermissionGuard();
  assert.equal(guard(sample()), null);
  const busy = sample(); busy.status.ses_test = { type: 'busy' };
  assert.equal(guard(busy), null);
  assert.equal(guard(sample()), null);
  const newer = sample(); newer.rows.push({ info: { id: 'msg_continued', role: 'assistant', parentID: 'msg_user',
    sessionID: 'ses_test', finish: 'stop', time: { completed: 170 } }, parts: [] });
  assert.equal(guard(newer), null);
  assert.equal(guard(sample()), null);
  assert.ok(guard(sample()));
});
