import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildCaseDefinition, executeEvaluationCase, runNodeTests } from './cases.mjs';
import { allocateRunFiles, assertFixtureReady } from './fixture.mjs';
import { spawnSync } from 'node:child_process';
import { ROUTING_CASES, routingSource, collectRoutingEvidence, collectRoutingMetrics } from './routing-cases.mjs';
import { EVALUATION_CASE_IDS } from './config.mjs';
import { gradeRoutingOutcome, gradeToolRequirements } from './graders.mjs';
import { runSessionTurn } from './client.mjs';

const repaired = (caseId) => ROUTING_CASES[caseId].kind === 'behavior'
  ? routingSource.replace('return price ?', 'return price != null ?')
  : routingSource.replace('gap:4px', 'gap:24px').replace('gap:2px', 'gap:8px')
    .replace('background:green;color:white', 'background:white;color:#333')
    .replace("(needsReview ? '<span>Needs Review</span>' : '') + '<span class=\"service-type\">Procedure</span>'",
      "'<span class=\"service-type\">Procedure</span>' + (needsReview ? '<span>Needs Review</span>' : '')");

for (const [caseId, scenario] of Object.entries(ROUTING_CASES)) {
  test(`${caseId} observes a failing baseline, grades the dispatched role, and restores its fixture`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-routing-eval-'));
    try {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'README.md'), '# Isolated routing fixture\n');
      for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', 'commit', '-qm', 'fixture']]) {
        assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
      }
      const startingManifest = assertFixtureReady(root);
      const runFiles = allocateRunFiles(root, caseId);
      assert.ok(EVALUATION_CASE_IDS.includes(caseId));
      const definition = buildCaseDefinition(caseId, runFiles);
      assert.doesNotMatch(definition.prompt, /\b(?:Designer|Fixer)\b/i);
      assert.equal(definition.followUpPrompt, scenario.approved ? 'implement plan' : undefined);
      const testResults = [];
      const result = await executeEvaluationCase({
        caseId, repetition: 1, fixtureRoot: root, runFiles, startingManifest,
        selection: { providerId: 'fixture', modelId: 'fixture', agent: 'orchestrator', variant: null }, timeoutMs: 30000,
        testRunner: async options => {
          const result = await runNodeTests(options);
          testResults.push(result);
          return result;
        },
        sessionRunner: async options => {
          assert.equal(options.followUpPrompt, definition.followUpPrompt);
          if (!scenario.readOnly) writeFileSync(runFiles.sourcePath, repaired(caseId));
          return {
            rootSessionId: 'root', childSessionIds: scenario.agent ? ['child'] : [],
            routingEvidence: scenario.kind === 'footer' ? { located: true, cause: true, verification: true }
              : scenario.kind === 'inventory' ? { counts: { identity: 180, billing: 180, session: 180, elevated: 135 } } : null,
            terminalEvidence: { complete: true },
            tools: [...(scenario.agent ? [{ tool: 'devryan_task', status: 'completed', sessionScope: 'root' }] : []),
              { tool: scenario.readOnly ? 'read' : 'edit', status: 'completed', sessionScope: scenario.agent ? 'child' : 'root' }],
            managedSnapshot: {
              tasks: scenario.agent ? [{ taskId: 'task', rootSessionId: 'root', childSessionId: 'child', agent: scenario.agent, status: 'completed' }] : [],
              resultEnvelopes: [{ taskId: 'task', status: 'completed', action: 'continue' }],
            },
          };
        },
      });
      assert.equal(testResults.length, scenario.readOnly ? 1 : 2);
      assert.equal(testResults[0].timedOut, false);
      if (!scenario.readOnly) assert.match(testResults[0].stdout + testResults[0].stderr, /ERR_ASSERTION/);
      assert.equal(testResults.at(-1).timedOut, false);
      assert.equal(result.status, 'passed', JSON.stringify(result.graders));
      assertFixtureReady(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('routing fails closed on missing, wrong, foreign, or duplicate specialist evidence', () => {
  const task = { rootSessionId: 'root', agent: 'designer' };
  const grade = snapshot => gradeRoutingOutcome({ caseId: 'routing-approved-visual', rootSessionId: 'root', snapshot }).passed;
  assert.equal(grade({ tasks: [task] }), true);
  for (const snapshot of [undefined, { tasks: [] }, { available: false, tasks: [task] },
    { tasks: [{ ...task, agent: 'fixer' }] }, { tasks: [{ ...task, agent: null }] },
    { tasks: [{ ...task, rootSessionId: 'other' }] }, { tasks: [task, task] }]) {
    assert.equal(grade(snapshot), false);
  }
  assert.equal(gradeToolRequirements('routing-visual', [
    { tool: 'devryan_task', final: true, sessionScope: 'root' },
    { tool: 'edit', final: true, sessionScope: 'root' },
  ]).passed, false);
});

test('plan approval waits for new turn evidence and preserves the actual dispatched role', async () => {
  const prompts = [];
  let followUpReads = 0;
  const plan = { info: { id: 'plan', role: 'assistant', finish: 'stop' }, parts: [] };
  const done = { info: { id: 'implementation', role: 'assistant', finish: 'stop' }, parts: [] };
  const client = {
    pollIntervalMs: 1,
    createSession: async () => ({ id: 'root' }),
    promptSession: async (_id, _directory, _selection, prompt) => { prompts.push(prompt); },
    getStatuses: async () => { if (prompts.length === 2) followUpReads++; return {}; },
    getMessages: async id => id === 'child' ? [done] : prompts.length === 2 && followUpReads >= 4 ? [plan, done] : [plan],
    getChildren: async id => id === 'root' && followUpReads >= 4 ? [{ id: 'child' }] : [],
    getManagedSnapshot: async () => ({ tasks: followUpReads >= 4
      ? [{ taskId: 'task', rootSessionId: 'root', childSessionId: 'child', agent: 'fixer', status: 'completed' }]
      : [], resultEnvelopes: [] }),
    getTurnTiming: async () => ({ records: [] }),
  };
  const result = await runSessionTurn({ client, directory: '/fixture',
    selection: { providerId: 'fixture', modelId: 'fixture', agent: 'orchestrator', variant: null },
    prompt: 'Plan visual changes only', followUpPrompt: 'implement plan', caseId: 'routing-approved-visual', timeoutMs: 2000 });
  assert.deepEqual(prompts, ['Plan visual changes only', 'implement plan']);
  assert.ok(followUpReads >= 5);
  assert.equal(result.terminalEvidence.complete, true);
  assert.equal(result.managedSnapshot.tasks[0].agent, 'fixer');
  assert.equal(gradeRoutingOutcome({ caseId: 'routing-approved-visual', rootSessionId: 'root', snapshot: result.managedSnapshot }).passed, false);
});

test('direct routing rejects any child and requires evidence for a footer plan', () => {
  const input = { caseId: 'routing-footer-plan', rootSessionId: 'root', snapshot: { tasks: [] }, childSessionIds: [],
    evidence: { located: true, cause: true, verification: true } };
  assert.equal(gradeRoutingOutcome(input).passed, true);
  assert.equal(gradeRoutingOutcome({ ...input, childSessionIds: ['hidden-child'] }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, evidence: { located: true } }).passed, false);
  assert.equal(gradeToolRequirements(input.caseId, [
    { tool: 'read', status: 'completed', sessionScope: 'root' },
    { tool: 'edit', status: 'completed', sessionScope: 'root' },
  ]).passed, false);
  const evidence = collectRoutingEvidence(input.caseId, [{ sessionId: 'root', messages: [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'src/footer.js uses a count threshold of 5; add a regression test.' }] },
  ] }], 'root', 'src/footer.js');
  assert.deepEqual(evidence, input.evidence);
});

test('routing latency metrics union overlapping calls and retain only numbers', () => {
  const tool = (name, start, end, filePath) => ({ type: 'tool', tool: name, state: { status: 'completed', time: { start, end }, input: { filePath } } });
  const metrics = collectRoutingMetrics([
    { sessionId: 'root', messages: [{ parts: [tool('task', 120, 500)] }] },
    { sessionId: 'child', messages: [{ parts: [tool('read', 200, 250, '/fixture/footer.js'), tool('grep', 300, 400)] }] },
  ], 'root', '/fixture/footer.js', 100, 600);
  assert.deepEqual(metrics, { componentLocationMs: 150, completionMs: 500, toolDurationMs: 380, childCount: 1 });
});
