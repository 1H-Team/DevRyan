import { isNativeStatusRecord, isNativeTurnParent } from '../../../../../../shared-runtime/lib/native-message-status.js';
// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) live event projector: one v2 `/api/event` envelope ->
// 0..n v1 event payloads (DESIGN.md B.4). Gen 1 never constructs a projector:
// its payloads pass through the hub unchanged (see
// {@link createEventProjectorForGeneration}).
//
// Envelope:  directory = location.directory, else the session's cached
//            directory, else 'global'. payload = {id, type, properties}. The
//            k-th extra payload projected from one upstream event gets the
//            event id `${id}#k` (k >= 1); the first keeps the upstream id.
//
// State (caps in `EVENT_PROJECTOR_LIMITS`):
//   per session (LRU)   folded Session.Info, slug, directory, status, lastUser,
//                       known message ids in seq order, user index, pending
//                       inbox items, the running agent/model fold
//   per active assistant {agent, model, parentID, created, announced part ids}
//   per active tool     the v2-shaped tool item {id, name, state, time}
// An assistant leaves the active set at `step.ended`/`step.failed`; a tool at
// `tool.success`/`tool.failed`; everything active is cleared at the execution
// terminal. Evicting a session, assistant, tool or inbox entry records a
// diagnostic; evicting an assistant or a tool also marks the session cold (an
// evicted session simply returns cold). Trimming the known-message-id window
// and evicting an inbox entry only record the diagnostic: a newest-page reseed
// cannot restore either, and a revert to a trimmed id still gaps. A cold session
// is reseeded in the background on its next event.
//
// First-sight rule: deltas can precede their durable `*.started` events. The
// first event for an unknown assistant emits a minimal `message.updated` whose
// parent is a guess; the durable `step.started` re-derives the parent (the
// delivery of a steered prompt may only arrive after the first delta) and
// completes the info. The first delta of an unknown part emits a
// `message.part.updated` with empty text and the right type. The durable
// `started` is then a no-op. Delta `field` is always 'text' (the UI's
// provisional-part path requires it). Compaction deltas that precede their
// `compaction.started` are buffered (bounded) and become the summary text the
// started pair announces, because the auto compaction id is only known from the
// started event id.
//
// No-op suppression: synthesized `session.updated` is emitted only when a
// UI-relevant field changes (title, archived, revert, parentID, agent, model,
// directory) and `session.status` only when the status changes.
//
// The projector never awaits. Work that needs I/O (session, message or
// history seeds, `/api/session/active` reconciliation, cancelling an
// unanswerable form, a global gap broadcast) is queued as a reseed request;
// the hub drains the queue (`takeReseedRequests`) on its bounded task runner
// and feeds results back through the `apply*` methods, which return payloads
// to publish. Seed-emitted payloads carry no upstream id (the hub assigns one).
//
// The live path reuses the REST projection (messages.js, sessions.js,
// tools.js), so a live fold of the payloads equals the projected REST page
// except for text part end times (LOSS(text-time)) and synthetic rows, which
// the REST page folds into the next user record (LOSS(live-synthetic-fold)).
// ---------------------------------------------------------------------------

import { toV1Error, toV1InterruptError } from './errors.js';
import {
  assistantReasoningPartId,
  assistantTextPartId,
  assistantToolPartId,
  clampIncreasingTime,
  compactionSummaryMessageId,
  stepFinishPartId,
  stepStartPartId,
} from './ids.js';
import {
  classifyForm,
  toV1PermissionReplied,
  toV1PermissionRequest,
  toV1QuestionRejected,
  toV1QuestionReplied,
} from './interaction.js';
import {
  addUserIndexEntry,
  buildUserIndex,
  compactionSummaryTextPartId,
  findIndexedParentID,
  projectMessagePage,
  readDevryanPromptSelection,
  toV1AssistantInfo,
  toV1AssistantParts,
  toV1CompactionRecords,
  toV1PathInfo,
  toV1Tokens,
  turnSummaryDiffs,
} from './messages.js';
import { readSessionTodo, toV1Session } from './sessions.js';
import {
  BUSY_STATUS,
  IDLE_STATUS,
  isSameStatus,
  reconcileActiveStatuses,
  toV1RetryStatus,
} from './status.js';
import { toV1ToolPart } from './tools.js';

/** Default memory caps (B.4). */
export const EVENT_PROJECTOR_LIMITS = Object.freeze({
  sessions: 1024,
  assistantsPerSession: 64,
  toolsPerSession: 512,
  knownMessagesPerSession: 2000,
  userIndexPerSession: 2000,
  inboxPerSession: 256,
  interactions: 1024,
  reseedQueue: 1024,
  /** UTF-16 code units of compaction summary text buffered before its `compaction.started`. */
  compactionBuffer: 262144,
});

/** Shared result for events with no v1 counterpart. Never mutate. */
export const EMPTY_PROJECTION = Object.freeze([]);

/** Diagnostic codes the projector records. */
export const EVENT_PROJECTOR_DIAGNOSTICS = Object.freeze({
  evicted: 'opencode_v2_projector_evicted',
  nativeStatus: 'opencode_v2_native_status_ignored',
  unprojected: 'opencode_v2_event_unprojected',
  malformed: 'opencode_v2_event_malformed',
  failed: 'opencode_v2_projection_failed',
  reseedDropped: 'opencode_v2_reseed_dropped',
  revertTargetUnknown: 'opencode_v2_revert_target_unknown',
  compactionUnknown: 'opencode_v2_compaction_unknown',
  form: 'opencode_v2_form_unsupported',
});

/**
 * @typedef {object} ProjectedEvent
 * @property {string | undefined} eventId hub event id (`evt_…`, `evt_…#k`), undefined for seeds
 * @property {string} directory
 * @property {{ id?: string, type: string, properties: Record<string, unknown> }} payload
 */

/**
 * @typedef {{ kind: 'session', sessionID: string, reason: string }
 *   | { kind: 'history', sessionID: string, reason: string }
 *   | { kind: 'message', sessionID: string, messageID: string, reason: string }
 *   | { kind: 'active', reason: string }
 *   | { kind: 'form-cancel', sessionID: string, formID: string, reason: string }
 *   | { kind: 'gap', scope: 'global', sessionID?: string, reason: string }} ReseedRequest
 *
 * What the hub does for each kind, on its bounded task runner:
 *   session      GET /api/session/:id                  -> applySession(sessionID, data | null)
 *   history      GET …/message?order=desc&limit (seq)  -> applyHistory(sessionID, rows in seq order)
 *   message      GET …/message/:mid                    -> applyMessage(sessionID, row | null)
 *   active       GET /api/session/active, then for each listed session the newest
 *                rows (GET …/message?order=desc&limit, reversed to seq order) through
 *                status.js `retryStatusFromMessages` (B.3: retry is recovered from the
 *                latest assistant)                      -> applyActive(body, retryBySession)
 *   form-cancel  DELETE /api/session/:sid/form/:id     (no feedback)
 *   gap          broadcast {type:'gap', scope:'global'} to WebSocket clients
 * A failed fetch is reported with `reseedFailed(request)` so the next event retries it.
 * A request dropped because the queue is full is never handed out; the session's
 * next event asks for it again.
 */

/**
 * @typedef {object} EventProjectorOptions
 * @property {(diagnostic: Record<string, unknown>) => void} [recordDiagnostic]
 * @property {() => void} [onReseedRequested] called synchronously (never awaited) when a
 *   request is queued; the hub schedules a drain on its task runner
 * @property {() => number} [now] clock for seed payload times
 * @property {Partial<typeof EVENT_PROJECTOR_LIMITS>} [limits]
 * @property {import('./errors.js').ToV1ErrorOptions} [errorOptions]
 */

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const EMPTY_DATA = Object.freeze({});

const TEXT_FIELD = 'text';

/** Events with no v1 counterpart that are dropped without a diagnostic. */
const DROPPED_TYPES = new Set([
  'session.viewed',
  'session.step.streamed',
  'session.tool.input.delta',
  'session.instructions.updated',
  'session.skill.activated',
  'session.synthetic',
  'session.shell.started',
  'session.shell.ended',
  'session.inbox.delivery.changed',
  'session.usage.recorded',
  'worktree.resolved',
  'integration.updated',
  'provider.updated',
  'model.updated',
  'agent.updated',
  'command.updated',
  'skill.updated',
  'websearch.updated',
  'reference.updated',
  'plugin.updated',
  'mcp.tools.changed',
  'mcp.resources.changed',
]);

/** Events forwarded with their data as the v1 properties. */
const PASS_THROUGH_TYPES = new Set([
  'server.connected',
  'vcs.branch.updated',
  'mcp.status.changed',
  'installation.updated',
  'installation.update-available',
]);

const NATIVE_STATUS_TYPES = new Set(['session.status', 'session.idle']);

// ---------------------------------------------------------------------------
// Payload emission
// ---------------------------------------------------------------------------

/**
 * @typedef {object} EmitContext
 * @property {string | undefined} eventId
 * @property {number} created envelope `created` (or the clock for seeds)
 * @property {string | undefined} envelopeDirectory
 * @property {string} directory
 * @property {ProjectedEvent[] | null} list
 * @property {unknown} [metadata] Original upstream event metadata.
 */

/** @param {EmitContext} ctx @param {string} type @param {Record<string, unknown>} properties */
const emit = (ctx, type, properties) => {
  let list = ctx.list;
  if (list === null) {
    list = [];
    ctx.list = list;
  }
  const index = list.length;
  if (ctx.eventId === undefined) {
    list.push({ eventId: undefined, directory: ctx.directory, payload: { type, properties } });
    return;
  }
  const eventId = index === 0 ? ctx.eventId : `${ctx.eventId}#${index}`;
  list.push({ eventId, directory: ctx.directory, payload: { id: eventId, type, properties } });
};

// ---------------------------------------------------------------------------
// Session signature (no-op suppression)
// ---------------------------------------------------------------------------

const sessionSignature = (info) => {
  const time = isRecord(info.time) ? info.time : EMPTY_DATA;
  const revert = isRecord(info.revert) ? info.revert : EMPTY_DATA;
  const model = isRecord(info.model) ? info.model : EMPTY_DATA;
  return [
    info.title,
    time.archived,
    revert.messageID,
    revert.partID,
    revert.snapshot,
    info.parentID,
    info.agent,
    model.providerID,
    model.id,
    model.variant,
    info.directory,
  ];
};

const sameSignature = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const toModelRef = (model) => {
  if (!isRecord(model) || typeof model.id !== 'string' || typeof model.providerID !== 'string') return undefined;
  return model;
};

// ---------------------------------------------------------------------------
// The projector
// ---------------------------------------------------------------------------

/**
 * Creates a gen-2 event projector. All state is in memory and bounded.
 * @param {EventProjectorOptions} [options]
 */
export function createEventProjector(options = {}) {
  const limits = { ...EVENT_PROJECTOR_LIMITS, ...(isRecord(options.limits) ? options.limits : {}) };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const errorOptions = isRecord(options.errorOptions) ? options.errorOptions : undefined;

  /** @type {Map<string, ReturnType<typeof createSessionState>>} LRU: oldest first. */
  const sessions = new Map();
  let lastTouched = null;
  /** @type {Map<string, string>} permission id -> session id */
  const permissionSession = new Map();
  /** @type {Map<string, { sessionID: string, form: unknown }>} form id -> asked form */
  const formSession = new Map();
  /** @type {ReseedRequest[]} */
  let reseeds = [];
  const reseedKeys = new Set();
  let reseedEpoch = 0;
  const queuedReseeds = new WeakMap();
  const runningReseeds = new WeakMap();
  const activeReseeds = new Set();
  /** One `reseedDropped` diagnostic per full-queue episode (reset when the hub drains it). */
  let reseedDropNoted = false;
  const unprojectedTypes = new Set();
  const counters = {
    events: 0,
    payloads: 0,
    diagnostics: 0,
    evictions: 0,
    reseedsQueued: 0,
    reseedsDropped: 0,
    failures: 0,
  };

  const diagnostic = (code, details) => {
    counters.diagnostics += 1;
    if (typeof options.recordDiagnostic !== 'function') return;
    try {
      options.recordDiagnostic({ code, ...details });
    } catch {
      // Observer only: a failing recorder never breaks projection.
    }
  };

  const reseedKey = (request) => (
    `${request.kind}\u0000${request.sessionID ?? ''}\u0000${request.messageID ?? request.formID ?? ''}`
  );

  /**
   * @param {ReseedRequest} request
   * @returns {boolean} false when the request was dropped (queue full)
   */
  const queueReseed = (request) => {
    const key = reseedKey(request);
    if (reseedKeys.has(key)) return true;
    if (reseeds.length >= limits.reseedQueue) {
      counters.reseedsDropped += 1;
      if (!reseedDropNoted) {
        reseedDropNoted = true;
        diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.reseedDropped, { kind: request.kind, reason: request.reason });
      }
      return false;
    }
    reseedKeys.add(key);
    queuedReseeds.set(request, { epoch: reseedEpoch, state: sessions.get(request.sessionID) });
    reseeds.push(request);
    counters.reseedsQueued += 1;
    if (typeof options.onReseedRequested === 'function') {
      try {
        options.onReseedRequested();
      } catch {
        // The hub's scheduler is an observer; the request stays queued.
      }
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  function createSessionState(sessionID) {
    return {
      sessionID,
      sessionRevision: 0,
      historyRevision: 0,
      /** Only in-flight message reads need a live-event conflict marker. */
      messageSeeds: new Set(),
      /** @type {string | undefined} */ directory: undefined,
      /** @type {{ cwd: string, root: string } | undefined} */ pathInfo: undefined,
      /** @type {string | undefined} */ slug: undefined,
      /** Folded v2 Session.Info (top-level fields replaced, never nested mutation). */
      /** @type {Record<string, unknown> | undefined} */ info: undefined,
      /** @type {unknown[] | undefined} */ signature: undefined,
      /** @type {number | null | undefined} */ todoRev: undefined,
      /** @type {import('./status.js').V1SessionStatus} */ status: IDLE_STATUS,
      cold: true,
      historyQueued: false,
      sessionQueued: false,
      pendingUpdate: false,
      pendingCreated: false,
      statusDirty: false,
      /** @type {string | undefined} */ lastUser: undefined,
      /** @type {number | undefined} */ lastTime: undefined,
      /** @type {string | undefined} */ foldAgent: undefined,
      /** @type {Record<string, unknown> | undefined} */ foldModel: undefined,
      agentSwitched: false,
      modelSwitched: false,
      /** @type {{ userID: string, info: Record<string, unknown>, agent: boolean, model: boolean } | undefined} */
      pendingRefine: undefined,
      /** @type {Map<string, 'user' | 'assistant' | 'status'>} message id -> role, seq order */
      known: new Map(),
      knownTrimmed: false,
      /** @type {import('./messages.js').UserIndexEntry[]} */ userIndex: [],
      /** @type {Map<string, Record<string, unknown>>} inbox id -> item */ inbox: new Map(),
      /** @type {string | undefined} */ pendingCompactionID: undefined,
      /** @type {Map<string, ReturnType<typeof createAssistant>>} */ assistants: new Map(),
      /** @type {Map<string, Record<string, unknown>>} tool part id -> v2 tool item */ tools: new Map(),
      /** @type {{ messageID: string, row: Record<string, unknown>, created: number | undefined, summaryCreated: number | undefined } | undefined} */
      compaction: undefined,
      /** Summary text whose deltas arrived before `compaction.started` (first sight). */
      /** @type {string | undefined} */ compactionBuffer: undefined,
      /** One `compactionUnknown` diagnostic until the next `compaction.started`. */
      compactionUnknownNoted: false,
      /** A compaction ended while cold: a history seed must not adopt a running row. */
      compactionSettledCold: false,
      /** @type {Map<string, Record<string, unknown>>} user id -> last emitted v1 info (current execution) */
      userInfos: new Map(),
      /** @type {Map<string, Map<string, { file: string, additions: number, deletions: number, status?: string }>>} */
      turnFiles: new Map(),
    };
  }

  /** @typedef {ReturnType<typeof createSessionState>} SessionState */

  /**
   * @param {SessionState} state
   * @param {string} messageID
   * @param {number | undefined} prevTime
   * @param {string} parentID
   */
  function createAssistant(state, messageID, prevTime, parentID) {
    return {
      id: messageID,
      parentID,
      prevTime,
      /** @type {string | undefined} */ agent: state.foldAgent,
      /** @type {Record<string, unknown> | undefined} */ model: state.foldModel,
      /** @type {number | undefined} */ rawCreated: undefined,
      /** @type {number | undefined} */ created: undefined,
      /** @type {number | undefined} */ completed: undefined,
      /** @type {string | undefined} */ finish: undefined,
      /** @type {unknown} */ cost: undefined,
      /** @type {unknown} */ tokens: undefined,
      /** @type {unknown} */ error: undefined,
      /** @type {string | undefined} */ snapshotStart: undefined,
      stepStarted: false,
      /** @type {unknown} */ cursorMetadata: undefined,
      /** Parent guessed at first sight; `step.started` re-derives it. */
      parentGuessed: false,
      /** Already ended before this event arrived (late event): never re-announce the info. */
      late: false,
      /** @type {Set<string>} */ announced: new Set(),
      /** @type {Map<string, number> | undefined} */ reasoningStarts: undefined,
      /** @type {Set<string>} */ toolKeys: new Set(),
    };
  }

  /** @typedef {ReturnType<typeof createAssistant>} AssistantState */

  const evictOldestSession = () => {
    const oldest = sessions.keys().next();
    if (oldest.done) return;
    const sessionID = oldest.value;
    const state = sessions.get(sessionID);
    sessions.delete(sessionID);
    if (lastTouched === state) lastTouched = null;
    counters.evictions += 1;
    diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.evicted, { scope: 'session', sessionID });
  };

  /**
   * The session's state, moved to the LRU tail. Creates a cold entry when absent.
   * @param {string} sessionID
   * @returns {SessionState}
   */
  const sessionState = (sessionID) => {
    let state = sessions.get(sessionID);
    if (state) {
      if (lastTouched !== state) {
        sessions.delete(sessionID);
        sessions.set(sessionID, state);
        lastTouched = state;
      }
      return state;
    }
    state = createSessionState(sessionID);
    sessions.set(sessionID, state);
    lastTouched = state;
    while (sessions.size > limits.sessions) evictOldestSession();
    return state;
  };

  /** Marks a session cold after losing state; its next event queues a reseed. */
  const markCold = (state, reason) => {
    state.cold = true;
    state.historyQueued = false;
    queueHistory(state, reason);
  };

  // The queued flags are set only when the request was queued: a dropped request
  // leaves them clear, so the session's next event asks again.
  const queueHistory = (state, reason) => {
    if (state.historyQueued) return;
    state.historyQueued = queueReseed({ kind: 'history', sessionID: state.sessionID, reason });
  };

  const queueSession = (state, reason) => {
    if (state.sessionQueued) return;
    state.sessionQueued = queueReseed({ kind: 'session', sessionID: state.sessionID, reason });
  };

  const pathInfoOf = (state) => {
    if (state.pathInfo === undefined) {
      const subpath = isRecord(state.info) ? state.info.subpath : undefined;
      state.pathInfo = toV1PathInfo(state.directory, subpath);
    }
    return state.pathInfo;
  };

  const setDirectory = (state, directory) => {
    if (!isNonEmptyString(directory) || directory === state.directory) return;
    state.sessionRevision += 1;
    state.directory = directory;
    state.pathInfo = undefined;
  };

  /**
   * Resolves the session for a session event: LRU touch, directory from the
   * envelope, output directory, and the cold-session reseeds.
   * @param {EmitContext} ctx
   * @param {string} sessionID
   * @returns {SessionState}
   */
  const enterSession = (ctx, sessionID) => {
    const state = sessionState(sessionID);
    if (ctx.envelopeDirectory !== undefined) setDirectory(state, ctx.envelopeDirectory);
    ctx.directory = state.directory ?? 'global';
    if (state.cold) queueHistory(state, 'cold_session');
    if (state.info === undefined) queueSession(state, 'unknown_session');
    return state;
  };

  const rememberKnown = (state, messageID, role) => {
    if (state.known.has(messageID)) return;
    state.known.set(messageID, role);
    if (state.known.size <= limits.knownMessagesPerSession) return;
    // A bounded window, not lost projection state: only a revert to a trimmed id needs a gap.
    const oldest = state.known.keys().next().value;
    state.known.delete(oldest);
    if (!state.knownTrimmed) {
      state.knownTrimmed = true;
      diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.evicted, { scope: 'known-messages', sessionID: state.sessionID });
    }
  };

  const rememberUser = (state, userID, deliveredAt) => {
    state.lastUser = userID;
    rememberKnown(state, userID, 'user');
    if (!isFiniteNumber(deliveredAt)) return;
    let index = addUserIndexEntry(state.userIndex, { userID, deliveredAt });
    if (index.length > limits.userIndexPerSession) index = index.slice(index.length - limits.userIndexPerSession);
    state.userIndex = index;
  };

  const advanceTime = (state, time) => {
    if (isFiniteNumber(time) && (state.lastTime === undefined || time > state.lastTime)) state.lastTime = time;
  };

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * @param {EmitContext} ctx
   * @param {SessionState} state
   * @param {import('./status.js').V1SessionStatus} status
   * @param {boolean} [force] emit even when unchanged (gap reconciliation)
   */
  const setStatus = (ctx, state, status, force = false) => {
    touchActiveReseeds(state.sessionID);
    if (!force && isSameStatus(state.status, status)) return;
    state.status = status;
    if (state.directory === undefined) state.statusDirty = true;
    emit(ctx, 'session.status', { sessionID: state.sessionID, status });
  };

  // -------------------------------------------------------------------------
  // Sessions (B.3 fold)
  // -------------------------------------------------------------------------

  const projectSessionInfo = (state) => toV1Session(state.info, { slug: state.slug });

  /** Emits `session.updated` when a UI-relevant field changed since the last emission. */
  const maybeEmitSessionUpdated = (ctx, state) => {
    if (state.info === undefined) return;
    const info = projectSessionInfo(state);
    if (!info) return;
    const signature = sessionSignature(info);
    if (sameSignature(state.signature, signature)) return;
    state.signature = signature;
    emit(ctx, 'session.updated', { sessionID: state.sessionID, info });
  };

  const maybeEmitTodo = (ctx, state, metadata) => {
    const todo = readSessionTodo(metadata, state.sessionID);
    const rev = todo ? todo.rev : null;
    if (state.todoRev === rev) return;
    const hadTodo = state.todoRev !== undefined && state.todoRev !== null;
    state.todoRev = rev;
    if (!todo && !hadTodo) return;
    emit(ctx, 'todo.updated', { sessionID: state.sessionID, todos: todo ? todo.items : [] });
  };

  /**
   * Folds one granular session event. Without a cached record the change is
   * remembered and the session seed (queued by enterSession) emits it.
   * @param {EmitContext} ctx
   * @param {SessionState} state
   * @param {(info: Record<string, unknown>) => void} apply
   */
  const foldSession = (ctx, state, apply) => {
    state.sessionRevision += 1;
    if (state.info === undefined) {
      state.pendingUpdate = true;
      return;
    }
    apply(state.info);
    const time = isRecord(state.info.time) ? state.info.time : {};
    state.info.time = { ...time, updated: ctx.created };
    maybeEmitSessionUpdated(ctx, state);
  };

  const seedSessionInfo = (state, info) => {
    state.info = info;
    if (isRecord(info.location)) setDirectory(state, info.location.directory);
    state.pathInfo = undefined;
    if (state.foldAgent === undefined && isNonEmptyString(info.agent)) state.foldAgent = info.agent;
    if (state.foldModel === undefined) state.foldModel = toModelRef(info.model);
  };

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  const messageContext = (state) => {
    const pathInfo = pathInfoOf(state);
    /** @type {import('./messages.js').MessagePageContext} */
    const context = { sessionID: state.sessionID, directory: pathInfo.root, cwd: pathInfo.cwd };
    if (state.foldAgent !== undefined) context.agent = state.foldAgent;
    const model = toModelRef(state.foldModel);
    if (model) context.model = /** @type {import('./messages.js').V2ModelRef} */ (model);
    if (errorOptions) context.errorOptions = errorOptions;
    return context;
  };

  /** @param {EmitContext} ctx @param {SessionState} state @param {import('./messages.js').V1MessageRecord} record */
  const emitRecord = (ctx, state, record) => {
    emit(ctx, 'message.updated', { sessionID: state.sessionID, info: record.info });
    for (const part of record.parts) {
      emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part, time: ctx.created });
    }
  };

  const parentFor = (state, createdAt) => (
    state.lastUser ?? findIndexedParentID(state.userIndex, createdAt) ?? ''
  );

  /** @param {SessionState} state @param {AssistantState} assistant */
  const assistantInfo = (state, assistant) => {
    const row = {
      id: assistant.id,
      agent: assistant.agent,
      model: assistant.model,
      time: { created: assistant.rawCreated, completed: assistant.completed },
      finish: assistant.finish,
      cost: assistant.cost,
      tokens: assistant.tokens,
      error: assistant.error,
    };
    return toV1AssistantInfo(row, {
      sessionID: state.sessionID,
      parentID: assistant.parentID,
      created: assistant.created,
      path: pathInfoOf(state),
      errorOptions,
    });
  };

  const evictOldestAssistant = (state) => {
    const oldest = state.assistants.keys().next().value;
    const assistant = state.assistants.get(oldest);
    state.assistants.delete(oldest);
    if (assistant) for (const key of assistant.toolKeys) state.tools.delete(key);
    counters.evictions += 1;
    diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.evicted, { scope: 'assistant', sessionID: state.sessionID, messageID: oldest });
    markCold(state, 'assistant_evicted');
  };

  /**
   * The active assistant for an event, applying the first-sight rule: an
   * unknown assistant is announced with a minimal `message.updated`. A known
   * but already ended assistant (late event) is tracked without re-announcing.
   * @param {EmitContext} ctx
   * @param {SessionState} state
   * @param {string} messageID
   * @returns {AssistantState}
   */
  const ensureAssistant = (ctx, state, messageID) => {
    const existing = state.assistants.get(messageID);
    if (existing) return existing;
    const late = state.known.has(messageID);
    const assistant = createAssistant(state, messageID, state.lastTime, late ? '' : parentFor(state, ctx.created));
    assistant.rawCreated = ctx.created;
    assistant.created = clampIncreasingTime(ctx.created, assistant.prevTime);
    assistant.late = late;
    state.assistants.set(messageID, assistant);
    if (state.assistants.size > limits.assistantsPerSession) evictOldestAssistant(state);
    if (late) return assistant;
    assistant.parentGuessed = true;
    rememberKnown(state, messageID, 'assistant');
    // The clamp time advances at `step.started` (or the step end without one): a
    // user delivery that the durable stream orders before this step keeps its time.
    emit(ctx, 'message.updated', { sessionID: state.sessionID, info: assistantInfo(state, assistant) });
    return assistant;
  };

  /** Emits a part once per id (first sight or the durable `started`). */
  const announcePart = (ctx, state, assistant, part) => {
    if (assistant.announced.has(part.id)) return;
    assistant.announced.add(part.id);
    emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part, time: ctx.created });
  };

  const textPart = (state, assistant, id, text, end, providerState) => {
    const part = {
      id,
      sessionID: state.sessionID,
      messageID: assistant.id,
      type: 'text',
      text,
      time: end === undefined ? { start: assistant.created } : { start: assistant.created, end },
    };
    if (isRecord(providerState)) part.metadata = { providerState };
    return part;
  };

  const reasoningPart = (state, assistant, id, text, start, end, providerState) => {
    const part = {
      id,
      sessionID: state.sessionID,
      messageID: assistant.id,
      type: 'reasoning',
      text,
      time: end === undefined ? { start } : { start, end },
    };
    if (isRecord(providerState)) part.metadata = providerState;
    return part;
  };

  const reasoningStart = (assistant, partID, fallback) => {
    if (!assistant.reasoningStarts) assistant.reasoningStarts = new Map();
    const known = assistant.reasoningStarts.get(partID);
    if (known !== undefined) return known;
    assistant.reasoningStarts.set(partID, fallback);
    return fallback;
  };

  /** The part a first delta announces (empty text, the right type). */
  const firstSightPart = (ctx, state, assistant, kind, partID) => (
    kind === 'reasoning'
      ? reasoningPart(state, assistant, partID, '', reasoningStart(assistant, partID, ctx.created), undefined, undefined)
      : textPart(state, assistant, partID, '', undefined, undefined)
  );

  const contentPartID = (kind, messageID, ordinal) => (
    kind === 'reasoning' ? assistantReasoningPartId(messageID, ordinal) : assistantTextPartId(messageID, ordinal)
  );

  const ordinalOf = (data) => (Number.isSafeInteger(data.ordinal) && data.ordinal >= 0 ? data.ordinal : 0);

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /**
   * The v2-shaped tool item for a tool event. An unknown tool is created with
   * no name; it is emitted once a `tool.input.started` or a message seed names it.
   */
  const ensureTool = (ctx, state, assistant, callID) => {
    const key = assistantToolPartId(assistant.id, callID);
    let tool = state.tools.get(key);
    if (tool) return tool;
    tool = { id: callID, name: undefined, state: { status: 'streaming', input: '' }, time: { created: ctx.created } };
    state.tools.set(key, tool);
    assistant.toolKeys.add(key);
    if (state.tools.size > limits.toolsPerSession) {
      const oldest = state.tools.keys().next().value;
      state.tools.delete(oldest);
      counters.evictions += 1;
      diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.evicted, { scope: 'tool', sessionID: state.sessionID, partID: oldest });
      markCold(state, 'tool_evicted');
    }
    return tool;
  };

  /** @returns {Record<string, unknown> | null} the emitted v1 part */
  const emitTool = (ctx, state, assistant, tool) => {
    if (typeof tool.name !== 'string') {
      queueReseed({ kind: 'message', sessionID: state.sessionID, messageID: assistant.id, reason: 'unknown_tool' });
      return null;
    }
    const part = toV1ToolPart(tool, { messageID: assistant.id, sessionID: state.sessionID });
    if (!part) return null;
    assistant.announced.add(part.id);
    emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part, time: ctx.created });
    return part;
  };

  const finishTool = (state, assistant, callID) => {
    const key = assistantToolPartId(assistant.id, callID);
    state.tools.delete(key);
    assistant.toolKeys.delete(key);
  };

  const accumulateTurnFiles = (state, assistant, part) => {
    if (!part || !isNonEmptyString(assistant.parentID)) return;
    const summaries = turnSummaryDiffs([{ info: { role: 'assistant', parentID: assistant.parentID }, parts: [part] }]);
    const entries = summaries.get(assistant.parentID);
    if (!entries) return;
    let files = state.turnFiles.get(assistant.parentID);
    if (!files) {
      files = new Map();
      state.turnFiles.set(assistant.parentID, files);
    }
    for (const entry of entries) {
      const current = files.get(entry.file) ?? { file: entry.file, additions: 0, deletions: 0 };
      const next = { ...current, additions: current.additions + entry.additions, deletions: current.deletions + entry.deletions };
      if (entry.status !== undefined) next.status = entry.status;
      files.set(entry.file, next);
    }
  };

  const toolInput = (tool) => (isRecord(tool.state) && isRecord(tool.state.input) ? tool.state.input : {});

  // -------------------------------------------------------------------------
  // Turn boundaries
  // -------------------------------------------------------------------------

  /** Refines a user record whose agent/model came from the fold (REST `refineSeededUsers`). */
  const refineUser = (ctx, state, assistant) => {
    const pending = state.pendingRefine;
    if (!pending || pending.userID !== assistant.parentID) return;
    state.pendingRefine = undefined;
    let info = pending.info;
    if (pending.agent && isNonEmptyString(assistant.agent) && info.agent !== assistant.agent) {
      info = { ...info, agent: assistant.agent };
    }
    const model = toModelRef(assistant.model);
    if (pending.model && model) {
      const userModel = { providerID: model.providerID, modelID: model.id };
      if (typeof model.variant === 'string') userModel.variant = model.variant;
      const current = isRecord(info.model) ? info.model : {};
      if (current.providerID !== userModel.providerID || current.modelID !== userModel.modelID
        || current.variant !== userModel.variant) {
        info = { ...info, model: userModel };
      }
    }
    if (info === pending.info) return;
    state.userInfos.set(pending.userID, info);
    emit(ctx, 'message.updated', { sessionID: state.sessionID, info });
  };

  const clearExecution = (state) => {
    state.historyRevision += 1;
    for (const seed of state.messageSeeds) seed.stale = true;
    state.assistants.clear();
    state.tools.clear();
    state.userInfos.clear();
    state.turnFiles.clear();
    state.pendingRefine = undefined;
    state.compactionBuffer = undefined;
  };

  /** Execution terminal: turn summaries, then idle and `session.idle` ([ev M14]). */
  const finishExecution = (ctx, state) => {
    for (const [userID, files] of state.turnFiles) {
      const info = state.userInfos.get(userID);
      if (!info || files.size === 0) continue;
      emit(ctx, 'message.updated', { sessionID: state.sessionID, info: { ...info, summary: { diffs: [...files.values()] } } });
    }
    clearExecution(state);
    setStatus(ctx, state, IDLE_STATUS);
    emit(ctx, 'session.idle', { sessionID: state.sessionID });
  };

  // -------------------------------------------------------------------------
  // Inbox delivery
  // -------------------------------------------------------------------------

  /**
   * Emits the v1 user record for a delivered `user` or `synthetic` inbox item.
   * The row has the stored message shape, so the REST projection applies as is.
   */
  const deliverPrompt = (ctx, state, inboxID, item) => {
    const payload = isRecord(item.payload) ? item.payload : {};
    const row = { ...payload, id: inboxID, type: item.type, time: { created: ctx.created } };
    const page = projectMessagePage([row], { ...messageContext(state), previousTime: state.lastTime });
    const record = page.records[0];
    if (isNativeTurnParent(row)) rememberUser(state, inboxID, ctx.created);
    else rememberKnown(state, inboxID, 'status');
    if (!record) return;
    advanceTime(state, page.lastTime);
    emitRecord(ctx, state, record);
    state.userInfos.set(inboxID, record.info);
    if (state.userInfos.size > limits.assistantsPerSession) {
      state.userInfos.delete(state.userInfos.keys().next().value);
    }
    if (!isNativeTurnParent(row)) return;
    const selection = readDevryanPromptSelection(payload.metadata);
    const agent = !selection?.agent && !state.agentSwitched;
    const model = !selection?.modelID && !state.modelSwitched;
    state.pendingRefine = agent || model ? { userID: inboxID, info: record.info, agent, model } : undefined;
  };

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /** @type {Map<string, (ctx: EmitContext, data: Record<string, unknown>) => void>} */
  const handlers = new Map();

  /** Registers a handler for session events, which all carry `sessionID`. */
  const onSession = (type, handler) => {
    handlers.set(type, (ctx, data) => {
      if (!isNonEmptyString(data.sessionID)) {
        diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.malformed, { type, reason: 'missing_session' });
        return;
      }
      handler(ctx, enterSession(ctx, data.sessionID), data);
    });
  };

  /** Registers a handler for assistant-scoped events (`assistantMessageID`). */
  const onAssistant = (type, handler) => {
    onSession(type, (ctx, state, data) => {
      if (!isNonEmptyString(data.assistantMessageID)) {
        diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.malformed, { type, reason: 'missing_assistant' });
        return;
      }
      for (const seed of state.messageSeeds) {
        if (seed.request.messageID === data.assistantMessageID) seed.stale = true;
      }
      handler(ctx, state, data, data.assistantMessageID);
    });
  };

  // --- sessions ------------------------------------------------------------

  handlers.set('session.created', (ctx, data) => {
    if (!isNonEmptyString(data.sessionID)) return;
    const state = sessionState(data.sessionID);
    state.sessionRevision += 1;
    touchActiveReseeds(data.sessionID);
    const { sessionID, slug, version: _version, ...rest } = data;
    const created = ctx.created;
    seedSessionInfo(state, { ...rest, id: sessionID, time: { created, updated: created } });
    if (ctx.envelopeDirectory !== undefined) setDirectory(state, ctx.envelopeDirectory);
    if (typeof slug === 'string') state.slug = slug;
    state.cold = false;
    state.historyQueued = false;
    state.pendingUpdate = false;
    state.pendingCreated = false;
    const todo = readSessionTodo(data.metadata, sessionID);
    state.todoRev = todo ? todo.rev : null;
    ctx.directory = state.directory ?? 'global';
    const info = projectSessionInfo(state);
    if (!info) return;
    state.signature = sessionSignature(info);
    emit(ctx, 'session.created', { sessionID, info });
  });

  onSession('session.renamed', (ctx, state, data) => {
    if (typeof data.title !== 'string') return;
    foldSession(ctx, state, (info) => { info.title = data.title; });
  });

  onSession('session.metadata.updated', (ctx, state, data) => {
    // F4: a metadata write replaces the whole map.
    foldSession(ctx, state, (info) => { info.metadata = data.metadata; });
    maybeEmitTodo(ctx, state, data.metadata);
  });

  onSession('session.agent.selected', (ctx, state, data) => {
    if (!isNonEmptyString(data.agent)) return;
    state.foldAgent = data.agent;
    state.agentSwitched = true;
    foldSession(ctx, state, (info) => { info.agent = data.agent; });
  });

  onSession('session.model.selected', (ctx, state, data) => {
    const model = toModelRef(data.model);
    if (!model) return;
    state.foldModel = model;
    state.modelSwitched = true;
    foldSession(ctx, state, (info) => { info.model = model; });
  });

  onSession('session.permissions', (ctx, state, data) => {
    foldSession(ctx, state, (info) => { info.permissions = data.permissions; });
  });

  onSession('session.moved', (ctx, state, data) => {
    if (isRecord(data.location)) setDirectory(state, data.location.directory);
    ctx.directory = state.directory ?? ctx.directory;
    foldSession(ctx, state, (info) => {
      info.location = data.location;
      if (typeof data.projectID === 'string') info.projectID = data.projectID;
      info.subpath = data.subpath;
    });
    state.pathInfo = undefined;
  });

  onSession('session.revert.staged', (ctx, state, data) => {
    foldSession(ctx, state, (info) => { info.revert = data.revert; });
  });

  onSession('session.revert.cleared', (ctx, state) => {
    foldSession(ctx, state, (info) => { delete info.revert; });
  });

  onSession('session.revert.committed', (ctx, state, data) => {
    state.historyRevision += 1;
    for (const seed of state.messageSeeds) seed.stale = true;
    const to = data.to;
    if (!isNonEmptyString(to) || !state.known.has(to)) {
      diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.revertTargetUnknown, { sessionID: state.sessionID });
      queueReseed({ kind: 'gap', scope: 'global', sessionID: state.sessionID, reason: 'revert_target_unknown' });
    } else {
      const removed = [];
      let found = false;
      for (const messageID of state.known.keys()) {
        if (messageID === to) found = true;
        if (found) removed.push(messageID);
      }
      for (const messageID of removed) {
        state.known.delete(messageID);
        state.assistants.delete(messageID);
        state.userInfos.delete(messageID);
        emit(ctx, 'message.removed', { sessionID: state.sessionID, messageID });
      }
      const removedSet = new Set(removed);
      state.userIndex = state.userIndex.filter((entry) => !removedSet.has(entry.userID));
      state.lastUser = undefined;
      for (const [messageID, role] of state.known) if (role === 'user') state.lastUser = messageID;
    }
    foldSession(ctx, state, (info) => { delete info.revert; });
  });

  onSession('session.usage.updated', (_ctx, state, data) => {
    state.sessionRevision += 1;
    if (state.info === undefined) return;
    if (isFiniteNumber(data.cost)) state.info.cost = data.cost;
    if (isRecord(data.tokens)) state.info.tokens = data.tokens;
  });

  handlers.set('session.forked', (ctx, data) => {
    // F4: a fork publishes no `session.created`; its record comes from a seed.
    if (!isNonEmptyString(data.sessionID)) return;
    const state = sessionState(data.sessionID);
    if (ctx.envelopeDirectory !== undefined) setDirectory(state, ctx.envelopeDirectory);
    state.pendingCreated = true;
    queueSession(state, 'forked');
  });

  handlers.set('session.deleted', (ctx, data) => {
    if (!isNonEmptyString(data.sessionID)) return;
    touchActiveReseeds(data.sessionID);
    const state = sessions.get(data.sessionID);
    if (ctx.envelopeDirectory === undefined && state?.directory) ctx.directory = state.directory;
    const info = state?.info ? projectSessionInfo(state) : undefined;
    emit(ctx, 'session.deleted', { sessionID: data.sessionID, info: info ?? { id: data.sessionID } });
    if (!state) return;
    sessions.delete(data.sessionID);
    if (lastTouched === state) lastTouched = null;
  });

  // --- inbox and execution ------------------------------------------------

  onSession('session.inbox.enqueued', (_ctx, state, data) => {
    if (!isNonEmptyString(data.inboxID) || !isRecord(data.item)) return;
    state.inbox.set(data.inboxID, data.item);
    if (state.inbox.size <= limits.inboxPerSession) return;
    const oldest = state.inbox.keys().next().value;
    state.inbox.delete(oldest);
    counters.evictions += 1;
    diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.evicted, { scope: 'inbox', sessionID: state.sessionID, inboxID: oldest });
  });

  onSession('session.inbox.cancelled', (_ctx, state, data) => {
    if (isNonEmptyString(data.inboxID)) state.inbox.delete(data.inboxID);
  });

  onSession('session.inbox.delivered', (ctx, state, data) => {
    const inboxID = data.inboxID;
    if (!isNonEmptyString(inboxID)) return;
    for (const seed of state.messageSeeds) {
      if (seed.request.messageID === inboxID) seed.stale = true;
    }
    const item = state.inbox.get(inboxID);
    state.inbox.delete(inboxID);
    if (!item) {
      // Enqueued before this projector saw it: a prompt is the overwhelmingly common
      // case, so it becomes the parent now and its record comes from a message seed.
      rememberUser(state, inboxID, ctx.created);
      advanceTime(state, ctx.created);
      queueReseed({ kind: 'message', sessionID: state.sessionID, messageID: inboxID, reason: 'unknown_inbox_item' });
      return;
    }
    if (item.type === 'user' || item.type === 'synthetic') {
      deliverPrompt(ctx, state, inboxID, item);
      return;
    }
    if (item.type === 'compaction') state.pendingCompactionID = inboxID;
    // `move` items are applied by `session.moved`.
  });

  onSession('session.execution.started', (ctx, state) => {
    setStatus(ctx, state, BUSY_STATUS);
  });

  onSession('session.execution.succeeded', (ctx, state) => {
    finishExecution(ctx, state);
  });

  onSession('session.execution.failed', (ctx, state, data) => {
    const error = toV1Error(data.error, errorOptions)
      ?? { name: 'UnknownError', data: { message: '', v2Type: 'unknown' } };
    emit(ctx, 'session.error', { sessionID: state.sessionID, error });
    finishExecution(ctx, state);
  });

  onSession('session.execution.interrupted', (ctx, state, data) => {
    if (data.reason === 'user') {
      emit(ctx, 'session.error', { sessionID: state.sessionID, error: toV1InterruptError(data.reason) });
    }
    finishExecution(ctx, state);
    // [ev M16]: `shutdown` keeps the claim, so the host may resume the run.
    if (data.reason === 'shutdown') queueReseed({ kind: 'active', reason: 'interrupted_shutdown' });
  });

  onSession('session.retry.scheduled', (ctx, state, data) => {
    setStatus(ctx, state, toV1RetryStatus(data) ?? BUSY_STATUS);
  });

  // --- steps ---------------------------------------------------------------

  onAssistant('session.step.started', (ctx, state, data, messageID) => {
    let assistant = state.assistants.get(messageID);
    const restart = assistant?.stepStarted === true;
    if (!assistant) {
      const late = state.known.has(messageID);
      assistant = createAssistant(state, messageID, state.lastTime, parentFor(state, data.started));
      assistant.late = late;
      state.assistants.set(messageID, assistant);
      if (state.assistants.size > limits.assistantsPerSession) evictOldestAssistant(state);
      rememberKnown(state, messageID, 'assistant');
    } else if (assistant.parentGuessed && !restart) {
      // First sight guessed the parent before the durable delivery of a steered
      // prompt could arrive; durable order is preserved, so derive it now as the
      // in-order stream would. The re-emitted info below corrects the guess.
      assistant.parentID = parentFor(state, data.started);
      assistant.prevTime = state.lastTime;
    }
    assistant.parentGuessed = false;
    if (isRecord(ctx.metadata) && isRecord(ctx.metadata.devryan) && isRecord(ctx.metadata.devryan.cursor)
      && ctx.metadata.devryan.cursor.source === 'cursor-acp' && isRecord(data.model) && data.model.providerID === 'cursor-acp') assistant.cursorMetadata = ctx.metadata;
    if (restart) {
      // F2: a retry restarts the step on the same message; drop the stale content.
      for (const partID of assistant.announced) {
        emit(ctx, 'message.part.removed', { sessionID: state.sessionID, messageID, partID });
      }
      assistant.announced.clear();
      assistant.reasoningStarts = undefined;
      for (const key of assistant.toolKeys) state.tools.delete(key);
      assistant.toolKeys.clear();
    }
    if (isNonEmptyString(data.agent)) assistant.agent = data.agent;
    const model = toModelRef(data.model);
    if (model) assistant.model = model;
    assistant.rawCreated = isFiniteNumber(data.started) ? data.started : ctx.created;
    assistant.created = clampIncreasingTime(assistant.rawCreated, assistant.prevTime);
    assistant.snapshotStart = isNonEmptyString(data.snapshot) ? data.snapshot : undefined;
    assistant.stepStarted = true;
    assistant.late = false;
    advanceTime(state, assistant.created);
    state.foldAgent = assistant.agent;
    state.foldModel = assistant.model;
    state.agentSwitched = false;
    state.modelSwitched = false;
    if (state.status.type === 'retry') setStatus(ctx, state, BUSY_STATUS);
    refineUser(ctx, state, assistant);
    emit(ctx, 'message.updated', { sessionID: state.sessionID, info: assistantInfo(state, assistant) });
    const stepStart = { id: stepStartPartId(messageID), sessionID: state.sessionID, messageID, type: 'step-start' };
    if (assistant.snapshotStart !== undefined) stepStart.snapshot = assistant.snapshotStart;
    if (!assistant.cursorMetadata) emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part: stepStart, time: ctx.created });
  });

  const endStep = (ctx, state, data, messageID, failed) => {
    const assistant = ensureAssistant(ctx, state, messageID);
    if (!assistant.stepStarted && !assistant.late) advanceTime(state, assistant.created);
    assistant.completed = ctx.created;
    if (failed) {
      assistant.finish = typeof data.finish === 'string' ? data.finish : 'error';
      assistant.error = data.error;
    } else if (typeof data.finish === 'string') {
      assistant.finish = data.finish;
    }
    if (isFiniteNumber(data.cost)) assistant.cost = data.cost;
    if (isRecord(data.tokens)) assistant.tokens = data.tokens;
    const stepFinish = {
      id: stepFinishPartId(messageID),
      sessionID: state.sessionID,
      messageID,
      type: 'step-finish',
      reason: assistant.finish ?? 'stop',
      cost: isFiniteNumber(assistant.cost) ? assistant.cost : 0,
      tokens: toV1Tokens(assistant.tokens),
    };
    if (isNonEmptyString(data.snapshot)) stepFinish.snapshot = data.snapshot;
    if (!assistant.cursorMetadata) emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part: stepFinish, time: ctx.created });
    if (assistant.late) {
      // The assistant left the active set before this event (it ended or was evicted):
      // its parent, creation time and selection are gone, so the stored record is
      // the authority instead of an info that would overwrite the UI's with blanks.
      queueReseed({ kind: 'message', sessionID: state.sessionID, messageID, reason: 'late_assistant' });
    } else {
      emit(ctx, 'message.updated', { sessionID: state.sessionID, info: assistantInfo(state, assistant) });
    }
    for (const key of assistant.toolKeys) state.tools.delete(key);
    state.assistants.delete(messageID);
  };

  onAssistant('session.step.ended', (ctx, state, data, messageID) => endStep(ctx, state, data, messageID, false));
  onAssistant('session.step.failed', (ctx, state, data, messageID) => endStep(ctx, state, data, messageID, true));

  // The exported replay event is used only by owned ACP cumulative ingress.
  onSession('session.message.content.updated', (ctx, state, data) => {
    if (!isNonEmptyString(data.messageID) || !Array.isArray(data.content)) return;
    const assistant = state.assistants.get(data.messageID);
    if (!assistant?.cursorMetadata || !isRecord(ctx.metadata) || !isRecord(ctx.metadata.devryan)
      || !isRecord(ctx.metadata.devryan.cursor) || ctx.metadata.devryan.cursor.source !== 'cursor-acp') return;
    const parts = toV1AssistantParts({ id: assistant.id, content: data.content,
      model: assistant.model, metadata: assistant.cursorMetadata }, { sessionID: state.sessionID,
        created: assistant.created, parentID: assistant.parentID, path: toV1PathInfo(state.directory) });
    const next = new Set(parts.map(part => part.id));
    for (const partID of assistant.announced) if (!next.has(partID)) {
      emit(ctx, 'message.part.removed', { sessionID: state.sessionID, messageID: assistant.id, partID });
    }
    assistant.announced.clear();
    for (const part of parts) {
      assistant.announced.add(part.id);
      emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part, time: ctx.created });
    }
  });

  // --- text and reasoning --------------------------------------------------

  const onContentStarted = (kind) => (ctx, state, data, messageID) => {
    const assistant = ensureAssistant(ctx, state, messageID);
    const partID = contentPartID(kind, messageID, ordinalOf(data));
    if (assistant.announced.has(partID)) return;
    if (assistant.late) {
      // Never re-announce an empty part over one the UI may already hold.
      assistant.announced.add(partID);
      return;
    }
    const part = kind === 'reasoning'
      ? reasoningPart(state, assistant, partID, '', reasoningStart(assistant, partID, ctx.created), undefined, data.state)
      : textPart(state, assistant, partID, '', undefined, undefined);
    announcePart(ctx, state, assistant, part);
  };

  const onContentDelta = (kind) => (ctx, state, data, messageID) => {
    if (typeof data.delta !== 'string') return;
    const assistant = ensureAssistant(ctx, state, messageID);
    const partID = contentPartID(kind, messageID, ordinalOf(data));
    if (assistant.late) {
      // The part was announced (and may hold text) before the assistant left the
      // active set: an empty first-sight part would wipe it in the UI. The delta
      // alone appends to it (or opens a provisional part).
      assistant.announced.add(partID);
    } else if (!assistant.announced.has(partID)) {
      announcePart(ctx, state, assistant, firstSightPart(ctx, state, assistant, kind, partID));
    }
    emit(ctx, 'message.part.delta', {
      sessionID: state.sessionID,
      messageID,
      partID,
      field: TEXT_FIELD,
      delta: data.delta,
    });
  };

  const onContentEnded = (kind) => (ctx, state, data, messageID) => {
    const assistant = ensureAssistant(ctx, state, messageID);
    const partID = contentPartID(kind, messageID, ordinalOf(data));
    const text = typeof data.text === 'string' ? data.text : '';
    const part = kind === 'reasoning'
      ? reasoningPart(state, assistant, partID, text, reasoningStart(assistant, partID, ctx.created), ctx.created, data.state)
      : textPart(state, assistant, partID, text, ctx.created, data.state);
    assistant.announced.add(partID);
    emit(ctx, 'message.part.updated', { sessionID: state.sessionID, part, time: ctx.created });
  };

  onAssistant('session.text.started', onContentStarted('text'));
  onAssistant('session.reasoning.started', onContentStarted('reasoning'));
  onAssistant('session.text.delta', onContentDelta('text'));
  onAssistant('session.reasoning.delta', onContentDelta('reasoning'));
  onAssistant('session.text.ended', onContentEnded('text'));
  onAssistant('session.reasoning.ended', onContentEnded('reasoning'));

  // --- tools ---------------------------------------------------------------

  const onTool = (type, handler) => {
    onAssistant(type, (ctx, state, data, messageID) => {
      if (!isNonEmptyString(data.id)) {
        diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.malformed, { type, reason: 'missing_tool' });
        return;
      }
      const assistant = ensureAssistant(ctx, state, messageID);
      handler(ctx, state, data, assistant, ensureTool(ctx, state, assistant, data.id));
    });
  };

  onTool('session.tool.input.started', (ctx, state, data, assistant, tool) => {
    if (typeof data.name === 'string') tool.name = data.name;
    tool.state = { status: 'streaming', input: '' };
    tool.time = { created: ctx.created };
    emitTool(ctx, state, assistant, tool);
  });

  onTool('session.tool.input.ended', (_ctx, _state, data, _assistant, tool) => {
    tool.state = { status: 'streaming', input: typeof data.text === 'string' ? data.text : '' };
  });

  onTool('session.tool.called', (ctx, state, data, assistant, tool) => {
    tool.state = { status: 'running', input: isRecord(data.input) ? data.input : {} };
    tool.time = { ...tool.time, ran: ctx.created };
    if (isRecord(data.state)) tool.providerState = data.state;
    emitTool(ctx, state, assistant, tool);
  });

  onTool('session.tool.progress', (ctx, state, data, assistant, tool) => {
    // Live-only replacement metadata for the running tool.
    tool.state = { status: 'running', input: toolInput(tool), metadata: isRecord(data.metadata) ? data.metadata : {} };
    emitTool(ctx, state, assistant, tool);
  });

  onTool('session.tool.success', (ctx, state, data, assistant, tool) => {
    tool.state = { status: 'completed', input: toolInput(tool), content: data.content, metadata: data.metadata };
    tool.time = { ...tool.time, completed: ctx.created };
    const part = emitTool(ctx, state, assistant, tool);
    accumulateTurnFiles(state, assistant, part);
    if (part) finishTool(state, assistant, data.id);
  });

  onTool('session.tool.failed', (ctx, state, data, assistant, tool) => {
    tool.state = {
      status: 'error',
      input: toolInput(tool),
      error: data.error,
      content: data.content,
      metadata: data.metadata,
    };
    tool.time = { ...tool.time, completed: ctx.created };
    const part = emitTool(ctx, state, assistant, tool);
    if (part) finishTool(state, assistant, data.id);
  });

  // --- compaction ----------------------------------------------------------
  //
  // Core keys a compaction row on `inputID` (manual: the delivered inbox item),
  // else on the started event id with `evt_` replaced by `msg_` (auto compaction
  // on context overflow publishes no inputID). An `ended` with no running
  // compaction appends a completed row keyed on its own event id; a `failed`
  // with none appends a failed row keyed on `inputID`, else its event id.

  /** Core's `SessionMessage.ID.fromEvent`. */
  const compactionIdFromEvent = (eventId) => (
    isNonEmptyString(eventId) ? eventId.replace(/^evt_/, 'msg_') : undefined
  );

  /** One diagnostic (and one cold mark) until the next `compaction.started`. */
  const noteCompactionUnknown = (state, reason) => {
    if (state.compactionUnknownNoted) return;
    state.compactionUnknownNoted = true;
    diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.compactionUnknown, { sessionID: state.sessionID, reason });
    markCold(state, 'compaction_unknown');
  };

  const emitCompaction = (ctx, state, compaction, which) => {
    const [user, summary] = toV1CompactionRecords(compaction.row, {
      sessionID: state.sessionID,
      created: compaction.created,
      summaryCreated: compaction.summaryCreated,
      agent: state.foldAgent,
      model: /** @type {import('./messages.js').V2ModelRef | undefined} */ (toModelRef(state.foldModel)),
      path: pathInfoOf(state),
      errorOptions,
    });
    if (which === 'pair') emitRecord(ctx, state, user);
    emitRecord(ctx, state, summary);
  };

  /**
   * A new compaction row at the envelope time; it becomes the turn parent.
   * @param {EmitContext} ctx
   * @param {SessionState} state
   * @param {string} messageID
   * @param {Record<string, unknown>} fields row fields beyond id, type and time
   */
  const openCompaction = (ctx, state, messageID, fields) => {
    const created = clampIncreasingTime(ctx.created, state.lastTime);
    const summaryCreated = clampIncreasingTime(created, created);
    advanceTime(state, summaryCreated);
    rememberKnown(state, messageID, 'user');
    rememberKnown(state, compactionSummaryMessageId(messageID), 'assistant');
    state.lastUser = messageID;
    return {
      messageID,
      row: { id: messageID, type: 'compaction', ...fields, time: { created: ctx.created } },
      created,
      summaryCreated,
    };
  };

  const summaryDelta = (ctx, state, compaction, text) => {
    emit(ctx, 'message.part.delta', {
      sessionID: state.sessionID,
      messageID: compactionSummaryMessageId(compaction.messageID),
      partID: compactionSummaryTextPartId(compaction.messageID),
      field: TEXT_FIELD,
      delta: text,
    });
  };

  onSession('session.compaction.started', (ctx, state, data) => {
    state.historyRevision += 1;
    const messageID = isNonEmptyString(data.inputID)
      ? data.inputID
      : compactionIdFromEvent(ctx.eventId) ?? state.pendingCompactionID;
    const buffered = state.compactionBuffer;
    state.pendingCompactionID = undefined;
    state.compactionBuffer = undefined;
    state.compactionUnknownNoted = false;
    if (!isNonEmptyString(messageID)) {
      noteCompactionUnknown(state, 'missing_id');
      return;
    }
    // First sight: summary deltas that beat this durable event become its text.
    const fields = { status: 'running', reason: data.reason };
    if (buffered !== undefined) fields.summary = buffered;
    const compaction = openCompaction(ctx, state, messageID, fields);
    state.compaction = compaction;
    emitCompaction(ctx, state, compaction, 'pair');
  });

  onSession('session.compaction.delta', (ctx, state, data) => {
    if (typeof data.text !== 'string') return;
    const compaction = state.compaction;
    if (compaction) {
      summaryDelta(ctx, state, compaction, data.text);
      return;
    }
    // The durable `compaction.started` may still be in flight (first sight): buffer.
    const next = `${state.compactionBuffer ?? ''}${data.text}`;
    if (next.length <= limits.compactionBuffer) state.compactionBuffer = next;
    else noteCompactionUnknown(state, 'buffer_full');
    if (state.cold) noteCompactionUnknown(state, 'cold_session');
  });

  /** @returns {boolean} whether a compaction was settled */
  const endCompaction = (ctx, state, data, failed) => {
    let compaction = state.compaction;
    let which = 'summary';
    state.compaction = undefined;
    state.compactionBuffer = undefined;
    if (!compaction) {
      if (state.cold) {
        // A compaction core still holds as running may have started unseen; its id is unknown.
        state.compactionSettledCold = true;
        noteCompactionUnknown(state, 'cold_session');
        return false;
      }
      const messageID = failed && isNonEmptyString(data.inputID) ? data.inputID : compactionIdFromEvent(ctx.eventId);
      if (!isNonEmptyString(messageID)) {
        noteCompactionUnknown(state, 'missing_id');
        return false;
      }
      compaction = openCompaction(ctx, state, messageID, { reason: data.reason });
      which = 'pair';
    }
    compaction.row = failed
      ? { ...compaction.row, status: 'failed', error: data.error, cost: data.cost, tokens: data.tokens }
      : {
        ...compaction.row,
        status: 'completed',
        summary: data.text,
        model: data.model,
        cost: data.cost,
        tokens: data.tokens,
      };
    emitCompaction(ctx, state, compaction, which);
    return true;
  };

  onSession('session.compaction.ended', (ctx, state, data) => {
    state.historyRevision += 1;
    endCompaction(ctx, state, data, false);
    // The compaction ended whether or not its row could be projected ([ev M17]).
    emit(ctx, 'session.compacted', { sessionID: state.sessionID });
  });

  onSession('session.compaction.failed', (ctx, state, data) => {
    state.historyRevision += 1;
    endCompaction(ctx, state, data, true);
  });

  /**
   * After a history seed, adopts the newest compaction the seed shows as running
   * (a cold session joined mid-compaction), so its deltas and end project.
   * @param {EmitContext} ctx
   * @param {SessionState} state
   * @param {readonly unknown[]} rows seq order
   * @param {readonly import('./messages.js').V1MessageRecord[]} records
   */
  const adoptRunningCompaction = (ctx, state, rows, records) => {
    const settled = state.compactionSettledCold;
    state.compactionSettledCold = false;
    if (state.compaction !== undefined || settled) return;
    let row;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index];
      if (isRecord(candidate) && candidate.type === 'compaction') {
        row = candidate;
        break;
      }
    }
    if (!row || row.status !== 'running' || !isNonEmptyString(row.id)) return;
    const user = records.find((record) => record.info.id === row.id);
    const summary = records.find((record) => record.info.id === compactionSummaryMessageId(row.id));
    const created = isRecord(user?.info.time) ? user.info.time.created : undefined;
    const summaryCreated = isRecord(summary?.info.time) ? summary.info.time.created : undefined;
    if (!isFiniteNumber(created) || !isFiniteNumber(summaryCreated)) return;
    const compaction = {
      messageID: row.id,
      row: { id: row.id, type: 'compaction', status: 'running', reason: row.reason, time: row.time },
      created,
      summaryCreated,
    };
    state.compaction = compaction;
    const buffered = state.compactionBuffer;
    state.compactionBuffer = undefined;
    // The stored running row has no summary yet; replay what streamed while cold.
    if (isNonEmptyString(buffered)) summaryDelta(ctx, state, compaction, buffered);
  };

  // --- permissions and forms ----------------------------------------------

  const rememberInteraction = (map, id, value) => {
    map.set(id, value);
    if (map.size > limits.interactions) map.delete(map.keys().next().value);
  };

  const interactionDirectory = (ctx, sessionID) => {
    if (ctx.envelopeDirectory !== undefined) return;
    const state = isNonEmptyString(sessionID) ? sessions.get(sessionID) : undefined;
    if (state?.directory) ctx.directory = state.directory;
  };

  handlers.set('permission.asked', (ctx, data) => {
    const request = toV1PermissionRequest(data);
    if (!request) return;
    interactionDirectory(ctx, request.sessionID);
    rememberInteraction(permissionSession, request.id, request.sessionID);
    emit(ctx, 'permission.asked', request);
  });

  handlers.set('permission.replied', (ctx, data) => {
    const replied = toV1PermissionReplied(data);
    if (!replied) return;
    interactionDirectory(ctx, replied.sessionID);
    permissionSession.delete(replied.requestID);
    emit(ctx, 'permission.replied', replied);
  });

  handlers.set('form.created', (ctx, data) => {
    const classified = classifyForm(data.form);
    if (classified.action === 'ask') {
      interactionDirectory(ctx, classified.request.sessionID);
      rememberInteraction(formSession, classified.request.id, { sessionID: classified.request.sessionID, form: data.form });
      emit(ctx, 'question.asked', classified.request);
      return;
    }
    diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.form, { ...classified.diagnostic, action: classified.action });
    if (classified.action === 'cancel') {
      queueReseed({
        kind: 'form-cancel',
        sessionID: classified.sessionID,
        formID: classified.formID,
        reason: classified.diagnostic.reason,
      });
    }
  });

  handlers.set('form.replied', (ctx, data) => {
    const asked = isNonEmptyString(data.id) ? formSession.get(data.id) : undefined;
    const replied = toV1QuestionReplied(data, asked?.form);
    if (!replied) return;
    interactionDirectory(ctx, replied.sessionID);
    formSession.delete(replied.requestID);
    emit(ctx, 'question.replied', replied);
  });

  handlers.set('form.cancelled', (ctx, data) => {
    const rejected = toV1QuestionRejected(data);
    if (!rejected) return;
    interactionDirectory(ctx, rejected.sessionID);
    formSession.delete(rejected.requestID);
    emit(ctx, 'question.rejected', rejected);
  });

  // --- locations, projects and files ---------------------------------------

  handlers.set('location.shutdown', (ctx) => {
    if (ctx.envelopeDirectory === undefined) return;
    emit(ctx, 'server.instance.disposed', { directory: ctx.envelopeDirectory });
  });

  handlers.set('project.updated', (ctx, data) => {
    emit(ctx, 'project.updated', typeof data.canonical === 'string' ? { ...data, worktree: data.canonical } : data);
  });

  handlers.set('filesystem.changed', (ctx, data) => {
    if (typeof data.file !== 'string') return;
    emit(ctx, 'file.watcher.updated', { file: data.file, event: data.event });
  });

  for (const type of PASS_THROUGH_TYPES) {
    handlers.set(type, (ctx, data) => { emit(ctx, type, data); });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Projects one parsed v2 envelope. Never throws and never awaits.
   * @param {unknown} envelope `{id, created, type, location?, durable?, data}`
   * @returns {readonly ProjectedEvent[]} {@link EMPTY_PROJECTION} when nothing is emitted
   */
  const project = (envelope) => {
    counters.events += 1;
    if (!isRecord(envelope) || typeof envelope.type !== 'string') {
      diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.malformed, { reason: 'invalid_envelope' });
      return EMPTY_PROJECTION;
    }
    const type = envelope.type;
    const handler = handlers.get(type);
    if (!handler) {
      if (NATIVE_STATUS_TYPES.has(type)) {
        diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.nativeStatus, { type });
      } else if (!DROPPED_TYPES.has(type) && !unprojectedTypes.has(type)) {
        if (unprojectedTypes.size < 256) unprojectedTypes.add(type);
        diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.unprojected, { type });
      }
      return EMPTY_PROJECTION;
    }
    const location = envelope.location;
    const envelopeDirectory = isRecord(location) && isNonEmptyString(location.directory) ? location.directory : undefined;
    /** @type {EmitContext} */
    const ctx = {
      eventId: isNonEmptyString(envelope.id) ? envelope.id : undefined,
      created: isFiniteNumber(envelope.created) ? envelope.created : now(),
      envelopeDirectory,
      directory: envelopeDirectory ?? 'global',
      list: null,
      metadata: envelope.metadata,
    };
    try {
      handler(ctx, isRecord(envelope.data) ? envelope.data : EMPTY_DATA);
    } catch (error) {
      counters.failures += 1;
      diagnostic(EVENT_PROJECTOR_DIAGNOSTICS.failed, {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      const sessionID = isRecord(envelope.data) ? envelope.data.sessionID : undefined;
      const state = isNonEmptyString(sessionID) ? sessions.get(sessionID) : undefined;
      if (state) markCold(state, 'projection_failed');
      return ctx.list ?? EMPTY_PROJECTION;
    }
    if (ctx.list === null) return EMPTY_PROJECTION;
    counters.payloads += ctx.list.length;
    return ctx.list;
  };

  /** @returns {ReadonlyMap<string, import('./status.js').V1SessionStatus | null> | undefined} */
  const toRetryMap = (retryBySession) => {
    if (retryBySession instanceof Map) return retryBySession;
    if (!isRecord(retryBySession)) return undefined;
    return new Map(Object.entries(retryBySession));
  };

  /** @returns {EmitContext} */
  const seedContext = (state) => ({
    eventId: undefined,
    created: now(),
    envelopeDirectory: undefined,
    directory: state?.directory ?? 'global',
    list: null,
  });

  const seedResult = (ctx) => {
    if (ctx.list === null) return EMPTY_PROJECTION;
    counters.payloads += ctx.list.length;
    return ctx.list;
  };

  // A seed owns the epoch and entity lifetime from its queued request, then
  // captures revisions immediately before I/O. Live updates only invalidate
  // reads of that same entity; streaming another message cannot starve a seed.
  const beginReseed = (request) => {
    const queued = queuedReseeds.get(request);
    if (!queued || queued.epoch !== reseedEpoch || runningReseeds.has(request)) return false;
    const state = sessions.get(request.sessionID);
    if (request.sessionID && queued.state !== state) return false;
    const seed = {
      request, state, epoch: reseedEpoch,
      sessionRevision: state?.sessionRevision,
      historyRevision: state?.historyRevision,
      stale: false, touched: new Set(),
    };
    runningReseeds.set(request, seed);
    if (request.kind === 'active') activeReseeds.add(seed);
    if (request.kind === 'message') state?.messageSeeds.add(seed);
    return true;
  };

  const touchActiveReseeds = (sessionID) => {
    for (const seed of activeReseeds) {
      if (seed.stale) continue;
      seed.touched.add(sessionID);
      if (seed.touched.size > limits.sessions) {
        seed.stale = true;
        seed.touched.clear();
      }
    }
  };

  const finishReseed = (request) => {
    const seed = runningReseeds.get(request);
    if (!seed) return undefined;
    runningReseeds.delete(request);
    queuedReseeds.delete(request);
    activeReseeds.delete(seed);
    seed.state?.messageSeeds.delete(seed);
    return seed;
  };

  const acceptReseed = (request, kind, state) => {
    // Synchronous callers may seed known state directly. The hub always uses a
    // queued request, and duplicate/old completions are rejected here.
    if (request === undefined) return true;
    const seed = finishReseed(request);
    if (!seed || request.kind !== kind || seed.epoch !== reseedEpoch || seed.state !== state) return false;
    const stale = seed.stale || (kind !== 'session' && seed.historyRevision !== state?.historyRevision)
      || (kind === 'session' && seed.sessionRevision !== state?.sessionRevision);
    if (!stale) return true;
    if (kind === 'session') {
      state.sessionQueued = false;
      queueSession(state, 'stale_seed');
    } else if (kind === 'history') {
      state.historyQueued = false;
      queueHistory(state, 'stale_seed');
    } else if (kind === 'message') {
      queueReseed({ ...request, reason: 'stale_seed' });
    }
    return false;
  };

  /**
   * Applies a `session` seed (`GET /api/session/:id` data, or `null` when it no
   * longer exists). Emits `session.created` for a fork, `session.updated` when a
   * fold arrived before the record was known, and a `session.status` that was
   * emitted before the session's directory was known.
   * @param {string} sessionID
   * @param {unknown} info v2 `Session.Info`
   * @returns {readonly ProjectedEvent[]}
   */
  const applySession = (sessionID, info, request) => {
    const state = sessions.get(sessionID);
    if (!acceptReseed(request, 'session', state)) return EMPTY_PROJECTION;
    if (!state) return EMPTY_PROJECTION;
    state.sessionQueued = false;
    if (!isRecord(info) || info.id !== sessionID) {
      state.pendingUpdate = false;
      state.pendingCreated = false;
      return EMPTY_PROJECTION;
    }
    seedSessionInfo(state, { ...info });
    const ctx = seedContext(state);
    const projected = projectSessionInfo(state);
    if (state.todoRev === undefined) {
      const todo = readSessionTodo(info.metadata, sessionID);
      state.todoRev = todo ? todo.rev : null;
    }
    if (projected && state.pendingCreated) {
      state.signature = sessionSignature(projected);
      emit(ctx, 'session.created', { sessionID, info: projected });
    } else if (projected && state.pendingUpdate) {
      const signature = sessionSignature(projected);
      if (!sameSignature(state.signature, signature)) {
        state.signature = signature;
        emit(ctx, 'session.updated', { sessionID, info: projected });
      }
    } else if (projected && state.signature === undefined) {
      state.signature = sessionSignature(projected);
    }
    state.pendingCreated = false;
    state.pendingUpdate = false;
    if (state.statusDirty && state.directory !== undefined) {
      state.statusDirty = false;
      emit(ctx, 'session.status', { sessionID, status: state.status });
    }
    return seedResult(ctx);
  };

  /**
   * Applies a `history` seed: the newest message rows of a cold session in
   * **seq order**. Restores lastUser, the known-id window, the user index and
   * the clamp time, adopts a compaction the rows show as running, and re-emits
   * active assistants whose parent was unknown.
   * @param {string} sessionID
   * @param {readonly unknown[]} rows
   * @returns {readonly ProjectedEvent[]}
   */
  const applyHistory = (sessionID, rows, request) => {
    const state = sessions.get(sessionID);
    if (!acceptReseed(request, 'history', state)) return EMPTY_PROJECTION;
    if (!state) return EMPTY_PROJECTION;
    state.historyQueued = false;
    if (!Array.isArray(rows)) return EMPTY_PROJECTION;
    const page = projectMessagePage(rows, { ...messageContext(state), userIndex: state.userIndex });
    const live = state.known;
    state.known = new Map();
    state.knownTrimmed = false;
    for (const record of page.records) {
      rememberKnown(state, String(record.info.id), isNativeStatusRecord(record) ? 'status' : record.info.role === 'user' ? 'user' : 'assistant');
    }
    for (const [messageID, role] of live) rememberKnown(state, messageID, role);
    let index = buildUserIndex(rows);
    for (const entry of state.userIndex) index = addUserIndexEntry(index, entry);
    state.userIndex = index.length > limits.userIndexPerSession
      ? index.slice(index.length - limits.userIndexPerSession)
      : index;
    if (state.lastUser === undefined && isNonEmptyString(page.lastParentID)) state.lastUser = page.lastParentID;
    advanceTime(state, page.lastTime);
    if (state.foldAgent === undefined && isNonEmptyString(page.fold.agent)) state.foldAgent = page.fold.agent;
    if (state.foldModel === undefined && page.fold.model) state.foldModel = page.fold.model;
    state.cold = false;
    const ctx = seedContext(state);
    adoptRunningCompaction(ctx, state, rows, page.records);
    for (const assistant of state.assistants.values()) {
      if (assistant.parentID !== '' || assistant.late) continue;
      const parentID = findIndexedParentID(state.userIndex, assistant.rawCreated) ?? state.lastUser;
      if (!isNonEmptyString(parentID)) continue;
      assistant.parentID = parentID;
      emit(ctx, 'message.updated', { sessionID, info: assistantInfo(state, assistant) });
    }
    return seedResult(ctx);
  };

  /**
   * Applies a `message` seed (`GET …/message/:mid` data): emits its v1
   * record(s) and names active tools the projector saw without a name.
   * @param {string} sessionID
   * @param {unknown} row v2 `Session.Message.Info`
   * @returns {readonly ProjectedEvent[]}
   */
  const applyMessage = (sessionID, row, request) => {
    const state = sessions.get(sessionID);
    if (!acceptReseed(request, 'message', state)) return EMPTY_PROJECTION;
    if (!state || !isRecord(row) || !isNonEmptyString(row.id)) return EMPTY_PROJECTION;
    if (row.type === 'assistant' && Array.isArray(row.content)) {
      for (const item of row.content) {
        if (!isRecord(item) || item.type !== 'tool' || !isNonEmptyString(item.id)) continue;
        const tool = state.tools.get(assistantToolPartId(row.id, item.id));
        if (tool && typeof tool.name !== 'string' && typeof item.name === 'string') tool.name = item.name;
      }
    }
    const assistant = state.assistants.get(row.id);
    const records = projectMessagePage([row], {
      ...messageContext(state),
      userIndex: state.userIndex,
    }).records;
    const ctx = seedContext(state);
    for (const record of records) {
      if (assistant && record.info.id === row.id) record.info.parentID = assistant.parentID || record.info.parentID;
      if (record.info.role === 'user') state.userInfos.set(String(record.info.id), record.info);
      emitRecord(ctx, state, record);
    }
    return seedResult(ctx);
  };

  /**
   * Applies `GET /api/session/active` after a gap or cold start (B.3, B.7):
   * emits `session.status` for every session previously held as non-idle and
   * every newly active one, plus `session.idle` where a run ended unseen. An
   * active session in `retryBySession` (status.js `retryStatusFromMessages` over
   * its newest rows) is reported as retrying instead of busy (B.3).
   * @param {unknown} body
   * @param {ReadonlyMap<string, import('./status.js').V1SessionStatus | null>
   *   | Readonly<Record<string, import('./status.js').V1SessionStatus | null>>} [retryBySession]
   * @returns {readonly ProjectedEvent[]}
   */
  const applyActive = (body, retryBySession, request) => {
    const seed = request === undefined ? undefined : finishReseed(request);
    if (request !== undefined && (!seed || request.kind !== 'active' || seed.epoch !== reseedEpoch || seed.stale)) return EMPTY_PROJECTION;
    /** @type {Map<string, import('./status.js').V1SessionStatus>} */
    const previous = new Map();
    for (const [sessionID, state] of sessions) {
      if (state.status.type !== 'idle') previous.set(sessionID, state.status);
    }
    const { changes } = reconcileActiveStatuses({ active: body, previous, retryBySession: toRetryMap(retryBySession) });
    /** @type {ProjectedEvent[]} */
    const results = [];
    for (const { sessionID, status } of changes) {
      if (seed?.touched.has(sessionID)) continue;
      const known = sessions.has(sessionID);
      const state = sessionState(sessionID);
      if (!known) queueSession(state, 'active_unknown_session');
      const ctx = seedContext(state);
      const wasBusy = state.status.type !== 'idle';
      if (state.directory === undefined) {
        // The UI routes 'global' payloads to its global reducer; hold the status for the seed.
        state.status = status;
        state.statusDirty = true;
        queueSession(state, 'status_without_directory');
        continue;
      }
      setStatus(ctx, state, status, true);
      if (status.type === 'idle') {
        clearExecution(state);
        if (wasBusy) emit(ctx, 'session.idle', { sessionID });
      }
      if (ctx.list) results.push(...ctx.list);
    }
    counters.payloads += results.length;
    return results.length === 0 ? EMPTY_PROJECTION : results;
  };

  /**
   * Every upstream reconnect is a gap (B.7): all sessions become cold and an
   * `active` reconciliation is queued. The hub broadcasts the WebSocket gap itself.
   * @param {string} [reason]
   */
  const handleGap = (reason = 'upstream_reconnect') => {
    reseedEpoch += 1;
    reseeds = [];
    reseedKeys.clear();
    activeReseeds.clear();
    for (const state of sessions.values()) {
      state.cold = true;
      state.historyQueued = false;
      // In-flight seeds may be lost with the connection; asking again is idempotent.
      state.sessionQueued = false;
      state.messageSeeds.clear();
    }
    queueReseed({ kind: 'active', reason });
  };

  /**
   * Hands the queued reseed requests to the hub and clears the queue.
   * @returns {ReseedRequest[]}
   */
  const takeReseedRequests = () => {
    if (reseeds.length === 0) return [];
    const taken = reseeds;
    reseeds = [];
    reseedKeys.clear();
    reseedDropNoted = false;
    return taken;
  };

  /**
   * Reports a reseed the hub could not complete, so the next event retries it.
   * @param {ReseedRequest} request
   */
  const reseedFailed = (request) => {
    const seed = finishReseed(request);
    if (!isRecord(request) || !isNonEmptyString(request.sessionID)) return;
    const state = sessions.get(request.sessionID);
    if (!state) return;
    const queued = seed ?? queuedReseeds.get(request);
    if (!queued || queued.epoch !== reseedEpoch || queued.state !== state) return;
    if (request.kind === 'history') state.historyQueued = false;
    if (request.kind === 'session') state.sessionQueued = false;
  };

  return Object.freeze({
    generation: 2,
    project,
    beginReseed,
    applySession,
    applyHistory,
    applyMessage,
    applyActive,
    handleGap,
    takeReseedRequests,
    reseedFailed,
    pendingReseedCount: () => reseeds.length,
    /** @param {string} sessionID */
    isCold: (sessionID) => sessions.get(sessionID)?.cold ?? true,
    /** @param {string} sessionID */
    sessionStatus: (sessionID) => sessions.get(sessionID)?.status ?? IDLE_STATUS,
    /** @param {string} sessionID */
    sessionDirectory: (sessionID) => sessions.get(sessionID)?.directory,
    /** @param {string} permissionID */
    permissionSession: (permissionID) => permissionSession.get(permissionID),
    /** @param {string} formID */
    formSession: (formID) => formSession.get(formID)?.sessionID,
    stats: () => ({
      ...counters,
      sessions: sessions.size,
      reseedsPending: reseeds.length,
    }),
  });
}

/**
 * The projector for a runtime generation: gen 2 gets one; gen 1 gets `null`,
 * so the hub keeps today's identity path with no projection hook.
 * @param {unknown} generation
 * @param {EventProjectorOptions} [options]
 */
export const createEventProjectorForGeneration = (generation, options) => (
  generation === 2 ? createEventProjector(options) : null
);
