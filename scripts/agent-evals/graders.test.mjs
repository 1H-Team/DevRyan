import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { collectSanitizedTools } from './client.mjs';
import {
  gradeCaseOutcome,
  gradeManagedTaskOutcome,
  gradeToolRequirements,
  summarizeGraders,
} from './graders.mjs';

const tools = (...names) => names.map((tool) => ({ tool, status: 'completed', final: true }));
const ownedTestRelativePath = 'src/devryan-eval-causal.test.mjs';
const ownedTestCommand = `node --test ${ownedTestRelativePath}`;

const repairPart = ({ kind, start, end, tool, syntheticWorkspacePatch = false }) => {
  const state = {
    status: 'completed',
    time: { start, end },
  };
  if (kind === 'red' || kind === 'green') {
    state.input = { command: ownedTestCommand };
    state.metadata = { exitCode: kind === 'green' ? 0 : 1 };
  }
  if (syntheticWorkspacePatch) {
    const patchText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    state.input = { patchText };
    state.output = 'Applied 1 patch.';
    state.metadata = {
      ...(state.metadata ?? {}),
      syntheticWorkspacePatch: true,
      patchText,
      files: [{
        relativePath: 'src/a.ts',
        filePath: 'src/a.ts',
        additions: 1,
        deletions: 1,
        patch: patchText,
      }],
    };
    return {
      id: 'msg_assistant_part_000001_tool_synthetic_workspace_patch',
      sessionID: 'ses_parent',
      messageID: 'msg_assistant',
      type: 'tool',
      tool: 'apply_patch',
      input: { patchText },
      output: state.output,
      state,
    };
  }
  return {
    type: 'tool',
    tool: tool ?? ({ read: 'read', red: 'bash', mutation: 'apply_patch', green: 'bash' })[kind],
    state,
  };
};

const collectRepairTools = (parts, sessionId = 'ses_parent') => collectSanitizedTools([{
  sessionId,
  messages: [{ parts: parts.map(repairPart) }],
}], {
  rootSessionId: sessionId,
  ownedTestRelativePath,
});

describe('deterministic evaluation graders', () => {
  test('requires read, search, and test tool families with no mutation for inspect', () => {
    const passing = gradeToolRequirements('inspect', tools('read', 'grep', 'bash'));
    assert.equal(passing.passed, true);
    assert.equal(passing.id, 'inspect.tools');

    assert.equal(gradeToolRequirements('inspect', tools('read', 'bash')).passed, false);
    assert.equal(gradeToolRequirements('inspect', tools('read', 'grep', 'bash', 'edit')).passed, false);
  });

  test('requires a final mutation tool and test execution for repair-and-test', () => {
    const passing = collectRepairTools([
      { kind: 'read', start: 1, end: 10 },
      { kind: 'red', start: 10, end: 20 },
      { kind: 'mutation', start: 20, end: 30 },
      { kind: 'green', start: 30, end: 40 },
    ]);
    assert.equal(
      gradeToolRequirements('repair-and-test', passing).passed,
      true,
    );
    assert.deepEqual(passing.map((event) => event.ordinal), [1, 2, 3, 4]);

    assert.equal(
      gradeToolRequirements('repair-and-test', collectRepairTools([
        { kind: 'read', start: 1, end: 10 },
        { kind: 'mutation', start: 10, end: 20 },
        { kind: 'red', start: 20, end: 30 },
        { kind: 'green', start: 30, end: 40 },
      ])).passed,
      false,
    );
    assert.equal(
      gradeToolRequirements('repair-and-test', collectRepairTools([
        { kind: 'read', start: 1, end: 10 },
        { kind: 'mutation', start: 10, end: 20 },
        { kind: 'green', start: 20, end: 30 },
      ])).passed,
      false,
    );

    const crossSession = collectRepairTools([
      { kind: 'read', start: 1, end: 10 },
      { kind: 'red', start: 10, end: 20 },
      { kind: 'mutation', start: 20, end: 30 },
      { kind: 'green', start: 30, end: 40 },
    ]);
    crossSession.push({
      tool: 'read', status: 'completed', final: true, sessionScope: 'child',
    });
    assert.equal(
      gradeToolRequirements('repair-and-test', crossSession).passed,
      false,
    );
  });

  test('rejects unique completion order when repair evidence intervals overlap', () => {
    const events = collectRepairTools([
      { kind: 'read', start: 1, end: 10 },
      { kind: 'red', start: 5, end: 20 },
      { kind: 'mutation', start: 6, end: 30 },
      { kind: 'green', start: 7, end: 40 },
    ]);

    assert.equal(gradeToolRequirements('repair-and-test', events).passed, false);
    assert.equal(events.every((event) => event.ordinal === undefined), true);
  });

  test('accepts exact non-overlapping repair interval boundaries', () => {
    const events = collectRepairTools([
      { kind: 'read', start: 1, end: 10 },
      { kind: 'red', start: 10, end: 20 },
      { kind: 'mutation', start: 20, end: 30 },
      { kind: 'green', start: 30, end: 40 },
    ]);

    assert.equal(gradeToolRequirements('repair-and-test', events).passed, true);
    assert.deepEqual(events.map((event) => event.ordinal), [1, 2, 3, 4]);
  });

  test('searches multiple candidates and projects ordinals only onto the causal chain', () => {
    const events = collectRepairTools([
      { kind: 'read', tool: 'read', start: 1, end: 5 },
      { kind: 'red', tool: 'shell', start: 6, end: 30 },
      { kind: 'red', tool: 'bash', start: 6, end: 10 },
      { kind: 'mutation', tool: 'edit', start: 8, end: 20 },
      { kind: 'mutation', tool: 'apply_patch', start: 11, end: 25 },
      { kind: 'green', tool: 'exec', start: 24, end: 40 },
      { kind: 'green', tool: 'terminal', start: 25, end: 45 },
    ]);

    assert.equal(gradeToolRequirements('repair-and-test', events).passed, true);
    assert.deepEqual(Object.fromEntries(events.map((event) => [event.tool, event.ordinal])), {
      read: 1,
      shell: undefined,
      bash: 2,
      edit: undefined,
      apply_patch: 3,
      exec: undefined,
      terminal: 4,
    });
  });

  test('excludes explicitly synthetic workspace patch cards from causal tool evidence', () => {
    const events = collectRepairTools([
      { kind: 'read', start: 1, end: 10 },
      { kind: 'red', start: 10, end: 20 },
      { kind: 'mutation', tool: 'edit', start: 20, end: 30 },
      {
        kind: 'mutation',
        tool: 'apply_patch',
        start: 1,
        end: 30,
        syntheticWorkspacePatch: true,
      },
      { kind: 'green', start: 30, end: 40 },
    ]);

    assert.deepEqual(events.map((event) => event.tool), [
      'read',
      'bash',
      'edit',
      'bash',
    ]);
    assert.equal(gradeToolRequirements('repair-and-test', events).passed, true);
    assert.deepEqual(events.map((event) => event.ordinal), [1, 2, 3, 4]);
  });

  test('keeps provider-marked real edits and tests while excluding only the runtime patch shape', () => {
    const realEdit = repairPart({
      kind: 'mutation',
      tool: 'edit',
      start: 1,
      end: 2,
    });
    realEdit.state.metadata = {
      syntheticWorkspacePatch: true,
      providerDetail: 'preserved by producer',
    };
    const realTest = repairPart({ kind: 'red', start: 3, end: 4 });
    realTest.state.metadata.syntheticWorkspacePatch = true;
    const syntheticPatch = repairPart({
      kind: 'mutation',
      start: 5,
      end: 6,
      syntheticWorkspacePatch: true,
    });
    const spoofedApplyPatch = {
      ...syntheticPatch,
      id: 'provider_call_1',
      state: {
        ...syntheticPatch.state,
        time: { start: 7, end: 8 },
      },
    };

    const events = collectSanitizedTools([{
      sessionId: 'ses_parent',
      messages: [{ parts: [realEdit, realTest, spoofedApplyPatch, syntheticPatch] }],
    }], {
      rootSessionId: 'ses_parent',
      ownedTestRelativePath,
    });

    assert.deepEqual(events, [
      { tool: 'edit', status: 'completed', final: true, sessionScope: 'root' },
      {
        tool: 'bash',
        status: 'completed',
        final: true,
        sessionScope: 'root',
        ownedTestOutcome: 'failed',
      },
      { tool: 'apply_patch', status: 'completed', final: true, sessionScope: 'root' },
    ]);
  });

  test('withholds repair sequence evidence for missing, invalid, or tied timing', () => {
    const invalidCases = [
      {
        label: 'missing start',
        parts: [
          { kind: 'read', start: 1, end: 10 },
          { kind: 'red', start: undefined, end: 20 },
          { kind: 'mutation', start: 20, end: 30 },
          { kind: 'green', start: 30, end: 40 },
        ],
      },
      {
        label: 'non-finite start',
        parts: [
          { kind: 'read', start: 1, end: 10 },
          { kind: 'red', start: 10, end: 20 },
          { kind: 'mutation', start: Number.POSITIVE_INFINITY, end: 30 },
          { kind: 'green', start: 30, end: 40 },
        ],
      },
      {
        label: 'reversed interval',
        parts: [
          { kind: 'read', start: 1, end: 10 },
          { kind: 'red', start: 10, end: 20 },
          { kind: 'mutation', start: 31, end: 30 },
          { kind: 'green', start: 30, end: 40 },
        ],
      },
      {
        label: 'tied completion',
        parts: [
          { kind: 'read', start: 1, end: 10 },
          { kind: 'red', start: 10, end: 20 },
          { kind: 'mutation', start: 20, end: 20 },
          { kind: 'green', start: 20, end: 40 },
        ],
      },
    ];

    for (const candidate of invalidCases) {
      const events = collectRepairTools(candidate.parts);
      assert.equal(
        gradeToolRequirements('repair-and-test', events).passed,
        false,
        candidate.label,
      );
      assert.equal(
        events.every((event) => event.ordinal === undefined),
        true,
        candidate.label,
      );
    }
  });

  test('keeps causal timing private before and after repair grading', () => {
    const events = collectRepairTools([
      { kind: 'read', start: 1_001, end: 1_010 },
      { kind: 'red', start: 1_010, end: 1_020 },
      { kind: 'mutation', start: 1_020, end: 1_030 },
      { kind: 'green', start: 1_030, end: 1_040 },
    ], 'ses_parent_SECRET');
    const assertPrivate = () => {
      const serialized = JSON.stringify(events);
      for (const forbidden of [
        'start',
        'end',
        'time',
        'command',
        'output',
        'exitCode',
        'ses_parent_SECRET',
        ownedTestRelativePath,
      ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    };

    assertPrivate();
    assert.equal(gradeToolRequirements('repair-and-test', events).passed, true);
    assertPrivate();
  });

  test('requires the managed task tool, a child, and fully dispositioned terminal tasks', () => {
    const snapshot = {
      tasks: [{
        taskId: 'dvr_task_1',
        rootSessionId: 'ses_parent',
        childSessionId: 'ses_child',
        status: 'completed',
      }],
      results: [{ taskId: 'dvr_task_1', action: 'continue', status: 'completed' }],
    };
    assert.equal(gradeToolRequirements('managed-change', tools('devryan_task', 'apply_patch', 'bash')).passed, true);
    assert.equal(gradeManagedTaskOutcome({ rootSessionId: 'ses_parent', childSessionIds: ['ses_child'], snapshot }).passed, true);

    assert.equal(gradeManagedTaskOutcome({
      rootSessionId: 'ses_parent',
      childSessionIds: [],
      snapshot,
    }).passed, false);
    assert.equal(gradeManagedTaskOutcome({
      rootSessionId: 'ses_parent',
      childSessionIds: ['ses_child'],
      snapshot: { ...snapshot, results: [{ taskId: 'dvr_task_1', action: null, status: 'completed' }] },
    }).passed, false);

    for (const status of ['queued', 'running', 'failed', 'aborted', 'interrupted']) {
      assert.equal(gradeManagedTaskOutcome({
        rootSessionId: 'ses_parent',
        childSessionIds: ['ses_child'],
        snapshot: {
          ...snapshot,
          tasks: [{ ...snapshot.tasks[0], status }],
        },
      }).passed, false, status);
    }
    for (const action of ['abandon', 'retry', 'resume', 'unknown']) {
      assert.equal(gradeManagedTaskOutcome({
        rootSessionId: 'ses_parent',
        childSessionIds: ['ses_child'],
        snapshot: {
          ...snapshot,
          results: [{ taskId: 'dvr_task_1', action, status: 'completed' }],
        },
      }).passed, false, action);
    }
    assert.equal(gradeManagedTaskOutcome({
      rootSessionId: 'ses_parent',
      childSessionIds: ['ses_child'],
      snapshot: {
        ...snapshot,
        results: [{ taskId: 'dvr_task_1', action: 'continue', status: 'failed' }],
      },
    }).passed, false);
  });

  test('requires exact unique one-to-one managed task, child, and envelope membership', () => {
    const task = (taskId, childSessionId) => ({
      taskId,
      rootSessionId: 'ses_parent',
      childSessionId,
      status: 'completed',
    });
    const envelope = (taskId, patch = {}) => ({
      taskId,
      status: 'completed',
      action: 'continue',
      ...patch,
    });
    const grade = (childSessionIds, tasks, resultEnvelopes) => gradeManagedTaskOutcome({
      rootSessionId: 'ses_parent',
      childSessionIds,
      snapshot: { available: true, tasks, resultEnvelopes },
    }).passed;

    assert.equal(grade(
      ['ses_child_a', 'ses_child_b'],
      [task('task_a', 'ses_child_a'), task('task_b', 'ses_child_b')],
      [envelope('task_a'), envelope('task_b')],
    ), true);

    const invalid = [
      {
        label: 'duplicate child IDs',
        childSessionIds: ['ses_child_a', 'ses_child_a'],
        tasks: [task('task_a', 'ses_child_a')],
        envelopes: [envelope('task_a')],
      },
      {
        label: 'duplicate task IDs',
        childSessionIds: ['ses_child_a', 'ses_child_b'],
        tasks: [task('task_a', 'ses_child_a'), task('task_a', 'ses_child_b')],
        envelopes: [envelope('task_a')],
      },
      {
        label: 'duplicate task-child mappings',
        childSessionIds: ['ses_child_a'],
        tasks: [task('task_a', 'ses_child_a'), task('task_b', 'ses_child_a')],
        envelopes: [envelope('task_a'), envelope('task_b')],
      },
      {
        label: 'duplicate envelope IDs',
        childSessionIds: ['ses_child_a'],
        tasks: [task('task_a', 'ses_child_a')],
        envelopes: [envelope('task_a'), envelope('task_a')],
      },
      {
        label: 'extra envelope ID',
        childSessionIds: ['ses_child_a'],
        tasks: [task('task_a', 'ses_child_a')],
        envelopes: [envelope('task_a'), envelope('task_extra', { action: 'abandon' })],
      },
      {
        label: 'missing envelope ID',
        childSessionIds: ['ses_child_a', 'ses_child_b'],
        tasks: [task('task_a', 'ses_child_a'), task('task_b', 'ses_child_b')],
        envelopes: [envelope('task_a')],
      },
    ];
    for (const candidate of invalid) {
      assert.equal(
        grade(candidate.childSessionIds, candidate.tasks, candidate.envelopes),
        false,
        candidate.label,
      );
    }
  });

  test('grades filesystem and test outcomes without response-text heuristics', () => {
    assert.equal(gradeCaseOutcome({
      caseId: 'inspect',
      nonOwnedManifestMatches: true,
      ownedSourceChanged: false,
      ownedTestChanged: false,
      finalTest: { exitCode: 0 },
    }).passed, true);
    assert.equal(gradeCaseOutcome({
      caseId: 'inspect',
      nonOwnedManifestMatches: false,
      finalTest: { exitCode: 0 },
    }).passed, false);

    assert.equal(gradeCaseOutcome({
      caseId: 'repair-and-test',
      nonOwnedManifestMatches: true,
      ownedSourceChanged: true,
      ownedTestChanged: false,
      baselineTest: { exitCode: 1 },
      finalTest: { exitCode: 0 },
    }).passed, true);
    assert.equal(gradeCaseOutcome({
      caseId: 'repair-and-test',
      nonOwnedManifestMatches: true,
      ownedSourceChanged: true,
      ownedTestChanged: true,
      baselineTest: { exitCode: 1 },
      finalTest: { exitCode: 0 },
    }).passed, false);
  });

  test('summarizes stable grader IDs and counts only', () => {
    assert.deepEqual(summarizeGraders([
      { id: 'inspect.tools', passed: true, detail: 'not retained' },
      { id: 'inspect.tools', passed: false, detail: 'not retained' },
      { id: 'inspect.filesystem', passed: true },
    ]), {
      total: 3,
      passed: 2,
      failed: 1,
      byId: {
        'inspect.filesystem': { passed: 1, failed: 0 },
        'inspect.tools': { passed: 1, failed: 1 },
      },
    });
  });
});
