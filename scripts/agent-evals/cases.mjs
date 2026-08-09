import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  abortSessionTree,
  buildOwnedTestEvidenceCommand,
  runSessionTurn,
} from './client.mjs';
import {
  captureFixtureManifest,
  cleanupRunFiles,
  compareFixtureManifests,
  writeRunOwnedFile,
} from './fixture.mjs';
import {
  gradeCaseOutcome,
  gradeManagedTaskOutcome,
  gradeOracleReviewOutcome,
  gradeToolRequirements,
} from './graders.mjs';

const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

const repairSource = `export function clampEvalValue(value, minimum, maximum) {
  if (value < minimum) return minimum;
  return value; // Intentional evaluation defect: values above maximum are not clamped.
}
`;

const sourceModuleLoader = (sourceFilename) => `import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

const sourceText = await readFile(new URL('./${sourceFilename}', import.meta.url), 'utf8');
const sourceUrl = \`data:text/javascript;base64,\${Buffer.from(sourceText).toString('base64')}\`;
const sourceModule = await import(sourceUrl);
`;

const repairTest = (sourceFilename) => `import assert from 'node:assert/strict';
import test from 'node:test';
${sourceModuleLoader(sourceFilename)}
const { clampEvalValue } = sourceModule;

test('clamps values at both boundaries', () => {
  assert.equal(clampEvalValue(-2, 0, 10), 0);
  assert.equal(clampEvalValue(4, 0, 10), 4);
  assert.equal(clampEvalValue(14, 0, 10), 10);
});
`;

const managedSource = `export function summarizeEvalValues(_values) {
  throw new Error('Intentional evaluation stub: implement summarizeEvalValues');
}
`;

const managedTest = (sourceFilename) => `import assert from 'node:assert/strict';
import test from 'node:test';
${sourceModuleLoader(sourceFilename)}
const { summarizeEvalValues } = sourceModule;

test('summarizes populated and empty numeric inputs', () => {
  assert.deepEqual(summarizeEvalValues([5, -2, 9]), {
    count: 3,
    total: 12,
    minimum: -2,
    maximum: 9,
  });
  assert.deepEqual(summarizeEvalValues([]), {
    count: 0,
    total: 0,
    minimum: null,
    maximum: null,
  });
});
`;

const oracleFocusedSource = `export function saveProfile(actor, current, expectedRevision, patch) {
  if (!actor?.id) throw new Error('Authentication required');
  return {
    ...current,
    ...patch,
    revision: current.revision + 1,
  };
}
`;

const oracleDeepSource = `${oracleFocusedSource}
const paymentAttempts = new Map();

export async function chargeDeposit(booking, operationKey, gateway) {
  const intent = await gateway.createPaymentIntent({
    amount: booking.depositMinor,
    idempotencyKey: booking.id,
  });
  if (paymentAttempts.has(operationKey)) return paymentAttempts.get(operationKey);
  paymentAttempts.set(operationKey, intent);
  return intent;
}

export function applyPaymentEvent(current, event) {
  return {
    ...current,
    status: event.status,
    updatedAt: event.createdAt,
  };
}
`;

const oracleFocusedContract = `export const profileSaveContract = Object.freeze({
  authorization: 'Only the profile owner or an administrator may save.',
  concurrency: 'Reject a save when expectedRevision differs from the stored revision.',
});
`;

const oracleDeepContract = `export const reviewContract = Object.freeze({
  authorization: 'Only the profile owner or an administrator may save.',
  concurrency: 'Reject a save when expectedRevision differs from the stored revision.',
  paymentAttempt: 'Reserve the operation before calling the external payment gateway.',
  webhook: 'Terminal payment state must not regress under stale or out-of-order events.',
});
`;

const ORACLE_REVIEW_CASE_IDS = new Set(['oracle-review-focused', 'oracle-review-deep']);

const isOracleReviewCase = (caseId) => ORACLE_REVIEW_CASE_IDS.has(caseId);

export const buildCaseDefinition = (caseId, runFiles) => {
  if (caseId === 'inspect') {
    return {
      caseId,
      prompt: [
        'Inspect this fixture without changing any file.',
        'Use a file read tool, a repository search tool, and a shell tool to run node --test.',
        'Describe only concise findings after the tests finish. Do not write, edit, patch, stage, or create files.',
      ].join(' '),
    };
  }
  if (caseId === 'repair-and-test') {
    const testEvidenceCommand = buildOwnedTestEvidenceCommand(runFiles.testRelativePath);
    return {
      caseId,
      prompt: [
        `Repair the intentionally failing edge case in ${runFiles.sourceRelativePath}.`,
        `First read ${runFiles.sourceRelativePath} and ${runFiles.testRelativePath}, then run exactly this shell command and observe the failure: ${testEvidenceCommand}`,
        `Patch only ${runFiles.sourceRelativePath}; do not change the test or any other file.`,
        `After the patch, run exactly this shell command again and finish only after it passes: ${testEvidenceCommand}`,
      ].join(' '),
    };
  }
  if (caseId === 'managed-change') {
    return {
      caseId,
      prompt: [
        `Implement the owned stub in ${runFiles.sourceRelativePath} so ${runFiles.testRelativePath} passes.`,
        'Use devryan_task managed child work for discovery and implementation.',
        'Start the managed work, wait for every result, and disposition each successful result with continue before resuming.',
        `Do not change ${runFiles.testRelativePath} or any other file. Run node --test ${runFiles.testRelativePath} after managed work settles.`,
      ].join(' '),
    };
  }
  if (isOracleReviewCase(caseId)) {
    const deep = caseId === 'oracle-review-deep';
    return {
      caseId,
      prompt: [
        `Review depth: ${deep ? 'deep' : 'focused'}.`,
        `Changed scope: ${runFiles.sourceRelativePath} and ${runFiles.testRelativePath}; inspect no other files.`,
        deep
          ? 'Critical invariants: profile authorization, optimistic concurrency, reserve-before-gateway idempotency, and monotonic webhook settlement.'
          : 'Critical invariants: profile authorization and optimistic concurrency.',
        'Validation evidence: the fixture was prepared deterministically; do not run tests, builds, lint, or type-checking.',
        'Exclusions: no edits, shell commands, delegation, external research, or broad repository audit.',
        `Return: actionable findings only, at most five, with severity and exact ${runFiles.sourceRelativePath}:line evidence; include residual risk and end with <status>complete</status>.`,
      ].join(' '),
    };
  }
  throw new TypeError(`Unknown evaluation case: ${caseId}`);
};

export const prepareCaseFixture = (caseId, runFiles) => {
  if (caseId === 'inspect') return { baselineSource: null, baselineTest: null };
  if (isOracleReviewCase(caseId)) {
    const deep = caseId === 'oracle-review-deep';
    const baselineSource = deep ? oracleDeepSource : oracleFocusedSource;
    const baselineTest = deep ? oracleDeepContract : oracleFocusedContract;
    writeRunOwnedFile(runFiles.sourcePath, baselineSource, runFiles);
    writeRunOwnedFile(runFiles.testPath, baselineTest, runFiles);
    return { baselineSource, baselineTest };
  }
  const baselineSource = caseId === 'repair-and-test' ? repairSource : managedSource;
  const baselineTest = caseId === 'repair-and-test'
    ? repairTest(path.basename(runFiles.sourcePath))
    : managedTest(path.basename(runFiles.sourcePath));
  writeRunOwnedFile(runFiles.sourcePath, baselineSource, runFiles);
  writeRunOwnedFile(runFiles.testPath, baselineTest, runFiles);
  return { baselineSource, baselineTest };
};

export const buildNodeTestInvocation = (options = {}) => ({
  command: process.execPath,
  args: [
    '--test',
    ...(options.testRelativePath ? [options.testRelativePath] : []),
  ],
  options: { shell: false },
});

export const runNodeTests = (options = {}) => {
  const invocation = buildNodeTestInvocation(options);
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const childEnvironment = { ...process.env };
  // A nested node --test process must be a fresh runner, not a worker of this suite.
  delete childEnvironment.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: options.fixtureRoot,
      ...invocation.options,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= OUTPUT_LIMIT_BYTES) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= OUTPUT_LIMIT_BYTES) stderr.push(chunk);
    });
    child.on('close', (code, signal) => finish(null, {
      exitCode: timedOut ? 124 : (Number.isInteger(code) ? code : 1),
      signal: signal ?? null,
      timedOut,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      outputTruncated: stdoutBytes > OUTPUT_LIMIT_BYTES || stderrBytes > OUTPUT_LIMIT_BYTES,
    }));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
      force.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  });
};

const filterOwnedPaths = (manifest, runFiles) => {
  const owned = new Set([runFiles.sourceRelativePath, runFiles.testRelativePath]);
  return {
    tracked: (manifest?.tracked ?? []).filter((entry) => !owned.has(entry.path)),
    untracked: (manifest?.untracked ?? []).filter((entry) => !owned.has(entry.path)),
    trackedDirty: manifest?.trackedDirty ?? [],
  };
};

const readIfPresent = (filePath) => {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

export const executeEvaluationCase = async (options = {}) => {
  const {
    caseId,
    repetition,
    fixtureRoot,
    runFiles,
    startingManifest,
    selection,
    timeoutMs,
  } = options;
  const testRunner = options.testRunner ?? runNodeTests;
  const sessionRunner = options.sessionRunner ?? runSessionTurn;
  const startedAt = Date.now();
  const definition = buildCaseDefinition(caseId, runFiles);
  let prepared = { baselineSource: null, baselineTest: null };
  let baselineTest = null;
  let finalTest = null;
  let sessionResult = null;
  let sessionError = null;
  let result;
  let cleanup;
  let sessionCleanup = {
    complete: true,
    discoveryComplete: true,
    reasonCodes: [],
    abortFailureCount: 0,
  };
  try {
    prepared = prepareCaseFixture(caseId, runFiles);
    if (caseId !== 'inspect' && !isOracleReviewCase(caseId)) {
      baselineTest = await testRunner({
        fixtureRoot,
        testRelativePath: runFiles.testRelativePath,
        timeoutMs,
      });
      if (baselineTest.timedOut || baselineTest.exitCode === 0) {
        const error = new Error(`${caseId} did not produce the required observed failing baseline test`);
        error.code = 'evaluation_invalid_baseline';
        throw error;
      }
    }

    try {
      sessionResult = await sessionRunner({
        client: options.client,
        directory: fixtureRoot,
        selection,
        prompt: definition.prompt,
        timeoutMs,
        caseId,
        repetition,
        runFiles,
      });
    } catch (error) {
      sessionError = error;
    }

    if (!isOracleReviewCase(caseId)) {
      finalTest = await testRunner({
        fixtureRoot,
        ...(caseId === 'inspect' ? {} : { testRelativePath: runFiles.testRelativePath }),
        timeoutMs,
      });
    }
    const currentManifest = filterOwnedPaths(captureFixtureManifest(fixtureRoot), runFiles);
    const nonOwnedManifestMatches = compareFixtureManifests(startingManifest, currentManifest).matches;
    const ownedSourceChanged = readIfPresent(runFiles.sourcePath) !== prepared.baselineSource;
    const ownedTestChanged = readIfPresent(runFiles.testPath) !== prepared.baselineTest;
    const tools = Array.isArray(sessionResult?.tools) ? sessionResult.tools : [];
    const graders = [
      {
        id: `${caseId}.session`,
        passed: sessionError === null
          && Boolean(sessionResult?.rootSessionId)
          && sessionResult?.terminalEvidence?.complete === true,
      },
      gradeToolRequirements(caseId, tools),
      gradeCaseOutcome({
        caseId,
        nonOwnedManifestMatches,
        ownedSourceChanged,
        ownedTestChanged,
        baselineTest,
        finalTest,
      }),
    ];
    if (caseId === 'managed-change') {
      graders.push(gradeManagedTaskOutcome({
        rootSessionId: sessionResult?.rootSessionId,
        childSessionIds: sessionResult?.childSessionIds,
        snapshot: sessionResult?.managedSnapshot,
      }));
    }
    if (isOracleReviewCase(caseId)) {
      graders.push(...gradeOracleReviewOutcome({
        caseId,
        evidence: sessionResult?.oracleReviewEvidence,
        durationMs: sessionResult?.durationMs,
      }));
    }
    result = {
      caseId,
      repetition,
      status: graders.every((grader) => grader.passed) ? 'passed' : 'failed',
      durationMs: Number.isFinite(sessionResult?.durationMs)
        ? sessionResult.durationMs
        : Date.now() - startedAt,
      tools,
      graders,
      turnTiming: sessionResult?.turnTiming ?? { records: [] },
      managedSnapshot: sessionResult?.managedSnapshot ?? { tasks: [], resultEnvelopes: [] },
      sessionIds: [
        sessionResult?.rootSessionId,
        ...(Array.isArray(sessionResult?.childSessionIds) ? sessionResult.childSessionIds : []),
      ].filter(Boolean),
      ...(sessionError?.code ? { errorCode: sessionError.code } : {}),
    };
    if (result.status === 'failed') {
      if (sessionError?.cleanup) {
        sessionCleanup = sessionError.cleanup;
      } else if (sessionResult?.rootSessionId && options.client) {
        sessionCleanup = await abortSessionTree(
          options.client,
          sessionResult.rootSessionId,
          fixtureRoot,
          {
            timeoutMs: Math.min(5_000, Math.max(100, timeoutMs)),
            knownSessionIds: sessionResult.childSessionIds,
          },
        );
      } else {
        sessionCleanup = {
          complete: false,
          discoveryComplete: false,
          reasonCodes: ['session_cleanup_unavailable'],
          abortFailureCount: 0,
        };
      }
    }
  } finally {
    cleanup = cleanupRunFiles({ fixtureRoot, runFiles, startingManifest });
  }
  return {
    ...result,
    cleanup: {
      ...cleanup,
      restored: cleanup.restored && sessionCleanup.complete === true,
      sessionComplete: sessionCleanup.complete === true,
      sessionDiscoveryComplete: sessionCleanup.discoveryComplete === true,
      sessionCleanupReasonCodes: Array.isArray(sessionCleanup.reasonCodes)
        ? [...sessionCleanup.reasonCodes]
        : [],
      sessionAbortFailureCount: Number.isSafeInteger(sessionCleanup.abortFailureCount)
        ? sessionCleanup.abortFailureCount
        : 0,
    },
  };
};
