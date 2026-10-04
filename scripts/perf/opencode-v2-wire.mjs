// OpenCode 2.0.20 wire helpers for the gen-2 loopback fixture and its tests.
//
// - Frame codec: `data: <json>\n\n` blocks and `: heartbeat` comments, exactly as
//   2.0.20 writes `/api/event` (no `id:` lines, no `event:` lines).
// - Identifiers: `<prefix>_` + 12 hex time digits + 14 base62 characters, ascending or
//   descending like `@opencode/schema/identifier`, with a deterministic suffix.
// - Domain -> wire: DevRyan's v1-shaped rows (`{info, parts}`) become the v2 event
//   sequence that a 2.0.20 host would have published for them, plus an address map
//   from every domain part id to its projected gen-2 id and a register of parts v2
//   cannot represent. This is the reverse projector the round-trip oracle uses:
//   `project(fold(wireEventsForDomainRows(rows)))` must reproduce the rows.
// - Fold: a port of 2.0.20's session projector and `SessionMessageUpdater`
//   (`@opencode/core` message-updater.ts / session projector), so the fixture's REST
//   records follow from the events it publishes. Ephemeral events (deltas, tool
//   progress, usage) never change stored records, as in 2.0.20.
// - Request validation: a JSON-schema subset walker over the vendored OpenAPI
//   document, used to reject request bodies 2.0.20 would reject.
//
// Plain data in, plain data out; nothing here performs I/O.

import { assistantReasoningPartId, assistantTextPartId, assistantToolPartId, compactionSummaryMessageId,
  userAgentPartId, userFilePartId } from '../../packages/web/server/lib/opencode/v2/projection/ids.js';
import { toV2Error } from '../../packages/web/server/lib/opencode/v2/projection/errors.js';
import { toV2ToolInput, toV2ToolMetadata, toV2ToolName } from '../../packages/web/server/lib/opencode/v2/projection/tools.js';

export const OPENCODE_V2_WIRE_VERSION = '2.0.20';

/** Durable event types and their durable schema version (`@opencode/schema` session-event.js, worktree-event). */
export const OPENCODE_V2_DURABLE_EVENT_VERSIONS = new Map([
  ['session.created', 1], ['session.agent.selected', 1], ['session.model.selected', 1], ['session.moved', 1],
  ['session.renamed', 1], ['session.metadata.updated', 1], ['session.permissions', 1], ['session.viewed', 1],
  ['session.deleted', 2], ['session.forked', 2], ['session.inbox.delivered', 1], ['session.inbox.enqueued', 1],
  ['session.inbox.cancelled', 1], ['session.inbox.delivery.changed', 1], ['session.execution.started', 1],
  ['session.execution.succeeded', 1], ['session.execution.failed', 1], ['session.execution.interrupted', 1],
  ['session.instructions.updated', 2], ['session.synthetic', 1], ['session.skill.activated', 1],
  ['session.shell.started', 1], ['session.shell.ended', 1], ['session.step.started', 1], ['session.step.streamed', 1],
  ['session.step.ended', 1], ['session.step.failed', 1], ['session.text.started', 1], ['session.text.ended', 1],
  ['session.reasoning.started', 1], ['session.reasoning.ended', 1], ['session.tool.input.started', 1],
  ['session.tool.input.ended', 1], ['session.tool.called', 1], ['session.tool.success', 2], ['session.tool.failed', 2],
  ['session.retry.scheduled', 1], ['session.compaction.started', 1], ['session.compaction.ended', 1],
  ['session.compaction.failed', 1], ['session.revert.staged', 1], ['session.revert.cleared', 1],
  ['session.revert.committed', 1], ['worktree.resolved', 1],
]);

/**
 * 2.0.20 publishes these without an envelope `location` (observed in every captured vector).
 * `session.tool.progress` is published both with and without one (01 vs 10), so it is not listed.
 */
export const OPENCODE_V2_UNLOCATED_EVENT_TYPES = new Set([
  'server.connected', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted', 'session.usage.updated', 'worktree.resolved',
]);

/**
 * Fixture-only frames: DevRyan managed-task visuals that the v1 fixture also injects on
 * the upstream stream. They are NOT part of the OpenCode 2.0.20 event manifest and carry
 * `metadata.devryanFixture: true`.
 */
export const DEVRYAN_FIXTURE_EVENT_TYPES = new Set(['openchamber:managed-task', 'openchamber:managed-task-removed']);

export const V2_HEARTBEAT_FRAME = ': heartbeat\n\n';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

// ---------------------------------------------------------------------------
// Frame codec

/** One SSE data block, as 2.0.20 frames every event. */
export const encodeV2Frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Parses one SSE block (without its `\n\n` terminator).
 * @returns {{ kind: 'event', event: Record<string, unknown> } | { kind: 'comment', text: string } | null}
 */
export const parseV2FrameBlock = (block) => {
  const lines = block.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
  if (data.length > 0) return { kind: 'event', event: JSON.parse(data.join('\n')) };
  if (lines.every((line) => line.startsWith(':'))) return { kind: 'comment', text: lines.map((line) => line.slice(1).trim()).join('\n') };
  return null;
};

/** Incremental parser for a `/api/event` body. */
export const createV2FrameParser = () => {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const frames = [];
      let index;
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, index);
        pending = pending.slice(index + 2);
        const frame = parseV2FrameBlock(block);
        if (frame) frames.push({ ...frame, raw: `${block}\n\n` });
      }
      return frames;
    },
    get pending() { return pending; },
  };
};

// ---------------------------------------------------------------------------
// Identifiers

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const base62 = (value, width) => {
  let rest = BigInt(value);
  let text = '';
  do {
    text = BASE62[Number(rest % 62n)] + text;
    rest /= 62n;
  } while (rest > 0n);
  return text.padStart(width, '0').slice(-width);
};

/**
 * Ascending/descending v2 identifiers with the same time prefix as
 * `@opencode/schema/identifier` and a deterministic serial suffix.
 */
export const createV2IdFactory = ({ clock = Date.now } = {}) => {
  let lastTimestamp = 0;
  let counter = 0;
  let serial = 0;
  const make = (descending) => {
    const timestamp = clock();
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      counter = 0;
    }
    counter += 1;
    const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
    const value = descending ? ~current : current;
    const time = Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16).padStart(2, '0')).join('');
    serial += 1;
    return time + base62(serial, 14);
  };
  return {
    ascending: (prefix) => `${prefix}_${make(false)}`,
    descending: (prefix) => `${prefix}_${make(true)}`,
  };
};

/** `SessionMessage.ID.fromEvent`: the message id derived from an event id. */
export const messageIdFromEventId = (eventID) => eventID.replace(/^evt_/, 'msg_');

// ---------------------------------------------------------------------------
// Domain (v1-shaped rows) -> wire events

const FINISH_REASONS = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown']);

const toWireFinish = (finish) => (FINISH_REASONS.has(finish) ? finish : 'unknown');

const toWireTokens = (tokens) => {
  if (!isRecord(tokens)) return zeroTokens();
  const number = (value) => (isFiniteNumber(value) ? value : 0);
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return { input: number(tokens.input), output: number(tokens.output), reasoning: number(tokens.reasoning),
    cache: { read: number(cache.read), write: number(cache.write) } };
};

const DATA_URL = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * A v1 FilePart (or prompt input `{uri, name}`) as a v2 `Prompt.FileAttachment`.
 * A `data:` URL keeps its bytes; any other URI keeps only its reference (a loss the
 * caller records), because the fixture cannot read it.
 */
export const toWireFileAttachment = ({ url, mime, filename }) => {
  const match = typeof url === 'string' ? DATA_URL.exec(url) : null;
  const attachment = match
    ? { data: match[2], mime: mime ?? match[1] ?? 'application/octet-stream', source: { type: 'inline' } }
    : { data: '', mime: mime ?? 'application/octet-stream', source: { type: 'uri', uri: String(url ?? '') } };
  if (isNonEmptyString(filename)) attachment.name = filename;
  return { attachment, lossless: Boolean(match) };
};

const modelRefFromV1 = (providerID, modelID, variant) => {
  const ref = { id: isNonEmptyString(modelID) ? modelID : 'unknown', providerID: isNonEmptyString(providerID) ? providerID : 'unknown' };
  if (isNonEmptyString(variant)) ref.variant = variant;
  return ref;
};

/**
 * The `metadata.devryan` selection block admission writes on prompts (DESIGN B.5).
 * @param {{ agent?: string, model?: { providerID?: string, modelID?: string, variant?: string } }} info
 */
export const devryanPromptMetadata = (info, parts, extra = {}) => {
  const devryan = { v: 1, ...extra, parts };
  if (isNonEmptyString(info?.agent)) devryan.agent = info.agent;
  if (isRecord(info?.model)) {
    if (isNonEmptyString(info.model.providerID)) devryan.providerID = info.model.providerID;
    if (isNonEmptyString(info.model.modelID)) devryan.modelID = info.model.modelID;
    if (typeof info.model.variant === 'string') devryan.variant = info.model.variant;
  }
  return devryan;
};

const textPartsOf = (parts) => parts.filter((part) => part?.type === 'text' && typeof part.text === 'string');

/**
 * The inbox item a v1 user row was admitted as.
 * @returns {{ item: object, addresses: [string, object][], losses: object[] }}
 */
const wireUserItem = (row, origin) => {
  const messageID = row.info.id;
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const addresses = [];
  const losses = [];
  const descriptors = [];
  let text = '';
  for (const part of textPartsOf(parts)) {
    const kind = part.synthetic === true ? 'synthetic' : 'text';
    descriptors.push({ kind, length: part.text.length, id: part.id });
    text += part.text;
    addresses.push([part.id, { messageID, kind: 'user-text', projectedID: part.id }]);
  }
  const files = [];
  const agents = [];
  for (const part of parts) {
    if (part?.type === 'file') {
      const { attachment, lossless } = toWireFileAttachment(part);
      addresses.push([part.id, { messageID, kind: 'user-file', index: files.length, projectedID: userFilePartId(messageID, files.length) }]);
      files.push(attachment);
      if (!lossless) losses.push({ messageID, partID: part.id, type: 'file', reason: 'non-data URL kept as a reference only' });
    } else if (part?.type === 'agent' && isNonEmptyString(part.name)) {
      const agent = { name: part.name };
      if (isRecord(part.source) && isFiniteNumber(part.source.start) && isFiniteNumber(part.source.end)) {
        agent.mention = { start: part.source.start, end: part.source.end, text: String(part.source.value ?? '') };
      }
      addresses.push([part.id, { messageID, kind: 'user-agent', index: agents.length, projectedID: userAgentPartId(messageID, agents.length) }]);
      agents.push(agent);
    } else if (part?.type !== 'text') {
      losses.push({ messageID, partID: part?.id ?? null, type: part?.type ?? null, reason: 'no v2 user representation' });
    }
  }
  const allSynthetic = descriptors.length > 0 && descriptors.every((descriptor) => descriptor.kind === 'synthetic')
    && files.length === 0 && agents.length === 0;
  const devryan = devryanPromptMetadata(row.info, descriptors, { origin });
  if (allSynthetic) {
    const first = textPartsOf(parts)[0];
    const metadata = { ...(isRecord(first?.metadata) ? clone(first.metadata) : {}), devryan };
    return { item: { type: 'synthetic', payload: { text, metadata }, delivery: 'steer' }, addresses, losses };
  }
  const payload = { text };
  if (files.length) payload.files = files;
  if (agents.length) payload.agents = agents;
  payload.metadata = { devryan };
  return { item: { type: 'user', payload, delivery: 'steer' }, addresses, losses };
};

const isOpenPart = (row, part) => !isFiniteNumber(row.info.time?.completed) && !isFiniteNumber(part.time?.end);

/** v1 ToolPart -> v2 events on the given assistant. */
const wireToolEvents = (sessionID, messageID, part, created) => {
  const callID = part.callID;
  const name = toV2ToolName(part.tool);
  const state = isRecord(part.state) ? part.state : { status: 'pending' };
  const start = isFiniteNumber(state.time?.start) ? state.time.start : created;
  const end = isFiniteNumber(state.time?.end) ? state.time.end : start;
  const base = { sessionID, assistantMessageID: messageID, id: callID };
  const events = [{ type: 'session.tool.input.started', created: start, data: { ...base, name } }];
  if (state.status === 'pending') {
    if (typeof state.raw === 'string' && state.raw.length) {
      events.push({ type: 'session.tool.input.ended', created: start, data: { ...base, text: state.raw } });
    }
    return events;
  }
  const input = toV2ToolInput(part.tool, isRecord(state.input) ? clone(state.input) : {});
  events.push({ type: 'session.tool.input.ended', created: start, data: { ...base, text: JSON.stringify(input) } });
  events.push({ type: 'session.tool.called', created: start, data: { ...base, input, executed: false } });
  const metadata = isRecord(state.metadata) ? toV2ToolMetadata(part.tool, clone(state.metadata)) : undefined;
  if (state.status === 'running') {
    if (metadata && Object.keys(metadata).length) {
      events.push({ type: 'session.tool.progress', created: start, data: { ...base, metadata } });
    }
    return events;
  }
  if (state.status === 'completed') {
    const content = [{ type: 'text', text: typeof state.output === 'string' ? state.output : '' }];
    for (const attachment of Array.isArray(state.attachments) ? state.attachments : []) {
      if (!isRecord(attachment) || typeof attachment.url !== 'string') continue;
      const file = { type: 'file', uri: attachment.url, mime: attachment.mime ?? 'application/octet-stream' };
      if (isNonEmptyString(attachment.filename)) file.name = attachment.filename;
      content.push(file);
    }
    const data = { ...base, content, executed: false };
    if (metadata !== undefined) data.metadata = metadata;
    events.push({ type: 'session.tool.success', created: end, data });
    return events;
  }
  if (state.status === 'error') {
    const data = { ...base, error: { type: 'tool.execution', message: String(state.error ?? '') }, executed: false };
    if (metadata !== undefined) data.metadata = metadata;
    events.push({ type: 'session.tool.failed', created: end, data });
  }
  return events;
};

/**
 * v1 assistant row -> step and content events.
 * @returns {{ events: object[], addresses: [string, object][], losses: object[] }}
 */
const wireAssistantEvents = (sessionID, row) => {
  const info = row.info;
  const messageID = info.id;
  const created = isFiniteNumber(info.time?.created) ? info.time.created : 0;
  const completed = isFiniteNumber(info.time?.completed) ? info.time.completed : undefined;
  const events = [{ type: 'session.step.started', created, data: { sessionID, assistantMessageID: messageID,
    agent: isNonEmptyString(info.agent) ? info.agent : (isNonEmptyString(info.mode) ? info.mode : 'build'),
    model: modelRefFromV1(info.providerID, info.modelID, info.variant), started: created } }];
  const addresses = [];
  const losses = [];
  let textOrdinal = 0;
  let reasoningOrdinal = 0;
  for (const part of Array.isArray(row.parts) ? row.parts : []) {
    if (!isRecord(part)) continue;
    if (part.type === 'step-start' || part.type === 'step-finish') continue;
    if (part.type === 'text' || part.type === 'reasoning') {
      const kind = part.type;
      const ordinal = kind === 'text' ? textOrdinal++ : reasoningOrdinal++;
      const projectedID = kind === 'text' ? assistantTextPartId(messageID, ordinal) : assistantReasoningPartId(messageID, ordinal);
      addresses.push([part.id, { messageID, kind, ordinal, projectedID }]);
      const start = isFiniteNumber(part.time?.start) ? part.time.start : created;
      const startedData = { sessionID, assistantMessageID: messageID, ordinal };
      if (kind === 'reasoning' && isRecord(part.metadata)) startedData.state = clone(part.metadata);
      events.push({ type: `session.${kind}.started`, created: start, data: startedData });
      const text = typeof part.text === 'string' ? part.text : '';
      if (isOpenPart(row, part)) {
        if (text) events.push({ type: `session.${kind}.delta`, created: start, data: { sessionID, assistantMessageID: messageID, ordinal, delta: text } });
        losses.push({ messageID, partID: part.id, type: kind, reason: 'open part: v2 stores text only at *.ended (deltas are ephemeral)' });
      } else {
        const end = isFiniteNumber(part.time?.end) ? part.time.end : (completed ?? start);
        events.push({ type: `session.${kind}.ended`, created: end, data: { sessionID, assistantMessageID: messageID, ordinal, text } });
      }
      continue;
    }
    if (part.type === 'tool' && isNonEmptyString(part.callID) && isNonEmptyString(part.tool)) {
      addresses.push([part.id, { messageID, kind: 'tool', callID: part.callID, projectedID: assistantToolPartId(messageID, part.callID) }]);
      events.push(...wireToolEvents(sessionID, messageID, part, created));
      continue;
    }
    losses.push({ messageID, partID: part.id ?? null, type: part.type ?? null, reason: 'no v2 assistant content representation' });
  }
  if (completed !== undefined) {
    if (isRecord(info.error)) {
      events.push({ type: 'session.step.failed', created: completed, data: { sessionID, assistantMessageID: messageID,
        error: toV2Error(info.error), cost: isFiniteNumber(info.cost) ? info.cost : 0, tokens: toWireTokens(info.tokens) } });
    } else {
      events.push({ type: 'session.step.ended', created: completed, data: { sessionID, assistantMessageID: messageID,
        finish: toWireFinish(info.finish), cost: isFiniteNumber(info.cost) ? info.cost : 0, tokens: toWireTokens(info.tokens) } });
    }
  }
  return { events, addresses, losses };
};

/**
 * Domain rows (v1 `{info, parts}` records in seq order) -> the v2 events a 2.0.20 host
 * would have published for them. Compaction pairs (a user row with a `compaction`
 * part followed by its `summary:true` assistant) become one compaction message.
 *
 * @param {readonly { info: Record<string, any>, parts: Record<string, any>[] }[]} rows
 * @param {{ sessionID: string, origin?: string }} options
 * @returns {{ events: { type: string, created: number, data: Record<string, unknown> }[],
 *   addresses: Map<string, { messageID: string, kind: string, projectedID: string, ordinal?: number, callID?: string, index?: number }>,
 *   losses: { messageID: string, partID: string | null, type: string | null, reason: string }[] }}
 */
export const wireEventsForDomainRows = (rows, { sessionID, origin = 'fixture-replay' }) => {
  const events = [];
  const addresses = new Map();
  const losses = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!isRecord(row?.info) || !isNonEmptyString(row.info.id)) {
      losses.push({ messageID: null, partID: null, type: null, reason: 'row without an id' });
      continue;
    }
    const created = isFiniteNumber(row.info.time?.created) ? row.info.time.created : 0;
    if (row.info.role === 'user') {
      const compaction = (row.parts ?? []).find((part) => part?.type === 'compaction');
      if (compaction) {
        const reason = compaction.auto === true ? 'auto' : 'manual';
        const next = rows[index + 1];
        const summary = next?.info?.role === 'assistant' && next.info.summary === true && next.info.parentID === row.info.id ? next : null;
        const inbox = { sessionID, inboxID: row.info.id };
        events.push({ type: 'session.inbox.enqueued', created, data: { ...inbox, item: { type: 'compaction', payload: {}, delivery: 'steer' } } });
        events.push({ type: 'session.inbox.delivered', created, data: inbox });
        events.push({ type: 'session.compaction.started', created, data: { sessionID, reason, recent: '', inputID: row.info.id } });
        addresses.set(compaction.id, { messageID: row.info.id, kind: 'compaction', projectedID: compaction.id });
        if (summary) {
          const summaryText = textPartsOf(summary.parts ?? []).map((part) => part.text).join('');
          const summaryID = compactionSummaryMessageId(row.info.id);
          textPartsOf(summary.parts ?? []).forEach((part, ordinal) => {
            addresses.set(part.id, { messageID: summaryID, kind: 'text', ordinal, projectedID: assistantTextPartId(summaryID, ordinal) });
          });
          const ended = { sessionID, reason, text: summaryText, recent: '' };
          if (isNonEmptyString(summary.info.modelID)) ended.model = modelRefFromV1(summary.info.providerID, summary.info.modelID);
          events.push({ type: 'session.compaction.ended', created: summary.info.time?.completed ?? summary.info.time?.created ?? created, data: ended });
          index += 1;
        } else {
          losses.push({ messageID: row.info.id, partID: compaction.id, type: 'compaction', reason: 'compaction without its summary assistant stays running' });
        }
        continue;
      }
      const { item, addresses: userAddresses, losses: userLosses } = wireUserItem(row, origin);
      for (const [id, address] of userAddresses) addresses.set(id, address);
      losses.push(...userLosses);
      const inbox = { sessionID, inboxID: row.info.id };
      events.push({ type: 'session.inbox.enqueued', created, data: { ...inbox, item } });
      events.push({ type: 'session.inbox.delivered', created, data: inbox });
      continue;
    }
    if (row.info.role === 'assistant') {
      const assistant = wireAssistantEvents(sessionID, row);
      events.push(...assistant.events);
      for (const [id, address] of assistant.addresses) addresses.set(id, address);
      losses.push(...assistant.losses);
      continue;
    }
    losses.push({ messageID: row.info.id, partID: null, type: row.info.role ?? null, reason: 'unknown role' });
  }
  return { events, addresses, losses };
};

// ---------------------------------------------------------------------------
// Fold: 2.0.20 session projector + SessionMessageUpdater

const forkTitle = (value) => {
  if (value === undefined) return undefined;
  const match = /^(.+) \(fork #(\d+)\)$/.exec(value);
  if (match) return `${match[1]} (fork #${Number.parseInt(match[2], 10) + 1})`;
  return `${value} (fork #1)`;
};

const omitUndefined = (record) => {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
};

/**
 * In-memory 2.0.20 store: sessions, ordered messages (with seq), inbox items.
 * `apply(envelope)` folds one published event exactly as the 2.0.20 projector would.
 */
export const createV2WireStore = () => {
  const sessions = new Map();
  const sequences = new Map();

  const nextSeq = (aggregateID) => {
    const value = sequences.get(aggregateID) ?? 0;
    sequences.set(aggregateID, value + 1);
    return value;
  };
  const reserveSeq = (aggregateID, minimum) => {
    sequences.set(aggregateID, Math.max(sequences.get(aggregateID) ?? 0, minimum));
  };

  const entry = (sessionID) => sessions.get(sessionID);
  const touch = (session, created) => { session.info.time.updated = created; };
  const assistantOf = (session, messageID) => session.messages.find((stored) => stored.record.id === messageID && stored.record.type === 'assistant')?.record;
  const currentAssistant = (session) => {
    const last = session.messages.findLast((stored) => stored.record.type === 'assistant')?.record;
    return last && last.time.completed === undefined ? last : undefined;
  };
  const insert = (session, seq, record) => { session.messages.push({ seq, record: omitUndefined(record) }); };
  const latestTool = (assistant, id) => assistant.content.findLast((item) => item.type === 'tool' && item.id === id);
  const clearCurrentRetry = (session) => {
    const current = currentAssistant(session);
    if (current?.retry) delete current.retry;
  };

  const applyUsage = (session, value) => {
    session.info.cost += value.cost;
    session.info.tokens.input += value.tokens.input;
    session.info.tokens.output += value.tokens.output;
    session.info.tokens.reasoning += value.tokens.reasoning;
    session.info.tokens.cache.read += value.tokens.cache.read;
    session.info.tokens.cache.write += value.tokens.cache.write;
  };

  const idle = (session, event, outcome) => {
    clearCurrentRetry(session);
    insert(session, event.durable.seq, { id: messageIdFromEventId(event.id), type: 'idle', outcome,
      metadata: clone(event.metadata), time: { created: event.created } });
    const previous = session.info.time.idle;
    session.info.time.idle = previous === undefined ? event.created : Math.max(event.created, previous + 1);
    session.info.outcome = outcome;
  };

  const projectFork = (event) => {
    const parent = entry(event.data.parentID);
    if (!parent) throw new Error(`Fork parent session not found: ${event.data.parentID}`);
    const boundary = parent.messages.find((stored) => stored.record.id === event.data.boundary.messageID);
    if (!boundary) throw new Error(`Fork boundary message not found: ${event.data.boundary.messageID}`);
    const included = (stored) => (event.data.boundary.type === 'before' ? stored.seq < boundary.seq : stored.seq <= boundary.seq);
    const copyable = (record) => !(record.type === 'assistant' && record.time.completed === undefined)
      && !(record.type === 'shell' && record.status === 'running')
      && !(record.type === 'compaction' && record.status === 'running');
    const base = messageIdFromEventId(event.id);
    const info = omitUndefined({
      id: event.data.sessionID,
      fork: { sessionID: event.data.parentID, boundary: clone(event.data.boundary) },
      projectID: parent.info.projectID,
      agent: parent.info.agent,
      model: clone(parent.info.model),
      cost: 0,
      tokens: zeroTokens(),
      time: { created: event.created, updated: event.created },
      title: forkTitle(parent.info.title),
      location: clone(parent.info.location),
      subpath: parent.info.subpath,
      metadata: clone(parent.info.metadata),
      permissions: clone(parent.info.permissions),
    });
    const messages = parent.messages.filter((stored) => included(stored) && copyable(stored.record))
      .map((stored) => ({ seq: stored.seq, record: { ...clone(stored.record), id: `${base}_${stored.seq}` } }));
    sessions.set(info.id, { info, slug: info.id, version: parent.version, messages, inbox: [] });
    const copiedSeq = parent.messages.filter(included).at(-1)?.seq;
    if (copiedSeq !== undefined) reserveSeq(info.id, copiedSeq + 1);
  };

  /** Folds one envelope. Unknown sessions are ignored, as the 2.0.20 projector's updates are no-ops for them. */
  const apply = (event) => {
    const data = event.data ?? {};
    const created = event.created;
    if (event.type === 'session.created') {
      if (sessions.has(data.sessionID)) throw new Error(`Session already projected: ${data.sessionID}`);
      const info = omitUndefined({
        id: data.sessionID, parentID: data.parentID, projectID: data.projectID, agent: data.agent, model: clone(data.model),
        cost: 0, tokens: zeroTokens(), time: { created, updated: created }, title: data.title,
        location: clone(data.location), subpath: isNonEmptyString(data.subpath) ? data.subpath : undefined,
        metadata: clone(data.metadata), permissions: clone(data.permissions),
      });
      sessions.set(data.sessionID, { info, slug: data.slug, version: data.version, messages: [], inbox: [] });
      return;
    }
    if (event.type === 'session.forked') { projectFork(event); return; }
    const session = typeof data.sessionID === 'string' ? entry(data.sessionID) : undefined;
    if (!session) return;
    const seq = event.durable?.seq;
    const owned = (recipe) => {
      const assistant = assistantOf(session, data.assistantMessageID);
      if (assistant) recipe(assistant);
    };
    switch (event.type) {
      case 'session.deleted': sessions.delete(data.sessionID); return;
      case 'session.renamed': session.info.title = data.title; touch(session, created); return;
      case 'session.metadata.updated': session.info.metadata = clone(data.metadata); touch(session, created); return;
      case 'session.permissions': session.info.permissions = clone(data.permissions); touch(session, created); return;
      case 'session.agent.selected':
        insert(session, seq, { id: messageIdFromEventId(event.id), type: 'agent-switched', metadata: clone(event.metadata),
          agent: data.agent, previous: data.previous ?? session.info.agent, time: { created } });
        session.info.agent = data.agent; touch(session, created); return;
      case 'session.model.selected':
        insert(session, seq, { id: messageIdFromEventId(event.id), type: 'model-switched', metadata: clone(event.metadata),
          model: clone(data.model), previous: clone(data.previous ?? session.info.model), time: { created } });
        session.info.model = clone(data.model); touch(session, created); return;
      case 'session.inbox.enqueued':
        session.inbox.push({ enqueuedSeq: seq, item: { id: data.inboxID, sessionID: data.sessionID, time: { created },
          ...clone(data.item) } });
        touch(session, created); return;
      case 'session.inbox.cancelled':
        session.inbox = session.inbox.filter((pending) => pending.item.id !== data.inboxID); return;
      case 'session.inbox.delivery.changed': {
        const pending = session.inbox.find((candidate) => candidate.item.id === data.inboxID);
        if (pending) pending.item.delivery = data.delivery;
        return;
      }
      case 'session.inbox.delivered': {
        const index = session.inbox.findIndex((pending) => pending.item.id === data.inboxID);
        if (index < 0) return;
        const [{ item }] = session.inbox.splice(index, 1);
        if (item.type === 'user') {
          insert(session, seq, { id: item.id, type: 'user', metadata: clone(item.payload.metadata), text: item.payload.text,
            files: clone(item.payload.files), agents: clone(item.payload.agents), skills: clone(item.payload.skills), time: { created } });
        } else if (item.type === 'synthetic') {
          insert(session, seq, { id: item.id, type: 'synthetic', text: item.payload.text, description: item.payload.description,
            metadata: clone(item.payload.metadata), time: { created } });
        }
        return;
      }
      case 'session.execution.started': return;
      case 'session.execution.succeeded': idle(session, event, 'succeeded'); return;
      case 'session.execution.failed': idle(session, event, 'failed'); return;
      case 'session.execution.interrupted':
        if (data.reason === 'shutdown') { clearCurrentRetry(session); return; }
        idle(session, event, 'interrupted'); return;
      case 'session.instructions.updated':
        if (data.text === undefined) return;
        insert(session, seq, { id: messageIdFromEventId(event.id), type: 'system', text: data.text,
          description: `Instructions updated: ${Object.keys(data.delta ?? {}).join(', ')}`,
          metadata: { ...(event.metadata ?? {}), notice: 'instructions', instructionSources: Object.keys(data.delta ?? {}) }, time: { created } });
        return;
      case 'session.synthetic':
        insert(session, seq, { id: messageIdFromEventId(event.id), type: 'synthetic', text: data.text, description: data.description,
          metadata: clone(data.metadata), time: { created } });
        return;
      case 'session.skill.activated':
        insert(session, seq, { id: messageIdFromEventId(event.id), type: 'skill', skill: data.id, name: data.name, text: data.text,
          metadata: clone(event.metadata), time: { created } });
        return;
      case 'session.step.started': {
        const existing = assistantOf(session, data.assistantMessageID);
        if (existing) {
          existing.agent = data.agent;
          existing.model = clone(data.model);
          for (const key of ['retry', 'error', 'finish', 'rawFinish', 'providerState']) delete existing[key];
          existing.time = { created: data.started };
          return;
        }
        const current = currentAssistant(session);
        if (current) { delete current.retry; current.time.completed = created; }
        insert(session, seq, { id: data.assistantMessageID, type: 'assistant', agent: data.agent, model: clone(data.model),
          metadata: clone(event.metadata), time: { created: data.started }, content: [] });
        return;
      }
      case 'session.step.streamed': owned((draft) => { draft.time.streamed = created; }); return;
      case 'session.step.ended':
        owned((draft) => {
          draft.time.completed = created;
          draft.finish = data.finish;
          if (data.rawFinish !== undefined) draft.rawFinish = data.rawFinish; else delete draft.rawFinish;
          if (data.providerState !== undefined) draft.providerState = clone(data.providerState); else delete draft.providerState;
          draft.cost = data.cost;
          draft.tokens = clone(data.tokens);
        });
        applyUsage(session, data);
        return;
      case 'session.step.failed':
        owned((draft) => {
          draft.time.completed = created;
          draft.finish = data.finish ?? 'error';
          if (data.rawFinish !== undefined) draft.rawFinish = data.rawFinish; else delete draft.rawFinish;
          if (data.providerState !== undefined) draft.providerState = clone(data.providerState); else delete draft.providerState;
          draft.error = clone(data.error);
          delete draft.retry;
          if (data.cost !== undefined && data.tokens !== undefined) { draft.cost = data.cost; draft.tokens = clone(data.tokens); }
        });
        if (data.cost !== undefined && data.tokens !== undefined) applyUsage(session, data);
        return;
      case 'session.text.started': owned((draft) => { draft.content.push({ type: 'text', text: '' }); }); return;
      case 'session.text.ended':
        owned((draft) => {
          const match = draft.content.findLast((item) => item.type === 'text');
          if (!match) return;
          match.text = data.text;
          if (data.state !== undefined) match.state = clone(data.state); else delete match.state;
        });
        return;
      case 'session.reasoning.started':
        owned((draft) => { draft.content.push(omitUndefined({ type: 'reasoning', text: '', state: clone(data.state), time: { created } })); });
        return;
      case 'session.reasoning.ended':
        owned((draft) => {
          const match = draft.content.findLast((item) => item.type === 'reasoning' && !item.time?.completed);
          if (!match) return;
          match.text = data.text;
          match.time = { created: match.time?.created ?? created, completed: created };
          if (data.state !== undefined) match.state = clone(data.state);
        });
        return;
      case 'session.tool.input.started':
        owned((draft) => { draft.content.push({ type: 'tool', id: data.id, name: data.name, time: { created }, state: { status: 'streaming', input: '' } }); });
        return;
      case 'session.tool.input.ended':
        owned((draft) => {
          const match = latestTool(draft, data.id);
          if (match && match.state.status === 'streaming') match.state.input = data.text;
        });
        return;
      case 'session.tool.called':
        owned((draft) => {
          const match = latestTool(draft, data.id);
          if (!match) return;
          match.executed = data.executed;
          if (data.state !== undefined) match.providerState = clone(data.state); else delete match.providerState;
          match.time.ran = created;
          match.state = { status: 'running', input: clone(data.input), metadata: {} };
        });
        return;
      case 'session.tool.success':
        owned((draft) => {
          const match = latestTool(draft, data.id);
          if (!match || match.state.status !== 'running') return;
          match.executed = data.executed || match.executed === true;
          if (data.resultState !== undefined) match.providerResultState = clone(data.resultState);
          match.time.completed = created;
          match.state = omitUndefined({ status: 'completed', input: match.state.input, content: clone(data.content), metadata: clone(data.metadata) });
        });
        return;
      case 'session.tool.failed':
        owned((draft) => {
          const match = latestTool(draft, data.id);
          if (!match || (match.state.status !== 'streaming' && match.state.status !== 'running')) return;
          match.executed = data.executed || match.executed === true;
          if (data.resultState !== undefined) match.providerResultState = clone(data.resultState);
          match.time.completed = created;
          match.state = omitUndefined({ status: 'error', error: clone(data.error),
            input: typeof match.state.input === 'string' ? {} : match.state.input, content: clone(data.content), metadata: clone(data.metadata) });
        });
        return;
      case 'session.retry.scheduled':
        owned((draft) => { draft.retry = { attempt: data.attempt, at: data.at, error: clone(data.error) }; });
        return;
      case 'session.compaction.started':
        insert(session, seq, { id: data.inputID ?? messageIdFromEventId(event.id), type: 'compaction', status: 'running',
          metadata: clone(event.metadata), reason: data.reason, summary: '', recent: data.recent ?? '', time: { created } });
        return;
      case 'session.compaction.ended': {
        const current = session.messages.findLast((stored) => stored.record.type === 'compaction' && stored.record.status === 'running')?.record;
        const fields = { status: 'completed', reason: data.reason, model: clone(data.model), providerState: clone(data.providerState),
          summary: data.text, providerContext: clone(data.providerContext), recent: data.recent, cost: data.cost, tokens: clone(data.tokens) };
        if (current) {
          Object.assign(current, fields, event.metadata ? { metadata: { ...current.metadata, ...event.metadata } } : {});
          omitUndefined(current);
          return;
        }
        insert(session, seq, { id: messageIdFromEventId(event.id), type: 'compaction', metadata: clone(event.metadata), ...fields, time: { created } });
        return;
      }
      case 'session.compaction.failed': {
        const current = session.messages.findLast((stored) => stored.record.type === 'compaction' && stored.record.status === 'running')?.record;
        const failed = { id: current?.id ?? data.inputID ?? messageIdFromEventId(event.id), type: 'compaction', status: 'failed',
          metadata: clone(current?.metadata ?? event.metadata), reason: data.reason, error: clone(data.error), cost: data.cost,
          tokens: clone(data.tokens), time: current?.time ?? { created } };
        if (current) {
          for (const key of Object.keys(current)) delete current[key];
          Object.assign(current, omitUndefined(failed));
          return;
        }
        insert(session, seq, failed);
        return;
      }
      case 'session.revert.staged':
        session.info.revert = clone(data.revert); touch(session, created); return;
      case 'session.revert.cleared':
        delete session.info.revert; touch(session, created); return;
      case 'session.revert.committed': {
        const boundary = session.messages.find((stored) => stored.record.id === data.to);
        if (!boundary) throw new Error(`Revert boundary message not found: ${data.to}`);
        session.messages = session.messages.filter((stored) => stored.seq < boundary.seq);
        session.inbox = session.inbox.filter((pending) => pending.enqueuedSeq < boundary.seq);
        delete session.info.revert; touch(session, created);
        return;
      }
      default:
        return;
    }
  };

  return {
    apply,
    nextSeq,
    reserveSeq,
    has: (sessionID) => sessions.has(sessionID),
    session: (sessionID) => {
      const value = entry(sessionID);
      return value ? clone(value.info) : undefined;
    },
    slug: (sessionID) => entry(sessionID)?.slug,
    sessions: () => [...sessions.values()].map((value) => clone(value.info)),
    /** Stored messages in seq order (clones). */
    messages: (sessionID) => (entry(sessionID)?.messages ?? []).map((stored) => clone(stored.record)),
    /** Live reference to one stored message; callers must not mutate it. */
    peekMessage: (sessionID, messageID) => entry(sessionID)?.messages.find((stored) => stored.record.id === messageID)?.record,
    inbox: (sessionID) => (entry(sessionID)?.inbox ?? []).map((pending) => clone(pending.item)),
    /** Fixture-only store edits with no 2.0.20 event equivalent. */
    removeMessages: (sessionID, predicate) => {
      const session = entry(sessionID);
      if (session) session.messages = session.messages.filter((stored) => !predicate(stored.record));
    },
    appendMessages: (sessionID, records) => {
      const session = entry(sessionID);
      if (!session) throw new Error(`Unknown session: ${sessionID}`);
      for (const record of records) insert(session, nextSeq(sessionID), clone(record));
    },
    prependMessages: (sessionID, records) => {
      const session = entry(sessionID);
      if (!session) throw new Error(`Unknown session: ${sessionID}`);
      const first = session.messages[0]?.seq ?? 0;
      const start = Math.min(first, 0) - records.length;
      session.messages.unshift(...records.map((record, index) => ({ seq: start + index, record: omitUndefined(clone(record)) })));
    },
  };
};

// ---------------------------------------------------------------------------
// OpenAPI JSON-schema subset walker (request validation and test wrappers)

const COMPONENT_PREFIX = '#/components/schemas/';

const jsonType = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const typeMatches = (expected, value) => {
  const actual = jsonType(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
};

/**
 * Checks `value` against an OpenAPI 3.1 schema fragment. Supports the keywords the
 * 2.0.20 document uses. `onRef(name, value, path)` may take over a `$ref` (return an
 * error string or `null`); returning `undefined` continues with the JSON schema.
 * @returns {string | null} the first error, or `null`
 */
export const checkOpenApiValue = (schema, value, context, path = '$') => {
  if (schema === undefined || schema === true) return null;
  if (schema === false) return `${path}: not allowed`;
  if (!isRecord(schema)) return `${path}: invalid schema`;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.startsWith(COMPONENT_PREFIX) ? schema.$ref.slice(COMPONENT_PREFIX.length) : schema.$ref;
    if (context.onRef) {
      const handled = context.onRef(name, value, path);
      if (handled !== undefined) return handled;
    }
    const target = context.components?.[name];
    if (!target) return `${path}: unknown schema ${name}`;
    return checkOpenApiValue(target, value, context, path);
  }
  if (Array.isArray(schema.anyOf)) {
    let first = null;
    for (const option of schema.anyOf) {
      const error = checkOpenApiValue(option, value, context, path);
      if (error === null) return null;
      first ??= error;
    }
    return `${path}: no anyOf branch matched (${first})`;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((option) => checkOpenApiValue(option, value, context, path) === null).length;
    if (matches !== 1) return `${path}: ${matches} oneOf branches matched`;
    return null;
  }
  if (Array.isArray(schema.allOf)) {
    for (const option of schema.allOf) {
      const error = checkOpenApiValue(option, value, context, path);
      if (error) return error;
    }
  }
  if (schema.not !== undefined && checkOpenApiValue(schema.not, value, context, path) === null) return `${path}: matched a forbidden schema`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) return `${path}: not one of ${JSON.stringify(schema.enum)}`;
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return `${path}: expected ${JSON.stringify(schema.const)}`;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) return `${path}: expected ${types.join('|')}, got ${jsonType(value)}`;
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return `${path}: does not match ${schema.pattern}`;
    if (isFiniteNumber(schema.minLength) && value.length < schema.minLength) return `${path}: shorter than ${schema.minLength}`;
    if (isFiniteNumber(schema.maxLength) && value.length > schema.maxLength) return `${path}: longer than ${schema.maxLength}`;
  }
  if (typeof value === 'number') {
    if (isFiniteNumber(schema.minimum) && value < schema.minimum) return `${path}: below ${schema.minimum}`;
    if (isFiniteNumber(schema.maximum) && value > schema.maximum) return `${path}: above ${schema.maximum}`;
    if (isFiniteNumber(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) return `${path}: not above ${schema.exclusiveMinimum}`;
    if (isFiniteNumber(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) return `${path}: not below ${schema.exclusiveMaximum}`;
  }
  if (Array.isArray(value)) {
    if (isFiniteNumber(schema.minItems) && value.length < schema.minItems) return `${path}: fewer than ${schema.minItems} items`;
    if (isFiniteNumber(schema.maxItems) && value.length > schema.maxItems) return `${path}: more than ${schema.maxItems} items`;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (let index = 0; index < value.length; index += 1) {
      const itemSchema = index < prefix.length ? prefix[index] : schema.items;
      const error = checkOpenApiValue(itemSchema, value[index], context, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) return `${path}: missing ${key}`;
    }
    const patterns = isRecord(schema.patternProperties)
      ? Object.entries(schema.patternProperties).map(([pattern, propertySchema]) => [new RegExp(pattern, 'u'), propertySchema]) : [];
    for (const [key, propertyValue] of Object.entries(value)) {
      const keyPath = `${path}.${key}`;
      if (Object.hasOwn(properties, key)) {
        const error = checkOpenApiValue(properties[key], propertyValue, context, keyPath);
        if (error) return error;
        continue;
      }
      const matched = patterns.filter(([pattern]) => pattern.test(key));
      if (matched.length) {
        for (const [, propertySchema] of matched) {
          const error = checkOpenApiValue(propertySchema, propertyValue, context, keyPath);
          if (error) return error;
        }
        continue;
      }
      if (schema.additionalProperties === false) return `${keyPath}: unexpected property`;
      if (isRecord(schema.additionalProperties)) {
        const error = checkOpenApiValue(schema.additionalProperties, propertyValue, context, keyPath);
        if (error) return error;
      }
    }
  }
  return null;
};

/** The JSON request-body schema of an operation, or `null`. */
export const openApiRequestSchema = (doc, method, template) => {
  const operation = doc?.paths?.[template]?.[method.toLowerCase()];
  const body = operation?.requestBody;
  if (!isRecord(body)) return null;
  return { required: body.required === true, schema: body.content?.['application/json']?.schema ?? null };
};

/** The JSON response schema of an operation for one status, `null` for a body-less status, `undefined` if undeclared. */
export const openApiResponseSchema = (doc, method, template, status) => {
  const response = doc?.paths?.[template]?.[method.toLowerCase()]?.responses?.[String(status)];
  if (!isRecord(response)) return undefined;
  if (!isRecord(response.content)) return null;
  return response.content['application/json']?.schema ?? null;
};
