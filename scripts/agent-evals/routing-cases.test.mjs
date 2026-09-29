import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildCaseDefinition, executeEvaluationCase, runNodeTests } from './cases.mjs';
import { allocateRunFiles, assertFixtureReady } from './fixture.mjs';
import { spawnSync } from 'node:child_process';
import { ROUTING_CASES, routingFixture, routingSource, collectRoutingEvidence, collectRoutingMetrics } from './routing-cases.mjs';
import { EVALUATION_CASE_IDS } from './config.mjs';
import { gradeRoutingOutcome, gradeToolRequirements } from './graders.mjs';
import { runSessionTurn } from './client.mjs';

const repaired = (caseId, filename) => ROUTING_CASES[caseId].kind === 'typo'
  ? routingFixture(caseId, filename).source.replace('Retruns', 'Returns')
  : ROUTING_CASES[caseId].kind === 'behavior'
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
      assert.doesNotMatch(definition.prompt, /\b(?:Designer|Fixer|Librarian|Explorer)\b/i);
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
          assert.equal(options.planMode, scenario.planMode === true);
          if (!scenario.readOnly) writeFileSync(runFiles.sourcePath, repaired(caseId, path.basename(runFiles.sourcePath)));
          return {
            rootSessionId: 'root', childSessionIds: scenario.agent ? ['child'] : [],
            routingEvidence: scenario.kind === 'footer' ? { located: true, cause: true, verification: true }
              : scenario.kind === 'inventory' ? { counts: { identity: 180, billing: 180, session: 180, elevated: 135 } }
              : scenario.kind === 'external' ? { cited: true, flag: true, defaultValue: true } : null,
            sessionTree: [{ sessionId: 'root', messages: [] }, ...(scenario.agent ? [{ sessionId: 'child', messages: [{ parts: [
              { type: 'tool', tool: scenario.readOnly ? 'read' : 'edit', state: { status: 'completed' } }] }] }] : [])],
            terminalEvidence: { complete: true },
            tools: [...(scenario.agent ? [{ tool: 'devryan_task', status: 'completed', sessionScope: 'root' }] : []),
              { tool: scenario.kind === 'external' ? 'webfetch' : scenario.readOnly ? 'read' : 'edit', status: 'completed', sessionScope: scenario.agent ? 'child' : 'root' }],
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

const editedChild = (sessionId) => ({ sessionId, messages: [{ parts: [{ type: 'tool', tool: 'apply_patch', state: { status: 'completed' } }] }] });
const failedChild = (sessionId) => ({ sessionId, messages: [{ parts: [{ type: 'tool', tool: 'edit', state: { status: 'error' } }] }] });

test('routing fails closed on missing, wrong, foreign, or duplicate specialist evidence', () => {
  const task = { rootSessionId: 'root', agent: 'designer', childSessionId: 'child' };
  const grade = snapshot => gradeRoutingOutcome({ caseId: 'routing-approved-visual', rootSessionId: 'root', snapshot, sessionTree: [editedChild('child')] }).passed;
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

test('unprompted implementation accepts one same-owner remediation that edits, but no other role', () => {
  const designer = (childSessionId) => ({ rootSessionId: 'root', agent: 'designer', childSessionId });
  const tree = [editedChild('a'), editedChild('b'), editedChild('c'), failedChild('wrong')];
  const grade = (caseId, tasks, sessionTree = tree) => gradeRoutingOutcome({ caseId, rootSessionId: 'root', snapshot: { tasks }, sessionTree }).passed;
  assert.equal(grade('routing-substantial-design', [designer('a'), designer('b')]), true);
  assert.equal(grade('routing-substantial-design', [designer('a'), { ...designer('b'), agent: 'fixer' }]), false);
  assert.equal(grade('routing-natural-behavior', [{ ...designer('a'), agent: 'fixer' }, { ...designer('b'), agent: 'fixer' }]), true);
  // A re-dispatch after a child that never completed an edit (e.g. it wrote to another workspace) fails.
  assert.equal(grade('routing-natural-visual', [designer('wrong'), designer('a')]), false);
  assert.equal(grade('routing-natural-visual', [designer('a')], []), false);
  // Remediation is bounded: a third same-owner child is a loop, not review follow-up.
  assert.equal(grade('routing-natural-visual', [designer('a'), designer('b'), designer('c')]), false);
  // An explicit single-specialist request still requires exactly one child.
  assert.equal(grade('routing-visual', [designer('a'), designer('b')]), false);
});

test('external documentation starts Librarian, optionally beside Explorer, and needs the sourced default', () => {
  const task = (agent) => ({ rootSessionId: 'root', agent, childSessionId: agent });
  const evidence = { cited: true, flag: true, defaultValue: true };
  const grade = (tasks, facts = evidence) => gradeRoutingOutcome({ caseId: 'routing-external-docs', rootSessionId: 'root', snapshot: { tasks }, evidence: facts }).passed;
  assert.equal(grade([task('librarian')]), true);
  assert.equal(grade([task('explorer'), task('librarian')]), true);
  assert.equal(grade([task('explorer')]), false);
  assert.equal(grade([task('fixer'), task('librarian')]), false);
  assert.equal(grade([task('librarian')], { ...evidence, defaultValue: false }), false);
  const collected = collectRoutingEvidence('routing-external-docs', [{ sessionId: 'root', messages: [{ info: { role: 'assistant' }, parts: [
    { type: 'text', text: 'Use `--test-timeout`; its default is Infinity. https://nodejs.org/api/cli.html#--test-timeout' }] }] }], 'root');
  assert.deepEqual(collected, evidence);
});

test('a mechanical typo fix stays direct and Plan-mode approval keeps Fixer ownership', () => {
  assert.equal(gradeRoutingOutcome({ caseId: 'routing-direct-typo', rootSessionId: 'root', snapshot: { tasks: [] }, childSessionIds: [] }).passed, true);
  assert.equal(gradeRoutingOutcome({ caseId: 'routing-direct-typo', rootSessionId: 'root',
    snapshot: { tasks: [{ rootSessionId: 'root', agent: 'fixer', childSessionId: 'a' }] }, childSessionIds: ['a'], sessionTree: [editedChild('a')] }).passed, false);
  const plan = (tasks) => gradeRoutingOutcome({ caseId: 'routing-plan-mode-behavior', rootSessionId: 'root', snapshot: { tasks }, sessionTree: [editedChild('fix')] }).passed;
  assert.equal(plan([{ rootSessionId: 'root', agent: 'explorer', childSessionId: 'map' }, { rootSessionId: 'root', agent: 'fixer', childSessionId: 'fix' }]), true);
  // A read-only Fixer dispatched during planning never edits and fails ownership.
  assert.equal(plan([{ rootSessionId: 'root', agent: 'fixer', childSessionId: 'map' }, { rootSessionId: 'root', agent: 'fixer', childSessionId: 'fix' }]), false);
  assert.equal(plan([{ rootSessionId: 'root', agent: 'designer', childSessionId: 'fix' }]), false);
});

test('broad discovery accepts one Explorer per subsystem but no other role', () => {
  const explorer = { rootSessionId: 'root', agent: 'explorer' };
  const input = { caseId: 'routing-broad-discovery', rootSessionId: 'root',
    evidence: { counts: { identity: 180, billing: 180, session: 180, elevated: 135 } } };
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [explorer, explorer, explorer] } }).passed, true);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [explorer, explorer, explorer, explorer] } }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [explorer, { ...explorer, agent: 'fixer' }] } }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [explorer, { ...explorer, rootSessionId: 'other' }] } }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [] } }).passed, false);
});

test('plan approval waits for new turn evidence and preserves the actual dispatched role', async () => {
  const prompts = [];
  const planModes = [];
  let followUpReads = 0;
  const plan = { info: { id: 'plan', role: 'assistant', finish: 'stop' }, parts: [] };
  const done = { info: { id: 'implementation', role: 'assistant', finish: 'stop' }, parts: [] };
  const client = {
    pollIntervalMs: 1,
    createSession: async () => ({ id: 'root' }),
    promptSession: async (_id, _directory, _selection, prompt, _signal, promptOptions) => { prompts.push(prompt); planModes.push(promptOptions?.planMode === true); },
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
    prompt: 'Plan visual changes only', followUpPrompt: 'implement plan', planMode: true, caseId: 'routing-approved-visual', timeoutMs: 2000 });
  assert.deepEqual(prompts, ['Plan visual changes only', 'implement plan']);
  // Only the planning turn carries the Plan-mode preface; "implement plan" is a normal-mode turn.
  assert.deepEqual(planModes, [true, false]);
  assert.ok(followUpReads >= 5);
  assert.equal(result.terminalEvidence.complete, true);
  assert.equal(result.managedSnapshot.tasks[0].agent, 'fixer');
  assert.equal(gradeRoutingOutcome({ caseId: 'routing-approved-visual', rootSessionId: 'root', snapshot: result.managedSnapshot }).passed, false);
});

test('unknown-location footer plan requires one Explorer child and located evidence', () => {
  const explorerTask = { taskId: 'task', rootSessionId: 'root', childSessionId: 'child', agent: 'explorer' };
  const input = { caseId: 'routing-footer-plan', rootSessionId: 'root', snapshot: { tasks: [explorerTask] }, childSessionIds: ['child'],
    evidence: { located: true, cause: true, verification: true } };
  assert.equal(gradeRoutingOutcome(input).passed, true);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [] }, childSessionIds: [] }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [{ ...explorerTask, agent: 'fixer' }] } }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, snapshot: { tasks: [explorerTask, explorerTask] } }).passed, false);
  assert.equal(gradeRoutingOutcome({ ...input, evidence: { located: true } }).passed, false);
  assert.equal(gradeToolRequirements(input.caseId, [
    { tool: 'read', final: true, sessionScope: 'root' },
  ]).passed, false);
  assert.equal(gradeToolRequirements(input.caseId, [
    { tool: 'devryan_task', final: true, sessionScope: 'root' },
    { tool: 'read', final: true, sessionScope: 'child' },
    { tool: 'edit', final: true, sessionScope: 'root' },
  ]).passed, false);
  assert.equal(gradeToolRequirements(input.caseId, [
    { tool: 'devryan_task', final: true, sessionScope: 'root' },
    { tool: 'read', final: true, sessionScope: 'child' },
  ]).passed, true);
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
