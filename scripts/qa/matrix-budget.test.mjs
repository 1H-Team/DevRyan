import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withQaTurnBudget, runQaMatrix } from './matrix-runner.mjs';
import { createQaClaudeBudget } from './focused-provider.mjs';

const now = 1800000000000;
const quota = usedPercent => ({ providerId: 'claude', ok: true, configured: true, usageUpdatedAt: now,
  usage: { windows: { '5h': { usedPercent, resetAt: now + 18000000, windowSeconds: 18000 } } } });

test('failed or timed-out turns sample final quota before stopping all further admission', async () => {
  for (const failure of [new Error('provider refused'), new Error('QA cell exceeded its timeout')]) {
    const budget = createQaClaudeBudget({ now: () => now }), calls = [];
    await assert.rejects(withQaTurnBudget(async () => { calls.push('active generation failed'); throw failure; }, {
      sample: async before => { calls.push(before ? 'before' : 'after'); budget.sample(quota(before ? 30 : 31), { before }); },
      stop: async () => { calls.push('stop'); budget.stop(); },
    }), error => error === failure);
    assert.deepEqual(calls, ['before', 'active generation failed', 'after', 'stop']);
    assert.equal(budget.snapshot().previous.usedPercent, 31);
    assert.equal(budget.snapshot().stopped, true);
    assert.throws(() => budget.sample(quota(31), { before: true }), { code: 'qa_claude_budget_stopped' });
  }
});

test('failed quota reads stop admission and a denied pre-sample never dispatches', async () => {
  for (const failBefore of [true, false]) {
    const calls = [], error = Error('quota unavailable');
    await assert.rejects(withQaTurnBudget(async () => { calls.push('dispatch'); }, {
      sample: async before => { calls.push(before ? 'before' : 'after'); if (before === failBefore) throw error; },
      stop: async () => { calls.push('stop'); },
    }), value => value === error);
    assert.deepEqual(calls, failBefore ? ['before', 'stop'] : ['before', 'dispatch', 'after', 'stop']);
  }
});

test('focused matrix stops after a failed first host and retains cleanup and failure evidence', async t => {
  const directory = await fs.mkdtemp(path.resolve('.cache/matrix-budget-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const providerId of ['anthropic', 'cursor-acp']) {
    const file = path.join(directory, providerId + '.json'), evidenceRoot = path.join(directory, providerId);
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, evidenceRoot, cells: ['web', 'electron'].map(runtime => ({
      id: providerId + '-' + runtime, runtime, transport: 'live', providerId, modelId: 'exact-model', variant: null,
      agent: 'builder', planMode: false, scenarioIds: ['focused-provider'], repetitions: 1, timeoutMs: 60000,
    })) }));
    const calls = [], budget = createQaClaudeBudget({ now: () => now });
    budget.sample(quota(30));
    const summary = await runQaMatrix(file, {
      claudeBudget: { stop: async () => { calls.push('stop'); budget.stop(); } },
      runCell: async cell => { calls.push(cell.runtime); return { runId: cell.runId, outcome: 'failed', interrupted: false }; },
      afterCell: async cell => { calls.push('cleanup:' + cell.runtime); },
    });
    assert.deepEqual(calls, providerId === 'anthropic' ? ['web', 'stop', 'cleanup:web'] : ['web', 'cleanup:web']);
    assert.equal(summary.completed, 1); assert.equal(summary.planned, 2); assert.equal(summary.outcome, 'failed');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(evidenceRoot, 'summary.json'), 'utf8')), summary);
    if (providerId === 'anthropic') assert.throws(() => budget.sample(quota(30), { before: true }), { code: 'qa_claude_budget_stopped' });
  }
});
