import crypto from 'node:crypto';
import { resolveRecordSessionID, resolveSessionRelation } from './session-id.js';

const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
  && !/(?:bearer|password|secret|credential|api.key)/i.test(value) ? value : null;
const id = (value) => label(value) ?? (typeof value === 'string'
  ? `ref_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}` : null);
const size = (value) => typeof value === 'string' ? Buffer.byteLength(value)
  : value?.type === 'blob' ? number(value.size) : null;
const duration = (start, end) => number(start) !== null && number(end) !== null && end >= start ? end - start : null;
const fields = ['taskId', 'rootSessionId', 'childSessionId', 'parentTaskId', 'priorTaskId', 'envelopeId',
  'messageID', 'assistantMessageID', 'userMessageID', 'callID', 'providerRequestID', 'recoveryLineageId',
  'recoveryMessageID', 'runtimeInstanceID'];
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
    if (payload.type === 'openchamber:managed-task' && p.task) {
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
        cost: number(info.cost), successful: !info.error });
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
        metrics: record.event === 'harness_context_projected' ? Object.fromEntries(['beforeBytes', 'projectedBytes', 'dynamicBytes']
          .map((key) => [key, number(payload[key])])) : null };
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
        toolVolumeBytes: [], workspaceBarrierMs: [], recoveryMs: [], objectiveDurations: [], retrievedPages: 0, projections: [] });
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
    for (const entry of usage.values()) {
      const values = summary(entry.sessionID);
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) values[key].push(entry[key]);
    }
    for (const turn of turns.values()) {
      if (rootOf(turn.sessionID) === turn.sessionID) summary(turn.sessionID).turnDurationMs.push(
        slice('Native turn', 'turn', turn.sessionID, `turn:${turn.userMessageID}`, turn.startedAt, turn.settledAt, metadata(turn)));
    }
    for (const objective of objectives.values()) {
      const values = summary(objective.sessionID);
      const elapsed = slice('Objective', 'objective', objective.sessionID, `objective:${objective.anchorID}`,
        objective.startedAt, objective.finishedAt, { anchorID: objective.anchorID, state: objective.state, generation: objective.generation });
      values.objectiveDurations.push({ anchorID: objective.anchorID, state: objective.state, durationMs: elapsed });
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
      retrievedPages: value.retrievedPages, projections: value.projections,
      objectiveDurations: value.objectiveDurations,
      totalObjectiveCriticalPathMs: value.objectiveDurations.length === 1 ? value.objectiveDurations[0].durationMs : null, wireFirstResponseMs: null,
      costProvenance: value.cost.some((v) => v !== null) ? 'native-runtime-reported' : 'unavailable' }));
    return { traceEvents, displayTimeUnit: 'ms', metadata: { schemaVersion: 1, product: 'DevRyan', source: 'retained-journal',
      sourceRecords, omittedRecords, omittedEvents, incomplete: omittedRecords > 0 || omittedEvents > 0,
      measurementScope: 'Observed durations may overlap; sums are not critical-path duration. Null means missing authoritative evidence.', roots } };
  };
  return { add, finish };
};
