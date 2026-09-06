import assert from 'node:assert/strict';
import test from 'node:test';
import { assertQaSubmittedPlanMode, findQaSubmittedUser, findQaTurnAssistants, findQaCompletedTurnAssistant } from './submitted-turn.mjs';
import { createQaTerminalPermissionGuard } from './terminal-permission.mjs';

test('native compaction and continuation do not replace the submitted human identity', () => {
  const rows = [
    { info: { id: 'msg_old', role: 'user' }, parts: [{ type: 'text', text: 'Revise the plan' }] },
    { info: { id: 'msg_human', role: 'user' }, parts: [{ type: 'text', text: 'Revise the plan' },
      { type: 'text', text: 'User has requested to enter plan mode', synthetic: true }] },
    { info: { id: 'msg_compact', role: 'user' }, parts: [{ type: 'compaction', auto: true }] },
    { info: { id: 'msg_summary', role: 'assistant', summary: true }, parts: [] },
    { info: { id: 'msg_continue', role: 'user' }, parts: [{ type: 'text', text: 'Revise the plan', synthetic: true }] },
    { info: { id: 'msg_answer', role: 'assistant', parentID: 'msg_continue' }, parts: [] },
  ];
  const previous = new Set(['msg_old']);
  assert.equal(findQaSubmittedUser(rows, previous, 'Revise the plan').info.id, 'msg_human');
  assert.deepEqual(findQaTurnAssistants(rows, previous, 'msg_human').map(row => row.info.id), ['msg_answer']);
});

test('duplicate submissions fail while absent or generated-only input cannot settle a turn', () => {
  const row = { info: { id: 'msg_first', role: 'user' }, parts: [{ type: 'text', text: 'Continue' }] };
  assert.equal(findQaSubmittedUser([], new Set(), 'Continue'), null);
  assert.equal(findQaSubmittedUser([{ ...row, parts: [{ type: 'text', text: 'Continue', synthetic: true }] }], new Set(), 'Continue'), null);
  assert.throws(() => findQaSubmittedUser([row, { ...row, info: { ...row.info, id: 'msg_second' } }], new Set(), 'Continue'), /multiple matching canonical/);
  assert.deepEqual(findQaTurnAssistants([{ info: { id: 'msg_answer', role: 'assistant' } }], new Set(), 'missing'), []);
});

test('native attachment captions and file content do not change the exact submitted input', () => {
  const user = { info: { id: 'msg_attached', role: 'user' }, parts: [
    { type: 'text', text: 'Read the attached requirements and investigate the defects.' },
    { type: 'text', text: 'Attached file: brief.txt' },
    { type: 'text', text: 'Attached file: brief.txt\nMIME: text/plain\n<file_content>requirements</file_content>', synthetic: true },
    { type: 'file', mime: 'image/png', filename: 'priority-reference.png' },
  ] };
  assert.equal(findQaSubmittedUser([user], new Set(), user.parts[0].text), user);
  assert.equal(findQaSubmittedUser([user], new Set(['msg_attached']), user.parts[0].text), null);
  assert.throws(() => findQaSubmittedUser([{ ...user, parts: [...user.parts, user.parts[0]] }], new Set(), user.parts[0].text), /multiple exact submitted input parts/);
});

test('input matching follows the composer LF boundary without trimming meaningful spaces', () => {
  const user = { info: { id: 'msg_batch', role: 'user' }, parts: [{ type: 'text', text: ' Audit batch\nrecord 1 ' }] };
  assert.equal(findQaSubmittedUser([user], new Set(), '\n\n Audit batch\nrecord 1 \n'), user);
  assert.equal(findQaSubmittedUser([user], new Set(), 'Audit batch\nrecord 1'), null);
});

test('canonical Plan mode requires the app instruction and detects a lost toggle', () => {
  const plain = { parts: [{ type: 'text', text: 'Keep implementation paused and preserve the plan.' }] };
  const planned = { parts: [...plain.parts, { type: 'text', synthetic: true, text: 'User has requested to enter plan mode\nRead-only constraints apply.' }] };
  assert.equal(assertQaSubmittedPlanMode(planned, true), true);
  assert.equal(assertQaSubmittedPlanMode(plain, false), false);
  assert.throws(() => assertQaSubmittedPlanMode(plain, true), /changed Plan mode/);
  assert.throws(() => assertQaSubmittedPlanMode(planned, false), /changed Plan mode/);
  assert.equal(assertQaSubmittedPlanMode({ parts: [{ type: 'text', text: planned.parts[1].text }] }, false), false);
});

const completedTurn = () => {
  const user = { info: { id: 'msg_human', role: 'user', sessionID: 'ses_test', time: { created: 100 } },
    parts: [{ type: 'text', text: 'Continue' }] };
  const answer = { info: { id: 'msg_answer', role: 'assistant', sessionID: 'ses_test', parentID: user.info.id,
    finish: 'stop', time: { created: 110, completed: 150 } }, parts: [] };
  return { rows: [user, answer], previousIds: new Set(), submittedUser: user, sessionID: 'ses_test', status: {} };
};

test('only a fresh completed canonical tail settles the exact human turn while idle', () => {
  const input = completedTurn();
  assert.equal(findQaCompletedTurnAssistant(input), input.rows.at(-1));
  input.status.ses_test = { type: 'idle' };
  assert.equal(findQaCompletedTurnAssistant(input), input.rows.at(-1));
  const mutations = [
    value => { value.rows = []; },
    value => { value.rows.shift(); },
    value => { value.previousIds.add('msg_human'); },
    value => { value.previousIds.add('msg_answer'); },
    value => { value.submittedUser.info.sessionID = 'ses_other'; },
    value => { delete value.submittedUser.info.time.created; },
    value => { value.rows.at(-1).info.sessionID = 'ses_other'; },
    value => { delete value.rows.at(-1).info.time.completed; },
    value => { value.rows.at(-1).info.time.completed = NaN; },
    value => { value.rows.at(-1).info.time.completed = 90; },
    value => { delete value.rows.at(-1).info.finish; },
    value => { value.rows.at(-1).info.finish = 'tool-calls'; },
    value => { value.rows.at(-1).info.error = { name: 'ProviderError' }; },
    value => { value.status.ses_test = { type: 'busy' }; },
    value => { value.status.ses_test = { type: 'retry' }; },
    value => { value.rows.push({ info: { id: 'msg_generated', role: 'user', sessionID: 'ses_test' }, parts: [] }); },
    value => { value.rows.push({ info: { id: 'msg_summary', role: 'assistant', sessionID: 'ses_test', summary: true,
      finish: 'stop', time: { completed: 170 } }, parts: [] }); },
    value => { value.rows.push({ info: { id: 'msg_pending', role: 'assistant', sessionID: 'ses_test', time: { created: 170 } }, parts: [] }); },
    value => { value.rows.push({ info: { id: 'msg_old', role: 'assistant', sessionID: 'ses_test', finish: 'stop',
      time: { completed: 90 } }, parts: [] }); value.previousIds.add('msg_old'); },
  ];
  for (const mutate of mutations) { const value = completedTurn(); mutate(value); assert.equal(findQaCompletedTurnAssistant(value), null); }
});

test('a completed native continuation tail remains eligible after generated compaction records', () => {
  const input = completedTurn();
  const continuation = { info: { id: 'msg_continued', role: 'assistant', sessionID: 'ses_test', parentID: 'msg_generated',
    finish: 'stop', time: { created: 180, completed: 200 } }, parts: [] };
  input.rows.push(
    { info: { id: 'msg_compaction', role: 'user', sessionID: 'ses_test' }, parts: [{ type: 'compaction' }] },
    { info: { id: 'msg_summary', role: 'assistant', sessionID: 'ses_test', summary: true, time: { completed: 170 } }, parts: [] },
    { info: { id: 'msg_generated', role: 'user', sessionID: 'ses_test' }, parts: [{ type: 'text', synthetic: true, text: 'Continue' }] },
    continuation,
  );
  assert.equal(findQaCompletedTurnAssistant(input), continuation);
});

test('an earlier completed answer cannot bypass the current denial second-poll confirmation', () => {
  const input = completedTurn();
  input.rows.push({ info: { id: 'msg_denied', role: 'assistant', sessionID: 'ses_test', parentID: 'msg_human',
    finish: 'tool-calls', time: { created: 160, completed: 200 } }, parts: [
    { type: 'tool', sessionID: 'ses_test', messageID: 'msg_denied', callID: 'call_read', state: { status: 'error' } },
  ] });
  input.observations = [
    { kind: 'native.permission.asked', sessionID: 'ses_test', messageID: 'msg_denied', callID: 'call_read', requestID: 'per_read', at: 170 },
    { kind: 'native.permission.replied', sessionID: 'ses_test', requestID: 'per_read', reply: 'reject', at: 190 },
  ];
  const guard = createQaTerminalPermissionGuard();
  assert.equal(guard(input), null);
  assert.equal(findQaCompletedTurnAssistant(input), null);
  assert.equal(guard(input).requestID, 'per_read');
  assert.equal(findQaCompletedTurnAssistant(input), null);
});
