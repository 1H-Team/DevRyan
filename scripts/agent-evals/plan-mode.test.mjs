import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlanModeInstruction, parsePlanModeInstruction, PLAN_MODE_INSTRUCTION_PREFIX } from './plan-mode.mjs';

test('loads the composer Plan-mode preface with its prefix and plan-card sentinel', () => {
  const text = loadPlanModeInstruction();
  assert.ok(text.startsWith(`${PLAN_MODE_INSTRUCTION_PREFIX}.`));
  assert.match(text, /<!--plan-->/);
  assert.match(text, /## Verification/);
  // A prefix-only preface cannot restore Plan authority after compaction.
  assert.ok(text.length > PLAN_MODE_INSTRUCTION_PREFIX.length + 200);
});

test('fails closed when the UI declaration changes shape', () => {
  assert.throws(() => parsePlanModeInstruction('export const other = [];'), /declaration was not found/);
  assert.throws(() => parsePlanModeInstruction(
    'export const buildPlanModeSyntheticInstruction = (): string => [\n  `template`,\n].join("\\n")',
  ), SyntaxError);
  assert.throws(() => parsePlanModeInstruction(
    'export const buildPlanModeSyntheticInstruction = (): string => [\n  "Plan please",\n].join("\\n")',
  ), /required prefix/);
});
