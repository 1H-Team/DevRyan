import { projectUsageObservation, runtimeUsageObservation, USAGE_TOKEN_FIELDS } from '../../shared-runtime/lib/usage-observation.js';
import { resolveRecordSessionID, resolveSessionRelation } from './session-id.js';

const metric = values => ({ known: values.filter(v => v !== null).length, unknown: values.filter(v => v === null).length,
  total: values.some(v => v !== null) ? values.reduce((a, b) => a + (b ?? 0), 0) : null });
const groupBy = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) { const key = keyOf(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  return groups;
};
const elapsed = (a, b) => a?.at !== null && b?.at !== null && a?.origin === b?.origin
  && a?.origin !== 'unknown' && b?.at >= a?.at ? b.at - a.at : null;
const summarize = rows => {
  const ratioRows = rows.filter(row => row.tokens.totalInput !== null && row.tokens.cacheRead !== null
    && row.tokens.cacheRead <= row.tokens.totalInput);
  const input = ratioRows.reduce((n, row) => n + row.tokens.totalInput, 0);
  const requests = rows.filter(row => row.source === 'provider_request' && row.counterMode === 'delta');
  const knownRequests = requests.filter(row => row.tokens.cacheRead !== null);
  const hits = knownRequests.filter(row => row.tokens.cacheRead > 0).length;
  const dispatches = rows.map(row => row.timing.dispatch).filter(t => t.at !== null);
  const completions = rows.map(row => row.timing.completion).filter(t => t.at !== null);
  const origins = new Set([...dispatches, ...completions].map(t => t.origin));
  const costs = {};
  for (const row of rows) {
    const key = `${row.cost.provenance}:${row.cost.currency ?? 'unknown'}`;
    (costs[key] ??= []).push(row.cost.amount);
  }
  return {
    observations: rows.length, tokens: Object.fromEntries(USAGE_TOKEN_FIELDS.map(key => [key, metric(rows.map(row => row.tokens[key]))])),
    cacheReadTokenRatio: input > 0 ? ratioRows.reduce((n, row) => n + row.tokens.cacheRead, 0) / input : null,
    ratioCoverage: { known: ratioRows.length, unknown: rows.length - ratioRows.length },
    requestHitRate: knownRequests.length ? hits / knownRequests.length : null,
    requests: { observed: requests.length, knownCacheUsage: knownRequests.length, hits, unknownCacheUsage: requests.length - knownRequests.length },
    responseModelCoverage: rows.filter(row => row.responseModel !== null).length,
    modelMismatches: rows.filter(row => row.requestedModel && row.responseModel && row.requestedModel !== row.responseModel).length,
    costs: Object.fromEntries(Object.entries(costs).map(([key, values]) => [key, metric(values)])),
    requestDurationMs: metric(rows.map(row => elapsed(row.timing.dispatch, row.timing.completion))),
    timeToFirstTokenMs: metric(rows.map(row => elapsed(row.timing.dispatch, row.timing.firstToken))),
    interRequestGapMs: metric(rows.map(row => elapsed(row.timing.previousCompletion, row.timing.dispatch))),
    observedSpanMs: dispatches.length === rows.length && completions.length === rows.length && rows.length > 0
      && origins.size === 1 && !origins.has('unknown')
      ? Math.max(...completions.map(t => t.at)) - Math.min(...dispatches.map(t => t.at)) : null,
  };
};
// Prefix continuity from numeric usage alone, with no request-path hashing.
// After a request the provider can reuse at most the prefix it cached: reads
// plus writes when the stream reports explicit writes, otherwise its whole
// input (implicit caching). A later request in the same stream reading much
// less lost that prefix. Provider eviction also produces a loss, so the idle
// gap is reported, and a compaction between requests resets the stream.
// A break that reads back no more than the stream's first request (the shared
// system/tool prefix every request gets) is a provider-side reset: routing or
// eviction dropped the conversation's entry although the request stayed
// append-only (observed for xAI Grok on the wire, 2026-09-24). A break above
// that floor lost only part of the prefix, which a request change can cause.
const CONTINUITY_MIN_LOSS = 1024;
const CONTINUITY_WARM_GAP_MS = 5 * 60 * 1000;
const at = row => row.timing.completion.at ?? row.observedAt;
const continuity = rows => {
  const compactions = groupBy(rows.filter(row => row.purpose === 'compaction' && at(row) !== null), row => row.sessionID);
  const result = { compared: 0, unknown: 0, breaks: 0, breaksWithinWarmGap: 0, lostPrefixTokensWithinWarmGap: 0,
    resetBreaksWithinWarmGap: 0, partialBreaksWithinWarmGap: 0, explicitStreams: 0, implicitStreams: 0 };
  const streams = groupBy(rows.filter(row => row.sessionID && row.purpose !== 'compaction'),
    row => JSON.stringify([row.sessionID, row.provider, row.route, row.requestedModel]));
  for (const stream of streams.values()) {
    if (stream.length < 2) continue;
    const explicit = stream.some(row => row.tokens.cacheWrite > 0);
    result[explicit ? 'explicitStreams' : 'implicitStreams']++;
    const resets = (compactions.get(stream[0].sessionID) ?? []).map(at);
    const floor = stream[0].tokens.cacheRead ?? 0;
    for (let index = 1; index < stream.length; index++) {
      const previous = stream[index - 1], current = stream[index];
      const expected = explicit ? sumKnown(previous.tokens.cacheRead, previous.tokens.cacheWrite) : previous.tokens.totalInput;
      if (expected === null || current.tokens.cacheRead === null) { result.unknown++; continue; }
      const from = at(previous), to = at(current);
      if (from !== null && to !== null && resets.some(time => time > from && time <= to)) continue;
      result.compared++;
      const loss = expected - current.tokens.cacheRead;
      if (loss <= Math.max(CONTINUITY_MIN_LOSS, expected * 0.05)) continue;
      result.breaks++;
      if (from !== null && to !== null && to >= from && to - from <= CONTINUITY_WARM_GAP_MS) {
        result.breaksWithinWarmGap++; result.lostPrefixTokensWithinWarmGap += loss;
        result[current.tokens.cacheRead <= floor ? 'resetBreaksWithinWarmGap' : 'partialBreaksWithinWarmGap']++;
      }
    }
  }
  return result;
};
const sumKnown = (a, b) => a !== null && b !== null ? a + b : null;
const cohorts = rows => {
  const group = field => Object.fromEntries([...new Set(rows.map(row => row[field] ?? 'unknown'))]
    .map(key => [key, summarize(rows.filter(row => (row[field] ?? 'unknown') === key))]));
  const all = summarize(rows), helpers = summarize(rows.filter(row => !['main', 'unknown'].includes(row.purpose)));
  return { all, byPurpose: group('purpose'), byUse: group('use'), helpers,
    helperInputShare: !rows.some(row => row.purpose === 'unknown') && all.tokens.totalInput.unknown === 0 && helpers.tokens.totalInput.unknown === 0 && all.tokens.totalInput.total > 0
      ? (helpers.tokens.totalInput.total ?? 0) / all.tokens.totalInput.total : null };
};

// Aggregation is rebuilt from the retained journal. No second database or new
// retention policy: deleted helper sessions remain available until journal expiry.
export function createUsageCollector({ maxObservations = 100_000, maxBytes = 32 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxObservations) || maxObservations < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new TypeError('Invalid usage bounds');
  const observations = new Map(), relations = new Map(), purposes = new Map(), messages = new Map(), turns = new Map(), versions = new Map();
  const responseOwners = new Map();
  let bytes = 0, omitted = 0, gaps = 0, duplicates = 0;
  const retain = (map, key, value) => {
    const before = map.get(key), size = Buffer.byteLength(JSON.stringify(value)) - (before ? Buffer.byteLength(JSON.stringify(before)) : 0)
      + (map.has(key) ? 0 : Buffer.byteLength(String(key)));
    if (bytes + size > maxBytes || (!map.has(key) && map.size >= maxObservations)) { omitted++; return; }
    map.set(key, value); bytes += size;
  };
  const add = record => {
    if (record?.type === 'gap' || record?.gap) gaps++;
    const relation = resolveSessionRelation(record);
    if (relation) retain(relations, relation.sessionID, relation.parentID);
    if (record?.type === 'lifecycle' && record.event === 'harness_run_start' && record.userMessageID
      && /^[a-zA-Z0-9._-]{1,80}$/.test(record.payload?.fingerprint?.runtimeVersion ?? '')) {
      retain(versions, `${resolveRecordSessionID(record)}:${record.userMessageID}`, record.payload.fingerprint.runtimeVersion);
    }
    if (record?.type === 'lifecycle' && record.event === 'session_title_generation' && record.payload?.helperSessionID) {
      retain(purposes, record.payload.helperSessionID, 'title');
    }
    if (record?.type === 'lifecycle' && ['turn_started', 'turn_completed', 'turn_aborted', 'turn_failed'].includes(record.event)) {
      const key = `${resolveRecordSessionID(record)}:${record.userMessageID}`, previous = turns.get(key);
      const validTime = value => Number.isFinite(value) && value >= 0 ? value : null;
      retain(turns, key, { sessionID: resolveRecordSessionID(record),
        start: validTime(record.payload?.startedAt) ?? previous?.start ?? (record.event === 'turn_started' ? validTime(record.at) : null),
        end: validTime(record.payload?.settledAt) ?? previous?.end ?? (record.event !== 'turn_started' ? validTime(record.at) : null) });
    }
    const observation = projectUsageObservation(record?.usageObservation) ?? runtimeUsageObservation(record);
    if (!observation) return;
    const row = projectUsageObservation({ ...observation, sessionID: observation.sessionID ?? resolveRecordSessionID(record) });
    const counterIdentity = row.counterMode === 'cumulative' && row.counterScopeID && row.sequence !== null;
    const responseOnly = row.source === 'provider_request' && !row.attemptID && row.responseID;
    const key = responseOnly ? JSON.stringify([row.source, row.provider, row.route, row.responseID])
      : JSON.stringify([row.source, row.sessionID, counterIdentity ? [row.counterScopeID, row.sequence]
      : row.source === 'provider_request' ? row.attemptID ?? row.responseID ?? row.observationID : row.stepID ?? row.messageID ?? row.observationID]);
    const previous = observations.get(key);
    if (responseOnly) {
      const owners = responseOwners.get(key) ?? [];
      if (!owners.some(owner => owner.sessionID === row.sessionID && owner.rootSessionID === row.rootSessionID)) {
        retain(responseOwners, key, [...owners, { sessionID: row.sessionID, rootSessionID: row.rootSessionID }]);
      }
    }
    if (previous) {
      duplicates++;
      if ((previous.observedAt ?? 0) > (row.observedAt ?? 0)) return;
      if (['complete', 'failed', 'aborted'].includes(previous.status) && ['dispatched', 'unknown'].includes(row.status)) row.status = previous.status;
      // Dispatch observations and split stream usage are snapshots of one
      // attempt, never additive. A later partial event cannot erase known usage.
      row.tokens = Object.fromEntries(USAGE_TOKEN_FIELDS.map(field => [field, row.tokens[field] ?? previous.tokens[field]]));
      if (row.cost.amount === null) row.cost = previous.cost;
      for (const field of Object.keys(row.timing)) if (row.timing[field].at === null) row.timing[field] = previous.timing[field];
      for (const field of ['provider', 'route', 'requestedModel', 'responseModel', 'messageID', 'rootSessionID']) row[field] ??= previous[field];
    }
    retain(observations, key, row);
    if (row.source === 'message_aggregate' && row.messageID) retain(messages, `${row.sessionID}:${row.messageID}`, row);
  };
  const finish = () => {
    let cumulativeGaps = 0, conflicts = 0, attributionConflicts = 0;
    const counters = new Map();
    const rootOf = session => {
      const seen = new Set();
      while (relations.has(session) && !seen.has(session)) { seen.add(session); session = relations.get(session); }
      return session ?? 'unknown';
    };
    const rows = [...observations.entries()].sort(([, a], [, b]) => (a.sequence ?? a.observedAt ?? 0) - (b.sequence ?? b.observedAt ?? 0)).map(([key, original]) => {
      let row = { ...original, tokens: { ...original.tokens }, cost: { ...original.cost } };
      if (row.counterMode === 'cumulative') {
        const key = JSON.stringify([row.source, row.sessionID, row.counterScopeID]);
        const previous = row.counterScopeID && row.sequence !== null ? counters.get(key) : null;
        const baseline = previous?.tokens ?? (row.cumulativeFromZero ? Object.fromEntries(USAGE_TOKEN_FIELDS.map(f => [f, 0])) : null);
        const valid = baseline && (!previous || row.sequence > previous.sequence);
        for (const field of USAGE_TOKEN_FIELDS) row.tokens[field] = valid && row.tokens[field] !== null && baseline[field] !== null
          && row.tokens[field] >= baseline[field] ? row.tokens[field] - baseline[field] : null;
        const priorCost = previous ? previous.cost.amount : row.cumulativeFromZero ? 0 : null;
        const sameCost = !previous || previous.cost.currency === row.cost.currency && previous.cost.provenance === row.cost.provenance;
        row.cost.amount = valid && sameCost && priorCost !== null && row.cost.amount !== null && row.cost.amount >= priorCost ? row.cost.amount - priorCost : null;
        if (!valid || USAGE_TOKEN_FIELDS.some(f => original.tokens[f] !== null && row.tokens[f] === null)
          || original.cost.amount !== null && row.cost.amount === null) cumulativeGaps++;
        if (row.counterScopeID && row.sequence !== null) counters.set(key, original);
        // Counter deltas are not evidence of individual HTTP requests.
      }
      const parent = messages.get(`${row.sessionID}:${row.messageID}`);
      if (row.source === 'runtime_step' && parent) row = { ...row, provider: row.provider ?? parent.provider,
        requestedModel: row.requestedModel ?? parent.requestedModel, parentMessageID: row.parentMessageID ?? parent.parentMessageID, purpose: parent.purpose };
      row.runtimeVersion ??= versions.get(`${row.sessionID}:${row.parentMessageID}`) ?? null;
      row.purpose = purposes.get(row.sessionID) ?? row.purpose;
      row.rootSessionID = row.rootSessionID ?? rootOf(row.sessionID);
      // Resolve copied native responses only after all retained session
      // relations are known. Preserve a shared root, never a guessed session.
      const owners = responseOwners.get(key) ?? [];
      if (new Set(owners.map(owner => owner.sessionID)).size > 1 || new Set(owners.map(owner => owner.rootSessionID)).size > 1) {
        const roots = new Set(owners.map(owner => owner.rootSessionID ?? rootOf(owner.sessionID)));
        attributionConflicts++;
        row.sessionID = null; row.rootTaskID = null; row.purpose = 'unknown';
        row.rootSessionID = roots.size === 1 ? [...roots][0] : 'unknown';
      }
      if (row.tokens.totalInput !== null && ((row.tokens.cacheRead ?? 0) + (row.tokens.cacheWrite ?? 0) > row.tokens.totalInput)) {
        conflicts++; row.tokens = { ...row.tokens, totalInput: null, uncachedInput: null };
      }
      return row;
    });
    const roots = [];
    const turnsBySession = groupBy(turns.values(), turn => turn.sessionID);
    let reportBytes = 0, omittedRoots = 0;
    for (const [rootSessionID, taskRows] of groupBy(rows, row => row.rootSessionID)) {
      const stepped = new Set(taskRows.filter(row => row.source === 'runtime_step').map(row => `${row.sessionID}:${row.messageID}`));
      const runtime = taskRows.filter(row => row.source === 'runtime_step' || (row.source === 'message_aggregate' && !stepped.has(`${row.sessionID}:${row.messageID}`)));
      const provider = taskRows.filter(row => row.source === 'provider_request');
      const taskTurns = turnsBySession.get(rootSessionID) ?? [];
      const result = { rootSessionID, runtime: cohorts(runtime), provider: cohorts(provider),
        continuity: { runtime: continuity(runtime), provider: continuity(provider) },
        observedTaskSpanMs: taskTurns.length > 0 && taskTurns.every(turn => turn.start !== null && turn.end !== null && turn.end >= turn.start)
          ? Math.max(...taskTurns.map(turn => turn.end)) - Math.min(...taskTurns.map(turn => turn.start)) : null,
        // Separate route/model cohorts prevent an identity switch from looking
        // like an improvement. Requested and response-reported IDs both survive.
        routes: [...groupBy(taskRows, row => JSON.stringify([row.provider, row.route, row.auth, row.requestedModel, row.responseModel]))].map(([key, routeRows]) => ({
          identity: JSON.parse(key), bySource: Object.fromEntries(['provider_request', 'runtime_step', 'message_aggregate'].map(source => [source,
            summarize(routeRows.filter(row => row.source === source))])),
        })),
      };
      const size = Buffer.byteLength(JSON.stringify(result));
      if (reportBytes + size > maxBytes) omittedRoots++;
      else { roots.push(result); reportBytes += size; }
    }
    const unsettled = rows.filter(row => ['dispatched', 'unknown'].includes(row.status)).length;
    return { version: 1, source: 'retained-journal', incomplete: omitted > 0 || omittedRoots > 0 || gaps > 0 || cumulativeGaps > 0 || conflicts > 0 || unsettled > 0 || attributionConflicts > 0,
      coverage: { retained: rows.length, omitted, omittedRoots, journalGaps: gaps, duplicates, cumulativeGaps, conflicts, unsettled, attributionConflicts }, roots,
      limitations: ['Provider and runtime totals overlap and must not be added.',
        'Runtime steps replace message aggregates; missing steps or expired records can undercount.',
        'Cumulative gaps leave known totals as partial lower bounds; missing intervals are not assigned to a later purpose.',
        'Known totals are partial when coverage is incomplete. First use does not imply a provider cache flush.',
        'Costs retain their provenance; subscription billing and quota consumption are unknown.'],
      observations: rows };
  };
  return { add, finish };
}
