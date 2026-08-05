import path from 'node:path';
import crypto from 'node:crypto';

const REDACTED = '[REDACTED]';

const RECORD_FIELDS = Object.freeze({
  open_code_event: new Set(['type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'coalesced', 'payload']),
  prompt: new Set(['type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'messageID', 'payload']),
  control: new Set(['type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'action', 'payload']),
  lifecycle: new Set([
    'type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'turnID', 'userMessageID',
    'assistantMessageID', 'event', 'payload',
  ]),
  worktree_transition: new Set([
    'type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'operationID', 'stage', 'status', 'payload',
  ]),
  evidence_transition: new Set([
    'type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'turnID', 'checkpointID',
    'status', 'payload',
  ]),
  connection: new Set(['type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'status', 'attempt', 'payload']),
  timing: new Set([
    'type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'messageID', 'mark', 'payload',
  ]),
  log: new Set(['type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'level', 'source', 'message', 'payload']),
  gap: new Set(['type', 'at', 'runtime', 'actor', 'directory', 'sessionID', 'reason', 'count', 'source', 'payload']),
});

const NESTED_FIELDS = new Set([
  'type', 'properties', 'payload', 'actor', 'info', 'part', 'status', 'state', 'time',
  'id', 'sessionID', 'sessionId', 'messageID', 'messageId', 'parentID', 'parentId',
  'role', 'scope', 'finish', 'completed', 'created', 'updated', 'started', 'ended',
  'version', 'phase', 'outcome', 'settledAt',
  'title', 'description', 'text', 'delta', 'reasoning', 'reasoningText',
  'tool', 'name', 'callID', 'callId', 'input', 'output', 'error', 'message',
  'code', 'reason', 'action', 'permission', 'questions', 'answers', 'response',
  'directory', 'path', 'file', 'filePath', 'url', 'mime', 'mimeType', 'size',
  'filename',
  'sha256', 'hash', 'source', 'runtime', 'providerID', 'providerId', 'modelID',
  'modelId', 'agent', 'variant', 'command', 'args', 'attachments', 'parts',
  'files', 'metadata', 'summary', 'diff', 'patch', 'before', 'after', 'head',
  'branch', 'remote', 'stage', 'stages', 'operationID', 'operationId', 'checkpointID',
  'checkpointId', 'turnID', 'turnId', 'userMessageID', 'assistantMessageID',
  'statusCode', 'success', 'failed', 'aborted', 'retry', 'attempt', 'count',
  'durationMs', 'startedAt', 'finishedAt', 'createdAt', 'updatedAt', 'warnings',
  'content', 'body', 'headers', 'method', 'kind', 'format', 'language',
  'binary', 'truncated', 'exitCode', 'stdout', 'stderr', 'data', 'value',
  'projectDirectory', 'idempotencyKey', 'fingerprint', 'tombstone', 'result',
  'contended', 'gapReason', 'ref', 'commit', 'tree', 'parent', 'reusedTree',
  'model', 'system', 'noReply', 'tools', 'tokens', 'cost', 'snapshot',
]);

const STABLE_IDENTIFIER_FIELDS = new Set([
  'id', 'sessionID', 'sessionId', 'messageID', 'messageId', 'parentID', 'parentId',
  'callID', 'callId', 'providerID', 'providerId', 'modelID', 'modelId',
  'operationID', 'operationId', 'checkpointID', 'checkpointId', 'turnID', 'turnId',
  'userMessageID', 'assistantMessageID', 'idempotencyKey', 'fingerprint',
  'sha256', 'hash', 'head', 'commit', 'tree', 'ref', 'parent',
]);

const SECRET_PATTERNS = [
  { kind: 'pem', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { kind: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'provider_token', regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gi },
  { kind: 'credential_assignment', regex: /\b(?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi },
];

const asObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const shannonEntropy = (value) => {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
};

const looksHighEntropyToken = (value) => (
  value.length >= 32
  && value.length <= 512
  && /^[A-Za-z0-9+/_=-]+$/.test(value)
  && /[A-Za-z]/.test(value)
  && /\d/.test(value)
  && shannonEntropy(value) >= 3.7
);

const HIGH_ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/_=-])([A-Za-z0-9+/_=-]{32,512})(?![A-Za-z0-9+/_=-])/g;

export const createDiagnosticSanitizer = (options = {}) => {
  const inventory = new Set(
    Array.isArray(options.knownSecrets)
      ? options.knownSecrets.filter((value) => typeof value === 'string' && value.length >= 6)
      : [],
  );
  const report = {
    droppedFields: 0,
    redactions: {},
    sanitizedRecords: 0,
    failedRecords: 0,
  };
  const pathMappings = [];

  const addPathMapping = (candidate, placeholder) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const absolute = path.resolve(candidate);
    if (pathMappings.some((entry) => entry.absolute === absolute)) return;
    pathMappings.push({ absolute, placeholder });
    pathMappings.sort((left, right) => right.absolute.length - left.absolute.length);
  };

  const addWorktreeRoot = (candidate) => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return;
    const absolute = path.resolve(candidate);
    const suffix = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 12);
    addPathMapping(absolute, `<WORKTREE_${suffix}>`);
  };

  addPathMapping(options.homeDir, '<HOME>');
  addPathMapping(options.dataDir, '<DATA_DIR>');
  for (const [index, root] of (options.worktreeRoots ?? []).entries()) {
    addPathMapping(root, `<WORKTREE_${index + 1}>`);
  }
  for (const mapping of options.pathMappings ?? []) {
    addPathMapping(mapping?.path, mapping?.placeholder || '<PATH>');
  }

  const increment = (kind, count = 1) => {
    report.redactions[kind] = (report.redactions[kind] ?? 0) + count;
  };

  const redactString = (input, redactOptions = {}) => {
    let value = input;
    for (const secret of inventory) {
      if (!value.includes(secret)) continue;
      value = value.split(secret).join(`${REDACTED}:known`);
      increment('known');
    }
    for (const { absolute, placeholder } of pathMappings) {
      const pattern = new RegExp(escapeRegExp(absolute), process.platform === 'win32' ? 'gi' : 'g');
      if (!pattern.test(value)) continue;
      pattern.lastIndex = 0;
      value = value.replace(pattern, placeholder);
      increment('path');
    }
    for (const { kind, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (!regex.test(value)) continue;
      regex.lastIndex = 0;
      value = value.replace(regex, `${REDACTED}:${kind}`);
      increment(kind);
    }
    if (redactOptions.highEntropy === false) return value;
    HIGH_ENTROPY_CANDIDATE.lastIndex = 0;
    return value.replace(HIGH_ENTROPY_CANDIDATE, (candidate) => {
      if (!looksHighEntropyToken(candidate)) return candidate;
      increment('high_entropy');
      return `${REDACTED}:high_entropy`;
    });
  };

  const sanitizeNested = (value, seen = new WeakSet(), field = '') => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      return redactString(value, { highEntropy: !STABLE_IDENTIFIER_FIELDS.has(field) });
    }
    if (Array.isArray(value)) return value.map((entry) => sanitizeNested(entry, seen, field));
    const object = asObject(value);
    if (!object) return null;
    if (seen.has(object)) throw new TypeError('diagnostic record contains a cycle');
    seen.add(object);
    const mime = typeof object.mime === 'string'
      ? object.mime
      : (typeof object.mimeType === 'string' ? object.mimeType : '');
    const isBinary = object.binary === true
      || (mime && !mime.startsWith('text/') && !mime.includes('json') && !mime.includes('xml'));
    if (isBinary) {
      const raw = typeof object.data === 'string'
        ? object.data
        : (typeof object.content === 'string'
          ? object.content
          : (typeof object.url === 'string' && object.url.startsWith('data:')
            ? object.url.slice(object.url.indexOf(',') + 1)
            : ''));
      const encoding = object.encoding === 'base64'
        || (typeof object.url === 'string' && object.url.includes(';base64,'))
        ? 'base64'
        : 'utf8';
      const bytes = raw ? Buffer.from(raw, encoding) : Buffer.alloc(0);
      const output = {
        binary: true,
        ...(typeof object.name === 'string' ? { name: redactString(object.name) } : {}),
        ...(mime ? { mime: redactString(mime) } : {}),
        size: typeof object.size === 'number' && Number.isFinite(object.size)
          ? object.size
          : bytes.length,
        sha256: typeof object.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(object.sha256)
          ? object.sha256.toLowerCase()
          : crypto.createHash('sha256').update(bytes).digest('hex'),
      };
      seen.delete(object);
      return output;
    }
    const output = {};
    for (const [key, nested] of Object.entries(object)) {
      if (!NESTED_FIELDS.has(key)) {
        report.droppedFields += 1;
        continue;
      }
      output[key] = sanitizeNested(nested, seen, key);
    }
    seen.delete(object);
    return output;
  };

  const sanitizeRecord = (candidate) => {
    const object = asObject(candidate);
    if (!object) throw new TypeError('diagnostic record must be an object');
    addWorktreeRoot(object.directory);
    const type = typeof object.type === 'string' ? object.type.trim() : '';
    const allowed = RECORD_FIELDS[type];
    if (!allowed) throw new TypeError(`unsupported diagnostic record type: ${type || 'missing'}`);
    const output = {};
    for (const [key, value] of Object.entries(object)) {
      if (!allowed.has(key)) {
        report.droppedFields += 1;
        continue;
      }
      output[key] = sanitizeNested(value, new WeakSet(), key);
    }
    output.type = type;
    output.at = Number.isFinite(output.at) ? output.at : Date.now();
    report.sanitizedRecords += 1;
    return output;
  };

  const sanitizeExportValue = (candidate) => {
    const visit = (value, field = '', seen = new WeakSet()) => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') {
        return redactString(value, { highEntropy: !STABLE_IDENTIFIER_FIELDS.has(field) });
      }
      if (Array.isArray(value)) return value.map((entry) => visit(entry, field, seen));
      const object = asObject(value);
      if (!object) return null;
      if (seen.has(object)) throw new TypeError('diagnostic export value contains a cycle');
      seen.add(object);
      const output = {};
      for (const [key, nested] of Object.entries(object)) {
        output[key] = visit(nested, key, seen);
      }
      seen.delete(object);
      return output;
    };
    return visit(candidate);
  };

  return {
    sanitizeRecord,
    sanitizeText: redactString,
    sanitizeExportValue,
    addKnownSecret(value) {
      if (typeof value === 'string' && value.length >= 6) inventory.add(value);
    },
    addPathMapping,
    addWorktreeRoot,
    recordFailure() {
      report.failedRecords += 1;
    },
    getReport() {
      return {
        ...report,
        redactions: { ...report.redactions },
        knownSecretCount: inventory.size,
        pathPlaceholderCount: pathMappings.length,
      };
    },
  };
};

export {
  NESTED_FIELDS,
  RECORD_FIELDS,
  SECRET_PATTERNS,
};
