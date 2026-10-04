// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) identity rules for the v1-shaped domain projection.
//
// v2 has no part ids: assistant content is an ordered array whose text and
// reasoning items are addressed by a per-kind `ordinal` in events and whose tool
// items are addressed by the provider call id. DevRyan's UI and server keep v1
// part ids as store keys, so the projection synthesizes stable ids that the
// REST path (content arrays) and the live path (event ordinals) agree on:
//
//   assistant text       `${messageID}:text:${n}`       (n-th text item = ordinal n)
//   assistant reasoning  `${messageID}:reasoning:${n}`  (n-th reasoning item)
//   assistant tool       `${messageID}:tool:${callID}`
//   step boundaries      `${messageID}:step-start`, `${messageID}:step-finish`
//   user text segment    metadata.devryan.parts[i].id, else `${messageID}:text:${i}`
//   user file / agent    `${messageID}:file:${i}`, `${messageID}:agent:${i}`
//
// Ordinals count per kind, never per content index. Everything here is pure.
// ---------------------------------------------------------------------------

/** @typedef {'text' | 'synthetic' | 'attachment'} DevryanSegmentKind */

/**
 * @typedef {object} DevryanPartDescriptor
 * @property {DevryanSegmentKind} kind
 * @property {number} length UTF-16 code units of `text` covered by this segment.
 * @property {string} [id] The client's own v1 part id.
 */

/**
 * @typedef {object} UserTextSegment
 * @property {string} id
 * @property {DevryanSegmentKind} kind
 * @property {string} text
 */

const DEVRYAN_METADATA_VERSION = 1;
const SEGMENT_KINDS = new Set(['text', 'synthetic', 'attachment']);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/** @param {string} messageID @param {number} ordinal */
export const assistantTextPartId = (messageID, ordinal) => `${messageID}:text:${ordinal}`;

/** @param {string} messageID @param {number} ordinal */
export const assistantReasoningPartId = (messageID, ordinal) => `${messageID}:reasoning:${ordinal}`;

/** @param {string} messageID @param {string} callID */
export const assistantToolPartId = (messageID, callID) => `${messageID}:tool:${callID}`;

/** @param {string} messageID */
export const stepStartPartId = (messageID) => `${messageID}:step-start`;

/** @param {string} messageID */
export const stepFinishPartId = (messageID) => `${messageID}:step-finish`;

/** @param {string} messageID @param {number} index */
export const userTextPartId = (messageID, index) => `${messageID}:text:${index}`;

/** @param {string} messageID @param {number} index */
export const userFilePartId = (messageID, index) => `${messageID}:file:${index}`;

/** @param {string} messageID @param {number} index */
export const userAgentPartId = (messageID, index) => `${messageID}:agent:${index}`;

/**
 * Id of the i-th file item a tool returned, projected as a v1 FilePart attachment.
 * @param {string} messageID @param {string} callID @param {number} index
 */
export const toolAttachmentPartId = (messageID, callID, index) => (
  `${assistantToolPartId(messageID, callID)}:file:${index}`
);

/**
 * The summary assistant of the projected v1 compaction pair.
 * @param {string} messageID the v2 compaction message id (also the v1 user id)
 */
export const compactionSummaryMessageId = (messageID) => `${messageID}:summary`;

/**
 * Part id for one v2 assistant content item, given the per-kind ordinal of that item.
 * Returns `null` for an item that has no projected id (unknown kind, tool without id).
 * @param {string} messageID
 * @param {unknown} item
 * @param {number} ordinal
 * @returns {string | null}
 */
export const assistantContentPartId = (messageID, item, ordinal) => {
  if (!isRecord(item)) return null;
  if (item.type === 'text') return assistantTextPartId(messageID, ordinal);
  if (item.type === 'reasoning') return assistantReasoningPartId(messageID, ordinal);
  if (item.type === 'tool') {
    return isNonEmptyString(item.id) ? assistantToolPartId(messageID, item.id) : null;
  }
  return null;
};

/**
 * Part ids for a v2 assistant `content` array, index-aligned with it. Text and
 * reasoning ordinals count per kind, so the n-th text item gets `:text:n` no
 * matter how many reasoning or tool items precede it; this matches the
 * `ordinal` that `session.text.*` / `session.reasoning.*` events carry.
 * @param {string} messageID
 * @param {readonly unknown[]} content
 * @param {unknown} [metadata] Constructor-owned external Cursor metadata.
 * @returns {(string | null)[]}
 */
export const assistantContentPartIds = (messageID, content, metadata) => {
  if (!Array.isArray(content)) return [];
  let textOrdinal = 0;
  let reasoningOrdinal = 0;
  return content.map((item) => {
    if (!isRecord(item)) return null;
    if (item.type === 'text') { const ordinal = textOrdinal++; return readCursorPartID(metadata, item) ?? assistantTextPartId(messageID, ordinal); }
    if (item.type === 'reasoning') { const ordinal = reasoningOrdinal++; return readCursorPartID(metadata, item) ?? assistantReasoningPartId(messageID, ordinal); }
    if (item.type === 'tool' && isNonEmptyString(item.id)) return readCursorPartID(metadata, item) ?? assistantToolPartId(messageID, item.id);
    return null;
  });
};

/**
 * Validated `metadata.devryan.parts` descriptors, or `null` when the metadata is
 * absent or malformed (wrong version, unknown kind, bad length, duplicate id).
 * Malformed metadata never throws: the caller falls back to one text part.
 * @param {unknown} metadata the v2 message `metadata`
 * @returns {DevryanPartDescriptor[] | null}
 */
export const readDevryanPartDescriptors = (metadata) => {
  if (!isRecord(metadata)) return null;
  const devryan = metadata.devryan;
  if (!isRecord(devryan) || devryan.v !== DEVRYAN_METADATA_VERSION) return null;
  if (!Array.isArray(devryan.parts)) return null;
  const seenIds = new Set();
  /** @type {DevryanPartDescriptor[]} */
  const descriptors = [];
  for (const entry of devryan.parts) {
    if (!isRecord(entry)) return null;
    if (!SEGMENT_KINDS.has(entry.kind)) return null;
    if (!Number.isSafeInteger(entry.length) || entry.length < 0) return null;
    if (entry.id !== undefined) {
      if (!isNonEmptyString(entry.id) || seenIds.has(entry.id)) return null;
      seenIds.add(entry.id);
    }
    descriptors.push(entry.id === undefined
      ? { kind: entry.kind, length: entry.length }
      : { kind: entry.kind, length: entry.length, id: entry.id });
  }
  return descriptors;
};

/**
 * Splits a v2 user `text` into the v1 text parts it was built from.
 *
 * With valid `metadata.devryan.parts` whose UTF-16 lengths sum to the text
 * length, each non-empty segment becomes one part keyed by the client's id (or
 * `${messageID}:text:${i}` when the descriptor has none). Otherwise the whole
 * text is one `text` part `${messageID}:text:0`. Empty text yields no parts.
 * @param {string} messageID
 * @param {unknown} text
 * @param {unknown} metadata
 * @returns {UserTextSegment[]}
 */
export const userTextSegments = (messageID, text, metadata) => {
  const value = typeof text === 'string' ? text : '';
  const descriptors = readDevryanPartDescriptors(metadata);
  const total = descriptors?.reduce((sum, descriptor) => sum + descriptor.length, 0);
  if (!descriptors || descriptors.length === 0 || total !== value.length) {
    return value.length === 0
      ? []
      : [{ id: userTextPartId(messageID, 0), kind: 'text', text: value }];
  }
  /** @type {UserTextSegment[]} */
  const segments = [];
  let offset = 0;
  descriptors.forEach((descriptor, index) => {
    const end = offset + descriptor.length;
    if (descriptor.length > 0) {
      segments.push({
        id: descriptor.id ?? userTextPartId(messageID, index),
        kind: descriptor.kind,
        text: value.slice(offset, end),
      });
    }
    offset = end;
  });
  return segments;
};

/**
 * The client part id recorded for the i-th text segment, if any. Lets the live
 * path reconcile an optimistic v1 part without re-splitting the text.
 * @param {string} messageID
 * @param {unknown} metadata
 * @param {number} index
 */
export const userSegmentPartId = (messageID, metadata, index) => (
  readDevryanPartDescriptors(metadata)?.[index]?.id ?? userTextPartId(messageID, index)
);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Clamp one `time.created` (epoch ms) so records sort strictly increasing in seq
 * order: `t_i = max(t_i, t_{i-1} + 1)`. A missing `previous` leaves the value
 * as is; a missing `created` takes `previous + 1`; both missing yields `undefined`.
 * @param {unknown} created
 * @param {unknown} previous the clamped time of the preceding record
 * @returns {number | undefined}
 */
export const clampIncreasingTime = (created, previous) => {
  if (!isFiniteNumber(previous)) return isFiniteNumber(created) ? created : undefined;
  if (!isFiniteNumber(created)) return previous + 1;
  return created > previous ? created : previous + 1;
};

/**
 * Applies {@link clampIncreasingTime} across times listed in seq order.
 * @param {readonly unknown[]} times
 * @param {unknown} [previous] the clamped time preceding the first entry (for example the last
 *   record of the previous page or the live fold)
 * @returns {(number | undefined)[]}
 */
export const clampIncreasingTimes = (times, previous) => {
  if (!Array.isArray(times)) return [];
  let last = previous;
  return times.map((created) => {
    const clamped = clampIncreasingTime(created, last);
    if (clamped !== undefined) last = clamped;
    return clamped;
  });
};

/** Retained original ACP IDs, only on explicitly marked external Cursor rows.
 * @param {unknown} metadata @param {unknown} item */
export const readCursorPartID = (metadata, item) => {
  if (!isRecord(metadata) || !isRecord(metadata.devryan) || !isRecord(metadata.devryan.cursor)
    || metadata.devryan.cursor.source !== 'cursor-acp' || !isRecord(item)) return null;
  const state = item.type === 'tool' ? item.providerState : item.state;
  if (!isRecord(state) || !isRecord(state.devryan) || !isRecord(state.devryan.cursor)) return null;
  const id = state.devryan.cursor.partID;
  return isNonEmptyString(id) && id.length <= 256 ? id : null;
};
/** @param {unknown} message */
export const isCursorAssistant = message => isRecord(message) && isRecord(message.model)
  && message.model.providerID === 'cursor-acp' && isRecord(message.metadata)
  && isRecord(message.metadata.devryan) && isRecord(message.metadata.devryan.cursor)
  && message.metadata.devryan.cursor.source === 'cursor-acp';
