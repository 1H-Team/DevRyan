import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { summarizeGraders } from './graders.mjs';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

const FORBIDDEN_KEY = /(prompt|response|message|tool.?input|tool.?output|arguments?|headers?|cookies?|authorization|credentials?|base.?url|request.?url)/i;
const FORBIDDEN_STRING = /(?:https?:\/\/|\bbearer(?:\s+|_)|(?:^|[?&;\s_.:@/-])(?:token|api[_-]?key|password|cookie|authorization|credential|secret)(?:=|[_:.-]|$)|(?:^|[\s_.:@/-])error[:=]|(?:^|[\s])(?:~\/|\/Users\/|\/home\/|[a-zA-Z]:[\\/]))/i;

const finiteNumber = (value) => (Number.isFinite(value) ? value : null);
const nonNegativeInteger = (value) => (
  Number.isSafeInteger(value) && value >= 0 ? value : 0
);

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,255}$/;
const SAFE_ENUM = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
const UNSAFE_IDENTIFIER_SHAPE = /(?:https?:\/\/|\bbearer\b|(?:^|[_.:@/-])(?:token|api[_-]?key|password|cookie|authorization|credential|secret)(?:$|[_.:@/-])|^error(?:$|[:_\s-]))/i;

const identifierLooksUnsafe = (value) => (
  UNSAFE_IDENTIFIER_SHAPE.test(value)
  || /^(?:~|\/|\\|[a-zA-Z]:[\\/])/.test(value)
  || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)
);

const opaqueIdentifier = (value, prefix) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw && SAFE_IDENTIFIER.test(raw) && !identifierLooksUnsafe(raw)) return raw;
  const digest = createHash('sha256').update(raw || 'missing').digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
};

const normalizeRunId = (value) => (
  typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value.trim())
    && !identifierLooksUnsafe(value.trim())
    ? value.trim()
    : opaqueIdentifier(value, 'run')
);

const normalizeTool = (value) => (
  typeof value === 'string' && SAFE_ENUM.test(value.trim()) && !identifierLooksUnsafe(value.trim())
    ? value.trim().toLowerCase()
    : 'unknown'
);

const normalizeStatus = (value) => (
  typeof value === 'string' && SAFE_ENUM.test(value.trim()) && !identifierLooksUnsafe(value.trim())
    ? value.trim().toLowerCase()
    : 'unknown'
);

export const redactUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return '<invalid-url>';
  }
  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
  const pathname = url.pathname || '/';
  return `${isLoopback ? '<loopback>' : '<remote>'}${pathname}`;
};

export const redactHeaders = (headers = {}) => Object.fromEntries(
  Object.entries(headers)
    .map(([name, value]) => {
      const normalizedName = String(name).toLowerCase();
      return [
        normalizedName,
        SENSITIVE_HEADERS.has(normalizedName) ? '[redacted]' : String(value),
      ];
    })
    .sort(([left], [right]) => left.localeCompare(right)),
);

const buildTimingAggregate = (results) => {
  const values = results
    .map((result) => finiteNumber(result?.durationMs))
    .filter((value) => value !== null && value >= 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total: Math.round(total),
    minimum: values.length > 0 ? Math.round(Math.min(...values)) : null,
    maximum: values.length > 0 ? Math.round(Math.max(...values)) : null,
    mean: values.length > 0 ? Math.round((total / values.length) * 100) / 100 : null,
  };
};

const buildToolAggregate = (results) => {
  const byName = {};
  const byStatus = {};
  let total = 0;
  for (const result of results) {
    for (const event of Array.isArray(result?.tools) ? result.tools : []) {
      const name = normalizeTool(event?.tool);
      const status = normalizeStatus(event?.status);
      byName[name] = (byName[name] ?? 0) + 1;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      total += 1;
    }
  }
  return {
    total,
    byName: Object.fromEntries(Object.entries(byName).sort(([left], [right]) => left.localeCompare(right))),
    byStatus: Object.fromEntries(Object.entries(byStatus).sort(([left], [right]) => left.localeCompare(right))),
  };
};

const buildCaseAggregate = (results) => {
  const byCaseId = {};
  for (const result of results) {
    const caseId = normalizeStatus(result?.caseId);
    const current = byCaseId[caseId] ?? { runs: 0, passed: 0, failed: 0, durationMs: 0 };
    current.runs += 1;
    if (result?.status === 'passed') current.passed += 1;
    else current.failed += 1;
    const duration = finiteNumber(result?.durationMs);
    if (duration !== null && duration >= 0) current.durationMs += Math.round(duration);
    byCaseId[caseId] = current;
  }
  return Object.fromEntries(Object.entries(byCaseId).sort(([left], [right]) => left.localeCompare(right)));
};

const summarizeNumbers = (values) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total: Math.round(total * 100) / 100,
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null,
    mean: values.length > 0 ? Math.round((total / values.length) * 100) / 100 : null,
  };
};

const buildTurnTimingAggregate = (results) => {
  const valuesByMetric = new Map();
  for (const result of results) {
    for (const record of Array.isArray(result?.turnTiming?.records) ? result.turnTiming.records : []) {
      for (const [rawMetric, rawValue] of Object.entries(record?.durationsMs ?? {})) {
        const metric = normalizeStatus(rawMetric);
        if (metric === 'unknown' || FORBIDDEN_KEY.test(metric)) continue;
        const value = finiteNumber(rawValue);
        if (value === null || value < 0) continue;
        const values = valuesByMetric.get(metric) ?? [];
        values.push(value);
        valuesByMetric.set(metric, values);
      }
    }
  }
  return {
    byMetric: Object.fromEntries(
      [...valuesByMetric.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([metric, values]) => [metric, summarizeNumbers(values)]),
    ),
  };
};

const buildManagedAggregate = (results) => {
  const byStatus = {};
  const dispositions = {};
  let tasks = 0;
  for (const result of results) {
    const snapshot = result?.managedSnapshot;
    for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : []) {
      const status = normalizeStatus(task?.status);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      tasks += 1;
    }
    const envelopes = Array.isArray(snapshot?.resultEnvelopes)
      ? snapshot.resultEnvelopes
      : Array.isArray(snapshot?.results)
        ? snapshot.results
        : [];
    for (const envelope of envelopes) {
      if (typeof envelope?.action !== 'string' || !envelope.action.trim()) continue;
      const action = normalizeStatus(envelope.action);
      dispositions[action] = (dispositions[action] ?? 0) + 1;
    }
  }
  return {
    tasks,
    byStatus: Object.fromEntries(Object.entries(byStatus).sort(([left], [right]) => left.localeCompare(right))),
    dispositions: Object.fromEntries(Object.entries(dispositions).sort(([left], [right]) => left.localeCompare(right))),
  };
};

const projectProcessRun = (run) => {
  const projected = {};
  for (const key of [
    'baselineBytes',
    'finalBytes',
    'growthBytes',
    'growthPercent',
    'monotonicSettledSamples',
  ]) {
    const value = finiteNumber(run?.[key]);
    if (value !== null) projected[key] = value;
  }
  if (typeof run?.qualifies === 'boolean') projected.qualifies = run.qualifies;
  return projected;
};

const projectResources = (resources) => {
  const sampling = resources?.processSampling;
  if (!sampling || typeof sampling !== 'object') return { processSampling: null };
  return {
    processSampling: {
      classification: normalizeStatus(sampling.classification),
      reproducedRuns: nonNegativeInteger(sampling.reproducedRuns),
      runs: (Array.isArray(sampling.runs) ? sampling.runs : []).map(projectProcessRun),
    },
  };
};

const safeHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const runtimeVersion = (value) => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/.test(value.trim()) && !identifierLooksUnsafe(value.trim())
  ? value.trim() : 'unknown';
const projectFingerprint = (value) => value?.schemaVersion === 1 ? {
  schemaVersion: 1, configurationHash: safeHash(value.configurationHash), runtimeVersion: runtimeVersion(value.runtimeVersion),
  selection: { providerId: opaqueIdentifier(value.selection?.providerID, 'provider'), modelId: opaqueIdentifier(value.selection?.modelID, 'model'),
    agent: opaqueIdentifier(value.selection?.agent, 'agent'), variant: value.selection?.variant === null ? null : opaqueIdentifier(value.selection?.variant, 'variant') },
  role: { source: normalizeStatus(value.role?.source), sourceHash: safeHash(value.role?.sourceHash), contentHash: safeHash(value.role?.contentHash), bytes: finiteNumber(value.role?.bytes) },
  catalog: { contentHash: safeHash(value.catalog?.contentHash), idsHash: safeHash(value.catalog?.idsHash), count: finiteNumber(value.catalog?.count), availability: normalizeStatus(value.catalog?.availability) },
  plugins: { configured: Array.isArray(value.plugins?.configured) ? value.plugins.configured.slice(0, 128).map((entry) => ({ name: opaqueIdentifier(entry.name, 'plugin'), sourceHash: safeHash(entry.sourceHash) })) : null,
    observed: Array.isArray(value.plugins?.observed) ? value.plugins.observed.slice(0, 128).map((entry) => ({ name: opaqueIdentifier(entry.name, 'plugin'), contentHash: safeHash(entry.contentHash), factoryCalls: nonNegativeInteger(entry.factoryCalls), ownership: normalizeStatus(entry.ownership) })) : null },
  policies: Object.fromEntries(['readOverlap', 'waitAny', 'compactResults', 'contextProjection'].map((key) => [key, value.policies?.[key] === true])),
} : null;

const measured = (value) => ({ observed: nonNegativeInteger(value?.observed), unknown: nonNegativeInteger(value?.unknown), total: finiteNumber(value?.total) });
export const projectHarnessEvidence = (value) => ({
  startFingerprint: projectFingerprint(value?.startFingerprint), finishFingerprint: projectFingerprint(value?.finishFingerprint),
  availability: value?.availability ? { available: typeof value.availability.available === 'boolean' ? value.availability.available : null,
    variantAvailable: typeof value.availability.variantAvailable === 'boolean' ? value.availability.variantAvailable : null } : null,
  evidence: value?.trace?.schemaVersion === 1 ? { source: 'retained-journal', incomplete: value.trace.incomplete === true,
    sourceRecords: nonNegativeInteger(value.trace.sourceRecords), omittedRecords: nonNegativeInteger(value.trace.omittedRecords), omittedEvents: nonNegativeInteger(value.trace.omittedEvents),
    roots: Array.isArray(value.trace.roots) ? value.trace.roots.slice(0, 2048).map((root) => ({ rootSessionId: opaqueIdentifier(root.rootSessionId, 'session'),
      queueMs: measured(root.measurements?.queueMs), firstActivityMs: measured(root.measurements?.firstResponseMs),
      toolExecutionMs: measured(root.measurements?.toolExecutionMs), resultConsumptionMs: measured(root.measurements?.resultConsumptionMs),
      workspaceBarrierMs: measured(root.measurements?.workspaceBarrierMs), recoveryMs: measured(root.measurements?.recoveryMs),
      objectiveDurationMs: finiteNumber(root.totalObjectiveCriticalPathMs),
      usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'cost'].map((key) => [key, measured(root.measurements?.[key])])),
      costProvenance: ['native-runtime-reported', 'native-provider-reported'].includes(root.costProvenance)
        ? 'native-runtime-reported' : 'unavailable',
      toolVolumeBytes: measured(root.measurements?.toolVolumeBytes), retrievedPages: nonNegativeInteger(root.retrievedPages),
      context: Array.isArray(root.projections) ? root.projections.slice(0, 512).map((entry) => ({ beforeBytes: finiteNumber(entry.beforeBytes), projectedBytes: finiteNumber(entry.projectedBytes), dynamicBytes: finiteNumber(entry.dynamicBytes) })) : [],
    })) : [],
  } : null,
});

export const buildSchemaV1Report = (input = {}) => {
  const results = Array.isArray(input.caseResults) ? input.caseResults : [];
  const passed = results.filter((result) => result?.status === 'passed').length;
  const failed = results.length - passed;
  const graders = results.flatMap((result) => (
    Array.isArray(result?.graders) ? result.graders : []
  )).map((grader) => ({
    id: normalizeStatus(grader?.id),
    passed: grader?.passed === true,
  }));
  const plannedRuns = nonNegativeInteger(input.plannedRuns)
    || nonNegativeInteger(input.repetitions) * (Array.isArray(input.caseIds) ? input.caseIds.length : 0);
  const executionFailed = input.executionFailed === true || failed > 0;
  const report = {
    schemaVersion: 1,
    executionMode: input.executionMode === 'deterministic' ? 'deterministic' : 'live',
    fixtureHash: safeHash(input.fixtureHash),
    environmentHash: safeHash(input.environmentHash),
    runs: results.map((result) => ({ caseId: normalizeStatus(result.caseId), repetition: nonNegativeInteger(result.repetition),
      status: normalizeStatus(result.status), durationMs: finiteNumber(result.durationMs),
      errorCode: result.errorCode ? normalizeStatus(result.errorCode) : null,
      contract: result.contractEvidence ? { sourceHash: safeHash(result.contractEvidence.sourceHash), selected: nonNegativeInteger(result.contractEvidence.selected), mode: 'deterministic' } : null,
      harness: projectHarnessEvidence(result.harnessEvidence) })),
    runId: normalizeRunId(input.runId),
    selection: {
      providerId: opaqueIdentifier(input.selection?.providerId, 'provider'),
      modelId: opaqueIdentifier(input.selection?.modelId, 'model'),
      agent: opaqueIdentifier(input.selection?.agent, 'agent'),
      variant: input.selection?.variant === null
        ? null
        : opaqueIdentifier(input.selection?.variant, 'variant'),
    },
    plan: {
      caseIds: (Array.isArray(input.caseIds) ? input.caseIds : []).map(normalizeStatus),
      repetitions: nonNegativeInteger(input.repetitions),
      timeoutMs: nonNegativeInteger(input.timeoutMs),
      processSampling: Boolean(input.resources?.processSampling),
    },
    execution: {
      status: executionFailed ? 'failed' : 'passed',
      plannedRuns,
      completedRuns: results.length,
    },
    sessionIds: [...new Set(
      (Array.isArray(input.sessionIds) ? input.sessionIds : [])
        .map((value) => opaqueIdentifier(value, 'session'))
        .filter(Boolean),
    )],
    aggregates: {
      status: executionFailed ? 'failed' : 'passed',
      runs: results.length,
      passed,
      failed,
      byCaseId: buildCaseAggregate(results),
      timingMs: buildTimingAggregate(results),
      turnTimingMs: buildTurnTimingAggregate(results),
      tools: buildToolAggregate(results),
      managed: buildManagedAggregate(results),
    },
    resources: projectResources(input.resources),
    graders: summarizeGraders(graders),
    cleanup: {
      restored: input.cleanup?.restored === true,
      deletedOwnedFileCount: nonNegativeInteger(input.cleanup?.deletedOwnedFileCount),
      manifestMatch: input.cleanup?.manifestMatch === true,
      deletionFailureCount: nonNegativeInteger(input.cleanup?.deletionFailureCount),
      sessionComplete: input.cleanup?.sessionComplete === true,
      sessionDiscoveryComplete: input.cleanup?.sessionDiscoveryComplete === true,
      sessionAbortFailureCount: nonNegativeInteger(input.cleanup?.sessionAbortFailureCount),
    },
  };
  assertSchemaV1ReportSafe(report);
  return report;
};

export const assertSchemaV1ReportSafe = (report) => {
  const visit = (value, location) => {
    if (typeof value === 'string') {
      if (FORBIDDEN_STRING.test(value)) {
        throw new Error(`Unsafe evaluation report string at ${location}`);
      }
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new Error(`Unsafe evaluation report key at ${location}.${key}`);
      }
      visit(child, `${location}.${key}`);
    }
  };
  if (!report || typeof report !== 'object' || report.schemaVersion !== 1) {
    throw new Error('Unsafe evaluation report schema');
  }
  visit(report, '$');
  return true;
};

export const writeSchemaV1Report = (reportDirectory, report) => {
  assertSchemaV1ReportSafe(report);
  const resolvedReportDirectory = path.resolve(reportDirectory);
  mkdirSync(resolvedReportDirectory, { recursive: true, mode: 0o700 });
  const filename = `devryan-agent-eval-${report.runId}.json`;
  const reportPath = path.resolve(resolvedReportDirectory, filename);
  if (path.dirname(reportPath) !== resolvedReportDirectory) {
    throw new Error('Unsafe evaluation report filename');
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return reportPath;
};
