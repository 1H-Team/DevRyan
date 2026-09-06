import { consumePrivateToolIntervals } from './tool-evidence.mjs';

const TOOL_FAMILIES = Object.freeze({
  read: new Set([
    'read', 'file_read', 'oc_read', 'ctx_execute_file', 'ctx_index',
    'mcp__context_mode__ctx_execute_file', 'mcp__context_mode__ctx_index',
  ]),
  search: new Set([
    'grep', 'glob', 'search', 'find', 'oc_grep', 'oc_glob', 'ctx_search',
    'mcp__context_mode__ctx_search', 'ast_grep_search',
  ]),
  test: new Set(['bash', 'shell', 'terminal', 'exec', 'exec_command', 'oc_bash']),
  mutation: new Set([
    'edit', 'write', 'oc_edit', 'oc_write', 'apply_patch', 'patch', 'multiedit',
    'ast_grep_replace', 'rm',
  ]),
  managed: new Set(['task', 'devryan_task', 'council_session']),
  contextMode: new Set([
    'ctx_execute', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_index', 'ctx_search',
    'ctx_fetch_and_index',
    'mcp__context_mode__ctx_execute', 'mcp__context_mode__ctx_execute_file',
    'mcp__context_mode__ctx_batch_execute', 'mcp__context_mode__ctx_index',
    'mcp__context_mode__ctx_search', 'mcp__context_mode__ctx_fetch_and_index',
  ]),
  contextModeExecution: new Set([
    'ctx_execute', 'ctx_execute_file', 'ctx_batch_execute',
    'mcp__context_mode__ctx_execute', 'mcp__context_mode__ctx_execute_file',
    'mcp__context_mode__ctx_batch_execute',
  ]),
  nativeInspection: new Set([
    'read', 'file_read', 'oc_read', 'grep', 'glob', 'search', 'find', 'oc_grep',
    'oc_glob', 'ls', 'oc_ls', 'stat', 'oc_stat', 'ast_grep_search',
  ]),
  oracleInspection: new Set([
    'read', 'oc_read', 'glob', 'oc_glob', 'grep', 'ls', 'oc_ls', 'stat', 'oc_stat',
    'ast_grep_search', 'ctx_index', 'ctx_search', 'ctx_stats',
    'mcp__context_mode__ctx_index', 'mcp__context_mode__ctx_search',
    'mcp__context_mode__ctx_stats',
  ]),
});

const ORACLE_REVIEW_CASES = Object.freeze({
  'oracle-review-focused': {
    maximumDurationMs: 15 * 60 * 1_000,
    maximumToolCalls: 20,
    signals: ['authorization_boundary', 'stale_write'],
  },
  'oracle-review-deep': {
    maximumDurationMs: 30 * 60 * 1_000,
    maximumToolCalls: 50,
    signals: [
      'authorization_boundary',
      'idempotency_order',
      'stale_write',
      'webhook_monotonicity',
    ],
  },
});

const normalizeTool = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase().replace(/[.-]/g, '_') : ''
);

const isFinalEvent = (event) => {
  if (typeof event?.final === 'boolean') return event.final;
  return ['completed', 'error', 'failed', 'aborted'].includes(
    typeof event?.status === 'string' ? event.status.toLowerCase() : '',
  );
};

const hasFamily = (events, family, { final = false } = {}) => events.some((event) => (
  TOOL_FAMILIES[family].has(normalizeTool(event?.tool)) && (!final || isFinalEvent(event))
));

const result = (id, passed) => ({ id, passed: passed === true });

const validInterval = (interval) => (
  Number.isFinite(interval?.start)
  && interval.start >= 0
  && Number.isFinite(interval?.end)
  && interval.end >= interval.start
);

const selectCausalRepairChain = (events, intervalByEvent) => {
  const completionCounts = new Map();
  for (const event of events) {
    const completedAt = intervalByEvent.get(event)?.end;
    if (!Number.isFinite(completedAt) || completedAt < 0) continue;
    completionCounts.set(completedAt, (completionCounts.get(completedAt) ?? 0) + 1);
  }
  const candidates = events
    .map((event, index) => ({ event, index, interval: intervalByEvent.get(event) }))
    .filter(({ event, interval }) => (
      isFinalEvent(event)
      && validInterval(interval)
      && completionCounts.get(interval.end) === 1
    ))
    .sort((left, right) => (
      left.interval.end - right.interval.end
      || left.interval.start - right.interval.start
      || left.index - right.index
    ));
  const reads = candidates.filter(({ event }) => hasFamily([event], 'read', { final: true }));
  const failingTests = candidates.filter(({ event }) => (
    hasFamily([event], 'test', { final: true }) && event?.ownedTestOutcome === 'failed'
  ));
  const mutations = candidates.filter(({ event }) => (
    hasFamily([event], 'mutation', { final: true })
  ));
  const passingTests = candidates.filter(({ event }) => (
    hasFamily([event], 'test', { final: true }) && event?.ownedTestOutcome === 'passed'
  ));

  for (const read of reads) {
    for (const failingTest of failingTests) {
      if (read.interval.end > failingTest.interval.start) continue;
      for (const mutation of mutations) {
        if (failingTest.interval.end > mutation.interval.start) continue;
        for (const passingTest of passingTests) {
          if (mutation.interval.end <= passingTest.interval.start) {
            return [read.event, failingTest.event, mutation.event, passingTest.event];
          }
        }
      }
    }
  }
  return null;
};

export const gradeToolRequirements = (caseId, toolEvents = []) => {
  const events = Array.isArray(toolEvents) ? toolEvents : [];
  const intervalByEvent = consumePrivateToolIntervals(events);
  if (caseId === 'inspect') {
    const passed = hasFamily(events, 'read', { final: true })
      && hasFamily(events, 'search', { final: true })
      && hasFamily(events, 'test', { final: true })
      && !hasFamily(events, 'mutation');
    return result('inspect.tools', passed);
  }
  if (caseId === 'context-large-analysis') {
    const rootEvents = events.filter((event) => event?.sessionScope === 'root');
    return result(
      'context-large-analysis.tools',
      hasFamily(rootEvents, 'contextMode', { final: true })
        && !hasFamily(events, 'mutation'),
    );
  }
  if (caseId === 'context-explorer-analysis') {
    const rootEvents = events.filter((event) => event?.sessionScope === 'root');
    const childEvents = events.filter((event) => event?.sessionScope === 'child');
    return result(
      'context-explorer-analysis.tools',
      hasFamily(rootEvents, 'managed', { final: true })
        && hasFamily(childEvents, 'contextMode', { final: true })
        && !hasFamily(events, 'mutation'),
    );
  }
  if (caseId === 'context-bounded-lookup') {
    const rootEvents = events.filter((event) => event?.sessionScope === 'root');
    return result(
      'context-bounded-lookup.tools',
      hasFamily(rootEvents, 'nativeInspection', { final: true })
        && !hasFamily(events, 'contextMode')
        && !hasFamily(events, 'mutation'),
    );
  }
  if (caseId === 'repair-and-test' || caseId === 'managed-repair-and-test') {
    const managed = caseId === 'managed-repair-and-test';
    const id = `${caseId}.tools`;
    for (const event of events) delete event.ordinal;
    const relevantEvents = events.filter((event) => (
      hasFamily([event], 'read')
      || hasFamily([event], 'test')
      || hasFamily([event], 'mutation')
    ));
    if (relevantEvents.some((event) => event?.sessionScope !== 'root'
      && (!managed || event.sessionScope !== 'child'))) {
      return result(id, false);
    }
    // Managed QA separately verifies exact task/child/result membership. Keep
    // each tool's actual scope while allowing its repair to cross that graph.
    const chain = selectCausalRepairChain(relevantEvents, intervalByEvent);
    if (!chain) return result(id, false);
    chain.forEach((event, index) => { event.ordinal = index + 1; });
    return result(id, true);
  }
  if (caseId === 'managed-change') {
    const childEvents = events.filter((event) => event?.sessionScope === 'child');
    return result(
      'managed-change.tools',
      hasFamily(events, 'managed', { final: true })
        && hasFamily(childEvents, 'contextModeExecution', { final: true })
        && hasFamily(events, 'mutation', { final: true })
        && hasFamily(events, 'test', { final: true }),
    );
  }
  const oracleReview = ORACLE_REVIEW_CASES[caseId];
  if (oracleReview) {
    return result(
      `${caseId}.tools`,
      events.length > 0
        && events.length <= oracleReview.maximumToolCalls
        && events.every((event) => event?.sessionScope === 'root')
        && events.every((event) => TOOL_FAMILIES.oracleInspection.has(normalizeTool(event?.tool)))
        && hasFamily(events, 'read', { final: true })
        && !hasFamily(events, 'test')
        && !hasFamily(events, 'mutation')
        && !hasFamily(events, 'managed'),
    );
  }
  return result('unknown.tools', false);
};

export const gradeCaseOutcome = (input = {}) => {
  const caseId = input.caseId;
  const manifestSafe = input.nonOwnedManifestMatches === true;
  const finalTestPassed = input.finalTest?.exitCode === 0;
  if (caseId === 'inspect') {
    return result(
      'inspect.filesystem-test',
      manifestSafe
        && input.ownedSourceChanged !== true
        && input.ownedTestChanged !== true
        && finalTestPassed,
    );
  }
  if (
    caseId === 'context-large-analysis'
    || caseId === 'context-explorer-analysis'
    || caseId === 'context-bounded-lookup'
  ) {
    return result(
      `${caseId}.filesystem-test`,
      manifestSafe
        && input.ownedSourceChanged === false
        && input.ownedTestChanged === false
        && finalTestPassed,
    );
  }
  if (caseId === 'repair-and-test' || caseId === 'managed-change') {
    return result(
      `${caseId}.filesystem-test`,
      manifestSafe
        && input.ownedSourceChanged === true
        && input.ownedTestChanged === false
        && input.baselineTest?.exitCode !== 0
        && finalTestPassed,
    );
  }
  if (ORACLE_REVIEW_CASES[caseId]) {
    return result(
      `${caseId}.filesystem`,
      manifestSafe
        && input.ownedSourceChanged === false
        && input.ownedTestChanged === false
        && input.finalTest == null,
    );
  }
  return result('unknown.filesystem-test', false);
};

export const gradeOracleReviewOutcome = (input = {}) => {
  const reviewCase = ORACLE_REVIEW_CASES[input.caseId];
  if (!reviewCase) return [result('unknown.oracle-review', false)];
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const signals = Array.isArray(evidence.signals)
    ? [...new Set(evidence.signals.filter((signal) => typeof signal === 'string'))].sort()
    : [];
  const expectedSignals = [...reviewCase.signals].sort();
  return [
    result(
      `${input.caseId}.findings`,
      signals.length === expectedSignals.length
        && expectedSignals.every((signal, index) => signals[index] === signal),
    ),
    result(
      `${input.caseId}.evidence`,
      evidence.pathLineEvidence === true && evidence.terminalComplete === true,
    ),
    result(
      `${input.caseId}.latency`,
      Number.isFinite(input.durationMs)
        && input.durationMs >= 0
        && input.durationMs <= reviewCase.maximumDurationMs,
    ),
  ];
};

export const gradeManagedTaskOutcome = (input = {}) => {
  const rootSessionId = typeof input.rootSessionId === 'string' ? input.rootSessionId : '';
  const rawChildIds = Array.isArray(input.childSessionIds) ? input.childSessionIds : [];
  const childIds = new Set(rawChildIds);
  const snapshot = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : {};
  if (snapshot.available === false) return result('managed.task-disposition', false);
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : [])
    .filter((task) => task?.rootSessionId === rootSessionId);
  const envelopes = Array.isArray(snapshot.resultEnvelopes)
    ? snapshot.resultEnvelopes
    : Array.isArray(snapshot.results)
      ? snapshot.results
      : [];
  const taskIds = tasks.map((task) => task?.taskId);
  const taskChildIds = tasks.map((task) => task?.childSessionId);
  const envelopeTaskIds = envelopes.map((envelope) => envelope?.taskId);
  const uniqueTaskIds = new Set(taskIds);
  const uniqueTaskChildIds = new Set(taskChildIds);
  const uniqueEnvelopeTaskIds = new Set(envelopeTaskIds);
  const validIds = (values) => values.every((value) => typeof value === 'string' && value);
  const sameMembers = (left, right) => (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
  const passed = rawChildIds.length > 0
    && validIds(rawChildIds)
    && childIds.size === rawChildIds.length
    && tasks.length === rawChildIds.length
    && validIds(taskIds)
    && uniqueTaskIds.size === tasks.length
    && validIds(taskChildIds)
    && uniqueTaskChildIds.size === tasks.length
    && sameMembers(childIds, uniqueTaskChildIds)
    && envelopes.length === tasks.length
    && validIds(envelopeTaskIds)
    && uniqueEnvelopeTaskIds.size === envelopes.length
    && sameMembers(uniqueTaskIds, uniqueEnvelopeTaskIds)
    && tasks.every((task) => (
      task?.status === 'completed'
    ))
    && envelopes.every((envelope) => (
      envelope?.status === 'completed' && envelope?.action === 'continue'
    ));
  return result('managed.task-disposition', passed);
};

export const summarizeGraders = (graders = []) => {
  const byId = {};
  let passed = 0;
  let failed = 0;
  for (const grader of graders) {
    if (!grader || typeof grader.id !== 'string' || !grader.id) continue;
    if (!byId[grader.id]) byId[grader.id] = { passed: 0, failed: 0 };
    if (grader.passed === true) {
      byId[grader.id].passed += 1;
      passed += 1;
    } else {
      byId[grader.id].failed += 1;
      failed += 1;
    }
  }
  return {
    total: passed + failed,
    passed,
    failed,
    byId: Object.fromEntries(Object.entries(byId).sort(([left], [right]) => left.localeCompare(right))),
  };
};
