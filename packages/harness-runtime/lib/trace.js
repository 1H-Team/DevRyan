import { canonicalDevRyanEventType } from '@devryan/shared-runtime/lib/event-types.js';
import crypto from 'node:crypto';
import { resolveRecordSessionID, resolveSessionRelation } from './session-id.js';
import { projectUsageObservation } from '../../shared-runtime/lib/usage-observation.js';

const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
  && !/(?:bearer|password|secret|credential|api.key)/i.test(value) ? value : null;
const id = (value) => label(value) ?? (typeof value === 'string'
  ? `ref_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}` : null);
const size = (value) => typeof value === 'string' ? Buffer.byteLength(value)
  : value?.type === 'blob' ? number(value.size) : null;
const duration = (start, end) => number(start) !== null && number(end) !== null && end >= start ? end - start : null;
// A root's objectives are its user turns. Their critical path is the union of
// their intervals, so overlap is counted once; it is unknown until all settle.
const objectiveCriticalPath = (intervals) => {
  if (!intervals.length || intervals.includes(null)) return null;
  let total = 0, end = -Infinity;
  for (const [start, finish] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (finish <= end) continue;
    total += finish - Math.max(start, end);
    end = finish;
  }
  return total;
};
const fields = ['taskId', 'rootSessionId', 'childSessionId', 'parentTaskId', 'priorTaskId', 'envelopeId',
  'messageID', 'assistantMessageID', 'userMessageID', 'callID', 'providerRequestID', 'recoveryLineageId',
  'recoveryMessageID', 'runtimeInstanceID'];
// Helper agents and the usage purposes their direct provider calls record.
const HELPER_AGENTS = new Set(['devryan-title', 'devryan-commit', 'devryan-pr', 'devryan-branch', 'devryan-notify']);
const HELPER_PURPOSES = new Set(['title', 'commit', 'pr', 'other_helper']);
const metadata = (source = {}) => Object.fromEntries([
  ...fields.flatMap((key) => source[key] == null ? [] : [[key, id(source[key])]]),
  ...['attempt', 'sequence', 'generation', 'cancellationGeneration', 'count', 'bytes', 'exitCode'].flatMap((key) =>
    Number.isFinite(source[key]) ? [[key, source[key]]] : []),
  ...['status', 'state', 'phase', 'failureKind', 'reason', 'rejectionState'].flatMap((key) => label(source[key]) ? [[key, source[key]]] : []),
]);

// Projection over retained journal evidence only. Missing timestamps and usage
// stay unknown. No transcript, tool arguments, reasoning or provider blobs are
// copied into the trace. Distinct tool lanes avoid non-nested overlapping slices.
export const createHarnessTraceCollector = ({ maxEvents = 100_000, maxBytes = 32 * 1024 * 1024 } = {}) => {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new TypeError('Invalid trace bounds');
  const tasks = new Map(), tools = new Map(), usage = new Map(), relations = new Map(), turns = new Map(), objectives = new Map();
  // Direct helper provider calls (no native session) and their usage records.
  const helperCalls = new Map(), helperUsage = new Map(), helperSessions = new Set();
  const observations = [];
  let sourceRecords = 0, omittedRecords = 0, retainedBytes = 0;
  const keep = (map, key, value) => {
    if (!key) return;
    const previous = map.get(key);
    const extra = Buffer.byteLength(JSON.stringify(value)) - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
    if (retainedBytes + extra > maxBytes || (!previous && map.size >= maxEvents)) { omittedRecords++; return; }
    map.set(key, value); retainedBytes += extra;
  };
  const add = (record) => {
    sourceRecords++;
    const relation = resolveSessionRelation(record);
    if (relation) keep(relations, id(relation.sessionID), id(relation.parentID));
    const sessionID = id(resolveRecordSessionID(record)) ?? 'runtime';
    const payload = record?.payload ?? {}, p = payload.properties ?? {}, at = number(record?.at);
    if (record?.type === 'lifecycle' && record.event === 'session_title_generation') {
      // A helper session is attributed to its title owner by the relation above.
      if (payload.helperSessionID) helperSessions.add(id(payload.helperSessionID));
      // A session-model attempt without a helper session is a direct provider
      // call on the owner's behalf; its usage must arrive as a usage record.
      else if (payload.stage === 'session_model' && sessionID !== 'runtime') {
        keep(helperCalls, `${sessionID}:${number(payload.attempt) ?? 'unknown'}:${at ?? 'unknown'}`, { sessionID, purpose: 'title' });
      }
    }
    const observation = projectUsageObservation(record?.usageObservation);
    if (observation?.source === 'provider_request' && HELPER_PURPOSES.has(observation.purpose)) {
      // Prefer the recorded originating root; otherwise the calling session.
      keep(helperUsage, `${observation.source}:${observation.observationID}`, { root: id(observation.rootSessionID),
        sessionID: id(observation.sessionID), purpose: observation.purpose,
        input: observation.tokens.uncachedInput, output: observation.tokens.output,
        cacheRead: observation.tokens.cacheRead, cacheWrite: observation.tokens.cacheWrite, cost: observation.cost.amount });
    }
    if (canonicalDevRyanEventType(payload.type) === 'devryan:managed-task' && p.task) {
      const task = p.task, key = id(task.taskId), previous = tasks.get(key);
      if (previous && number(previous.sequence) > number(task.sequence)) return;
      const envelope = p.resultEnvelope;
      keep(tasks, key, { ...metadata(task), sessionID: id(task.rootSessionId) ?? sessionID,
        createdAt: number(task.createdAt), startedAt: number(task.startedAt), finishedAt: number(task.finishedAt),
        childPromptedAt: number(task.childPromptedAt), firstAssistantPartAt: number(task.firstAssistantPartAt),
        deliveryAt: number(envelope?.createdAt), consumedAt: number(envelope?.acknowledgedAt),
        envelopeId: id(envelope?.envelopeId), action: label(envelope?.action), at });
      if (task.childSessionId && task.rootSessionId) keep(relations, id(task.childSessionId), id(task.rootSessionId));
    }
    const part = p.part;
    if (payload.type === 'message.part.updated' && part?.type === 'tool'
      && ['completed', 'error'].includes(part.state?.status)) {
      keep(tools, `${sessionID}:${id(part.callID)}`, { sessionID, callID: id(part.callID), messageID: id(part.messageID),
        tool: label(part.tool) ?? 'tool', status: part.state.status, startedAt: number(part.state.time?.start),
        finishedAt: number(part.state.time?.end), bytes: size(part.state.output ?? part.state.error),
        retrievedPage: part.tool === 'devryan_task' && part.state.input?.action === 'read_result', at });
    }
    if (payload.type === 'message.updated' && p.info?.role === 'assistant' && number(p.info.time?.completed) !== null) {
      const info = p.info;
      keep(usage, `${sessionID}:${id(info.id)}`, { sessionID, messageID: id(info.id), parentID: id(info.parentID),
        completedAt: number(info.time.completed), input: number(info.tokens?.input), output: number(info.tokens?.output),
        cacheRead: number(info.tokens?.cache?.read), cacheWrite: number(info.tokens?.cache?.write),
        cost: number(info.cost), successful: !info.error, helper: HELPER_AGENTS.has(info.agent) });
    }
    if (record?.type === 'lifecycle' && ['turn_started', 'turn_completed', 'turn_failed', 'turn_aborted'].includes(record.event)) {
      const key = `${sessionID}:${id(record.userMessageID)}`, previous = turns.get(key);
      keep(turns, key, { sessionID, userMessageID: id(record.userMessageID), startedAt: number(payload.startedAt) ?? previous?.startedAt ?? at,
        settledAt: number(payload.settledAt) ?? previous?.settledAt ?? null, outcome: label(payload.outcome) });
    }
    if (record?.type === 'lifecycle' && record.event === 'objective_state') {
      const key = `${sessionID}:${id(payload.messageID)}`, previous = objectives.get(key);
      if (!previous || at >= previous.at) keep(objectives, key, { sessionID, anchorID: id(payload.messageID), at,
        startedAt: number(payload.createdAt), state: label(payload.state), generation: number(payload.generation),
        recoveryStartedAt: previous?.recoveryStartedAt ?? (['stopping', 'reconciling', 'recovery_reserved', 'recovering'].includes(payload.state) ? at : null),
        finishedAt: ['completed', 'needs_attention', 'cancelled', 'superseded'].includes(payload.state) ? at : null });
    }
    if (['lifecycle', 'timing', 'gap', 'connection'].includes(record?.type) || payload.type === 'session.error') {
      const observation = { sessionID, at, name: label(record.event ?? record.mark ?? payload.type) ?? record.type,
        args: metadata(payload), category: record.type,
        metrics: record.event === 'harness_context_projected' ? { phase: label(payload.phase) ?? 'legacy-estimate', ...Object.fromEntries(['beforeBytes', 'projectedBytes', 'dynamicBytes', 'plannedReductions', 'appliedReductions', 'savedBytes', 'transformDurationMs', 'finalRequestBytes']
          .map((key) => [key, number(payload[key])])) } : null };
      const bytes = Buffer.byteLength(JSON.stringify(observation));
      if (retainedBytes + bytes > maxBytes || observations.length >= maxEvents) omittedRecords++;
      else { observations.push(observation); retainedBytes += bytes; }
    }
  };
  const finish = () => {
    const traceEvents = [], processes = new Map(), lanes = new Map(), summaries = new Map();
    let eventBytes = 0, omittedEvents = 0;
    const rootOf = (session) => {
      const seen = new Set();
      while (relations.has(session) && !seen.has(session)) { seen.add(session); session = relations.get(session); }
      return session ?? 'runtime';
    };
    const push = (event) => {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (traceEvents.length >= maxEvents || eventBytes + bytes > maxBytes) { omittedEvents++; return; }
      traceEvents.push(event); eventBytes += bytes;
    };
    const coordinates = (session, lane) => {
      const root = rootOf(session);
      if (!processes.has(root)) { processes.set(root, processes.size + 1); push({ ph: 'M', name: 'process_name', pid: processes.get(root), tid: 0, args: { name: root } }); }
      const pid = processes.get(root), key = `${root}:${lane}`;
      if (!lanes.has(key)) { lanes.set(key, lanes.size + 1); push({ ph: 'M', name: 'thread_name', pid, tid: lanes.get(key), args: { name: lane } }); }
      return { pid, tid: lanes.get(key) };
    };
    const summary = (session) => {
      const root = rootOf(session);
      if (!summaries.has(root)) summaries.set(root, { rootSessionId: root, queueMs: [], firstResponseMs: [], toolExecutionMs: [],
        resultConsumptionMs: [], turnDurationMs: [], input: [], output: [], cacheRead: [], cacheWrite: [], cost: [],
        helperInput: [], helperOutput: [], toolVolumeBytes: [], workspaceBarrierMs: [], recoveryMs: [], objectiveDurations: [], retrievedPages: 0, projections: [],
        attribution: { helperSessions: new Set(), helperCalls: 0, helperUsageRecords: 0 } });
      return summaries.get(root);
    };
    const slice = (name, category, session, lane, start, end, args) => {
      const elapsed = duration(start, end);
      if (elapsed === null) return null;
      push({ ph: 'X', name, cat: category, ...coordinates(session, lane), ts: start * 1000, dur: elapsed * 1000, args });
      return elapsed;
    };
    for (const task of tasks.values()) {
      const values = summary(task.sessionID), args = metadata(task), lane = `task:${task.taskId}`;
      values.queueMs.push(slice('Queued', 'task', task.sessionID, lane, task.createdAt, task.startedAt, args));
      slice('Execution', 'task', task.sessionID, lane, task.startedAt, task.finishedAt, args);
      values.firstResponseMs.push(slice('First response', 'provider-observed', task.sessionID, `response:${task.taskId}`, task.childPromptedAt, task.firstAssistantPartAt, args));
      values.resultConsumptionMs.push(slice('Result awaiting disposition', 'task', task.sessionID, lane, task.deliveryAt, task.consumedAt, args));
      if (task.childSessionId && task.startedAt !== null) {
        const flow = id(task.taskId);
        push({ ph: 's', name: 'Delegation', cat: 'task', id: flow, ...coordinates(task.sessionID, lane), ts: task.startedAt * 1000 });
        push({ ph: 'f', bp: 'e', name: 'Delegation', cat: 'task', id: flow, ...coordinates(task.childSessionId, `session:${task.childSessionId}`), ts: task.startedAt * 1000 });
      }
    }
    for (const tool of tools.values()) {
      const values = summary(tool.sessionID);
      values.toolExecutionMs.push(slice(tool.tool, 'tool', tool.sessionID, `tool:${tool.sessionID}:${tool.callID}`, tool.startedAt, tool.finishedAt, metadata(tool)));
      values.toolVolumeBytes.push(tool.bytes);
      if (tool.retrievedPage) values.retrievedPages++;
    }
    // Helper sessions: title helpers named by their owner's diagnostic, and any
    // session whose assistant ran as a helper agent.
    const helperSessionIDs = new Set(helperSessions);
    for (const entry of usage.values()) if (entry.helper) helperSessionIDs.add(entry.sessionID);
    const reportingSessions = new Set([...usage.values()].map((entry) => entry.sessionID));
    for (const entry of usage.values()) {
      const values = summary(entry.sessionID);
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) values[key].push(entry[key]);
      // A helper session reached through its recorded relation is part of this
      // root's spending; without one it remains its own (unattributed) root.
      if (helperSessionIDs.has(entry.sessionID)) {
        if (rootOf(entry.sessionID) !== entry.sessionID) values.attribution.helperSessions.add(entry.sessionID);
        values.helperInput.push(entry.input); values.helperOutput.push(entry.output);
      }
    }
    let unattributedHelperUsage = 0;
    for (const entry of helperUsage.values()) {
      // A helper session already reporting its own message usage is not counted twice.
      if (entry.sessionID && helperSessionIDs.has(entry.sessionID) && reportingSessions.has(entry.sessionID)) continue;
      const owner = entry.root ?? entry.sessionID;
      if (!owner) { unattributedHelperUsage++; continue; }
      const values = summary(owner);
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) values[key].push(entry[key]);
      values.helperInput.push(entry.input); values.helperOutput.push(entry.output);
      if (entry.purpose === 'title') values.attribution.helperUsageRecords++;
    }
    for (const call of helperCalls.values()) summary(call.sessionID).attribution.helperCalls++;
    for (const turn of turns.values()) {
      if (rootOf(turn.sessionID) === turn.sessionID) summary(turn.sessionID).turnDurationMs.push(
        slice('Native turn', 'turn', turn.sessionID, `turn:${turn.userMessageID}`, turn.startedAt, turn.settledAt, metadata(turn)));
    }
    const objectiveIntervals = new Map();
    for (const objective of objectives.values()) {
      const values = summary(objective.sessionID);
      const elapsed = slice('Objective', 'objective', objective.sessionID, `objective:${objective.anchorID}`,
        objective.startedAt, objective.finishedAt, { anchorID: objective.anchorID, state: objective.state, generation: objective.generation });
      values.objectiveDurations.push({ anchorID: objective.anchorID, state: objective.state, durationMs: elapsed });
      if (!objectiveIntervals.has(values.rootSessionId)) objectiveIntervals.set(values.rootSessionId, []);
      objectiveIntervals.get(values.rootSessionId).push(elapsed === null ? null : [objective.startedAt, objective.finishedAt]);
      if (objective.recoveryStartedAt !== null) values.recoveryMs.push(slice('Recovery', 'recovery', objective.sessionID,
        `recovery:${objective.anchorID}`, objective.recoveryStartedAt, objective.finishedAt, { anchorID: objective.anchorID, generation: objective.generation }));
    }
    const barrierStarts = new Map();
    for (const observation of [...observations].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
      if (observation.at === null) continue;
      push({ ph: 'I', s: 't', name: observation.name, cat: observation.category, ...coordinates(observation.sessionID, `session:${observation.sessionID}`), ts: observation.at * 1000, args: observation.args });
      if (observation.metrics) summary(observation.sessionID).projections.push(observation.metrics);
      if (observation.name === 'managed_workspace_barrier') {
        if (observation.args.state === 'clear') {
          const started = barrierStarts.get(observation.sessionID);
          if (started !== undefined) summary(observation.sessionID).workspaceBarrierMs.push(slice('Workspace mutations gated', 'barrier', observation.sessionID,
            `barrier:${observation.sessionID}`, started, observation.at, { scope: 'grouped-orchestration-workspace-tools' }));
          barrierStarts.delete(observation.sessionID);
        } else if (!barrierStarts.has(observation.sessionID)) barrierStarts.set(observation.sessionID, observation.at);
      }
    }
    for (const session of barrierStarts.keys()) summary(session).workspaceBarrierMs.push(null);
    const aggregate = (values) => ({ observed: values.filter((v) => v !== null).length, unknown: values.filter((v) => v === null).length,
      total: values.some((v) => v !== null) ? values.reduce((sum, v) => sum + (v ?? 0), 0) : null });
    const roots = [...summaries.values()].map((value) => ({ rootSessionId: value.rootSessionId,
      measurements: Object.fromEntries(Object.entries(value).filter(([, entry]) => Array.isArray(entry) && entry !== value.projections && entry !== value.objectiveDurations).map(([key, entry]) => [key, aggregate(entry)])),
      // Direct title calls the journal shows without a matching usage record
      // are spending this root cannot account for.
      attribution: { helperSessions: value.attribution.helperSessions.size, helperCalls: value.attribution.helperCalls,
        helperUsageRecords: value.attribution.helperUsageRecords,
        unattributedHelperCalls: Math.max(0, value.attribution.helperCalls - value.attribution.helperUsageRecords),
        helperOnly: value.input.length > 0 && value.input.length === value.helperInput.length },
      retrievedPages: value.retrievedPages, projections: value.projections,
      objectiveDurations: value.objectiveDurations,
      totalObjectiveCriticalPathMs: objectiveCriticalPath(objectiveIntervals.get(value.rootSessionId) ?? []), wireFirstResponseMs: null,
      costProvenance: value.cost.some((v) => v !== null) ? 'native-runtime-reported' : 'unavailable' }));
    return { traceEvents, displayTimeUnit: 'ms', metadata: { schemaVersion: 1, product: 'DevRyan', source: 'retained-journal',
      sourceRecords, omittedRecords, omittedEvents, incomplete: omittedRecords > 0 || omittedEvents > 0,
      attribution: { schemaVersion: 1, unattributedHelperUsage },
      measurementScope: 'Observed durations may overlap; sums are not critical-path duration. Null means missing authoritative evidence.', roots } };
  };
  return { add, finish };
};
