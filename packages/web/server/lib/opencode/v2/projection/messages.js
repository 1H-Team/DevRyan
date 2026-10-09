import { isNativeStatusMessage, isNativeTurnParent } from '../../../../../../shared-runtime/lib/native-message-status.js';
// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) message history -> DevRyan's v1 `{info, parts}` records.
//
// v2 `GET /api/session/:id/message` returns `Session.Message.Info` rows in seq
// order (asc) or reverse seq order (desc). DESIGN.md B.2 fixes how each row
// becomes zero, one or two v1 records:
//
//   user              one user record (text segments, files, agents)
//   synthetic         folded into the immediately following `user` row of the
//                     same page; otherwise one user record with a synthetic part
//   assistant         one assistant record (step-start, content, step-finish)
//   compaction        the v1 pair: user `mid` with a compaction part, plus the
//                     summary assistant `${mid}:summary`
//   shell             one assistant record with a single `bash` tool part
//   skill             one user record with a hidden synthetic part
//   system, idle,     dropped; the `*-switched` rows feed the running agent,
//   *-switched        model and location fold used by later records
//
// parentID: the nearest earlier user (or standalone synthetic, or compaction)
// record in seq order. REST page edges use unfiltered sequence lookbehind;
// only exact sequence parents receive turnOwnership evidence. A live user
// timestamp index is display-only. time.created is clamped
// to be strictly increasing in seq order (ids.js `clampIncreasingTime`).
//
// Every lossy field is tagged `LOSS(<key>)`; the keys are the entries of the
// semantic-loss register in `v2/DOCUMENTATION.md`. Everything here is pure except
// the two page-fill helpers, which only await the fetchers they are given.
// ---------------------------------------------------------------------------

import path from 'node:path';

import { toV1Error } from './errors.js';
import {
  assistantContentPartIds,
  isCursorAssistant,
  assistantTextPartId,
  assistantToolPartId,
  clampIncreasingTime,
  compactionSummaryMessageId,
  stepFinishPartId,
  stepStartPartId,
  userAgentPartId,
  userFilePartId,
  userTextPartId,
  userTextSegments,
} from './ids.js';
import { toV1ToolPart } from './tools.js';

/** Prefix of the opaque `x-next-cursor` the façade emits on gen 2. */
export const V2_MESSAGE_CURSOR_PREFIX = 'v2:';
/** v2 `limit` bounds for the message list (`1..200`). */
export const V2_MESSAGE_PAGE_MAX = 200;
/** Extra v2 page fetches allowed while filling one projected page (B.2). */
export const MAX_PAGE_FILL_EXTRA_FETCHES = 3;
/** Upper bound on unfiltered older pages read to prove a parent. */
const MAX_PARENT_LOOKUP_PAGES = 50;

const DEVRYAN_METADATA_KEY = 'devryan';
const DEVRYAN_METADATA_VERSION = 1;
const PLAN_MODE_METADATA_KEY = 'openchamberPlanMode';
const COMPACTION_AGENT = 'compaction';
const SHELL_TOOL = 'bash';
const FILE_COUNT_TOOLS = new Set(['edit', 'write', 'apply_patch']);
const FILE_STATUSES = new Set(['added', 'deleted', 'modified']);
const FOLDED_TYPES = new Set(['agent-switched', 'model-switched', 'location-switched']);
// LOSS(system-notices): migrated legacy-tool `system` notices are hidden (F16 default).
// LOSS(idle-rows): `idle` rows only end a turn; `outcome` is read from the session record.
const DROPPED_TYPES = new Set(['system', 'idle']);

const EMPTY_RECORDS = Object.freeze([]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const finiteOr = (value, fallback) => (isFiniteNumber(value) ? value : fallback);

const createdOf = (message) => (isRecord(message.time) ? message.time.created : undefined);

const completedOf = (message) => {
  if (!isRecord(message.time)) return undefined;
  return isFiniteNumber(message.time.completed) ? message.time.completed : undefined;
};

/**
 * @typedef {object} V1ModelSelection
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} [variant]
 */

/**
 * @typedef {object} V2ModelRef
 * @property {string} id
 * @property {string} providerID
 * @property {string} [variant]
 */

/**
 * @typedef {object} V1PathInfo
 * @property {string} cwd
 * @property {string} root
 */

/**
 * @typedef {object} V1MessageRecord
 * @property {Record<string, unknown>} info
 * @property {Record<string, unknown>[]} parts
 * @property {{ source: 'native-sequence', kind: 'status-only' }} [nativeStatus] private native status projection.
 * @property {{ source: 'native-sequence', userMessageID: string }} [turnOwnership]
 */

/**
 * @typedef {object} UserIndexEntry
 * @property {number} deliveredAt the user (or synthetic) row's `time.created`
 *   (equal to its `session.inbox.delivered` envelope time, F6)
 * @property {string} userID
 */

/**
 * @typedef {object} MessagePageContext
 * @property {string} sessionID stamped on every record and part.
 * @property {string} [directory] project root (v1 `path.root`).
 * @property {string} [cwd] working directory (v1 `path.cwd`); defaults to `directory`.
 * @property {string} [agent] seed for the agent fold, usually `Session.Info.agent`.
 * @property {V2ModelRef} [model] seed for the model fold, usually `Session.Info.model`.
 * @property {number} [previousTime] clamped `time.created` of the record preceding this page.
 * @property {readonly UserIndexEntry[]} [userIndex] display-only timestamp fallback.
 * @property {string} [previousParentID] exact preceding parent from unfiltered native sequence.
 * @property {import('./errors.js').ToV1ErrorOptions} [errorOptions]
 */

// ---------------------------------------------------------------------------
// Ids and small shapes
// ---------------------------------------------------------------------------

/**
 * Part id of the v1 `compaction` part on the projected compaction user record.
 * @param {string} messageID the v2 compaction message id
 */
export const compactionPartId = (messageID) => `${messageID}:compaction`;

/**
 * Part id of the summary text on the projected compaction assistant. Equal to
 * text ordinal 0 of `${mid}:summary`, which is what `session.compaction.delta`
 * streams into on the live path.
 * @param {string} messageID the v2 compaction message id
 */
export const compactionSummaryTextPartId = (messageID) => (
  assistantTextPartId(compactionSummaryMessageId(messageID), 0)
);

/**
 * v1 `tokens` (with `total`) from a v2 `TokenUsage.Info`. Missing values are 0.
 * @param {unknown} tokens
 */
export const toV1Tokens = (tokens) => {
  const usage = isRecord(tokens) ? tokens : {};
  const cache = isRecord(usage.cache) ? usage.cache : {};
  const input = finiteOr(usage.input, 0);
  const output = finiteOr(usage.output, 0);
  const reasoning = finiteOr(usage.reasoning, 0);
  const read = finiteOr(cache.read, 0);
  const write = finiteOr(cache.write, 0);
  // F11: v2 `input` is uncached input, so `total` matches TokenUsage.total.
  return { total: input + output + reasoning + read + write, input, output, reasoning, cache: { read, write } };
};

const toV2ModelRef = (model) => {
  if (!isRecord(model) || typeof model.id !== 'string' || typeof model.providerID !== 'string') return undefined;
  return typeof model.variant === 'string'
    ? { id: model.id, providerID: model.providerID, variant: model.variant }
    : { id: model.id, providerID: model.providerID };
};

/**
 * The cwd/root pair for v1 `AssistantMessage.path` from a v2 location.
 * `location.directory` is already the cwd; `subpath` is its path relative to
 * the project root, not another directory to append. Only infer a root when
 * that relative path is an exact suffix. An external or inconsistent subpath
 * cannot identify the root, so retain the authoritative cwd for both fields.
 * @param {unknown} directory
 * @param {unknown} [subpath]
 * @returns {V1PathInfo}
 */
export const toV1PathInfo = (directory, subpath) => {
  const cwd = typeof directory === 'string' ? directory : '';
  let root = cwd;
  if (cwd && isNonEmptyString(subpath) && !path.isAbsolute(subpath)) {
    const segments = subpath.split(path.sep).filter((segment) => segment !== '' && segment !== '.');
    if (segments.length > 0 && !segments.includes('..')) {
      let candidate = cwd;
      for (const _segment of segments) candidate = path.dirname(candidate);
      if (path.normalize(path.join(candidate, subpath)) === path.normalize(cwd)) root = candidate;
    }
  }
  return { cwd, root };
};

/**
 * The DevRyan prompt selection recorded in `metadata.devryan` (B.5), or `null`
 * when absent or written by an unknown metadata version.
 * @param {unknown} metadata
 * @returns {{ agent?: string, providerID?: string, modelID?: string, variant?: string | null, planMode?: boolean } | null}
 */
export const readDevryanPromptSelection = (metadata) => {
  if (!isRecord(metadata)) return null;
  const devryan = metadata[DEVRYAN_METADATA_KEY];
  if (!isRecord(devryan) || devryan.v !== DEVRYAN_METADATA_VERSION) return null;
  /** @type {{ agent?: string, providerID?: string, modelID?: string, variant?: string | null, planMode?: boolean }} */
  const selection = {};
  if (isNonEmptyString(devryan.agent)) selection.agent = devryan.agent;
  if (isNonEmptyString(devryan.providerID)) selection.providerID = devryan.providerID;
  if (isNonEmptyString(devryan.modelID)) selection.modelID = devryan.modelID;
  if (typeof devryan.variant === 'string' || devryan.variant === null) selection.variant = devryan.variant;
  if (devryan.planMode === true) selection.planMode = true;
  return selection;
};

/**
 * v1 user `metadata`: the v2 metadata without DevRyan internals, plus the
 * `openchamberPlanMode` marker the UI's plan-card detection reads.
 * @param {unknown} metadata
 * @returns {Record<string, unknown>}
 */
export const toV1UserMetadata = (metadata) => {
  if (!isRecord(metadata)) return {};
  const { [DEVRYAN_METADATA_KEY]: _devryan, ...rest } = metadata;
  return readDevryanPromptSelection(metadata)?.planMode === true
    ? { ...rest, [PLAN_MODE_METADATA_KEY]: true }
    : rest;
};

const toV1UserModel = (selection, fallback) => {
  // LOSS(user-selection): without metadata.devryan the agent/model come from a switched row
  // before the record, else the answering assistant, else the previous assistant or the
  // session's current selection.
  const providerID = selection?.providerID ?? fallback?.providerID ?? '';
  const modelID = selection?.modelID ?? fallback?.id ?? '';
  /** @type {V1ModelSelection} */
  const model = { providerID, modelID };
  if (selection && Object.hasOwn(selection, 'variant')) {
    // A recorded null is the v1 "explicit provider default" (empty string).
    model.variant = selection.variant ?? '';
  } else if (!selection?.modelID && typeof fallback?.variant === 'string') {
    model.variant = fallback.variant;
  }
  return model;
};

// ---------------------------------------------------------------------------
// User-side records
// ---------------------------------------------------------------------------

const textPart = (id, sessionID, messageID, text, synthetic) => {
  const part = { id, sessionID, messageID, type: 'text', text };
  if (synthetic) part.synthetic = true;
  return part;
};

/**
 * v1 parts for a v2 `user` row: text segments (B.2, ids.js), then files, then
 * agent mentions.
 * @param {Record<string, unknown>} message
 * @param {string} sessionID
 * @returns {Record<string, unknown>[]}
 */
export const toV1UserParts = (message, sessionID) => {
  const messageID = String(message.id);
  /** @type {Record<string, unknown>[]} */
  const parts = userTextSegments(messageID, message.text, message.metadata).map((segment) => (
    // LOSS(segment-kind): `attachment` and `synthetic` segments both become synthetic text parts.
    textPart(segment.id, sessionID, messageID, segment.text, segment.kind !== 'text')
  ));
  // LOSS(part-order): files and agents follow the text segments; their position relative to the
  // text in the original v1 prompt is not recorded.
  if (Array.isArray(message.files)) {
    message.files.forEach((file, index) => {
      if (!isRecord(file) || typeof file.data !== 'string') return;
      const mime = typeof file.mime === 'string' ? file.mime : 'application/octet-stream';
      // LOSS(file-source): v2 `source`, `description` and `mention` have no v1 FilePart field.
      const part = {
        id: userFilePartId(messageID, index),
        sessionID,
        messageID,
        type: 'file',
        mime,
        url: `data:${mime};base64,${file.data}`,
      };
      if (isNonEmptyString(file.name)) part.filename = file.name;
      parts.push(part);
    });
  }
  if (Array.isArray(message.agents)) {
    message.agents.forEach((agent, index) => {
      if (!isRecord(agent) || typeof agent.name !== 'string') return;
      const part = { id: userAgentPartId(messageID, index), sessionID, messageID, type: 'agent', name: agent.name };
      const mention = agent.mention;
      if (isRecord(mention) && typeof mention.text === 'string'
        && isFiniteNumber(mention.start) && isFiniteNumber(mention.end)) {
        part.source = { value: mention.text, start: mention.start, end: mention.end };
      }
      parts.push(part);
    });
  }
  // LOSS(user-skills): v2 `skills` attachments have no v1 part.
  return parts;
};

/**
 * v1 user info. `agent`/`model` come from `metadata.devryan` when present,
 * otherwise from `fallback` (the caller's fold).
 * @param {Record<string, unknown>} message
 * @param {{ sessionID: string, created: number | undefined, agent?: string, model?: V2ModelRef }} context
 */
export const toV1UserInfo = (message, context) => {
  const selection = readDevryanPromptSelection(message.metadata);
  return {
    id: message.id,
    sessionID: context.sessionID,
    role: 'user',
    time: { created: context.created },
    agent: selection?.agent ?? context.agent ?? '',
    model: toV1UserModel(selection, context.model),
    metadata: toV1UserMetadata(message.metadata),
  };
};

/**
 * Hidden synthetic text part for a v2 `synthetic` row, keyed by its own id so
 * folding it into the following user record keeps it unique.
 * @param {Record<string, unknown>} message
 * @param {string} sessionID
 * @param {string} messageID the record the part is attached to
 */
const syntheticPart = (message, sessionID, messageID) => {
  const part = textPart(userTextPartId(String(message.id), 0), sessionID, messageID,
    typeof message.text === 'string' ? message.text : '', true);
  // LOSS(synthetic-description): kept in part metadata; v1 has no field for it.
  if (isNonEmptyString(message.description)) part.metadata = { opencodeDescription: message.description };
  // A folded preface must not turn the following human request into maintenance.
  if (message.type === 'synthetic' && messageID === String(message.id)
      && isRecord(message.metadata) && message.metadata.compaction_continue === true) {
    part.metadata = { ...part.metadata, compaction_continue: true };
  }
  return part;
};

/**
 * Hidden synthetic part for a v2 `skill` row.
 * @param {Record<string, unknown>} message
 * @param {string} sessionID
 */
const skillPart = (message, sessionID) => {
  const messageID = String(message.id);
  const part = textPart(userTextPartId(messageID, 0), sessionID, messageID,
    typeof message.text === 'string' ? message.text : '', true);
  part.metadata = { opencodeSkill: { id: message.skill, name: message.name } };
  return part;
};

// ---------------------------------------------------------------------------
// Assistant-side records
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AssistantRecordContext
 * @property {string} sessionID
 * @property {string} parentID
 * @property {number | undefined} created clamped `time.created`
 * @property {V1PathInfo} path
 * @property {import('./errors.js').ToV1ErrorOptions} [errorOptions]
 */

const assistantTimes = (created, completed) => (
  completed === undefined ? { created } : { created, completed }
);

const partTime = (start, end) => (end === undefined ? { start } : { start, end });

/**
 * v1 info for a v2 `assistant` row.
 * @param {Record<string, unknown>} message
 * @param {AssistantRecordContext} context
 */
export const toV1AssistantInfo = (message, context) => {
  const model = toV2ModelRef(message.model);
  const agent = typeof message.agent === 'string' ? message.agent : '';
  const info = {
    id: message.id,
    sessionID: context.sessionID,
    role: 'assistant',
    parentID: context.parentID,
    agent,
    mode: agent,
    providerID: model?.providerID ?? '',
    modelID: model?.id ?? '',
    path: context.path,
    time: assistantTimes(context.created, completedOf(message)),
    cost: finiteOr(message.cost, 0),
    tokens: toV1Tokens(message.tokens),
  };
  // LOSS(variant-default): v2 adds `variant: "default"` on a model switch; it passes through.
  if (typeof model?.variant === 'string') info.variant = model.variant;
  if (typeof message.finish === 'string') info.finish = message.finish;
  const error = toV1Error(message.error, context.errorOptions);
  if (error) info.error = error;
  // LOSS(assistant-retry): `retry` is not a record field; status.js derives the retry status.
  // LOSS(assistant-streamed): `time.streamed`, `rawFinish` and `providerState` are dropped.
  return info;
};

/**
 * v1 parts for a v2 `assistant` row: `step-start`, the content items, and a
 * `step-finish` once the step has finished.
 * @param {Record<string, unknown>} message
 * @param {AssistantRecordContext} context
 * @returns {Record<string, unknown>[]}
 */
export const toV1AssistantParts = (message, context) => {
  const messageID = String(message.id);
  const { sessionID } = context;
  const completed = completedOf(message);
  const snapshot = isRecord(message.snapshot) ? message.snapshot : {};
  /** @type {Record<string, unknown>[]} */
  const parts = [];
  const stepStart = { id: stepStartPartId(messageID), sessionID, messageID, type: 'step-start' };
  if (isNonEmptyString(snapshot.start)) stepStart.snapshot = snapshot.start;
  if (!isCursorAssistant(message)) parts.push(stepStart);

  const content = Array.isArray(message.content) ? message.content : EMPTY_RECORDS;
  const ids = assistantContentPartIds(messageID, content, isCursorAssistant(message) ? message.metadata : undefined);
  content.forEach((item, index) => {
    const id = ids[index];
    if (!isRecord(item) || id === null) return;
    if (item.type === 'text') {
      // LOSS(text-time): v2 text items carry no time; the step's times stand in.
      const part = textPart(id, sessionID, messageID, typeof item.text === 'string' ? item.text : '', false);
      part.time = partTime(context.created, completed);
      if (isRecord(item.state)) part.metadata = { providerState: item.state };
      parts.push(part);
      return;
    }
    if (item.type === 'reasoning') {
      const time = isRecord(item.time) ? item.time : {};
      const start = finiteOr(time.created, context.created);
      const end = isFiniteNumber(time.completed) ? time.completed : completed;
      const part = {
        id,
        sessionID,
        messageID,
        type: 'reasoning',
        text: typeof item.text === 'string' ? item.text : '',
        time: partTime(start, end),
      };
      if (isRecord(item.state)) part.metadata = item.state;
      parts.push(part);
      return;
    }
    const tool = toV1ToolPart(item, { messageID, sessionID });
    if (tool) parts.push(id === tool.id ? tool : { ...tool, id });
  });

  if (!isCursorAssistant(message) && (completed !== undefined || typeof message.finish === 'string')) {
    const stepFinish = {
      id: stepFinishPartId(messageID),
      sessionID,
      messageID,
      type: 'step-finish',
      reason: typeof message.finish === 'string' ? message.finish : 'stop',
      cost: finiteOr(message.cost, 0),
      tokens: toV1Tokens(message.tokens),
    };
    if (isNonEmptyString(snapshot.end)) stepFinish.snapshot = snapshot.end;
    parts.push(stepFinish);
  }
  return parts;
};

/**
 * One v1 assistant record for a v2 `assistant` row.
 * @param {Record<string, unknown>} message
 * @param {AssistantRecordContext} context
 * @returns {V1MessageRecord}
 */
export const toV1AssistantRecord = (message, context) => ({
  info: toV1AssistantInfo(message, context),
  parts: toV1AssistantParts(message, context),
});

/**
 * @typedef {object} CompactionRecordContext
 * @property {string} sessionID
 * @property {number | undefined} created clamped time of the user half
 * @property {number | undefined} summaryCreated clamped time of the summary assistant
 * @property {string} [agent] the folded agent, for the user half
 * @property {V2ModelRef} [model] the folded model, when the compaction has none
 * @property {V1PathInfo} path
 * @property {import('./errors.js').ToV1ErrorOptions} [errorOptions]
 */

/**
 * The v1 compaction pair for a v2 `compaction` row (B.2, [sm M28]).
 * @param {Record<string, unknown>} message
 * @param {CompactionRecordContext} context
 * @returns {[V1MessageRecord, V1MessageRecord]}
 */
export const toV1CompactionRecords = (message, context) => {
  const messageID = String(message.id);
  const summaryID = compactionSummaryMessageId(messageID);
  const { sessionID } = context;
  const model = toV2ModelRef(message.model) ?? context.model;
  const user = {
    info: {
      id: messageID,
      sessionID,
      role: 'user',
      time: { created: context.created },
      agent: context.agent ?? '',
      model: toV1UserModel(null, model),
      metadata: {},
    },
    parts: [{
      id: compactionPartId(messageID),
      sessionID,
      messageID,
      type: 'compaction',
      auto: message.reason === 'auto',
    }],
  };
  // LOSS(compaction-time): v2 compaction rows have one time; the summary assistant takes the
  // next clamped millisecond and completes at the same instant once the row is terminal.
  const terminal = message.status === 'completed' || message.status === 'failed';
  const info = {
    id: summaryID,
    sessionID,
    role: 'assistant',
    parentID: messageID,
    agent: COMPACTION_AGENT,
    mode: COMPACTION_AGENT,
    summary: true,
    providerID: model?.providerID ?? '',
    modelID: model?.id ?? '',
    path: context.path,
    time: assistantTimes(context.summaryCreated, terminal ? context.summaryCreated : undefined),
    cost: finiteOr(message.cost, 0),
    tokens: toV1Tokens(message.tokens),
  };
  if (message.status === 'completed') info.finish = 'stop';
  if (message.status === 'failed') {
    info.finish = 'error';
    const error = toV1Error(message.error, context.errorOptions);
    if (error) info.error = error;
  }
  // LOSS(compaction-recent): `recent`, `providerContext` and `providerState` are dropped.
  const summary = typeof message.summary === 'string' ? message.summary : '';
  const parts = summary.length > 0 || message.status === 'running'
    ? [textPart(compactionSummaryTextPartId(messageID), sessionID, summaryID, summary, false)]
    : [];
  return [user, { info, parts }];
};

/**
 * One v1 assistant record with a single `bash` tool part for a v2 `shell` row.
 * @param {Record<string, unknown>} message
 * @param {AssistantRecordContext & { agent?: string, model?: V2ModelRef }} context
 * @returns {V1MessageRecord}
 */
export const toV1ShellRecord = (message, context) => {
  const messageID = String(message.id);
  const { sessionID } = context;
  const callID = isNonEmptyString(message.shellID) ? message.shellID : messageID;
  const completed = completedOf(message);
  const command = typeof message.command === 'string' ? message.command : '';
  const input = { command };
  const start = context.created;
  const state = message.status === 'running'
    ? { status: 'running', input, title: command, metadata: {}, time: { start } }
    : {
      status: 'completed',
      input,
      title: command,
      output: isRecord(message.output) && typeof message.output.output === 'string' ? message.output.output : '',
      metadata: isFiniteNumber(message.exit)
        ? { status: message.status, exit: message.exit }
        : { status: message.status },
      time: { start, end: completed ?? start },
    };
  const agent = context.agent ?? '';
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      parentID: context.parentID,
      agent,
      mode: agent,
      providerID: context.model?.providerID ?? '',
      modelID: context.model?.id ?? '',
      path: context.path,
      time: assistantTimes(context.created, completed),
      cost: 0,
      tokens: toV1Tokens(undefined),
    },
    parts: [{
      id: assistantToolPartId(messageID, callID),
      sessionID,
      messageID,
      type: 'tool',
      callID,
      tool: SHELL_TOOL,
      state,
      metadata: { opencodeTool: 'shell' },
    }],
  };
};

// ---------------------------------------------------------------------------
// User index (parentID at the older edge of a page)
// ---------------------------------------------------------------------------

const compareIndexEntries = (left, right) => left.deliveredAt - right.deliveredAt;

/**
 * Builds the sorted user index from v2 `user`/`synthetic` rows (any order).
 * Ties on `deliveredAt` keep the input order, so pass rows in seq order.
 * @param {readonly unknown[]} messages
 * @returns {UserIndexEntry[]}
 */
export const buildUserIndex = (messages) => {
  if (!Array.isArray(messages)) return [];
  /** @type {UserIndexEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const message of messages) {
    if (!isRecord(message) || (message.type !== 'user' && message.type !== 'synthetic' || isNativeStatusMessage(message))) continue;
    const created = createdOf(message);
    if (!isNonEmptyString(message.id) || !isFiniteNumber(created) || seen.has(message.id)) continue;
    seen.add(message.id);
    entries.push({ deliveredAt: created, userID: message.id });
  }
  return entries.sort(compareIndexEntries);
};

/**
 * Adds one delivered user (live `session.inbox.delivered`) to a sorted index.
 * Returns a new array; an id already present is not duplicated.
 * @param {readonly UserIndexEntry[]} index
 * @param {UserIndexEntry} entry
 * @returns {UserIndexEntry[]}
 */
export const addUserIndexEntry = (index, entry) => {
  const base = Array.isArray(index) ? index : [];
  if (!isRecord(entry) || !isNonEmptyString(entry.userID) || !isFiniteNumber(entry.deliveredAt)) return [...base];
  if (base.some((existing) => existing.userID === entry.userID)) return [...base];
  const next = [...base];
  let position = next.length;
  while (position > 0 && next[position - 1].deliveredAt > entry.deliveredAt) position -= 1;
  next.splice(position, 0, { deliveredAt: entry.deliveredAt, userID: entry.userID });
  return next;
};

/**
 * The user with the largest `deliveredAt <= createdAt` (the last one on ties).
 * LOSS(parent-edge): INFERRED equal to the seq rule except after a step restart (F2, F6).
 * @param {readonly UserIndexEntry[] | undefined} index sorted
 * @param {unknown} createdAt the assistant's raw `time.created`
 * @returns {string | undefined}
 */
export const findIndexedParentID = (index, createdAt) => {
  if (!Array.isArray(index) || !isFiniteNumber(createdAt)) return undefined;
  let low = 0;
  let high = index.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index[middle].deliveredAt <= createdAt) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? undefined : index[low - 1].userID;
};

// ---------------------------------------------------------------------------
// Turn summaries (B.6)
// ---------------------------------------------------------------------------

const fileEntriesOf = (part) => {
  if (!isRecord(part) || part.type !== 'tool' || !FILE_COUNT_TOOLS.has(String(part.tool))) return EMPTY_RECORDS;
  const state = part.state;
  if (!isRecord(state) || state.status !== 'completed' || !isRecord(state.metadata)) return EMPTY_RECORDS;
  return Array.isArray(state.metadata.files) ? state.metadata.files : EMPTY_RECORDS;
};

/**
 * Patch-free per-turn file counts: for each parent user id, the edit/write/patch
 * `metadata.files[]` counts of its assistants' completed tool parts, summed per
 * file. LOSS(diff-shell): changes made by `shell` are not counted. LOSS(diff-page): a
 * turn split across pages counts only the assistants on this page. LOSS(diff-files):
 * 2.0.20 `write` results observed without `files` (F8 notes) contribute nothing.
 * @param {readonly V1MessageRecord[]} records
 * @returns {Map<string, { file: string, additions: number, deletions: number, status?: string }[]>}
 */
export const turnSummaryDiffs = (records) => {
  /** @type {Map<string, Map<string, { file: string, additions: number, deletions: number, status?: string }>>} */
  const byTurn = new Map();
  for (const record of Array.isArray(records) ? records : EMPTY_RECORDS) {
    const info = isRecord(record) ? record.info : undefined;
    if (!isRecord(info) || info.role !== 'assistant' || !isNonEmptyString(info.parentID)) continue;
    for (const part of Array.isArray(record.parts) ? record.parts : EMPTY_RECORDS) {
      for (const entry of fileEntriesOf(part)) {
        if (!isRecord(entry) || !isNonEmptyString(entry.file)) continue;
        let files = byTurn.get(info.parentID);
        if (!files) {
          files = new Map();
          byTurn.set(info.parentID, files);
        }
        const current = files.get(entry.file) ?? { file: entry.file, additions: 0, deletions: 0 };
        current.additions += finiteOr(entry.additions, 0);
        current.deletions += finiteOr(entry.deletions, 0);
        if (FILE_STATUSES.has(entry.status)) current.status = entry.status;
        files.set(entry.file, current);
      }
    }
  }
  return new Map([...byTurn].map(([userID, files]) => [userID, [...files.values()]]));
};

// ---------------------------------------------------------------------------
// Page projection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProjectedMessagePage
 * @property {V1MessageRecord[]} records v1 records in seq order
 * @property {number | undefined} lastTime clamped time of the last record (seed for the next newer page)
 * @property {string | undefined} lastParentID the parent the next assistant would get
 * @property {{ agent?: string, model?: V2ModelRef, path: V1PathInfo }} fold the running selection after the page
 */

/**
 * Projects v2 message rows given in **seq order** (asc) into v1 records (B.2).
 * Rows of unknown type and rows without an id are dropped.
 * @param {readonly unknown[]} messages
 * @param {MessagePageContext} context
 * @returns {ProjectedMessagePage}
 */
export const projectMessagePage = (messages, context) => {
  const sessionID = context.sessionID;
  const errorOptions = context.errorOptions;
  let agent = context.agent;
  let model = toV2ModelRef(context.model);
  let pathInfo = { cwd: context.cwd ?? context.directory ?? '', root: context.directory ?? '' };
  let lastTime = context.previousTime;
  /** @type {string | undefined} */
  let lastParentID = context.previousParentID;
  /** @type {V1MessageRecord[]} */
  const records = [];
  /** @type {Record<string, unknown>[]} */
  let pendingSynthetic = [];
  // The running selection: the session seed, then each switched row, then what each assistant
  // actually ran with. User records that got theirs from a seed or an earlier assistant (no
  // metadata.devryan, no switched row since) are refined from the assistant that answers them.
  /** @type {Map<string, { info: Record<string, unknown>, agent: boolean, model: boolean }>} */
  const seededUsers = new Map();
  let agentFromSwitch = false;
  let modelFromSwitch = false;

  // LOSS(time-clamp): equal or out-of-order v2 times are raised by whole milliseconds.
  const nextTime = (raw) => {
    const clamped = clampIncreasingTime(raw, lastTime);
    if (clamped !== undefined) lastTime = clamped;
    return clamped;
  };

  const parentFor = (message) => (
    lastParentID ?? findIndexedParentID(context.userIndex, createdOf(message)) ?? ''
  );

  const trackSeeded = (messageID, info, metadata) => {
    const selection = readDevryanPromptSelection(metadata);
    const refineAgent = !selection?.agent && !agentFromSwitch;
    const refineModel = !selection?.modelID && !modelFromSwitch;
    if (refineAgent || refineModel) seededUsers.set(messageID, { info, agent: refineAgent, model: refineModel });
  };

  const pushUser = (message, extraParts) => {
    const info = toV1UserInfo(message, { sessionID, created: nextTime(createdOf(message)), agent, model });
    const parts = extraParts.length > 0
      ? [...extraParts, ...toV1UserParts(message, sessionID)]
      : toV1UserParts(message, sessionID);
    records.push({ info, parts });
    lastParentID = String(message.id);
    trackSeeded(lastParentID, info, message.metadata);
  };

  const flushSynthetic = () => {
    // A synthetic row not followed by a user row in this page stands alone and is a parent.
    for (const message of pendingSynthetic) {
      const messageID = String(message.id);
      const info = toV1UserInfo(message, { sessionID, created: nextTime(createdOf(message)), agent, model });
      records.push({ info, parts: [syntheticPart(message, sessionID, messageID)],
        ...(isNativeStatusMessage(message) ? { nativeStatus: { source: 'native-sequence', kind: 'status-only' } } : {}) });
      if (!isNativeStatusMessage(message)) {
        lastParentID = messageID;
        trackSeeded(messageID, info, message.metadata);
      }
    }
    pendingSynthetic = [];
  };

  for (const message of Array.isArray(messages) ? messages : EMPTY_RECORDS) {
    if (!isRecord(message) || !isNonEmptyString(message.id)) continue;
    const type = message.type;
    if (FOLDED_TYPES.has(type)) {
      if (type === 'agent-switched' && isNonEmptyString(message.agent)) {
        agent = message.agent;
        agentFromSwitch = true;
      }
      const switchedModel = type === 'model-switched' ? toV2ModelRef(message.model) : undefined;
      if (switchedModel) {
        model = switchedModel;
        modelFromSwitch = true;
      }
      if (type === 'location-switched' && isRecord(message.location)) {
        pathInfo = toV1PathInfo(message.location.directory, message.subpath);
      }
      continue;
    }
    if (DROPPED_TYPES.has(type)) continue;
    if (type === 'synthetic') {
      pendingSynthetic.push(message);
      continue;
    }
    if (type === 'user') {
      // LOSS(synthetic-fold): a folded synthetic row loses its own id and time.
      const folded = pendingSynthetic.map((synthetic) => syntheticPart(synthetic, sessionID, message.id));
      pendingSynthetic = [];
      pushUser(message, folded);
      continue;
    }
    flushSynthetic();
    if (type === 'assistant') {
      records.push(toV1AssistantRecord(message, {
        sessionID,
        parentID: parentFor(message),
        created: nextTime(createdOf(message)),
        path: pathInfo,
        errorOptions,
      }));
      if (isNonEmptyString(message.agent)) agent = message.agent;
      model = toV2ModelRef(message.model) ?? model;
      agentFromSwitch = false;
      modelFromSwitch = false;
      continue;
    }
    if (type === 'compaction') {
      const created = nextTime(createdOf(message));
      const summaryCreated = nextTime(created);
      const pair = toV1CompactionRecords(message, {
        sessionID, created, summaryCreated, agent, model, path: pathInfo, errorOptions,
      });
      records.push(pair[0], pair[1]);
      lastParentID = String(message.id);
      continue;
    }
    if (type === 'shell') {
      records.push(toV1ShellRecord(message, {
        sessionID,
        parentID: parentFor(message),
        created: nextTime(createdOf(message)),
        path: pathInfo,
        agent,
        model,
      }));
      continue;
    }
    if (type === 'skill') {
      // A skill row is model-facing context inside a turn; it is not a parent.
      const info = toV1UserInfo(message, { sessionID, created: nextTime(createdOf(message)), agent, model });
      records.push({ info, parts: [skillPart(message, sessionID)] });
    }
  }
  flushSynthetic();

  // Only the sequence parent is authority. The live display's timestamp
  // fallback may populate parentID but never receives this proof.
  let exactParentID = context.previousParentID;
  const parentIDs = new Set(messages.filter(isNativeTurnParent).map((row) => row.id));
  for (const record of records) {
    if (record.info.role === 'user') {
      // Skill rows are context, not turn parents (see the loop above).
      if (parentIDs.has(record.info.id)) exactParentID = record.info.id;
    } else if (record.info.role === 'assistant' && exactParentID && record.info.parentID === exactParentID) {
      record.turnOwnership = { source: 'native-sequence', userMessageID: exactParentID };
    }
  }
  refineSeededUsers(records, seededUsers);
  applyTurnSummaries(records);

  return { records, lastTime, lastParentID, fold: { agent, model, path: pathInfo } };
};

/**
 * A user record whose agent/model came from the session seed or an earlier
 * assistant takes them from the first assistant that answers it, which is
 * what ran for that turn.
 */
const refineSeededUsers = (records, seededUsers) => {
  if (seededUsers.size === 0) return;
  for (const record of records) {
    const info = record.info;
    if (info.role !== 'assistant' || info.summary === true) continue;
    const pending = seededUsers.get(String(info.parentID));
    if (!pending) continue;
    seededUsers.delete(String(info.parentID));
    if (pending.agent && isNonEmptyString(info.agent)) pending.info.agent = info.agent;
    if (pending.model && isNonEmptyString(info.modelID)) {
      const userModel = { providerID: info.providerID, modelID: info.modelID };
      if (typeof info.variant === 'string') userModel.variant = info.variant;
      pending.info.model = userModel;
    }
    if (seededUsers.size === 0) return;
  }
};

const applyTurnSummaries = (records) => {
  const summaries = turnSummaryDiffs(records);
  if (summaries.size === 0) return;
  for (const record of records) {
    const diffs = record.info.role === 'user' ? summaries.get(String(record.info.id)) : undefined;
    if (diffs && diffs.length > 0) record.info.summary = { diffs };
  }
};

// ---------------------------------------------------------------------------
// Cursors and page fill (the façade behind GET /api/session/:id/message)
// ---------------------------------------------------------------------------

/**
 * `x-next-cursor` value for a v2 `cursor.next`, or `undefined` when absent.
 * @param {unknown} cursor
 */
export const encodeMessageCursor = (cursor) => (
  isNonEmptyString(cursor) ? `${V2_MESSAGE_CURSOR_PREFIX}${cursor}` : undefined
);

/**
 * The v2 cursor inside a v1 `before` value. `undefined` when no `before` was
 * given; `null` when it is not a gen-2 cursor (for example a gen-1 cursor that
 * survived a generation switch), which the caller rejects.
 * @param {unknown} before
 * @returns {string | null | undefined}
 */
export const decodeMessageCursor = (before) => {
  if (before === undefined || before === null || before === '') return undefined;
  if (typeof before !== 'string' || !before.startsWith(V2_MESSAGE_CURSOR_PREFIX)) return null;
  const cursor = before.slice(V2_MESSAGE_CURSOR_PREFIX.length);
  return cursor.length > 0 ? cursor : null;
};

/**
 * Error thrown by the page-fill helpers for a `before` value that is not a gen-2 cursor.
 */
export class InvalidMessageCursorError extends Error {
  constructor() {
    super('The message cursor does not belong to this OpenCode generation');
    this.name = 'InvalidMessageCursorError';
    this.code = 'opencode_invalid_cursor';
    this.status = 400;
  }
}

/** A repeated upstream cursor would replay rows instead of advancing history. */
export class InvalidMessagePageError extends Error {
  constructor(message = 'OpenCode message pagination did not advance') {
    super(message);
    this.name = 'InvalidMessagePageError';
    this.code = 'opencode_invalid_response';
    this.status = 502;
  }
}

const readPageBody = (body) => {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : EMPTY_RECORDS;
  if (!isRecord(body) || !Array.isArray(body.data) || (body.cursor != null && !isRecord(body.cursor))) {
    throw new InvalidMessagePageError('Invalid OpenCode message page');
  }
  const cursor = isRecord(body.cursor) ? body.cursor : {};
  if (cursor.next != null && !isNonEmptyString(cursor.next)) throw new InvalidMessagePageError('Invalid OpenCode message cursor');
  return { data, next: isNonEmptyString(cursor.next) ? cursor.next : undefined };
};

const clampPageLimit = (limit) => {
  if (!Number.isSafeInteger(limit) || limit < 1) return V2_MESSAGE_PAGE_MAX;
  return Math.min(limit, V2_MESSAGE_PAGE_MAX);
};

/**
 * @typedef {object} FilledMessagePage
 * @property {V1MessageRecord[]} records in seq order (may exceed `limit`)
 * @property {string | undefined} nextCursor `x-next-cursor` value (`v2:<cursor>`), absent once exhausted
 * @property {number} fetches v2 message pages fetched
 */

/**
 * The façade's page fill (B.2). Fetches v2 pages newest first (`order=desc`
 * on the first request, the cursor alone afterwards) until it has `limit`
 * projected records, the history is exhausted, or {@link MAX_PAGE_FILL_EXTRA_FETCHES}
 * extra pages were fetched; then projects the rows in seq order. Dropped rows
 * (switches, idle, system) can leave a short or empty page at the work limit.
 * Its `v2:` cursor still advances through every scanned row and is authoritative
 * for whether more history remains, independently of the projected row count.
 * @param {object} options
 * @param {number} options.limit requested record count (`1..200`)
 * @param {unknown} [options.before] the UI's `before` (an `x-next-cursor` value)
 * @param {(request: { cursor?: string, limit: number }) => Promise<unknown>} options.fetchPage
 *   returns the raw v2 body for `…/message?order=desc&limit` or `…/message?cursor&limit`
 * @param {MessagePageContext} options.context
 * @returns {Promise<FilledMessagePage>}
 */
export const fillMessagePage = async ({ limit, before, fetchPage, context }) => {
  const cursorIn = decodeMessageCursor(before);
  if (cursorIn === null) throw new InvalidMessageCursorError();
  const requestLimit = clampPageLimit(limit);
  const wanted = Number.isSafeInteger(limit) && limit > 0 ? limit : requestLimit;
  /** Rows newest first, as fetched. */
  const rows = [];
  let cursor = cursorIn;
  const seenCursors = new Set(cursorIn === undefined ? [] : [cursorIn]);
  let fetches = 0;
  let exhausted = false;
  for (;;) {
    const page = readPageBody(await fetchPage(cursor === undefined ? { limit: requestLimit } : { cursor, limit: requestLimit }));
    fetches += 1;
    rows.push(...page.data);
    // v2 returns `cursor.next` even on an exhausted page, so a short page ends history ([sm M0]).
    exhausted = page.data.length < requestLimit || !page.next;
    if (!exhausted) {
      if (seenCursors.has(page.next)) throw new InvalidMessagePageError();
      seenCursors.add(page.next);
    }
    cursor = page.next;
    if (exhausted || fetches > MAX_PAGE_FILL_EXTRA_FETCHES) break;
    const seq = [...rows].reverse();
    if (projectMessagePage(seq, context).records.length >= wanted) break;
  }
  const seq = rows.reverse();
  let previousParentID;
  // The oldest edge must use the same unfiltered sequence as the page.
  // A type=user index cannot represent synthetic/compaction parents and
  // timestamps do not order native rows.
  const firstTurnRow = seq.find((row) => isRecord(row) && (isNativeTurnParent(row) || ['assistant', 'shell'].includes(row.type)));
  const needsParent = firstTurnRow?.type === 'assistant' || firstTurnRow?.type === 'shell';
  if (needsParent && !exhausted) {
    let parentCursor = cursor;
    const parentCursors = new Set(seenCursors);
    for (let lookups = 0; lookups < MAX_PARENT_LOOKUP_PAGES; lookups += 1) {
      const page = readPageBody(await fetchPage({ cursor: parentCursor, limit: V2_MESSAGE_PAGE_MAX }));
      const parent = page.data.find((row) => isRecord(row) && isNonEmptyString(row.id)
        && isNativeTurnParent(row));
      if (parent) { previousParentID = parent.id; break; }
      if (page.data.length < V2_MESSAGE_PAGE_MAX || !page.next) break;
      if (parentCursors.has(page.next)) throw new InvalidMessagePageError();
      parentCursors.add(page.next);
      parentCursor = page.next;
      if (lookups === MAX_PARENT_LOOKUP_PAGES - 1) throw Object.assign(new Error('The OpenCode message parent exceeded the sequence-read budget'),
        { code: 'opencode_unavailable', statusCode: 503, retryable: false });
    }
  }
  const { records } = projectMessagePage(seq, { ...context, userIndex: undefined, previousParentID });
  return { records, nextCursor: exhausted ? undefined : encodeMessageCursor(cursor), fetches };
};

/**
 * Projects a single v2 message (`GET …/message/:mid`) into its v1 record(s).
 * An authoritative parent requires native sequence context.
 * Dropped types yield an empty array.
 * @param {unknown} message
 * @param {MessagePageContext} context
 * @returns {V1MessageRecord[]}
 */
export const projectSingleMessage = (message, context) => (
  projectMessagePage([message], context).records
);

/**
 * True when a v2 row has no v1 record of its own (B.2 dropped and folded types).
 * @param {unknown} message
 */
export const isDroppedMessageType = (message) => (
  isRecord(message) && (DROPPED_TYPES.has(message.type) || FOLDED_TYPES.has(message.type))
);
