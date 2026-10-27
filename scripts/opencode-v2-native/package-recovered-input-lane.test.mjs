import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFirstPromptWithoutTools, assertZeroEditRevert } from './package-recovered-input-lane.mjs';

test('first-prompt Stop proof rejects missing, extra or tool-bearing history', () => {
  const page = { records: [{ info: { id: 'msg_first', role: 'user' }, parts: [] },
    { info: { id: 'msg_assistant', role: 'assistant' }, parts: [{ type: 'text', text: 'waiting' }] }] };
  assertFirstPromptWithoutTools(page, 'msg_first');
  assert.throws(() => assertFirstPromptWithoutTools(page, 'msg_other'));
  assert.throws(() => assertFirstPromptWithoutTools({ records: [...page.records, page.records[0]] }, 'msg_first'));
  assert.throws(() => assertFirstPromptWithoutTools({ records: [...page.records, { info: { role: 'assistant' }, parts: [{ type: 'tool' }] }] }, 'msg_first'));
});

test('zero-edit Revert proof requires the exact native conversation marker', () => {
  const result = { verification: { ok: true }, reverted: { files: [] }, revert: { messageID: 'msg_first', fileRestore: false } };
  assertZeroEditRevert(result, 'msg_first');
  for (const bad of [{ ...result, reverted: { files: [{ path: 'x' }] } },
    { ...result, revert: { messageID: 'msg_other', fileRestore: false } },
    { ...result, revert: { messageID: 'msg_first', fileRestore: true } }, { ...result, verification: { ok: false } }]) {
    assert.throws(() => assertZeroEditRevert(bad, 'msg_first'));
  }
});
