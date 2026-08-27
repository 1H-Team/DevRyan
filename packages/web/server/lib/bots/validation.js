const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class BotValidationError extends Error {
  constructor(message, code = 'bot_request_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotValidationError(message, code, statusCode);
};

export const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const assertExactObject = (value, {
  label = 'request',
  required = [],
  optional = [],
} = {}) => {
  if (!isPlainObject(value)) fail(`${label} must be a JSON object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${label} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label}.${key} must be a JSON data property`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
  return value;
};

export const validateUuid = (value, field = 'id') => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) fail(`${field} must be a UUID`);
  return normalized;
};

export const validateOptionalUuid = (value, field = 'id') => (
  value === null || value === undefined ? null : validateUuid(value, field)
);

export const validateBoundedString = (value, field, {
  minimum = 1,
  maximum = 512,
  pattern,
} = {}) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minimum || normalized.length > maximum || (pattern && !pattern.test(normalized))) {
    fail(`${field} is invalid`);
  }
  return normalized;
};

const validateJsonValue = (value, path, ancestors, depth) => {
  if (depth > 8) fail(`${path} is nested too deeply`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) fail(`${path} is not JSON-compatible`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail(`${path} is not JSON-compatible`);
        validateJsonValue(value[index], `${path}[${index}]`, ancestors, depth + 1);
      }
      return;
    }
    if (!isPlainObject(value)) fail(`${path} must be a plain JSON object`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        fail(`${path} contains a forbidden key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail(`${path}.${key} must be a JSON data property`);
      }
      validateJsonValue(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
};

export const validateBoundedJsonObject = (value, field, maximumBytes = MAX_JSON_BYTES) => {
  if (!isPlainObject(value)) fail(`${field} must be a JSON object`);
  validateJsonValue(value, field, new Set(), 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) {
    fail(`${field} is too large`, 'bot_request_too_large', 413);
  }
  return structuredClone(value);
};

export const decodeCanonicalBase64 = (value, field = 'dataBase64', maximumBytes = MAX_UPLOAD_BYTES) => {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) fail(`${field} must be canonical base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail(`${field} must be canonical base64`);
  if (bytes.byteLength < 1) fail(`${field} must not be empty`);
  if (bytes.byteLength > maximumBytes) fail(`${field} is too large`, 'bot_object_too_large', 413);
  return bytes;
};

export const validateObjectUploadRequest = (value, maximumBytes = MAX_UPLOAD_BYTES) => {
  assertExactObject(value, {
    label: 'object upload',
    required: ['contentType', 'dataBase64'],
    optional: ['provenance'],
  });
  return {
    contentType: validateBoundedString(value.contentType, 'contentType', { maximum: 255 }),
    bytes: decodeCanonicalBase64(value.dataBase64, 'dataBase64', maximumBytes),
    provenance: value.provenance === undefined
      ? {}
      : validateBoundedJsonObject(value.provenance, 'provenance'),
  };
};

export const validateBotProfileUpdateRequest = (value, maximumAvatarBytes) => {
  assertExactObject(value, {
    label: 'Bot profile update',
    required: ['name', 'title', 'summary', 'expectedUpdatedAt'],
    optional: ['avatar'],
  });
  const request = {
    name: validateBoundedString(value.name, 'name', { maximum: 120 }),
    title: validateBoundedString(value.title, 'title', { maximum: 160 }),
    summary: typeof value.summary === 'string' ? value.summary.trim() : '',
    expectedUpdatedAt: value.expectedUpdatedAt,
  };
  if (request.summary.length > 500) fail('summary is invalid');
  if (Object.hasOwn(value, 'avatar')) {
    request.avatar = value.avatar === null
      ? null
      : validateObjectUploadRequest(value.avatar, maximumAvatarBytes);
  }
  return request;
};

export const validatePublishObjectRequest = (value) => {
  assertExactObject(value, {
    label: 'library publication',
    required: ['name'],
    optional: ['sourceId', 'provenance'],
  });
  return {
    name: validateBoundedString(value.name, 'name', { maximum: 255 }),
    sourceId: value.sourceId === undefined ? null : validateUuid(value.sourceId, 'sourceId'),
    provenance: value.provenance === undefined
      ? {}
      : validateBoundedJsonObject(value.provenance, 'provenance'),
  };
};

export const validateBreakGlassReason = (value) => validateBoundedString(
  value,
  'break-glass reason',
  { minimum: 3, maximum: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$/ },
);

export const normalizePageLimit = (value, fallback = 50, maximum = 100) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`limit must be between 1 and ${maximum}`);
  }
  return parsed;
};

export const jsonError = (res, error, fallbackStatus = 500) => {
  const status = Number(error?.statusCode || error?.status || fallbackStatus);
  const statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallbackStatus;
  const code = typeof error?.code === 'string' ? error.code : 'bot_internal_error';
  const message = statusCode >= 500
    ? 'Production Bots are temporarily unavailable'
    : (error instanceof Error ? error.message : 'Bot request failed');
  return res.status(statusCode).json({ error: message, code });
};

export const BOT_OBJECT_MAX_BYTES = MAX_UPLOAD_BYTES;
