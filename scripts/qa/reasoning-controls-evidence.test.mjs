import { createHash } from 'node:crypto';
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

// Synthetic contract records; physical runtime qualification is separate.
const nativeInput = { ...input, directory: '/fixture', configurationDigest: 'a'.repeat(64), agent: 'orchestrator' };
const nativeRows = (variant = null, options = { reasoningEffort: 'medium' }) => {
  const common = { schema: 1, controllerInstanceID: 'controller', configurationDigest: 'a'.repeat(64), sessionID: 'ses_root', directory: `<WORKTREE_${createHash('sha256').update('/fixture').digest('hex').slice(0, 12)}>` };
  const execution = { agent: 'orchestrator', providerID: 'openai', modelID: 'qa-model', variant };
  return [
    { ...common, stage: 'accepted-user', messageID: 'msg_user', fingerprint: 'b'.repeat(64), intent: { source: 'prompt', variantPresent: true, variant }, execution },
    { ...common, stage: 'model-prepared', requestID: 'request', kind: 'primary', execution, options, hookOptions: options, modelLimits: { context: 100, input: 80, output: 20 } },
    { ...common, stage: 'physical', requestID: 'request', kind: 'primary', transport: 'http', wireOptions: options, ordinal: 1, attempt: { traceID: 'trace', spanID: 'span' } },
    { ...common, stage: 'step-link', eventID: 'event', sequence: 10, created: 1, assistantMessageID: 'msg_assistant', userMessageID: 'msg_user', execution, attempt: { traceID: 'trace', spanID: 'span' } },
  ];
};

test('native actual prepared controls need physical span and canonical step linkage', async () => {
  const { gradeQaNativeReasoningControls } = await import('./reasoning-controls-evidence.mjs');
  const result = gradeQaNativeReasoningControls({ ...nativeInput, observations: nativeRows() });
  assert.equal(result.passed, true);
  assert.equal(result.turns[0].requests[0].sequence, 10);
  assert.deepEqual(result.turns[0].nativeResolvedControls, [{ reasoningEffort: 'medium' }]);
  for (const mutation of [
    rows => rows.splice(0, 1), rows => rows.splice(1, 1), rows => rows.splice(2, 1), rows => rows.splice(3, 1),
    rows => { rows[2].wireOptions = null; }, rows => { rows[2].attempt = null; }, rows => { rows[3].attempt.spanID = 'other'; },
    rows => { rows[0].intent.variantPresent = false; delete rows[0].intent.variant; },
    rows => { rows[3].execution.modelID = 'foreign'; }, rows => { rows[1].configurationDigest = 'c'.repeat(64); },
    rows => { rows[3].controllerInstanceID = 'old-controller'; }, rows => { rows[3].directory = '/foreign'; },
  ]) {
    const observations = nativeRows(); mutation(observations);
    assert.equal(gradeQaNativeReasoningControls({ ...nativeInput, observations }).passed, false);
  }
});

test('native explicit effort uses post-hook controls and preserves unmatched pre-Step diagnostics', async () => {
  const { gradeQaNativeReasoningControls } = await import('./reasoning-controls-evidence.mjs');
  const expected = { ...nativeInput, variant: 'high', advertisedVariant: { reasoningEffort: 'high' } };
  const observations = nativeRows('high', { reasoningEffort: 'high' });
  observations.push({ ...observations[2], requestID: 'cancelled-request', attempt: null });
  const result = gradeQaNativeReasoningControls({ ...expected, observations });
  assert.equal(result.passed, true);
  assert.deepEqual(result.unmatchedPhysicalAttempts, [{ requestID: 'cancelled-request', transport: 'http', ordinal: 1,
    attempt: null, reason: 'missing-prepared' }]);
  assert.equal(gradeQaNativeReasoningControls({ ...expected, observations: nativeRows('high', { reasoningEffort: 'medium' }) }).passed, false);
  assert.equal(gradeQaNativeReasoningControls({ ...expected, observations: nativeRows(null, { reasoningEffort: 'high' }) }).passed, false);
  assert.equal(gradeQaNativeReasoningControls({ ...nativeInput, observations, userMessageIDs: [] }).passed, false);
});

test('final physical controls must preserve actual adapter semantics after Prepared hooks', async () => {
  const { gradeQaNativeReasoningControls } = await import('./reasoning-controls-evidence.mjs');
  const expected = { ...nativeInput, variant: 'high', advertisedVariant: { reasoningEffort: 'high' } };
  for (const wireOptions of [{ reasoning: { effort: 'high' } }, { reasoning_effort: 'high' }]) {
    const observations = nativeRows('high', { reasoningEffort: 'high' }); observations[2].wireOptions = wireOptions;
    assert.equal(gradeQaNativeReasoningControls({ ...expected, observations }).passed, true);
  }
  for (const wireOptions of [null, {}, { reasoning: { effort: 'medium' } }]) {
    const observations = nativeRows('high', { reasoningEffort: 'high' }); observations[2].wireOptions = wireOptions;
    assert.equal(gradeQaNativeReasoningControls({ ...expected, observations }).passed, false);
  }
});

test('native execution null/default equivalence preserves exact original cleared intent', async () => {
  const { gradeQaNativeReasoningControls } = await import('./reasoning-controls-evidence.mjs');
  const observations = nativeRows();
  for (const row of observations) if (row.execution) row.execution.variant = 'default';
  assert.equal(gradeQaNativeReasoningControls({ ...nativeInput, observations }).passed, true);
  observations[0].intent.variant = 'default';
  assert.equal(gradeQaNativeReasoningControls({ ...nativeInput, observations }).passed, false);
  observations[0].intent.variant = null;
  observations[1].execution.variant = 'high';
  assert.equal(gradeQaNativeReasoningControls({ ...nativeInput, observations }).passed, false);
});
