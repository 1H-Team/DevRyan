import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlanModeInstruction, parsePlanModeInstruction, PLAN_MODE_INSTRUCTION_PREFIX } from './plan-mode.mjs';
import { PLAN_MODE_SYSTEM_INSTRUCTIONS } from '../../packages/orchestration-runtime/index.js';

test('loads the composer Plan-mode preface with its prefix and plan-card sentinel', () => {
  const text = loadPlanModeInstruction();
  assert.ok(text.startsWith(`${PLAN_MODE_INSTRUCTION_PREFIX}.`));
  assert.match(text, /<!--plan-->/);
  assert.match(text, /\[devryan-plan-turn:v1\] planMode=true/);
  assert.ok(Buffer.byteLength(text) < 256, 'Turn metadata must not duplicate static planning guidance');
  assert.match(PLAN_MODE_SYSTEM_INSTRUCTIONS, /## Verification/);
  assert.match(PLAN_MODE_SYSTEM_INSTRUCTIONS, /do not edit files/);
  // Read-only shell is admitted in Plan mode (native-admission-owner blockedPlanWriter).
  assert.match(PLAN_MODE_SYSTEM_INSTRUCTIONS, /Read-only shell commands remain available for inspection/);
  // Captured host Plan authority survives compaction; this text grants none.
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
