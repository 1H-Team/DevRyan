// ---------------------------------------------------------------------------
// Tool media attachment trimming.
//
// Since OpenCode 2.1.3 an MCP tool result keeps supported media inline, and the
// v2 projector turns each `file` content item into a v1 `state.attachments`
// entry whose `url` is the whole `data:` URI (`v2/projection/tools.js`). One
// screenshot is often several hundred KB of base64, carried again by every
// history page, replay entry and live part update.
//
// Browser payloads (history pages, the single-message route and the live
// stream) keep small data URIs and replace larger ones with an empty `url` plus
// `devryanOmitted: { bytes }`. The renderer fetches the full message on demand
// through `GET /api/session/:sessionID/message/:messageID?attachments=inline`,
// which skips this trim, when a thumbnail nears the viewport.
//
// Kill switch: `DEVRYAN_TOOL_ATTACHMENT_OMIT=off` (read on every use) keeps
// every attachment inline.
// ---------------------------------------------------------------------------

import { stripEventDiffContent } from './diff-summary.js';

export const TOOL_ATTACHMENT_OMIT_ENV = 'DEVRYAN_TOOL_ATTACHMENT_OMIT';
/** Data URIs up to this many characters stay inline (small icons, thumbnails). */
export const TOOL_ATTACHMENT_INLINE_LIMIT = 32 * 1024;

const DATA_URI = /^data:/i;

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/** @param {Record<string, string | undefined>} [env] */
export const isToolAttachmentOmissionEnabled = (env = process.env) => {
  const value = String(env?.[TOOL_ATTACHMENT_OMIT_ENV] ?? '').trim().toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false');
};

/** Decoded size of a data URI's payload, without decoding it. */
export const estimateDataUriBytes = (uri) => {
  const comma = uri.indexOf(',');
  if (comma === -1) return 0;
  const payload = uri.length - comma - 1;
  if (!/;base64$/i.test(uri.slice(0, comma))) return payload;
  const padding = uri.endsWith('==') ? 2 : uri.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
};

const stripAttachment = (attachment) => {
  if (!isRecord(attachment) || typeof attachment.url !== 'string') return attachment;
  if (attachment.url.length <= TOOL_ATTACHMENT_INLINE_LIMIT || !DATA_URI.test(attachment.url)) return attachment;
  return { ...attachment, url: '', devryanOmitted: { bytes: estimateDataUriBytes(attachment.url) } };
};

/**
 * Replaces large data-URI attachments of one v1 tool part. Returns the same
 * reference when nothing was trimmed.
 * @param {unknown} part
 * @param {Record<string, string | undefined>} [env]
 */
export const stripToolPartAttachmentData = (part, env = process.env) => {
  if (!isRecord(part) || part.type !== 'tool' || !isRecord(part.state)) return part;
  const { attachments } = part.state;
  if (!Array.isArray(attachments) || attachments.length === 0) return part;
  if (!isToolAttachmentOmissionEnabled(env)) return part;
  const stripped = attachments.map(stripAttachment);
  if (stripped.every((attachment, index) => attachment === attachments[index])) return part;
  return { ...part, state: { ...part.state, attachments: stripped } };
};

/**
 * Same trim for a v1 message record (`{ info, parts }`).
 * @param {unknown} record
 * @param {Record<string, string | undefined>} [env]
 */
export const stripMessageToolAttachmentData = (record, env = process.env) => {
  if (!isRecord(record) || !Array.isArray(record.parts)) return record;
  const parts = record.parts.map((part) => stripToolPartAttachmentData(part, env));
  return parts.some((part, index) => part !== record.parts[index]) ? { ...record, parts } : record;
};

/**
 * Live-stream variant for a v1 `message.part.updated` payload. Every other
 * event type is returned untouched, by reference.
 * @param {unknown} payload
 * @param {Record<string, string | undefined>} [env]
 */
export const stripEventToolAttachmentData = (payload, env = process.env) => {
  if (!isRecord(payload) || payload.type !== 'message.part.updated' || !isRecord(payload.properties)) return payload;
  const part = stripToolPartAttachmentData(payload.properties.part, env);
  return part === payload.properties.part ? payload : { ...payload, properties: { ...payload.properties, part } };
};

/**
 * The browser fan-out transform of the global message hub: diff bodies and
 * large tool media never enter replay or reach a client.
 * @param {unknown} payload
 */
export const stripBrowserEventPayload = (payload) => stripEventToolAttachmentData(stripEventDiffContent(payload));
