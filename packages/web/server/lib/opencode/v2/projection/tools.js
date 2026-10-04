// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) tool vocabulary <-> DevRyan's v1 ToolPart contract.
//
// Names:     shell -> bash, subagent -> task, patch -> apply_patch. Migrated
//            sessions already use v1 names, which pass through unchanged.
// Input:     aliases are ADDED for v1 consumers, never replacing the original
//            keys: read/edit/write `path` -> `filePath`, task `agent` ->
//            `subagent_type`, skill `id` -> `name`.
// Metadata:  task `sessionID` also as `sessionId`; edit/write `files[0]` ->
//            `diff` (its patch) and `filediff {file, additions, deletions}`.
// State:     streaming -> pending {input: {}, raw}; running gains a title
//            synthesized from description/command/path; completed joins text
//            content into `output` and turns file content into attachments;
//            error flattens the structured error to its message.
//
// The reverse helpers (`toV2*`) strip exactly the aliases this module adds, so
// a wire round trip of a projected record is stable. Everything here is pure.
// ---------------------------------------------------------------------------

import { assistantToolPartId, toolAttachmentPartId } from './ids.js';

const V2_TO_V1_TOOL_NAMES = new Map([
  ['shell', 'bash'],
  ['subagent', 'task'],
  ['patch', 'apply_patch'],
]);

const V1_TO_V2_TOOL_NAMES = new Map(
  [...V2_TO_V1_TOOL_NAMES].map(([v2Name, v1Name]) => [v1Name, v2Name]),
);

/**
 * Input key aliases per v1 tool name, as `[v2Key, v1Key]` pairs.
 * @type {ReadonlyMap<string, ReadonlyArray<readonly [string, string]>>}
 */
const INPUT_ALIASES = new Map([
  ['read', [['path', 'filePath']]],
  ['edit', [['path', 'filePath']]],
  ['write', [['path', 'filePath']]],
  ['task', [['agent', 'subagent_type']]],
  ['skill', [['id', 'name']]],
]);

const FILE_DIFF_TOOLS = new Set(['edit', 'write']);
const SUBAGENT_TOOL = 'task';

const EMPTY_INPUT = Object.freeze({});

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const hasKey = (record, key) => Object.hasOwn(record, key) && record[key] !== undefined;

/**
 * v1 tool name for a v2 (or already-v1) tool name.
 * @param {string} name
 * @returns {string}
 */
export const toV1ToolName = (name) => V2_TO_V1_TOOL_NAMES.get(name) ?? name;

/**
 * v2 tool name for a v1 (or already-v2) tool name.
 * @param {string} name
 * @returns {string}
 */
export const toV2ToolName = (name) => V1_TO_V2_TOOL_NAMES.get(name) ?? name;

/**
 * Adds the v1 input aliases for one tool. Returns the same reference when no
 * alias applies. Existing v1 keys are never overwritten.
 * @param {string} name v1 or v2 tool name
 * @param {unknown} input
 * @returns {unknown}
 */
export const toV1ToolInput = (name, input) => {
  if (!isRecord(input)) return input;
  const aliases = INPUT_ALIASES.get(toV1ToolName(name));
  if (!aliases) return input;
  let projected = input;
  for (const [v2Key, v1Key] of aliases) {
    if (!hasKey(input, v2Key) || hasKey(input, v1Key)) continue;
    if (projected === input) projected = { ...input };
    projected[v1Key] = input[v2Key];
  }
  return projected;
};

/**
 * Reverse of {@link toV1ToolInput}: renames v1 alias keys to their v2 keys and
 * removes the v1 keys. When both keys are present the v2 value wins. Returns the
 * same reference when nothing changes.
 * @param {string} name v1 or v2 tool name
 * @param {unknown} input
 * @returns {unknown}
 */
export const toV2ToolInput = (name, input) => {
  if (!isRecord(input)) return input;
  const aliases = INPUT_ALIASES.get(toV1ToolName(name));
  if (!aliases) return input;
  let projected = input;
  for (const [v2Key, v1Key] of aliases) {
    if (!Object.hasOwn(input, v1Key)) continue;
    if (projected === input) projected = { ...input };
    if (!hasKey(input, v2Key) && input[v1Key] !== undefined) projected[v2Key] = input[v1Key];
    delete projected[v1Key];
  }
  return projected;
};

const firstFileDiff = (metadata) => {
  if (!Array.isArray(metadata.files)) return null;
  const first = metadata.files[0];
  return isRecord(first) ? first : null;
};

/**
 * Adds the v1 metadata aliases for one tool. Returns the same reference when no
 * alias applies. Existing v1 keys are never overwritten.
 * @param {string} name v1 or v2 tool name
 * @param {unknown} metadata
 * @returns {unknown}
 */
export const toV1ToolMetadata = (name, metadata) => {
  if (!isRecord(metadata)) return metadata;
  const v1Name = toV1ToolName(name);
  if (v1Name === SUBAGENT_TOOL) {
    if (!isNonEmptyString(metadata.sessionID) || hasKey(metadata, 'sessionId')) return metadata;
    return { ...metadata, sessionId: metadata.sessionID };
  }
  if (!FILE_DIFF_TOOLS.has(v1Name)) return metadata;
  const file = firstFileDiff(metadata);
  if (!file) return metadata;
  let projected = metadata;
  if (typeof file.patch === 'string' && !hasKey(metadata, 'diff')) {
    projected = { ...projected, diff: file.patch };
  }
  if (!hasKey(metadata, 'filediff')) {
    projected = {
      ...projected,
      filediff: { file: file.file, additions: file.additions, deletions: file.deletions },
    };
  }
  return projected;
};

/**
 * Reverse of {@link toV1ToolMetadata}: removes the aliases it adds. `sessionId`
 * is removed only when `sessionID` carries the same value; `diff` and `filediff`
 * only when `files` is present (they are derived from it).
 * @param {string} name v1 or v2 tool name
 * @param {unknown} metadata
 * @returns {unknown}
 */
export const toV2ToolMetadata = (name, metadata) => {
  if (!isRecord(metadata)) return metadata;
  const v1Name = toV1ToolName(name);
  if (v1Name === SUBAGENT_TOOL) {
    if (!Object.hasOwn(metadata, 'sessionId') || metadata.sessionId !== metadata.sessionID) return metadata;
    const { sessionId: _sessionId, ...rest } = metadata;
    return rest;
  }
  if (!FILE_DIFF_TOOLS.has(v1Name) || !firstFileDiff(metadata)) return metadata;
  if (!Object.hasOwn(metadata, 'diff') && !Object.hasOwn(metadata, 'filediff')) return metadata;
  const { diff: _diff, filediff: _filediff, ...rest } = metadata;
  return rest;
};

/**
 * A v1 running/completed title synthesized from the tool input (v2 tools have
 * no title): `description`, else `command`, else `filePath`/`path`.
 * @param {unknown} input
 * @returns {string | undefined}
 */
export const synthesizeToolTitle = (input) => {
  if (!isRecord(input)) return undefined;
  for (const key of ['description', 'command', 'filePath', 'path']) {
    if (isNonEmptyString(input[key])) return input[key];
  }
  return undefined;
};

/**
 * @typedef {object} ToolProjectionContext
 * @property {string} messageID
 * @property {string} sessionID
 */

const toolTimes = (time) => {
  const record = isRecord(time) ? time : {};
  const start = isFiniteNumber(record.ran) ? record.ran : record.created;
  return {
    start: isFiniteNumber(start) ? start : undefined,
    end: isFiniteNumber(record.completed) ? record.completed : undefined,
  };
};

const contentText = (content) => {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
};

const contentAttachments = (content, callID, context) => {
  if (!Array.isArray(content)) return [];
  const attachments = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'file' || typeof item.uri !== 'string') continue;
    const attachment = {
      id: toolAttachmentPartId(context.messageID, callID, attachments.length),
      sessionID: context.sessionID,
      messageID: context.messageID,
      type: 'file',
      mime: typeof item.mime === 'string' ? item.mime : 'application/octet-stream',
      url: item.uri,
    };
    if (isNonEmptyString(item.name)) attachment.filename = item.name;
    attachments.push(attachment);
  }
  return attachments;
};

const structuredErrorMessage = (error) => {
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : '';
};

/**
 * Projects a v2 `Session.Message.Assistant.Tool` item's state into a v1
 * ToolState. Returns `null` for an unknown state (the caller drops the part).
 * @param {unknown} tool
 * @param {ToolProjectionContext} context
 * @returns {Record<string, unknown> | null}
 */
export const toV1ToolState = (tool, context) => {
  if (!isRecord(tool) || !isRecord(tool.state)) return null;
  const name = typeof tool.name === 'string' ? tool.name : '';
  const callID = typeof tool.id === 'string' ? tool.id : '';
  const state = tool.state;
  const { start, end } = toolTimes(tool.time);

  if (state.status === 'streaming') {
    return { status: 'pending', input: {}, raw: typeof state.input === 'string' ? state.input : '' };
  }

  const input = toV1ToolInput(name, isRecord(state.input) ? state.input : EMPTY_INPUT);
  const metadata = isRecord(state.metadata) ? toV1ToolMetadata(name, state.metadata) : undefined;

  if (state.status === 'running') {
    const title = synthesizeToolTitle(input);
    const running = { status: 'running', input, metadata: metadata ?? {}, time: { start } };
    return title === undefined ? running : { ...running, title };
  }

  if (state.status === 'completed') {
    const completed = {
      status: 'completed',
      input,
      output: contentText(state.content),
      title: synthesizeToolTitle(input) ?? '',
      metadata: metadata ?? {},
      time: { start, end: end ?? start },
    };
    const attachments = contentAttachments(state.content, callID, context);
    return attachments.length === 0 ? completed : { ...completed, attachments };
  }

  if (state.status === 'error') {
    const failed = {
      status: 'error',
      input,
      error: structuredErrorMessage(state.error),
      time: { start, end: end ?? start },
    };
    return metadata === undefined ? failed : { ...failed, metadata };
  }

  return null;
};

/**
 * Projects a v2 assistant tool content item into a complete v1 ToolPart.
 * Part-level `metadata` carries the original v2 tool name (`opencodeTool`) and
 * the provider state, which have no v1 counterpart. Returns `null` when the item
 * has no call id or an unknown state.
 * @param {unknown} tool
 * @param {ToolProjectionContext} context
 * @returns {Record<string, unknown> | null}
 */
export const toV1ToolPart = (tool, context) => {
  if (!isRecord(tool) || !isNonEmptyString(tool.id) || typeof tool.name !== 'string') return null;
  const state = toV1ToolState(tool, context);
  if (!state) return null;
  const metadata = isRecord(tool.providerState)
    ? { opencodeTool: tool.name, providerState: tool.providerState }
    : { opencodeTool: tool.name };
  return {
    id: assistantToolPartId(context.messageID, tool.id),
    sessionID: context.sessionID,
    messageID: context.messageID,
    type: 'tool',
    callID: tool.id,
    tool: toV1ToolName(tool.name),
    state,
    metadata,
  };
};
