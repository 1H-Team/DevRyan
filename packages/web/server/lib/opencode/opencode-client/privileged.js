// ---------------------------------------------------------------------------
// The privileged OpenCode client (DESIGN.md C.1, C.3 `privileged` class).
//
// These operations bypass what a browser or an ordinary server module may do:
// revert stage/clear/commit, synthetic inbox items (spoofable as subagent
// completions), session instructions, permission rulesets, raw metadata,
// selection switches, location reloads, child sessions with rules or metadata,
// and Cursor transcript injection. Only the allowlisted modules import this
// file (or the privileged requester in `requester.js`): the admission module,
// the scoped-revert coordinator, config apply and the session execution host.
// `opencode-client.contract.test.js` enforces the allowlist, and `index.js`
// never re-exports either, so the factory cannot reach route-handler deps.
//
// The operations exist on OpenCode 2 only. On gen 1 every one raises
// `capability_unavailable`: the gen-1 callers keep their existing companion
// paths until those are migrated.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { createHash } from 'node:crypto';
import { isNativeTurnParent } from '../../../../../shared-runtime/lib/native-message-status.js';
import { sessionMessageContext, toV1Revert, toV1Session } from '../v2/projection/sessions.js';
import { decodeMessageCursor, encodeMessageCursor, projectMessagePage, V2_MESSAGE_PAGE_MAX } from '../v2/projection/messages.js';
import { unwrapData } from './envelope.js';
import {
  createCapabilityUnavailableError,
  createOpenCodeClientError,
  createInvalidResponseError,
  OPENCODE_CLIENT_ERROR_CODES,
} from './errors.js';
import { createV2AudienceRequester } from './requester.js';
import { toV2ModelRef } from './v2.js';
import { readOpenCodeRuntime, withOpenCodeRuntime } from './runtime.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const encode = (value) => encodeURIComponent(String(value));

const DISPATCH_TIMEOUT_MS = 30_000;

const invalidInput = (operation, message) => createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.invalidInput, 400,
  `${operation}: ${message}`, { operation, generation: 2 });

/**
 * Creates the privileged client. Takes the same deps as `createOpenCodeClient`.
 * @param {import('./v2.js').V2BackendDeps} deps
 */
export const createPrivilegedOpenCodeClient = (deps) => {
  if (!deps || typeof deps.getRuntime !== 'function') throw new TypeError('getRuntime is required');
  const request = createV2AudienceRequester(deps, { audience: 'privileged' });

  /** Gen 2 only: resolves the generation per call (the runtime can change). */
  const gen2 = (operation, run) => async (...args) => withOpenCodeRuntime(deps.getRuntime, operation, async () => {
    const generation = readOpenCodeRuntime(deps.getRuntime).generation;
    if (generation !== 2) {
      throw createCapabilityUnavailableError(operation, { operation, generation: generation === 1 ? 1 : null });
    }
    return await run(...args);
  });

  const pass = (options = {}, label, defaultTimeoutMs) => ({
    label,
    allowNotFound: options.allowNotFound === true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    onResponseRead: options.onResponseRead,
    defaultTimeoutMs,
  });

  const sessionPath = (sessionID, suffix = '') => `/api/session/${encode(sessionID)}${suffix}`;
  const done = (result) => (result === null ? null : true);

  const revert = Object.freeze({
    /** `{messageID, files?}` -> the staged v1 revert (patch bodies dropped). */
    stage: gen2('revert.stage', async (sessionID, input = {}, options = {}) => {
      if (!isNonEmptyString(input.messageID)) throw invalidInput('revert.stage', 'messageID is required');
      const body = await request({
        ...pass(options, 'revert.stage'),
        method: 'POST',
        path: sessionPath(sessionID, '/revert/stage'),
        body: { messageID: input.messageID, ...(typeof input.files === 'boolean' ? { files: input.files } : {}) },
      });
      return body === null ? null : (toV1Revert(unwrapData(body)) ?? null);
    }),
    clear: gen2('revert.clear', async (sessionID, options = {}) => done(await request({
      ...pass(options, 'revert.clear'), method: 'DELETE', path: sessionPath(sessionID, '/revert'),
    }))),
    commit: gen2('revert.commit', async (sessionID, options = {}) => done(await request({
      ...pass(options, 'revert.commit'), method: 'POST', path: sessionPath(sessionID, '/revert/commit'),
    }))),
  });

  /**
   * `{id?, text, description?, metadata?, delivery?, resume?}` -> the inbox item.
   * The route policy refuses `metadata.source: 'subagent'` (G1 verifier item 2).
   */
  const synthetic = gen2('synthetic', async (sessionID, input = {}, options = {}) => {
    if (typeof input.text !== 'string') throw invalidInput('synthetic', 'text is required');
    const body = await request({
      ...pass(options, 'synthetic', DISPATCH_TIMEOUT_MS),
      method: 'POST',
      path: sessionPath(sessionID, '/synthetic'),
      body: {
        text: input.text,
        ...(isNonEmptyString(input.id) ? { id: input.id } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
        ...(input.delivery === 'steer' || input.delivery === 'queue' ? { delivery: input.delivery } : {}),
        ...(typeof input.resume === 'boolean' ? { resume: input.resume } : {}),
      },
    });
    return body === null ? null : unwrapData(body);
  });

  const instructions = Object.freeze({
    put: gen2('instructions.put', async (sessionID, key, value, options = {}) => done(await request({
      ...pass(options, 'instructions.put'),
      method: 'PUT',
      path: `/api/experimental/session/${encode(sessionID)}/instructions/entries/${encode(key)}`,
      body: { value },
    }))),
    remove: gen2('instructions.remove', async (sessionID, key, options = {}) => done(await request({
      ...pass(options, 'instructions.remove'),
      method: 'DELETE',
      path: `/api/experimental/session/${encode(sessionID)}/instructions/entries/${encode(key)}`,
    }))),
  });

  /** Replaces the session ruleset (v2 `Permission.Ruleset`; the v1 rule mapping is Phase 4). */
  const setPermissions = gen2('setPermissions', async (sessionID, permissions, options = {}) => {
    if (!Array.isArray(permissions)) throw invalidInput('setPermissions', 'permissions must be a ruleset array');
    return done(await request({ ...pass(options, 'setPermissions'), method: 'PATCH', path: sessionPath(sessionID), body: { permissions } }));
  });

  /** Replaces the whole metadata map (PATCH replaces, F4). */
  const setMetadata = gen2('setMetadata', async (sessionID, metadata, options = {}) => {
    if (!isRecord(metadata)) throw invalidInput('setMetadata', 'metadata must be an object');
    return done(await request({ ...pass(options, 'setMetadata'), method: 'PATCH', path: sessionPath(sessionID), body: { metadata } }));
  });

  /** Internal owners need the original map for a whole-map CAS; the public projection deliberately hides it. */
  const readSessionMetadata = gen2('readSessionMetadata', async (sessionID, options = {}) => {
    if (!isNonEmptyString(sessionID) || !path.isAbsolute(options.directory ?? '') || options.directory.includes('\0')) {
      throw invalidInput('readSessionMetadata', 'sessionID and absolute directory are required');
    }
    const body = await request({ ...pass(options, 'readSessionMetadata'), method: 'GET', path: sessionPath(sessionID),
      maxResponseBytes: Math.min(Number.isSafeInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
        ? options.maxResponseBytes : 1024 * 1024, 1024 * 1024) });
    if (body === null) return null;
    const session = unwrapData(body);
    if (!isRecord(session) || session.id !== sessionID || session.location?.directory !== options.directory
      || session.metadata !== undefined && !isRecord(session.metadata)) {
      throw createInvalidResponseError({ label: 'readSessionMetadata', generation: 2 });
    }
    return { id: sessionID, directory: options.directory, metadata: structuredClone(session.metadata ?? {}) };
  });

  /** Internal accepted-command evidence; the public message projection hides this map. */
  const readUserMessage = gen2('readUserMessage', async (sessionID, messageID, options = {}) => {
    if (!/^ses[A-Za-z0-9_-]{1,128}$/.test(sessionID ?? '') || !/^msg[A-Za-z0-9_-]{1,128}$/.test(messageID ?? '')
      || !path.isAbsolute(options.directory ?? '') || options.directory.includes('\0')) {
      throw invalidInput('readUserMessage', 'canonical session, message and directory are required');
    }
    const session = await readSessionMetadata(sessionID, options);
    if (!session) return null;
    const body = await request({ ...pass(options, 'readUserMessage'), method: 'GET', path: sessionPath(sessionID, `/message/${encode(messageID)}`),
      maxResponseBytes: 4 * 1024 * 1024 });
    if (body === null) return null;
    const message = unwrapData(body);
    if (!isRecord(message) || message.id !== messageID || message.type !== 'user' || typeof message.text !== 'string'
      || message.metadata !== undefined && !isRecord(message.metadata)) throw createInvalidResponseError({ label: 'readUserMessage', generation: 2 });
    return { id: messageID, type: 'user', sessionID, directory: options.directory, metadata: structuredClone(message.metadata ?? {}) };
  });

  /**
   * Private native-input view. UI user records can also represent standalone
   * synthetic/skill/compaction rows; only the original native type proves an
   * actual user input. Account for every scanned row before filtering.
   * @param {string} sessionID
   * @param {{limit?:number,before?:string}} page
   * @param {{directory:string,signal?:AbortSignal,timeoutMs?:number,maxResponseBytes?:number,allowNotFound?:boolean}} options
   * @returns {Promise<{records:import('../v2/projection/messages.js').V1MessageRecord[],cursor:string|undefined,scannedCount:number,scannedBytes:number,latestTurnParent?:{id:string,type:string,fingerprint:string}}|null>}
   */
  const readCanonicalUserPage = gen2('readCanonicalUserPage', async (sessionID, page = {}, options = {}) => {
    if (options.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)) {
      throw new TypeError('maxResponseBytes must be a positive integer');
    }
    if (!/^ses[A-Za-z0-9_-]{1,128}$/.test(sessionID ?? '') || !path.isAbsolute(options.directory ?? '')
      || options.directory.includes('\0') || page.limit !== undefined && (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > V2_MESSAGE_PAGE_MAX)) {
      throw invalidInput('readCanonicalUserPage', 'canonical session, directory and bounded limit are required');
    }
    const cursor = decodeMessageCursor(page.before);
    if (cursor === null) throw invalidInput('readCanonicalUserPage', 'native cursor is required');
    const limit = page.limit ?? V2_MESSAGE_PAGE_MAX;
    const infoBody = await request({ ...pass(options, 'readCanonicalUserPage'), directory: options.directory,
      method: 'GET', path: sessionPath(sessionID), maxResponseBytes: Math.min(options.maxResponseBytes ?? 1024 * 1024, 1024 * 1024) });
    if (infoBody === null) return null;
    const info = unwrapData(infoBody);
    const context = sessionMessageContext(info);
    if (!context || info.id !== sessionID || info.location?.directory !== options.directory) {
      throw createInvalidResponseError({ label: 'readCanonicalUserPage', generation: 2 });
    }
    const body = await request({ ...pass(options, 'readCanonicalUserPage'), directory: options.directory,
      allowNotFound: false, method: 'GET', path: sessionPath(sessionID, '/message'),
      query: cursor === undefined ? { order: 'desc', limit } : { cursor, limit },
      maxResponseBytes: Math.min(options.maxResponseBytes ?? 64 * 1024 * 1024, 64 * 1024 * 1024) });
    if (!isRecord(body) || !Array.isArray(body.data) || body.data.length > limit
      || body.cursor != null && !isRecord(body.cursor)
      || body.cursor?.next != null && !isNonEmptyString(body.cursor.next)
      || body.data.some(row => !isRecord(row) || !/^msg[A-Za-z0-9_-]{1,128}$/.test(row.id ?? '') || typeof row.type !== 'string')) {
      throw createInvalidResponseError({ label: 'readCanonicalUserPage', generation: 2 });
    }
    const parent = body.data.find(isNativeTurnParent);
    const latestTurnParent = parent && { id: parent.id, type: parent.type, fingerprint: createHash('sha256').update(JSON.stringify(parent)).digest('hex') };
    const userIDs = new Set(body.data.filter(row => row.type === 'user').map(row => row.id));
    const records = projectMessagePage([...body.data].reverse(), context).records.filter(row => userIDs.has(row.info.id));
    if (records.length !== userIDs.size || records.some(row => row.info.role !== 'user' || row.info.sessionID !== sessionID)) {
      throw createInvalidResponseError({ label: 'readCanonicalUserPage', generation: 2 });
    }
    return { records, ...(latestTurnParent ? { latestTurnParent } : {}), cursor: body.data.length === limit && body.cursor?.next ? encodeMessageCursor(body.cursor.next) : undefined,
      scannedCount: body.data.length, scannedBytes: Buffer.byteLength(JSON.stringify(body)) };
  });

  const switchAgent = gen2('switchAgent', async (sessionID, agent, options = {}) => {
    if (!isNonEmptyString(agent)) throw invalidInput('switchAgent', 'agent is required');
    return done(await request({ ...pass(options, 'switchAgent'), method: 'POST', path: sessionPath(sessionID, '/agent'), body: { agent } }));
  });

  /** Accepts the v1 `{providerID, modelID, variant?}` or a v2 `Model.Ref`. */
  const switchModel = gen2('switchModel', async (sessionID, model, options = {}) => {
    const ref = toV2ModelRef(model);
    if (!ref) throw invalidInput('switchModel', 'model needs providerID and modelID');
    return done(await request({ ...pass(options, 'switchModel'), method: 'POST', path: sessionPath(sessionID, '/model'), body: { model: ref } }));
  });

  const locationReload = gen2('locationReload', async (options = {}) => done(await request({
    ...pass(options, 'locationReload'), method: 'POST', path: '/api/location/reload',
  })));

  /**
   * `POST /devryan/session` (C.6): a child session with optional rules and metadata.
   * @param {{ id?: string, parentID: string, title?: string, directory?: string, agent?: string,
   *   model?: Record<string, string>, permissions?: unknown[], metadata?: Record<string, unknown> }} input
   */
  const createChildSession = gen2('createChildSession', async (input = {}, options = {}) => {
    if (!isNonEmptyString(input.parentID)) throw invalidInput('createChildSession', 'parentID is required');
    const model = toV2ModelRef(input.model);
    const body = await request({
      ...pass(options, 'createChildSession', DISPATCH_TIMEOUT_MS),
      method: 'POST',
      path: '/devryan/session',
      body: {
        parentID: input.parentID,
        ...(isNonEmptyString(input.id) ? { id: input.id } : {}),
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(isNonEmptyString(input.directory) ? { location: { directory: input.directory } } : {}),
        ...(isNonEmptyString(input.agent) ? { agent: input.agent } : {}),
        ...(model ? { model } : {}),
        ...(Array.isArray(input.permissions) ? { permissions: input.permissions } : {}),
        ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
      },
    });
    return body === null ? null : (toV1Session(unwrapData(body)) ?? null);
  });

  /** Cursor transcript injection (`POST /devryan/session/:id/external-message`, [sm M50]). */
  const externalMessage = gen2('externalMessage', async (sessionID, message, options = {}) => {
    if (!isRecord(message)) throw invalidInput('externalMessage', 'message must be a Session.Message.Info record');
    const body = await request({
      ...pass(options, 'externalMessage'),
      method: 'POST',
      path: `/devryan/session/${encode(sessionID)}/external-message`,
      body: { message },
    });
    return body === null ? null : unwrapData(body);
  });

  return Object.freeze({
    revert,
    synthetic,
    instructions,
    setPermissions,
    setMetadata,
    readSessionMetadata,
    readUserMessage,
    readCanonicalUserPage,
    switchAgent,
    switchModel,
    locationReload,
    createChildSession,
    externalMessage,
  });
};
