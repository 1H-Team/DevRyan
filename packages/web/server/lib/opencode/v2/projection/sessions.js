// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) `Session.Info` -> DevRyan's v1 Session record (B.3).
//
//   id, projectID, parentID, title (?? ''), agent, model, cost, tokens   as is
//   slug        cached from `session.created` (v2 records have none), else id
//   directory   location.directory          path        subpath
//   version     '2'                         permission  permissions (v1 rule shape)
//   time        {created, updated, archived}; archived = the DevRyan archive
//               override in metadata.devryan.archive when it is owned by this
//               session, otherwise the read-only v2 time.archived
//   revert      {messageID, partID?, snapshot?, files? without patch bodies}
//   metadata    v2 metadata without the `devryan` internals
//
// A fork has `fork{sessionID, boundary}` and no parentID in v2; it stays a
// root (parentID undefined) so sidebar grouping never treats it as a child.
// `share` and `summary` have no v2 source and are absent.
//
// metadata.devryan entries (archive, todo) carry the owner `sessionID`: v2
// children and forks inherit the parent's whole metadata (F4), so an entry
// whose owner is another session is ignored. Every lossy field is tagged
// `LOSS(<key>)` against the semantic-loss register in `v2/codemap.md`.
// Everything here is pure.
// ---------------------------------------------------------------------------

import { toV1PathInfo } from './messages.js';
import { toV1ToolName } from './tools.js';

export const DEVRYAN_METADATA_KEY = 'devryan';
export const V1_SESSION_VERSION = '2';

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const finiteOr = (value, fallback) => (isFiniteNumber(value) ? value : fallback);

// ---------------------------------------------------------------------------
// metadata.devryan (owner guard)
// ---------------------------------------------------------------------------

/**
 * One `metadata.devryan[key]` entry when its owner is `sessionID`, else `undefined`.
 * @param {unknown} metadata the v2 session metadata
 * @param {string} key
 * @param {unknown} sessionID
 * @returns {Record<string, unknown> | undefined}
 */
export const readOwnedDevryanEntry = (metadata, key, sessionID) => {
  if (!isRecord(metadata) || !isNonEmptyString(sessionID)) return undefined;
  const devryan = metadata[DEVRYAN_METADATA_KEY];
  if (!isRecord(devryan)) return undefined;
  const entry = devryan[key];
  if (!isRecord(entry) || entry.sessionID !== sessionID) return undefined;
  return entry;
};

/**
 * The DevRyan archive override (B.6): `{at: number}` archived, `{at: null}`
 * explicitly unarchived, `undefined` when no owned override exists.
 * @param {unknown} metadata
 * @param {unknown} sessionID
 * @returns {{ at: number | null } | undefined}
 */
export const readArchiveOverride = (metadata, sessionID) => {
  const entry = readOwnedDevryanEntry(metadata, 'archive', sessionID);
  if (!entry) return undefined;
  if (entry.at === null) return { at: null };
  return isFiniteNumber(entry.at) ? { at: entry.at } : undefined;
};

const isTodoItem = (item) => (
  isRecord(item) && typeof item.content === 'string' && typeof item.status === 'string'
);

/**
 * The owned durable todo list (B.6) `{items, rev}`, or `null` when the session
 * has none of its own (absent, malformed, or inherited from a parent or fork
 * origin). Until the Phase 4 writer exists, gen-2 todos read as empty.
 * @param {unknown} metadata
 * @param {unknown} sessionID
 * @returns {{ items: Record<string, unknown>[], rev: number } | null}
 */
export const readSessionTodo = (metadata, sessionID) => {
  const entry = readOwnedDevryanEntry(metadata, 'todo', sessionID);
  if (!entry || !Array.isArray(entry.items)) return null;
  // Items are v1 Todo records written by DevRyan's own writer; malformed ones are skipped.
  return { items: entry.items.filter(isTodoItem), rev: finiteOr(entry.rev, 0) };
};

/**
 * v1 `GET /session/:id/todo` body from a v2 session record.
 * @param {unknown} session the v2 `Session.Info`
 * @returns {Record<string, unknown>[]}
 */
export const toV1SessionTodos = (session) => {
  if (!isRecord(session)) return [];
  return readSessionTodo(session.metadata, session.id)?.items ?? [];
};

/**
 * The v2 metadata without DevRyan internals; `undefined` when nothing else remains.
 * @param {unknown} metadata
 * @returns {Record<string, unknown> | undefined}
 */
export const stripDevryanMetadata = (metadata) => {
  if (!isRecord(metadata)) return undefined;
  if (!Object.hasOwn(metadata, DEVRYAN_METADATA_KEY)) {
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }
  const { [DEVRYAN_METADATA_KEY]: _devryan, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
};

// ---------------------------------------------------------------------------
// Field projections
// ---------------------------------------------------------------------------

/**
 * v1 PermissionRuleset `{permission, pattern, action}` from a v2 Ruleset
 * `{action, resource, effect}`. Action names use the v1 tool vocabulary.
 * @param {unknown} rules
 * @returns {{ permission: string, pattern: string, action: string }[] | undefined}
 */
export const toV1PermissionRuleset = (rules) => {
  if (!Array.isArray(rules)) return undefined;
  const projected = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.action !== 'string' || typeof rule.resource !== 'string'
      || typeof rule.effect !== 'string') continue;
    projected.push({ permission: toV1ToolName(rule.action), pattern: rule.resource, action: rule.effect });
  }
  return projected;
};

/**
 * v1 `revert` without patch bodies (B.3, [sm M48]).
 * LOSS(revert-diff): v1 `revert.diff` has no v2 source; `files[]` keep only counts.
 * @param {unknown} revert
 */
export const toV1Revert = (revert) => {
  if (!isRecord(revert) || !isNonEmptyString(revert.messageID)) return undefined;
  const projected = { messageID: revert.messageID };
  if (isNonEmptyString(revert.partID)) projected.partID = revert.partID;
  if (isNonEmptyString(revert.snapshot)) projected.snapshot = revert.snapshot;
  if (Array.isArray(revert.files)) {
    projected.files = revert.files.filter(isRecord).map((file) => {
      const { patch: _patch, ...counts } = file;
      return counts;
    });
  }
  return projected;
};

const toV1Tokens = (tokens) => {
  if (!isRecord(tokens)) return undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return {
    input: finiteOr(tokens.input, 0),
    output: finiteOr(tokens.output, 0),
    reasoning: finiteOr(tokens.reasoning, 0),
    cache: { read: finiteOr(cache.read, 0), write: finiteOr(cache.write, 0) },
  };
};

const toV1Model = (model) => {
  if (!isRecord(model) || typeof model.id !== 'string' || typeof model.providerID !== 'string') return undefined;
  return typeof model.variant === 'string'
    ? { id: model.id, providerID: model.providerID, variant: model.variant }
    : { id: model.id, providerID: model.providerID };
};

/**
 * The session's location directory, or `undefined`.
 * @param {unknown} session the v2 `Session.Info`
 * @returns {string | undefined}
 */
export const sessionDirectory = (session) => {
  if (!isRecord(session) || !isRecord(session.location)) return undefined;
  return isNonEmptyString(session.location.directory) ? session.location.directory : undefined;
};

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ToV1SessionOptions
 * @property {string} [slug] the slug cached from `session.created`
 */

/**
 * Projects a v2 `Session.Info` into the v1 Session record. Returns `undefined`
 * for input without an id.
 * @param {unknown} info
 * @param {ToV1SessionOptions} [options]
 * @returns {Record<string, unknown> | undefined}
 */
export const toV1Session = (info, options = {}) => {
  if (!isRecord(info) || !isNonEmptyString(info.id)) return undefined;
  const time = isRecord(info.time) ? info.time : {};
  const created = finiteOr(time.created, 0);
  const archiveOverride = readArchiveOverride(info.metadata, info.id);
  const archived = archiveOverride ? archiveOverride.at : time.archived;
  const projectedTime = { created, updated: finiteOr(time.updated, created) };
  if (isFiniteNumber(archived)) projectedTime.archived = archived;
  // LOSS(session-time): `time.idle` and `time.viewed` have no v1 field; `outcome` is dropped.

  const session = {
    id: info.id,
    // LOSS(session-slug): only `session.created` carries the slug; uncached sessions use their id.
    slug: isNonEmptyString(options.slug) ? options.slug : info.id,
    projectID: typeof info.projectID === 'string' ? info.projectID : '',
    directory: sessionDirectory(info) ?? '',
    title: typeof info.title === 'string' ? info.title : '',
    version: V1_SESSION_VERSION,
    time: projectedTime,
  };
  if (typeof info.subpath === 'string' && info.subpath.length > 0) session.path = info.subpath;
  // A fork has no parentID; LOSS(fork-lineage): `fork{sessionID, boundary}` is not projected.
  if (isNonEmptyString(info.parentID)) session.parentID = info.parentID;
  if (isNonEmptyString(info.agent)) session.agent = info.agent;
  const model = toV1Model(info.model);
  if (model) session.model = model;
  if (isFiniteNumber(info.cost)) session.cost = info.cost;
  const tokens = toV1Tokens(info.tokens);
  if (tokens) session.tokens = tokens;
  const metadata = stripDevryanMetadata(info.metadata);
  if (metadata) session.metadata = metadata;
  const permission = toV1PermissionRuleset(info.permissions);
  if (permission) session.permission = permission;
  const revert = toV1Revert(info.revert);
  if (revert) session.revert = revert;
  // LOSS(session-share-summary): `share` and `summary` are absent ([sm M29]).
  return session;
};

/**
 * v1 Session from `session.created` event data, whose id field is `sessionID`
 * and whose creation time is the envelope `created` ([ev M10]). The event's
 * `slug` is used; its `version` is replaced by {@link V1_SESSION_VERSION}.
 * @param {unknown} data
 * @param {unknown} created envelope `created` (epoch ms)
 */
export const toV1SessionFromCreated = (data, created) => {
  if (!isRecord(data) || !isNonEmptyString(data.sessionID)) return undefined;
  const { sessionID, slug, version: _version, ...rest } = data;
  const time = isFiniteNumber(created) ? { created, updated: created } : {};
  return toV1Session({ ...rest, id: sessionID, time }, { slug: typeof slug === 'string' ? slug : undefined });
};

/**
 * The v1 `GET /session` body from a v2 `{data, cursor}` list body (or a bare
 * array). Rows without an id are dropped.
 * @param {unknown} body
 * @param {{ slugOf?: (sessionID: string) => string | undefined }} [options]
 * @returns {Record<string, unknown>[]}
 */
export const toV1SessionList = (body, options = {}) => {
  let rows = [];
  if (Array.isArray(body)) rows = body;
  else if (isRecord(body) && Array.isArray(body.data)) rows = body.data;
  const slugOf = typeof options.slugOf === 'function' ? options.slugOf : () => undefined;
  const sessions = [];
  for (const row of rows) {
    if (!isRecord(row) || !isNonEmptyString(row.id)) continue;
    const session = toV1Session(row, { slug: slugOf(row.id) });
    if (session) sessions.push(session);
  }
  return sessions;
};

/**
 * Whether a projected v1 session is archived (v2 has no archived filter, so
 * the façade filters projected lists with this).
 * @param {unknown} session a v1 Session
 */
export const isV1SessionArchived = (session) => (
  isRecord(session) && isRecord(session.time) && isFiniteNumber(session.time.archived)
);

/**
 * The page context for {@link import('./messages.js').projectMessagePage}
 * from a v2 `Session.Info`.
 * @param {unknown} info
 * @returns {import('./messages.js').MessagePageContext | undefined}
 */
export const sessionMessageContext = (info) => {
  if (!isRecord(info) || !isNonEmptyString(info.id)) return undefined;
  const { cwd, root } = toV1PathInfo(sessionDirectory(info), info.subpath);
  /** @type {import('./messages.js').MessagePageContext} */
  const context = { sessionID: info.id, directory: root, cwd };
  if (isNonEmptyString(info.agent)) context.agent = info.agent;
  const model = toV1Model(info.model);
  if (model) context.model = model;
  return context;
};
