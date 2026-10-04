// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x) forms and permissions <-> DevRyan's v1 question and
// permission contracts (DESIGN.md B.4 and B.6).
//
// Forms -> questions. Every form whose fields map becomes a v1 QuestionRequest,
// not only `metadata.kind === 'question'`, so MCP elicitation does not stall:
//   string + options  -> single choice (`custom` only when the field allows it)
//   string            -> free text (no options, custom)
//   multiselect       -> `multiple: true`
//   boolean           -> Yes / No
//   number / integer  -> free text, parsed when the reply is built
//   hidden            -> not asked (v2 uses the default unless answered)
//   external          -> no v1 equivalent: the caller cancels the form and
//                        records the returned diagnostic (F15 default)
// `tool {messageID, callID}` comes from `metadata.tool {messageID, id}`.
// A reply maps `answers[i]` (v1 labels) onto the i-th asked field's key, which
// is `q<i>` for forms the question tool created; option labels become option
// values and inactive (`when`) fields are left out.
//
// Permissions. `permission.asked` / the request list map as
//   permission = v1 tool name of `action`, patterns = resources, always = save,
//   tool.callID = source.id, metadata gains the v1 edit aliases filepath/diff.
// A v1 reply `{reply, message?}` becomes `{decision, message?}`.
//
// The `toV2*` reverse helpers exist for fixtures and wire round trips.
// Everything here is pure: no I/O, no clocks, no logging.
// ---------------------------------------------------------------------------

import { toV1ToolName, toV2ToolName } from './tools.js';

/**
 * @typedef {object} V1QuestionOption
 * @property {string} label
 * @property {string} description
 */

/**
 * @typedef {object} V1QuestionInfo
 * @property {string} question
 * @property {string} header
 * @property {V1QuestionOption[]} options
 * @property {boolean} [multiple]
 * @property {boolean} [custom]
 */

/**
 * @typedef {object} V1QuestionRequest
 * @property {string} id
 * @property {string} sessionID
 * @property {V1QuestionInfo[]} questions
 * @property {{ messageID: string, callID: string }} [tool]
 */

/**
 * @typedef {object} FormDiagnostic
 * @property {'opencode_v2_form_unsupported'} code
 * @property {'external_field' | 'no_fields' | 'invalid_field' | 'invalid_form'} reason
 * @property {string} [formID]
 * @property {string} [sessionID]
 * @property {string[]} [fieldKeys] keys of the offending fields (never their URLs)
 */

/**
 * @typedef {{ action: 'ask', request: V1QuestionRequest }
 *   | { action: 'cancel', formID: string, sessionID: string, diagnostic: FormDiagnostic }
 *   | { action: 'ignore', diagnostic: FormDiagnostic }} FormClassification
 */

/**
 * @typedef {{ ok: true, answer: Record<string, string | number | boolean | string[]> }
 *   | { ok: false, code: 'invalid_answer' | 'unsupported_form', message: string, key?: string }} FormAnswerResult
 */

/**
 * @typedef {object} V1PermissionRequest
 * @property {string} id
 * @property {string} sessionID
 * @property {string} permission
 * @property {string[]} patterns
 * @property {Record<string, unknown>} metadata
 * @property {string[]} always
 * @property {{ messageID: string, callID: string }} [tool]
 */

const DIAGNOSTIC_CODE = 'opencode_v2_form_unsupported';
const QUESTION_FORM_TITLE = 'Questions';
const QUESTION_FORM_KIND = 'question';
const BOOLEAN_YES = 'Yes';
const BOOLEAN_NO = 'No';
const PERMISSION_DECISIONS = new Set(['once', 'always', 'reject']);
const FILE_DIFF_PERMISSIONS = new Set(['edit', 'write']);
const ASKABLE_FIELD_TYPES = new Set(['string', 'multiselect', 'boolean', 'number', 'integer']);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const hasKey = (record, key) => Object.hasOwn(record, key) && record[key] !== undefined;

const stringList = (value) => (
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
);

const fieldOptions = (field) => (
  Array.isArray(field.options)
    ? field.options.filter((option) => isRecord(option) && typeof option.value === 'string')
    : []
);

/** Fields a v1 question card can show; external and hidden fields are not asked. */
const isAskedField = (field) => isRecord(field) && field.hidden !== true && field.type !== 'external';

/**
 * The form fields that become v1 questions, in order. `questions[i]` and
 * `answers[i]` correspond to `formQuestionFields(form)[i]`.
 * @param {unknown} form a v2 `Form.Info` or `Form.Detail`
 * @returns {Record<string, unknown>[]}
 */
export const formQuestionFields = (form) => {
  if (!isRecord(form) || !Array.isArray(form.fields)) return [];
  return form.fields.filter(isAskedField);
};

/** @returns {V1QuestionOption} */
const toV1Option = (option) => ({
  label: typeof option.label === 'string' && option.label.length > 0 ? option.label : option.value,
  description: typeof option.description === 'string' ? option.description : '',
});

/**
 * One v2 form field as a v1 question, or `null` when its type has no mapping.
 * @param {Record<string, unknown>} field
 * @returns {V1QuestionInfo | null}
 */
const toV1QuestionInfo = (field) => {
  if (!isNonEmptyString(field.key) || !ASKABLE_FIELD_TYPES.has(field.type)) return null;
  const header = isNonEmptyString(field.title) ? field.title : field.key;
  const question = isNonEmptyString(field.description) ? field.description : header;
  const base = { question, header };
  if (field.type === 'boolean') {
    return {
      ...base,
      options: [{ label: BOOLEAN_YES, description: '' }, { label: BOOLEAN_NO, description: '' }],
      custom: false,
    };
  }
  if (field.type === 'number' || field.type === 'integer') {
    return { ...base, options: [], custom: true };
  }
  const options = fieldOptions(field).map(toV1Option);
  if (field.type === 'multiselect') {
    return { ...base, options, multiple: true, custom: field.custom === true };
  }
  // string: with options a single choice; without options free text only.
  return { ...base, options, custom: options.length === 0 || field.custom === true };
};

const formTool = (metadata) => {
  if (!isRecord(metadata) || !isRecord(metadata.tool)) return undefined;
  const { messageID, id } = metadata.tool;
  return isNonEmptyString(messageID) && isNonEmptyString(id) ? { messageID, callID: id } : undefined;
};

const diagnostic = (reason, form, fieldKeys) => {
  /** @type {FormDiagnostic} */
  const result = { code: DIAGNOSTIC_CODE, reason };
  if (isRecord(form) && isNonEmptyString(form.id)) result.formID = form.id;
  if (isRecord(form) && isNonEmptyString(form.sessionID)) result.sessionID = form.sessionID;
  if (fieldKeys && fieldKeys.length > 0) result.fieldKeys = fieldKeys;
  return result;
};

const fieldKeysOf = (fields) => fields
  .map((field) => (isRecord(field) && typeof field.key === 'string' ? field.key : ''))
  .filter((key) => key.length > 0);

/**
 * Decides what DevRyan does with a v2 form: show it as a v1 question, cancel it
 * (it cannot be answered through a question card), or ignore it (too malformed
 * to address). The caller performs the cancel and records the diagnostic.
 * @param {unknown} form a v2 `Form.Info` (from `form.created` or a form list)
 * @returns {FormClassification}
 */
export const classifyForm = (form) => {
  if (!isRecord(form) || !isNonEmptyString(form.id) || !isNonEmptyString(form.sessionID)) {
    return { action: 'ignore', diagnostic: diagnostic('invalid_form', form) };
  }
  const cancel = (reason, fieldKeys) => ({
    action: 'cancel',
    formID: form.id,
    sessionID: form.sessionID,
    diagnostic: diagnostic(reason, form, fieldKeys),
  });
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const external = fields.filter((field) => isRecord(field) && field.type === 'external');
  if (external.length > 0) return cancel('external_field', fieldKeysOf(external));
  const asked = fields.filter(isAskedField);
  const questions = asked.map(toV1QuestionInfo);
  const invalid = asked.filter((_, index) => questions[index] === null);
  if (invalid.length > 0) return cancel('invalid_field', fieldKeysOf(invalid));
  if (questions.length === 0) return cancel('no_fields');
  /** @type {V1QuestionRequest} */
  const request = {
    id: form.id,
    sessionID: form.sessionID,
    questions: /** @type {V1QuestionInfo[]} */ (questions),
  };
  const tool = formTool(form.metadata);
  if (tool) request.tool = tool;
  return { action: 'ask', request };
};

/**
 * The v1 QuestionRequest for a v2 form, or `null` when the form must be
 * cancelled or ignored (see {@link classifyForm}).
 * @param {unknown} form
 * @returns {V1QuestionRequest | null}
 */
export const toV1QuestionRequest = (form) => {
  const classified = classifyForm(form);
  return classified.action === 'ask' ? classified.request : null;
};

/**
 * Projects a pending-form list (`GET /api/form` or `GET /api/session/:id/form`
 * data) into v1 questions plus the forms the caller must cancel.
 * @param {unknown} forms
 * @returns {{ questions: V1QuestionRequest[], cancel: { formID: string, sessionID: string, diagnostic: FormDiagnostic }[], ignored: FormDiagnostic[] }}
 */
export const projectFormList = (forms) => {
  const questions = [];
  const cancel = [];
  const ignored = [];
  if (!Array.isArray(forms)) return { questions, cancel, ignored };
  for (const form of forms) {
    const classified = classifyForm(form);
    if (classified.action === 'ask') {
      questions.push(classified.request);
    } else if (classified.action === 'cancel') {
      cancel.push({ formID: classified.formID, sessionID: classified.sessionID, diagnostic: classified.diagnostic });
    } else {
      ignored.push(classified.diagnostic);
    }
  }
  return { questions, cancel, ignored };
};

const matchesCondition = (condition, answers) => {
  if (!isRecord(condition) || typeof condition.key !== 'string') return false;
  if (!Object.hasOwn(answers, condition.key)) return false;
  const value = answers[condition.key];
  const equal = Array.isArray(value) ? value.includes(condition.value) : value === condition.value;
  if (condition.op === 'eq') return equal;
  if (condition.op === 'neq') return !equal;
  return false;
};

/** A field is active when every `when` condition holds against earlier answers. */
const isFieldActive = (field, answers) => {
  if (!Array.isArray(field.when) || field.when.length === 0) return true;
  return field.when.every((condition) => matchesCondition(condition, answers));
};

const toOptionValue = (field, label) => {
  const options = fieldOptions(field);
  const byLabel = options.find((option) => option.label === label);
  if (byLabel) return byLabel.value;
  const byValue = options.find((option) => option.value === label);
  if (byValue) return byValue.value;
  return field.custom === true || options.length === 0 ? label : undefined;
};

const parseBoolean = (value) => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'true') return true;
  if (normalized === 'no' || normalized === 'false') return false;
  return undefined;
};

const parseNumber = (value, integer) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  if (integer && !Number.isSafeInteger(parsed)) return undefined;
  return parsed;
};

const invalidAnswer = (key, message) => ({ ok: false, code: 'invalid_answer', key, message });

/**
 * Converts one v1 answer (selected labels or typed text) into the v2 value for
 * a field. Returns `{value: undefined}` for an empty answer.
 */
const toFieldValue = (field, labels) => {
  const values = labels.map((label) => label.trim()).filter((label) => label.length > 0);
  if (values.length === 0) return { ok: true, value: undefined };
  if (field.type === 'multiselect') {
    const mapped = values.map((label) => toOptionValue(field, label));
    if (mapped.some((value) => value === undefined)) {
      return invalidAnswer(field.key, `Answer for ${field.key} is not one of its options`);
    }
    return { ok: true, value: [...new Set(/** @type {string[]} */ (mapped))] };
  }
  const first = values[0];
  if (field.type === 'boolean') {
    const parsed = parseBoolean(first);
    return parsed === undefined
      ? invalidAnswer(field.key, `Answer for ${field.key} must be Yes or No`)
      : { ok: true, value: parsed };
  }
  if (field.type === 'number' || field.type === 'integer') {
    const parsed = parseNumber(first, field.type === 'integer');
    return parsed === undefined
      ? invalidAnswer(field.key, `Answer for ${field.key} must be ${field.type === 'integer' ? 'an integer' : 'a number'}`)
      : { ok: true, value: parsed };
  }
  const value = toOptionValue(field, first);
  return value === undefined
    ? invalidAnswer(field.key, `Answer for ${field.key} is not one of its options`)
    : { ok: true, value };
};

/**
 * Builds the v2 `Form.Answer` for a v1 question reply. `answers[i]` answers the
 * i-th asked field ({@link formQuestionFields}); labels map to option values,
 * Yes/No to booleans, numbers are parsed, and fields made inactive by `when`
 * are left out. A required active field without an answer is an error.
 * @param {unknown} form the v2 form being answered
 * @param {unknown} answers v1 `answers: string[][]`
 * @returns {FormAnswerResult}
 */
export const toV2FormAnswer = (form, answers) => {
  const classified = classifyForm(form);
  if (classified.action !== 'ask') {
    return { ok: false, code: 'unsupported_form', message: 'This form cannot be answered as a question' };
  }
  if (!Array.isArray(answers)) {
    return { ok: false, code: 'invalid_answer', message: 'answers must be an array' };
  }
  const fields = formQuestionFields(form);
  /** @type {Record<string, string | number | boolean | string[]>} */
  const answer = {};
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!isFieldActive(field, answer)) continue;
    const raw = answers[index];
    if (raw !== undefined && !Array.isArray(raw)) {
      return invalidAnswer(field.key, `Answer for ${field.key} must be a list`);
    }
    const converted = toFieldValue(field, stringList(raw));
    if (!converted.ok) return converted;
    if (converted.value === undefined) {
      if (field.required === true) return invalidAnswer(field.key, `Answer for ${field.key} is required`);
      continue;
    }
    answer[field.key] = converted.value;
  }
  return { ok: true, answer };
};

const toV1Label = (field, value) => {
  if (typeof value === 'boolean') return value ? BOOLEAN_YES : BOOLEAN_NO;
  if (typeof value !== 'string') return String(value);
  const option = isRecord(field) ? fieldOptions(field).find((entry) => entry.value === value) : undefined;
  return option && typeof option.label === 'string' && option.label.length > 0 ? option.label : value;
};

const toV1AnswerList = (field, value) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((entry) => toV1Label(field, entry));
  return [toV1Label(field, value)];
};

/** `q<i>` keys in index order, for a reply whose form is unknown. */
const questionKeyAnswers = (answer) => {
  let last = -1;
  for (const key of Object.keys(answer)) {
    const match = /^q(\d+)$/.exec(key);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return Array.from({ length: last + 1 }, (_, index) => toV1AnswerList(undefined, answer[`q${index}`]));
};

/**
 * `form.replied {id, sessionID, answer}` as v1 `question.replied` properties.
 * With the form, answers follow its asked fields and option values map back to
 * the labels the card showed; without it, `q<i>` keys are read in order.
 * @param {unknown} data
 * @param {unknown} [form]
 * @returns {{ sessionID: string, requestID: string, answers: string[][] } | null}
 */
export const toV1QuestionReplied = (data, form) => {
  if (!isRecord(data) || !isNonEmptyString(data.id) || typeof data.sessionID !== 'string') return null;
  const answer = isRecord(data.answer) ? data.answer : {};
  const fields = formQuestionFields(form);
  const answers = fields.length > 0
    ? fields.map((field) => toV1AnswerList(field, answer[field.key]))
    : questionKeyAnswers(answer);
  return { sessionID: data.sessionID, requestID: data.id, answers };
};

/**
 * `form.cancelled {id, sessionID}` as v1 `question.rejected` properties.
 * @param {unknown} data
 * @returns {{ sessionID: string, requestID: string } | null}
 */
export const toV1QuestionRejected = (data) => {
  if (!isRecord(data) || !isNonEmptyString(data.id) || typeof data.sessionID !== 'string') return null;
  return { sessionID: data.sessionID, requestID: data.id };
};

/**
 * Reverse of {@link toV1QuestionRequest} for a v1 question, in the exact shape
 * OpenCode 2.0.20's question tool creates (`core credential-76832g3x.js`
 * `toField`): `q<i>` keys, header -> title, question -> description, option
 * label -> value and label, `custom: true`, `metadata.kind: 'question'`.
 * @param {unknown} request a v1 QuestionRequest
 * @returns {Record<string, unknown> | null}
 */
export const toV2QuestionForm = (request) => {
  if (!isRecord(request) || !isNonEmptyString(request.id) || typeof request.sessionID !== 'string') return null;
  if (!Array.isArray(request.questions) || request.questions.length === 0) return null;
  const fields = request.questions.map((question, index) => {
    const info = isRecord(question) ? question : {};
    return {
      key: `q${index}`,
      title: typeof info.header === 'string' ? info.header : '',
      description: typeof info.question === 'string' ? info.question : '',
      type: info.multiple === true ? 'multiselect' : 'string',
      options: (Array.isArray(info.options) ? info.options : [])
        .filter((option) => isRecord(option) && typeof option.label === 'string')
        .map((option) => ({
          value: option.label,
          label: option.label,
          description: typeof option.description === 'string' ? option.description : '',
        })),
      custom: true,
    };
  });
  /** @type {Record<string, unknown>} */
  const metadata = { kind: QUESTION_FORM_KIND };
  if (isRecord(request.tool) && isNonEmptyString(request.tool.messageID) && isNonEmptyString(request.tool.callID)) {
    metadata.tool = { messageID: request.tool.messageID, id: request.tool.callID };
  }
  return { id: request.id, sessionID: request.sessionID, title: QUESTION_FORM_TITLE, metadata, fields };
};

const firstFileDiff = (metadata) => {
  if (!Array.isArray(metadata.files)) return null;
  const first = metadata.files[0];
  return isRecord(first) ? first : null;
};

/**
 * Adds the v1 edit-permission metadata aliases (`filepath`, `diff`) from the
 * first `files` entry. Existing keys are never overwritten; the same reference
 * is returned when nothing applies.
 * @param {string} permission v1 permission name
 * @param {Record<string, unknown>} metadata
 */
const toV1PermissionMetadata = (permission, metadata) => {
  if (!FILE_DIFF_PERMISSIONS.has(permission)) return metadata;
  const file = firstFileDiff(metadata);
  if (!file) return metadata;
  let projected = metadata;
  if (typeof file.file === 'string' && !hasKey(metadata, 'filepath')) {
    projected = { ...projected, filepath: file.file };
  }
  if (typeof file.patch === 'string' && !hasKey(metadata, 'diff')) {
    projected = { ...projected, diff: file.patch };
  }
  return projected;
};

const toV2PermissionMetadata = (permission, metadata) => {
  if (!FILE_DIFF_PERMISSIONS.has(permission) || !firstFileDiff(metadata)) return metadata;
  if (!Object.hasOwn(metadata, 'filepath') && !Object.hasOwn(metadata, 'diff')) return metadata;
  const { filepath: _filepath, diff: _diff, ...rest } = metadata;
  return rest;
};

/**
 * A v2 `Permission.Request` (the `permission.asked` data or a request list
 * entry) as a v1 PermissionRequest. Returns `null` without an id or session.
 * @param {unknown} request
 * @returns {V1PermissionRequest | null}
 */
export const toV1PermissionRequest = (request) => {
  if (!isRecord(request) || !isNonEmptyString(request.id) || !isNonEmptyString(request.sessionID)) return null;
  const permission = toV1ToolName(typeof request.action === 'string' ? request.action : '');
  const metadata = isRecord(request.metadata) ? toV1PermissionMetadata(permission, request.metadata) : {};
  /** @type {V1PermissionRequest} */
  const projected = {
    id: request.id,
    sessionID: request.sessionID,
    permission,
    patterns: stringList(request.resources),
    metadata,
    always: stringList(request.save),
  };
  const source = request.source;
  if (isRecord(source) && source.type === 'tool' && isNonEmptyString(source.messageID) && isNonEmptyString(source.id)) {
    projected.tool = { messageID: source.messageID, callID: source.id };
  }
  return projected;
};

/**
 * A v2 permission request list as v1 PermissionRequests; malformed entries are dropped.
 * @param {unknown} requests
 * @returns {V1PermissionRequest[]}
 */
export const toV1PermissionRequests = (requests) => {
  if (!Array.isArray(requests)) return [];
  const projected = [];
  for (const request of requests) {
    const entry = toV1PermissionRequest(request);
    if (entry) projected.push(entry);
  }
  return projected;
};

/**
 * `permission.replied` data, which already has the v1 shape. Validated and copied.
 * @param {unknown} data
 * @returns {{ sessionID: string, requestID: string, reply: 'once' | 'always' | 'reject' } | null}
 */
export const toV1PermissionReplied = (data) => {
  if (!isRecord(data) || !isNonEmptyString(data.sessionID) || !isNonEmptyString(data.requestID)) return null;
  if (!PERMISSION_DECISIONS.has(data.reply)) return null;
  return { sessionID: data.sessionID, requestID: data.requestID, reply: data.reply };
};

/**
 * A v1 permission reply body `{reply, message?}` as the v2 body
 * `{decision, message?}`. `response` is accepted as the legacy v1 key.
 * @param {unknown} body
 * @returns {{ ok: true, body: { decision: 'once' | 'always' | 'reject', message?: string } }
 *   | { ok: false, code: 'invalid_reply', message: string }}
 */
export const toV2PermissionReply = (body) => {
  const record = isRecord(body) ? body : {};
  const decision = record.reply ?? record.response;
  if (!PERMISSION_DECISIONS.has(decision)) {
    return { ok: false, code: 'invalid_reply', message: 'reply must be once, always or reject' };
  }
  return isNonEmptyString(record.message)
    ? { ok: true, body: { decision, message: record.message } }
    : { ok: true, body: { decision } };
};

/**
 * Reverse of {@link toV1PermissionRequest}, for fixtures and wire round trips.
 * @param {unknown} request a v1 PermissionRequest
 * @returns {Record<string, unknown> | null}
 */
export const toV2PermissionRequest = (request) => {
  if (!isRecord(request) || !isNonEmptyString(request.id) || !isNonEmptyString(request.sessionID)) return null;
  const permission = typeof request.permission === 'string' ? request.permission : '';
  /** @type {Record<string, unknown>} */
  const projected = {
    id: request.id,
    sessionID: request.sessionID,
    action: toV2ToolName(permission),
    resources: stringList(request.patterns),
  };
  const save = stringList(request.always);
  if (save.length > 0) projected.save = save;
  if (isRecord(request.metadata) && Object.keys(request.metadata).length > 0) {
    projected.metadata = toV2PermissionMetadata(permission, request.metadata);
  }
  if (isRecord(request.tool) && isNonEmptyString(request.tool.messageID) && isNonEmptyString(request.tool.callID)) {
    projected.source = { type: 'tool', messageID: request.tool.messageID, id: request.tool.callID };
  }
  return projected;
};
