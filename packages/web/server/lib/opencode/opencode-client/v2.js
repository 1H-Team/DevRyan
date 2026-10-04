import { isNativeTurnParent } from '../../../../../shared-runtime/lib/native-message-status.js';
// ---------------------------------------------------------------------------
// Gen 2 backend of openCodeClient: OpenCode 2.0.20 behind DevRyan's v1 domain
// (DESIGN.md C.1, B.2-B.6).
//
// Requests go through `requester.js` (path mapping and normalization, location
// translation, the route policy for the audience, optional root binding, typed
// errors and envelope reading).
// Per operation the backend projects the 2.0.20 answer into the v1 domain
// shape with the projection modules (items 3, 4 and 6), fills message pages
// (B.2) and resolves the session of a permission or form reply (B.6).
//
// Writes that change the session selection (prompt, command) belong to the
// admission module (B.5, item 12), which the deps provide through
// `getAdmission`; without it they fail closed. `sessions.archive` is the one
// scoped elevation: it writes only `metadata.devryan.archive` for the session
// itself (owner guard), through a privileged-audience request (B.6).
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

import { probe } from '../readiness-probe.js';
import {
  toV1Agents,
  toV1Commands,
  toV1Config,
  toV1ConfigProviders,
  toV1CurrentProject,
  toV1McpStatus,
  toV1Path,
  toV1ProviderList,
  toV1Skills,
  toV1VcsInfo,
} from '../v2/projection/catalog.js';
import { createEventProjector } from '../v2/projection/events.js';
import {
  projectFormList,
  toV1PermissionRequests,
  toV2FormAnswer,
  toV2PermissionReply,
} from '../v2/projection/interaction.js';
import {
  fillMessagePage,
  InvalidMessageCursorError,
  InvalidMessagePageError,
  projectMessagePage,
  turnSummaryDiffs,
  V2_MESSAGE_PAGE_MAX,
} from '../v2/projection/messages.js';
import {
  sessionDirectory,
  sessionMessageContext,
  toV1Session,
  toV1SessionList,
  toV1SessionTodos,
} from '../v2/projection/sessions.js';
import { filterStatusesByDirectory, retryStatusFromMessages, statusesFromActive } from '../v2/projection/status.js';
import { toV1ToolName } from '../v2/projection/tools.js';
import { OPENCODE_V2_AUDIENCE } from '../v2/route-policy.js';
import { isNoContent, NO_CONTENT, unwrapData, unwrapList, unwrapPage } from './envelope.js';
import { createOpenCodeClientError, OPENCODE_CLIENT_ERROR_CODES } from './errors.js';
import { createV2AudienceRequester, V2_DEFAULT_REQUEST_TIMEOUT_MS } from './requester.js';
import { isSameOpenCodeRuntime, readOpenCodeRuntime } from './runtime.js';

export { V2_DEFAULT_REQUEST_TIMEOUT_MS };
export const V2_DISPATCH_REQUEST_TIMEOUT_MS = 30_000;
export const V2_MESSAGES_REQUEST_TIMEOUT_MS = 120_000;
/** Session list page size; v2 defaults to 50 when `limit` is omitted. */
export const V2_SESSION_PAGE_SIZE = 200;
/** Upper bound on pages read by one list or full-history read. */
export const V2_MAX_PAGES = 50;
/** Session directories remembered for status filtering. */
export const V2_DIRECTORY_CACHE_LIMIT = 2_048;
/** Unknown session locations looked up by one `status({directory})`. */
export const V2_STATUS_LOOKUP_LIMIT = 64;

const C = OPENCODE_CLIENT_ERROR_CODES;
const SERVER = OPENCODE_V2_AUDIENCE.SERVER;
const PRIVILEGED = OPENCODE_V2_AUDIENCE.PRIVILEGED;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const encode = (value) => encodeURIComponent(String(value));

// ---------------------------------------------------------------------------
// Identifiers

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdTimestamp = 0;
let idCounter = 0;

/**
 * A descending 2.x session id (`ses_` + the `@opencode/schema/identifier`
 * layout: 12 hex time digits, newest first, then 14 random base62 characters).
 * DevRyan generates it so a retried create is idempotent ([sm M30]).
 */
export const createV2SessionId = (timestamp = Date.now()) => {
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(idCounter));
  const time = Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - 8 * index)) & 0xffn)
    .toString(16).padStart(2, '0')).join('');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join('');
  return `ses_${time}${random}`;
};

// ---------------------------------------------------------------------------
// Events

/**
 * Parses one `/api/event` block (the text between blank lines).
 * - `{kind: 'comment'}` for comment-only blocks (`: heartbeat`): they reset the
 *   stall timer but are never events (B.7);
 * - `{kind: 'event', eventId, directory, envelope}` for a data frame (2.0.20
 *   frames are data-only: the id lives in the JSON);
 * - `null` for anything else.
 * @param {unknown} block
 */
export const parseV2EventBlock = (block) => {
  if (typeof block !== 'string' || block.length === 0) return null;
  const lines = block.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
  if (data.length === 0) return lines.every((line) => line.startsWith(':')) ? { kind: 'comment' } : null;
  let envelope;
  try {
    envelope = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isNonEmptyString(envelope.type)) return null;
  const location = isRecord(envelope.location) && isNonEmptyString(envelope.location.directory) ? envelope.location.directory : null;
  return { kind: 'event', eventId: isNonEmptyString(envelope.id) ? envelope.id : null, directory: location, envelope };
};

// ---------------------------------------------------------------------------
// Requests (requester.js)

/**
 * The server-audience gen-2 requester, for modules that build their own
 * request bodies. Only the server audience is reachable through this export:
 * the privileged audience lives behind `requester.js`, whose importers the
 * contract suite restricts (C.1 privilege boundary).
 * @param {import('./requester.js').V2RequesterDeps} deps
 * @param {{ audience?: 'server' }} [options]
 * @returns {(spec: import('./requester.js').V2RequestSpec) => Promise<unknown>}
 */
export const createV2Requester = (deps, { audience = SERVER } = {}) => {
  if (audience !== SERVER) throw new TypeError('createV2Requester only builds the server audience');
  return createV2AudienceRequester(deps, { audience: SERVER });
};

// ---------------------------------------------------------------------------
// Small projections of DevRyan inputs

/** v1 `{providerID, modelID, variant?}` (or a v2 ref) -> v2 `Model.Ref`. */
export const toV2ModelRef = (model) => {
  if (!isRecord(model)) return undefined;
  const id = isNonEmptyString(model.modelID) ? model.modelID : model.id;
  if (!isNonEmptyString(id) || !isNonEmptyString(model.providerID)) return undefined;
  return isNonEmptyString(model.variant) ? { id, providerID: model.providerID, variant: model.variant } : { id, providerID: model.providerID };
};

const projectToolIds = (ids) => (Array.isArray(ids) ? ids.filter((id) => typeof id === 'string').map(toV1ToolName) : []);

const projectToolDefinitions = (definitions) => (Array.isArray(definitions)
  ? definitions.filter(isRecord).map((definition) => (
    typeof definition.id === 'string' ? { ...definition, id: toV1ToolName(definition.id) } : definition
  ))
  : []);

const mergeTurnDiffs = (byTurn) => {
  /** @type {Map<string, { file: string, additions: number, deletions: number, status?: string }>} */
  const files = new Map();
  for (const entries of byTurn.values()) {
    for (const entry of entries) {
      const current = files.get(entry.file) ?? { file: entry.file, additions: 0, deletions: 0 };
      current.additions += entry.additions;
      current.deletions += entry.deletions;
      if (entry.status) current.status = entry.status;
      files.set(entry.file, current);
    }
  }
  return [...files.values()];
};

// ---------------------------------------------------------------------------
// The backend

/**
 * @typedef {object} V2BackendDeps
 * @property {() => import('./runtime.js').OpenCodeRuntime} getRuntime
 * @property {() => Record<string, string> | Promise<Record<string, string>>} [getAuthHeaders]
 * @property {typeof fetch} [fetchImpl]
 * @property {{ allowedRoots?: () => Iterable<string> }} [policy] project roots every location must lie in
 * @property {unknown} [projector] the live gen-2 event projector, or a getter returning it (slug-free
 *   lookups: session directory, retry status, permission and form sessions)
 * @property {(diagnostic: Record<string, unknown>) => void} [recordDiagnostic]
 * @property {() => ({ prompt?: Function, command?: Function, compact?: Function } | null)} [getAdmission]
 * @property {(sessionID:string,options:object)=>Promise<true>} [removeNativeSession] private owned subtree coordinator
 * @property {(spec:object,action:()=>Promise<unknown>)=>Promise<unknown>} [withNativeWebOperation]
 */

/**
 * Creates the gen-2 backend.
 * @param {V2BackendDeps} deps
 */
export const createV2Backend = (deps) => {
  const request = createV2AudienceRequester(deps, { audience: SERVER });
  // Scoped elevation for `sessions.archive` only (see the header).
  const elevated = createV2AudienceRequester(deps, { audience: PRIVILEGED });
  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const getAuthHeaders = typeof deps.getAuthHeaders === 'function' ? deps.getAuthHeaders : () => ({});
  const recordDiagnostic = typeof deps.recordDiagnostic === 'function' ? deps.recordDiagnostic : () => {};

  const resolveProjector = () => {
    const value = typeof deps.projector === 'function' ? deps.projector() : deps.projector;
    return isRecord(value) ? value : null;
  };
  const resolveAdmission = () => {
    const value = typeof deps.getAdmission === 'function' ? deps.getAdmission() : null;
    return isRecord(value) ? value : null;
  };

  /** Session id -> directory (LRU), from every session the client has read. */
  const directories = new Map();
  let directoryRuntime;
  const refreshDirectoryRuntime = () => {
    const runtime = readOpenCodeRuntime(deps.getRuntime);
    if (!isSameOpenCodeRuntime(directoryRuntime, runtime)) {
      directories.clear();
      directoryRuntime = { ...runtime };
    }
  };
  const rememberSession = (info) => {
    refreshDirectoryRuntime();
    if (!isRecord(info) || !isNonEmptyString(info.id)) return;
    const directory = sessionDirectory(info);
    if (!directory) return;
    directories.delete(info.id);
    directories.set(info.id, directory);
    if (directories.size > V2_DIRECTORY_CACHE_LIMIT) directories.delete(directories.keys().next().value);
  };
  const directoryOf = (sessionID) => {
    refreshDirectoryRuntime();
    const projected = resolveProjector()?.sessionDirectory?.(sessionID);
    return isNonEmptyString(projected) ? projected : directories.get(sessionID);
  };

  const pass = (options = {}, label, defaultTimeoutMs) => ({
    label,
    allowNotFound: options.allowNotFound === true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    onResponseRead: options.onResponseRead,
    defaultTimeoutMs,
  });

  const notFound = (operation, what) => createOpenCodeClientError(C.notFound, 404, `${operation}: ${what} not found`, { operation, generation: 2 });

  const sessionPath = (sessionID, suffix = '') => `/api/session/${encode(sessionID)}${suffix}`;

  /** The raw v2 `Session.Info`, `null` on an allowed 404. */
  const readSessionInfo = async (sessionID, options, label) => {
    const body = await request({ ...pass(options, label), path: sessionPath(sessionID) });
    if (body === null) return null;
    const info = unwrapData(body);
    rememberSession(info);
    return info;
  };

  const projectSession = (info) => {
    rememberSession(info);
    return toV1Session(info) ?? null;
  };

  /** Raw message rows of a session in seq order (bounded; newest first on the wire). */
  const readAllMessageRows = async (sessionID, options, label, targetID) => {
    const rows = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < V2_MAX_PAGES; page += 1) {
      const body = await request({
        ...pass(options, label, V2_MESSAGES_REQUEST_TIMEOUT_MS),
        allowNotFound: false,
        path: sessionPath(sessionID, '/message'),
        query: cursor === undefined ? { order: 'desc', limit: V2_MESSAGE_PAGE_MAX } : { cursor, limit: V2_MESSAGE_PAGE_MAX },
      });
      const { data, next } = unwrapPage(body);
      rows.push(...data);
      if (targetID !== undefined) {
        const target = rows.findIndex((row) => isRecord(row) && row.id === targetID);
        if (target >= 0 && rows.slice(target + 1).some((row) => isRecord(row)
          && isNativeTurnParent(row))) return rows.reverse();
      }
      if (data.length < V2_MESSAGE_PAGE_MAX || !next) return rows.reverse();
      if (seen.has(next)) throw createOpenCodeClientError(C.invalidResponse, 502,
        'The OpenCode message cursor did not advance', { operation: label, generation: 2 });
      seen.add(next);
      cursor = next;
    }
    recordDiagnostic({ code: 'opencode_client_history_truncated', generation: 2, operation: label, sessionID, pages: V2_MAX_PAGES });
    throw createOpenCodeClientError(C.unavailable, 503, 'Message history exceeded the complete-read budget; use paginated history',
      { operation: label, generation: 2, retryable: false });
  };

  const messagePageFetcher = (sessionID, options, label, type) => async ({ cursor, limit }) => await request({
    ...pass(options, label, V2_MESSAGES_REQUEST_TIMEOUT_MS),
    allowNotFound: false,
    path: sessionPath(sessionID, '/message'),
    query: cursor === undefined
      ? { ...(type ? { type } : {}), order: 'desc', limit }
      : { ...(type ? { type } : {}), cursor, limit },
  });

  /** The retry status of the latest assistant row (B.3, [sm M27]), or `null`. */
  const readLatestRetry = async (sessionID, options) => {
    const body = await request({
      ...pass(options, 'sessions.status'),
      allowNotFound: true,
      path: sessionPath(sessionID, '/message'),
      query: { type: 'assistant', order: 'desc', limit: 1 },
    });
    return body === null ? null : retryStatusFromMessages(unwrapPage(body).data);
  };

  const listSessions = async (query, options, label) => {
    const wanted = Number.isSafeInteger(query.limit) && query.limit > 0 ? query.limit : Number.POSITIVE_INFINITY;
    const pageSize = Math.min(wanted, V2_SESSION_PAGE_SIZE);
    let parentID;
    if (isNonEmptyString(query.parentID)) parentID = query.parentID;
    else if (query.roots === true) parentID = 'null';
    const sessions = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < V2_MAX_PAGES; page += 1) {
      const body = await request({
        ...pass(options, label),
        path: '/api/session',
        // The cursor carries the first page's filters: 2.0.20 encodes the whole
        // first-page query except `limit` (directory, search, order, parentID)
        // plus the anchor (`@opencode/protocol` `SessionsCursor`, `withCursor`).
        directory: cursor === undefined ? query.directory ?? options.directory : undefined,
        query: cursor === undefined
          ? { limit: pageSize, order: 'desc', parentID, ...(typeof query.search === 'string' ? { search: query.search } : {}) }
          : { cursor, limit: pageSize },
      });
      if (body === null) return null;
      const { data, next } = unwrapPage(body);
      for (const row of data) rememberSession(row);
      for (const session of toV1SessionList(data)) {
        // v2 has no archived filter (B.6): the projected override decides.
        if (typeof query.archived === 'boolean' && Boolean(session.time?.archived) !== query.archived) continue;
        sessions.push(session);
        if (sessions.length >= wanted) return sessions;
      }
      if (!next) return sessions;
      if (seen.has(next)) throw createOpenCodeClientError(C.invalidResponse, 502,
        'The OpenCode session cursor did not advance', { operation: label, generation: 2 });
      seen.add(next);
      cursor = next;
    }
    recordDiagnostic({ code: 'opencode_client_list_truncated', generation: 2, operation: label, pages: V2_MAX_PAGES });
    throw createOpenCodeClientError(C.unavailable, 503, 'Session enumeration exceeded the complete-read budget',
      { operation: label, generation: 2, retryable: true });
  };

  const sessions = {
    /** @param {{ directory?: string, parentID?: string, roots?: boolean, limit?: number, search?: string, archived?: boolean }} [query] */
    async list(query = {}, options = {}) {
      return await listSessions(query, options, 'sessions.list');
    },
    async get(sessionID, options = {}) {
      const info = await readSessionInfo(sessionID, options, 'sessions.get');
      return info === null ? null : projectSession(info);
    },
    /**
     * Root sessions use `POST /api/session` (body location); a child goes to the
     * host's `POST /devryan/session` (C.6). Permissions and metadata are
     * privileged (C.3 body rule) and are refused here.
     * @param {{ id?: string, directory?: string, title?: string, parentID?: string, agent?: string,
     *   model?: { providerID: string, modelID: string, variant?: string }, permission?: unknown[], metadata?: unknown }} input
     */
    async create(input = {}, options = {}) {
      if (input.permission !== undefined || input.metadata !== undefined || input.permissions !== undefined) {
        throw createOpenCodeClientError(C.privilegeRequired, 403,
          'sessions.create cannot set permissions or metadata on OpenCode 2; use the privileged client',
          { operation: 'sessions.create', generation: 2 });
      }
      const id = isNonEmptyString(input.id) ? input.id : createV2SessionId();
      const model = toV2ModelRef(input.model);
      const common = {
        id,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(isNonEmptyString(input.agent) ? { agent: input.agent } : {}),
        ...(model ? { model } : {}),
      };
      const directory = input.directory ?? options.directory;
      if (isNonEmptyString(input.parentID)) {
        const body = await request({
          ...pass(options, 'sessions.create', V2_DISPATCH_REQUEST_TIMEOUT_MS),
          method: 'POST',
          path: '/devryan/session',
          body: { ...common, parentID: input.parentID, ...(isNonEmptyString(directory) ? { location: { directory } } : {}) },
        });
        return body === null ? null : projectSession(unwrapData(body));
      }
      const body = await request({
        ...pass(options, 'sessions.create', V2_DISPATCH_REQUEST_TIMEOUT_MS),
        method: 'POST',
        path: '/api/session',
        directory,
        body: common,
      });
      return body === null ? null : projectSession(unwrapData(body));
    },
    async update(sessionID, patch = {}, options = {}) {
      const result = await request({
        ...pass(options, 'sessions.update'),
        method: 'PATCH',
        path: sessionPath(sessionID),
        // As on gen 1, a patch without a string title changes nothing.
        body: typeof patch.title === 'string' ? { title: patch.title } : {},
      });
      if (result === null) return null;
      return await sessions.get(sessionID, options);
    },
    /**
     * The DevRyan archive override `metadata.devryan.archive = {sessionID, at}`.
     * PATCH replaces metadata (F4), so the current map is read and rewritten.
     * The runtime session owner serializes whole-metadata changes with admission.
     * @param {string} sessionID
     * @param {number | null | undefined} at epoch ms, or null/undefined to unarchive
     */
    async archive(sessionID, at, options = {}) {
      const admission = resolveAdmission();
      if (typeof admission?.withSessionLock !== 'function') throw createOpenCodeClientError(C.unavailable, 503,
        'Session archive requires the runtime session owner', { operation: 'sessions.archive', generation: 2 });
      return admission.withSessionLock(sessionID, async () => {
        const info = await readSessionInfo(sessionID, options, 'sessions.archive');
        if (info === null) return null;
        const metadata = isRecord(info.metadata) ? info.metadata : {};
        const devryan = isRecord(metadata.devryan) ? metadata.devryan : {};
        const next = { ...metadata, devryan: { ...devryan, archive: { sessionID, at: isFiniteNumber(at) ? at : null } } };
        const result = await elevated({
          ...pass(options, 'sessions.archive'),
          method: 'PATCH',
          path: sessionPath(sessionID),
          body: { metadata: next },
        });
        if (result === null) return null;
        return await sessions.get(sessionID, options);
      }, { signal: options.signal });
    },
    async remove(sessionID, options = {}) {
      if (typeof deps.removeNativeSession !== 'function' || typeof deps.withNativeWebOperation !== 'function') {
        throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.capabilityUnavailable, 503,
          'Owned native session deletion is unavailable', { generation: 2, operation: 'sessions.remove' });
      }
      const result = await deps.withNativeWebOperation({ operation: 'sessions.remove', method: 'DELETE',
        path: `/api/session/${encodeURIComponent(sessionID)}`, directory: options.directory },
      () => deps.removeNativeSession(sessionID, options));
      if (result === null) return null;
      if (result !== true) throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.invalidResponse, 502,
        'Owned native session deletion was not confirmed', { generation: 2, operation: 'sessions.remove' });
      directories.delete(sessionID);
      return true;
    },
    async children(sessionID, options = {}) {
      return await listSessions({ parentID: sessionID }, options, 'sessions.children');
    },
    /** v1 fork `{messageID}` copies the messages before it: v2 `{before}` ([sm M40]). */
    async fork(sessionID, input = {}, options = {}) {
      const body = await request({
        ...pass(options, 'sessions.fork'),
        method: 'POST',
        path: sessionPath(sessionID, '/fork'),
        body: isNonEmptyString(input.messageID) ? { before: input.messageID } : {},
      });
      return body === null ? null : projectSession(unwrapData(body));
    },
    /**
     * Non-idle statuses from `GET /api/session/active`. With a directory,
     * entries are filtered by session location; unknown locations are looked up
     * (bounded); an incomplete lookup fails without publishing a partial snapshot.
     * Retry (B.3) comes from the live
     * projector; an active session the projector does not hold as busy or
     * retrying (no projector, cold start, gap) is recovered from its latest
     * assistant's `retry` field (bounded; a failed lookup stays busy).
     */
    async status(query = {}, options = {}) {
      const body = await request({ ...pass(options, 'sessions.status'), path: '/api/session/active' });
      let statuses = statusesFromActive(body);
      if (isNonEmptyString(query.directory)) {
        const unknown = Object.keys(statuses).filter((sessionID) => !directoryOf(sessionID)).slice(0, V2_STATUS_LOOKUP_LIMIT);
        await Promise.all(unknown.map((sessionID) => readSessionInfo(sessionID, { ...options, allowNotFound: true }, 'sessions.status')));
        // An omitted active session would be interpreted as idle by callers. Cache
        // successful lookups, but leave the previous snapshot intact until every
        // active session can be assigned to a directory. Repeated reads make
        // bounded progress when more than the per-call budget was unknown.
        if (Object.keys(statuses).some((sessionID) => !directoryOf(sessionID))) {
          throw createOpenCodeClientError(C.unavailable, 503,
            'Active session locations are incomplete; retry the status snapshot',
            { operation: 'sessions.status', generation: 2, retryable: true });
        }
        statuses = filterStatusesByDirectory(statuses, { directory: query.directory, directoryOf });
      }
      const projector = resolveProjector();
      const retryBySession = new Map();
      const cold = [];
      for (const sessionID of Object.keys(statuses)) {
        const live = projector?.sessionStatus?.(sessionID);
        if (isRecord(live) && live.type === 'retry') retryBySession.set(sessionID, live);
        else if (!isRecord(live) || live.type !== 'busy') cold.push(sessionID);
      }
      await Promise.all(cold.slice(0, V2_STATUS_LOOKUP_LIMIT).map(async (sessionID) => {
        const retry = await readLatestRetry(sessionID, options);
        if (retry) retryBySession.set(sessionID, retry);
      }));
      return Object.fromEntries(Object.entries(statuses).map(([sessionID, status]) => [sessionID, retryBySession.get(sessionID) ?? status]));
    },
    /** `true` for both `interrupted: true` and the idle no-op `interrupted: false` ([sm M37]). */
    async abort(sessionID, options = {}) {
      const result = await request({ ...pass(options, 'sessions.abort'), method: 'POST', path: sessionPath(sessionID, '/interrupt') });
      return result === null ? null : true;
    },
    /**
     * A page of v1 records (seq order) and the opaque `v2:` cursor for the next
     * older page. Without a `limit` (and without `before`) the whole history is
     * read (bounded by {@link V2_MAX_PAGES}).
     * @param {string} sessionID
     * @param {{ limit?: number, before?: string }} [page]
     */
    async messages(sessionID, page = {}, options = {}) {
      const info = await readSessionInfo(sessionID, options, 'sessions.messages');
      if (info === null) return null;
      const context = sessionMessageContext(info) ?? { sessionID };
      const hasLimit = Number.isSafeInteger(page.limit) && page.limit > 0;
      if (!hasLimit && !isNonEmptyString(page.before)) {
        const rows = await readAllMessageRows(sessionID, options, 'sessions.messages');
        return { records: projectMessagePage(rows, context).records, cursor: undefined };
      }
      try {
        const filled = await fillMessagePage({
          limit: hasLimit ? page.limit : V2_MESSAGE_PAGE_MAX,
          before: page.before,
          fetchPage: messagePageFetcher(sessionID, options, 'sessions.messages'),
          context,
        });
        return { records: filled.records, cursor: filled.nextCursor };
      } catch (error) {
        if (error instanceof InvalidMessageCursorError) {
          throw createOpenCodeClientError(C.invalidCursor, 400, error.message, { operation: 'sessions.messages', generation: 2, cause: error });
        }
        if (error instanceof InvalidMessagePageError) {
          throw createOpenCodeClientError(C.invalidResponse, 502, error.message, { operation: 'sessions.messages', generation: 2, cause: error });
        }
        throw error;
      }
    },
    /**
     * One v1 record. A compaction's summary assistant is addressed as
     * `<mid>:summary`. Assistant ownership comes from the native sequence.
     */
    async message(sessionID, messageID, options = {}) {
      const summary = typeof messageID === 'string' && messageID.endsWith(':summary');
      const baseID = summary ? messageID.slice(0, -':summary'.length) : messageID;
      const body = await request({ ...pass(options, 'sessions.message'), path: sessionPath(sessionID, `/message/${encode(baseID)}`) });
      if (body === null) return null;
      const row = unwrapData(body);
      const info = await readSessionInfo(sessionID, options, 'sessions.message');
      if (info === null) return null;
      const context = sessionMessageContext(info) ?? { sessionID };
      // Native message Info omits seq. Read through its preceding parent in
      // the unfiltered sequence rather
      // than reconstructing a turn from timestamps or a filtered user index.
      const rows = isRecord(row) && (row.type === 'assistant' || row.type === 'shell')
        ? await readAllMessageRows(sessionID, options, 'sessions.message', baseID) : [row];
      const record = projectMessagePage(rows, context).records.find((candidate) => candidate.info.id === messageID);
      if (record) return record;
      if (options.allowNotFound === true) return null;
      throw notFound('sessions.message', `message ${messageID}`);
    },
    /**
     * Patch-free per-turn file counts from edit/write/patch tool metadata (B.6,
     * F8: 2.0.20 serves no snapshot diff with `snapshots:false`). With a user
     * `messageID` the counts of that turn, otherwise the session's sum.
     */
    async diff(sessionID, query = {}, options = {}) {
      const info = await readSessionInfo(sessionID, options, 'sessions.diff');
      if (info === null) return null;
      const rows = await readAllMessageRows(sessionID, options, 'sessions.diff');
      const byTurn = turnSummaryDiffs(projectMessagePage(rows, sessionMessageContext(info) ?? { sessionID }).records);
      if (isNonEmptyString(query.messageID)) return byTurn.get(query.messageID) ?? [];
      return mergeTurnDiffs(byTurn);
    },
    /** The owned `metadata.devryan.todo` list (B.6); empty until the Phase 4 writer exists. */
    async todo(sessionID, options = {}) {
      const info = await readSessionInfo(sessionID, options, 'sessions.todo');
      return info === null ? null : toV1SessionTodos(info);
    },
  };

  const admissionUnavailable = (operation) => createOpenCodeClientError(C.admissionUnavailable, 503,
    `${operation} needs the gen-2 admission module`, { operation, generation: 2, retryable: false });

  const prompts = {
    /** B.5: selection switching and `POST /prompt` belong to the admission module. */
    async prompt(sessionID, body, options = {}) {
      const admission = resolveAdmission();
      if (typeof admission?.prompt !== 'function') throw admissionUnavailable('prompts.prompt');
      return await admission.prompt(sessionID, body, options);
    },
    async command(sessionID, body, options = {}) {
      const admission = resolveAdmission();
      if (typeof admission?.command !== 'function') throw admissionUnavailable('prompts.command');
      return await admission.command(sessionID, body, options);
    },
    /** `POST /compact`, through admission when it serializes compaction. */
    async compact(sessionID, body = {}, options = {}) {
      const admission = resolveAdmission();
      if (typeof admission?.compact === 'function') return await admission.compact(sessionID, body, options);
      const result = await request({
        ...pass(options, 'prompts.compact', V2_DISPATCH_REQUEST_TIMEOUT_MS),
        method: 'POST',
        path: sessionPath(sessionID, '/compact'),
        body: {},
      });
      return result === null ? null : true;
    },
  };

  const listPermissionRows = async (directory, options, label) => unwrapList(await request({
    ...pass(options, label), allowNotFound: false, path: '/api/permission/request', directory,
  }));

  const listFormRows = async (directory, options, label) => unwrapList(await request({
    ...pass(options, label), allowNotFound: false, path: '/api/form', directory,
  }));

  /** The session of a permission or form: explicit, the live projector, then the directory list. */
  const resolveOwner = async ({ id, options, label, fromProjector, listRows }) => {
    if (isNonEmptyString(options.sessionID)) return options.sessionID;
    const live = fromProjector(resolveProjector(), id);
    if (isNonEmptyString(live)) return live;
    const rows = await listRows(options.directory, options, label);
    const row = rows.find((candidate) => isRecord(candidate) && candidate.id === id);
    return isRecord(row) && isNonEmptyString(row.sessionID) ? row.sessionID : null;
  };

  const invalidInput = (operation, message) => createOpenCodeClientError(C.invalidInput, 400, `${operation}: ${message}`, { operation, generation: 2 });

  /** Form ids with a cancel in flight, so concurrent lists cancel once. */
  const cancellingForms = new Set();

  /**
   * `DELETE /api/session/:sid/form/:id` (form.cancel) for each entry of
   * `projectFormList(...).cancel`. Best effort: a failed cancel is a
   * diagnostic, never a failed list; an already settled form (404) is done.
   * @param {readonly { formID: string, sessionID: string, diagnostic: Record<string, unknown> }[]} entries
   */
  const cancelUnaskableForms = async (entries, options) => {
    const pending = entries.filter((entry) => !cancellingForms.has(entry.formID));
    await Promise.all(pending.map(async (entry) => {
      cancellingForms.add(entry.formID);
      const base = { ...entry.diagnostic, generation: 2, operation: 'questions.list', action: 'cancel' };
      try {
        await request({
          ...pass(options, 'questions.list'),
          allowNotFound: true,
          method: 'DELETE',
          path: sessionPath(entry.sessionID, `/form/${encode(entry.formID)}`),
        });
        recordDiagnostic({ ...base, outcome: 'cancelled' });
      } catch (error) {
        recordDiagnostic({ ...base, outcome: 'cancel_failed', errorCode: typeof error?.code === 'string' ? error.code : null });
      } finally {
        cancellingForms.delete(entry.formID);
      }
    }));
  };

  const interaction = {
    permissions: {
      async list(query = {}, options = {}) {
        return toV1PermissionRequests(await listPermissionRows(query.directory, options, 'permissions.list'));
      },
      /**
       * v1 `{reply, message?}` -> `POST /api/session/:sid/permission/:id/reply {decision, message?}`.
       * @param {{ directory?: string, sessionID?: string }} [options]
       */
      async reply(requestID, body, options = {}) {
        const reply = toV2PermissionReply(body);
        if (!reply.ok) throw invalidInput('permissions.reply', reply.message);
        const sessionID = await resolveOwner({
          id: requestID, options, label: 'permissions.reply',
          fromProjector: (projector, id) => projector?.permissionSession?.(id), listRows: listPermissionRows,
        });
        if (!sessionID) {
          if (options.allowNotFound === true) return null;
          throw notFound('permissions.reply', `permission ${requestID}`);
        }
        const result = await request({
          ...pass(options, 'permissions.reply'),
          method: 'POST',
          path: sessionPath(sessionID, `/permission/${encode(requestID)}/reply`),
          body: reply.body,
        });
        return result === null ? null : true;
      },
    },
    questions: {
      /**
       * Forms that map become questions. A pending form no question card can
       * answer (an `external` field, or no usable field) is cancelled with a
       * diagnostic (B.6, F15 default), so one that predates the event stream
       * (cold start, gap) never stalls its session. Malformed rows are reported.
       */
      async list(query = {}, options = {}) {
        const projected = projectFormList(await listFormRows(query.directory, options, 'questions.list'));
        await cancelUnaskableForms(projected.cancel, options);
        for (const diagnostic of projected.ignored) recordDiagnostic({ ...diagnostic, generation: 2, operation: 'questions.list' });
        return projected.questions;
      },
      /** v1 `{answers: string[][]}` -> `Form.Answer` on `POST /api/session/:sid/form/:id/reply`. */
      async reply(requestID, body, options = {}) {
        const sessionID = await resolveOwner({
          id: requestID, options, label: 'questions.reply',
          fromProjector: (projector, id) => projector?.formSession?.(id), listRows: listFormRows,
        });
        if (!sessionID) {
          if (options.allowNotFound === true) return null;
          throw notFound('questions.reply', `question ${requestID}`);
        }
        const formBody = await request({ ...pass(options, 'questions.reply'), path: sessionPath(sessionID, `/form/${encode(requestID)}`) });
        if (formBody === null) return null;
        const answer = toV2FormAnswer(unwrapData(formBody), isRecord(body) ? body.answers : undefined);
        if (!answer.ok) throw invalidInput('questions.reply', answer.message);
        const result = await request({
          ...pass(options, 'questions.reply'),
          method: 'POST',
          path: sessionPath(sessionID, `/form/${encode(requestID)}/reply`),
          body: { answer: answer.answer },
        });
        return result === null ? null : true;
      },
      /** v1 reject -> `DELETE /api/session/:sid/form/:id` (form.cancel). */
      async reject(requestID, options = {}) {
        const sessionID = await resolveOwner({
          id: requestID, options, label: 'questions.reject',
          fromProjector: (projector, id) => projector?.formSession?.(id), listRows: listFormRows,
        });
        if (!sessionID) {
          if (options.allowNotFound === true) return null;
          throw notFound('questions.reject', `question ${requestID}`);
        }
        const result = await request({ ...pass(options, 'questions.reject'), method: 'DELETE', path: sessionPath(sessionID, `/form/${encode(requestID)}`) });
        return result === null ? null : true;
      },
    },
  };

  const read = async (path, query, options, label) => await request({ ...pass(options, label), path, directory: query.directory });

  const providerCatalog = async (query, options, label) => {
    const [providers, models, defaultModel] = await Promise.all([
      read('/api/provider', query, options, label),
      read('/api/model', query, options, label),
      read('/api/model/default', query, options, label),
    ]);
    return { providers: unwrapList(providers), models: unwrapList(models), defaultModel: unwrapData(defaultModel) };
  };

  const runtimePaths = () => {
    const runtime = readOpenCodeRuntime(deps.getRuntime);
    return isRecord(runtime.paths) ? runtime.paths : {};
  };

  const catalog = {
    async agents(query = {}, options = {}) {
      return toV1Agents(unwrapList(await read('/api/agent', query, options, 'catalog.agents')));
    },
    /** v1 `/config/providers`: `{providers, default}`. */
    async providers(query = {}, options = {}) {
      return toV1ConfigProviders(await providerCatalog(query, options, 'catalog.providers'));
    },
    /** v1 `/provider`: `{all, default, connected}`. */
    async providerList(query = {}, options = {}) {
      return toV1ProviderList(await providerCatalog(query, options, 'catalog.providerList'));
    },
    async commands(query = {}, options = {}) {
      const [commands, config] = await Promise.all([
        read('/api/command', query, options, 'catalog.commands'),
        read('/api/config', query, options, 'catalog.commands'),
      ]);
      return toV1Commands(unwrapList(commands), { config: toV1Config(unwrapList(config)) });
    },
    async skills(query = {}, options = {}) {
      return toV1Skills(unwrapList(await read('/api/skill', query, options, 'catalog.skills')));
    },
    async mcp(query = {}, options = {}) {
      return toV1McpStatus(unwrapList(await read('/api/mcp', query, options, 'catalog.mcp')));
    },
    /** The merged v1 view of the `/api/config` entry list. */
    async config(query = {}, options = {}) {
      return toV1Config(unwrapList(await read('/api/config', query, options, 'catalog.config')));
    },
    async project(query = {}, options = {}) {
      const [location, projects] = await Promise.all([
        read('/api/location', query, options, 'catalog.project'),
        request({ ...pass(options, 'catalog.project'), path: '/api/project' }),
      ]);
      return toV1CurrentProject(unwrapData(location), unwrapList(projects));
    },
    /** home/state/config come from the runtime (`getRuntime().paths`); v2 serves none. */
    async path(query = {}, options = {}) {
      return toV1Path(unwrapData(await read('/api/location', query, options, 'catalog.path')), runtimePaths());
    },
    async vcs(query = {}, options = {}) {
      return toV1VcsInfo(unwrapData(await read('/api/vcs', query, options, 'catalog.vcs')));
    },
    /**
     * The host's sealed tool snapshot (`GET /devryan/tools`, C.6) in v1 tool
     * names: `{ids, definitions}`; `definitions` is `null` unless a provider and
     * model are given, as on gen 1.
     */
    async tools(query = {}, options = {}) {
      const withModel = isNonEmptyString(query.providerID) && isNonEmptyString(query.modelID);
      const body = await request({
        ...pass(options, 'catalog.tools'),
        path: '/devryan/tools',
        directory: query.directory,
        query: withModel ? { providerID: query.providerID, modelID: query.modelID } : {},
      });
      if (body === null) return null;
      const snapshot = isRecord(body) ? body : {};
      return { ids: projectToolIds(snapshot.ids), definitions: withModel ? projectToolDefinitions(snapshot.definitions) : null };
    },
  };

  const health = {
    /** Canonical native version read; this does not assert DevRyan readiness. */
    async runtimeInfo(options = {}) {
      const body = await request({ ...pass(options, 'health.runtimeInfo'), allowNotFound: false, path: '/api/info' });
      if (!isRecord(body) || !isNonEmptyString(body.version) || body.version.trim() !== body.version) {
        throw createOpenCodeClientError(C.invalidResponse, 502, 'health.runtimeInfo returned invalid native version info',
          { operation: 'health.runtimeInfo', generation: 2 });
      }
      return { version: body.version };
    },
    /** `GET /devryan/ready` plus `GET /api/info` at the pinned version (C.4). */
    async probe(options = {}) {
      const headers = await getAuthHeaders();
      return await probe({
        ...options,
        propagateReadFailures: true,
        generation: 2,
        baseUrl: String(readOpenCodeRuntime(deps.getRuntime).baseUrl ?? ''),
        headers,
        fetchImpl: (...args) => {
          readOpenCodeRuntime(deps.getRuntime);
          return fetchImpl(...args);
        },
      });
    },
  };

  const events = {
    /** The global 2.0.20 stream; there is no per-directory upstream stream (B.7). */
    url() {
      return `${String(readOpenCodeRuntime(deps.getRuntime).baseUrl ?? '').replace(/\/+$/, '')}/api/event`;
    },
    parseBlock(block) {
      return parseV2EventBlock(block);
    },
    /** A fresh gen-2 event projector (item 5). */
    createProjector(options = {}) {
      return createEventProjector({ recordDiagnostic, ...options });
    },
  };

  return Object.freeze({ generation: 2, sessions, prompts, interaction, catalog, health, events });
};

/** Re-exported for callers that need to recognise the 204 sentinel. */
export { isNoContent, NO_CONTENT };
