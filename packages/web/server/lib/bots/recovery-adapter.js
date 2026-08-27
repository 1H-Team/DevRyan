import crypto from 'node:crypto';

import { hashCanonicalBotJson } from '@openchamber/bots-runtime';

import { decryptBotJson } from './encryption.js';
import {
  BOT_MCP_DEPLOYMENT_KEY_ID,
  botMcpDescriptorAssociatedData,
  digestBotMcpDescriptor,
  normalizePinnedBotMcpDescriptor,
} from './mcp-connector.js';
import { BOT_TABLES } from './store.js';
import { validateBoundedString, validateUuid } from './validation.js';

export const BOT_RECOVERY_CONFIGURATION_FORMAT = 'DevRyan.BotConfiguration';
export const BOT_RECOVERY_CONFIGURATION_VERSION = 1;

const CONFIGURATION_ARRAYS = Object.freeze([
  'revisions',
  'memberships',
  'routines',
  'evalCases',
  'librarySources',
  'libraryVersions',
  'skillPackages',
  'mcpBindings',
  'credentials',
  'environmentSecrets',
  'channels',
  'channelAcl',
]);
const CONFIGURATION_KEYS = Object.freeze([
  'format',
  'version',
  'bot',
  ...CONFIGURATION_ARRAYS,
]);
const LEGACY_CONFIGURATION_KEYS = Object.freeze(
  CONFIGURATION_KEYS.filter((key) => ![
    'skillPackages', 'mcpBindings', 'environmentSecrets',
  ].includes(key)),
);
const PRE_ENVIRONMENT_SECRETS_CONFIGURATION_KEYS = Object.freeze(
  CONFIGURATION_KEYS.filter((key) => key !== 'environmentSecrets'),
);
const COMPATIBLE_CONFIGURATION_KEY_SETS = Object.freeze([
  CONFIGURATION_KEYS,
  PRE_ENVIRONMENT_SECRETS_CONFIGURATION_KEYS,
  LEGACY_CONFIGURATION_KEYS,
]);
const MAX_CONFIGURATION_ROWS = 20_000;
const MAX_OBJECT_COUNT = 10_000;
const MAX_OBJECT_TOTAL_BYTES = 260 * 1024 * 1024;
const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
const PROFILE_AVATAR_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class BotRecoveryAdapterError extends Error {
  constructor(message, code = 'bot_recovery_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotRecoveryAdapterError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details) => {
  throw new BotRecoveryAdapterError(message, code, statusCode, details);
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const assertExact = (value, keys, label) => {
  if (!isRecord(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} is invalid`, 'bot_recovery_corrupt');
  }
  return value;
};

const listAll = async (repository, filters = {}, maximum = MAX_CONFIGURATION_ROWS) => {
  const rows = [];
  let cursor = null;
  do {
    const page = await repository.list({ filters, cursor, limit: 100 });
    if (!page || !Array.isArray(page.items)) {
      fail('Bot control-plane query returned invalid data', 'bot_recovery_control_plane_invalid', 502);
    }
    rows.push(...page.items);
    if (rows.length > maximum) {
      fail('Bot recovery selection is too large', 'bot_recovery_limit_exceeded', 413);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
};

const publicWriteRow = (tableName, row, overrides = {}) => {
  const writable = BOT_TABLES[tableName]?.writable;
  if (!writable) fail('Bot recovery table is unsupported', 'bot_recovery_incompatible', 409);
  const output = {};
  for (const field of writable) {
    const value = Object.hasOwn(overrides, field) ? overrides[field] : row[field];
    if (value !== undefined) output[field] = structuredClone(value);
  }
  return output;
};

const validateConfiguration = (configuration, expectedBotId) => {
  if (!isRecord(configuration)
    || !COMPATIBLE_CONFIGURATION_KEY_SETS.some((keys) => (
      Object.keys(configuration).sort().join('\0') === [...keys].sort().join('\0')
    ))) {
    fail('Recovery configuration is invalid', 'bot_recovery_corrupt');
  }
  if (configuration.format !== BOT_RECOVERY_CONFIGURATION_FORMAT
    || configuration.version !== BOT_RECOVERY_CONFIGURATION_VERSION) {
    fail('Recovery configuration version is incompatible', 'bot_recovery_incompatible', 409);
  }
  const legacyRevisions = Array.isArray(configuration.revisions) ? configuration.revisions : [];
  const compatibleRevisions = legacyRevisions.map((row) => (
    isRecord(row)
      && !Object.hasOwn(row, 'portable_spec')
      && !Object.hasOwn(row, 'spec_hash')
      ? { ...row, portable_spec: null, spec_hash: null }
      : row
  ));
  const legacyProfileRevision = legacyRevisions.find((row) => (
    row?.id === configuration.bot?.active_revision_id
  )) ?? [...legacyRevisions].sort((left, right) => (
    Number(right?.revision_number || 0) - Number(left?.revision_number || 0)
  ))[0];
  const legacyIdentity = isRecord(legacyProfileRevision?.contract?.identity)
    ? legacyProfileRevision.contract.identity
    : {};
  const compatibleBot = isRecord(configuration.bot) ? {
    ...configuration.bot,
    title: configuration.bot.title ?? legacyIdentity.title ?? configuration.bot.name,
    summary: configuration.bot.summary ?? '',
    avatar_object_id: configuration.bot.avatar_object_id ?? null,
    avatar_fallback: configuration.bot.avatar_fallback ?? legacyIdentity.avatar ?? null,
  } : configuration.bot;
  const bot = assertExact(
    compatibleBot,
    BOT_TABLES.bots.columns,
    'Recovery Bot record',
  );
  const botId = validateUuid(bot.id, 'configuration.bot.id');
  if (botId !== expectedBotId) fail('Recovery Bot identity does not match', 'bot_recovery_corrupt');
  validateBoundedString(bot.name, 'configuration.bot.name', { maximum: 120 });
  validateBoundedString(bot.title, 'configuration.bot.title', { maximum: 160 });
  if (typeof bot.summary !== 'string' || bot.summary.length > 500) {
    fail('Recovery Bot profile is invalid', 'bot_recovery_corrupt');
  }
  if (bot.avatar_fallback !== null) {
    validateBoundedString(bot.avatar_fallback, 'configuration.bot.avatarFallback', { maximum: 512 });
  }
  if (!['draft', 'active', 'paused', 'retired'].includes(bot.lifecycle)
    || !['team', 'personalized'].includes(bot.tenancy)) {
    fail('Recovery Bot state is invalid', 'bot_recovery_corrupt');
  }
  let totalRows = 0;
  for (const key of CONFIGURATION_ARRAYS) {
    const rows = configuration[key] ?? [];
    if (!Array.isArray(rows)) fail(`Recovery ${key} is invalid`, 'bot_recovery_corrupt');
    totalRows += rows.length;
  }
  if (totalRows > MAX_CONFIGURATION_ROWS || configuration.revisions.length < 1) {
    fail('Recovery configuration is too large or incomplete', 'bot_recovery_limit_exceeded', 413);
  }
  const tableForKey = {
    revisions: 'bot_revisions',
    memberships: 'bot_memberships',
    routines: 'bot_routines',
    evalCases: 'bot_eval_cases',
    librarySources: 'bot_library_sources',
    libraryVersions: 'bot_library_versions',
    skillPackages: 'bot_skill_packages',
    mcpBindings: 'bot_mcp_bindings',
    credentials: 'bot_credentials',
    environmentSecrets: 'bot_environment_secrets',
    channels: 'bot_channels',
    channelAcl: 'bot_channel_acl',
  };
  for (const [key, tableName] of Object.entries(tableForKey)) {
    const rows = key === 'revisions' ? compatibleRevisions : (configuration[key] ?? []);
    for (const row of rows) {
      assertExact(row, BOT_TABLES[tableName].columns, `Recovery ${tableName} record`);
    }
  }
  const revisions = new Map(compatibleRevisions.map((row) => [validateUuid(row.id), row]));
  if (revisions.size !== compatibleRevisions.length
    || compatibleRevisions.some((row) => validateUuid(row.bot_id) !== botId)
    || compatibleRevisions.some((row) => (
      (row.portable_spec === null) !== (row.spec_hash === null)
      || (row.portable_spec !== null
        && (!isRecord(row.portable_spec)
          || !HASH_PATTERN.test(row.spec_hash)
          || hashCanonicalBotJson(row.portable_spec) !== row.spec_hash))
    ))
    || (bot.active_revision_id !== null
      && (!revisions.has(validateUuid(bot.active_revision_id))
        || !revisions.get(bot.active_revision_id).activated_at))) {
    fail('Recovery revision identities are invalid', 'bot_recovery_corrupt');
  }
  const channels = new Map(configuration.channels.map((row) => [validateUuid(row.id), row]));
  if (channels.size !== configuration.channels.length
    || configuration.channels.some((row) => validateUuid(row.bot_id) !== botId)
    || configuration.channelAcl.some((row) => !channels.has(validateUuid(row.channel_id)))) {
    fail('Recovery channel identities are invalid', 'bot_recovery_corrupt');
  }
  const sources = new Map(configuration.librarySources.map((row) => [validateUuid(row.id), row]));
  const versions = new Map(configuration.libraryVersions.map((row) => [validateUuid(row.id), row]));
  if (sources.size !== configuration.librarySources.length
    || versions.size !== configuration.libraryVersions.length
    || configuration.librarySources.some((row) => validateUuid(row.bot_id) !== botId)
    || configuration.libraryVersions.some((row) => !sources.has(validateUuid(row.source_id)))
    || configuration.librarySources.some((row) => (
      row.current_published_version_id !== null
      && !versions.has(validateUuid(row.current_published_version_id))
    ))) {
    fail('Recovery Library identities are invalid', 'bot_recovery_corrupt');
  }
  for (const [key, field] of [
    ['memberships', 'bot_id'],
    ['routines', 'bot_id'],
    ['evalCases', 'bot_id'],
    ['credentials', 'bot_id'],
    ['environmentSecrets', 'bot_id'],
    ['skillPackages', 'bot_id'],
    ['mcpBindings', 'bot_id'],
  ]) {
    if ((configuration[key] ?? []).some((row) => validateUuid(row[field]) !== botId)) {
      fail(`Recovery ${key} contains another Bot`, 'bot_recovery_corrupt');
    }
  }
  const skillPackages = new Map((configuration.skillPackages ?? []).map((row) => [validateUuid(row.id), row]));
  const mcpBindings = new Map((configuration.mcpBindings ?? []).map((row) => [validateUuid(row.id), row]));
  if (skillPackages.size !== (configuration.skillPackages ?? []).length
    || mcpBindings.size !== (configuration.mcpBindings ?? []).length) {
    fail('Recovery capability binding identities are invalid', 'bot_recovery_corrupt');
  }
  for (const row of skillPackages.values()) {
    validateUuid(row.package_object_id, 'skillPackage.packageObjectId');
    if (typeof row.skill_name !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(row.skill_name)
      || !HASH_PATTERN.test(row.package_digest) || !isRecord(row.manifest)
      || !isRecord(row.display_metadata)) {
      fail('Recovery skill package is invalid', 'bot_recovery_corrupt');
    }
  }
  for (const row of mcpBindings.values()) {
    if (!['stdio', 'streamable_http', 'sse'].includes(row.transport)
      || typeof row.server_name !== 'string' || row.server_name.trim().length < 1
      || row.server_name.length > 120 || row.credential_provider !== `mcp.${row.id}`
      || row.credential_kind !== 'mcp-transport'
      || !HASH_PATTERN.test(row.descriptor_digest) || !HASH_PATTERN.test(row.manifest_digest)
      || !Array.isArray(row.tool_manifest) || !isRecord(row.descriptor_envelope)
      || !isRecord(row.display_metadata)
      || hashCanonicalBotJson(row.tool_manifest) !== row.manifest_digest) {
      fail('Recovery MCP binding is invalid', 'bot_recovery_corrupt');
    }
  }
  for (const revision of compatibleRevisions) {
    for (const binding of revision.contract?.skillBindings ?? []) {
      const row = skillPackages.get(validateUuid(binding.id));
      if (!row || row.package_digest !== binding.digest) {
        fail('Recovery skill bindings are invalid', 'bot_recovery_corrupt');
      }
    }
    for (const binding of revision.contract?.mcpBindings ?? []) {
      const row = mcpBindings.get(validateUuid(binding.id));
      if (!row || row.descriptor_digest !== binding.descriptorDigest
        || row.manifest_digest !== binding.manifestDigest) {
        fail('Recovery MCP bindings are invalid', 'bot_recovery_corrupt');
      }
    }
  }
  return Object.freeze({ bot, botId, revisions, channels, sources, versions });
};

const decodeObject = (entry, expectedBotId, channels) => {
  assertExact(entry, ['row', 'ciphertextBase64'], 'Recovery object');
  const row = assertExact(entry.row, BOT_TABLES.bot_objects.columns, 'Recovery object record');
  if (validateUuid(row.bot_id) !== expectedBotId
    || !['private', 'library', 'profile'].includes(row.visibility)
    || (row.visibility === 'private'
      && (!row.channel_id || !channels.has(validateUuid(row.channel_id))))
    || (['library', 'profile'].includes(row.visibility) && row.channel_id !== null)
    || typeof entry.ciphertextBase64 !== 'string') {
    fail('Recovery object identity is invalid', 'bot_recovery_corrupt');
  }
  if (row.visibility === 'profile'
    && (!PROFILE_AVATAR_CONTENT_TYPES.has(row.content_type)
      || Number(row.ciphertext_size) > MAX_PROFILE_AVATAR_BYTES)) {
    fail('Recovery profile avatar is invalid', 'bot_recovery_corrupt');
  }
  const ciphertext = Buffer.from(entry.ciphertextBase64, 'base64');
  if (ciphertext.toString('base64') !== entry.ciphertextBase64
    || !Number.isSafeInteger(Number(row.ciphertext_size))
    || ciphertext.byteLength !== Number(row.ciphertext_size)
    || !HASH_PATTERN.test(row.ciphertext_hash)
    || crypto.createHash('sha256').update(ciphertext).digest('hex') !== row.ciphertext_hash) {
    ciphertext.fill(0);
    fail('Recovery object hash or size is invalid', 'bot_recovery_integrity_invalid');
  }
  return { row, ciphertext };
};

const validateObjects = (objects, expectedBotId, channels) => {
  if (!Array.isArray(objects) || objects.length > MAX_OBJECT_COUNT) {
    fail('Recovery object selection is invalid', 'bot_recovery_limit_exceeded', 413);
  }
  const decoded = [];
  let totalBytes = 0;
  try {
    for (const entry of objects) {
      const object = decodeObject(entry, expectedBotId, channels);
      decoded.push(object);
      totalBytes += object.ciphertext.byteLength;
      if (totalBytes > MAX_OBJECT_TOTAL_BYTES) {
        fail('Recovery objects are too large', 'bot_recovery_limit_exceeded', 413);
      }
    }
    if (new Set(decoded.map(({ row }) => row.id)).size !== decoded.length
      || new Set(decoded.map(({ row }) => row.storage_object_name)).size !== decoded.length) {
      fail('Recovery object identities collide', 'bot_recovery_corrupt');
    }
    return decoded;
  } catch (error) {
    for (const object of decoded) object.ciphertext.fill(0);
    throw error;
  }
};

const validateMcpDescriptorEncryption = (configuration, deploymentKey) => {
  const key = Buffer.from(deploymentKey || []);
  try {
    if (key.byteLength !== 32) {
      fail('Recovery deployment key is invalid', 'bot_recovery_corrupt');
    }
    for (const binding of configuration.mcpBindings ?? []) {
      const descriptor = normalizePinnedBotMcpDescriptor(decryptBotJson({
        key,
        envelope: binding.descriptor_envelope,
        expectedKeyId: BOT_MCP_DEPLOYMENT_KEY_ID,
        associatedData: botMcpDescriptorAssociatedData(binding.id),
      }));
      if (digestBotMcpDescriptor(descriptor) !== binding.descriptor_digest) {
        fail('Recovery MCP descriptor failed integrity validation', 'bot_recovery_integrity_invalid');
      }
    }
  } catch (error) {
    if (error instanceof BotRecoveryAdapterError) throw error;
    fail('Recovery MCP descriptor failed integrity validation', 'bot_recovery_integrity_invalid');
  } finally {
    key.fill(0);
  }
};

const userReferences = (configuration, objects) => {
  const ids = new Set([configuration.bot.created_by]);
  const fields = [
    ['revisions', ['created_by']],
    ['memberships', ['user_id', 'assigned_by']],
    ['routines', ['created_by', 'managed_by']],
    ['evalCases', ['created_by']],
    ['librarySources', ['created_by']],
    ['libraryVersions', ['published_by']],
    ['credentials', ['created_by', 'owner_user_id']],
    ['environmentSecrets', ['created_by']],
    ['skillPackages', ['created_by']],
    ['mcpBindings', ['created_by']],
    ['channels', ['owner_user_id']],
    ['channelAcl', ['user_id', 'invited_by']],
  ];
  for (const [key, rowFields] of fields) {
    for (const row of configuration[key] ?? []) {
      for (const field of rowFields) if (row[field]) ids.add(row[field]);
    }
  }
  for (const { row } of objects) if (row.created_by) ids.add(row.created_by);
  return [...ids].map((id) => validateUuid(id, 'referencedUserId')).sort();
};

const identityRows = (configuration) => [
  ['bots', configuration.bot, { id: configuration.bot.id }],
  ...configuration.revisions.map((row) => ['bot_revisions', row, { id: row.id }]),
  ...configuration.routines.map((row) => ['bot_routines', row, { id: row.id }]),
  ...configuration.evalCases.map((row) => ['bot_eval_cases', row, { id: row.id }]),
  ...configuration.librarySources.map((row) => ['bot_library_sources', row, { id: row.id }]),
  ...configuration.libraryVersions.map((row) => ['bot_library_versions', row, { id: row.id }]),
  ...(configuration.skillPackages ?? []).map((row) => ['bot_skill_packages', row, { id: row.id }]),
  ...(configuration.mcpBindings ?? []).map((row) => ['bot_mcp_bindings', row, { id: row.id }]),
  ...configuration.credentials.map((row) => ['bot_credentials', row, { id: row.id }]),
  ...(configuration.environmentSecrets ?? []).map((row) => [
    'bot_environment_secrets', row, { id: row.id },
  ]),
  ...configuration.channels.map((row) => ['bot_channels', row, { id: row.id }]),
];

const deleteStorageNames = async (store, rows) => {
  const byBucket = new Map();
  for (const row of rows) {
    const names = byBucket.get(row.storage_bucket) || [];
    names.push(row.storage_object_name);
    byBucket.set(row.storage_bucket, names);
  }
  for (const [bucket, names] of byBucket) {
    for (let index = 0; index < names.length; index += 100) {
      await store.storage.delete(bucket, names.slice(index, index + 100));
    }
  }
};

const getDeploymentKeyCopy = async (encryption) => {
  const supplied = await encryption.getKey();
  try {
    return Buffer.from(supplied || []);
  } finally {
    if (Buffer.isBuffer(supplied) || supplied instanceof Uint8Array) supplied.fill(0);
  }
};

export function createBotRecoveryAdapter({
  store,
  authorization,
  encryption,
  getCredentialVault = () => null,
  getEnvironmentSecretVault = () => null,
  browserProfiles = null,
} = {}) {
  if (!store || !authorization || typeof authorization.requireManager !== 'function'
    || typeof encryption?.getKey !== 'function' || typeof getCredentialVault !== 'function'
    || typeof getEnvironmentSecretVault !== 'function') {
    throw new TypeError('Bot recovery adapter is misconfigured');
  }

  const exportConfiguration = async (principal, botId, options) => {
    await authorization.requireManager(principal, botId);
    const bot = await store.repositories.bots.get({ id: botId });
    if (!bot) fail('Bot was not found', 'bot_not_found', 404);
    const [
      revisions,
      memberships,
      routines,
      evalCases,
      allObjects,
      librarySources,
      skillPackages,
      mcpBindings,
      credentials,
      environmentSecrets,
    ] = await Promise.all([
      listAll(store.repositories.bot_revisions, { bot_id: botId }),
      listAll(store.repositories.bot_memberships, { bot_id: botId }),
      listAll(store.repositories.bot_routines, { bot_id: botId }),
      listAll(store.repositories.bot_eval_cases, { bot_id: botId }),
      listAll(store.repositories.bot_objects, { bot_id: botId }, MAX_OBJECT_COUNT),
      options.includeLibraryObjects
        ? listAll(store.repositories.bot_library_sources, { bot_id: botId })
        : Promise.resolve([]),
      listAll(store.repositories.bot_skill_packages, { bot_id: botId }),
      listAll(store.repositories.bot_mcp_bindings, { bot_id: botId }),
      options.includeConnectorVault
        ? listAll(store.repositories.bot_credentials, { bot_id: botId })
        : Promise.resolve([]),
      options.includeEnvironmentSecrets
        ? listAll(store.repositories.bot_environment_secrets, { bot_id: botId })
        : Promise.resolve([]),
    ]);
    const requiredSkillObjectIds = new Set(skillPackages.map((row) => row.package_object_id));
    const requiredProfileObjectIds = new Set(bot.avatar_object_id ? [bot.avatar_object_id] : []);
    const selectedRows = allObjects.filter((row) => (
      row.deleted_at === null
      && (requiredSkillObjectIds.has(row.id)
        || requiredProfileObjectIds.has(row.id)
        || (row.visibility === 'library' && options.includeLibraryObjects)
        || (row.visibility === 'private' && options.includeWorkspaceObjects))
    ));
    const selectedObjectIds = new Set(selectedRows.map((row) => row.id));
    if ([...requiredSkillObjectIds, ...requiredProfileObjectIds]
      .some((objectId) => !selectedObjectIds.has(objectId))) {
      fail('A required Bot encrypted object is unavailable for recovery', 'bot_recovery_conflict', 409);
    }
    const channelIds = new Set(selectedRows
      .filter((row) => row.visibility === 'private')
      .map((row) => row.channel_id));
    const channels = [];
    const channelAcl = [];
    for (const channelId of channelIds) {
      const channel = await store.repositories.bot_channels.get({ id: channelId });
      if (!channel || channel.bot_id !== botId) {
        fail('Selected workspace object has no compatible channel', 'bot_recovery_conflict', 409);
      }
      channels.push(channel);
      channelAcl.push(...await listAll(store.repositories.bot_channel_acl, { channel_id: channelId }));
    }
    const libraryVersions = [];
    for (const source of librarySources) {
      libraryVersions.push(...await listAll(
        store.repositories.bot_library_versions,
        { source_id: source.id },
      ));
    }
    const objects = [];
    let objectBytes = 0;
    for (const row of selectedRows) {
      const ciphertext = await store.storage.download(row.storage_bucket, row.storage_object_name, {
        maximumBytes: Number(row.ciphertext_size),
      });
      try {
        const hash = crypto.createHash('sha256').update(ciphertext).digest('hex');
        if (ciphertext.byteLength !== Number(row.ciphertext_size) || hash !== row.ciphertext_hash) {
          fail('Stored Bot object failed recovery integrity validation', 'bot_object_integrity_failed', 502);
        }
        objectBytes += ciphertext.byteLength;
        if (objectBytes > MAX_OBJECT_TOTAL_BYTES) {
          fail('Recovery objects are too large', 'bot_recovery_limit_exceeded', 413);
        }
        objects.push({ row: structuredClone(row), ciphertextBase64: ciphertext.toString('base64') });
      } finally {
        ciphertext.fill(0);
      }
    }
    return Object.freeze({
      bot: Object.freeze({ id: bot.id, name: bot.name }),
      configuration: Object.freeze({
        format: BOT_RECOVERY_CONFIGURATION_FORMAT,
        version: BOT_RECOVERY_CONFIGURATION_VERSION,
        bot: structuredClone(bot),
        revisions: structuredClone(revisions),
        memberships: structuredClone(memberships),
        routines: structuredClone(routines),
        evalCases: structuredClone(evalCases),
        librarySources: structuredClone(librarySources),
        libraryVersions: structuredClone(libraryVersions),
        skillPackages: structuredClone(skillPackages),
        mcpBindings: structuredClone(mcpBindings),
        credentials: structuredClone(credentials),
        environmentSecrets: structuredClone(environmentSecrets),
        channels: structuredClone(channels),
        channelAcl: structuredClone(channelAcl),
      }),
      objects: Object.freeze(objects),
      browserScopes: Object.freeze(bot.tenancy === 'team'
        ? [`bot:${bot.id}`]
        : memberships.filter((row) => row.revoked_at === null)
          .map((row) => `bot:${bot.id}:user:${row.user_id}`)
          .sort()),
    });
  };

  const inspectRestore = async (input) => {
    const botId = validateUuid(input.manifest?.bot?.id, 'manifest.bot.id');
    const validated = validateConfiguration(input.configuration, botId);
    validateMcpDescriptorEncryption(input.configuration, input.deploymentKey);
    const objects = validateObjects(input.objects, botId, validated.channels);
    const objectsById = new Map(objects.map((entry) => [entry.row.id, entry.row]));
    if (validated.bot.avatar_object_id !== null) {
      const avatar = objectsById.get(validateUuid(validated.bot.avatar_object_id));
      if (!avatar || avatar.visibility !== 'profile' || avatar.bot_id !== botId) {
        for (const object of objects) object.ciphertext.fill(0);
        fail('Recovery Bot profile requires its encrypted avatar object', 'bot_recovery_corrupt');
      }
    }
    if ((input.configuration.skillPackages ?? []).some((row) => {
      const object = objectsById.get(row.package_object_id);
      return !object || object.visibility !== 'library' || object.bot_id !== botId;
    })) {
      for (const object of objects) object.ciphertext.fill(0);
      fail('Recovery skill packages require their encrypted objects', 'bot_recovery_corrupt');
    }
    let currentKey;
    try {
      currentKey = await getDeploymentKeyCopy(encryption);
      if (currentKey.byteLength !== 32) fail('Deployment key is unavailable', 'bot_os_encryption_unavailable', 503);
      const keyMatches = crypto.timingSafeEqual(currentKey, input.deploymentKey);
      if (input.mode === 'merge' && !keyMatches) {
        fail('Merge restore requires the same deployment key', 'bot_recovery_key_conflict', 409);
      }
      if (input.mode === 'empty') {
        const existing = await store.repositories.bots.list({ limit: 1 });
        if (existing.items.length > 0) {
          fail('Empty restore requires a deployment with no Bots', 'bot_recovery_target_not_empty', 409);
        }
      }
      const collisions = [];
      for (const [tableName, row, keys] of identityRows(input.configuration)) {
        if (await store.repositories[tableName].get(keys)) {
          collisions.push({ table: tableName, id: row.id });
        }
      }
      for (const object of objects) {
        if (await store.repositories.bot_objects.get({ id: object.row.id })) {
          collisions.push({ table: 'bot_objects', id: object.row.id });
        } else if (await store.repositories.bot_objects.get({
          storage_object_name: object.row.storage_object_name,
        })) {
          collisions.push({ table: 'bot_objects', id: object.row.storage_object_name });
        }
      }
      if (collisions.length > 0) {
        fail('Recovery restore would overwrite existing identities', 'bot_recovery_collision', 409, {
          collisions: collisions.slice(0, 100),
        });
      }
      const missingUsers = [];
      for (const userId of userReferences(input.configuration, objects)) {
        if (!await store.userProfileExists(userId)) missingUsers.push(userId);
      }
      if (missingUsers.length > 0) {
        fail('Recovery deployment is missing referenced users', 'bot_recovery_users_incompatible', 409, {
          missingUserIds: missingUsers.slice(0, 100),
        });
      }
      const vault = getCredentialVault();
      if (input.connectorVault) {
        if (!vault || typeof vault.inspectRestoreForBot !== 'function') {
          fail('Connector vault restore is unavailable', 'bot_recovery_connector_vault_unavailable', 503);
        }
        const inspected = await vault.inspectRestoreForBot(botId, input.connectorVault, {
          mode: input.mode,
          deploymentKey: input.deploymentKey,
        });
        const configuredIds = input.configuration.credentials.map((row) => row.id).sort();
        if (inspected.credentialIds.join('\0') !== configuredIds.join('\0')) {
          fail('Credential metadata does not match the connector vault', 'bot_recovery_corrupt');
        }
      } else if (input.configuration.credentials.length > 0) {
        fail('Credential metadata requires its connector vault', 'bot_recovery_corrupt');
      }
      const environmentVault = getEnvironmentSecretVault();
      if (input.environmentSecrets) {
        if (!environmentVault || typeof environmentVault.inspectRestoreForBot !== 'function') {
          fail('Environment-secret vault restore is unavailable',
            'bot_recovery_environment_secrets_unavailable', 503);
        }
        const inspected = await environmentVault.inspectRestoreForBot(
          botId,
          input.environmentSecrets,
          { mode: input.mode, deploymentKey: input.deploymentKey },
        );
        const configuredIds = (input.configuration.environmentSecrets ?? [])
          .map((row) => row.id).sort();
        if (inspected.secretIds.join('\0') !== configuredIds.join('\0')) {
          fail('Environment-secret metadata does not match its vault', 'bot_recovery_corrupt');
        }
      } else if ((input.configuration.environmentSecrets ?? []).length > 0) {
        fail('Environment-secret metadata requires its vault', 'bot_recovery_corrupt');
      }
      if (input.browserProfiles) {
        if (typeof browserProfiles?.inspectRestoreForBot !== 'function') {
          fail('Browser profile restore is unavailable', 'bot_recovery_browser_profiles_unavailable', 503);
        }
        await browserProfiles.inspectRestoreForBot(botId, input.browserProfiles, { mode: input.mode });
      }
      return Object.freeze({ botId, keyMatches, objectCount: objects.length });
    } finally {
      currentKey?.fill(0);
      for (const object of objects) object.ciphertext.fill(0);
    }
  };

  const restoreControlPlane = async (principal, configuration, objects) => {
    const revisions = [...configuration.revisions]
      .sort((left, right) => left.revision_number - right.revision_number || left.id.localeCompare(right.id));
    const firstRevision = revisions[0];
    const created = await store.createBot({
      botId: configuration.bot.id,
      revisionId: firstRevision.id,
      name: configuration.bot.name,
      tenancy: configuration.bot.tenancy,
      contract: firstRevision.contract,
      compiledHash: firstRevision.compiled_hash,
      actorId: principal.id,
    });
    let currentBot = created?.bot || await store.repositories.bots.get({ id: configuration.bot.id });
    for (const revision of revisions.slice(1)) {
      await store.insert('bot_revisions', publicWriteRow('bot_revisions', revision, {
        created_by: principal.id,
      }));
    }
    for (const membership of configuration.memberships) {
      const restoredMembership = membership.user_id === principal.id
        ? publicWriteRow('bot_memberships', membership, {
          role: 'manager',
          assigned_by: principal.id,
          revoked_at: null,
        })
        : publicWriteRow('bot_memberships', membership);
      await store.insert('bot_memberships', restoredMembership, {
        onConflict: ['bot_id', 'user_id'],
      });
    }
    const activatedRevisions = revisions
      .filter((revision) => revision.activated_at)
      .sort((left, right) => (
        Date.parse(left.activated_at) - Date.parse(right.activated_at)
        || left.revision_number - right.revision_number
      ));
    for (const revision of activatedRevisions) {
      currentBot = await store.activateRevision({
        botId: configuration.bot.id,
        revisionId: revision.id,
        actorId: principal.id,
      });
    }
    if (configuration.bot.active_revision_id) {
      if (currentBot?.active_revision_id !== configuration.bot.active_revision_id) {
        currentBot = await store.activateRevision({
          botId: configuration.bot.id,
          revisionId: configuration.bot.active_revision_id,
          actorId: principal.id,
        });
      }
      if (configuration.bot.lifecycle !== 'active') {
        currentBot = await store.updateIfRevision('bots', { id: configuration.bot.id }, {
          lifecycle: configuration.bot.lifecycle,
          ...(configuration.bot.lifecycle === 'retired'
            ? { retired_at: new Date().toISOString() }
            : {}),
        }, currentBot.updated_at);
      }
    }
    for (const routine of configuration.routines) {
      const status = routine.status === 'retired'
        ? 'retired'
        : (routine.status === 'draft' ? 'draft' : 'paused');
      await store.insert('bot_routines', publicWriteRow('bot_routines', routine, {
        status,
        next_occurrence_at: routine.next_occurrence_at,
        retired_at: status === 'retired' ? new Date().toISOString() : null,
      }));
    }
    for (const evalCase of configuration.evalCases) {
      await store.insert('bot_eval_cases', publicWriteRow('bot_eval_cases', evalCase));
    }
    const sourceRevisions = new Map();
    for (const source of configuration.librarySources) {
      const createdSource = await store.insert('bot_library_sources', publicWriteRow(
        'bot_library_sources',
        source,
        {
          current_published_version_id: null,
          retired_at: source.retired_at ? new Date().toISOString() : null,
        },
      ));
      sourceRevisions.set(source.id, createdSource.updated_at);
    }
    for (const version of configuration.libraryVersions) {
      await store.insert('bot_library_versions', publicWriteRow('bot_library_versions', version));
    }
    for (const source of configuration.librarySources) {
      if (!source.current_published_version_id) continue;
      await store.updateIfRevision('bot_library_sources', { id: source.id }, {
        current_published_version_id: source.current_published_version_id,
      }, sourceRevisions.get(source.id));
    }
    for (const channel of configuration.channels) {
      await store.insert('bot_channels', publicWriteRow('bot_channels', channel, {
        lifecycle: 'active',
        current_checkpoint_number: 0,
        next_message_sequence: 1,
        summary_envelope: null,
        last_message_at: null,
        archived_at: null,
      }));
    }
    for (const acl of configuration.channelAcl) {
      await store.insert('bot_channel_acl', publicWriteRow('bot_channel_acl', acl), {
        onConflict: ['channel_id', 'user_id'],
      });
    }
    for (const credential of configuration.credentials) {
      await store.insert('bot_credentials', publicWriteRow('bot_credentials', credential, {
        revoked_at: credential.status === 'revoked' ? new Date().toISOString() : null,
      }));
    }
    for (const secret of configuration.environmentSecrets ?? []) {
      await store.insert('bot_environment_secrets', publicWriteRow(
        'bot_environment_secrets',
        secret,
      ));
    }
    for (const { row } of objects) {
      await store.insert('bot_objects', publicWriteRow('bot_objects', row, {
        expires_at: null,
        deleted_at: null,
      }));
    }
    currentBot = await store.updateIfRevision('bots', { id: configuration.bot.id }, {
      name: configuration.bot.name,
      title: configuration.bot.title,
      summary: configuration.bot.summary,
      avatar_fallback: configuration.bot.avatar_fallback,
      avatar_object_id: configuration.bot.avatar_object_id,
    }, currentBot.updated_at);
    for (const skillPackage of configuration.skillPackages ?? []) {
      await store.insert('bot_skill_packages', publicWriteRow('bot_skill_packages', skillPackage));
    }
    for (const mcpBinding of configuration.mcpBindings ?? []) {
      await store.insert('bot_mcp_bindings', publicWriteRow('bot_mcp_bindings', mcpBinding));
    }
    return currentBot;
  };

  const restore = async (input) => {
    await inspectRestore(input);
    const botId = input.manifest.bot.id;
    const validated = validateConfiguration(input.configuration, botId);
    const objects = validateObjects(input.objects, botId, validated.channels);
    const uploadedRows = [];
    let previousKey;
    let keyChanged = false;
    let vaultRestored = false;
    let environmentVaultRestored = false;
    let profilesAttempted = false;
    let controlPlaneAttempted = false;
    try {
      previousKey = await getDeploymentKeyCopy(encryption);
      for (const object of objects) {
        await store.storage.upload(
          object.row.storage_bucket,
          object.row.storage_object_name,
          object.ciphertext,
          {
            contentType: 'application/octet-stream',
            maximumBytes: object.ciphertext.byteLength,
          },
        );
        uploadedRows.push(object.row);
      }
      if (!crypto.timingSafeEqual(previousKey, input.deploymentKey)) {
        if (input.mode !== 'empty' || typeof encryption.installKey !== 'function') {
          fail('Deployment key cannot be installed on this host', 'bot_recovery_key_install_unavailable', 503);
        }
        const replacementKey = Buffer.from(input.deploymentKey);
        try {
          const installed = await encryption.installKey(replacementKey);
          keyChanged = installed?.changed === true;
        } finally {
          replacementKey.fill(0);
        }
      }
      if (input.connectorVault) {
        await getCredentialVault().restoreForBot(botId, input.connectorVault, { mode: input.mode });
        vaultRestored = true;
      }
      if (input.environmentSecrets) {
        await getEnvironmentSecretVault().restoreForBot(
          botId,
          input.environmentSecrets,
          { mode: input.mode },
        );
        environmentVaultRestored = true;
      }
      if (input.browserProfiles) {
        profilesAttempted = true;
        await browserProfiles.restoreForBot(botId, input.browserProfiles, { mode: input.mode });
      }
      controlPlaneAttempted = true;
      await restoreControlPlane(input.principal, input.configuration, objects);
      return Object.freeze({
        botId,
        objectCount: objects.length,
        credentialCount: input.configuration.credentials.length,
        environmentSecretCount: (input.configuration.environmentSecrets ?? []).length,
        browserProfilesRestored: profilesAttempted,
        routinesRestoredPaused: input.configuration.routines
          .filter((routine) => !['draft', 'retired'].includes(routine.status)).length,
      });
    } catch (error) {
      const cleanupFailures = [];
      const cleanup = async (step, operation) => {
        try {
          await operation();
        } catch (cleanupError) {
          cleanupFailures.push({
            step,
            code: typeof cleanupError?.code === 'string'
              ? cleanupError.code.slice(0, 120)
              : 'bot_recovery_cleanup_failed',
          });
        }
      };
      if (controlPlaneAttempted) {
        await cleanup('supabase_rows', () => store.rollbackRestoredBot(botId));
      }
      if (profilesAttempted) {
        await cleanup('browser_profiles', () => browserProfiles.deleteForBot(botId));
      }
      if (vaultRestored) {
        await cleanup('connector_vault', () => getCredentialVault().deleteForBot(botId));
      }
      if (environmentVaultRestored) {
        await cleanup('environment_secrets', () => getEnvironmentSecretVault().deleteBot(botId));
      }
      if (uploadedRows.length > 0) {
        await cleanup('storage_objects', () => deleteStorageNames(store, uploadedRows));
      }
      if (keyChanged && previousKey?.byteLength === 32) {
        const rollbackKey = Buffer.from(previousKey);
        try {
          await cleanup('deployment_key', () => encryption.installKey(rollbackKey));
        } finally {
          rollbackKey.fill(0);
        }
      }
      if (cleanupFailures.length > 0) {
        fail(
          'Recovery restore failed and cleanup is incomplete',
          'bot_recovery_rollback_partial',
          500,
          {
            originalCode: typeof error?.code === 'string'
              ? error.code.slice(0, 120)
              : 'bot_recovery_restore_failed',
            cleanupFailures,
          },
        );
      }
      throw error;
    } finally {
      previousKey?.fill(0);
      for (const object of objects) object.ciphertext.fill(0);
    }
  };

  return Object.freeze({ exportConfiguration, inspectRestore, restore });
}

export function createBotPurgeAdapter({
  store,
  authorization,
  getCredentialVault = () => null,
  getEnvironmentSecrets = () => null,
  dockerProvider,
  getIndexer = () => null,
  getRuntimeStatus = null,
  listIndexDocuments = async () => [],
} = {}) {
  if (!store || !authorization || typeof authorization.requireManager !== 'function'
    || typeof getCredentialVault !== 'function' || typeof getEnvironmentSecrets !== 'function'
    || !dockerProvider
    || typeof getIndexer !== 'function'
    || (getRuntimeStatus !== null && typeof getRuntimeStatus !== 'function')
    || typeof listIndexDocuments !== 'function') {
    throw new TypeError('Bot purge adapter is misconfigured');
  }

  const runtimeSetupRequired = async () => {
    if (typeof getRuntimeStatus !== 'function') return false;
    try {
      const status = await getRuntimeStatus();
      return status?.state === 'setup_required';
    } catch {
      return false;
    }
  };

  const prepare = async (principal, botId) => {
    await authorization.requireManager(principal, botId);
    const bot = await store.repositories.bots.get({ id: botId });
    if (!bot) fail('Bot was not found', 'bot_not_found', 404);
    const [objects, channels, memberships, indexDocuments] = await Promise.all([
      listAll(store.repositories.bot_objects, { bot_id: botId }, MAX_OBJECT_COUNT),
      listAll(store.repositories.bot_channels, { bot_id: botId }),
      listAll(store.repositories.bot_memberships, { bot_id: botId }),
      listIndexDocuments(botId),
    ]);
    const computerTargets = bot.tenancy === 'team'
      ? [{ botId, tenancy: 'team', ownerUserId: principal.id }]
      : memberships.map((membership) => ({
        botId,
        tenancy: 'personalized',
        ownerUserId: membership.user_id,
      }));
    return Object.freeze({
      bot: Object.freeze({
        id: bot.id,
        name: bot.name,
        lifecycle: bot.lifecycle,
        updatedAt: bot.updated_at,
      }),
      snapshot: Object.freeze({
        botId,
        actorId: principal.id,
        storageRows: objects.map((row) => ({
          id: row.id,
          storage_bucket: row.storage_bucket,
          storage_object_name: row.storage_object_name,
        })),
        reasoningTargets: channels.map((channel) => ({ botId, channelId: channel.id })),
        computerTargets,
        indexIdentities: indexDocuments.map((document) => ({
          namespace: document.namespace,
          documentId: document.documentId,
          version: document.version,
        })),
      }),
    });
  };

  const purgeResource = async (resourceId, snapshot) => {
    if (resourceId === 'capability_bindings') {
      const result = await store.purgeResource({
        botId: snapshot.botId,
        resourceId,
        actorId: snapshot.actorId,
      });
      return { detail: `${Number(result?.deletedCount) || 0} Skill and MCP bindings removed` };
    }
    if (resourceId === 'objects') {
      await deleteStorageNames(store, snapshot.storageRows);
      return { detail: `${snapshot.storageRows.length} encrypted Storage objects removed` };
    }
    if (resourceId === 'credentials') {
      const vault = getCredentialVault();
      if (!vault || typeof vault.deleteForBot !== 'function') {
        fail('Bot credential vault is unavailable', 'bot_credential_vault_unavailable', 503);
      }
      const local = await vault.deleteForBot(snapshot.botId);
      const environment = getEnvironmentSecrets();
      const environmentResult = environment && typeof environment.purgeBot === 'function'
        ? await environment.purgeBot(snapshot.botId)
        : { vaultDeletedCount: 0 };
      return {
        detail: `${local.deletedCount} local credential entries and ${environmentResult.vaultDeletedCount} environment secrets removed`,
      };
    }
    if (resourceId === 'browser_profiles') {
      if (!dockerProvider.resetAvailable) {
        fail('Bot browser profile cleanup requires Electron', 'bot_runtime_unsupported_host', 503);
      }
      if (await runtimeSetupRequired()) {
        return { detail: 'Bot runtime is not set up; no browser profiles required cleanup' };
      }
      for (const target of snapshot.computerTargets) {
        await dockerProvider.resetComputer(target, 'profile');
      }
      return { detail: `${snapshot.computerTargets.length} browser profile scopes reset` };
    }
    if (resourceId === 'workspaces') {
      if (!dockerProvider.resetAvailable) {
        fail('Bot workspace cleanup requires Electron', 'bot_runtime_unsupported_host', 503);
      }
      if (await runtimeSetupRequired()) {
        return { detail: 'Bot runtime is not set up; no scoped workspaces required cleanup' };
      }
      for (const target of snapshot.reasoningTargets) {
        await dockerProvider.resetReasoning(target, 'all');
      }
      for (const target of snapshot.computerTargets) {
        await dockerProvider.resetComputer(target, 'scratch');
      }
      if (snapshot.computerTargets[0]) {
        await dockerProvider.resetComputer(snapshot.computerTargets[0], 'shared');
      }
      return {
        detail: `${snapshot.reasoningTargets.length + snapshot.computerTargets.length} scoped workspaces reset`,
      };
    }
    if (resourceId === 'indexes') {
      if (snapshot.indexIdentities.length === 0) {
        return { detail: '0 index records removed' };
      }
      if (await runtimeSetupRequired()) {
        return { detail: 'Bot runtime is not set up; no local retrieval index required cleanup' };
      }
      const indexer = getIndexer();
      if (!indexer || typeof indexer.delete !== 'function') {
        fail('Bot index cleanup is unavailable', 'bot_indexer_unavailable', 503);
      }
      for (const identity of snapshot.indexIdentities) await indexer.delete(identity);
      return { detail: `${snapshot.indexIdentities.length} index records removed` };
    }
    if (['channels', 'shared_memory', 'private_memory'].includes(resourceId)) {
      const result = await store.purgeResource({
        botId: snapshot.botId,
        resourceId,
        actorId: snapshot.actorId,
      });
      const retained = Number(result?.retainedSharedMemoryCount) || 0;
      return {
        detail: resourceId === 'channels'
          ? `${Number(result?.deletedCount) || 0} channels removed; ${retained} shared memories retained`
          : `${Number(result?.deletedCount) || 0} memory records removed`,
      };
    }
    fail('Bot purge resource is unsupported', 'bot_purge_invalid');
  };

  const stopRuntimeContainers = async (snapshot, selectedResourceIds) => {
    const selected = new Set(selectedResourceIds);
    if (await runtimeSetupRequired()) {
      return { detail: 'Bot runtime is not set up; no scoped runtime containers required cleanup' };
    }
    let stopped = 0;
    if (selected.has('workspaces')) {
      for (const target of snapshot.reasoningTargets) {
        await dockerProvider.stopReasoning(target);
        stopped += 1;
      }
    }
    if (selected.has('workspaces') || selected.has('browser_profiles')) {
      for (const target of snapshot.computerTargets) {
        await dockerProvider.stopComputer(target);
        stopped += 1;
      }
    }
    return { detail: `${stopped} scoped runtime containers stopped` };
  };

  const purgeSupabaseRows = async (snapshot, selectedResourceIds, { deleteBot = false } = {}) => {
    if (deleteBot && !await store.repositories.bots.get({ id: snapshot.botId })) {
      return { detail: 'Supabase rows and Bot definition were already removed' };
    }
    const selected = new Set(selectedResourceIds);
    let removed = 0;
    for (const resourceId of ['capability_bindings', 'objects', 'credentials']) {
      if (!selected.has(resourceId)) continue;
      const result = await store.purgeResource({
        botId: snapshot.botId,
        resourceId,
        actorId: snapshot.actorId,
      });
      removed += Number(result?.deletedCount) || 0;
    }
    if (deleteBot) {
      const result = await store.purgeBot({ botId: snapshot.botId, actorId: snapshot.actorId });
      removed += Number(result?.deletedCount) || 0;
      return { detail: `${removed} Supabase rows and the Bot definition removed` };
    }
    return { detail: `${removed} Supabase metadata rows removed; Bot definition retained` };
  };

  return Object.freeze({ prepare, stopRuntimeContainers, purgeResource, purgeSupabaseRows });
}
