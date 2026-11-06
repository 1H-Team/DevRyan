import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  ADAPTIVE_CASES,
  ARM_PINNED_ROUTING_CASES,
  CLAMP_COMMENT,
  LOOKUP_ANSWER,
  adaptiveFixture,
  buildAdaptiveDefinition,
  delegationArmExpectations,
  isArmPinnedCase,
  resolveDelegationArm,
  runFileOptionsFor,
} from './adaptive-cases.mjs';
import { executeEvaluationCase, runNodeTests } from './cases.mjs';
import { collectSanitizedTools } from './client.mjs';
import { EVALUATION_CASE_IDS } from './config.mjs';
import { allocateRunFiles, assertFixtureReady } from './fixture.mjs';
import { gradeDelegationArm, gradeManagedTaskOutcome, gradeRoutingOutcome, gradeToolRequirements } from './graders.mjs';
import { ROUTING_CASES, routingSource } from './routing-cases.mjs';
import { retainPrivateToolInterval } from './tool-evidence.mjs';

const tempRoots = [];
after(() => { for (const directory of tempRoots) rmSync(directory, { recursive: true, force: true }); });

const fingerprint = (adaptiveDelegation) => ({ schemaVersion: 1, policies: { readOverlap: false, adaptiveDelegation } });
const armEvidence = (start, finish = start) => ({ startFingerprint: fingerprint(start), finishFingerprint: fingerprint(finish) });

// Sanitized tool events with private native intervals, as collectSanitizedTools produces.
const ev = (tool, scope, start, end, extra = {}) => retainPrivateToolInterval(
  { tool, status: 'completed', final: true, sessionScope: scope, ...extra }, { start, end });
const toolPart = (tool, extra = {}) => ({ type: 'tool', tool, state: { status: 'completed', ...extra } });
const startPart = () => toolPart('devryan_task', { input: { action: 'start' } });
const task = (agent, childSessionId, taskId = childSessionId) => ({ taskId, rootSessionId: 'root', childSessionId, agent, status: 'completed' });
const continued = (tasks) => tasks.map(entry => ({ taskId: entry.taskId, status: 'completed', action: 'continue' }));

// Root implements: optional failed check, declare_checks, edit, passing check.
const directShape = ({ declare = true, declareAfterEdit = false, failedFirst = false, editAfterPass = false } = {}) => ({
  tools: [
    ev('read', 'root', 0, 1),
    ...(failedFirst ? [ev('bash', 'root', 1, 2, { ownedTestOutcome: 'failed' })] : []),
    ...(declare ? [ev('devryan_task', 'root', declareAfterEdit ? 6 : 2, declareAfterEdit ? 7 : 3, { managedAction: 'declare_checks' })] : []),
    ev('edit', 'root', 4, 5),
    ev('bash', 'root', 8, 9, { ownedTestOutcome: 'passed' }),
    ...(editAfterPass ? [ev('edit', 'root', 10, 11)] : []),
  ],
  sessionResult: { rootSessionId: 'root', childSessionIds: [], managedSnapshot: { tasks: [], resultEnvelopes: [] },
    sessionTree: [{ sessionId: 'root', messages: [{ info: { id: 'turn', role: 'assistant' }, parts: [toolPart('edit')] }] }] },
});

// One or more implementation specialists, each editing its own child session.
const specialistShape = (agent, { children = ['child'], sameMessage = true, failedFirst = false, action = 'continue' } = {}) => {
  const tasks = children.map(child => task(agent, child));
  const starts = children.map(startPart);
  return {
    tools: [
      ev('devryan_task', 'root', 0, 20, { managedAction: 'start' }),
      ...children.flatMap((child, index) => [
        ...(failedFirst ? [ev('bash', 'child', 1 + index * 4, 2 + index * 4, { ownedTestOutcome: 'failed' })] : []),
        ev('edit', 'child', 3 + index * 4, 4 + index * 4),
      ]),
      ev('bash', 'child', 30, 31, { ownedTestOutcome: 'passed' }),
    ],
    sessionResult: { rootSessionId: 'root', childSessionIds: [...children],
      managedSnapshot: { tasks, resultEnvelopes: continued(tasks).map(envelope => ({ ...envelope, action })) },
      sessionTree: [
        { sessionId: 'root', messages: sameMessage
          ? [{ info: { id: 'turn', role: 'assistant' }, parts: starts }]
          : starts.map((part, index) => ({ info: { id: `turn-${index}`, role: 'assistant' }, parts: [part] })) },
        ...children.map(child => ({ sessionId: child, messages: [{ parts: [toolPart('edit')] }] })),
      ] },
  };
};

const passed = (graders) => graders.every(grader => grader.passed);
const grade = (caseId, arm, shape) => gradeDelegationArm({ caseId, arm, ...shape });

describe('delegation arm selection', () => {
  test('reads the arm only from matching start and finish fingerprints', () => {
    assert.deepEqual(resolveDelegationArm(armEvidence(false)), { arm: 'baseline', reason: null });
    assert.deepEqual(resolveDelegationArm(armEvidence(true)), { arm: 'adaptive', reason: null });
    assert.deepEqual(resolveDelegationArm(armEvidence(false, true)), { arm: null, reason: 'policy_changed_during_run' });
    for (const evidence of [undefined, null, {}, { startFingerprint: fingerprint(false) }, { finishFingerprint: fingerprint(true) },
      { startFingerprint: { schemaVersion: 1, policies: {} }, finishFingerprint: fingerprint(false) },
      { startFingerprint: { schemaVersion: 1, policies: { adaptiveDelegation: 'false' } }, finishFingerprint: fingerprint(false) },
      { startFingerprint: { policies: { adaptiveDelegation: false } }, finishFingerprint: fingerprint(false) },
      { startFingerprint: { schemaVersion: 1, policies: [] }, finishFingerprint: fingerprint(false) }]) {
      assert.deepEqual(resolveDelegationArm(evidence), { arm: null, reason: 'policy_unattested' });
    }
  });

  test('an unknown or missing arm grades nothing arm-specific', () => {
    for (const arm of [null, undefined, 'other']) {
      assert.deepEqual(grade('routing-natural-behavior', arm, specialistShape('fixer')), [{ id: 'routing-natural-behavior.arm', passed: false }]);
    }
  });

  test('pins exactly the five baseline routing cases plus every adaptive case, each with both arms', () => {
    assert.deepEqual(Object.keys(ARM_PINNED_ROUTING_CASES), ['routing-natural-behavior', 'routing-natural-visual',
      'routing-direct-typo', 'routing-plan-mode-behavior', 'routing-broad-discovery']);
    for (const caseId of [...Object.keys(ARM_PINNED_ROUTING_CASES), ...Object.keys(ADAPTIVE_CASES)]) {
      assert.equal(isArmPinnedCase(caseId), true);
      assert.ok(EVALUATION_CASE_IDS.includes(caseId), caseId);
      const expectations = delegationArmExpectations(caseId);
      assert.ok(expectations.baseline.length > 0 && expectations.adaptive.length > 0, caseId);
    }
    for (const caseId of ['routing-visual', 'routing-substantial-design', 'routing-external-docs', 'inspect', 'managed-change']) {
      assert.equal(isArmPinnedCase(caseId), false, caseId);
    }
    // The baseline alternative is the unchanged ROUTING_CASES entry.
    for (const caseId of Object.keys(ARM_PINNED_ROUTING_CASES)) {
      assert.deepEqual(ARM_PINNED_ROUTING_CASES[caseId].baseline, [{ route: 'routing', scenario: { ...ROUTING_CASES[caseId] } }]);
    }
  });
});

describe('arm-pinned existing routing cases', () => {
  test('the baseline arm reproduces the legacy routing graders exactly', () => {
    for (const [caseId, agent] of [['routing-natural-behavior', 'fixer'], ['routing-natural-visual', 'designer']]) {
      for (const make of [() => specialistShape(agent), () => directShape()]) {
        // Fresh shapes: grading consumes the private tool intervals.
        const legacyShape = make(), shape = make();
        const { sessionResult } = legacyShape;
        const legacy = [
          gradeToolRequirements(caseId, legacyShape.tools),
          gradeManagedTaskOutcome({ rootSessionId: 'root', childSessionIds: sessionResult.childSessionIds, snapshot: sessionResult.managedSnapshot }),
          gradeRoutingOutcome({ caseId, rootSessionId: 'root', snapshot: sessionResult.managedSnapshot, childSessionIds: sessionResult.childSessionIds,
            sessionTree: sessionResult.sessionTree }),
        ];
        assert.deepEqual(grade(caseId, 'baseline', shape), [...legacy, { id: `${caseId}.arm.baseline`, passed: true }]);
      }
    }
  });

  test('known one-file repair: baseline requires Fixer, adaptive requires declared direct work', () => {
    const caseId = 'routing-natural-behavior';
    assert.equal(passed(grade(caseId, 'baseline', specialistShape('fixer'))), true);
    assert.equal(passed(grade(caseId, 'baseline', directShape())), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape())), true);
    assert.equal(passed(grade(caseId, 'adaptive', specialistShape('fixer'))), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ declare: false }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ declareAfterEdit: true }))), false);
    // An edit after the last passing check leaves the final content unverified.
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ editAfterPass: true }))), false);
    const childEdit = directShape();
    childEdit.tools.push(ev('edit', 'child', 4, 5));
    assert.equal(passed(grade(caseId, 'adaptive', childEdit)), false);
    const unknownAction = directShape();
    unknownAction.tools.push(ev('devryan_task', 'root', 6, 7));
    assert.equal(passed(grade(caseId, 'adaptive', unknownAction)), false);
    const untimed = directShape();
    untimed.tools.push({ tool: 'edit', status: 'completed', final: true, sessionScope: 'root' });
    assert.equal(passed(grade(caseId, 'adaptive', untimed)), false);
  });

  test('small cohesive visual change: adaptive accepts declared direct work or Designer, never Fixer', () => {
    const caseId = 'routing-natural-visual';
    assert.equal(passed(grade(caseId, 'baseline', directShape())), false);
    assert.equal(passed(grade(caseId, 'baseline', specialistShape('designer'))), true);
    assert.equal(passed(grade(caseId, 'adaptive', directShape())), true);
    assert.equal(passed(grade(caseId, 'adaptive', specialistShape('designer'))), true);
    assert.equal(passed(grade(caseId, 'adaptive', specialistShape('fixer'))), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ declare: false }))), false);
  });

  test('mechanical typo: baseline forbids every managed call, adaptive requires declared checks', () => {
    const caseId = 'routing-direct-typo';
    assert.equal(passed(grade(caseId, 'baseline', directShape({ declare: false }))), true);
    assert.equal(passed(grade(caseId, 'baseline', directShape())), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape())), true);
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ declare: false }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', specialistShape('fixer'))), false);
  });

  test('plan then approved-plan implementation: adaptive implements directly and keeps the plan turn read-only', () => {
    const caseId = 'routing-plan-mode-behavior';
    const planDirect = ({ editInPlanTurn = false, firstTurnMessageIds = ['plan'], companion = 'explorer' } = {}) => {
      const tasks = [task(companion, 'map')];
      return {
        tools: [ev('devryan_task', 'root', 0, 1, { managedAction: 'start' }), ev('read', 'child', 1, 2),
          ev('devryan_task', 'root', 3, 4, { managedAction: 'declare_checks' }), ev('edit', 'root', 5, 6),
          ev('bash', 'root', 7, 8, { ownedTestOutcome: 'passed' })],
        sessionResult: { rootSessionId: 'root', childSessionIds: ['map'], firstTurnMessageIds,
          managedSnapshot: { tasks, resultEnvelopes: continued(tasks) },
          sessionTree: [
            { sessionId: 'root', messages: [
              { info: { id: 'plan', role: 'assistant' }, parts: editInPlanTurn ? [toolPart('edit')] : [startPart()] },
              { info: { id: 'implementation', role: 'assistant' }, parts: [toolPart('edit')] }] },
            { sessionId: 'map', messages: [{ parts: [toolPart('read')] }] },
          ] },
      };
    };
    assert.equal(passed(grade(caseId, 'adaptive', planDirect())), true);
    assert.equal(passed(grade(caseId, 'adaptive', planDirect({ editInPlanTurn: true }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', planDirect({ firstTurnMessageIds: null }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', planDirect({ firstTurnMessageIds: ['missing'] }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', planDirect({ companion: 'fixer' }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', specialistShape('fixer'))), false);
    assert.equal(passed(grade(caseId, 'baseline', planDirect())), false);
  });

  test('bounded broad discovery keeps the Explorer-first expectation in both arms', () => {
    const caseId = 'routing-broad-discovery';
    assert.deepEqual(delegationArmExpectations(caseId).baseline, delegationArmExpectations(caseId).adaptive);
    const explorers = () => {
      const tasks = ['a', 'b', 'c'].map(id => task('explorer', id));
      return { tools: [ev('devryan_task', 'root', 0, 9, { managedAction: 'start' }), ev('read', 'child', 1, 2)],
        sessionResult: { rootSessionId: 'root', childSessionIds: ['a', 'b', 'c'], routingEvidence: { counts: { identity: 180, billing: 180, session: 180, elevated: 135 } },
          managedSnapshot: { tasks, resultEnvelopes: continued(tasks) }, sessionTree: [{ sessionId: 'root', messages: [] }] } };
    };
    for (const arm of ['baseline', 'adaptive']) {
      assert.equal(passed(grade(caseId, arm, explorers())), true, arm);
      const direct = directShape({ declare: false });
      direct.tools = [ev('read', 'root', 0, 1)];
      assert.equal(passed(grade(caseId, arm, direct)), false, arm);
    }
  });
});

describe('adaptive behaviour-matrix cases', () => {
  test('explicit specialist request keeps Fixer in both arms', () => {
    const caseId = 'adaptive-explicit-fixer';
    for (const arm of ['baseline', 'adaptive']) {
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer'))), true, arm);
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer', { children: ['a', 'b'] }))), true, arm);
      assert.equal(passed(grade(caseId, arm, directShape())), false, arm);
      assert.equal(passed(grade(caseId, arm, specialistShape('designer'))), false, arm);
    }
  });

  test('narrow lookup reads without editing, uses at most one Explorer, and returns the exact answer', () => {
    const caseId = 'adaptive-narrow-lookup';
    const lookup = ({ answer = LOOKUP_ANSWER, tasks = [], edit = false } = {}) => ({
      tools: [ev('read', tasks.length ? 'child' : 'root', 0, 1), ...(tasks.length ? [ev('devryan_task', 'root', 0, 2, { managedAction: 'start' })] : []),
        ...(edit ? [ev('edit', 'root', 3, 4)] : [])],
      sessionResult: { rootSessionId: 'root', childSessionIds: tasks.map(entry => entry.childSessionId),
        managedSnapshot: { tasks, resultEnvelopes: continued(tasks) },
        sessionTree: [{ sessionId: 'root', messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `Found it.\n${JSON.stringify(answer)}` }] }] },
          ...tasks.map(entry => ({ sessionId: entry.childSessionId, messages: [{ parts: [toolPart('read')] }] }))] },
    });
    assert.deepEqual(LOOKUP_ANSWER, { missingLabel: 'Add Price', line: 6 });
    for (const arm of ['baseline', 'adaptive']) {
      assert.equal(passed(grade(caseId, arm, lookup())), true, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ tasks: [task('explorer', 'map')] }))), true, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ tasks: [task('explorer', 'a'), task('explorer', 'b')] }))), false, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ tasks: [task('fixer', 'map')] }))), false, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ answer: { missingLabel: 'Add Price', line: 5 } }))), false, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ answer: { missingLabel: 'add price', line: 6 } }))), false, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ answer: { label: 'Add Price' } }))), false, arm);
      assert.equal(passed(grade(caseId, arm, lookup({ edit: true }))), false, arm);
    }
  });

  test('check discipline needs a failed check before the first edit and a passing one after the last', () => {
    const caseId = 'adaptive-check-discipline';
    assert.equal(passed(grade(caseId, 'baseline', specialistShape('fixer', { failedFirst: true }))), true);
    assert.equal(passed(grade(caseId, 'baseline', specialistShape('fixer'))), false);
    assert.equal(passed(grade(caseId, 'baseline', directShape({ failedFirst: true }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ failedFirst: true }))), true);
    assert.equal(passed(grade(caseId, 'adaptive', directShape())), false);
    assert.equal(passed(grade(caseId, 'adaptive', directShape({ failedFirst: true, editAfterPass: true }))), false);
    assert.equal(passed(grade(caseId, 'adaptive', specialistShape('fixer', { failedFirst: true }))), false);
    const ids = grade(caseId, 'adaptive', directShape({ failedFirst: true })).map(grader => grader.id);
    assert.ok(ids.includes(`${caseId}.check-order`) && ids.includes(`${caseId}.arm.adaptive`));
  });

  test('independent phases start parallel Fixers in one dispatch and disposition every result', () => {
    const caseId = 'adaptive-independent-phases';
    for (const arm of ['baseline', 'adaptive']) {
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer', { children: ['a', 'b'] }))), true, arm);
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer'))), false, arm);
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer', { children: ['a', 'b'], sameMessage: false }))), false, arm);
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer', { children: ['a', 'b'], action: 'retry' }))), false, arm);
      assert.equal(passed(grade(caseId, arm, specialistShape('fixer', { children: ['a', 'b', 'c', 'd'] }))), false, arm);
      assert.equal(passed(grade(caseId, arm, directShape())), false, arm);
    }
  });

  test('prompts name the run-owned files and never leak arm or owner expectations', () => {
    const runFiles = { sourcePath: '/f/src/devryan-eval-x.ts', sourceRelativePath: 'src/devryan-eval-x.ts', testRelativePath: 'src/devryan-eval-x.test.mjs',
      secondarySourcePath: '/f/src/devryan-eval-x.phase-b.ts', secondarySourceRelativePath: 'src/devryan-eval-x.phase-b.ts' };
    for (const caseId of Object.keys(ADAPTIVE_CASES)) {
      const { prompt } = buildAdaptiveDefinition(caseId, runFiles);
      assert.ok(prompt.includes(runFiles.sourceRelativePath), caseId);
      assert.doesNotMatch(prompt, /adaptive|baseline|declare_checks|\barm\b/i, caseId);
      // Only the explicit-request case names a specialist, because the user does.
      if (caseId === 'adaptive-explicit-fixer') assert.match(prompt, /Delegate this implementation to Fixer/);
      else assert.doesNotMatch(prompt, /\b(?:Designer|Fixer|Librarian|Explorer|Oracle)\b/i, caseId);
    }
    assert.ok(buildAdaptiveDefinition('adaptive-independent-phases', runFiles).prompt.includes(runFiles.secondarySourceRelativePath));
    assert.deepEqual(runFileOptionsFor('adaptive-independent-phases'), { secondarySource: true });
    assert.deepEqual(runFileOptionsFor('routing-natural-behavior'), {});
    assert.throws(() => adaptiveFixture('adaptive-independent-phases', { ...runFiles, secondarySourcePath: undefined }), /secondary/);
  });

  test('sanitized devryan_task events keep only a closed-shape managed action', () => {
    const part = (tool, action) => ({ type: 'tool', tool, state: { status: 'completed', input: { action } } });
    const tools = collectSanitizedTools([{ sessionId: 'root', messages: [{ parts: [part('devryan_task', 'declare_checks'),
      part('devryan_task', 'Bad Action!'), part('devryan_task', undefined), part('bash', 'declare_checks')] }] }], { rootSessionId: 'root' });
    assert.deepEqual(tools.map(event => event.managedAction), ['declare_checks', undefined, undefined, undefined]);
  });
});

// Live-shaped execution against a real fixture: baseline test fails, the
// simulated session repairs the run-owned files, the final test passes.
const makeFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-adaptive-eval-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'README.md'), '# Isolated adaptive fixture\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', 'commit', '-qm', 'fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  }
  return root;
};
const fixedClamp = `${CLAMP_COMMENT}
export function clampEvalValue(value, minimum, maximum) {
  if (value < minimum) return minimum;
  return value > maximum ? maximum : value;
}
`;
const repair = (caseId, runFiles) => {
  if (caseId === 'adaptive-explicit-fixer') writeFileSync(runFiles.sourcePath, routingSource.replace('return price ?', 'return price != null ?'));
  if (caseId === 'adaptive-check-discipline') writeFileSync(runFiles.sourcePath, fixedClamp);
  if (caseId === 'adaptive-independent-phases') {
    writeFileSync(runFiles.sourcePath, "export function priceLabel(price) {\n  return price != null ? String(price) : 'Add Price';\n}\n");
    writeFileSync(runFiles.secondarySourcePath, fixedClamp);
  }
};
const lookupShape = () => ({ tools: [ev('read', 'root', 0, 1)], sessionResult: { rootSessionId: 'root', childSessionIds: [],
  managedSnapshot: { tasks: [], resultEnvelopes: [] }, sessionTree: [{ sessionId: 'root', messages: [{ info: { role: 'assistant' },
    parts: [{ type: 'text', text: JSON.stringify(LOOKUP_ANSWER) }] }] }] } });
const passingShape = (caseId, arm) => ({
  'adaptive-explicit-fixer': () => specialistShape('fixer'),
  'adaptive-narrow-lookup': lookupShape,
  'adaptive-check-discipline': () => arm === 'baseline' ? specialistShape('fixer', { failedFirst: true }) : directShape({ failedFirst: true }),
  'adaptive-independent-phases': () => specialistShape('fixer', { children: ['a', 'b'] }),
})[caseId]();

const execute = async (caseId, harnessEvidence, shape) => {
  const root = makeFixture();
  const startingManifest = assertFixtureReady(root);
  const runFiles = allocateRunFiles(root, `${caseId}-run`, runFileOptionsFor(caseId));
  const testResults = [];
  const result = await executeEvaluationCase({
    caseId, repetition: 1, fixtureRoot: root, runFiles, startingManifest, timeoutMs: 30_000,
    selection: { providerId: 'fixture', modelId: 'fixture', agent: 'orchestrator', variant: null },
    testRunner: async options => { const value = await runNodeTests(options); testResults.push(value); return value; },
    sessionRunner: async () => {
      repair(caseId, runFiles);
      return { ...shape.sessionResult, ...(harnessEvidence ? { harnessEvidence } : {}), tools: shape.tools, terminalEvidence: { complete: true } };
    },
  });
  assertFixtureReady(root);
  return { result, testResults };
};

describe('adaptive case execution', () => {
  for (const caseId of Object.keys(ADAPTIVE_CASES)) {
    for (const arm of ['baseline', 'adaptive']) {
      test(`${caseId} passes its ${arm} expectation end to end and restores its fixture`, async () => {
        const { result, testResults } = await execute(caseId, armEvidence(arm === 'adaptive'), passingShape(caseId, arm));
        assert.equal(result.status, 'passed', JSON.stringify(result.graders));
        assert.equal(result.delegationArm, arm);
        const readOnly = ADAPTIVE_CASES[caseId].readOnly === true;
        assert.equal(testResults.length, readOnly ? 1 : 2);
        if (!readOnly) assert.notEqual(testResults[0].exitCode, 0);
        assert.equal(testResults.at(-1).exitCode, 0, testResults.at(-1).stdout);
        assert.equal(result.cleanup.restored, true);
      });
    }
  }

  test('an arm-pinned run without attested policy is held and graded as neither arm', async () => {
    for (const [caseId, evidence] of [['adaptive-explicit-fixer', null], ['adaptive-check-discipline', armEvidence(false, true)],
      ['adaptive-narrow-lookup', { startFingerprint: fingerprint(true), finishFingerprint: null }]]) {
      const { result } = await execute(caseId, evidence, passingShape(caseId, 'baseline'));
      assert.equal(result.status, 'held', caseId);
      assert.equal(result.errorCode, 'evaluation_arm_unattested', caseId);
      assert.equal(result.delegationArm, null, caseId);
      const ids = result.graders.map(grader => grader.id);
      assert.ok(ids.includes(`${caseId}.arm`), caseId);
      assert.equal(ids.some(id => /\.(?:tools|specialist|direct|direct-tools|arm\.baseline|arm\.adaptive)$/.test(id)), false, caseId);
      // A held run is not passed, so its session tree is aborted like a failed one.
      assert.equal(result.cleanup.sessionComplete, false, caseId);
    }
  });
});
