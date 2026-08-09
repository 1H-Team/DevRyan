import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import {
  buildCaseDefinition,
  buildNodeTestInvocation,
  executeEvaluationCase,
  prepareCaseFixture,
  runNodeTests,
} from './cases.mjs';
import { buildOwnedTestEvidenceCommand } from './client.mjs';
import { allocateRunFiles, assertFixtureReady, cleanupRunFiles } from './fixture.mjs';
import { retainPrivateToolInterval } from './tool-evidence.mjs';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

const makeFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-case-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'eval@example.test']);
  git(root, ['config', 'user.name', 'DevRyan Eval']);
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const existing = true;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
};

const selection = {
  providerId: 'provider-pinned',
  modelId: 'model-pinned',
  agent: 'orchestrator',
  variant: null,
};

const causalRepairTools = (events) => events.map((event, index) => (
  retainPrivateToolInterval(event, { start: index * 10, end: (index + 1) * 10 })
));

describe('evaluation case fixtures', () => {
  test('seeds a repair case whose owned test fails before a source-only repair and passes after', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'repair-seed');
    const prepared = prepareCaseFixture('repair-and-test', runFiles);
    const definition = buildCaseDefinition('repair-and-test', runFiles);
    const evidenceCommand = buildOwnedTestEvidenceCommand(runFiles.testRelativePath);
    assert.equal(definition.prompt.split(evidenceCommand).length - 1, 2);

    const red = await runNodeTests({ fixtureRoot, testRelativePath: runFiles.testRelativePath, timeoutMs: 5_000 });
    assert.notEqual(red.exitCode, 0);
    assert.match(runFiles.sourceRelativePath, /\.ts$/);
    assert.match(runFiles.testRelativePath, /\.test\.mjs$/);
    assert.match(prepared.baselineTest, /data:text\/javascript;base64/);
    assert.doesNotMatch(prepared.baselineTest, /from ['"]\.\/[^'"]+\.ts['"]/);
    const redOutput = `${red.stdout}\n${red.stderr}`;
    assert.match(redOutput, /clamps values at both boundaries/);
    assert.doesNotMatch(redOutput, /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|SyntaxError/);
    assert.equal(prepared.baselineSource.includes('return maximum'), false);

    writeFileSync(runFiles.sourcePath, prepared.baselineSource.replace(
      '  return value; // Intentional evaluation defect: values above maximum are not clamped.',
      '  if (value > maximum) return maximum;\n  return value;',
    ));
    const green = await runNodeTests({ fixtureRoot, testRelativePath: runFiles.testRelativePath, timeoutMs: 5_000 });
    assert.equal(green.exitCode, 0, green.stderr);
    assert.equal(readFileSync(runFiles.testPath, 'utf8'), prepared.baselineTest);

    assert.equal(cleanupRunFiles({ fixtureRoot, runFiles, startingManifest: starting }).restored, true);
  });

  test('seeds managed implementation work and requires managed discovery/disposition in its prompt', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'managed-seed');
    const definition = buildCaseDefinition('managed-change', runFiles);
    const prepared = prepareCaseFixture('managed-change', runFiles);

    assert.match(definition.prompt, /devryan_task/);
    assert.match(definition.prompt, /wait/);
    assert.match(definition.prompt, /continue/);
    assert.match(definition.prompt, new RegExp(runFiles.sourceRelativePath));
    assert.notEqual((await runNodeTests({
      fixtureRoot,
      testRelativePath: runFiles.testRelativePath,
      timeoutMs: 5_000,
    })).exitCode, 0);
    assert.equal(prepared.baselineTest, readFileSync(runFiles.testPath, 'utf8'));

    cleanupRunFiles({ fixtureRoot, runFiles, startingManifest: starting });
  });

  test('keeps inspect read-only and invokes node with an argument array and no shell', () => {
    const fixtureRoot = makeFixture();
    const runFiles = allocateRunFiles(fixtureRoot, 'inspect-case');
    assert.deepEqual(prepareCaseFixture('inspect', runFiles), {
      baselineSource: null,
      baselineTest: null,
    });
    assert.deepEqual(buildNodeTestInvocation({ testRelativePath: 'src/file.test.mjs' }), {
      command: process.execPath,
      args: ['--test', 'src/file.test.mjs'],
      options: { shell: false },
    });
    assert.deepEqual(buildNodeTestInvocation({}), {
      command: process.execPath,
      args: ['--test'],
      options: { shell: false },
    });
  });

  test('seeds bounded focused and deep Oracle review fixtures without executable tests', () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    for (const caseId of ['oracle-review-focused', 'oracle-review-deep']) {
      const runFiles = allocateRunFiles(fixtureRoot, caseId);
      const prepared = prepareCaseFixture(caseId, runFiles);
      const definition = buildCaseDefinition(caseId, runFiles);

      assert.equal(readFileSync(runFiles.sourcePath, 'utf8'), prepared.baselineSource);
      assert.equal(readFileSync(runFiles.testPath, 'utf8'), prepared.baselineTest);
      assert.match(definition.prompt, new RegExp(`Review depth: ${caseId.endsWith('deep') ? 'deep' : 'focused'}`));
      assert.match(definition.prompt, /Critical invariants:/);
      assert.match(definition.prompt, /do not run tests, builds, lint, or type-checking/);
      assert.match(definition.prompt, /at most five/);
      assert.match(definition.prompt, new RegExp(runFiles.sourceRelativePath.replaceAll('.', '\\.')));
      assert.match(prepared.baselineSource, /expectedRevision/);
      if (caseId.endsWith('deep')) {
        assert.match(prepared.baselineSource, /createPaymentIntent/);
        assert.match(prepared.baselineSource, /applyPaymentEvent/);
      } else {
        assert.doesNotMatch(prepared.baselineSource, /createPaymentIntent/);
      }
      assert.equal(cleanupRunFiles({ fixtureRoot, runFiles, startingManifest: starting }).restored, true);
    }
  });
});

describe('case execution', () => {
  test('fails inspect when a shell command creates a reserved run-owned file', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'inspect-mutation');
    const result = await executeEvaluationCase({
      caseId: 'inspect',
      repetition: 1,
      fixtureRoot,
      runFiles,
      startingManifest: starting,
      selection,
      timeoutMs: 5_000,
      client: {
        async getChildren() { return []; },
        async abortSession() {},
      },
      sessionRunner: async () => {
        writeFileSync(runFiles.sourcePath, 'export const unexpected = true;\n');
        return {
          rootSessionId: 'ses_inspect',
          childSessionIds: [],
          tools: [
            { tool: 'read', status: 'completed', final: true },
            { tool: 'grep', status: 'completed', final: true },
            { tool: 'bash', status: 'completed', final: true },
          ],
          terminalEvidence: { complete: true, proof: 'assistant' },
          managedSnapshot: { tasks: [], resultEnvelopes: [] },
          durationMs: 10,
        };
      },
    });

    assert.equal(result.status, 'failed');
    assert.equal(
      result.graders.find((grader) => grader.id === 'inspect.filesystem-test').passed,
      false,
    );
    assert.equal(result.cleanup.restored, true);
  });

  test('grades a focused Oracle review without running tests or retaining response text', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'oracle-focused-execution');
    let testRuns = 0;
    const result = await executeEvaluationCase({
      caseId: 'oracle-review-focused',
      repetition: 1,
      fixtureRoot,
      runFiles,
      startingManifest: starting,
      selection: { ...selection, agent: 'oracle', variant: 'high' },
      timeoutMs: 5_000,
      testRunner: async () => {
        testRuns += 1;
        throw new Error('Oracle review evaluation must not execute tests');
      },
      sessionRunner: async () => ({
        rootSessionId: 'ses_oracle',
        childSessionIds: [],
        tools: [
          { tool: 'read', status: 'completed', final: true, sessionScope: 'root' },
          { tool: 'ctx_search', status: 'completed', final: true, sessionScope: 'root' },
        ],
        oracleReviewEvidence: {
          signals: ['authorization_boundary', 'stale_write'],
          pathLineEvidence: true,
          terminalComplete: true,
          privateResponse: 'SECRET RESPONSE MUST NOT SURVIVE',
        },
        terminalEvidence: { complete: true, proof: 'assistant' },
        managedSnapshot: { tasks: [], resultEnvelopes: [] },
        durationMs: 25,
      }),
    });

    assert.equal(testRuns, 0);
    assert.equal(result.status, 'passed');
    assert.equal(result.graders.every((grader) => grader.passed), true);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(result.cleanup.restored, true);
  });

  test('requires observed RED, source-only repair, final GREEN, tool evidence, and exact cleanup', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'repair-execution');
    const result = await executeEvaluationCase({
      caseId: 'repair-and-test',
      repetition: 1,
      fixtureRoot,
      runFiles,
      startingManifest: starting,
      selection,
      timeoutMs: 5_000,
      sessionRunner: async () => {
        const source = readFileSync(runFiles.sourcePath, 'utf8');
        writeFileSync(runFiles.sourcePath, source.replace(
          '  return value; // Intentional evaluation defect: values above maximum are not clamped.',
          '  if (value > maximum) return maximum;\n  return value;',
        ));
        return {
          rootSessionId: 'ses_repair',
          childSessionIds: [],
          tools: causalRepairTools([
            { tool: 'read', status: 'completed', final: true, sessionScope: 'root' },
            { tool: 'bash', status: 'completed', final: true, sessionScope: 'root', ownedTestOutcome: 'failed' },
            { tool: 'apply_patch', status: 'completed', final: true, sessionScope: 'root' },
            { tool: 'bash', status: 'completed', final: true, sessionScope: 'root', ownedTestOutcome: 'passed' },
          ]),
          managedSnapshot: { tasks: [], resultEnvelopes: [] },
          terminalEvidence: { complete: true, proof: 'assistant' },
          durationMs: 25,
        };
      },
    });

    assert.equal(result.status, 'passed');
    assert.equal(result.graders.every((grader) => grader.passed), true);
    assert.equal(result.cleanup.restored, true);
    assert.deepEqual(result.sessionIds, ['ses_repair']);
  });

  test('grades managed child sessions and disposition from authoritative snapshot fields', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'managed-execution');
    const result = await executeEvaluationCase({
      caseId: 'managed-change',
      repetition: 1,
      fixtureRoot,
      runFiles,
      startingManifest: starting,
      selection,
      timeoutMs: 5_000,
      sessionRunner: async () => {
        writeFileSync(runFiles.sourcePath, `
export function summarizeEvalValues(values) {
  if (values.length === 0) return { count: 0, total: 0, minimum: null, maximum: null };
  return { count: values.length, total: values.reduce((sum, value) => sum + value, 0), minimum: Math.min(...values), maximum: Math.max(...values) };
}
`);
        return {
          rootSessionId: 'ses_parent',
          childSessionIds: ['ses_child'],
          tools: [
            { tool: 'devryan_task', status: 'completed', final: true },
            { tool: 'apply_patch', status: 'completed', final: true },
            { tool: 'bash', status: 'completed', final: true },
          ],
          managedSnapshot: {
            tasks: [{
              taskId: 'dvr_task_1',
              rootSessionId: 'ses_parent',
              childSessionId: 'ses_child',
              status: 'completed',
            }],
            resultEnvelopes: [{ taskId: 'dvr_task_1', status: 'completed', action: 'continue' }],
          },
          terminalEvidence: { complete: true, proof: 'assistant' },
          durationMs: 50,
        };
      },
    });

    assert.equal(result.status, 'passed');
    assert.deepEqual(result.sessionIds, ['ses_parent', 'ses_child']);
    assert.equal(result.graders.find((grader) => grader.id === 'managed.task-disposition').passed, true);
    assert.equal(result.cleanup.restored, true);
  });

  test('aborts a deterministically failed case before deleting its run-owned files', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'repair-abort-before-cleanup');
    const aborts = [];
    const result = await executeEvaluationCase({
      caseId: 'repair-and-test',
      repetition: 1,
      fixtureRoot,
      runFiles,
      startingManifest: starting,
      selection,
      timeoutMs: 5_000,
      client: {
        async getChildren() { return []; },
        async abortSession(sessionId) {
          assert.equal(existsSync(runFiles.sourcePath), true);
          assert.equal(existsSync(runFiles.testPath), true);
          aborts.push(sessionId);
        },
      },
      sessionRunner: async () => {
        const source = readFileSync(runFiles.sourcePath, 'utf8');
        writeFileSync(runFiles.sourcePath, source.replace(
          '  return value; // Intentional evaluation defect: values above maximum are not clamped.',
          '  if (value > maximum) return maximum;\n  return value;',
        ));
        return {
          rootSessionId: 'ses_failed_grader',
          childSessionIds: [],
          tools: [{ tool: 'bash', status: 'completed', final: true }],
          terminalEvidence: { complete: true, proof: 'assistant' },
          managedSnapshot: { tasks: [], resultEnvelopes: [] },
          durationMs: 25,
        };
      },
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(aborts, ['ses_failed_grader']);
    assert.equal(result.cleanup.sessionComplete, true);
    assert.equal(result.cleanup.restored, true);
    assert.equal(existsSync(runFiles.sourcePath), false);
  });

  test('marks overall cleanup incomplete when failed-case descendant discovery is incomplete', async () => {
    const fixtureRoot = makeFixture();
    const starting = assertFixtureReady(fixtureRoot);
    const runFiles = allocateRunFiles(fixtureRoot, 'inspect-incomplete-abort');
    const aborts = [];
    const result = await executeEvaluationCase({
      caseId: 'inspect',
      repetition: 1,
      fixtureRoot,
      runFiles,
      startingManifest: starting,
      selection,
      timeoutMs: 5_000,
      client: {
        async getChildren() { throw new Error('private child failure'); },
        async abortSession(sessionId) { aborts.push(sessionId); },
      },
      sessionRunner: async () => ({
        rootSessionId: 'ses_incomplete',
        childSessionIds: [],
        tools: [],
        terminalEvidence: { complete: true, proof: 'assistant' },
        managedSnapshot: { tasks: [], resultEnvelopes: [] },
        durationMs: 10,
      }),
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(aborts, ['ses_incomplete']);
    assert.equal(result.cleanup.sessionComplete, false);
    assert.equal(result.cleanup.sessionDiscoveryComplete, false);
    assert.deepEqual(result.cleanup.sessionCleanupReasonCodes, ['children_fetch_failed']);
    assert.equal(result.cleanup.restored, false);
  });
});
