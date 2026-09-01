import { createHash } from 'node:crypto';

export const BOT_LIFECYCLES = Object.freeze(['draft', 'active', 'paused', 'retired']);
// Every Bot runs one shared computer. 'personalized' is still accepted at the
// boundary so records written before the shared-computer migration keep
// resolving, but it maps to the same team scope key.
export const BOT_TENANCIES = Object.freeze(['team', 'personalized']);
export const BOT_DEFAULT_TENANCY = 'team';
export const BOT_MEMBER_ROLES = Object.freeze(['member', 'operator', 'manager']);
export const BOT_RUN_STATES = Object.freeze([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'waiting_control',
  'needs_reconciliation',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export const BOT_ACTION_STATES = Object.freeze([
  'proposed',
  'pending_approval',
  'approved',
  'executing',
  'waiting_control',
  'succeeded',
  'failed',
  'unknown',
  'reconciled',
  'denied',
  'cancelled',
]);

export const BOT_ERROR_CODES = Object.freeze({
  unavailable: 'bots_unavailable',
  migrationRequired: 'bot_schema_migration_required',
  dockerNotInstalled: 'bot_runtime_docker_not_installed',
  dockerUnavailable: 'bot_runtime_docker_unavailable',
  runtimeSetupRequired: 'bot_runtime_setup_required',
  runtimeUpdateRequired: 'bot_runtime_update_required',
  botPaused: 'bot_paused',
  botRetired: 'bot_retired',
  membershipRequired: 'bot_membership_required',
  managerRequired: 'bot_manager_required',
  channelForbidden: 'bot_channel_forbidden',
  modelUnavailable: 'bot_model_unavailable',
  approvalRequired: 'bot_approval_required',
  actionNeedsReconciliation: 'bot_action_needs_reconciliation',
  revisionConflict: 'bot_revision_conflict',
});

const JSON_OBJECT_PROTOTYPES = new Set([Object.prototype, null]);

export const isPlainBotJsonObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && JSON_OBJECT_PROTOTYPES.has(Object.getPrototypeOf(value))
);

const formatUnknownField = (label, key) => `${label} contains unknown field ${String(key)}`;

export const assertBotBoundaryObject = (
  value,
  {
    label,
    required = [],
    optional = [],
  },
) => {
  if (!isPlainBotJsonObject(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }

  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(formatUnknownField(label, key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be a JSON data property`);
    }
  }

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing required field ${key}`);
    }
  }

  return value;
};

export const assertBotString = (value, field, { nullable = false } = {}) => {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string${nullable ? ' or null' : ''}`);
  }
  return value;
};

export const assertBotBoolean = (value, field) => {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
};

export const assertBotTimestamp = (value, field, { nullable = false } = {}) => {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer timestamp${nullable ? ' or null' : ''}`);
  }
  return value;
};

export const assertBotEnum = (value, values, field) => {
  if (!values.includes(value)) {
    throw new TypeError(`${field} must be one of ${values.join(', ')}`);
  }
  return value;
};

const assertJsonValue = (value, path, ancestors) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite JSON number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} must be JSON-compatible`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] must be JSON-compatible`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${path}[${index}] must be a JSON data property`);
        }
        assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const index = typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)
          ? Number(key)
          : Number.NaN;
        if (!Number.isSafeInteger(index) || index >= value.length) {
          throw new TypeError(`${path} contains a non-JSON array property`);
        }
      }
      return;
    }

    if (!isPlainBotJsonObject(value)) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} contains a non-string JSON key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${path}.${key} must be a JSON data property`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
};

export const assertBotJsonValue = (value, path = 'value') => {
  assertJsonValue(value, path, new Set());
  return value;
};

const serializeCanonicalJson = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
};

export const canonicalizeBotJson = (value) => {
  assertBotJsonValue(value, 'value');
  return serializeCanonicalJson(value);
};

export const hashCanonicalBotJson = (value) => (
  createHash('sha256').update(canonicalizeBotJson(value), 'utf8').digest('hex')
);

export const resolveComputerScopeKey = (input) => {
  assertBotBoundaryObject(input, {
    label: 'computer scope input',
    required: ['botId', 'tenancy', 'ownerUserId'],
  });
  const botId = assertBotString(input.botId, 'botId');
  assertBotEnum(input.tenancy, BOT_TENANCIES, 'tenancy');
  assertBotString(input.ownerUserId, 'ownerUserId');
  return `bot:${botId}`;
};

export const resolveReasoningScopeKey = (input) => {
  assertBotBoundaryObject(input, {
    label: 'reasoning scope input',
    required: ['channelId'],
  });
  return `channel:${assertBotString(input.channelId, 'channelId')}`;
};
