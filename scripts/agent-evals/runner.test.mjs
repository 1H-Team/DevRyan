import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { validateEvaluationConfig } from './config.mjs';
import { captureFixtureManifest } from './fixture.mjs';
import { runEvaluation } from './runner.mjs';
import { retainPrivateToolInterval } from './tool-evidence.mjs';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

const makeWorkspace = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-runner-'));
  const fixtureRoot = path.join(root, 'fixture');
  const reportDirectory = path.join(root, 'reports');
  mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
  git(fixtureRoot, ['init', '--quiet']);
  git(fixtureRoot, ['config', 'user.email', 'eval@example.test']);
  git(fixtureRoot, ['config', 'user.name', 'DevRyan Eval']);
  writeFileSync(path.join(fixtureRoot, 'README.md'), '# Fixture\n');
  writeFileSync(path.join(fixtureRoot, 'src', 'existing.ts'), 'export const existing = true;\n');
  git(fixtureRoot, ['add', '.']);
  git(fixtureRoot, ['commit', '--quiet', '-m', 'fixture']);
  return { root, fixtureRoot, reportDirectory };
};

const makeConfig = (workspace, patch = {}) => validateEvaluationConfig({
  schemaVersion: 1,
  fixtureRoot: workspace.fixtureRoot,
  devRyanBaseUrl: 'http://127.0.0.1:4310',
  providerId: 'provider-pinned',
  modelId: 'model-pinned',
  agent: 'builder',
  variant: null,
  caseIds: ['repair-and-test'],
  repetitions: 1,
  timeoutMs: 5_000,
  reportDirectory: workspace.reportDirectory,
  ...patch,
}, { repoRoot: workspace.root });

const causalRepairTools = (events) => events.map((event, index) => (
  retainPrivateToolInterval(event, { start: index * 10, end: (index + 1) * 10 })
));

describe('evaluation runner integration', () => {
  test('runs cases, restores the fixture, and writes only the schema-v1 aggregate report', async () => {
    const workspace = makeWorkspace();
    const starting = captureFixtureManifest(workspace.fixtureRoot);
    const config = makeConfig(workspace);
    const result = await runEvaluation(config, {
      createRunId: () => 'eval-test-001',
      sessionRunner: async ({ runFiles }) => {
        const source = readFileSync(runFiles.sourcePath, 'utf8');
        writeFileSync(runFiles.sourcePath, source.replace(
          '  return value; // Intentional evaluation defect: values above maximum are not clamped.',
          '  if (value > maximum) return maximum;\n  return value;',
        ));
        return {
          rootSessionId: 'ses_parent',
          childSessionIds: [],
          terminalEvidence: { complete: true, proof: 'assistant' },
          tools: causalRepairTools([
            {
              tool: 'read', status: 'completed', final: true, sessionScope: 'root', input: 'SECRET INPUT',
            },
            {
              tool: 'bash', status: 'completed', final: true, sessionScope: 'root', ownedTestOutcome: 'failed',
            },
            {
              tool: 'apply_patch', status: 'completed', final: true, sessionScope: 'root', output: 'SECRET OUTPUT',
            },
            {
              tool: 'bash', status: 'completed', final: true, sessionScope: 'root', ownedTestOutcome: 'passed',
            },
          ]),
          managedSnapshot: { tasks: [], resultEnvelopes: [] },
          sessionTree: [{ messages: [{ parts: [{ type: 'text', text: 'SECRET RESPONSE' }] }] }],
          durationMs: 75,
        };
      },
    });

    assert.equal(result.report.schemaVersion, 1);
    assert.equal(result.report.cleanup.restored, true);
    assert.equal(result.report.aggregates.status, 'passed');
    assert.equal(existsSync(result.reportPath), true);
    const serialized = readFileSync(result.reportPath, 'utf8');
    assert.equal(serialized.includes('SECRET'), false);
    assert.equal(serialized.includes('prompt'), false);
    assert.deepEqual(captureFixtureManifest(workspace.fixtureRoot), starting);
  });

  test('aborts before sessions or report writes when tracked fixture state is dirty', async () => {
    const workspace = makeWorkspace();
    const config = makeConfig(workspace);
    writeFileSync(path.join(workspace.fixtureRoot, 'README.md'), 'dirty\n');
    let sessionCalls = 0;

    await assert.rejects(
      runEvaluation(config, {
        createRunId: () => 'eval-test-002',
        sessionRunner: async () => { sessionCalls += 1; },
      }),
      /tracked state is dirty/i,
    );
    assert.equal(sessionCalls, 0);
    assert.equal(existsSync(workspace.reportDirectory), false);
    assert.equal(readFileSync(path.join(workspace.fixtureRoot, 'README.md'), 'utf8'), 'dirty\n');
  });

  test('connects the optional sampler to ten run-owned failure cycles and reports classification only', async () => {
    const workspace = makeWorkspace();
    const processSampling = {
      electronPid: 4242,
      caseId: 'inspect',
      intervalMs: 1_000,
      idleSeconds: 60,
      cycles: 5,
      settlementSeconds: 30,
      runs: 2,
    };
    const config = makeConfig(workspace, { processSampling });
    let profileCycles = 0;
    const result = await runEvaluation(config, {
      createRunId: () => 'eval-test-003',
      sessionRunner: async ({ caseId }) => ({
        rootSessionId: `ses_${caseId}_${profileCycles}`,
        childSessionIds: [],
        terminalEvidence: { complete: true, proof: 'assistant' },
        tools: caseId === 'inspect'
          ? [
              { tool: 'read', status: 'completed', final: true },
              { tool: 'grep', status: 'completed', final: true },
            ]
          : [],
        managedSnapshot: { tasks: [], resultEnvelopes: [] },
        durationMs: 1,
      }),
      memoryProfileRunner: async ({ rootPid, executeFailureCycle }) => {
        assert.equal(rootPid, 4242);
        for (let runIndex = 1; runIndex <= 2; runIndex += 1) {
          for (let cycleIndex = 1; cycleIndex <= 5; cycleIndex += 1) {
            profileCycles += 1;
            await executeFailureCycle({ runIndex, cycleIndex });
          }
        }
        return {
          classification: 'not-reproduced',
          reproducedRuns: 0,
          runs: [{ baselineBytes: 1, finalBytes: 2, samples: [{ command: 'SECRET PROCESS' }] }],
        };
      },
    });

    assert.equal(profileCycles, 10);
    assert.equal(result.report.resources.processSampling.classification, 'not-reproduced');
    assert.equal(JSON.stringify(result.report).includes('SECRET PROCESS'), false);
    assert.equal(result.report.plan.processSampling, true);
  });

  test('rejects a memory-profile cycle that does not produce a failed evaluation', async () => {
    const workspace = makeWorkspace();
    const config = makeConfig(workspace, {
      processSampling: {
        electronPid: 4242,
        caseId: 'inspect',
        intervalMs: 1_000,
        idleSeconds: 60,
        cycles: 5,
        settlementSeconds: 30,
        runs: 2,
      },
    });

    await assert.rejects(
      runEvaluation(config, {
        createRunId: () => 'eval-test-004',
        sessionRunner: async ({ caseId }) => ({
          rootSessionId: `ses_${caseId}`,
          childSessionIds: [],
          terminalEvidence: { complete: true, proof: 'assistant' },
          tools: caseId === 'inspect'
            ? [
                { tool: 'read', status: 'completed', final: true },
                { tool: 'grep', status: 'completed', final: true },
                { tool: 'bash', status: 'completed', final: true },
              ]
            : [],
          managedSnapshot: { tasks: [], resultEnvelopes: [] },
          durationMs: 1,
        }),
        memoryProfileRunner: async ({ executeFailureCycle }) => {
          await executeFailureCycle({ runIndex: 1, cycleIndex: 1 });
          return { classification: 'not-reproduced', reproducedRuns: 0, runs: [] };
        },
      }),
      (error) => error?.code === 'evaluation_memory_cycle_not_failed',
    );
  });

  test('writes a failed honest report when execution throws before the first case result', async () => {
    const workspace = makeWorkspace();
    const config = makeConfig(workspace, { caseIds: ['inspect', 'repair-and-test'] });
    await assert.rejects(
      runEvaluation(config, {
        createRunId: () => 'eval-fatal-before-first',
        caseExecutor: async () => {
          const error = new Error('SECRET fatal detail');
          error.code = 'private_failure';
          throw error;
        },
      }),
      (error) => {
        assert.equal(error.report.aggregates.status, 'failed');
        assert.deepEqual(error.report.execution, {
          status: 'failed',
          plannedRuns: 2,
          completedRuns: 0,
        });
        assert.equal(JSON.stringify(error.report).includes('SECRET'), false);
        return true;
      },
    );
  });

  test('keeps fatal execution failed after one completed passing case', async () => {
    const workspace = makeWorkspace();
    const config = makeConfig(workspace, { caseIds: ['inspect', 'repair-and-test'] });
    let calls = 0;
    await assert.rejects(
      runEvaluation(config, {
        createRunId: () => 'eval-fatal-after-pass',
        caseExecutor: async ({ caseId }) => {
          calls += 1;
          if (calls === 2) throw new Error('SECRET second-case failure');
          return {
            caseId,
            repetition: 1,
            status: 'passed',
            durationMs: 1,
            tools: [],
            graders: [{ id: `${caseId}.session`, passed: true }],
            sessionIds: [],
            cleanup: {
              restored: true,
              manifestMatch: true,
              deletedOwnedFileCount: 0,
              deletionFailureCount: 0,
              sessionComplete: true,
              sessionDiscoveryComplete: true,
            },
          };
        },
      }),
      (error) => {
        assert.equal(error.report.aggregates.status, 'failed');
        assert.deepEqual(error.report.execution, {
          status: 'failed',
          plannedRuns: 2,
          completedRuns: 1,
        });
        assert.equal(error.report.aggregates.passed, 1);
        assert.equal(JSON.stringify(error.report).includes('SECRET'), false);
        return true;
      },
    );
  });

  test('projects incomplete descendant discovery into aggregate cleanup evidence', async () => {
    const workspace = makeWorkspace();
    const result = await runEvaluation(makeConfig(workspace), {
      createRunId: () => 'eval-incomplete-session-cleanup',
      caseExecutor: async ({ caseId }) => ({
        caseId,
        repetition: 1,
        status: 'failed',
        durationMs: 1,
        tools: [],
        graders: [{ id: `${caseId}.session`, passed: false }],
        sessionIds: ['ses_parent'],
        cleanup: {
          restored: false,
          manifestMatch: true,
          deletedOwnedFileCount: 0,
          deletionFailureCount: 0,
          sessionComplete: false,
          sessionDiscoveryComplete: false,
          sessionAbortFailureCount: 2,
        },
      }),
    });

    assert.deepEqual(result.report.cleanup, {
      restored: false,
      deletedOwnedFileCount: 0,
      manifestMatch: true,
      deletionFailureCount: 0,
      sessionComplete: false,
      sessionDiscoveryComplete: false,
      sessionAbortFailureCount: 2,
    });
  });
});
