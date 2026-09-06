import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeQaReasoningControls, projectReasoningOptions } from './reasoning-controls-evidence.mjs';

const input = { sessionID: 'ses_root', providerID: 'openai', modelID: 'qa-model', userMessageIDs: ['msg_user'], variant: null };
const rows = (variant, options) => [
  { kind: 'chat.message', sessionID: 'ses_root', messageID: 'msg_user', providerID: 'openai', modelID: 'qa-model', variant, variantPresent: true },
  { kind: 'chat.params', sessionID: 'ses_root', messageID: 'msg_user', providerID: 'openai', modelID: 'qa-model', options },
];

test('default clears the agent variant while reporting native adapter defaults', () => {
  const grade = gradeQaReasoningControls({ ...input, observations: rows('', { reasoningEffort: 'medium' }) });
  assert.equal(grade.passed, true);
  assert.deepEqual(grade.turns[0].nativeResolvedControls, [{ reasoningEffort: 'medium' }]);
  assert.equal(grade.providerWireControls, 'not-captured');
  assert.equal(gradeQaReasoningControls({ ...input, observations: rows('medium', { reasoningEffort: 'medium' }) }).passed, false);
});

test('explicit thinking must reach the native controls advertised by the adapter', () => {
  const expected = { ...input, variant: 'high', advertisedVariant: { thinking: { type: 'adaptive' }, outputConfig: { effort: 'high' } } };
  assert.equal(gradeQaReasoningControls({ ...expected, observations: rows('high', { thinking: { type: 'adaptive' }, outputConfig: { effort: 'high' } }) }).passed, true);
  assert.equal(gradeQaReasoningControls({ ...expected, observations: rows('high', { outputConfig: { effort: 'medium' } }) }).passed, false);
});

test('missing, foreign or unsupported control evidence cannot establish acceptance', () => {
  assert.equal(gradeQaReasoningControls({ ...input, observations: [] }).passed, false);
  assert.equal(gradeQaReasoningControls({ ...input, observations: rows('', {}).map(row => ({ ...row, sessionID: 'ses_other' })) }).passed, false);
  assert.equal(gradeQaReasoningControls({ ...input, userMessageIDs: [], observations: rows('', {}) }).passed, false);
  assert.equal(gradeQaReasoningControls({ ...input, variant: 'high', advertisedVariant: {}, observations: rows('high', {}) }).passed, false);
});

test('empty or unsupported nested controls do not prove an explicit effort', () => {
  for (const advertisedVariant of [{ thinking: { unsupported: true } }, { reasoning: {} },
    { thinking: { type: null, budgetTokens: 'high' }, reasoning: { effort: '' } }]) {
    assert.deepEqual(projectReasoningOptions(advertisedVariant), {});
    assert.equal(gradeQaReasoningControls({ ...input, variant: 'high', advertisedVariant,
      observations: rows('high', { thinking: {}, reasoning: {} }) }).passed, false);
  }
  assert.deepEqual(projectReasoningOptions({ thinking: { budgetTokens: 0 }, reasoning: { effort: 'high' } }),
    { thinking: { budgetTokens: 0 }, reasoning: { effort: 'high' } });
});
