// Loopback OpenCode 2.0.20 fixture (gen 2) with the same control API as the gen-1
// fixture (`fixture-session-seeds.mjs`), so QA scenarios stay generation-agnostic.
//
// Wire contract (DESIGN.md D):
// - Basic auth (`opencode:<password>`, or `?auth_token=`), 401 `UnauthorizedError` otherwise.
// - Routes are matched with the gen-2 route table (`v2/route-policy.js`); bodies follow the
//   vendored 2.0.20 OpenAPI document and are validated against it.
// - Location routes (`header` and `body-location` modes) without a location answer
//   400 `location_required`. This is stricter than 2.0.20 (which falls back to its
//   cwd, F9) so client bugs surface in tests.
// - `/api/event` is the global 2.0.20 stream: `server.connected` (no `created`, as 2.0.20
//   writes it), data-only frames with `location` and `durable{aggregateID, seq, version}`,
//   and `: heartbeat` comments.
// - Every REST record is the fold of the published events (`opencode-v2-wire.mjs`), so
//   REST and SSE never disagree. As in 2.0.20, ephemeral deltas never reach REST.
// - Named sequences replay the item-0 vectors captured from a real 2.0.20 host.
// - `/devryan/*` (DESIGN C.6) are FIXTURE-ONLY plausible shapes marked with
//   `x-devryan-fixture-only: true` until the Phase 3 host defines them.
// - Unknown routes answer 404 and are recorded, as in gen 1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toManagedTaskEvent, toManagedTaskRemovalEvent, validateManagedTaskRecord } from '../../packages/orchestration-runtime/contract.js';
import { assertManagedTaskResultEnvelopeMatchesTask } from '../../packages/orchestration-runtime/result-envelope.js';
import { assistantReasoningPartId, assistantTextPartId, assistantToolPartId, compactionSummaryMessageId } from '../../packages/web/server/lib/opencode/v2/projection/ids.js';
import { toV1ToolPart, toV2ToolName } from '../../packages/web/server/lib/opencode/v2/projection/tools.js';
import { matchOpenCodeV2Route } from '../../packages/web/server/lib/opencode/v2/route-policy.js';
import { PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID } from './fixture-session-seeds.mjs';
import {
  checkOpenApiValue, createV2IdFactory, createV2WireStore, DEVRYAN_FIXTURE_EVENT_TYPES, encodeV2Frame,
  OPENCODE_V2_DURABLE_EVENT_VERSIONS, OPENCODE_V2_UNLOCATED_EVENT_TYPES, openApiRequestSchema, parseV2FrameBlock,
  toWireFileAttachment, V2_HEARTBEAT_FRAME, wireEventsForDomainRows, zeroTokens,
} from './opencode-v2-wire.mjs';

export { PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID };

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V2_DIRECTORY = path.join(repositoryRoot, 'packages/web/server/lib/opencode/v2');
export const OPENCODE_V2_FIXTURE_OPENAPI_PATH = path.join(V2_DIRECTORY, 'openapi-2.0.20.json');
export const OPENCODE_V2_FIXTURE_VECTORS_DIRECTORY = path.join(V2_DIRECTORY, '__vectors__');
export const OPENCODE_V2_FIXTURE_VERSION = '2.0.20';

/** Named event sequences (DESIGN D) and the captured 2.0.20 vector each one replays. */
export const OPENCODE_V2_FIXTURE_SEQUENCES = Object.freeze({
  'two-step-tool-turn': '01-two-step-tool-turn.json',
  retry: '02-retry.json',
  abort: '03-abort.json',
  failure: '04-failure.json',
  'tool-failed': '04b-tool-failed.json',
  'question-form': '05-question-form.json',
  'question-dismissed': '05b-question-dismissed.json',
  permission: '06-permission.json',
  compaction: '07-compaction.json',
  revert: '08-revert.json',
  'rename-metadata': '09-rename-metadata.json',
  child: '10-child.json',
  synthetic: '11-synthetic.json',
  'steer-queue-switch': '12-steer-queue-switch.json',
  'stream-drop': '13-stream-drop.json',
  'location-shutdown': '14-location-shutdown.json',
});

const ALL_SESSION_IDS = [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS];
const FIXED_CREATED_AT = Date.now();
const DEFAULT_MODEL = Object.freeze({ id: 'fixture-model', providerID: 'fixture' });
const PROJECT_ID = 'project_perf';
const VECTOR_TIME_BASE = 1767225600000;
const CONTINUE_TEXT = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const UNAUTHORIZED_MESSAGE = 'Authentication required';
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"';
const DEFAULT_PAGE_SIZE = 50;
const MESSAGE_TYPES = new Set(['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell', 'assistant', 'compaction']);

const streamFixtureChunks = new Map([
  [PERF_PARENT_SESSION_ID, ['Renderer ', 'paint ', 'fixture ', 'parent.\n']],
  [PERF_CHILD_SESSION_IDS[0], ['Child ', 'one ', 'stream ', 'α.\n']],
  [PERF_CHILD_SESSION_IDS[1], ['Child ', 'two ', 'stream ', 'β.\n']],
  [PERF_CHILD_SESSION_IDS[2], ['Child ', 'three ', 'stream ', 'γ.\n']],
]);

/** v1 suppression categories (the gen-1 control API) -> the gen-2 events that project to them. */
const SUPPRESSION_CATEGORIES = new Map([
  ['session.text.delta', 'message.part.delta'], ['session.reasoning.delta', 'message.part.delta'],
  ['session.text.started', 'message.part.updated'], ['session.text.ended', 'message.part.updated'],
  ['session.reasoning.started', 'message.part.updated'], ['session.reasoning.ended', 'message.part.updated'],
  ['session.tool.input.started', 'message.part.updated'], ['session.tool.input.ended', 'message.part.updated'],
  ['session.tool.called', 'message.part.updated'], ['session.tool.progress', 'message.part.updated'],
  ['session.tool.success', 'message.part.updated'], ['session.tool.failed', 'message.part.updated'],
  ['session.step.started', 'message.updated'], ['session.step.streamed', 'message.updated'],
  ['session.step.ended', 'message.updated'], ['session.step.failed', 'message.updated'],
  ['session.retry.scheduled', 'message.updated'],
  ['session.execution.started', 'session.status'], ['session.execution.succeeded', 'session.status'],
  ['session.execution.failed', 'session.status'], ['session.execution.interrupted', 'session.status'],
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const json = (response, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
};
const noContent = (response) => { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); };
const fail = (response, status, tag, message, extra = {}) => json(response, status, { _tag: tag, ...extra, message });
const sessionNotFound = (response, sessionID) => fail(response, 404, 'SessionNotFoundError', `Session not found: ${sessionID}`, { sessionID });
const invalidRequest = (response, message, extra = {}) => fail(response, 400, 'InvalidRequestError', message, extra);

const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeCursor = (text) => {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const validatePromptOptions = (options) => {
  const keys = ['reasoning','reasoningText','reasoningDelayChunks','tool','hold','chunks','intervalMs','rejectStatus','responseText','canonicalUserDelayMs'];
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !keys.includes(key))) throw new Error('Invalid fixture prompt options');
  const behavior = { reasoning:'none', reasoningText:'Checking the task requirements before answering.', reasoningDelayChunks:3,
    tool:'none', hold:false, chunks:20, intervalMs:100, canonicalUserDelayMs:0, ...options };
  if (!['none','delayed','empty','text'].includes(behavior.reasoning) || !['none','completed','error'].includes(behavior.tool)
    || typeof behavior.hold !== 'boolean' || typeof behavior.reasoningText !== 'string' || behavior.reasoningText.length > 16_384
    || !Number.isSafeInteger(behavior.reasoningDelayChunks) || behavior.reasoningDelayChunks < 0 || behavior.reasoningDelayChunks > 1000
    || !Number.isSafeInteger(behavior.chunks) || behavior.chunks < 1 || behavior.chunks > 1000
    || !Number.isSafeInteger(behavior.intervalMs) || behavior.intervalMs < 10 || behavior.intervalMs > 10_000
    || !Number.isSafeInteger(behavior.canonicalUserDelayMs) || behavior.canonicalUserDelayMs < 0 || behavior.canonicalUserDelayMs > 10_000
    || (behavior.responseText !== undefined && (typeof behavior.responseText !== 'string' || behavior.responseText.length > 16_384))
    || (behavior.rejectStatus !== undefined && ![400,409,429,500].includes(behavior.rejectStatus))) throw new Error('Invalid fixture prompt options');
  return behavior;
};
const DEFAULT_BEHAVIOR = Object.freeze(validatePromptOptions({}));

const v2ModelsFromThinkingModels = (thinkingModels) => Object.values(thinkingModels ?? {
  'fixture-model': { id: 'fixture-model', name: 'Fixture model', limit: { context: 100_000, output: 10_000 },
    variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } },
}).map((model) => ({
  id: model.id, modelID: model.id, providerID: 'fixture', name: model.name ?? model.id,
  package: '@opencode/ai/providers/openai-compatible',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({ id, settings: structuredClone(settings) })),
  time: { released: 0 }, cost: [], status: 'active', enabled: true,
  limit: { context: model.limit?.context ?? 100_000, output: model.limit?.output ?? 10_000 },
}));

/**
 * @param {{ directory: string, agentVariant?: 'low' | 'high', thinkingModels?: Record<string, object>,
 *   password?: string, opencodeVersion?: string, heartbeatMs?: number, catalogEventsOnFirstTouch?: boolean,
 *   commands?: { name: string, description?: string }[] }} options
 */
export const createLoopbackOpenCodeV2Fixture = async ({
  directory, agentVariant, thinkingModels, password = crypto.randomBytes(18).toString('base64url'),
  opencodeVersion = OPENCODE_V2_FIXTURE_VERSION, heartbeatMs = 15_000, catalogEventsOnFirstTouch = true, commands = [],
} = {}) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('The v2 fixture requires an absolute directory');
  if (agentVariant !== undefined && !['low','high'].includes(agentVariant)) throw new Error('Invalid fixture agent variant');
  if (typeof password !== 'string' || password.length < 8) throw new Error('The v2 fixture requires a test password of at least 8 characters');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60_000) throw new Error('Invalid fixture heartbeat interval');
  const openapiText = fs.readFileSync(OPENCODE_V2_FIXTURE_OPENAPI_PATH, 'utf8');
  const openapi = JSON.parse(openapiText);
  const schemaContext = { components: openapi.components.schemas };

  const ids = createV2IdFactory();
  const store = createV2WireStore();
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

  // Catalog (the same logical catalog as gen 1, in 2.0.20 shapes).
  const models = v2ModelsFromThinkingModels(thinkingModels);
  const agents = ['build','builder','orchestrator'].map((name) => ({
    id: name, name, model: { ...DEFAULT_MODEL, ...(agentVariant !== undefined ? { variant: agentVariant } : {}) },
    request: { settings: {}, headers: {}, body: {} }, description: name === 'orchestrator' ? 'QA Orchestrator' : 'QA Builder',
    mode: 'primary', hidden: name === 'builder', permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  }));
  const providers = [{ id: 'fixture', name: 'Fixture', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' }];
  const integrations = [{ id: 'fixture', name: 'Fixture', methods: [{ type: 'key', label: 'Manually enter API Key' }], connections: [] }];
  const commandCatalog = commands.map((command) => ({ name: command.name, ...(command.description ? { description: command.description } : {}) }));
  const toolIDs = ['bash', 'read', 'edit', 'write', 'question'].map(toV2ToolName);

  // State.
  const sseClients = new Map();
  const sessionDirectories = new Map();
  const executing = new Set();
  const runs = new Map();
  const forms = new Map();
  const permissions = new Map();
  const addresses = new Map();
  const promptBehaviors = new Map();
  const inboxBehaviors = new Map();
  const deferredInbox = new Set();
  const deliveringInbox = new Set();
  const historyIDs = new Map();
  const historyNamespaces = new Map();
  const touchedLocations = new Set();
  const texts = new Map(ALL_SESSION_IDS.map((id) => [id, '']));
  const scenarioAssistants = new Map();
  const messageRequestCounts = new Map();
  const olderMessageRequestCounts = new Map();
  const messagePageRequests = [];
  const receivedPrompts = [];
  const canonicalUserDelays = [];
  const delayedDeliveries = new Map();
  const rejectedPrompts = [];
  const replies = [];
  const unknownRoutes = [];
  const locationRequired = [];
  const wireLosses = [];
  const suppressedEvents = [];
  const suppressionRuns = [];
  const streamDrops = [];
  const eventCounts = new Map();
  let nextCreatedSessionPrompt = null;
  let eventSuppression = null;
  let streamTimer = null;
  let activeScenario = 'idle';
  let statusRequestCount = 0;
  let sseConnectionCount = 0;
  let abortedPrompts = 0;
  let nextIdentity = 0;
  let todoRevision = 0;
  let origin = '';
  let readiness = { ready: true };

  const requireSession = (sessionID) => {
    if (!store.has(sessionID)) throw new Error('Unknown fixture session');
  };
  const sessionDirectory = (sessionID) => sessionDirectories.get(sessionID) ?? directory;

  // -------------------------------------------------------------------------
  // Publication

  const writeFrame = (frame) => {
    for (const [response, client] of sseClients) {
      response.write(frame);
      if (client.dropAfter === null) continue;
      client.dropAfter -= 1;
      if (client.dropAfter <= 0) {
        // SubscriberOverflow over a Bun listener ends as a clean chunked terminator (F7).
        sseClients.delete(response);
        clearInterval(client.heartbeat);
        response.end();
      }
    }
  };

  const suppressionFor = (envelope) => {
    if (!eventSuppression) return null;
    const rule = eventSuppression;
    if (Date.now() >= rule.expiresAt) {
      rule.endedReason = 'expired'; eventSuppression = null;
      return null;
    }
    const category = SUPPRESSION_CATEGORIES.get(envelope.type);
    const data = envelope.data ?? {};
    if (!category || data.sessionID !== rule.sessionID || !rule.types.includes(category)) return null;
    if (category !== 'session.status' && data.assistantMessageID !== rule.messageID) return null;
    return { rule, category };
  };

  const partIDFor = (envelope) => {
    const data = envelope.data ?? {};
    if (envelope.type.startsWith('session.text.')) return assistantTextPartId(data.assistantMessageID, data.ordinal);
    if (envelope.type.startsWith('session.reasoning.')) return assistantReasoningPartId(data.assistantMessageID, data.ordinal);
    if (envelope.type.startsWith('session.tool.')) return assistantToolPartId(data.assistantMessageID, data.id);
    return null;
  };

  const emit = (envelope) => {
    eventCounts.set(envelope.type, (eventCounts.get(envelope.type) ?? 0) + 1);
    const suppressed = suppressionFor(envelope);
    if (suppressed) {
      const { rule, category } = suppressed;
      rule.suppressedCount += 1;
      suppressedEvents.push({ eventID: envelope.id, at: Date.now(), type: category, v2Type: envelope.type,
        sessionID: envelope.data.sessionID, messageID: envelope.data.assistantMessageID ?? null, partID: partIDFor(envelope),
        status: category === 'session.status' ? (envelope.type === 'session.execution.started' ? 'busy' : 'idle') : null });
      if (rule.suppressedCount === rule.maximumEvents) { rule.endedReason = 'count-limit'; eventSuppression = null; }
      return;
    }
    writeFrame(encodeV2Frame(envelope));
  };

  const afterApply = (envelope) => {
    const data = envelope.data ?? {};
    switch (envelope.type) {
      case 'session.created': sessionDirectories.set(data.sessionID, data.location.directory); break;
      case 'session.forked': sessionDirectories.set(data.sessionID, sessionDirectory(data.parentID)); break;
      case 'session.deleted':
        for (const [id, form] of forms) if (form.form.sessionID === data.sessionID) forms.delete(id);
        for (const [id, request] of permissions) if (request.sessionID === data.sessionID) permissions.delete(id);
        executing.delete(data.sessionID);
        break;
      case 'session.execution.started': executing.add(data.sessionID); break;
      case 'session.execution.succeeded': case 'session.execution.failed': case 'session.execution.interrupted':
        executing.delete(data.sessionID); break;
      case 'form.created': forms.set(data.form.id, { form: structuredClone(data.form), state: { status: 'pending' } }); break;
      case 'form.replied': { const form = forms.get(data.id); if (form) form.state = { status: 'answered', answer: structuredClone(data.answer) }; break; }
      case 'form.cancelled': { const form = forms.get(data.id); if (form) form.state = { status: 'cancelled' }; break; }
      case 'permission.asked': permissions.set(data.id, structuredClone(data)); break;
      case 'permission.replied': permissions.delete(data.requestID); break;
      default: break;
    }
  };

  const defaultLocation = (type, data) => {
    if (OPENCODE_V2_UNLOCATED_EVENT_TYPES.has(type)) return null;
    if (isRecord(data.location) && typeof data.location.directory === 'string' && type === 'session.created') return { directory: data.location.directory };
    if (typeof data.sessionID === 'string' && sessionDirectories.has(data.sessionID)) return { directory: sessionDirectories.get(data.sessionID) };
    if (type === 'session.forked') return { directory: sessionDirectory(data.parentID) };
    return { directory };
  };

  /**
   * Publishes one 2.0.20 event: envelope, durable seq, fold into the store, then frame.
   * `location: null` publishes without a location; `undefined` uses the 2.0.20 default.
   */
  const publish = (type, data, { created, location, metadata } = {}) => {
    const envelope = { id: ids.ascending('evt'), created: created ?? Date.now() };
    if (metadata) envelope.metadata = structuredClone(metadata);
    envelope.type = type;
    const resolved = location === undefined ? defaultLocation(type, data) : location;
    if (resolved) envelope.location = resolved;
    envelope.data = structuredClone(data);
    const version = OPENCODE_V2_DURABLE_EVENT_VERSIONS.get(type);
    if (version !== undefined) {
      const aggregateID = typeof data.sessionID === 'string' ? data.sessionID : 'global';
      envelope.durable = { aggregateID, seq: store.nextSeq(aggregateID), version };
    }
    store.apply(envelope);
    afterApply(envelope);
    emit(envelope);
    return envelope;
  };

  /** Fixture-only DevRyan frames (managed-task visuals); never part of the 2.0.20 manifest. */
  const publishFixtureOnly = (event) => {
    if (!DEVRYAN_FIXTURE_EVENT_TYPES.has(event.type)) throw new Error('Unknown fixture-only event type');
    const envelope = { id: ids.ascending('evt'), created: Date.now(), metadata: { devryanFixture: true }, type: event.type,
      location: { directory: event.properties.directory ?? directory }, data: structuredClone(event.properties) };
    eventCounts.set(envelope.type, (eventCounts.get(envelope.type) ?? 0) + 1);
    writeFrame(encodeV2Frame(envelope));
    return envelope;
  };

  // -------------------------------------------------------------------------
  // Vector replay (named sequences)

  const loadVectorEvents = (file) => {
    const vector = JSON.parse(fs.readFileSync(path.join(OPENCODE_V2_FIXTURE_VECTORS_DIRECTORY, file), 'utf8'));
    return vector.frames.map((raw) => parseV2FrameBlock(raw.replace(/\n\n$/, ''))).filter((frame) => frame?.kind === 'event').map((frame) => frame.event);
  };

  const remapVectorEvents = (events, targetDirectory) => {
    const idPattern = /\b(ses|msg|frm|per|evt)_[0-9a-f]{12}normalized0000/g;
    const found = new Map();
    const scan = (value) => {
      if (typeof value === 'string') for (const match of value.matchAll(idPattern)) found.set(match[0], match[1]);
      else if (Array.isArray(value)) value.forEach(scan);
      else if (isRecord(value)) Object.values(value).forEach(scan);
    };
    events.forEach((event) => scan(event.data));
    const idMap = new Map();
    const sorted = [...found.keys()].sort();
    for (const id of sorted.filter((candidate) => found.get(candidate) === 'ses').reverse()) idMap.set(id, ids.descending('ses'));
    for (const id of sorted.filter((candidate) => found.get(candidate) !== 'ses')) idMap.set(id, ids.ascending(found.get(id)));
    const base = Date.now();
    const parent = path.dirname(targetDirectory);
    const transform = (value) => {
      if (typeof value === 'string') {
        return value.replaceAll('<home>/workspace-other', `${targetDirectory}-other`).replaceAll('<home>/workspace', targetDirectory)
          .replaceAll('<home>', parent).replace(idPattern, (match) => idMap.get(match) ?? match);
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= VECTOR_TIME_BASE && value < VECTOR_TIME_BASE + 1e9) {
        return base + Math.round((value - VECTOR_TIME_BASE) / 1000);
      }
      if (Array.isArray(value)) return value.map(transform);
      if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item)]));
      return value;
    };
    return {
      idMap,
      events: events.filter((event) => event.type !== 'server.connected').map((event) => ({
        type: event.type, data: transform(event.data), created: transform(event.created),
        location: event.location ? transform(event.location) : null, metadata: event.metadata ? transform(event.metadata) : undefined,
      })),
    };
  };

  /** Moves each delta group before its durable `*.started` (and the first group before `step.started`). */
  const reorderDeltaFirst = (events) => {
    const key = (event) => `${event.data.assistantMessageID}|${event.type.split('.')[1]}|${event.data.ordinal}`;
    const deltas = new Map();
    for (const event of events) if (/^session\.(text|reasoning)\.delta$/.test(event.type)) {
      const list = deltas.get(key(event)) ?? []; list.push(event); deltas.set(key(event), list);
    }
    const firstGroup = new Map();
    for (const event of events) if (/^session\.(text|reasoning)\.started$/.test(event.type) && !firstGroup.has(event.data.assistantMessageID)) {
      firstGroup.set(event.data.assistantMessageID, key(event));
    }
    const placed = new Set();
    const out = [];
    const place = (groupKey) => { if (!groupKey || placed.has(groupKey)) return; placed.add(groupKey); out.push(...(deltas.get(groupKey) ?? [])); };
    for (const event of events) {
      if (/^session\.(text|reasoning)\.delta$/.test(event.type)) { if (!placed.has(key(event))) { placed.add(key(event)); out.push(...deltas.get(key(event))); } continue; }
      if (event.type === 'session.step.started') place(firstGroup.get(event.data.assistantMessageID));
      if (/^session\.(text|reasoning)\.started$/.test(event.type)) place(key(event));
      out.push(event);
    }
    return out;
  };

  const settledReply = (event) => {
    if (event.type === 'form.replied' || event.type === 'form.cancelled') return forms.get(event.data.id)?.state.status !== 'pending';
    if (event.type === 'permission.replied') return !permissions.has(event.data.requestID);
    return false;
  };

  const publishReplayEvent = (event) => {
    if (settledReply(event)) return;
    let data = event.data;
    if (event.type === 'session.forked' && data.boundary?.type === 'through'
      && !store.messages(data.parentID).some((record) => record.id === data.boundary.messageID)) {
      // The vector's `through` boundary is an event-derived idle id normalised separately: use the parent's last message.
      const last = store.messages(data.parentID).at(-1);
      if (last) data = { ...data, boundary: { type: 'through', messageID: last.id } };
    }
    publish(event.type, data, { created: event.created, location: event.location, metadata: event.metadata });
  };

  const playSequence = (name, { deltaFirst = false, until, directory: targetDirectory = directory } = {}) => {
    const file = OPENCODE_V2_FIXTURE_SEQUENCES[name];
    if (!file) throw new Error('Unknown fixture sequence');
    if (until !== undefined && typeof until !== 'string') throw new Error('Invalid fixture sequence pause');
    if (deltaFirst && name !== 'two-step-tool-turn') throw new Error('deltaFirst applies to the two-step tool turn');
    const { events: remapped, idMap } = remapVectorEvents(loadVectorEvents(file), targetDirectory);
    const events = deltaFirst ? reorderDeltaFirst(remapped) : remapped;
    if (name === 'stream-drop') dropEventStream({ afterFrames: events.length });
    let index = 0;
    const run = (stopType) => {
      for (; index < events.length; index += 1) {
        if (stopType !== undefined && events[index].type === stopType) return false;
        publishReplayEvent(events[index]);
      }
      return true;
    };
    const done = run(until);
    const sessionIDs = [...idMap.entries()].filter(([from]) => from.startsWith('ses_')).sort(([a], [b]) => (a < b ? 1 : -1)).map(([, to]) => to);
    return {
      name, sessionIDs, idMap: Object.fromEntries(idMap), done, frames: events.length,
      next: () => events[index]?.type ?? null,
      resume: ({ until: nextStop } = {}) => run(nextStop),
    };
  };

  const touchLocation = (targetDirectory) => {
    if (!catalogEventsOnFirstTouch || touchedLocations.has(targetDirectory)) return;
    touchedLocations.add(targetDirectory);
    // The first touch of a location publishes the catalog `*.updated` events (00-catalog-cold).
    for (const event of remapVectorEvents(loadVectorEvents('00-catalog-cold.json'), targetDirectory).events) publishReplayEvent(event);
  };

  // -------------------------------------------------------------------------
  // SSE

  const dropEventStream = ({ afterFrames = 0 } = {}) => {
    if (!Number.isSafeInteger(afterFrames) || afterFrames < 0 || afterFrames > 100_000) throw new Error('Invalid fixture stream drop');
    streamDrops.push({ at: Date.now(), afterFrames, clients: sseClients.size });
    for (const [response, client] of sseClients) {
      if (afterFrames === 0) {
        sseClients.delete(response); clearInterval(client.heartbeat); response.end();
      } else client.dropAfter = afterFrames;
    }
  };

  const openEventStream = (request, response) => {
    sseConnectionCount += 1;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    // 2.0.20 frames server.connected with id/type/data only (server-info-asp20mjn.js).
    response.write(encodeV2Frame({ id: ids.ascending('evt'), type: 'server.connected', data: {} }));
    response.write(V2_HEARTBEAT_FRAME);
    const heartbeat = setInterval(() => response.write(V2_HEARTBEAT_FRAME), heartbeatMs);
    sseClients.set(response, { heartbeat, dropAfter: null });
    request.on('close', () => { clearInterval(heartbeat); sseClients.delete(response); });
  };

  // -------------------------------------------------------------------------
  // Sessions, messages and selections

  const modelRef = (providerID, modelID, variant) => ({
    id: modelID, providerID, ...(isNonEmptyString(variant) ? { variant } : {}),
  });

  /** Agent and model of a stored user message: `metadata.devryan`, else the session selection. */
  const userSelection = (sessionID, record) => {
    const devryan = isRecord(record?.metadata?.devryan) ? record.metadata.devryan : {};
    const session = store.session(sessionID);
    const sessionModel = session?.model ?? DEFAULT_MODEL;
    const providerID = isNonEmptyString(devryan.providerID) ? devryan.providerID : sessionModel.providerID;
    const modelID = isNonEmptyString(devryan.modelID) ? devryan.modelID : sessionModel.id;
    const variant = Object.hasOwn(devryan, 'variant') ? devryan.variant : sessionModel.variant;
    return { agent: isNonEmptyString(devryan.agent) ? devryan.agent : (session?.agent ?? 'build'),
      model: { providerID, modelID, ...(variant !== undefined ? { variant } : {}) } };
  };

  const createSessionRecord = ({ id, title, parentID, agent, model, metadata, permissions: rules, location, created }) => {
    const sessionID = id ?? ids.descending('ses');
    publish('session.created', {
      sessionID, slug: sessionID, version: '2', projectID: PROJECT_ID, location: { directory: location ?? directory },
      ...(parentID ? { parentID } : {}), ...(title !== undefined ? { title } : {}), ...(agent ? { agent } : {}),
      ...(model ? { model } : {}), ...(metadata ? { metadata } : {}), ...(rules ? { permissions: rules } : {}),
    }, created === undefined ? {} : { created });
    if (nextCreatedSessionPrompt) {
      promptBehaviors.set(sessionID, nextCreatedSessionPrompt);
      nextCreatedSessionPrompt = null;
    }
    return sessionID;
  };

  const userPayload = (text, parts, extra = {}) => ({ text, metadata: { devryan: { v: 1, ...extra, parts } } });

  // Seed the four performance sessions and their single user turn, as gen 1 does.
  ALL_SESSION_IDS.forEach((sessionID, index) => {
    const parent = sessionID === PERF_PARENT_SESSION_ID;
    createSessionRecord({ id: sessionID, parentID: parent ? undefined : PERF_PARENT_SESSION_ID,
      title: parent ? 'Performance parent' : `Performance ${sessionID.slice(-7)}`, created: FIXED_CREATED_AT + (parent ? 4 : index) });
    const text = 'Run the deterministic renderer performance fixture.';
    const inboxID = `msg_user_${sessionID}`;
    publish('session.inbox.enqueued', { sessionID, inboxID, item: { type: 'user', delivery: 'steer',
      payload: userPayload(text, [{ kind: 'text', length: text.length, id: `part_user_${sessionID}` }], { agent: 'build', providerID: 'fixture', modelID: 'fixture-model' }) } },
    { created: FIXED_CREATED_AT + 10 + (parent ? 4 : index) });
    publish('session.inbox.delivered', { sessionID, inboxID }, { created: FIXED_CREATED_AT + 10 });
  });

  const lastStoredTime = (sessionID) => store.messages(sessionID).reduce((latest, record) => Math.max(latest, record.time?.created ?? 0, record.time?.completed ?? 0), 0);

  // -------------------------------------------------------------------------
  // Turns (prompt, synthetic resume, queued delivery)

  const hasPendingInteraction = (sessionID) => [...permissions.values()].some((request) => request.sessionID === sessionID)
    || [...forms.values()].some((form) => form.form.sessionID === sessionID && form.state.status === 'pending');

  const finishExecution = (sessionID) => {
    if (executing.has(sessionID)) publish('session.execution.succeeded', { sessionID });
  };

  const scheduleInbox = (sessionID) => {
    if (runs.has(sessionID) || !store.has(sessionID)) return;
    const next = store.inbox(sessionID).find((item) => !deferredInbox.has(item.id) && !deliveringInbox.has(item.id)
      && (item.type === 'user' || item.type === 'synthetic'));
    if (!next) {
      finishExecution(sessionID);
      return;
    }
    const behavior = inboxBehaviors.get(next.id) ?? DEFAULT_BEHAVIOR;
    inboxBehaviors.delete(next.id);
    if (!executing.has(sessionID)) publish('session.execution.started', { sessionID });
    if (behavior.canonicalUserDelayMs > 0) {
      const now = Date.now();
      const observation = { sessionID, messageID: next.id, assistantMessageID: null, receivedAt: now, delayMs: behavior.canonicalUserDelayMs,
        releaseDueAt: now + behavior.canonicalUserDelayMs, releasedAt: null, ...userSelection(sessionID, { metadata: next.payload.metadata }) };
      canonicalUserDelays.push(observation);
      deliveringInbox.add(next.id);
      // Fixture-only ordering: 2.0.20 always delivers before the step starts.
      const timer = setTimeout(() => {
        delayedDeliveries.delete(next.id);
        deliveringInbox.delete(next.id);
        observation.releasedAt = Date.now();
        if (store.has(sessionID)) publish('session.inbox.delivered', { sessionID, inboxID: next.id });
      }, behavior.canonicalUserDelayMs);
      delayedDeliveries.set(next.id, timer);
      const run = startRun(sessionID, next, behavior);
      observation.assistantMessageID = run.assistantID;
      return;
    }
    publish('session.inbox.delivered', { sessionID, inboxID: next.id });
    startRun(sessionID, next, behavior);
  };

  const toolInput = { command: 'npm test', description: 'Run fixture tests' };

  const startRun = (sessionID, item, behavior) => {
    const selection = userSelection(sessionID, { metadata: item.payload?.metadata });
    const run = { sessionID, userID: item.id, behavior: { ...behavior }, assistantID: ids.ascending('msg'), chunks: 0, text: '',
      reasoning: null, tool: null, timer: null, settle: null };
    runs.set(sessionID, run);
    const base = { sessionID, assistantMessageID: run.assistantID };
    publish('session.step.started', { ...base, agent: selection.agent,
      model: modelRef(selection.model.providerID, selection.model.modelID, selection.model.variant), started: Date.now() });
    if (behavior.reasoning !== 'none') {
      run.reasoning = { ended: false, text: '' };
      publish('session.reasoning.started', { ...base, ordinal: 0 });
      if (behavior.reasoning === 'text') endReasoning(run, behavior.reasoningText);
    }
    if (behavior.tool !== 'none') {
      run.tool = { callID: `call_qa${++nextIdentity}` };
      const tool = { ...base, id: run.tool.callID };
      publish('session.tool.input.started', { ...tool, name: toV2ToolName('bash') });
      publish('session.tool.input.ended', { ...tool, text: JSON.stringify(toolInput) });
      publish('session.tool.called', { ...tool, input: structuredClone(toolInput), executed: false });
    }
    publish('session.text.started', { ...base, ordinal: 0 });
    run.settle = (outcome) => settleRun(run, outcome);
    run.timer = setInterval(() => tickRun(run), behavior.intervalMs);
    return run;
  };

  const endReasoning = (run, text) => {
    const base = { sessionID: run.sessionID, assistantMessageID: run.assistantID, ordinal: 0 };
    if (text) publish('session.reasoning.delta', { ...base, delta: text });
    publish('session.reasoning.ended', { ...base, text });
    run.reasoning.text = text;
    run.reasoning.ended = true;
  };

  const tickRun = (run) => {
    if (run.behavior.hold || hasPendingInteraction(run.sessionID)) return;
    const { behavior } = run;
    if (run.reasoning && !run.reasoning.ended && behavior.reasoning === 'delayed' && run.chunks >= behavior.reasoningDelayChunks) {
      endReasoning(run, behavior.reasoningText);
    }
    const delta = behavior.responseText === undefined ? `QA response chunk ${run.chunks + 1}. ` : run.chunks === 0 ? behavior.responseText : '';
    run.text += delta;
    if (delta) publish('session.text.delta', { sessionID: run.sessionID, assistantMessageID: run.assistantID, ordinal: 0, delta });
    run.chunks += 1;
    if (run.chunks === behavior.chunks) run.settle({ kind: 'complete' });
  };

  /**
   * Ends a run. `complete`: normal end; `interrupt`: user interrupt (step.failed aborted,
   * execution.interrupted user); `permission-rejected`: the tool fails and the step ends;
   * `dismissed`: a question form was cancelled (05b: aborted, execution.interrupted shutdown);
   * `silent`: timers only (session deletion).
   */
  const settleRun = (run, { kind, message }) => {
    clearInterval(run.timer);
    runs.delete(run.sessionID);
    if (kind === 'silent') return;
    const base = { sessionID: run.sessionID, assistantMessageID: run.assistantID };
    if (run.tool) {
      const tool = { ...base, id: run.tool.callID, executed: false };
      if (kind === 'interrupt' || kind === 'dismissed') publish('session.tool.failed', { ...tool, error: { type: 'aborted', message: 'Tool cancelled' } });
      else if (kind === 'permission-rejected') publish('session.tool.failed', { ...tool, error: { type: 'permission.rejected', message: message ?? 'Permission rejected' } });
      else if (run.behavior.tool === 'error') publish('session.tool.failed', { ...tool, error: { type: 'tool.execution', message: 'Fixture test failure' } });
      else publish('session.tool.success', { ...tool, content: [{ type: 'text', text: 'Fixture tests passed.\n' }], metadata: { exit: 0 } });
    }
    if (run.reasoning && !run.reasoning.ended) endReasoning(run, run.reasoning.text);
    publish('session.text.ended', { ...base, ordinal: 0, text: run.text });
    publish('session.step.streamed', base);
    if (kind === 'interrupt' || kind === 'dismissed') {
      publish('session.step.failed', { ...base, error: { type: 'aborted', message: 'Step interrupted' } });
      publish('session.execution.interrupted', { sessionID: run.sessionID, reason: kind === 'interrupt' ? 'user' : 'shutdown' });
      return;
    }
    publish('session.step.ended', { ...base, finish: 'stop', rawFinish: 'stop', cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
    scheduleInbox(run.sessionID);
  };

  const cancelInteractions = (sessionID) => {
    for (const [id, request] of permissions) if (request.sessionID === sessionID) {
      publish('permission.replied', { sessionID, requestID: id, reply: 'reject' });
    }
    for (const [id, form] of forms) if (form.form.sessionID === sessionID && form.state.status === 'pending') {
      publish('form.cancelled', { id, sessionID });
    }
  };

  // -------------------------------------------------------------------------
  // Controls (gen-1 control API)

  const askPermission = (sessionID, { permission = 'bash', patterns = ['npm test'] } = {}) => {
    requireSession(sessionID);
    if (typeof permission !== 'string' || !permission || !Array.isArray(patterns) || !patterns.length || patterns.some((pattern) => typeof pattern !== 'string')) throw new Error('Invalid fixture permission');
    const run = runs.get(sessionID);
    const request = { id: ids.ascending('per'), sessionID, action: toV2ToolName(permission), resources: [...patterns], save: [...patterns], metadata: {},
      ...(run?.tool ? { source: { type: 'tool', messageID: run.assistantID, id: run.tool.callID } } : {}) };
    publish('permission.asked', request);
    return request.id;
  };

  const askQuestion = (sessionID, { question = 'Which implementation should be used?', options = ['Keep creation order','Sort by priority'] } = {}) => {
    requireSession(sessionID);
    if (typeof question !== 'string' || !question || !Array.isArray(options) || options.length < 2 || options.some((option) => typeof option !== 'string' || !option)) throw new Error('Invalid fixture question');
    const run = runs.get(sessionID);
    const form = { id: ids.ascending('frm'), sessionID, title: 'Questions',
      metadata: { kind: 'question', ...(run?.tool ? { tool: { messageID: run.assistantID, id: run.tool.callID } } : {}) },
      fields: [{ key: 'q0', title: 'Task order', description: question, type: 'string',
        options: options.map((label) => ({ value: label, label, description: label })), custom: true }] };
    publish('form.created', { form });
    return form.id;
  };

  const setTodos = (sessionID, items) => {
    requireSession(sessionID);
    if (!Array.isArray(items) || items.length > 100 || items.some((item) => typeof item?.content !== 'string'
      || !['pending','in_progress','completed','cancelled'].includes(item.status) || !['high','medium','low'].includes(item.priority))) throw new Error('Invalid fixture todos');
    // DESIGN B.6: the durable todo source is metadata.devryan.todo with an owner guard.
    const current = store.session(sessionID).metadata ?? {};
    const devryan = isRecord(current.devryan) ? current.devryan : {};
    todoRevision += 1;
    publish('session.metadata.updated', { sessionID,
      metadata: { ...current, devryan: { ...devryan, todo: { sessionID, items: structuredClone(items), rev: todoRevision } } } });
  };

  const seedHistory = (sessionID, { turns, textBytes = 128 } = {}) => {
    requireSession(sessionID);
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > 2000 || !Number.isSafeInteger(textBytes)
      || textBytes < 32 || textBytes > 65_536 || turns * textBytes > 32 * 1024 * 1024) throw new Error('Invalid fixture history size');
    if (runs.has(sessionID) || streamTimer !== null) throw new Error('Seed history before starting a workload');
    if (!historyNamespaces.has(sessionID)) historyNamespaces.set(sessionID, historyNamespaces.size);
    const namespace = historyNamespaces.get(sessionID).toString(16).padStart(8, '0');
    const previous = historyIDs.get(sessionID) ?? new Set();
    store.removeMessages(sessionID, (record) => previous.has(record.id));
    const records = [];
    for (let index = 0; index < turns; index += 1) {
      const created = FIXED_CREATED_AT - (turns - index) * 1000;
      const suffix = namespace + index.toString(16).padStart(6, '0');
      const userID = `msg_${(BigInt(created) << 12n).toString(16).padStart(14, '0')}${suffix}`;
      const assistantID = `msg_${(BigInt(created + 20) << 12n).toString(16).padStart(14, '0')}${suffix}`;
      const request = `History request ${index + 1}`;
      records.push({ id: userID, type: 'user', text: request, time: { created },
        metadata: { devryan: { v: 1, agent: 'build', providerID: 'fixture', modelID: 'fixture-model',
          parts: [{ kind: 'text', length: request.length, id: `prt_history_user_${sessionID}_${index}` }] } } });
      let text = `History response ${index + 1}. `;
      for (let segment = 1; text.length < textBytes; segment += 1) {
        text += `${String(segment).padStart(5, '0')}: The fixture preserves this numbered detail. `;
      }
      records.push({ id: assistantID, type: 'assistant', agent: 'build', model: { ...DEFAULT_MODEL }, content: [{ type: 'text', text: text.slice(0, textBytes) }],
        finish: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: created + 20, completed: created + 30 } });
    }
    store.prependMessages(sessionID, records);
    historyIDs.set(sessionID, new Set(records.map((record) => record.id)));
    return { sessionID, turns, messages: records.length };
  };

  const stopScenario = ({ settle = true } = {}) => {
    if (streamTimer !== null) { clearInterval(streamTimer); streamTimer = null; }
    if (settle) {
      for (const [sessionID, assistantID] of scenarioAssistants) {
        if (!store.has(sessionID)) continue;
        const base = { sessionID, assistantMessageID: assistantID };
        publish('session.text.ended', { ...base, ordinal: 0, text: texts.get(sessionID) ?? '' });
        publish('session.step.streamed', base);
        publish('session.step.ended', { ...base, finish: 'stop', rawFinish: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
        finishExecution(sessionID);
      }
      scenarioAssistants.clear();
    }
    activeScenario = 'idle';
  };

  const startScenario = (scenario) => {
    if (!['idle','one-stream','four-stream'].includes(scenario)) throw new Error('Invalid fixture streaming scenario');
    stopScenario({ settle: false });
    activeScenario = scenario;
    const active = (scenario === 'four-stream' ? ALL_SESSION_IDS : scenario === 'one-stream' ? [PERF_PARENT_SESSION_ID] : []).filter((id) => store.has(id));
    for (const sessionID of active) {
      const assistantID = `msg_assistant_${sessionID}`;
      const base = { sessionID, assistantMessageID: assistantID };
      if (scenarioAssistants.has(sessionID)) {
        // Close the unsettled step before restarting it (gen 1 resets the same message).
        publish('session.text.ended', { ...base, ordinal: 0, text: texts.get(sessionID) ?? '' });
        publish('session.step.ended', { ...base, finish: 'stop', cost: 0, tokens: zeroTokens() });
      }
      store.removeMessages(sessionID, (record) => record.id === assistantID);
      texts.set(sessionID, '');
      if (!executing.has(sessionID)) publish('session.execution.started', { sessionID });
      publish('session.step.started', { ...base, agent: 'build', model: { ...DEFAULT_MODEL }, started: Date.now() });
      publish('session.text.started', { ...base, ordinal: 0 });
      scenarioAssistants.set(sessionID, assistantID);
    }
    if (active.length === 0) return;
    const chunkIndexes = new Map(active.map((id) => [id, 0]));
    streamTimer = setInterval(() => {
      for (const sessionID of active) {
        const chunks = streamFixtureChunks.get(sessionID) ?? ['fixture'];
        const index = chunkIndexes.get(sessionID);
        const delta = chunks[index % chunks.length];
        chunkIndexes.set(sessionID, index + 1);
        texts.set(sessionID, `${texts.get(sessionID) ?? ''}${delta}`);
        publish('session.text.delta', { sessionID, assistantMessageID: `msg_assistant_${sessionID}`, ordinal: 0, delta });
      }
    }, 16);
  };

  const appendCompactionBoundary = (sessionID, options = {}) => {
    requireSession(sessionID);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['summaryText','autoContinue'].includes(key))
      || (options.autoContinue !== undefined && typeof options.autoContinue !== 'boolean')
      || (options.summaryText !== undefined && (typeof options.summaryText !== 'string' || !options.summaryText.trim() || options.summaryText.length > 16_384))) {
      throw new Error('Invalid fixture compaction options');
    }
    if (runs.has(sessionID)) throw new Error('Cannot append a compaction fixture during an active prompt');
    const previous = store.messages(sessionID).filter((record) => record.type === 'user').at(-1);
    if (!previous) throw new Error('A real fixture user turn is required before compaction records');
    const selection = userSelection(sessionID, previous);
    let now = Math.max(Date.now(), lastStoredTime(sessionID) + 1);
    const tick = () => now++;
    const identity = ++nextIdentity;
    const compactionID = ids.ascending('msg');
    const summaryText = options.summaryText ?? 'Fixture compaction summary: retain the previous real user selection.';
    const reason = options.autoContinue ? 'auto' : 'manual';
    const at = tick();
    publish('session.inbox.enqueued', { sessionID, inboxID: compactionID, item: { type: 'compaction', payload: {}, delivery: 'steer' } }, { created: at });
    if (!executing.has(sessionID)) publish('session.execution.started', { sessionID }, { created: at });
    publish('session.inbox.delivered', { sessionID, inboxID: compactionID }, { created: at });
    publish('session.compaction.started', { sessionID, reason, recent: '', inputID: compactionID }, { created: at });
    publish('session.compaction.delta', { sessionID, text: summaryText }, { created: tick() });
    publish('session.compaction.ended', { sessionID, reason, model: modelRef(selection.model.providerID, selection.model.modelID),
      text: summaryText, recent: '', cost: 0, tokens: zeroTokens() }, { created: tick() });
    let continuationUserID;
    if (options.autoContinue) {
      continuationUserID = ids.ascending('msg');
      const continuationAt = tick();
      const devryan = { v: 1, agent: selection.agent, providerID: selection.model.providerID, modelID: selection.model.modelID,
        ...(selection.model.variant !== undefined ? { variant: selection.model.variant } : {}),
        parts: [{ kind: 'synthetic', length: CONTINUE_TEXT.length, id: `prt_qa_continuation_${identity}` }] };
      publish('session.inbox.enqueued', { sessionID, inboxID: continuationUserID, item: { type: 'synthetic', delivery: 'steer',
        payload: { text: CONTINUE_TEXT, metadata: { compaction_continue: true, devryan } } } }, { created: continuationAt });
      publish('session.inbox.delivered', { sessionID, inboxID: continuationUserID }, { created: continuationAt });
      const assistantID = ids.ascending('msg');
      const base = { sessionID, assistantMessageID: assistantID };
      const started = tick();
      publish('session.step.started', { ...base, agent: selection.agent,
        model: modelRef(selection.model.providerID, selection.model.modelID, selection.model.variant), started }, { created: started });
      publish('session.text.started', { ...base, ordinal: 0 }, { created: started });
      publish('session.text.ended', { ...base, ordinal: 0, text: 'Fixture automatic continuation completed; await the next real user request.' }, { created: tick() });
      publish('session.step.ended', { ...base, finish: 'stop', rawFinish: 'stop', cost: 0, tokens: zeroTokens() }, { created: tick() });
    }
    finishExecution(sessionID);
    return { userMessageID: compactionID, summaryMessageID: compactionSummaryMessageId(compactionID), previousUserMessageID: previous.id,
      ...(continuationUserID ? { continuationUserMessageID: continuationUserID } : {}) };
  };

  const resolveAddress = (sessionID, messageID, partID) => {
    const known = addresses.get(partID);
    if (known && known.messageID === messageID) return known;
    const match = /^(.*):(text|reasoning):(\d+)$/.exec(partID);
    if (match && match[1] === messageID) return { messageID, kind: match[2], ordinal: Number(match[3]), projectedID: partID };
    return null;
  };

  /** Assistant/user rows of a session in seq order with the parent rule of DESIGN B.2. */
  const conversationRows = (sessionID) => {
    let lastUser = null;
    return store.messages(sessionID).filter((record) => ['user', 'synthetic', 'assistant'].includes(record.type)).map((record) => {
      if (record.type !== 'assistant') { lastUser = record.id; return { record, parentID: null }; }
      return { record, parentID: lastUser };
    });
  };

  const controls = {
    startScenario,
    stopScenario,
    seedHistory,
    // Live replay of a delta on an existing text or reasoning part. As in 2.0.20, deltas are
    // ephemeral: REST keeps the text of the last `*.ended` (gen 1 also appends it to REST).
    appendVisualPartDelta: ({ sessionID, messageID, partID, delta }) => {
      const record = store.peekMessage(sessionID, messageID);
      const address = record?.type === 'assistant' ? resolveAddress(sessionID, messageID, partID) : null;
      const items = address ? record.content.filter((item) => item.type === address.kind) : [];
      if (!address || !['text', 'reasoning'].includes(address.kind) || !items[address.ordinal] || typeof delta !== 'string') {
        throw new Error('Visual delta requires an existing text or reasoning part');
      }
      publish(`session.${address.kind}.delta`, { sessionID, assistantMessageID: messageID, ordinal: address.ordinal, delta });
    },
    replayRecoveryVisual: ({ sessionID, rows, taskEvents = [], status = 'idle', agent = null }) => {
      requireSession(sessionID);
      if (runs.has(sessionID) || !Array.isArray(rows) || rows.length > 32
        || !['idle', 'busy'].includes(status)
        || (agent !== null && !['explorer', 'designer'].includes(agent))
        || rows.some(row => row.info?.sessionID !== sessionID || !['user', 'assistant'].includes(row.info.role)
          || !Array.isArray(row.parts) || row.parts.some(part => part.sessionID !== sessionID || part.messageID !== row.info.id))) {
        throw new Error('Invalid recovery visual replay');
      }
      for (const { task, resultEnvelope = null } of taskEvents) {
        validateManagedTaskRecord(task);
        if (task.rootSessionId !== sessionID || task.directory !== directory) throw new Error('Recovery visual task outside fixture root');
        if (resultEnvelope) assertManagedTaskResultEnvelopeMatchesTask(task, resultEnvelope);
      }
      const wired = wireEventsForDomainRows(structuredClone(rows), { sessionID });
      // Replace the session's records (the gen-1 replay replaces rows); 2.0.20 has no such event.
      store.removeMessages(sessionID, () => true);
      if (status === 'busy' && !executing.has(sessionID)) publish('session.execution.started', { sessionID });
      for (const event of wired.events) publish(event.type, event.data, { created: event.created });
      for (const [id, address] of wired.addresses) addresses.set(id, address);
      wireLosses.push(...wired.losses.map((loss) => ({ sessionID, ...loss })));
      for (const { task, resultEnvelope = null } of taskEvents) publishFixtureOnly(toManagedTaskEvent(task, resultEnvelope));
      if (agent) publish('session.agent.selected', { sessionID, agent });
      if (status === 'idle') finishExecution(sessionID);
      return { addresses: Object.fromEntries([...wired.addresses].map(([id, address]) => [id, address.projectedID])), losses: structuredClone(wired.losses) };
    },
    replaySessionFailure: (sessionID, code = 'local_execution_timeout') => {
      requireSession(sessionID);
      if (!['local_execution_timeout', 'session_timeout', 'provider_authentication'].includes(code)) throw new Error('Invalid fixture failure');
      // Fixture-only: 2.0.20 publishes execution.failed only after execution.started.
      publish('session.execution.failed', { sessionID, error: { type: 'unknown', message: code } });
    },
    appendCompactionBoundary,
    configureNextPrompt: (sessionID, options) => {
      requireSession(sessionID);
      promptBehaviors.set(sessionID, validatePromptOptions(options));
    },
    configureNextCreatedSessionPrompt: (options) => {
      if (nextCreatedSessionPrompt) throw new Error('A next-created-session fixture prompt is already configured');
      nextCreatedSessionPrompt = validatePromptOptions(options);
    },
    setPromptReasoning: (sessionID, text) => {
      requireSession(sessionID);
      if (typeof text !== 'string' || text.length > 16_384) throw new Error('Invalid fixture reasoning text');
      const run = runs.get(sessionID);
      if (!run?.reasoning || run.reasoning.ended) throw new Error('No active fixture reasoning part');
      endReasoning(run, text);
    },
    releasePrompt: (sessionID) => { requireSession(sessionID); const run = runs.get(sessionID); if (!run) throw new Error('No active fixture prompt'); run.behavior.hold = false; },
    askPermission,
    askQuestion,
    setTodos,
    appendManagedTaskVisual: ({ sessionID, messageID, task, resultEnvelope = null }) => {
      requireSession(sessionID);
      validateManagedTaskRecord(task);
      if (resultEnvelope) assertManagedTaskResultEnvelopeMatchesTask(task, resultEnvelope);
      const row = store.peekMessage(sessionID, messageID);
      const child = store.session(task.childSessionId);
      const childRows = child ? conversationRows(child.id) : [];
      const childAssistant = childRows.at(-1);
      if (row?.type !== 'assistant' || task.rootSessionId !== sessionID || task.directory !== directory || child?.parentID !== sessionID
        || !task.dispatchCallId || !['running', 'completed'].includes(task.status)
        || (task.status === 'completed') !== Boolean(resultEnvelope)
        || childAssistant?.record.type !== 'assistant' || !childAssistant.parentID
        || !task.canonicalRefs.some(reference => reference.type === 'session' && reference.id === child.id)
        || !task.canonicalRefs.some(reference => reference.type === 'message' && reference.id === childAssistant.record.id)
        || (task.status === 'running' && (!executing.has(child.id) || childAssistant.record.time.completed))
        || (task.status === 'completed' && (executing.has(child.id) || !childAssistant.record.time.completed))
        || row.content.some(item => item.type === 'tool' && item.id === task.dispatchCallId)) {
        throw new Error('Managed task visual must correlate with an owned canonical root, assistant, child and unique dispatch');
      }
      const event = toManagedTaskEvent(task, resultEnvelope);
      const input = { action: 'start', agent: task.agent, label: task.label };
      const base = { sessionID, assistantMessageID: messageID, id: task.dispatchCallId };
      publish('session.tool.input.started', { ...base, name: 'devryan_task' }, { created: task.createdAt });
      publish('session.tool.input.ended', { ...base, text: JSON.stringify(input) }, { created: task.createdAt });
      publish('session.tool.called', { ...base, input, executed: false }, { created: task.createdAt });
      publish('session.tool.success', { ...base, content: [{ type: 'text', text: JSON.stringify({ task: event.properties.task }) }],
        metadata: {}, executed: false }, { created: task.startedAt ?? task.createdAt });
      const item = store.peekMessage(sessionID, messageID).content.findLast((candidate) => candidate.type === 'tool' && candidate.id === task.dispatchCallId);
      const part = toV1ToolPart(item, { messageID, sessionID });
      publishFixtureOnly(event);
      return structuredClone({ part, event });
    },
    removeManagedTaskVisual: task => {
      requireSession(task.rootSessionId);
      if (task.directory !== directory) throw new Error('Managed task visual removal must stay in the fixture directory');
      publishFixtureOnly(toManagedTaskRemovalEvent(task));
    },
    suppressMessageEvents: ({ sessionID, messageID, types, maximumEvents = 64, durationMs = 30_000 }) => {
      requireSession(sessionID);
      const row = store.peekMessage(sessionID, messageID);
      const allowed = ['message.updated', 'message.part.updated', 'message.part.delta', 'session.status'];
      if (row?.type !== 'assistant' || row.time?.completed || !runs.has(sessionID) || eventSuppression
        || !Array.isArray(types) || !types.length || new Set(types).size !== types.length
        || types.some(type => !allowed.includes(type)) || !Number.isSafeInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 128
        || !Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 30_000 || suppressionRuns.length >= 8) {
        throw new Error('Invalid or overlapping bounded fixture event suppression');
      }
      eventSuppression = { sessionID, messageID, types: [...types], maximumEvents, durationMs, startedAt: Date.now(),
        expiresAt: Date.now() + durationMs, suppressedCount: 0, endedReason: null };
      suppressionRuns.push(eventSuppression);
    },
    clearMessageEventSuppression: () => {
      if (eventSuppression) eventSuppression.endedReason = 'explicit-clear';
      eventSuppression = null;
    },
    getState: () => ({
      generation: 2,
      activeScenario,
      sseClientCount: sseClients.size,
      sseConnectionCount,
      statusRequestCount,
      suppressedEvents: structuredClone(suppressedEvents),
      suppressionRuns: structuredClone(suppressionRuns),
      messageRequestCounts: Object.fromEntries(messageRequestCounts),
      olderMessageRequestCounts: Object.fromEntries(olderMessageRequestCounts),
      messagePageRequests: structuredClone(messagePageRequests),
      textLengths: Object.fromEntries([...texts].map(([id, text]) => [id, text.length])),
      receivedPrompts: structuredClone(receivedPrompts),
      canonicalUserDelays: structuredClone(canonicalUserDelays),
      rejectedPrompts: structuredClone(rejectedPrompts),
      replies: structuredClone(replies),
      unknownRoutes: structuredClone(unknownRoutes),
      locationRequired: structuredClone(locationRequired),
      wireLosses: structuredClone(wireLosses),
      streamDrops: structuredClone(streamDrops),
      eventCounts: Object.fromEntries(eventCounts),
      permissionCount: permissions.size,
      questionCount: [...forms.values()].filter((form) => form.state.status === 'pending').length,
      executingSessions: [...executing],
      abortedPrompts,
      activePrompts: runs.size,
    }),
    disconnectEvents: () => {
      for (const [response, client] of sseClients) { clearInterval(client.heartbeat); response.end(); }
      sseClients.clear();
    },
    // Gen-2 extras.
    playSequence,
    dropEventStream,
    shutdownLocation: (targetDirectory = directory) => publish('location.shutdown', {}, { location: { directory: targetDirectory } }),
    setReady: (state) => {
      if (state?.ready === true) { readiness = { ready: true }; return; }
      if (!isRecord(state) || state.ready !== false || !['booting', 'migrating', 'catalog_mismatch', 'stopping'].includes(state.phase)
        || !Number.isSafeInteger(state.retryAfterMs) || state.retryAfterMs < 0) throw new Error('Invalid fixture readiness');
      readiness = { ready: false, phase: state.phase, retryAfterMs: state.retryAfterMs };
    },
    /** The stored 2.0.20 records (what REST serves), for oracle tests. */
    wireMessages: (sessionID) => store.messages(sessionID),
    wireSession: (sessionID) => store.session(sessionID),
  };

  // -------------------------------------------------------------------------
  // HTTP

  const authorized = (request, url) => {
    const expected = Buffer.from(authorization);
    const header = request.headers.authorization ?? '';
    const token = url.searchParams.get('auth_token');
    const candidate = Buffer.from(token ? `Basic ${token}` : header);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  };

  const readBody = async (request) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) return { error: 'too_large' };
    }
    if (!body) return { value: undefined };
    try {
      return { value: JSON.parse(body) };
    } catch {
      return { error: 'invalid_json' };
    }
  };

  const recordUnknown = (request, pathname, known) => {
    if (unknownRoutes.length < 100) unknownRoutes.push({ method: request.method, path: pathname, known });
  };

  const requestLocation = (request, url) => {
    const query = url.searchParams.get('location[directory]');
    if (query) return query;
    const header = request.headers['x-opencode-directory'];
    if (typeof header !== 'string' || !header) return null;
    try {
      return decodeURIComponent(header);
    } catch {
      return header;
    }
  };

  const pagedSessions = (url, response) => {
    let cursor = null;
    if (url.searchParams.has('cursor')) {
      cursor = decodeCursor(url.searchParams.get('cursor'));
      if (!cursor || !isRecord(cursor.anchor) || !['previous', 'next'].includes(cursor.anchor.direction)) {
        fail(response, 400, 'InvalidCursorError', 'Invalid session cursor'); return null;
      }
    }
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? DEFAULT_PAGE_SIZE : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) { invalidRequest(response, 'Invalid session limit', { kind: 'Query', field: 'limit' }); return null; }
    const filters = cursor ?? {
      ...(url.searchParams.has('directory') ? { directory: url.searchParams.get('directory') } : {}),
      ...(url.searchParams.has('parentID') ? { parentID: url.searchParams.get('parentID') } : {}),
      ...(url.searchParams.has('search') ? { search: url.searchParams.get('search') } : {}),
      order: url.searchParams.get('order') ?? 'desc',
    };
    if (!['asc', 'desc'].includes(filters.order ?? 'desc')) { invalidRequest(response, 'Invalid session order', { kind: 'Query', field: 'order' }); return null; }
    if (filters.parentID !== undefined && filters.parentID !== 'null' && !filters.parentID.startsWith('ses')) {
      invalidRequest(response, 'Invalid parentID', { kind: 'Query', field: 'parentID' }); return null;
    }
    const order = filters.order ?? 'desc';
    let listed = store.sessions().filter((session) => (filters.directory === undefined || session.location.directory === filters.directory)
      && (filters.parentID === undefined || (filters.parentID === 'null' ? !session.parentID : session.parentID === filters.parentID))
      && (filters.search === undefined || (session.title ?? '').toLowerCase().includes(String(filters.search).toLowerCase())));
    const compare = (left, right) => (right.time.updated - left.time.updated) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    listed.sort(order === 'desc' ? compare : (left, right) => compare(right, left));
    if (cursor) {
      const position = listed.findIndex((session) => session.id === cursor.anchor.id);
      const index = position >= 0 ? position : listed.findIndex((session) => (order === 'desc' ? session.time.updated < cursor.anchor.time : session.time.updated > cursor.anchor.time));
      if (cursor.anchor.direction === 'next') listed = index < 0 ? [] : listed.slice(position >= 0 ? index + 1 : index, (position >= 0 ? index + 1 : index) + limit);
      else listed = listed.slice(Math.max(0, (index < 0 ? listed.length : index) - limit), index < 0 ? listed.length : index);
    } else listed = listed.slice(0, limit);
    const anchor = (session, direction) => encodeCursor({ ...filters, order, anchor: { id: session.id, time: session.time.updated, direction } });
    return { data: listed, cursor: listed.length ? { previous: anchor(listed[0], 'previous'), next: anchor(listed.at(-1), 'next') } : { previous: null, next: null } };
  };

  const pagedMessages = (sessionID, url, response) => {
    const types = url.searchParams.getAll('type');
    if (types.length > 1 || types.some((type) => !MESSAGE_TYPES.has(type))) {
      invalidRequest(response, `Expected one of ${[...MESSAGE_TYPES].map((type) => `"${type}"`).join(' | ')}\n  at ["type"]`, { kind: 'Query' }); return null;
    }
    if (url.searchParams.has('cursor') && url.searchParams.has('order')) { fail(response, 400, 'InvalidCursorError', 'Cursor cannot be combined with order'); return null; }
    let cursor = null;
    if (url.searchParams.has('cursor')) {
      cursor = decodeCursor(url.searchParams.get('cursor'));
      if (!cursor || typeof cursor.id !== 'string' || !['asc', 'desc'].includes(cursor.order) || !['previous', 'next'].includes(cursor.direction)) {
        fail(response, 400, 'InvalidCursorError', 'Invalid message cursor'); return null;
      }
    }
    const order = cursor?.order ?? url.searchParams.get('order') ?? 'desc';
    if (!['asc', 'desc'].includes(order)) { invalidRequest(response, 'Invalid message order', { kind: 'Query', field: 'order' }); return null; }
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? DEFAULT_PAGE_SIZE : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) { invalidRequest(response, 'Invalid message limit', { kind: 'Query', field: 'limit' }); return null; }
    let listed = store.messages(sessionID).filter((record) => (types[0] === undefined ? true : record.type === types[0]));
    if (order === 'desc') listed.reverse();
    if (cursor) {
      const index = listed.findIndex((record) => record.id === cursor.id);
      if (index < 0) { fail(response, 400, 'InvalidCursorError', 'Unknown message cursor'); return null; }
      listed = cursor.direction === 'next' ? listed.slice(index + 1, index + 1 + limit) : listed.slice(Math.max(0, index - limit), index);
    } else listed = listed.slice(0, limit);
    messageRequestCounts.set(sessionID, (messageRequestCounts.get(sessionID) ?? 0) + 1);
    if (cursor) olderMessageRequestCounts.set(sessionID, (olderMessageRequestCounts.get(sessionID) ?? 0) + 1);
    if (messagePageRequests.length < 200) messagePageRequests.push({ sessionID, limit, order, type: types[0] ?? null, cursor: Boolean(cursor),
      returned: listed.length, firstMessageID: listed[0]?.id ?? null, lastMessageID: listed.at(-1)?.id ?? null });
    const anchor = (record, direction) => encodeCursor({ id: record.id, order, direction });
    return { data: listed, cursor: listed.length ? { previous: anchor(listed[0], 'previous'), next: anchor(listed.at(-1), 'next') } : { previous: null, next: null } };
  };

  const pendingForms = (predicate) => [...forms.values()].filter((form) => form.state.status === 'pending' && predicate(form.form)).map((form) => structuredClone(form.form));
  const locationOfForm = (form) => (form.sessionID === 'global' ? null : sessionDirectory(form.sessionID));

  /**
   * Admits a prompt (or an expanded command) into the inbox and schedules delivery.
   * @returns {{ status: number, body: Record<string, unknown> }}
   */
  const admitPrompt = (sessionID, body, request) => {
    const behavior = promptBehaviors.get(sessionID) ?? DEFAULT_BEHAVIOR;
    promptBehaviors.delete(sessionID);
    if (behavior.rejectStatus !== undefined) {
      rejectedPrompts.push({ sessionID, messageID: body.id ?? null, status: behavior.rejectStatus });
      const tag = behavior.rejectStatus === 400 ? 'InvalidRequestError' : behavior.rejectStatus === 409 ? 'ConflictError' : 'UnknownError';
      return { status: behavior.rejectStatus, body: { _tag: tag, message: 'Configured QA prompt rejection' } };
    }
    const header = request.headers['x-openchamber-message-id'];
    const id = body.id ?? (typeof header === 'string' && header.startsWith('msg_') ? header : ids.ascending('msg'));
    if (store.messages(sessionID).some((record) => record.id === id) || store.inbox(sessionID).some((item) => item.id === id)) {
      rejectedPrompts.push({ sessionID, messageID: id, status: 409 });
      return { status: 409, body: { _tag: 'ConflictError', resource: id, message: 'Duplicate message ID' } };
    }
    const files = (body.files ?? []).map((file) => toWireFileAttachment({ url: file.uri, filename: file.name }).attachment);
    const payload = { text: body.text, ...(files.length ? { files } : {}), ...(body.agents?.length ? { agents: structuredClone(body.agents) } : {}),
      ...(isRecord(body.metadata) ? { metadata: structuredClone(body.metadata) } : {}) };
    const devryan = isRecord(body.metadata?.devryan) ? body.metadata.devryan : {};
    const selection = userSelection(sessionID, { metadata: body.metadata });
    receivedPrompts.push({ sessionID, messageID: id,
      partTypes: [...(Array.isArray(devryan.parts) ? devryan.parts.map(() => 'text') : (body.text ? ['text'] : [])), ...files.map(() => 'file'), ...(body.agents ?? []).map(() => 'agent')],
      model: structuredClone(selection.model), agent: selection.agent, delivery: body.delivery ?? 'steer',
      ...(Object.hasOwn(devryan, 'variant') ? { variant: devryan.variant } : {}),
      ...(Object.hasOwn(devryan, 'planMode') ? { planMode: devryan.planMode } : {}) });
    const enqueued = publish('session.inbox.enqueued', { sessionID, inboxID: id, item: { type: 'user', payload, delivery: body.delivery ?? 'steer' } });
    inboxBehaviors.set(id, behavior);
    if (body.resume === false) deferredInbox.add(id);
    return { status: 200, body: { data: { id, sessionID, time: { created: enqueued.created }, type: 'user', payload, delivery: body.delivery ?? 'steer' } } };
  };

  /** One handler per `METHOD template`. Each returns after answering. */
  const handlers = {
    'GET /api/info': ({ response }) => json(response, 200, { version: opencodeVersion, pid: process.pid, urls: [origin], paths: { tmp: os.tmpdir() } }),
    'GET /api/location': ({ response, location }) => json(response, 200, { directory: location, project: { id: PROJECT_ID, directory: location, canonical: location } }),
    'POST /api/location/reload': ({ response, location }) => { noContent(response); publish('location.shutdown', {}, { location: { directory: location } }); },
    'GET /api/agent': ({ response, location }) => json(response, 200, { location: { directory: location }, data: structuredClone(agents) }),
    'GET /api/agent/{agentID}': ({ response, location, params }) => {
      const agent = agents.find((candidate) => candidate.id === params.agentID);
      if (!agent) return fail(response, 404, 'AgentNotFoundError', `Agent not found: ${params.agentID}`, { agentID: params.agentID });
      json(response, 200, { location: { directory: location }, data: structuredClone(agent) });
    },
    'GET /api/provider': ({ response, location }) => json(response, 200, { location: { directory: location }, data: structuredClone(providers) }),
    'GET /api/provider/{providerID}': ({ response, location, params }) => {
      const provider = providers.find((candidate) => candidate.id === params.providerID);
      if (!provider) return fail(response, 404, 'ProviderNotFoundError', `Provider not found: ${params.providerID}`, { providerID: params.providerID });
      json(response, 200, { location: { directory: location }, data: structuredClone(provider) });
    },
    'GET /api/model': ({ response, location }) => json(response, 200, { location: { directory: location }, data: structuredClone(models) }),
    'GET /api/model/default': ({ response, location }) => json(response, 200, { location: { directory: location },
      data: structuredClone(models.find((model) => model.id === DEFAULT_MODEL.id) ?? models[0] ?? null) }),
    'GET /api/integration': ({ response, location }) => json(response, 200, { location: { directory: location }, data: structuredClone(integrations) }),
    'GET /api/command': ({ response, location }) => json(response, 200, { location: { directory: location }, data: structuredClone(commandCatalog) }),
    'GET /api/skill': ({ response, location }) => json(response, 200, { location: { directory: location }, data: [] }),
    'GET /api/mcp': ({ response, location }) => json(response, 200, { location: { directory: location }, data: [] }),
    'GET /api/config': ({ response }) => json(response, 200, [{ type: 'document',
      info: { model: { providerID: DEFAULT_MODEL.providerID, model: DEFAULT_MODEL.id }, snapshots: false, share: 'disabled', update: 'disable' } }]),
    // `GET /api/project` is not location-scoped in 2.0.20: it lists the fixture's one project.
    'GET /api/project': ({ response }) => json(response, 200, [{ id: PROJECT_ID, canonical: directory, vcs: 'git',
      time: { created: FIXED_CREATED_AT, updated: FIXED_CREATED_AT, active: FIXED_CREATED_AT }, sandboxes: [] }]),
    'GET /api/vcs': ({ response, location }) => json(response, 200, { location: { directory: location }, data: { provider: 'git', branch: { current: 'perf-fixture' } } }),
    'GET /api/form': ({ response, location }) => json(response, 200, { location: { directory: location },
      data: pendingForms((form) => locationOfForm(form) === null || locationOfForm(form) === location) }),
    'GET /api/permission/request': ({ response, location }) => json(response, 200, { location: { directory: location },
      data: [...permissions.values()].filter((request) => sessionDirectory(request.sessionID) === location).map((request) => structuredClone(request)) }),
    'GET /api/event': ({ request, response }) => openEventStream(request, response),
    'GET /api/session': ({ response, url }) => { const page = pagedSessions(url, response); if (page) json(response, 200, page); },
    'POST /api/session': ({ response, body, location }) => {
      if (body.id && store.has(body.id)) return json(response, 200, { data: store.session(body.id) });
      const sessionID = createSessionRecord({ id: body.id ?? undefined, title: body.title ?? undefined, agent: body.agent ?? undefined,
        model: body.model ?? undefined, metadata: body.metadata ?? undefined, permissions: body.permissions ?? undefined, location });
      json(response, 200, { data: store.session(sessionID) });
    },
    'GET /api/session/active': ({ response }) => {
      statusRequestCount += 1;
      json(response, 200, { data: Object.fromEntries([...executing].map((id) => [id, { type: 'running' }])) });
    },
    'GET /api/session/{sessionID}': ({ response, sessionID }) => json(response, 200, { data: store.session(sessionID) }),
    'PATCH /api/session/{sessionID}': ({ response, sessionID, body }) => {
      if (typeof body.title === 'string') publish('session.renamed', { sessionID, title: body.title });
      if (isRecord(body.metadata)) publish('session.metadata.updated', { sessionID, metadata: body.metadata });
      if (Array.isArray(body.permissions)) publish('session.permissions', { sessionID, permissions: body.permissions });
      noContent(response);
    },
    'DELETE /api/session/{sessionID}': ({ response, sessionID }) => {
      const run = runs.get(sessionID);
      if (run) settleRun(run, { kind: 'silent' });
      for (const id of store.inbox(sessionID).map((item) => item.id)) {
        clearTimeout(delayedDeliveries.get(id)); delayedDeliveries.delete(id); deliveringInbox.delete(id);
      }
      promptBehaviors.delete(sessionID);
      publish('session.deleted', { sessionID });
      noContent(response);
    },
    'POST /api/session/{sessionID}/fork': ({ response, sessionID, body }) => {
      const messages = store.messages(sessionID);
      if (body.before && !messages.some((record) => record.id === body.before)) {
        return fail(response, 404, 'MessageNotFoundError', `Message not found: ${body.before}`, { sessionID, messageID: body.before });
      }
      if (!body.before && messages.length === 0) return invalidRequest(response, 'Session has no messages to fork');
      const forkID = ids.descending('ses');
      publish('session.forked', { sessionID: forkID, parentID: sessionID,
        boundary: body.before ? { type: 'before', messageID: body.before } : { type: 'through', messageID: messages.at(-1).id } });
      json(response, 200, { data: store.session(forkID) });
    },
    'POST /api/session/{sessionID}/agent': ({ response, sessionID, body }) => { publish('session.agent.selected', { sessionID, agent: body.agent }); noContent(response); },
    'POST /api/session/{sessionID}/model': ({ response, sessionID, body }) => { publish('session.model.selected', { sessionID, model: body.model }); noContent(response); },
    'POST /api/session/{sessionID}/prompt': ({ request, response, sessionID, body }) => {
      const result = admitPrompt(sessionID, body, request);
      json(response, result.status, result.body);
      if (result.status === 200) scheduleInbox(sessionID);
    },
    'POST /api/session/{sessionID}/command': ({ request, response, sessionID, body }) => {
      if (!commandCatalog.some((command) => command.name === body.name)) {
        return fail(response, 404, 'CommandNotFoundError', `Command not found: ${body.name}`, { command: body.name });
      }
      // Fixture-only expansion: the command runs as a prompt whose text names the command.
      const forwarded = { text: `/${body.name}${body.text ? ` ${body.text}` : ''}`, ...(body.files ? { files: body.files } : {}),
        ...(body.agents ? { agents: body.agents } : {}), ...(body.delivery ? { delivery: body.delivery } : {}) };
      const result = admitPrompt(sessionID, forwarded, request);
      if (result.status !== 200) return json(response, result.status, result.body);
      noContent(response);
      scheduleInbox(sessionID);
    },
    'POST /api/session/{sessionID}/compact': ({ response, sessionID, body }) => {
      if (runs.has(sessionID) || executing.has(sessionID)) return fail(response, 409, 'ConflictError', 'Session is busy', { resource: sessionID });
      const id = body.id ?? ids.ascending('msg');
      const session = store.session(sessionID);
      const enqueued = publish('session.inbox.enqueued', { sessionID, inboxID: id, item: { type: 'compaction', payload: {}, delivery: body.delivery ?? 'steer' } });
      json(response, 200, { data: { id, sessionID, time: { created: enqueued.created }, type: 'compaction', payload: {}, delivery: body.delivery ?? 'steer' } });
      const text = '## Objective\nFixture compaction.\n\n## Next Move\nWait for the next prompt.';
      publish('session.execution.started', { sessionID });
      publish('session.inbox.delivered', { sessionID, inboxID: id });
      publish('session.compaction.started', { sessionID, reason: 'manual', recent: '', inputID: id });
      publish('session.compaction.delta', { sessionID, text });
      publish('session.compaction.ended', { sessionID, reason: 'manual', model: structuredClone(session.model ?? DEFAULT_MODEL), text, recent: '', cost: 0, tokens: zeroTokens() });
      publish('session.execution.succeeded', { sessionID });
    },
    'POST /api/session/{sessionID}/interrupt': ({ response, sessionID }) => {
      const run = runs.get(sessionID);
      if (run) {
        abortedPrompts += 1;
        cancelInteractions(sessionID);
        settleRun(run, { kind: 'interrupt' });
        return json(response, 200, { interrupted: true });
      }
      if (executing.has(sessionID)) {
        cancelInteractions(sessionID);
        publish('session.execution.interrupted', { sessionID, reason: 'user' });
        return json(response, 200, { interrupted: true });
      }
      json(response, 200, { interrupted: false });
    },
    'POST /api/session/{sessionID}/synthetic': ({ response, sessionID, body }) => {
      const id = body.id ?? ids.ascending('msg');
      const payload = { text: body.text, ...(body.description ? { description: body.description } : {}), ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}) };
      const delivery = body.delivery ?? 'steer';
      const enqueued = publish('session.inbox.enqueued', { sessionID, inboxID: id, item: { type: 'synthetic', payload, delivery } });
      if (body.resume === false) deferredInbox.add(id);
      else inboxBehaviors.set(id, promptBehaviors.get(sessionID) ?? validatePromptOptions({ chunks: 1, intervalMs: 10 }));
      promptBehaviors.delete(sessionID);
      json(response, 200, { data: { id, sessionID, time: { created: enqueued.created }, type: 'synthetic', payload, delivery } });
      scheduleInbox(sessionID);
    },
    'POST /api/session/{sessionID}/revert/stage': ({ response, sessionID, body }) => {
      if (!store.messages(sessionID).some((record) => record.id === body.messageID)) {
        return fail(response, 404, 'MessageNotFoundError', `Message not found: ${body.messageID}`, { sessionID, messageID: body.messageID });
      }
      if (executing.has(sessionID)) return fail(response, 409, 'SessionBusyError', 'Session is busy', { sessionID });
      const revert = { messageID: body.messageID, files: [] };
      publish('session.revert.staged', { sessionID, revert });
      json(response, 200, { data: revert });
    },
    'POST /api/session/{sessionID}/revert/commit': ({ response, sessionID }) => {
      if (executing.has(sessionID)) return fail(response, 409, 'SessionBusyError', 'Session is busy', { sessionID });
      const revert = store.session(sessionID).revert;
      if (!revert) return invalidRequest(response, 'No staged revert');
      publish('session.revert.committed', { sessionID, to: revert.messageID });
      noContent(response);
    },
    'DELETE /api/session/{sessionID}/revert': ({ response, sessionID }) => {
      if (executing.has(sessionID)) return fail(response, 409, 'SessionBusyError', 'Session is busy', { sessionID });
      publish('session.revert.cleared', { sessionID });
      noContent(response);
      // 2.0.20 follows a clear with an empty execution (08-revert.json).
      publish('session.execution.started', { sessionID });
      publish('session.execution.succeeded', { sessionID });
    },
    'GET /api/session/{sessionID}/message': ({ response, sessionID, url }) => { const page = pagedMessages(sessionID, url, response); if (page) json(response, 200, page); },
    'GET /api/session/{sessionID}/message/{messageID}': ({ response, sessionID, params }) => {
      const record = store.messages(sessionID).find((candidate) => candidate.id === params.messageID);
      if (!record) return fail(response, 404, 'MessageNotFoundError', `Message not found: ${params.messageID}`, { sessionID, messageID: params.messageID });
      json(response, 200, { data: record });
    },
    // F8: with snapshots:false 2.0.20 returns no file diffs.
    'GET /api/session/{sessionID}/diff': ({ response }) => json(response, 200, { data: [] }),
    'GET /api/session/{sessionID}/inbox': ({ response, sessionID }) => json(response, 200, { data: store.inbox(sessionID) }),
    'GET /api/session/{sessionID}/form': ({ response, sessionID }) => json(response, 200, { data: pendingForms((form) => form.sessionID === sessionID) }),
    'GET /api/session/{sessionID}/form/{formID}': ({ response, sessionID, params }) => {
      const form = forms.get(params.formID);
      if (!form || form.form.sessionID !== sessionID) return fail(response, 404, 'FormNotFoundError', `Form not found: ${params.formID}`, { id: params.formID });
      json(response, 200, { data: { ...structuredClone(form.form), state: structuredClone(form.state) } });
    },
    'POST /api/session/{sessionID}/form/{formID}/reply': ({ response, sessionID, params, body }) => {
      const form = forms.get(params.formID);
      if (!form || form.form.sessionID !== sessionID) return fail(response, 404, 'FormNotFoundError', `Form not found: ${params.formID}`, { id: params.formID });
      if (form.state.status !== 'pending') return fail(response, 409, 'FormAlreadySettledError', `Form already settled: ${params.formID}`, { id: params.formID });
      const keys = new Set(form.form.fields.map((field) => field.key));
      if (Object.keys(body.answer).some((key) => !keys.has(key))) return fail(response, 400, 'FormInvalidAnswerError', 'Unknown form field', { id: params.formID });
      publish('form.replied', { id: params.formID, sessionID, answer: body.answer });
      replies.push({ type: 'question', sessionID, requestID: params.formID,
        answers: form.form.fields.map((field) => { const value = body.answer[field.key]; return value === undefined ? [] : Array.isArray(value) ? [...value] : [String(value)]; }),
        answer: structuredClone(body.answer) });
      noContent(response);
    },
    'DELETE /api/session/{sessionID}/form/{formID}': ({ response, sessionID, params }) => {
      const form = forms.get(params.formID);
      if (!form || form.form.sessionID !== sessionID) return fail(response, 404, 'FormNotFoundError', `Form not found: ${params.formID}`, { id: params.formID });
      if (form.state.status !== 'pending') return fail(response, 409, 'FormAlreadySettledError', `Form already settled: ${params.formID}`, { id: params.formID });
      publish('form.cancelled', { id: params.formID, sessionID });
      replies.push({ type: 'question', sessionID, requestID: params.formID });
      noContent(response);
      const run = runs.get(sessionID);
      if (run && form.form.metadata?.kind === 'question') settleRun(run, { kind: 'dismissed' });
    },
    'GET /api/session/{sessionID}/permission': ({ response, sessionID }) => json(response, 200, {
      data: [...permissions.values()].filter((request) => request.sessionID === sessionID).map((request) => structuredClone(request)) }),
    'GET /api/session/{sessionID}/permission/{requestID}': ({ response, sessionID, params }) => {
      const request = permissions.get(params.requestID);
      if (!request || request.sessionID !== sessionID) return fail(response, 404, 'PermissionNotFoundError', `Permission not found: ${params.requestID}`, { requestID: params.requestID });
      json(response, 200, { data: structuredClone(request) });
    },
    'POST /api/session/{sessionID}/permission/{requestID}/reply': ({ response, sessionID, params, body }) => {
      const pending = permissions.get(params.requestID);
      if (!pending || pending.sessionID !== sessionID) return fail(response, 404, 'PermissionNotFoundError', `Permission not found: ${params.requestID}`, { requestID: params.requestID });
      publish('permission.replied', { sessionID, requestID: params.requestID, reply: body.decision });
      replies.push({ type: 'permission', sessionID, requestID: params.requestID, reply: body.decision });
      noContent(response);
      const run = runs.get(sessionID);
      if (body.decision === 'reject' && run) settleRun(run, { kind: 'permission-rejected', message: body.message ?? undefined });
    },
  };

  // FIXTURE-ONLY: plausible /devryan/* host routes (DESIGN C.6) until Phase 3 defines them.
  const FIXTURE_ONLY = { 'x-devryan-fixture-only': 'true' };
  const handleDevryan = async (request, response, url) => {
    const pathname = url.pathname;
    if (pathname === '/devryan/ready' && request.method === 'GET') {
      if (!readiness.ready) return json(response, 503, { ready: false, phase: readiness.phase, retryAfterMs: readiness.retryAfterMs }, FIXTURE_ONLY);
      return json(response, 200, { ready: true, generation: 2, opencode: { version: opencodeVersion },
        host: { version: '0.0.0-fixture', buildId: 'loopback-opencode-v2-fixture' }, migration: { v1: 'not-needed' }, catalog: { asserted: true } }, FIXTURE_ONLY);
    }
    if (pathname === '/devryan/tools' && request.method === 'GET') {
      if (!url.searchParams.get('directory')) {
        locationRequired.push({ method: request.method, path: pathname });
        return invalidRequest(response, 'location_required', { kind: 'Location', field: 'directory' });
      }
      return json(response, 200, { ids: [...toolIDs], definitions: toolIDs.map((id) => ({ id, description: `Fixture ${id} tool`,
        parameters: { type: 'object', properties: {}, additionalProperties: true } })) }, FIXTURE_ONLY);
    }
    if (pathname === '/devryan/session/revert-capabilities' && request.method === 'GET') {
      return json(response, 200, { data: { stage: true, commit: true, clear: true, scoped: false, files: false } }, FIXTURE_ONLY);
    }
    const parsed = request.method === 'POST' ? await readBody(request) : { value: undefined };
    if (parsed.error) return invalidRequest(response, parsed.error, { kind: 'Body' });
    const body = parsed.value ?? {};
    if (!isRecord(body)) return invalidRequest(response, 'object required', { kind: 'Body' });
    if (pathname === '/devryan/session/retention-control' && request.method === 'POST') {
      return json(response, 200, { data: { accepted: true } }, FIXTURE_ONLY);
    }
    if (pathname === '/devryan/session' && request.method === 'POST') {
      if (!isNonEmptyString(body.parentID) || !store.has(body.parentID)) return sessionNotFound(response, String(body.parentID ?? ''));
      if (body.id !== undefined && (typeof body.id !== 'string' || !body.id.startsWith('ses'))) return invalidRequest(response, 'Invalid session id', { kind: 'Body', field: 'id' });
      if (body.id && store.has(body.id)) return json(response, 200, { data: store.session(body.id) }, FIXTURE_ONLY);
      const parent = store.session(body.parentID);
      const sessionID = createSessionRecord({ id: body.id, parentID: body.parentID, title: typeof body.title === 'string' ? body.title : undefined,
        agent: typeof body.agent === 'string' ? body.agent : undefined, model: isRecord(body.model) ? body.model : undefined,
        metadata: isRecord(body.metadata) ? body.metadata : parent.metadata, permissions: Array.isArray(body.permissions) ? body.permissions : undefined,
        location: typeof body.location?.directory === 'string' ? body.location.directory : parent.location.directory });
      return json(response, 200, { data: store.session(sessionID) }, FIXTURE_ONLY);
    }
    const external = /^\/devryan\/session\/([^/]+)\/external-message$/.exec(pathname);
    if (external && request.method === 'POST') {
      const sessionID = decodeURIComponent(external[1]);
      if (!store.has(sessionID)) return sessionNotFound(response, sessionID);
      const message = body.message;
      if (!isRecord(message) || typeof message.id !== 'string' || !message.id.startsWith('msg_') || !['user', 'synthetic', 'assistant'].includes(message.type)) {
        return invalidRequest(response, 'message must be a Session.Message.Info user, synthetic or assistant record', { kind: 'Body', field: 'message' });
      }
      store.appendMessages(sessionID, [message]);
      return json(response, 200, { data: { id: message.id } }, FIXTURE_ONLY);
    }
    recordUnknown(request, pathname, false);
    return json(response, 404, { _tag: 'RouteNotFound', message: 'Unsupported fixture route', method: request.method, path: pathname });
  };

  const handleRequest = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!authorized(request, url)) {
      return json(response, 401, { _tag: 'UnauthorizedError', message: UNAUTHORIZED_MESSAGE }, { 'www-authenticate': WWW_AUTHENTICATE });
    }
    if (url.pathname.startsWith('/devryan/')) return handleDevryan(request, response, url);
    if (url.pathname === '/openapi.json' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(openapiText);
    }
    const match = matchOpenCodeV2Route(request.method, request.url ?? '/');
    if (!match.ok) {
      recordUnknown(request, url.pathname, false);
      return json(response, 404, { _tag: 'RouteNotFound', message: 'Unsupported fixture route', method: request.method, path: url.pathname });
    }
    const key = `${match.route.method} ${match.route.template}`;
    const handler = handlers[key];
    if (!handler) {
      recordUnknown(request, url.pathname, true);
      return json(response, 404, { _tag: 'RouteNotFound', message: 'Unsupported fixture route', method: request.method, path: url.pathname });
    }
    let body = {};
    const requestSchema = openApiRequestSchema(openapi, match.route.method, match.route.template);
    if (requestSchema) {
      const parsed = await readBody(request);
      if (parsed.error) return invalidRequest(response, parsed.error === 'too_large' ? 'Request body too large' : 'Invalid JSON body', { kind: 'Body' });
      if (parsed.value === undefined && requestSchema.required) return invalidRequest(response, 'Request body required', { kind: 'Body' });
      if (parsed.value !== undefined) {
        const error = checkOpenApiValue(requestSchema.schema, parsed.value, schemaContext);
        if (error) return invalidRequest(response, error, { kind: 'Body' });
        body = parsed.value;
      }
    }
    let location = null;
    if (match.route.location === 'header' || match.route.location === 'body-location') {
      location = requestLocation(request, url) ?? (match.route.location === 'body-location' ? body.location?.directory ?? null : null);
      if (!location) {
        locationRequired.push({ method: request.method, path: url.pathname });
        return invalidRequest(response, 'location_required', { kind: 'Location', field: 'x-opencode-directory' });
      }
      if (!path.isAbsolute(location)) return invalidRequest(response, 'location_invalid', { kind: 'Location', field: 'x-opencode-directory' });
      touchLocation(location);
    }
    const sessionID = match.params.sessionID;
    if (sessionID !== undefined && !store.has(sessionID)) return sessionNotFound(response, sessionID);
    return handler({ request, response, url, params: match.params, body, location, sessionID });
  };

  const server = http.createServer((request, response) => {
    void Promise.resolve().then(() => handleRequest(request, response)).catch((error) => {
      if (!response.headersSent) json(response, 500, { _tag: 'UnknownError', message: error instanceof Error ? error.message : 'Fixture failure' });
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback OpenCode v2 fixture did not bind a TCP port');
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    generation: 2,
    directory,
    password,
    authHeaders: Object.freeze({ authorization }),
    ...controls,
    close: async () => {
      stopScenario({ settle: false });
      for (const run of runs.values()) clearInterval(run.timer);
      runs.clear();
      for (const timer of delayedDeliveries.values()) clearTimeout(timer);
      delayedDeliveries.clear();
      for (const [response, client] of sseClients) { clearInterval(client.heartbeat); response.end(); }
      sseClients.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
};
