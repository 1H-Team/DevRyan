import crypto from 'node:crypto';

import {
  isPlainObject,
  validateBoundedString,
  validateOptionalUuid,
  validateUuid,
} from './validation.js';

export const BOT_AUDIT_DEFAULT_RETENTION_DAYS = 365;
export const BOT_AUDIT_MINIMUM_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_AUDIT_METADATA_BYTES = 16 * 1024;
const RESULTS = new Set(['success', 'failure', 'denied', 'partial', 'unknown']);
const SAFE_SUFFIXES = [
  'at',
  'code',
  'count',
  'digest',
  'hash',
  'id',
  'length',
  'reference',
  'size',
  'status',
  'type',
];
const CONTENT_KEYS = [
  'args',
  'arguments',
  'attachment',
  'authorization',
  'body',
  'ciphertext',
  'content',
  'cookie',
  'data',
  'image',
  'input',
  'message',
  'output',
  'password',
  'plaintext',
  'prompt',
  'request',
  'response',
  'screenshot',
  'secret',
  'token',
  'transcript',
];

export class BotAuditError extends Error {
  constructor(message, code = 'bot_audit_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotAuditError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotAuditError(message, code, statusCode);
};

const normalizedKey = (key) => key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();

const isContentKey = (key) => {
  const normalized = normalizedKey(key);
  if (SAFE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  return CONTENT_KEYS.some((candidate) => normalized === candidate || normalized.endsWith(candidate));
};

const validateMetadataValue = (value, path, depth) => {
  if (depth > 6) fail(`${path} is nested too deeply`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (value.length > 512 || /[\r\n\0]/.test(value)) fail(`${path} is not content-free`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail(`${path} is too large`);
    return value.map((entry, index) => validateMetadataValue(entry, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) fail(`${path} must contain JSON metadata`);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || isContentKey(key)) {
      fail(`${path} contains content-bearing metadata`);
    }
    output[key] = validateMetadataValue(entry, `${path}.${key}`, depth + 1);
  }
  return output;
};

export const validateBotAuditMetadata = (metadata = {}) => {
  if (!isPlainObject(metadata)) fail('Bot audit metadata must be an object');
  const normalized = validateMetadataValue(metadata, 'metadata', 0);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_AUDIT_METADATA_BYTES) {
    fail('Bot audit metadata is too large');
  }
  return normalized;
};

export const resolveBotAuditRetentionDays = (
  value = process.env.DEVRYAN_BOT_AUDIT_RETENTION_DAYS,
  minimumDays = BOT_AUDIT_MINIMUM_RETENTION_DAYS,
) => {
  const effectiveMinimum = Math.max(BOT_AUDIT_MINIMUM_RETENTION_DAYS, Number(minimumDays) || 0);
  const retentionDays = value === undefined || value === null || value === ''
    ? BOT_AUDIT_DEFAULT_RETENTION_DAYS
    : Number(value);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < effectiveMinimum) {
    fail(
      `Bot audit retention must be at least ${effectiveMinimum} days`,
      'bot_audit_retention_invalid',
      500,
    );
  }
  return retentionDays;
};

export function createBotAuditRetention({
  store,
  platformAudit = async () => {},
  withAuditDeliveryBarrier = async (operation) => operation(),
  retentionDays = resolveBotAuditRetentionDays(),
  minimumDays = BOT_AUDIT_MINIMUM_RETENTION_DAYS,
  now = () => new Date(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof withAuditDeliveryBarrier !== 'function') {
    throw new TypeError('Bot audit retention requires a delivery barrier');
  }
  const normalizedRetentionDays = resolveBotAuditRetentionDays(retentionDays, minimumDays);
  let pruneTimer = null;

  const record = async ({
    principal,
    botId = null,
    targetType,
    targetId = null,
    action,
    result = 'success',
    metadata = {},
    eventId = crypto.randomUUID(),
    createdAt,
  }) => {
    if (!RESULTS.has(result)) fail('Bot audit result is invalid');
    const normalizedMetadata = validateBotAuditMetadata(metadata);
    const normalizedBotId = validateOptionalUuid(botId, 'botId');
    const row = {
      event_id: validateUuid(eventId, 'eventId'),
      bot_id: normalizedBotId,
      actor_user_id: principal?.scope === 'managed'
        ? validateOptionalUuid(principal.id, 'actorUserId')
        : null,
      target_type: validateBoundedString(targetType, 'targetType', { maximum: 120 }),
      target_id: targetId === null
        ? null
        : validateBoundedString(String(targetId), 'targetId', { maximum: 512 }),
      action: validateBoundedString(action, 'action', { maximum: 160 }),
      result,
      metadata: normalizedMetadata,
      ...(createdAt ? { created_at: new Date(createdAt).toISOString() } : {}),
    };
    const stored = await store.insert('bot_audit_events', row);
    await platformAudit(principal, action, {
      eventId: row.event_id,
      targetType: row.target_type,
      targetId: row.target_id,
      success: result === 'success',
      metadata: {
        botId: normalizedBotId,
        result,
        ...normalizedMetadata,
      },
    });
    return stored;
  };

  const prune = async () => {
    if (!store.available) return 0;
    const current = now();
    const currentMs = current instanceof Date ? current.getTime() : Number(current);
    if (!Number.isFinite(currentMs)) fail('Bot audit clock is invalid', 'bot_audit_retention_invalid', 500);
    const cutoff = new Date(currentMs - (normalizedRetentionDays * DAY_MS)).toISOString();
    const result = await withAuditDeliveryBarrier(() => store.pruneAudit(cutoff));
    return Number(Array.isArray(result) ? result[0] : result) || 0;
  };

  return Object.freeze({
    retentionDays: normalizedRetentionDays,
    record,
    prune,
    async start() {
      if (!store.available || pruneTimer) return;
      await prune();
      pruneTimer = setIntervalImpl(() => {
        void prune().catch(() => undefined);
      }, DAY_MS);
      pruneTimer?.unref?.();
    },
    shutdown() {
      if (!pruneTimer) return;
      clearIntervalImpl(pruneTimer);
      pruneTimer = null;
    },
  });
}
