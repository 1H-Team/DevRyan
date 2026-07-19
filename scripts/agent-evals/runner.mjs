import { randomBytes } from 'node:crypto';

import { executeEvaluationCase } from './cases.mjs';
import { createEvaluationClient } from './client.mjs';
import {
  allocateRunFiles,
  assertFixtureReady,
  captureFixtureManifest,
  compareFixtureManifests,
} from './fixture.mjs';
import { runRetryMemoryProfile } from './process-sampler.mjs';
import { buildSchemaV1Report, writeSchemaV1Report } from './report.mjs';

export const createEvaluationRunId = () => {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `eval-${timestamp}-${randomBytes(6).toString('hex')}`;
};

const mergeCleanup = (aggregate, cleanup) => {
  aggregate.restored = aggregate.restored && cleanup?.restored === true;
  aggregate.manifestMatch = aggregate.manifestMatch && cleanup?.manifestMatch === true;
  aggregate.deletedOwnedFileCount += Number.isSafeInteger(cleanup?.deletedOwnedFileCount)
    ? cleanup.deletedOwnedFileCount
    : 0;
  aggregate.deletionFailureCount += Number.isSafeInteger(cleanup?.deletionFailureCount)
    ? cleanup.deletionFailureCount
    : 0;
  if (Object.hasOwn(cleanup ?? {}, 'sessionComplete')) {
    aggregate.sessionComplete = aggregate.sessionComplete && cleanup.sessionComplete === true;
  }
  if (Object.hasOwn(cleanup ?? {}, 'sessionDiscoveryComplete')) {
    aggregate.sessionDiscoveryComplete = aggregate.sessionDiscoveryComplete
      && cleanup.sessionDiscoveryComplete === true;
  }
  aggregate.sessionAbortFailureCount += Number.isSafeInteger(cleanup?.sessionAbortFailureCount)
    ? cleanup.sessionAbortFailureCount
    : 0;
};

export const runEvaluation = async (config, dependencies = {}) => {
  // This is intentionally the first IO operation: dirty tracked state creates no sessions or reports.
  const startingManifest = assertFixtureReady(config.fixtureRoot);
  const runId = (dependencies.createRunId ?? createEvaluationRunId)();
  const client = dependencies.client ?? createEvaluationClient({ baseUrl: config.devRyanBaseUrl });
  const caseExecutor = dependencies.caseExecutor ?? executeEvaluationCase;
  const memoryProfileRunner = dependencies.memoryProfileRunner ?? runRetryMemoryProfile;
  const selection = {
    providerId: config.providerId,
    modelId: config.modelId,
    agent: config.agent,
    variant: config.variant,
  };
  const caseResults = [];
  const sessionIds = new Set();
  const cleanup = {
    restored: true,
    deletedOwnedFileCount: 0,
    manifestMatch: true,
    deletionFailureCount: 0,
    sessionComplete: true,
    sessionDiscoveryComplete: true,
    sessionAbortFailureCount: 0,
  };
  let resources = { processSampling: null };
  let fatalError = null;
  let sequence = 0;

  const executeOne = async ({ caseId, repetition, purpose, includeInAggregates }) => {
    sequence += 1;
    const runFileId = `${runId}-${purpose}-${sequence}`;
    const runFiles = allocateRunFiles(config.fixtureRoot, runFileId);
    const result = await caseExecutor({
      caseId,
      repetition,
      fixtureRoot: config.fixtureRoot,
      runFiles,
      startingManifest,
      selection,
      timeoutMs: config.timeoutMs,
      client,
      ...(dependencies.sessionRunner ? { sessionRunner: dependencies.sessionRunner } : {}),
      ...(dependencies.testRunner ? { testRunner: dependencies.testRunner } : {}),
    });
    mergeCleanup(cleanup, result.cleanup);
    for (const sessionId of result.sessionIds ?? []) sessionIds.add(sessionId);
    if (includeInAggregates) caseResults.push(result);
    return result;
  };

  try {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      for (const caseId of config.caseIds) {
        await executeOne({
          caseId,
          repetition,
          purpose: `${caseId}-${repetition}`,
          includeInAggregates: true,
        });
      }
    }

    if (config.processSampling) {
      const sampling = await memoryProfileRunner({
        rootPid: config.processSampling.electronPid,
        executeFailureCycle: async ({ runIndex, cycleIndex }) => {
          const cycleResult = await executeOne({
            caseId: config.processSampling.caseId,
            repetition: cycleIndex,
            purpose: `memory-${runIndex}-${cycleIndex}`,
            includeInAggregates: false,
          });
          if (cycleResult.status !== 'failed') {
            const error = new Error('Memory profile cycles must end in a failed evaluation');
            error.code = 'evaluation_memory_cycle_not_failed';
            throw error;
          }
        },
      });
      resources = { processSampling: sampling };
    }
  } catch (error) {
    fatalError = error;
    if (error?.cleanup) mergeCleanup(cleanup, error.cleanup);
    if (config.processSampling && !resources.processSampling) {
      resources = {
        processSampling: {
          classification: 'unavailable',
          reproducedRuns: 0,
          runs: [],
        },
      };
    }
  }

  try {
    const finalManifest = captureFixtureManifest(config.fixtureRoot);
    const comparison = compareFixtureManifests(startingManifest, finalManifest);
    cleanup.manifestMatch = cleanup.manifestMatch && comparison.matches;
    cleanup.restored = cleanup.restored && comparison.matches;
  } catch (error) {
    cleanup.manifestMatch = false;
    cleanup.restored = false;
    fatalError ??= error;
  }

  const report = buildSchemaV1Report({
    runId,
    selection,
    caseIds: config.caseIds,
    repetitions: config.repetitions,
    timeoutMs: config.timeoutMs,
    plannedRuns: config.caseIds.length * config.repetitions,
    executionFailed: fatalError !== null,
    sessionIds: [...sessionIds],
    caseResults,
    resources,
    cleanup,
  });
  const reportPath = writeSchemaV1Report(config.reportDirectory, report);

  if (fatalError) {
    fatalError.reportPath = reportPath;
    fatalError.report = report;
    throw fatalError;
  }
  return { report, reportPath };
};
