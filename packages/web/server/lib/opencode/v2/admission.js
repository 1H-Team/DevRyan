// ---------------------------------------------------------------------------
// Gen-2 admission: every DevRyan write that starts or shapes a turn on
// OpenCode 2.x (DESIGN.md B.5, E item 12).
//
//   prompt   v1 prompt_async body (or the companion `{prompt, delivery}` body)
//            -> selection switches, then `POST /api/session/:id/prompt`
//   command  v1 command body -> selection switches, then `POST .../command`
//   compact  v1 summarize -> `POST .../compact`
//   abort    `POST .../interrupt`; `true` for `interrupted: true` and for the
//            idle no-op `interrupted: false` ([sm M37])
//   create   DevRyan-generated id (idempotent retries, [sm M30]); a child goes
//            to the privileged `createChildSession` (`POST /devryan/session`)
//   fork     `{before: messageID}` ([sm M40])
//   remove   204 -> `true` ([sm M43])
//
// Selection writes (agent, model, permissions) and prompt admission run under
// a per-session admission lock (`withSessionLock`), the seam the Phase 3 revert
// coordinator serializes against. While the session is busy a prompt that
// would change the agent or model is refused with 409
// `selection_change_while_busy`: a switch would apply to the running turn's
// next step. Switches are sent only on change: `switchAgent` always appends an
// `agent-switched` row (accepted noise; the projector drops it), `switchModel`
// compares `{id, providerID, variant ?? 'default'}` as 2.0.20 does.
//
// The prompt carries `metadata.devryan` (DEVRYAN_PROMPT_METADATA_SCHEMA): the
// turn's origin, agent, model and variant, plan mode, the objective, and the
// client's text segments `{kind, length, id?}`. Plan-mode prefaces and text
// attachments are inlined as `synthetic`/`attachment` segments of the one user
// text (never `POST /synthetic`), so they stay in the same model-visible turn.
// Segments are concatenated without separators: the descriptor lengths must sum
// to the text length (`projection/ids.js` `userTextSegments`).
//
// Retries are idempotent: the message id comes from the body `messageID` or the
// `x-openchamber-message-id` header (generated otherwise). A repeat of an
// admitted id with the same accepted operation resolves without new writes.
// Its digest is persisted on that turn's inbox/transcript metadata, not the
// session's latest metadata. Existing turns are checked before selection writes;
// both successful native replay and conflicts must prove the same identity.
//
// v1 `tools` overrides become native session permission rules. Native writers
// share the `edit` action, so contradictory writer overrides fail explicitly.
// Permission changes, like selection changes, cannot alter a running turn.
//
// Privilege boundary (C.1): this module is on the privileged-importer
// allowlist (`opencode-client.contract.test.js`). It is never handed to route
// handlers; the openCodeClient reaches it through `deps.getAdmission`.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

import { unwrapData } from '../opencode-client/envelope.js';
import {
  createCapabilityUnavailableError,
  createOpenCodeClientError,
  OPENCODE_CLIENT_ERROR_CODES,
} from '../opencode-client/errors.js';
import { createOpenCodeClient } from '../opencode-client/index.js';
import { createPrivilegedOpenCodeClient } from '../opencode-client/privileged.js';
import { createV2AudienceRequester } from '../opencode-client/requester.js';
import { isSameOpenCodeRuntime, readOpenCodeRuntime, withOpenCodeRuntime } from '../opencode-client/runtime.js';
import { createV2SessionId, toV2ModelRef } from '../opencode-client/v2.js';
import { toV1PermissionRuleset, toV1Session } from './projection/sessions.js';
import { activeSessionIDs } from './projection/status.js';
import { toV2ToolName } from './projection/tools.js';

const C = OPENCODE_CLIENT_ERROR_CODES;

/** Error codes raised by the admission module (besides the client's). */
export const ADMISSION_ERROR_CODES = Object.freeze({
  selectionChangeWhileBusy: 'selection_change_while_busy',
  identityUncertain: 'opencode_admission_identity_uncertain',
});

export const DEVRYAN_PROMPT_METADATA_KEY = 'devryan';
export const DEVRYAN_PROMPT_METADATA_VERSION = 1;
export const DEVRYAN_PROMPT_SEGMENT_KINDS = Object.freeze(['text', 'synthetic', 'attachment']);
/** Upper bound on text segments in one prompt. */
export const DEVRYAN_PROMPT_MAX_SEGMENTS = 256;
/** 2.0.20 refuses attachments above 20 MB ([sm risks]). */
export const V2_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Admitted prompt ids remembered for idempotent retries. */
export const ADMISSION_DEDUPE_LIMIT = 512;
export const ADMISSION_DISPATCH_TIMEOUT_MS = 30_000;
export const ADMISSION_DELIVERIES = Object.freeze(['queue', 'steer']);
/** Default delivery for prompts and commands (B.5; F10 may change it). */
export const ADMISSION_DEFAULT_DELIVERY = 'queue';

export const PROMPT_MESSAGE_ID_HEADER = 'x-openchamber-message-id';
export const PROMPT_ORIGIN_HEADER = 'x-devryan-prompt-origin';

/** The synthetic preface the UI adds for plan mode (`ui/src/lib/messages/actionablePlan.ts`). */
const PLAN_MODE_INSTRUCTION_PREFIX = 'User has requested to enter plan mode';
/** The synthetic text the UI builds for a text-like attachment (`ui/src/lib/opencode/client.ts`). */
const ATTACHMENT_SEGMENT_PATTERN = /^Attached file: [^\n]*\nMIME type: [^\n]*\n\n<file_content>\n/;
const MESSAGE_ID_PATTERN = /^msg_[0-9A-Za-z_-]{1,128}$/;
const SESSION_ID_PATTERN = /^ses[0-9A-Za-z_-]{1,128}$/;
const ORIGIN_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const DATA_URL_PATTERN = /^data:([^;,]*)((?:;[^;,]*)*),/;
// The 2.0.20 `Prompt.Base64` pattern, checked without a grouped repetition: V8
// overflows its stack on a grouped quantifier over a multi-megabyte string.
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;
const isCanonicalBase64 = (value) => value.length % 4 === 0 && BASE64_ALPHABET.test(value);
const TEXT_LIKE_MIMES = new Set([
  'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml',
  'application/javascript', 'application/typescript', 'application/x-sh', 'application/sql',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const encode = (value) => encodeURIComponent(String(value));

const invalidInput = (operation, message, detail) => createOpenCodeClientError(C.invalidInput, 400,
  `${operation}: ${message}`, { operation, generation: 2, ...(detail ? { detail } : {}) });

// ---------------------------------------------------------------------------
// metadata.devryan (B.5)

/**
 * The `metadata.devryan` block of a gen-2 prompt, as a JSON Schema (draft
 * 2020-12 vocabulary). `validateDevryanPromptMetadata` enforces it; the readers
 * are `projection/ids.js` (`readDevryanPartDescriptors`) and
 * `projection/messages.js` (`readDevryanPromptSelection`).
 */
export const DEVRYAN_PROMPT_METADATA_SCHEMA = Object.freeze({
  $id: 'devryan:prompt-metadata/v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'origin', 'planMode', 'parts'],
  properties: Object.freeze({
    v: Object.freeze({ const: DEVRYAN_PROMPT_METADATA_VERSION }),
    origin: Object.freeze({ type: 'string', pattern: ORIGIN_PATTERN.source }),
    agent: Object.freeze({ type: 'string', minLength: 1 }),
    providerID: Object.freeze({ type: 'string', minLength: 1 }),
    modelID: Object.freeze({ type: 'string', minLength: 1 }),
    // A string is an explicit variant; null is the v1 explicit provider default
    // (empty variant); absent means the agent's variant was inherited.
    variant: Object.freeze({ type: ['string', 'null'] }),
    planMode: Object.freeze({ type: 'boolean' }),
    parts: Object.freeze({
      type: 'array',
      maxItems: DEVRYAN_PROMPT_MAX_SEGMENTS,
      // UTF-16 lengths; they sum to the prompt text length. Ids are unique.
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'length'],
        properties: Object.freeze({
          kind: Object.freeze({ enum: DEVRYAN_PROMPT_SEGMENT_KINDS }),
          length: Object.freeze({ type: 'integer', minimum: 0 }),
          id: Object.freeze({ type: 'string', minLength: 1 }),
        }),
      }),
    }),
    objectiveID: Object.freeze({ type: 'string', pattern: MESSAGE_ID_PATTERN.source }),
    admission: Object.freeze({
      type: 'object', additionalProperties: false, required: ['v', 'fingerprint'],
      properties: Object.freeze({
        v: Object.freeze({ const: 1 }),
        fingerprint: Object.freeze({ type: 'string', pattern: '^[a-f0-9]{64}$' }),
      }),
    }),
  }),
});

const METADATA_KEYS = new Set(Object.keys(DEVRYAN_PROMPT_METADATA_SCHEMA.properties));
const SEGMENT_KEYS = new Set(['kind', 'length', 'id']);

/**
 * Validates a `metadata.devryan` block against {@link DEVRYAN_PROMPT_METADATA_SCHEMA}.
 * With `text`, the segment lengths must also sum to its UTF-16 length.
 * @param {unknown} value
 * @param {{ text?: string }} [options]
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export const validateDevryanPromptMetadata = (value, options = {}) => {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ['metadata.devryan must be an object'] };
  for (const key of Object.keys(value)) if (!METADATA_KEYS.has(key)) errors.push(`unknown key ${key}`);
  if (value.v !== DEVRYAN_PROMPT_METADATA_VERSION) errors.push('v must be 1');
  if (typeof value.origin !== 'string' || !ORIGIN_PATTERN.test(value.origin)) errors.push('origin is invalid');
  for (const key of ['agent', 'providerID', 'modelID']) {
    if (Object.hasOwn(value, key) && !isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (Object.hasOwn(value, 'variant') && value.variant !== null && typeof value.variant !== 'string') {
    errors.push('variant must be a string or null');
  }
  if (typeof value.planMode !== 'boolean') errors.push('planMode must be a boolean');
  if (Object.hasOwn(value, 'objectiveID') && (typeof value.objectiveID !== 'string' || !MESSAGE_ID_PATTERN.test(value.objectiveID))) {
    errors.push('objectiveID must be a message id');
  }
  if (Object.hasOwn(value, 'admission')) {
    const identity = value.admission;
    if (!isRecord(identity) || identity.v !== 1 || typeof identity.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(identity.fingerprint)
      || Object.keys(identity).some((key) => !['v', 'fingerprint'].includes(key))) {
      errors.push('admission must be a versioned accepted-operation fingerprint');
    }
  }
  if (!Array.isArray(value.parts)) {
    errors.push('parts must be an array');
  } else {
    if (value.parts.length > DEVRYAN_PROMPT_MAX_SEGMENTS) errors.push('too many parts');
    const ids = new Set();
    let total = 0;
    value.parts.forEach((part, index) => {
      if (!isRecord(part)) {
        errors.push(`parts[${index}] must be an object`);
        return;
      }
      for (const key of Object.keys(part)) if (!SEGMENT_KEYS.has(key)) errors.push(`parts[${index}] unknown key ${key}`);
      if (!DEVRYAN_PROMPT_SEGMENT_KINDS.includes(part.kind)) errors.push(`parts[${index}].kind is invalid`);
      if (!Number.isSafeInteger(part.length) || part.length < 0) errors.push(`parts[${index}].length is invalid`);
      else total += part.length;
      if (Object.hasOwn(part, 'id')) {
        if (!isNonEmptyString(part.id)) errors.push(`parts[${index}].id must be a non-empty string`);
        else if (ids.has(part.id)) errors.push(`parts[${index}].id is duplicated`);
        else ids.add(part.id);
      }
    });
    if (typeof options.text === 'string' && total !== options.text.length) errors.push('parts lengths do not sum to the text length');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
};

/**
 * Builds a valid `metadata.devryan` block. Throws on invalid input (a DevRyan
 * bug, never user data: segments come from {@link buildV2PromptContent}).
 * @param {{ origin: string, agent?: string, providerID?: string, modelID?: string,
 *   variant?: string | null, planMode: boolean, parts: { kind: string, length: number, id?: string }[],
 *   objectiveID?: string, admission?: { v: 1, fingerprint: string } }} input
 * @param {{ text?: string }} [options]
 */
export const buildDevryanPromptMetadata = (input, options = {}) => {
  const metadata = { v: DEVRYAN_PROMPT_METADATA_VERSION, origin: input.origin };
  if (isNonEmptyString(input.agent)) metadata.agent = input.agent;
  if (isNonEmptyString(input.providerID)) metadata.providerID = input.providerID;
  if (isNonEmptyString(input.modelID)) metadata.modelID = input.modelID;
  if (input.variant === null || typeof input.variant === 'string') metadata.variant = input.variant;
  metadata.planMode = input.planMode === true;
  metadata.parts = input.parts.map((part) => (part.id === undefined
    ? { kind: part.kind, length: part.length }
    : { kind: part.kind, length: part.length, id: part.id }));
  if (isNonEmptyString(input.objectiveID)) metadata.objectiveID = input.objectiveID;
  if (input.admission !== undefined) metadata.admission = { ...input.admission };
  const checked = validateDevryanPromptMetadata(metadata, options);
  if (!checked.ok) throw new TypeError(`Invalid metadata.devryan: ${checked.errors.join('; ')}`);
  return metadata;
};

// ---------------------------------------------------------------------------
// Prompt content (pure)

/** Lower-cased MIME without parameters. */
const baseMime = (mime) => (typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '');

const isTextLikeMime = (mime) => {
  const value = baseMime(mime);
  return value.startsWith('text/') || TEXT_LIKE_MIMES.has(value) || value.endsWith('+json') || value.endsWith('+xml');
};

/**
 * A v1 FilePart URL as a canonical base64 `data:` URL. Only `data:` URLs are
 * forwarded: 2.0.20 also reads `file:` URIs from the server's disk ([sm risks]).
 * @returns {{ mime: string, base64: string, uri: string, bytes: number }}
 */
const parseDataUrl = (operation, url, declaredMime) => {
  if (typeof url !== 'string' || !url.startsWith('data:')) {
    throw invalidInput(operation, 'file parts must be data: URLs on OpenCode 2', { reason: 'file_url_scheme' });
  }
  const header = DATA_URL_PATTERN.exec(url);
  if (!header) throw invalidInput(operation, 'malformed data: URL', { reason: 'file_url_malformed' });
  const params = header[2].split(';').filter(Boolean);
  if (!params.some((param) => param.toLowerCase() === 'base64')) {
    throw invalidInput(operation, 'data: URLs must be base64 encoded', { reason: 'file_url_not_base64' });
  }
  const mime = baseMime(header[1]) || baseMime(declaredMime) || 'application/octet-stream';
  const payload = url.slice(header[0].length);
  const base64 = isCanonicalBase64(payload) ? payload : Buffer.from(payload, 'base64').toString('base64');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  if (bytes > V2_ATTACHMENT_MAX_BYTES) {
    throw createOpenCodeClientError(C.payloadTooLarge, 413, `${operation}: attachment exceeds ${V2_ATTACHMENT_MAX_BYTES} bytes`,
      { operation, generation: 2, detail: { reason: 'attachment_too_large' } });
  }
  return { mime, base64, uri: base64 === payload ? url : `data:${mime};base64,${base64}`, bytes };
};

const decodeUtf8 = (base64) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }
};

/** The text segment the UI builds for a text-like attachment. */
export const formatAttachmentSegment = (filename, mime, text) => [
  `Attached file: ${isNonEmptyString(filename) ? filename.trim() || 'attachment' : 'attachment'}`,
  `MIME type: ${mime}`,
  '',
  '<file_content>',
  text,
  '</file_content>',
].join('\n');

/** v1 `{value, start, end}` source -> v2 `Prompt.Mention`. */
const toMention = (source) => {
  if (!isRecord(source)) return undefined;
  const { start, end } = source;
  const text = typeof source.value === 'string' ? source.value : source.text;
  if (!Number.isFinite(start) || !Number.isFinite(end) || typeof text !== 'string') return undefined;
  return { start, end, text };
};

/**
 * @typedef {object} V2PromptContent
 * @property {string} text the concatenated segments
 * @property {{ kind: string, length: number, id?: string }[]} segments
 * @property {{ uri: string, name?: string, mention?: object }[]} files
 * @property {{ name: string, mention?: object }[]} agents
 * @property {boolean} planMode a plan-mode preface was present
 */

/**
 * v1 prompt parts -> 2.0.20 prompt content (B.5): text parts become segments
 * (`synthetic: true` -> `synthetic`, or `attachment` for the UI's text
 * attachment shape); text-like `data:` file parts are inlined as `attachment`
 * segments; other `data:` files become `files[{uri, name}]`; agent parts become
 * `agents[{name, mention}]`. Any other part type, or a non-`data:` file, is
 * refused (`opencode_invalid_input`).
 * @param {unknown} parts
 * @param {{ operation?: string, inlineTextFiles?: boolean }} [options]
 * @returns {V2PromptContent}
 */
export const buildV2PromptContent = (parts, options = {}) => {
  const operation = options.operation ?? 'admission.prompt';
  const inlineTextFiles = options.inlineTextFiles !== false;
  if (!Array.isArray(parts)) throw invalidInput(operation, 'parts must be an array');
  const segments = [];
  const files = [];
  const agents = [];
  const seenIds = new Set();
  let text = '';
  let planMode = false;
  const claimId = (id) => {
    if (!isNonEmptyString(id) || seenIds.has(id)) return undefined;
    seenIds.add(id);
    return id;
  };
  const pushSegment = (kind, value, id) => {
    if (segments.length >= DEVRYAN_PROMPT_MAX_SEGMENTS) throw invalidInput(operation, 'too many text parts');
    const claimed = claimId(id);
    segments.push(claimed === undefined ? { kind, length: value.length } : { kind, length: value.length, id: claimed });
    text += value;
  };
  for (const part of parts) {
    if (!isRecord(part)) throw invalidInput(operation, 'every part must be an object');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw invalidInput(operation, 'text parts need text');
      if (part.ignored === true) continue;
      let kind = 'text';
      if (part.synthetic === true) kind = ATTACHMENT_SEGMENT_PATTERN.test(part.text) ? 'attachment' : 'synthetic';
      if (kind === 'synthetic' && part.text.trimStart().startsWith(PLAN_MODE_INSTRUCTION_PREFIX)) planMode = true;
      pushSegment(kind, part.text, part.id);
      continue;
    }
    if (part.type === 'file') {
      const data = parseDataUrl(operation, part.url, part.mime);
      const mime = baseMime(part.mime) || data.mime;
      const inlined = inlineTextFiles && isTextLikeMime(mime) ? decodeUtf8(data.base64) : null;
      if (inlined !== null) {
        pushSegment('attachment', formatAttachmentSegment(part.filename, mime, inlined), part.id);
        continue;
      }
      const file = { uri: data.uri };
      if (isNonEmptyString(part.filename)) file.name = part.filename;
      const mention = toMention(isRecord(part.source) ? part.source.text : undefined);
      if (mention) file.mention = mention;
      files.push(file);
      continue;
    }
    if (part.type === 'agent') {
      if (!isNonEmptyString(part.name)) throw invalidInput(operation, 'agent parts need a name');
      const agent = { name: part.name };
      const mention = toMention(part.source);
      if (mention) agent.mention = mention;
      agents.push(agent);
      continue;
    }
    throw invalidInput(operation, `part type ${String(part.type)} is not supported on OpenCode 2`, { reason: 'part_type_unsupported' });
  }
  return { text, segments, files, agents, planMode };
};

/**
 * The companion's immediate-prompt body `{prompt: {text, files, agents}, delivery: 'immediate'}`
 * ([sm M33]) as v1 parts.
 */
const companionPromptParts = (prompt) => {
  const parts = [];
  if (typeof prompt.text === 'string' && prompt.text.length > 0) parts.push({ type: 'text', text: prompt.text });
  for (const file of Array.isArray(prompt.files) ? prompt.files : []) {
    if (!isRecord(file)) continue;
    parts.push({ type: 'file', url: file.uri, mime: file.mime, ...(isNonEmptyString(file.name) ? { filename: file.name } : {}) });
  }
  for (const agent of Array.isArray(prompt.agents) ? prompt.agents : []) {
    if (isRecord(agent)) parts.push({ type: 'agent', name: agent.name, ...(isRecord(agent.source) ? { source: agent.source } : {}) });
  }
  return parts;
};

// ---------------------------------------------------------------------------
// Selection (pure)

/**
 * The requested model of a v1 body: `{providerID, modelID}` or `'provider/model'`.
 * @returns {{ providerID: string, modelID: string } | null}
 */
export const readRequestedModel = (model) => {
  if (isRecord(model) && isNonEmptyString(model.providerID) && isNonEmptyString(model.modelID)) {
    return { providerID: model.providerID, modelID: model.modelID };
  }
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    if (slash > 0 && slash < model.length - 1) return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
  return null;
};

/** `switchModel` equality, as 2.0.20 compares it ([sm M34]). */
export const isSameModelSelection = (current, target) => (
  isRecord(current) && isRecord(target)
  && current.providerID === target.providerID
  && (current.id ?? current.modelID) === (target.id ?? target.modelID)
  && (isNonEmptyString(current.variant) ? current.variant : 'default') === (isNonEmptyString(target.variant) ? target.variant : 'default')
);

/** v1 PermissionRuleset `{permission, pattern, action}` -> v2 Ruleset `{action, resource, effect}`. */
export const toV2PermissionRuleset = (rules) => {
  if (!Array.isArray(rules)) return undefined;
  const projected = [];
  for (const rule of rules) {
    if (!isRecord(rule) || !isNonEmptyString(rule.permission) || typeof rule.pattern !== 'string'
      || !['allow', 'deny', 'ask'].includes(rule.action)) {
      throw invalidInput('admission.create', 'permission rules need {permission, pattern, action}');
    }
    projected.push({ action: toV2ToolName(rule.permission), resource: rule.pattern, effect: rule.action });
  }
  return projected;
};

/**
 * Pinned 2.0.20 Tool.snapshot and Permission.evaluate use the tool's permission
 * action, with the last matching rule winning. write/edit/patch all use edit.
 * Reject contradictory aliases instead of widening a denied writer's grant.
 */
const PINNED_TOOL_PERMISSION_ACTIONS = new Set([
  'read', 'glob', 'grep', 'shell', 'write', 'edit', 'patch', 'subagent',
  'skill', 'question', 'webfetch', 'websearch', 'execute',
]);

const normalizeToolOverrides = (tools, operation) => {
  if (tools === undefined) return {};
  if (!isRecord(tools)) throw invalidInput(operation, 'tools must be boolean overrides');
  const overrides = Object.create(null);
  for (const [name, enabled] of Object.entries(tools)) {
    if(name==='*'){
      if(enabled!==false)throw invalidInput(operation,'wildcard tools can only deny');
      overrides['*']=false;continue;
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(name) || typeof enabled !== 'boolean') {
      throw invalidInput(operation, 'tools need literal tool names and boolean values');
    }
    const native = toV2ToolName(name);
    // Plugin tools may set options.permission to a different/shared action.
    // The HTTP catalog does not attest that mapping. Require B's reviewed host
    // registration instead of pretending a same-named rule disables the tool.
    if (!PINNED_TOOL_PERMISSION_ACTIONS.has(native)) {
      // A final wildcard deny already disables every custom permission action.
      // Unknown false names add no grant and need no guessed action mapping.
      if(enabled===false&&tools['*']===false)continue;
      throw createOpenCodeClientError(C.capabilityUnavailable, 501,
        `${operation}: the native permission action for tool ${name} is unavailable`,
        { operation, generation: 2, detail: { capability: 'prompt.tools', reason: 'tool_permission_action_unavailable', tool: name } });
    }
    const action = ['write', 'edit', 'patch'].includes(native) ? 'edit' : native;
    if (Object.hasOwn(overrides, action) && overrides[action] !== enabled) {
      throw createOpenCodeClientError(C.capabilityUnavailable, 501,
        `${operation}: tools sharing the ${action} permission cannot have conflicting overrides`,
        { operation, generation: 2, detail: { capability: 'prompt.tools', reason: 'shared_permission_action', action } });
    }
    overrides[action] = enabled;
  }
  // A false writer override can conservatively disable the whole native group.
  // An allow must explicitly cover the whole group; otherwise it grants tools
  // the caller never enabled. Host per-executor denies can narrow this in B.
  if (overrides.edit === true && !['write', 'edit', 'patch'].every((writer) => (
    Object.entries(tools).some(([name, enabled]) => toV2ToolName(name) === writer && enabled === true)
  ))) {
    throw createOpenCodeClientError(C.capabilityUnavailable, 501,
      `${operation}: native writer permissions cannot enable just one writer`,
      { operation, generation: 2, detail: { capability: 'prompt.tools', reason: 'shared_permission_action', action: 'edit' } });
  }
  return overrides;
};

const validateNativeRules = (rules, operation) => {
  if (!Array.isArray(rules) || rules.some((rule) => !isRecord(rule) || !isNonEmptyString(rule.action)
    || typeof rule.resource !== 'string' || !['allow', 'deny', 'ask'].includes(rule.effect))) {
    throw createCapabilityUnavailableError('prompt.tools', { operation, generation: 2 });
  }
  return rules;
};

const applyToolOverrides = (rules, overrides) => [
  ...rules.filter((rule) => rule.resource !== '*' || !Object.hasOwn(overrides, rule.action)),
  ...Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
    .map(([action, enabled]) => ({ action, resource: '*', effect: enabled ? 'allow' : 'deny' })),
];

const validateSelectionInput = (body, operation) => {
  normalizeToolOverrides(body.tools, operation);
  if (body.agent !== undefined && !isNonEmptyString(body.agent)) throw invalidInput(operation, 'agent must be a non-empty string');
  if (body.model !== undefined && !readRequestedModel(body.model)) throw invalidInput(operation, 'model needs providerID and modelID');
  if (body.variant !== undefined && body.variant !== null && typeof body.variant !== 'string') throw invalidInput(operation, 'variant must be a string or null');
};

const sortedJson = (value) => JSON.stringify(value, (_key, entry) => (isRecord(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
  : entry));

const fingerprint = (value) => crypto.createHash('sha256').update(sortedJson(value)).digest('hex');

/** The durable accepted-prompt identity, shared with offline bundle checks.
 * @param {{ sessionID: string, messageID: string, content: V2PromptContent,
 *   selection: { agent?: string, model?: unknown, variant?: string, tools?: Record<string, boolean> },
 *   objectiveID?: string, origin: string, resume: boolean, delivery: 'queue' | 'steer', planMode: boolean }} input
 * @returns {string}
 */
export const buildV2PromptFingerprint = ({ sessionID, messageID, content, selection, objectiveID, origin, resume, delivery, planMode }) =>
  fingerprint({ v: 1, generation: 2, sessionID, messageID,
    text: content.text, segments: content.segments, files: content.files, agents: content.agents,
    agent: selection.agent ?? null, model: readRequestedModel(selection.model),
    variant: selection.variant === undefined ? { inherit: true } : (selection.variant === '' ? null : selection.variant),
    tools: selection.tools ?? {}, objectiveID: objectiveID ?? null, origin, resume, delivery, planMode });

// ---------------------------------------------------------------------------
// Identifiers

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdTimestamp = 0;
let idCounter = 0;

/** An ascending 2.x message id (`msg_` + the `@opencode/schema/identifier` layout). */
export const createV2MessageId = (timestamp = Date.now()) => {
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  const time = Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - 8 * index)) & 0xffn)
    .toString(16).padStart(2, '0')).join('');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join('');
  return `msg_${time}${random}`;
};

const readHeader = (headers, name) => {
  if (!isRecord(headers)) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (key === undefined) return undefined;
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
};

/** The prompt id: body `messageID`, else the header, else a new id. Both given must agree. */
const resolveMessageId = (operation, body, options) => {
  const fromBody = isNonEmptyString(body.messageID) ? body.messageID : undefined;
  const fromOptions = isNonEmptyString(options.messageID) ? options.messageID : readHeader(options.headers, PROMPT_MESSAGE_ID_HEADER);
  const fromHeader = isNonEmptyString(fromOptions) ? fromOptions : undefined;
  if (fromBody && fromHeader && fromBody !== fromHeader) throw invalidInput(operation, 'messageID and the message id header differ');
  const id = fromBody ?? fromHeader;
  if (id === undefined) return { id: createV2MessageId(), generated: true };
  if (!MESSAGE_ID_PATTERN.test(id)) throw invalidInput(operation, 'messageID must be a msg_ identifier');
  return { id, generated: false };
};

const resolveOrigin = (options) => {
  const value = isNonEmptyString(options.origin) ? options.origin : readHeader(options.headers, PROMPT_ORIGIN_HEADER);
  return typeof value === 'string' && ORIGIN_PATTERN.test(value) ? value : 'unknown';
};

const resolveDelivery = (operation, body, options, fallback) => {
  const requested = options.delivery ?? body.delivery;
  if (requested === undefined || requested === null) return fallback;
  if (requested === 'immediate') return 'steer';
  if (ADMISSION_DELIVERIES.includes(requested)) return requested;
  throw invalidInput(operation, 'delivery must be queue, steer or immediate');
};

// ---------------------------------------------------------------------------
// The module

/**
 * @typedef {object} AdmissionToolRuleRequest
 * @property {string} sessionID
 * @property {string} messageID
 * @property {Record<string, boolean>} tools the v1 overrides
 * @property {string | undefined} agent the effective agent
 * @property {{ providerID: string, modelID: string } | null} model the effective model
 * @property {Record<string, unknown>} session the projected v1 session
 */

/**
 * @typedef {object} AdmissionOptions
 * @property {ReturnType<typeof createOpenCodeClient>} [client] the openCodeClient (built from deps when absent)
 * @property {ReturnType<typeof createPrivilegedOpenCodeClient>} [privileged] the privileged client (built from deps when absent)
 * @property {{ resolve: (request: AdmissionToolRuleRequest) => unknown[] | null | undefined | Promise<unknown[] | null | undefined> }} [toolRules]
 *   Optional native base-rules resolver. Required overrides are appended after it;
 *   an unavailable resolver fails closed rather than ignoring requested tools.
 * @property {'queue' | 'steer'} [defaultDelivery]
 * @property {() => boolean} [requiresEffectiveSelection]
 * @property {(receipt: object) => Promise<unknown>} [beforePromptDispatch]
 * @property {(receipt: object) => Promise<unknown>} [onPromptDispatchFailure]
 * @property {(receipt: object, request: object) => Promise<boolean>} [externalPromptDispatch] Constructor-owned external provider; must persist the same native accepted turn.
 * @property {{ requestHeaders(): Record<string,string>, withAcceptedOperation(input:object, action:()=>Promise<unknown>):Promise<unknown>, withCommandSelection(input:{sessionID:string,delivery?:'queue'|'steer'}, action:()=>Promise<unknown>):Promise<unknown>, updateAcceptedOperation(input:object):void, checkQueuedPromptAdmission(input:object):Promise<void>, stageQueuedPromptAdmission(receipt:object,admit:(authorizeWrite:()=>Promise<void>)=>Promise<void>):Promise<void>, assertQueuedPromptReconciled(input:object):Promise<void>, queuedPromptWasRejected():boolean }} [nativeOwner]
 */

/**
 * Creates the gen-2 admission module. `deps` are the openCodeClient deps
 * (`getRuntime`, `getAuthHeaders`, `fetchImpl`, `policy`, `projector`,
 * `recordDiagnostic`). Wire the client's `getAdmission` to the result.
 * @param {import('../opencode-client/v2.js').V2BackendDeps} deps
 * @param {AdmissionOptions} [options]
 */
export const createOpenCodeAdmission = (deps, options = {}) => {
  if (!isRecord(deps) || typeof deps.getRuntime !== 'function') throw new TypeError('getRuntime is required');
  const defaultDelivery = options.defaultDelivery ?? ADMISSION_DEFAULT_DELIVERY;
  if (!ADMISSION_DELIVERIES.includes(defaultDelivery)) throw new TypeError('defaultDelivery must be queue or steer');
  const recordDiagnostic = typeof deps.recordDiagnostic === 'function' ? deps.recordDiagnostic : () => {};
  const ownedDeps = options.nativeOwner ? { ...deps, getAuthHeaders: async () => ({
    ...await deps.getAuthHeaders?.(), ...options.nativeOwner.requestHeaders(),
  }) } : deps;
  const serverRequest = createV2AudienceRequester(ownedDeps, { audience: 'server' });
  const privilegedRequest = createV2AudienceRequester(ownedDeps, { audience: 'privileged' });
  /** @type {Readonly<Record<string, unknown>> | undefined} */
  let admission;
  const client = options.client ?? createOpenCodeClient({ ...deps, getAdmission: () => admission });
  const privileged = options.privileged ?? createPrivilegedOpenCodeClient(ownedDeps);
  const toolRules = typeof options.toolRules?.resolve === 'function' ? options.toolRules : {
    resolve: ({ session }) => toV2PermissionRuleset(session.permission ?? []),
  };

  const resolveProjector = () => {
    const value = typeof deps.projector === 'function' ? deps.projector() : deps.projector;
    return isRecord(value) ? value : null;
  };

  const requireGen2 = (operation) => {
    const generation = readOpenCodeRuntime(deps.getRuntime)?.generation;
    if (generation !== 2) throw createCapabilityUnavailableError(operation, { operation, generation: generation === 1 ? 1 : null });
  };

  const requireSessionId = (operation, sessionID) => {
    if (typeof sessionID !== 'string' || !SESSION_ID_PATTERN.test(sessionID)) throw invalidInput(operation, 'a session id is required');
  };

  const pass = (opts, label, defaultTimeoutMs) => ({
    label,
    allowNotFound: opts.allowNotFound === true,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
    onResponseRead: opts.onResponseRead,
    defaultTimeoutMs,
  });

  const clientOptions = (opts) => ({
    ...(opts.directory === undefined ? {} : { directory: opts.directory }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.maxResponseBytes === undefined ? {} : { maxResponseBytes: opts.maxResponseBytes }),
    ...(opts.onResponseRead === undefined ? {} : { onResponseRead: opts.onResponseRead }),
  });

  // -------------------------------------------------------------------------
  // Per-session admission lock

  /** sessionID -> the tail of its admission chain (never rejects). */
  const tails = new Map();

  /**
   * Runs `run` while holding the session's admission lock. Waiting honours
   * `signal`; the lock is released when `run` settles.
   * @template T
   * @param {string} sessionID
   * @param {() => Promise<T>} run
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<T>}
   */
  const withSessionLock = async (sessionID, run, opts = {}) => {
    const previous = tails.get(sessionID) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(sessionID, tail);
    try {
      if (opts.signal) {
        opts.signal.throwIfAborted();
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(opts.signal.reason);
          opts.signal.addEventListener('abort', onAbort, { once: true });
          previous.then(() => {
            opts.signal.removeEventListener('abort', onAbort);
            resolve();
          });
        });
      } else {
        await previous;
      }
      return await run();
    } finally {
      release();
      if (tails.get(sessionID) === tail) tails.delete(sessionID);
    }
  };

  // -------------------------------------------------------------------------
  // Idempotency

  /** messageID -> `{sessionID, fingerprint}` of admitted prompts (LRU). */
  const admitted = new Map();
  const rememberAdmitted = (messageID, entry) => {
    admitted.delete(messageID);
    admitted.set(messageID, entry);
    if (admitted.size > ADMISSION_DEDUPE_LIMIT) admitted.delete(admitted.keys().next().value);
  };

  const reusedId = (id) => createOpenCodeClientError(C.conflict, 409,
    `admission.prompt: message ${id} was already admitted with another operation`,
    { operation: 'admission.prompt', generation: 2, detail: { reason: 'prompt_id_reused' } });

  const uncertainIdentity = (id) => createOpenCodeClientError(ADMISSION_ERROR_CODES.identityUncertain, 409,
    `admission.prompt: accepted operation for message ${id} cannot be verified`,
    { operation: 'admission.prompt', generation: 2, detail: { reason: 'accepted_identity_unavailable' } });

  /**
   * Only admission builds this reserved metadata; caller-supplied metadata is
   * never forwarded. B's native host must preserve its authorship through hooks.
   * Legacy, malformed or missing identity cannot prove replay equivalence.
   */
  const assertAcceptedIdentity = (row, sessionID, id, contentKey) => {
    if (!isRecord(row) || row.id !== id || (row.sessionID !== undefined && row.sessionID !== sessionID)) {
      throw uncertainIdentity(id);
    }
    if (row.type !== 'user') throw reusedId(id);
    const payload = isRecord(row.payload) ? row.payload : row;
    const metadata = payload.metadata?.[DEVRYAN_PROMPT_METADATA_KEY];
    if (typeof payload.text !== 'string' || !validateDevryanPromptMetadata(metadata, { text: payload.text }).ok || !metadata.admission) {
      throw uncertainIdentity(id);
    }
    if (metadata.admission.fingerprint !== contentKey) throw reusedId(id);
  };

  /**
   * Read inbox before transcript: native promotion atomically moves an item
   * from inbox to transcript, so the reverse order can miss it between reads.
   */
  const findAcceptedTurn = async (sessionID, id, opts) => {
    const inbox = unwrapData(await serverRequest({
      ...pass(opts, 'admission.prompt'),
      allowNotFound: false,
      path: `/api/session/${encode(sessionID)}/inbox`,
    }));
    if (!Array.isArray(inbox) || inbox.some((item) => !isRecord(item) || !isNonEmptyString(item.id))) {
      throw uncertainIdentity(id);
    }
    const pending = inbox.find((candidate) => candidate.id === id);
    if (pending) return pending;
    const message = await serverRequest({
      ...pass(opts, 'admission.prompt'),
      allowNotFound: true,
      path: `/api/session/${encode(sessionID)}/message/${encode(id)}`,
    });
    if (message === null) return null;
    const row = unwrapData(message);
    if (!isRecord(row)) throw uncertainIdentity(id);
    return row;
  };

  // -------------------------------------------------------------------------
  // Selection

  const isBusy = async (sessionID, opts) => {
    const live = resolveProjector()?.sessionStatus?.(sessionID);
    if (isRecord(live) && (live.type === 'busy' || live.type === 'retry')) return true;
    const body = await serverRequest({ ...pass(opts, 'admission.status'), allowNotFound: false, path: '/api/session/active' });
    if (!isRecord(body) || !isRecord(body.data) || Object.entries(body.data).some(([id, state]) => (
      !SESSION_ID_PATTERN.test(id) || !isRecord(state)
    ))) {
      throw createOpenCodeClientError(C.invalidResponse, 502, 'admission.status: native activity snapshot is invalid',
        { operation: 'admission.status', generation: 2 });
    }
    return activeSessionIDs(body).has(sessionID);
  };

  /**
   * The variant a v1 body asks for: a string is explicit; `''` (the v1
   * explicit provider default) and `null` omit it (2.0.20 `default`); absent
   * means the agent's configured variant for that model, from the catalog.
   * @returns {Promise<{ variant: string | undefined, recorded: string | null | undefined }>}
   */
  const resolveVariant = async ({ variant, agent, model, directory, opts, primary }) => {
    if (isNonEmptyString(variant)) return { variant, recorded: variant };
    if (variant === '' || variant === null) return { variant: undefined, recorded: null };
    if (!isNonEmptyString(agent) || !isNonEmptyString(directory)) return { variant: undefined, recorded: undefined };
    try {
      const agents = await client.catalog.agents({ directory }, clientOptions(opts));
      const entry = Array.isArray(agents) ? agents.find((candidate) => isRecord(candidate) && candidate.name === agent) : undefined;
      const sameModel = isRecord(entry?.model) && entry.model.providerID === model.providerID && entry.model.modelID === model.modelID;
      return { variant: sameModel && isNonEmptyString(entry.variant) ? entry.variant : undefined, recorded: undefined };
    } catch (error) {
      if (opts.signal?.aborted || error?.code === C.runtimeChanged || error?.code === 'opencode_response_too_large'
        || error?.name === 'AbortError' || error?.name === 'TimeoutError' || typeof opts.onResponseRead === 'function'
        || (primary && ((typeof options.beforePromptDispatch === 'function' && options.requiresEffectiveSelection?.() !== false)
          || typeof opts.beforePromptDispatch === 'function'))) throw error;
      recordDiagnostic({ code: 'opencode_admission_variant_unresolved', generation: 2, operation: 'admission.prompt',
        errorCode: typeof error?.code === 'string' ? error.code : null });
      return { variant: undefined, recorded: undefined };
    }
  };

  /**
   * Applies the requested agent/model and native tool permissions under the
   * caller's lock. Returns the effective selection for `metadata.devryan`.
   */
  const applySelection = async ({ operation, sessionID, messageID, body, opts }) => {
    const overrides = normalizeToolOverrides(body.tools, operation);
    const session = await client.sessions.get(sessionID, clientOptions(opts));
    const directory = isNonEmptyString(opts.directory) ? opts.directory : session.directory;
    const requestedAgent = isNonEmptyString(body.agent) ? body.agent : undefined;
    const requestedModel = readRequestedModel(body.model);
    let target;
    let recordedVariant;
    if (requestedModel) {
      const resolved = await resolveVariant({ variant: body.variant, agent: requestedAgent ?? session.agent, model: requestedModel, directory, opts, primary: !session.parentID });
      target = { id: requestedModel.modelID, providerID: requestedModel.providerID, ...(resolved.variant ? { variant: resolved.variant } : {}) };
      recordedVariant = resolved.recorded;
    }
    const switchAgent = requestedAgent !== undefined && requestedAgent !== session.agent;
    const switchModel = target !== undefined && !isSameModelSelection(session.model, target);
    const agent = requestedAgent ?? (isNonEmptyString(session.agent) ? session.agent : undefined);
    const effectiveModel = requestedModel
      ?? (isRecord(session.model) && isNonEmptyString(session.model.id) ? { providerID: session.model.providerID, modelID: session.model.id } : null);
    let rules;
    if (Object.keys(overrides).length > 0) {
      const resolved = await toolRules.resolve({ sessionID, messageID, tools: body.tools, agent, model: effectiveModel, session });
      readOpenCodeRuntime(deps.getRuntime);
      rules = applyToolOverrides(validateNativeRules(resolved, operation), overrides);
    }
    const switchPermissions = rules !== undefined
      && sortedJson(toV1PermissionRuleset(rules)) !== sortedJson(session.permission ?? []);
    if ((switchAgent || switchModel || switchPermissions) && await isBusy(sessionID, opts)) {
      throw createOpenCodeClientError(ADMISSION_ERROR_CODES.selectionChangeWhileBusy, 409,
        `${operation}: the session is busy; its selection or permissions cannot change until it is idle`,
        { operation, generation: 2, detail: { changes: [...(switchAgent ? ['agent'] : []), ...(switchModel ? ['model'] : []), ...(switchPermissions ? ['permissions'] : [])] } });
    }
    if (switchAgent) await privileged.switchAgent(sessionID, requestedAgent, clientOptions(opts));
    if (switchModel) await privileged.switchModel(sessionID, toV2ModelRef(target), clientOptions(opts));
    if (switchPermissions) await privileged.setPermissions(sessionID, rules, clientOptions(opts));
    // Request intent stays in metadata/fingerprint. Primary ownership needs the
    // actual post-switch tuple, including native's explicit default alias.
    const verifySelection = !session.parentID && ((typeof options.beforePromptDispatch === 'function'
      && (options.requiresEffectiveSelection?.() !== false || switchAgent || switchModel)) || typeof opts.beforePromptDispatch === 'function');
    const accepted = verifySelection ? await client.sessions.get(sessionID, clientOptions(opts)) : session;
    readOpenCodeRuntime(deps.getRuntime);
    const execution = isNonEmptyString(accepted.agent) && isRecord(accepted.model)
      && isNonEmptyString(accepted.model.providerID) && isNonEmptyString(accepted.model.id)
      ? { agent: accepted.agent, providerID: accepted.model.providerID, modelID: accepted.model.id,
        variant: isNonEmptyString(accepted.model.variant) ? accepted.model.variant : 'default' } : null;
    // A new native session may have no stored agent yet. Verify the accepted
    // model independently; only a primary receipt requires the complete tuple.
    if (verifySelection && ((switchAgent && accepted.agent !== requestedAgent) || (target && (!isRecord(accepted.model)
      || accepted.model.providerID !== target.providerID || accepted.model.id !== target.id
      || (accepted.model.variant ?? 'default') !== (target.variant ?? 'default'))))) throw createOpenCodeClientError(C.conflict, 409,
      `${operation}: native selection did not accept the requested execution`, { operation, generation: 2 });
    return { agent, model: effectiveModel, variant: recordedVariant, execution, directory: accepted.directory, parentID: accepted.parentID };
  };

  // -------------------------------------------------------------------------
  // Operations

  /**
   * v1 `prompt_async` body -> `POST /api/session/:id/prompt` (B.5). Resolves to
   * `null`, as the v1 204 does.
   * @param {string} sessionID
   * @param {Record<string, unknown>} body
   * @param {{ directory?: string, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, unknown>,
   *   messageID?: string, origin?: string, objectiveID?: string, planMode?: boolean, delivery?: 'queue' | 'steer' }} [opts]
   */
  const prompt = async (sessionID, body, opts = {}) => {
    const operation = 'admission.prompt';
    requireGen2(operation);
    requireSessionId(operation, sessionID);
    if (!isRecord(body)) throw invalidInput(operation, 'the body must be an object');
    validateSelectionInput(body, operation);
    for (const key of ['noReply', 'planMode']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') throw invalidInput(operation, `${key} must be a boolean`);
    }
    if (body.format !== undefined) throw createCapabilityUnavailableError('prompt.format', { operation, generation: 2 });
    if (isNonEmptyString(body.system)) throw createCapabilityUnavailableError('prompt.system', { operation, generation: 2 });
    const companion = isRecord(body.prompt);
    const parts = companion ? companionPromptParts(body.prompt) : body.parts;
    const content = buildV2PromptContent(parts, { operation });
    if (content.text.length === 0 && content.files.length === 0 && content.agents.length === 0) {
      throw invalidInput(operation, 'a prompt needs text, a file or an agent mention');
    }
    const { id } = resolveMessageId(operation, body, opts);
    const delivery = resolveDelivery(operation, body, opts, companion ? 'steer' : defaultDelivery);
    const objectiveID = isNonEmptyString(opts.objectiveID) ? opts.objectiveID : body.objectiveID;
    if (objectiveID !== undefined && (typeof objectiveID !== 'string' || !MESSAGE_ID_PATTERN.test(objectiveID))) {
      throw invalidInput(operation, 'objectiveID must be a message id');
    }
    const planMode = body.planMode === true || opts.planMode === true || content.planMode;
    const origin = resolveOrigin(opts);
    const resume = body.noReply !== true;
    const queuedAfterChildren=origin==='human'&&delivery==='queue';
    const selectionInput = {
      ...(body.agent === undefined ? {} : { agent: body.agent }),
      ...(body.model === undefined ? {} : { model: readRequestedModel(body.model) }),
      ...(body.variant === undefined ? {} : { variant: body.variant }),
      ...(body.tools === undefined ? {} : { tools: { ...body.tools } }),
    };
    // Native records in the currently fenced store supply durable scope. Do
    // not include process epoch, URL or paths: restart/migration preserves turns.
    const contentKey = buildV2PromptFingerprint({ sessionID, messageID: id, content, selection: selectionInput, objectiveID, origin, resume, delivery, planMode });

    return await withSessionLock(sessionID, async () => {
      const previous = admitted.get(id);
      if (previous) {
        if (previous.sessionID !== sessionID || previous.fingerprint !== contentKey) throw reusedId(id);
      }
      const existing = await findAcceptedTurn(sessionID, id, opts);
      if (existing !== null) {
        assertAcceptedIdentity(existing, sessionID, id, contentKey);
        if(existing.delivery==='queue'&&origin==='human'&&options.nativeOwner){
          await options.nativeOwner.assertQueuedPromptReconciled({sessionID,messageID:id,directory:opts.directory,item:existing});
        }
        rememberAdmitted(id, { sessionID, fingerprint: contentKey });
        recordDiagnostic({ code: 'opencode_admission_prompt_reconciled', generation: 2, operation, sessionID, messageID: id });
        return null;
      }
      // Revert/delete can remove native accepted evidence within this epoch.
      // The warm cache cannot manufacture success or resurrect a revoked turn.
      if (previous) throw uncertainIdentity(id);
      const submit = async () => {
      if(queuedAfterChildren&&options.nativeOwner)await options.nativeOwner.checkQueuedPromptAdmission({sessionID,messageID:id});
      const selection = await applySelection({ operation, sessionID, messageID: id, body: selectionInput, opts });
      const metadata = buildDevryanPromptMetadata({
        origin,
        agent: selection.agent,
        providerID: selection.model?.providerID,
        modelID: selection.model?.modelID,
        variant: selection.variant,
        planMode,
        parts: content.segments,
        objectiveID,
        admission: { v: 1, fingerprint: contentKey },
      }, { text: content.text });
      const request = {
        id,
        text: content.text,
        ...(content.files.length > 0 ? { files: content.files } : {}),
        ...(content.agents.length > 0 ? { agents: content.agents } : {}),
        metadata: { [DEVRYAN_PROMPT_METADATA_KEY]: metadata },
        delivery,
        ...(!resume ? { resume: false } : {}),
      };
      options.nativeOwner?.updateAcceptedOperation({ metadata: request.metadata, request });
      const receipt = { sessionID, messageID: id, directory: selection.directory, parentID: selection.parentID,
        execution: selection.execution, body: { ...body, messageID: id }, objectiveID,
        ...(queuedAfterChildren && !selection.parentID ? { queuedAfterChildren: true } : {}) };
      // Both callbacks are trusted host options, never request-body fields.
      readOpenCodeRuntime(deps.getRuntime);
      try {
      const admit = async (authorizeWrite) => {
        opts.signal?.throwIfAborted();
        const guardedWrite=authorizeWrite&&(async()=>{opts.signal?.throwIfAborted();await authorizeWrite();opts.signal?.throwIfAborted();});
        await options.beforePromptDispatch?.(structuredClone(receipt),guardedWrite?{authorizeWrite:guardedWrite}:undefined);
        await opts.beforePromptDispatch?.(structuredClone(receipt),guardedWrite?{authorizeWrite:guardedWrite}:undefined);
      };
      if (receipt.queuedAfterChildren && options.nativeOwner) {
        if(typeof options.nativeOwner.stageQueuedPromptAdmission!=='function')throw createCapabilityUnavailableError('queued.primary.admission',{operation,generation:2});
        await options.nativeOwner.stageQueuedPromptAdmission(receipt, admit);
      } else await admit();
      readOpenCodeRuntime(deps.getRuntime);
      let result;
      try {
        const external=await options.externalPromptDispatch?.(structuredClone(receipt),structuredClone(request));
        result = external ? null : await serverRequest({
          ...pass(opts, operation, ADMISSION_DISPATCH_TIMEOUT_MS),
          allowNotFound: false,
          method: 'POST',
          path: `/api/session/${encode(sessionID)}/prompt`,
          body: request,
        });
      } catch (error) {
        if(receipt.queuedAfterChildren&&options.nativeOwner?.queuedPromptWasRejected?.())throw createOpenCodeClientError('native_queued_input_blocked',409,
          'Queued input was not accepted: the session or a descendant is active or its state is unavailable',{operation,generation:2});
        if (error?.code !== C.conflict) throw error;
        const accepted = await findAcceptedTurn(sessionID, id, opts);
        if (accepted === null) throw uncertainIdentity(id);
        assertAcceptedIdentity(accepted, sessionID, id, contentKey);
        if(accepted.delivery==='queue'&&origin==='human'&&options.nativeOwner)await options.nativeOwner.assertQueuedPromptReconciled({sessionID,messageID:id,directory:opts.directory,item:accepted});
        recordDiagnostic({ code: 'opencode_admission_prompt_reconciled', generation: 2, operation, sessionID, messageID: id });
        result = accepted;
      }
      // 2.0.20 may return the original inbox item on a same-ID POST with a
      // different payload. HTTP 200 alone is not proof of this operation.
      const accepted = result === null ? await findAcceptedTurn(sessionID, id, opts) : unwrapData(result);
      assertAcceptedIdentity(accepted, sessionID, id, contentKey);
      rememberAdmitted(id, { sessionID, fingerprint: contentKey });
      return null;
      } catch (error) {
        await options.onPromptDispatchFailure?.(structuredClone(receipt));
        await opts.onPromptDispatchFailure?.(structuredClone(receipt));
        throw error;
      }
      };
      if (!options.nativeOwner) return submit();
      return options.nativeOwner.withAcceptedOperation({ sessionID, messageID: id, fingerprint: contentKey,
        intent:structuredClone(body),
        metadata: { [DEVRYAN_PROMPT_METADATA_KEY]: buildDevryanPromptMetadata({ origin, planMode,
          parts: content.segments, objectiveID, admission: { v: 1, fingerprint: contentKey } }, { text: content.text }) },
        request: { text: content.text,delivery } }, submit);
    }, opts);
  };

  /**
   * v1 command body `{command, arguments?, agent?, model?, variant?, parts?}`
   * -> `POST /api/session/:id/command {name, text, files?, delivery}` ([sm M35]).
   * Resolves to `null`: 2.0.20 returns no message (LOSS(command-result)).
   */
  const command = async (sessionID, body, opts = {}) => {
    const operation = 'admission.command';
    requireGen2(operation);
    requireSessionId(operation, sessionID);
    if (!isRecord(body) || !isNonEmptyString(body.command)) throw invalidInput(operation, 'command is required');
    validateSelectionInput(body, operation);
    if (body.arguments !== undefined && typeof body.arguments !== 'string') throw invalidInput(operation, 'arguments must be a string');
    const fileParts = Array.isArray(body.parts) ? body.parts : [];
    if (fileParts.some((part) => !isRecord(part) || part.type !== 'file')) throw invalidInput(operation, 'command parts must be file parts');
    const content = buildV2PromptContent(fileParts, { operation, inlineTextFiles: false });
    const delivery = resolveDelivery(operation, body, opts, defaultDelivery);
    return await withSessionLock(sessionID, async () => {
      const select = () => applySelection({ operation, sessionID, messageID: null, body, opts });
      if (options.nativeOwner) await options.nativeOwner.withCommandSelection({ sessionID,delivery }, select);
      else await select();
      await serverRequest({
        ...pass(opts, operation, ADMISSION_DISPATCH_TIMEOUT_MS),
        allowNotFound: false,
        method: 'POST',
        path: `/api/session/${encode(sessionID)}/command`,
        body: {
          name: body.command,
          text: body.arguments ?? '',
          ...(content.files.length > 0 ? { files: content.files } : {}),
          delivery,
        },
      });
      return null;
    }, opts);
  };

  /**
   * v1 summarize -> `POST /api/session/:id/compact` ([sm M41]). The session
   * model compacts (LOSS(compact-model): the v1 `{providerID, modelID}` is not
   * applied, so compaction never switches the session model).
   */
  const compact = async (sessionID, body = {}, opts = {}) => {
    const operation = 'admission.compact';
    requireGen2(operation);
    requireSessionId(operation, sessionID);
    const input = isRecord(body) ? body : {};
    if (input.messageID !== undefined && (typeof input.messageID !== 'string' || !MESSAGE_ID_PATTERN.test(input.messageID))) {
      throw invalidInput(operation, 'messageID must be a msg_ identifier');
    }
    const delivery = opts.delivery ?? input.delivery;
    if (delivery !== undefined && !ADMISSION_DELIVERIES.includes(delivery)) throw invalidInput(operation, 'delivery must be queue or steer');
    return await withSessionLock(sessionID, async () => {
      const result = await serverRequest({
        ...pass(opts, operation, ADMISSION_DISPATCH_TIMEOUT_MS),
        method: 'POST',
        path: `/api/session/${encode(sessionID)}/compact`,
        body: {
          ...(isNonEmptyString(input.messageID) ? { id: input.messageID } : {}),
          ...(delivery === undefined ? {} : { delivery }),
        },
      });
      return result === null ? null : true;
    }, opts);
  };

  /**
   * `POST /api/session/:id/interrupt`. Not serialized behind the admission
   * lock: a stop never waits for a pending admission.
   */
  const abort = async (sessionID, opts = {}) => {
    const operation = 'admission.abort';
    requireGen2(operation);
    requireSessionId(operation, sessionID);
    const result = await serverRequest({ ...pass(opts, operation), method: 'POST', path: `/api/session/${encode(sessionID)}/interrupt` });
    if (result === null) return null;
    const value = unwrapData(result);
    if (isRecord(value) && typeof value.interrupted === 'boolean') return true;
    recordDiagnostic({ code: 'opencode_admission_interrupt_unrecognized', generation: 2, operation, sessionID });
    return true;
  };

  /**
   * v1 create `{parentID?, title?, agent?, model?, permission?, metadata?}` (plus
   * `id`, `directory`). The id is DevRyan-generated, so a retry returns the
   * same session. Callers cannot write the `devryan` metadata namespace.
   */
  const create = async (input = {}, opts = {}) => {
    const operation = 'admission.create';
    requireGen2(operation);
    if (!isRecord(input)) throw invalidInput(operation, 'the input must be an object');
    if (input.id !== undefined && (typeof input.id !== 'string' || !SESSION_ID_PATTERN.test(input.id))) {
      throw invalidInput(operation, 'id must be a session identifier');
    }
    const id = input.id ?? createV2SessionId();
    const directory = isNonEmptyString(input.directory) ? input.directory : opts.directory;
    if (input.permission !== undefined && !Array.isArray(input.permission)) throw invalidInput(operation, 'permission must be a ruleset array');
    if (input.permissions !== undefined && !Array.isArray(input.permissions)) throw invalidInput(operation, 'permissions must be a ruleset array');
    const permissions = input.permission !== undefined ? toV2PermissionRuleset(input.permission) : input.permissions;
    let metadata;
    if (isRecord(input.metadata)) {
      const { [DEVRYAN_PROMPT_METADATA_KEY]: reserved, ...rest } = input.metadata;
      if (reserved !== undefined) recordDiagnostic({ code: 'opencode_admission_reserved_metadata_dropped', generation: 2, operation });
      if (Object.keys(rest).length > 0) metadata = rest;
    }
    const model = readRequestedModel(input.model);
    if (input.model !== undefined && !model) throw invalidInput(operation, 'model needs providerID and modelID');
    const common = {
      id,
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      ...(isNonEmptyString(input.agent) ? { agent: input.agent } : {}),
    };
    if (isNonEmptyString(input.parentID)) {
      return await privileged.createChildSession({
        ...common,
        parentID: input.parentID,
        ...(isNonEmptyString(directory) ? { directory } : {}),
        ...(model ? { model } : {}),
        ...(permissions ? { permissions } : {}),
        ...(metadata ? { metadata } : {}),
      }, clientOptions(opts));
    }
    if (permissions === undefined && metadata === undefined) {
      return await client.sessions.create({ ...common, ...(isNonEmptyString(directory) ? { directory } : {}), ...(model ? { model } : {}) },
        clientOptions(opts));
    }
    const ref = model ? toV2ModelRef(model) : undefined;
    const body = await privilegedRequest({
      ...pass(opts, operation, ADMISSION_DISPATCH_TIMEOUT_MS),
      method: 'POST',
      path: '/api/session',
      directory,
      body: { ...common, ...(ref ? { model: ref } : {}), ...(permissions ? { permissions } : {}), ...(metadata ? { metadata } : {}) },
    });
    return body === null ? null : (toV1Session(unwrapData(body)) ?? null);
  };

  /** v1 fork `{messageID}` -> `{before}`; the fork is a root session ([sm M40]). */
  const fork = async (sessionID, input = {}, opts = {}) => {
    const operation = 'admission.fork';
    requireGen2(operation);
    requireSessionId(operation, sessionID);
    const messageID = isRecord(input) ? input.messageID : undefined;
    if (messageID !== undefined && (typeof messageID !== 'string' || !MESSAGE_ID_PATTERN.test(messageID))) {
      throw invalidInput(operation, 'messageID must be a msg_ identifier');
    }
    return await client.sessions.fork(sessionID, messageID === undefined ? {} : { messageID },
      { ...clientOptions(opts), ...(opts.allowNotFound === true ? { allowNotFound: true } : {}) });
  };

  /** `DELETE /api/session/:id`: 204 -> `true` ([sm M43]). Serialized with admission. */
  const remove = async (sessionID, opts = {}) => {
    const operation = 'admission.remove';
    requireGen2(operation);
    requireSessionId(operation, sessionID);
    return await withSessionLock(sessionID, async () => {
      const result = await client.sessions.remove(sessionID,
        { ...clientOptions(opts), ...(opts.allowNotFound === true ? { allowNotFound: true } : {}) });
      admitted.forEach((entry, messageID) => { if (entry.sessionID === sessionID) admitted.delete(messageID); });
      return result;
    }, opts);
  };

  let admissionRuntime;
  const scoped = (name, run) => async (...args) => await withOpenCodeRuntime(deps.getRuntime, `admission.${name}`, () => {
    const runtime = readOpenCodeRuntime(deps.getRuntime);
    if (!isSameOpenCodeRuntime(admissionRuntime, runtime)) {
      admitted.clear();
      admissionRuntime = { ...runtime };
    }
    return run(...args);
  });
  admission = Object.freeze({
    generation: 2,
    prompt: scoped('prompt', prompt),
    command: scoped('command', command),
    compact: scoped('compact', compact),
    abort: scoped('abort', abort),
    create: scoped('create', create),
    fork: scoped('fork', fork),
    remove: scoped('remove', remove),
    withSessionLock: scoped('withSessionLock', withSessionLock),
    /** Diagnostics only: lock and accepted-cache state (no prompt content). */
    inspect: () => ({
      lockedSessions: [...tails.keys()],
      admittedCount: admitted.size,
    }),
  });
  return admission;
};
