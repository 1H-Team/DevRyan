import { validateUuid } from './validation.js';

const MAX_CANDIDATES = 24;
const MAX_STATEMENT_BYTES = 4 * 1024;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const LOGICAL_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const CANDIDATE_FIELDS = Object.freeze([
  'confidence',
  'logicalKey',
  'provenance',
  'scope',
  'sensitivity',
  'statement',
  'subjectUserId',
  'transcriptQuote',
]);
const PROVENANCE_FIELDS = Object.freeze(['channelId', 'messageIds', 'runId']);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:bearer|authorization)\s+[a-z0-9._~+/=-]{16,}\b/i,
  /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk|pk)_(?:live|test)_[a-z0-9]{16,}\b/i,
  /\bsk-[a-z0-9_-]{20,}\b/i,
]);
const PRIVATE_FACT_PATTERN = /\b(?:the user|user prefers|my preference|i prefer|my email|my phone|home address|medical|salary|passport|account number)\b/i;

export const BOT_MEMORY_EXTRACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      maxItems: MAX_CANDIDATES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: CANDIDATE_FIELDS,
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 4_096 },
          logicalKey: { type: 'string', pattern: '^[a-z0-9][a-z0-9._:-]{0,127}$' },
          scope: { type: 'string', enum: ['shared', 'user_private', 'thread_only'] },
          subjectUserId: { type: ['string', 'null'] },
          sensitivity: { type: 'string', enum: ['normal', 'confidential', 'restricted'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          transcriptQuote: { type: 'boolean' },
          provenance: {
            type: 'object',
            additionalProperties: false,
            required: PROVENANCE_FIELDS,
            properties: {
              channelId: { type: 'string' },
              runId: { type: 'string' },
              messageIds: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
});

// Content-free reasons for an unusable classifier output. They reach the audit
// and the log so a repeated failure can be diagnosed without reading the text.
export const BOT_MEMORY_CLASSIFIER_REASONS = Object.freeze([
  'not_json',
  'shape',
  'too_large',
  'provenance',
]);

export class BotMemoryClassifierError extends Error {
  constructor(message, code = 'bot_memory_extraction_invalid', statusCode = 422, reason = null) {
    super(message);
    this.name = 'BotMemoryClassifierError';
    this.code = code;
    this.statusCode = statusCode;
    this.reason = BOT_MEMORY_CLASSIFIER_REASONS.includes(reason) ? reason : null;
  }
}

const fail = (message, code, statusCode, reason) => {
  throw new BotMemoryClassifierError(message, code, statusCode, reason);
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value, expected) => (
  isRecord(value) && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
);

// Structured-output models still wrap JSON in markdown fences, prefix it with a
// sentence, or return the candidates array bare. Those are shape problems, not
// trust problems: recover the object here and keep the per-candidate checks
// strict. Anything that is not recoverable fails with a content-free reason.
const stripCodeFence = (text) => {
  const fenced = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
};

const extractBalancedJson = (text) => {
  const openers = { '{': '}', '[': ']' };
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (!openers[opener]) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
};

const parseOutput = (value) => {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value, 'utf8') > 128 * 1024) {
    fail('Bot memory extraction output is too large', undefined, undefined, 'too_large');
  }
  const trimmed = stripCodeFence(value.trim()).trim();
  if (!trimmed) return { candidates: [] };
  try {
    return JSON.parse(trimmed);
  } catch {
    const recovered = extractBalancedJson(trimmed);
    if (recovered !== undefined) return recovered;
    fail('Bot memory extraction output is not valid JSON', undefined, undefined, 'not_json');
  }
};

// Accept `{ candidates: [...] }`, a bare array, or an object whose single
// array-valued key carries the candidates. Extra top-level keys are ignored.
const candidateListFrom = (parsed) => {
  if (parsed === null || parsed === undefined) return [];
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.candidates)) return parsed.candidates;
  if (parsed.candidates === null || parsed.candidates === undefined) {
    const arrays = Object.values(parsed).filter((entry) => Array.isArray(entry));
    if (arrays.length === 1) return arrays[0];
    if (Object.keys(parsed).length === 0) return [];
  }
  return null;
};

const normalizedForQuoteCheck = (value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

const containsTranscriptQuote = (statement, transcript) => {
  const normalized = normalizedForQuoteCheck(statement);
  if (normalized.length < 80) return false;
  return normalizedForQuoteCheck(transcript).includes(normalized);
};

const rejection = (index, code) => Object.freeze({ index, code });

const normalizeLogicalKey = (value) => {
  if (typeof value !== 'string') return null;
  const key = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 128);
  return LOGICAL_KEY_PATTERN.test(key) ? key : null;
};

const normalizeCandidateShape = (candidate, provenanceDefaults) => {
  if (!isRecord(candidate)) return null;
  const statement = typeof candidate.statement === 'string' ? candidate.statement : null;
  const logicalKey = normalizeLogicalKey(candidate.logicalKey ?? candidate.logical_key ?? candidate.key);
  if (statement === null || logicalKey === null) return null;
  const rawProvenance = isRecord(candidate.provenance) ? candidate.provenance : {};
  const messageIds = Array.isArray(rawProvenance.messageIds)
    ? rawProvenance.messageIds
    : (Array.isArray(candidate.messageIds) ? candidate.messageIds : provenanceDefaults.messageIds);
  // Missing optional fields take their defaults. A field that is present but
  // unsupported is kept as written so the strict schema check still rejects it.
  const rawConfidence = typeof candidate.confidence === 'string' && candidate.confidence.trim()
    ? Number(candidate.confidence)
    : candidate.confidence;
  const confidence = rawConfidence === undefined || rawConfidence === null
    ? 0.6
    : (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : rawConfidence);
  return Object.freeze({
    statement,
    logicalKey,
    scope: candidate.scope === undefined || candidate.scope === null ? 'shared' : candidate.scope,
    subjectUserId: typeof candidate.subjectUserId === 'string' ? candidate.subjectUserId : null,
    sensitivity: candidate.sensitivity === undefined || candidate.sensitivity === null
      ? 'normal'
      : candidate.sensitivity,
    confidence,
    transcriptQuote: candidate.transcriptQuote === true,
    provenance: Object.freeze({
      channelId: typeof rawProvenance.channelId === 'string' ? rawProvenance.channelId : provenanceDefaults.channelId,
      runId: typeof rawProvenance.runId === 'string' ? rawProvenance.runId : provenanceDefaults.runId,
      messageIds: Object.freeze(Array.isArray(messageIds) ? [...messageIds] : []),
    }),
  });
};

export const buildBotMemoryExtractionPrompt = ({
  botId,
  channelId,
  runId,
  ownerUserId,
  userText,
  assistantText,
} = {}) => {
  const context = {
    botId: validateUuid(botId, 'botId'),
    channelId: validateUuid(channelId, 'channelId'),
    runId: validateUuid(runId, 'runId'),
    ownerUserId: validateUuid(ownerUserId, 'ownerUserId'),
    userText: typeof userText === 'string' ? userText : '',
    assistantText: typeof assistantText === 'string' ? assistantText : '',
  };
  const encoded = JSON.stringify(context);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    fail('Bot memory extraction context is too large', 'bot_memory_extraction_too_large', 413);
  }
  return [
    'Extract only concise reusable facts from this completed private Bot run.',
    'Return JSON matching the supplied schema exactly. Do not call tools.',
    'Every retained fact is shared with every Bot member, so use shared for anything worth remembering.',
    'Use thread_only for temporary context that belongs only in the channel summary.',
    'Mark a fact confidential or restricted when it is personal or sensitive; it is still shared, so prefer thread_only when it should not outlive the channel.',
    'Never copy raw transcript passages, credentials, tokens, passwords, or unsupported claims.',
    'Every provenance ID must come from the supplied context.',
    'Logical keys are lowercase dotted paths. Use the prefix user. for durable facts about the person you talk to (user.name, user.timezone, user.role), preference. for how they like things done, identity. for facts about the Bot itself, and project. or topic. for everything else, so the most personal facts stay retrievable.',
    `Context JSON:\n${encoded}`,
  ].join('\n\n');
};

export function classifyBotMemoryCandidates({
  output,
  botId,
  channelId,
  runId,
  ownerUserId,
  messageIds,
  transcript,
} = {}) {
  const normalizedBotId = validateUuid(botId, 'botId');
  const normalizedChannelId = validateUuid(channelId, 'channelId');
  const normalizedRunId = validateUuid(runId, 'runId');
  const normalizedOwnerId = validateUuid(ownerUserId, 'ownerUserId');
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 8) {
    fail('Bot memory extraction provenance is invalid', undefined, undefined, 'provenance');
  }
  const allowedMessageIds = new Set(messageIds.map((id, index) => validateUuid(id, `messageIds[${index}]`)));
  const rawTranscript = typeof transcript === 'string' ? transcript : '';
  if (Buffer.byteLength(rawTranscript, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    fail('Bot memory extraction transcript is too large', 'bot_memory_extraction_too_large', 413, 'too_large');
  }

  const parsed = parseOutput(output);
  const candidateList = candidateListFrom(parsed);
  if (candidateList === null) {
    fail('Bot memory extraction output does not match the schema', undefined, undefined, 'shape');
  }

  const accepted = [];
  const rejected = [];
  // A model that overflows the candidate cap has still produced usable facts;
  // keep the first MAX_CANDIDATES and record the overflow instead of failing.
  candidateList.slice(MAX_CANDIDATES).forEach((_, offset) => {
    rejected.push(rejection(MAX_CANDIDATES + offset, 'too_many_candidates'));
  });
  candidateList.slice(0, MAX_CANDIDATES).forEach((rawCandidate, index) => {
    // Structured-output models routinely omit null-valued keys, capitalise
    // logical keys, or add an extra field. Those are shape problems, not
    // trust problems: normalise them and keep the trust checks below strict.
    const candidate = normalizeCandidateShape(rawCandidate, {
      channelId: normalizedChannelId,
      runId: normalizedRunId,
      messageIds: [...allowedMessageIds],
    });
    if (!candidate) {
      rejected.push(rejection(index, !isRecord(rawCandidate)
        ? 'schema_invalid'
        : (typeof rawCandidate.statement !== 'string'
          ? 'schema_statement_invalid'
          : 'schema_key_invalid')));
      return;
    }
    if (!exactFields(candidate, CANDIDATE_FIELDS)
      || !exactFields(candidate.provenance, PROVENANCE_FIELDS)) {
      rejected.push(rejection(index, 'schema_invalid'));
      return;
    }
    const statement = typeof candidate.statement === 'string' ? candidate.statement.trim() : '';
    if (!statement || Buffer.byteLength(statement, 'utf8') > MAX_STATEMENT_BYTES) {
      rejected.push(rejection(index, 'schema_statement_invalid'));
      return;
    }
    if (typeof candidate.logicalKey !== 'string' || !LOGICAL_KEY_PATTERN.test(candidate.logicalKey)) {
      rejected.push(rejection(index, 'schema_key_invalid'));
      return;
    }
    if (!['shared', 'user_private', 'thread_only'].includes(candidate.scope)
      || !['normal', 'confidential', 'restricted'].includes(candidate.sensitivity)
      || typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence)
      || candidate.confidence < 0 || candidate.confidence > 1
      || typeof candidate.transcriptQuote !== 'boolean') {
      rejected.push(rejection(index, 'schema_invalid'));
      return;
    }
    if (candidate.transcriptQuote || containsTranscriptQuote(statement, rawTranscript)) {
      rejected.push(rejection(index, 'transcript_quote_rejected'));
      return;
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(statement))) {
      rejected.push(rejection(index, 'secret_rejected'));
      return;
    }
    const provenanceIds = candidate.provenance.messageIds;
    if (candidate.provenance.channelId !== normalizedChannelId
      || candidate.provenance.runId !== normalizedRunId
      || !Array.isArray(provenanceIds) || provenanceIds.length < 1 || provenanceIds.length > 8
      || new Set(provenanceIds).size !== provenanceIds.length
      || provenanceIds.some((id) => !allowedMessageIds.has(id))) {
      rejected.push(rejection(index, 'provenance_invalid'));
      return;
    }
    if (candidate.subjectUserId !== null && candidate.subjectUserId !== normalizedOwnerId) {
      rejected.push(rejection(index, 'cross_user_scope_rejected'));
      return;
    }

    // A Bot keeps one memory that every member shares. Personal or sensitive
    // statements are no longer routed to a private scope, but they are still
    // flagged so the console can surface them.
    const sensitiveFact = candidate.sensitivity !== 'normal'
      || candidate.scope === 'user_private'
      || candidate.subjectUserId === normalizedOwnerId
      || PRIVATE_FACT_PATTERN.test(statement);
    const scope = candidate.scope === 'thread_only' ? 'thread_only' : 'shared';
    const sensitivity = sensitiveFact && candidate.sensitivity === 'normal'
      ? 'confidential'
      : candidate.sensitivity;
    accepted.push(Object.freeze({
      botId: normalizedBotId,
      statement,
      logicalKey: candidate.logicalKey,
      scope,
      subjectUserId: null,
      sensitivity,
      confidence: candidate.confidence,
      provenance: Object.freeze({
        channelId: normalizedChannelId,
        runId: normalizedRunId,
        messageIds: Object.freeze([...provenanceIds]),
      }),
      classifier: Object.freeze({
        version: 1,
        requestedScope: candidate.scope,
        resolvedScope: scope,
      }),
    }));
  });

  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
  });
}
