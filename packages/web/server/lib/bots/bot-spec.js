import crypto, { randomUUID } from 'node:crypto';

import {
  canonicalizeBotJson,
  hashCanonicalBotJson,
  parseStrictJson,
} from '@openchamber/bots-runtime';

import {
  BOT_COMPILED_CONFIG_VERSION,
  BOT_REVISION_CONTRACT_VERSION,
  validateBotRevisionRuntimeContract,
} from './config-compiler.js';
import { decryptBotJson } from './encryption.js';
import { assertExactObject, validateBoundedString, validateUuid } from './validation.js';

export const BOT_SPEC_API_VERSION = 'devryan.ai/bot-revision/v1';
export const BOT_SPEC_KIND = 'BotRevision';
export const BOT_SPEC_MEDIA_TYPE = 'application/vnd.devryan.bot-revision+json';
export const BOT_SPEC_MAX_BYTES = 512 * 1024;

const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const DEPLOYMENT_KEY_ID = 'deployment-v1';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^ed25519:[0-9a-f]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BINDING_KINDS = Object.freeze([
  'agent_connection',
  'credential',
  'library',
  'mcp',
  'skill',
]);
const OPTIONAL_CONTRACT_FIELDS = Object.freeze([
  'contractVersion',
  'agent',
  'computerPolicy',
  'runtimeTools',
  'skillBindings',
  'mcpBindings',
  'soul',
]);

export class BotSpecError extends Error {
  constructor(message, code = 'bot_spec_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotSpecError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotSpecError(message, code, statusCode, details);
};

const exact = (value, label, required, optional = []) => {
  try {
    assertExactObject(value, { label, required, optional });
  } catch (error) {
    fail(error.message, 'bot_spec_schema_invalid', 400);
  }
  return value;
};

const boundedText = (value, field, maximum = 256) => {
  try {
    return validateBoundedString(value, field, { maximum });
  } catch (error) {
    fail(error.message, 'bot_spec_schema_invalid', 400);
  }
};

const digest = (value, field) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(`${field} is invalid`, 'bot_spec_schema_invalid', 400);
  }
  return value;
};

const safeClone = (value) => structuredClone(value);

const listAll = async (store, tableName, filters = {}, maximum = 5_000) => {
  const rows = [];
  let cursor = null;
  do {
    const page = await store.list(tableName, { filters, cursor, limit: 100 });
    rows.push(...page.items);
    if (rows.length > maximum) {
      fail('Bot specification binding collection is too large', 'bot_spec_limit_exceeded', 413);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
};

const decodeBase64 = (value, field) => {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    fail(`${field} is invalid`, 'bot_spec_signature_invalid', 400);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    bytes.fill(0);
    fail(`${field} is invalid`, 'bot_spec_signature_invalid', 400);
  }
  return bytes;
};

const credentialLogical = (row) => {
  const label = typeof row?.metadata?.label === 'string' && row.metadata.label.trim()
    ? row.metadata.label.trim()
    : row.provider;
  const descriptor = Object.freeze({
    provider: row.provider,
    kind: row.kind,
    scope: row.credential_scope,
    label,
  });
  return Object.freeze({
    logicalKey: `${row.provider}:${row.kind}:${label}`.slice(0, 256),
    portableDigest: hashCanonicalBotJson(descriptor),
  });
};

const mcpLogical = (row) => Object.freeze({
  logicalKey: row.server_name,
  portableDigest: hashCanonicalBotJson({
    descriptorDigest: row.descriptor_digest,
    manifestDigest: row.manifest_digest,
  }),
});

const libraryMetadataAad = (versionId) => `devryan-bot-library-manifest:${versionId}:v1`;

const withEncryptionKey = async (encryption, operation) => {
  let supplied = null;
  let key = null;
  try {
    supplied = await encryption.getKey();
    key = Buffer.from(supplied || []);
    if (key.byteLength !== 32) {
      fail('Bot specification encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
    }
    return await operation(key);
  } finally {
    key?.fill(0);
    if (Buffer.isBuffer(supplied) || supplied instanceof Uint8Array) supplied.fill(0);
  }
};

const libraryLogical = async (encryption, source, version) => {
  let manifest;
  try {
    manifest = await withEncryptionKey(encryption, (key) => decryptBotJson({
      key,
      envelope: version.manifest_envelope,
      expectedKeyId: DEPLOYMENT_KEY_ID,
      associatedData: libraryMetadataAad(version.id),
    }));
  } catch (error) {
    if (error instanceof BotSpecError) throw error;
    fail('A pinned Library manifest failed integrity verification', 'bot_spec_binding_invalid', 409);
  }
  if (!manifest || !Array.isArray(manifest.files)) {
    fail('A pinned Library manifest is invalid', 'bot_spec_binding_invalid', 409);
  }
  const files = manifest.files.map((file) => ({
    relativePath: file.relativePath,
    contentType: file.contentType,
    sha256: file.sha256,
    size: file.size,
    textBytes: file.textBytes,
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const name = typeof source?.descriptor?.name === 'string' && source.descriptor.name.trim()
    ? source.descriptor.name.trim()
    : `library-${Number(version.version_number)}`;
  return Object.freeze({
    logicalKey: `${name}:v${Number(version.version_number)}`.slice(0, 256),
    portableDigest: hashCanonicalBotJson({ version: 1, files }),
  });
};

const portableModel = async (store, botId, model) => {
  const credential = await store.get('bot_credentials', {
    id: model.credentialId,
    bot_id: botId,
  });
  if (!credential || credential.status !== 'active') {
    fail('A model credential binding is unavailable', 'bot_spec_binding_invalid', 409);
  }
  const logical = credentialLogical(credential);
  return Object.freeze({
    providerId: model.providerId,
    modelId: model.modelId,
    credential: Object.freeze({
      key: logical.logicalKey,
      digest: logical.portableDigest,
    }),
    egressHosts: Object.freeze([...model.egressHosts]),
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  });
};

const portableModels = async (store, botId, models) => Object.freeze({
  primary: await portableModel(store, botId, models.primary),
  fallbacks: Object.freeze(await Promise.all(models.fallbacks.map(
    (model) => portableModel(store, botId, model),
  ))),
});

const portableMcpPolicy = (policy, mappings) => {
  if (!policy?.rules || mappings.length === 0) return safeClone(policy);
  const ids = new Map();
  for (const mapping of mappings) {
    for (const tool of mapping.row.tool_manifest || []) {
      const localId = `generated.mcp.${crypto.createHash('sha256')
        .update(`${mapping.row.id}:${tool.name}`).digest('hex').slice(0, 20)}`;
      const portableId = `generated.mcp.${crypto.createHash('sha256')
        .update(`${mapping.logical.logicalKey}:${tool.name}`).digest('hex').slice(0, 20)}`;
      ids.set(localId, portableId);
    }
  }
  return {
    ...safeClone(policy),
    rules: policy.rules.map((rule) => ({ ...safeClone(rule), id: ids.get(rule.id) || rule.id })),
  };
};

const localMcpPolicy = (policy, requirements, resolved) => {
  if (!policy?.rules) return safeClone(policy);
  const ids = new Map();
  for (const requirement of requirements.filter((entry) => entry.kind === 'mcp')) {
    const local = resolved.get(`mcp\0${requirement.logicalKey}`);
    if (!local || local.id === NIL_UUID) continue;
    for (const tool of local.row.tool_manifest || []) {
      const portableId = `generated.mcp.${crypto.createHash('sha256')
        .update(`${requirement.logicalKey}:${tool.name}`).digest('hex').slice(0, 20)}`;
      const localId = `generated.mcp.${crypto.createHash('sha256')
        .update(`${local.id}:${tool.name}`).digest('hex').slice(0, 20)}`;
      ids.set(portableId, localId);
    }
  }
  return {
    ...safeClone(policy),
    rules: policy.rules.map((rule) => ({ ...safeClone(rule), id: ids.get(rule.id) || rule.id })),
  };
};

const bindingEntry = (kind, key, portableDigest) => Object.freeze({
  kind,
  logicalKey: key,
  portableDigest,
});

const collectRequirements = (spec) => {
  const requirements = [];
  const addModel = (model) => requirements.push(bindingEntry(
    'credential',
    model.credential.key,
    model.credential.digest,
  ));
  if (spec.reasoning.adapter.kind === 'ag_ui') {
    requirements.push(bindingEntry(
      'agent_connection',
      spec.reasoning.adapter.connection.key,
      spec.reasoning.adapter.connection.digest,
    ));
  } else {
    addModel(spec.reasoning.adapter.models.primary);
    for (const model of spec.reasoning.adapter.models.fallbacks) addModel(model);
  }
  for (const entry of spec.bindings.skills) {
    requirements.push(bindingEntry('skill', entry.key, entry.digest));
  }
  for (const entry of spec.bindings.mcp) {
    requirements.push(bindingEntry(
      'mcp',
      entry.key,
      hashCanonicalBotJson({
        descriptorDigest: entry.descriptorDigest,
        manifestDigest: entry.manifestDigest,
      }),
    ));
  }
  for (const entry of spec.bindings.library) {
    requirements.push(bindingEntry('library', entry.key, entry.digest));
  }
  const unique = new Map();
  for (const requirement of requirements) {
    const id = `${requirement.kind}\0${requirement.logicalKey}`;
    const existing = unique.get(id);
    if (existing && existing.portableDigest !== requirement.portableDigest) {
      fail('A portable binding key has conflicting digests', 'bot_spec_schema_invalid', 400);
    }
    unique.set(id, requirement);
  }
  return Object.freeze([...unique.values()].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.logicalKey.localeCompare(right.logicalKey)
  )));
};

const validatePortableModel = (value, field) => {
  exact(value, field, ['credential', 'egressHosts', 'modelId', 'providerId'], ['variant']);
  exact(value.credential, `${field}.credential`, ['digest', 'key']);
  boundedText(value.providerId, `${field}.providerId`);
  boundedText(value.modelId, `${field}.modelId`);
  boundedText(value.credential.key, `${field}.credential.key`);
  digest(value.credential.digest, `${field}.credential.digest`);
  if (!Array.isArray(value.egressHosts) || value.egressHosts.length < 1
    || value.egressHosts.length > 32
    || value.egressHosts.some((host) => typeof host !== 'string' || host.length > 2_048)) {
    fail(`${field}.egressHosts is invalid`, 'bot_spec_schema_invalid', 400);
  }
  if (value.variant !== undefined) boundedText(value.variant, `${field}.variant`);
};

const validatePortableSpec = (spec) => {
  exact(spec, 'Bot portable spec', [
    'bindings',
    'browserPolicy',
    'compatibility',
    'computerPolicy',
    'egressHosts',
    'identity',
    'instructions',
    'memory',
    'policy',
    'reasoning',
    'soul',
    'tools',
  ]);
  exact(spec.identity, 'Bot portable identity', ['name', 'summary', 'title'], [
    'contractAvatar',
    'contractTitle',
  ]);
  boundedText(spec.identity.name, 'spec.identity.name', 120);
  boundedText(spec.identity.title, 'spec.identity.title', 160);
  if (typeof spec.identity.summary !== 'string' || spec.identity.summary.length > 500) {
    fail('spec.identity.summary is invalid', 'bot_spec_schema_invalid', 400);
  }
  if (spec.identity.contractTitle !== undefined
    && (typeof spec.identity.contractTitle !== 'string' || spec.identity.contractTitle.length > 512)) {
    fail('spec.identity.contractTitle is invalid', 'bot_spec_schema_invalid', 400);
  }
  if (spec.identity.contractAvatar !== undefined
    && (typeof spec.identity.contractAvatar !== 'string' || spec.identity.contractAvatar.length > 512)) {
    fail('spec.identity.contractAvatar is invalid', 'bot_spec_schema_invalid', 400);
  }
  if (typeof spec.soul !== 'string' || Buffer.byteLength(spec.soul, 'utf8') > 16 * 1024) {
    fail('spec.soul is invalid', 'bot_spec_schema_invalid', 400);
  }
  if (!Array.isArray(spec.egressHosts) || spec.egressHosts.length > 256
    || spec.egressHosts.some((host) => typeof host !== 'string' || host.length > 2_048)
    || new Set(spec.egressHosts).size !== spec.egressHosts.length) {
    fail('spec.egressHosts is invalid', 'bot_spec_schema_invalid', 400);
  }
  exact(spec.instructions, 'Bot portable instructions', [
    'advanced',
    'objectives',
    'operating',
    'prohibited',
    'standingRole',
    'tone',
  ]);
  if (!Array.isArray(spec.instructions.objectives) || spec.instructions.objectives.length > 32
    || [
      spec.instructions.advanced,
      spec.instructions.operating,
      spec.instructions.prohibited,
      spec.instructions.standingRole,
      spec.instructions.tone,
    ].some((entry) => typeof entry !== 'string')) {
    fail('spec.instructions is invalid', 'bot_spec_schema_invalid', 400);
  }
  exact(spec.reasoning, 'Bot portable reasoning', ['adapter', 'config']);
  if (!spec.reasoning.config || typeof spec.reasoning.config !== 'object'
    || Array.isArray(spec.reasoning.config)) {
    fail('spec.reasoning.config is invalid', 'bot_spec_schema_invalid', 400);
  }
  if (spec.reasoning.adapter?.kind === 'ag_ui') {
    exact(spec.reasoning.adapter, 'Bot portable AG-UI adapter', ['connection', 'kind'], ['modelHint']);
    exact(spec.reasoning.adapter.connection, 'Bot portable AG-UI connection', ['digest', 'key']);
    boundedText(spec.reasoning.adapter.connection.key, 'spec.reasoning.adapter.connection.key');
    digest(spec.reasoning.adapter.connection.digest, 'spec.reasoning.adapter.connection.digest');
    if (spec.reasoning.adapter.modelHint !== undefined) {
      boundedText(spec.reasoning.adapter.modelHint, 'spec.reasoning.adapter.modelHint');
    }
  } else if (spec.reasoning.adapter?.kind === 'opencode') {
    exact(spec.reasoning.adapter, 'Bot portable OpenCode adapter', ['kind', 'models']);
    exact(spec.reasoning.adapter.models, 'Bot portable models', ['fallbacks', 'primary']);
    validatePortableModel(spec.reasoning.adapter.models.primary, 'spec.reasoning.adapter.models.primary');
    if (!Array.isArray(spec.reasoning.adapter.models.fallbacks)
      || spec.reasoning.adapter.models.fallbacks.length > 8) {
      fail('spec.reasoning.adapter.models.fallbacks is invalid', 'bot_spec_schema_invalid', 400);
    }
    spec.reasoning.adapter.models.fallbacks.forEach((model, index) => (
      validatePortableModel(model, `spec.reasoning.adapter.models.fallbacks[${index}]`)
    ));
  } else {
    fail('spec.reasoning.adapter.kind is invalid', 'bot_spec_schema_invalid', 400);
  }
  exact(spec.tools, 'Bot portable tools', ['file', 'gatewayPluginVersion', 'runtime']);
  if (!Array.isArray(spec.tools.file) || (spec.tools.runtime !== null
    && !Array.isArray(spec.tools.runtime))) {
    fail('spec.tools is invalid', 'bot_spec_schema_invalid', 400);
  }
  boundedText(spec.tools.gatewayPluginVersion, 'spec.tools.gatewayPluginVersion');
  exact(spec.bindings, 'Bot portable bindings', ['library', 'mcp', 'skills']);
  if (!Array.isArray(spec.bindings.skills) || spec.bindings.skills.length > 128
    || !Array.isArray(spec.bindings.mcp) || spec.bindings.mcp.length > 64
    || !Array.isArray(spec.bindings.library) || spec.bindings.library.length > 1_000) {
    fail('spec.bindings is invalid', 'bot_spec_schema_invalid', 400);
  }
  spec.bindings.skills.forEach((entry, index) => {
    exact(entry, `spec.bindings.skills[${index}]`, ['digest', 'key']);
    boundedText(entry.key, `spec.bindings.skills[${index}].key`);
    digest(entry.digest, `spec.bindings.skills[${index}].digest`);
  });
  spec.bindings.mcp.forEach((entry, index) => {
    exact(entry, `spec.bindings.mcp[${index}]`, ['descriptorDigest', 'key', 'manifestDigest']);
    boundedText(entry.key, `spec.bindings.mcp[${index}].key`);
    digest(entry.descriptorDigest, `spec.bindings.mcp[${index}].descriptorDigest`);
    digest(entry.manifestDigest, `spec.bindings.mcp[${index}].manifestDigest`);
  });
  spec.bindings.library.forEach((entry, index) => {
    exact(entry, `spec.bindings.library[${index}]`, ['digest', 'key']);
    boundedText(entry.key, `spec.bindings.library[${index}].key`);
    digest(entry.digest, `spec.bindings.library[${index}].digest`);
  });
  exact(spec.compatibility, 'Bot portable compatibility', ['contractVersion', 'optionalFields']);
  if (!Number.isInteger(spec.compatibility.contractVersion)
    || ![1, BOT_REVISION_CONTRACT_VERSION].includes(spec.compatibility.contractVersion)
    || !Array.isArray(spec.compatibility.optionalFields)
    || spec.compatibility.optionalFields.some((field) => !OPTIONAL_CONTRACT_FIELDS.includes(field))) {
    fail('spec.compatibility is invalid', 'bot_spec_schema_invalid', 400);
  }
  for (const field of ['browserPolicy', 'computerPolicy', 'memory', 'policy']) {
    if (!spec[field] || typeof spec[field] !== 'object' || Array.isArray(spec[field])) {
      fail(`spec.${field} is invalid`, 'bot_spec_schema_invalid', 400);
    }
  }
  collectRequirements(spec);
  return spec;
};

const unsignedDocument = (document) => ({
  apiVersion: document.apiVersion,
  kind: document.kind,
  metadata: safeClone(document.metadata),
  spec: safeClone(document.spec),
  integrity: {
    specHash: document.integrity.specHash,
    compiledHash: document.integrity.compiledHash,
    compilerVersion: document.integrity.compilerVersion,
    signerKeyId: document.integrity.signerKeyId,
    signerPublicKey: document.integrity.signerPublicKey,
  },
});

const parseDocument = (source) => {
  let document;
  try {
    document = parseStrictJson(source, {
      maximumBytes: BOT_SPEC_MAX_BYTES,
      maximumDepth: 32,
      maximumNodes: 100_000,
    });
  } catch (error) {
    fail(error.message, error.code || 'bot_spec_json_invalid', 400);
  }
  exact(document, 'Bot specification', ['apiVersion', 'integrity', 'kind', 'metadata', 'spec']);
  if (document.apiVersion !== BOT_SPEC_API_VERSION || document.kind !== BOT_SPEC_KIND) {
    fail('Bot specification version or kind is unsupported', 'bot_spec_version_unsupported', 400);
  }
  exact(document.metadata, 'Bot specification metadata', ['name', 'revision']);
  boundedText(document.metadata.name, 'metadata.name', 120);
  if (!Number.isSafeInteger(document.metadata.revision) || document.metadata.revision < 1) {
    fail('metadata.revision is invalid', 'bot_spec_schema_invalid', 400);
  }
  validatePortableSpec(document.spec);
  exact(document.integrity, 'Bot specification integrity', [
    'compiledHash',
    'compilerVersion',
    'signature',
    'signerKeyId',
    'signerPublicKey',
    'specHash',
  ]);
  digest(document.integrity.specHash, 'integrity.specHash');
  digest(document.integrity.compiledHash, 'integrity.compiledHash');
  if (!Number.isSafeInteger(document.integrity.compilerVersion)
    || document.integrity.compilerVersion < 1) {
    fail('integrity.compilerVersion is invalid', 'bot_spec_schema_invalid', 400);
  }
  if (typeof document.integrity.signerKeyId !== 'string'
    || !KEY_ID_PATTERN.test(document.integrity.signerKeyId)) {
    fail('integrity.signerKeyId is invalid', 'bot_spec_signature_invalid', 400);
  }
  if (hashCanonicalBotJson(document.spec) !== document.integrity.specHash) {
    fail('Bot specification hash does not match its content', 'bot_spec_tampered', 400);
  }
  const publicKeyBytes = decodeBase64(
    document.integrity.signerPublicKey,
    'integrity.signerPublicKey',
  );
  const signatureBytes = decodeBase64(document.integrity.signature, 'integrity.signature');
  try {
    const expectedKeyId = `ed25519:${crypto.createHash('sha256').update(publicKeyBytes).digest('hex')}`;
    const publicKey = crypto.createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
    const payload = Buffer.from(canonicalizeBotJson(unsignedDocument(document)), 'utf8');
    if (publicKey.asymmetricKeyType !== 'ed25519'
      || expectedKeyId !== document.integrity.signerKeyId
      || !crypto.verify(null, payload, publicKey, signatureBytes)) {
      fail('Bot specification signature is invalid', 'bot_spec_signature_invalid', 400);
    }
  } catch (error) {
    if (error instanceof BotSpecError) throw error;
    fail('Bot specification signature is invalid', 'bot_spec_signature_invalid', 400);
  } finally {
    publicKeyBytes.fill(0);
    signatureBytes.fill(0);
  }
  return document;
};

const prettyDocument = (document) => (
  `${JSON.stringify(JSON.parse(canonicalizeBotJson(document)), null, 2)}\n`
);

const slug = (value) => {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 80);
  return normalized || 'bot';
};

const validateSignerIdentity = (keyId, publicKeyValue) => {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    fail('Signer key ID is invalid', 'bot_spec_signature_invalid', 400);
  }
  const bytes = decodeBase64(publicKeyValue, 'signerPublicKey');
  try {
    const key = crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const actual = `ed25519:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (key.asymmetricKeyType !== 'ed25519' || actual !== keyId) {
      fail('Signer identity is invalid', 'bot_spec_signature_invalid', 400);
    }
  } catch (error) {
    if (error instanceof BotSpecError) throw error;
    fail('Signer identity is invalid', 'bot_spec_signature_invalid', 400);
  } finally {
    bytes.fill(0);
  }
};

const publicTrust = (row) => Object.freeze({
  id: row.id,
  scope: row.scope,
  botId: row.bot_id,
  signerKeyId: row.signer_key_id,
  signerPublicKey: row.signer_public_key,
  status: row.status,
  trustedAt: row.trusted_at,
  updatedAt: row.updated_at,
  revokedAt: row.revoked_at,
});

const trustStatus = async (store, botId, integrity) => {
  const [globalRows, botRows] = await Promise.all([
    listAll(store, 'bot_signer_trust', { scope: 'global' }, 1_000),
    botId
      ? listAll(store, 'bot_signer_trust', { scope: 'bot', bot_id: botId }, 1_000)
      : [],
  ]);
  const matches = [...globalRows, ...botRows].filter(
    (row) => row.signer_key_id === integrity.signerKeyId,
  );
  if (matches.some((row) => row.signer_public_key !== integrity.signerPublicKey)) {
    fail('Signer key identity conflicts with the trust store', 'bot_spec_signer_conflict', 409);
  }
  if (matches.some((row) => row.status === 'revoked')) {
    fail('Bot specification signer is revoked', 'bot_spec_signer_revoked', 409);
  }
  return matches.some((row) => row.status === 'trusted') ? 'trusted' : 'unknown';
};

const buildBindingCatalog = async ({ store, encryption, botId }) => {
  const [credentials, agents, skills, mcpRows, sources, versions] = await Promise.all([
    listAll(store, 'bot_credentials', { bot_id: botId }, 5_000),
    listAll(store, 'bot_agent_connections', { bot_id: botId }, 1_000),
    listAll(store, 'bot_skill_packages', { bot_id: botId }, 1_000),
    listAll(store, 'bot_mcp_bindings', { bot_id: botId }, 1_000),
    listAll(store, 'bot_library_sources', { bot_id: botId }, 2_000),
    listAll(store, 'bot_library_versions', {}, 5_000),
  ]);
  const candidates = [];
  for (const row of credentials) {
    if (row.status !== 'active') continue;
    const logical = credentialLogical(row);
    candidates.push({
      kind: 'credential', id: row.id, row, label: logical.logicalKey, ...logical,
    });
  }
  for (const row of agents) {
    if (row.status === 'revoked' || row.revoked_at) continue;
    candidates.push({
      kind: 'agent_connection',
      id: row.id,
      row,
      label: row.name,
      logicalKey: row.name,
      portableDigest: row.descriptor_digest,
    });
  }
  for (const row of skills) {
    candidates.push({
      kind: 'skill',
      id: row.id,
      row,
      label: row.skill_name,
      logicalKey: row.skill_name,
      portableDigest: row.package_digest,
    });
  }
  for (const row of mcpRows) {
    const logical = mcpLogical(row);
    candidates.push({ kind: 'mcp', id: row.id, row, label: row.server_name, ...logical });
  }
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  for (const row of versions) {
    const source = sourceMap.get(row.source_id);
    if (!source || source.retired_at) continue;
    const logical = await libraryLogical(encryption, source, row);
    candidates.push({ kind: 'library', id: row.id, row, label: logical.logicalKey, ...logical });
  }
  return Object.freeze(candidates);
};

const publicCandidate = (candidate) => Object.freeze({
  id: candidate.id,
  label: candidate.label,
  digest: candidate.portableDigest,
  exact: true,
});

const candidatesFor = (requirements, catalog) => requirements.map((requirement) => {
  const matches = catalog.filter((candidate) => (
    candidate.kind === requirement.kind
      && candidate.portableDigest === requirement.portableDigest
  ));
  return Object.freeze({
    ...requirement,
    candidates: Object.freeze(matches.map(publicCandidate)),
  });
});

const normalizeMappings = (value) => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 2_000) {
    fail('Bot import mappings are invalid', 'bot_spec_mapping_invalid', 400);
  }
  const seen = new Set();
  return Object.freeze(value.map((mapping, index) => {
    exact(mapping, `Bot import mapping ${index}`, ['kind', 'localResourceId', 'logicalKey']);
    if (!BINDING_KINDS.includes(mapping.kind)) {
      fail(`Bot import mapping ${index}.kind is invalid`, 'bot_spec_mapping_invalid', 400);
    }
    const logicalKey = boundedText(mapping.logicalKey, `mappings[${index}].logicalKey`);
    const id = `${mapping.kind}\0${logicalKey}`;
    if (seen.has(id)) fail('Bot import mappings contain duplicates', 'bot_spec_mapping_invalid', 400);
    seen.add(id);
    return Object.freeze({
      kind: mapping.kind,
      logicalKey,
      localResourceId: validateUuid(mapping.localResourceId, `mappings[${index}].localResourceId`),
    });
  }));
};

const resolveMappings = (requirements, mappings, catalog) => {
  const mappingMap = new Map(mappings.map((mapping) => [
    `${mapping.kind}\0${mapping.logicalKey}`,
    mapping,
  ]));
  const resolved = new Map();
  for (const requirement of requirements) {
    const key = `${requirement.kind}\0${requirement.logicalKey}`;
    const mapping = mappingMap.get(key);
    if (!mapping) {
      resolved.set(key, Object.freeze({ id: NIL_UUID, row: null, requirement }));
      continue;
    }
    const candidate = catalog.find((entry) => (
      entry.kind === requirement.kind
      && entry.id === mapping.localResourceId
      && entry.portableDigest === requirement.portableDigest
    ));
    if (!candidate) {
      fail('A Bot import mapping does not match the portable digest', 'bot_spec_mapping_mismatch', 409, {
        kind: requirement.kind,
        logicalKey: requirement.logicalKey,
      });
    }
    resolved.set(key, Object.freeze({ id: candidate.id, row: candidate.row, requirement }));
  }
  for (const key of mappingMap.keys()) {
    if (!resolved.has(key)) {
      fail('A Bot import mapping is not required by this specification', 'bot_spec_mapping_invalid', 400);
    }
  }
  return resolved;
};

const localModel = (model, resolved) => ({
  providerId: model.providerId,
  modelId: model.modelId,
  credentialId: resolved.get(`credential\0${model.credential.key}`)?.id || NIL_UUID,
  egressHosts: [...model.egressHosts],
  ...(model.variant === undefined ? {} : { variant: model.variant }),
});

const contractFromSpec = (spec, requirements, resolved) => {
  const optional = new Set(spec.compatibility.optionalFields);
  const legacy = spec.compatibility.contractVersion === 1;
  const adapter = spec.reasoning.adapter;
  const contract = {
    identity: {
      title: spec.identity.contractTitle || '',
      avatar: spec.identity.contractAvatar || '',
    },
    objectives: [...spec.instructions.objectives],
    tone: spec.instructions.tone,
    operatingInstructions: spec.instructions.operating,
    prohibitedInstructions: spec.instructions.prohibited,
    advancedPrompt: spec.instructions.advanced,
    tenancy: 'team',
    standingRole: spec.instructions.standingRole,
    reasoning: safeClone(spec.reasoning.config),
    fileTools: [...spec.tools.file],
    gatewayPluginVersion: spec.tools.gatewayPluginVersion,
    libraryVersionIds: spec.bindings.library.map((entry) => (
      resolved.get(`library\0${entry.key}`)?.id || NIL_UUID
    )).sort(),
    memoryPolicy: safeClone(spec.memory),
    actionPolicy: localMcpPolicy(spec.policy, requirements, resolved),
    browserPolicy: safeClone(spec.browserPolicy),
  };
  if (legacy) {
    contract.models = {
      primary: localModel(adapter.models.primary, resolved),
      fallbacks: adapter.models.fallbacks.map((model) => localModel(model, resolved)),
    };
  } else {
    contract.contractVersion = BOT_REVISION_CONTRACT_VERSION;
    contract.agent = adapter.kind === 'ag_ui'
      ? {
          kind: 'ag_ui',
          connectionRef: resolved.get(`agent_connection\0${adapter.connection.key}`)?.id || NIL_UUID,
          connectionDigest: adapter.connection.digest,
          ...(adapter.modelHint === undefined ? {} : { modelHint: adapter.modelHint }),
        }
      : {
          kind: 'opencode',
          models: {
            primary: localModel(adapter.models.primary, resolved),
            fallbacks: adapter.models.fallbacks.map((model) => localModel(model, resolved)),
          },
        };
    contract.computerPolicy = safeClone(spec.computerPolicy);
  }
  if (optional.has('runtimeTools')) contract.runtimeTools = [...(spec.tools.runtime || [])];
  if (optional.has('soul')) contract.soul = spec.soul;
  if (optional.has('skillBindings')) {
    contract.skillBindings = spec.bindings.skills.map((entry) => ({
      id: resolved.get(`skill\0${entry.key}`)?.id || NIL_UUID,
      digest: entry.digest,
    })).sort((left, right) => left.id.localeCompare(right.id));
  }
  if (optional.has('mcpBindings')) {
    contract.mcpBindings = spec.bindings.mcp.map((entry) => ({
      id: resolved.get(`mcp\0${entry.key}`)?.id || NIL_UUID,
      descriptorDigest: entry.descriptorDigest,
      manifestDigest: entry.manifestDigest,
    })).sort((left, right) => left.id.localeCompare(right.id));
  }
  try {
    return validateBotRevisionRuntimeContract(contract);
  } catch (error) {
    fail(error.message, error.code || 'bot_spec_contract_invalid', 400);
  }
};

const buildPortableSpec = async ({ store, encryption, bot, revision }) => {
  let contract;
  try {
    contract = validateBotRevisionRuntimeContract(revision.contract);
  } catch (error) {
    fail(error.message, error.code || 'bot_spec_contract_invalid', 409);
  }
  if (hashCanonicalBotJson(contract) !== revision.compiled_hash) {
    fail('Bot revision compiled hash does not match its contract', 'bot_spec_compiled_hash_mismatch', 409);
  }
  const skillRows = await Promise.all((contract.skillBindings || []).map(async (binding) => {
    const row = await store.get('bot_skill_packages', { id: binding.id, bot_id: bot.id });
    if (!row || row.package_digest !== binding.digest) {
      fail('A pinned Skill binding is unavailable', 'bot_spec_binding_invalid', 409);
    }
    return row;
  }));
  const mcpRows = await Promise.all((contract.mcpBindings || []).map(async (binding) => {
    const row = await store.get('bot_mcp_bindings', { id: binding.id, bot_id: bot.id });
    if (!row || row.descriptor_digest !== binding.descriptorDigest
      || row.manifest_digest !== binding.manifestDigest) {
      fail('A pinned MCP binding is unavailable', 'bot_spec_binding_invalid', 409);
    }
    return row;
  }));
  const mcpMappings = mcpRows.map((row) => ({ row, logical: mcpLogical(row) }));
  const libraryBindings = [];
  for (const versionId of contract.libraryVersionIds) {
    const version = await store.get('bot_library_versions', { id: versionId });
    const source = version
      ? await store.get('bot_library_sources', { id: version.source_id, bot_id: bot.id })
      : null;
    if (!version || !source || source.retired_at) {
      fail('A pinned Library binding is unavailable', 'bot_spec_binding_invalid', 409);
    }
    libraryBindings.push(await libraryLogical(encryption, source, version));
  }

  let adapter;
  let egressHosts = [];
  if (contract.agent?.kind === 'ag_ui') {
    const connection = await store.get('bot_agent_connections', {
      id: contract.agent.connectionRef,
      bot_id: bot.id,
    });
    if (!connection || connection.descriptor_digest !== contract.agent.connectionDigest
      || connection.status === 'revoked') {
      fail('The pinned AG-UI connection is unavailable', 'bot_spec_binding_invalid', 409);
    }
    adapter = Object.freeze({
      kind: 'ag_ui',
      connection: Object.freeze({ key: connection.name, digest: connection.descriptor_digest }),
      ...(contract.agent.modelHint === undefined ? {} : { modelHint: contract.agent.modelHint }),
    });
  } else {
    const models = await portableModels(
      store,
      bot.id,
      contract.agent?.kind === 'opencode' ? contract.agent.models : contract.models,
    );
    adapter = Object.freeze({ kind: 'opencode', models });
    egressHosts = [...new Set([
      ...models.primary.egressHosts,
      ...models.fallbacks.flatMap((model) => model.egressHosts),
    ])].sort();
  }
  const optionalFields = OPTIONAL_CONTRACT_FIELDS.filter((field) => Object.hasOwn(contract, field));
  const spec = Object.freeze({
    identity: Object.freeze({
      name: bot.name,
      title: bot.title || bot.name,
      summary: bot.summary || '',
      contractTitle: contract.identity.title,
      contractAvatar: contract.identity.avatar,
    }),
    soul: contract.soul || '',
    instructions: Object.freeze({
      standingRole: contract.standingRole,
      objectives: Object.freeze([...contract.objectives]),
      tone: contract.tone,
      operating: contract.operatingInstructions,
      prohibited: contract.prohibitedInstructions,
      advanced: contract.advancedPrompt,
    }),
    reasoning: Object.freeze({ adapter, config: safeClone(contract.reasoning) }),
    egressHosts: Object.freeze(egressHosts),
    tools: Object.freeze({
      file: Object.freeze([...contract.fileTools]),
      runtime: Object.hasOwn(contract, 'runtimeTools')
        ? Object.freeze([...contract.runtimeTools])
        : null,
      gatewayPluginVersion: contract.gatewayPluginVersion,
    }),
    policy: portableMcpPolicy(contract.actionPolicy, mcpMappings),
    browserPolicy: safeClone(contract.browserPolicy),
    computerPolicy: safeClone(contract.computerPolicy || { isolationTier: 'standard' }),
    memory: safeClone(contract.memoryPolicy),
    bindings: Object.freeze({
      skills: Object.freeze(skillRows.map((row) => Object.freeze({
        key: row.skill_name,
        digest: row.package_digest,
      })).sort((left, right) => left.key.localeCompare(right.key))),
      mcp: Object.freeze(mcpRows.map((row) => Object.freeze({
        key: row.server_name,
        descriptorDigest: row.descriptor_digest,
        manifestDigest: row.manifest_digest,
      })).sort((left, right) => left.key.localeCompare(right.key))),
      library: Object.freeze(libraryBindings.map((entry) => Object.freeze({
        key: entry.logicalKey,
        digest: entry.portableDigest,
      })).sort((left, right) => left.key.localeCompare(right.key))),
    }),
    compatibility: Object.freeze({
      contractVersion: contract.contractVersion || 1,
      optionalFields: Object.freeze(optionalFields),
    }),
  });
  validatePortableSpec(spec);
  return spec;
};

const insertSignatureIfMissing = async ({ store, uuid, revision, document, principal }) => {
  const existing = await listAll(store, 'bot_revision_signatures', {
    revision_id: revision.id,
  }, 1_000);
  const match = existing.find((row) => (
    row.spec_hash === document.integrity.specHash
    && row.signer_key_id === document.integrity.signerKeyId
  ));
  if (match) {
    if (match.signature !== document.integrity.signature
      || match.signer_public_key !== document.integrity.signerPublicKey
      || match.compiled_hash !== document.integrity.compiledHash) {
      fail('Stored Bot revision signature conflicts with the export', 'bot_spec_signature_conflict', 409);
    }
    return match;
  }
  return store.insert('bot_revision_signatures', {
    id: uuid(),
    revision_id: revision.id,
    spec_hash: document.integrity.specHash,
    compiled_hash: document.integrity.compiledHash,
    compiler_version: document.integrity.compilerVersion,
    signer_key_id: document.integrity.signerKeyId,
    signer_public_key: document.integrity.signerPublicKey,
    signature: document.integrity.signature,
    created_by: validateUuid(principal.id, 'principal.id'),
  });
};

const publicImportRequirement = (entry) => Object.freeze({
  kind: entry.kind,
  logicalKey: entry.logicalKey,
  portableDigest: entry.portableDigest,
  candidates: entry.candidates,
});

export function createBotSpecService({
  store,
  authorization,
  management,
  encryption,
  signer,
  audit = async () => {},
  isGlobalAdmin = () => false,
  uuid = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.attachRevisionSpec !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || !management || typeof management.createImportedDraft !== 'function'
    || typeof management.updateImportedDraftBindings !== 'function'
    || typeof encryption?.getKey !== 'function'
    || !signer || typeof signer.identity !== 'function' || typeof signer.sign !== 'function'
    || typeof audit !== 'function' || typeof isGlobalAdmin !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function') {
    throw new TypeError('Bot specification service is misconfigured');
  }

  const requirePrincipal = (principal) => {
    if (!principal?.id) fail('Authentication required', 'bot_authentication_required', 401);
    return principal;
  };

  const requireBot = async (principal, botId) => {
    requirePrincipal(principal);
    const id = validateUuid(botId, 'botId');
    await authorization.requireManager(principal, id);
    const bot = await store.get('bots', { id });
    if (!bot) fail('Bot not found', 'bot_not_found', 404);
    return bot;
  };

  const targetContext = async (principal, { botId = null, newBotName = null } = {}) => {
    requirePrincipal(principal);
    if ((botId === null) === (newBotName === null)) {
      fail('Choose exactly one existing or new Bot import target', 'bot_spec_target_invalid', 400);
    }
    if (botId) return Object.freeze({ bot: await requireBot(principal, botId), newBotName: null });
    if (!isGlobalAdmin(principal)) {
      fail('Global administrator access is required to create a Bot', 'bot_global_admin_required', 403);
    }
    return Object.freeze({
      bot: null,
      newBotName: boundedText(newBotName, 'newBotName', 120),
    });
  };

  const inspectImport = async (principal, request, { requireAcknowledgement = false } = {}) => {
    exact(request, 'Bot specification import', ['source'], [
      'acknowledgeUnknownSigner',
      'botId',
      'mappings',
      'newBotName',
    ]);
    const target = await targetContext(principal, {
      botId: request.botId ?? null,
      newBotName: request.newBotName ?? null,
    });
    const document = parseDocument(request.source);
    const signerStatus = await trustStatus(store, target.bot?.id || null, document.integrity);
    if (requireAcknowledgement && signerStatus === 'unknown'
      && request.acknowledgeUnknownSigner !== true) {
      fail(
        'Explicit acknowledgement is required for this valid unknown signer',
        'bot_spec_signer_acknowledgement_required',
        409,
      );
    }
    const requirements = collectRequirements(document.spec);
    const unresolved = new Map(requirements.map((requirement) => [
      `${requirement.kind}\0${requirement.logicalKey}`,
      Object.freeze({ id: NIL_UUID, row: null, requirement }),
    ]));
    // Reconstruct once during preview so nested policy/compiler schemas are
    // validated before the user is shown a mapping decision.
    contractFromSpec(document.spec, requirements, unresolved);
    const catalog = target.bot
      ? await buildBindingCatalog({ store, encryption, botId: target.bot.id })
      : Object.freeze([]);
    const withCandidates = candidatesFor(requirements, catalog);
    return Object.freeze({
      target,
      document,
      signerStatus,
      requirements,
      catalog,
      withCandidates,
      mappings: normalizeMappings(request.mappings),
    });
  };

  return Object.freeze({
    async exportRevision(principal, botId, revisionId) {
      const bot = await requireBot(principal, botId);
      const revision = await store.get('bot_revisions', {
        id: validateUuid(revisionId, 'revisionId'),
        bot_id: bot.id,
      });
      if (!revision) fail('Bot revision not found', 'bot_revision_not_found', 404);
      if (!revision.activated_at) {
        fail('Only published Bot revisions can be exported', 'bot_spec_revision_unpublished', 409);
      }
      const spec = await buildPortableSpec({ store, encryption, bot, revision });
      const specHash = hashCanonicalBotJson(spec);
      if (revision.portable_spec && (revision.spec_hash !== specHash
        || canonicalizeBotJson(revision.portable_spec) !== canonicalizeBotJson(spec))) {
        fail('Stored portable specification conflicts with the active revision', 'bot_spec_immutable_conflict', 409);
      }
      const attached = revision.portable_spec ? revision : await store.attachRevisionSpec({
        revisionId: revision.id,
        portableSpec: spec,
        specHash,
        compiledHash: revision.compiled_hash,
      });
      const identity = await signer.identity();
      const unsigned = {
        apiVersion: BOT_SPEC_API_VERSION,
        kind: BOT_SPEC_KIND,
        metadata: { name: bot.name, revision: Number(revision.revision_number) },
        spec,
        integrity: {
          specHash,
          compiledHash: revision.compiled_hash,
          compilerVersion: BOT_COMPILED_CONFIG_VERSION,
          signerKeyId: identity.keyId,
          signerPublicKey: identity.publicKey,
        },
      };
      const signed = await signer.sign(Buffer.from(canonicalizeBotJson(unsigned), 'utf8'));
      const document = {
        ...unsigned,
        integrity: { ...unsigned.integrity, signature: signed.signature },
      };
      const source = prettyDocument(document);
      if (Buffer.byteLength(source, 'utf8') > BOT_SPEC_MAX_BYTES) {
        fail('Bot specification is too large to export', 'bot_spec_limit_exceeded', 413);
      }
      await insertSignatureIfMissing({ store, uuid, revision: attached, document, principal });
      await audit({
        principal,
        botId: bot.id,
        targetType: 'bot_revision',
        targetId: revision.id,
        action: 'bot.revision.export',
        result: 'success',
        metadata: { specHash, signerKeyId: identity.keyId },
      });
      return Object.freeze({
        filename: `DevRyan-Bot-${slug(bot.name)}-r${Number(revision.revision_number)}.devryan-bot.json`,
        mediaType: BOT_SPEC_MEDIA_TYPE,
        source,
        specHash,
      });
    },

    async previewImport(principal, request) {
      const inspected = await inspectImport(principal, request);
      return Object.freeze({
        metadata: safeClone(inspected.document.metadata),
        specHash: inspected.document.integrity.specHash,
        sourceCompiledHash: inspected.document.integrity.compiledHash,
        signer: Object.freeze({
          keyId: inspected.document.integrity.signerKeyId,
          publicKey: inspected.document.integrity.signerPublicKey,
          status: inspected.signerStatus,
          acknowledgementRequired: inspected.signerStatus === 'unknown',
        }),
        target: Object.freeze({
          botId: inspected.target.bot?.id || null,
          name: inspected.target.bot?.name || inspected.target.newBotName,
        }),
        requirements: Object.freeze(inspected.withCandidates.map(publicImportRequirement)),
        readyForPublication: inspected.signerStatus === 'trusted'
          && inspected.withCandidates.every((entry) => entry.candidates.length > 0),
      });
    },

    async importDraft(principal, request) {
      const inspected = await inspectImport(principal, request, { requireAcknowledgement: true });
      const resolved = resolveMappings(
        inspected.requirements,
        inspected.mappings,
        inspected.catalog,
      );
      const contract = contractFromSpec(inspected.document.spec, inspected.requirements, resolved);
      const result = await management.createImportedDraft(principal, {
        botId: inspected.target.bot?.id || null,
        newBotName: inspected.target.newBotName,
        contract,
        portableSpec: inspected.document.spec,
        specHash: inspected.document.integrity.specHash,
      });
      const actorId = validateUuid(principal.id, 'principal.id');
      const mapped = [...resolved.values()].filter((entry) => entry.id !== NIL_UUID);
      try {
        for (const entry of mapped) {
          await store.insert('bot_revision_binding_resolutions', {
            id: uuid(),
            revision_id: result.revision.id,
            binding_kind: entry.requirement.kind,
            logical_key: entry.requirement.logicalKey,
            portable_digest: entry.requirement.portableDigest,
            local_resource_id: entry.id,
            resolved_digest: entry.requirement.portableDigest,
            resolved_by: actorId,
          });
        }
        await insertSignatureIfMissing({
          store,
          uuid,
          revision: {
            id: result.revision.id,
            compiled_hash: result.revision.compiledHash,
          },
          document: inspected.document,
          principal,
        });
      } catch (error) {
        fail('Imported Draft was created but binding provenance needs recovery', 'bot_spec_import_partial', 500, {
          botId: result.bot.id,
          revisionId: result.revision.id,
          cause: typeof error?.code === 'string' ? error.code : 'bot_spec_provenance_failed',
        });
      }
      const unresolved = inspected.requirements.filter((requirement) => (
        resolved.get(`${requirement.kind}\0${requirement.logicalKey}`).id === NIL_UUID
      ));
      await audit({
        principal,
        botId: result.bot.id,
        targetType: 'bot_revision',
        targetId: result.revision.id,
        action: 'bot.revision.import.complete',
        result: unresolved.length === 0 ? 'success' : 'partial',
        metadata: {
          specHash: inspected.document.integrity.specHash,
          signerStatus: inspected.signerStatus,
          unresolvedBindingCount: unresolved.length,
        },
      });
      return Object.freeze({
        ...result,
        signerStatus: inspected.signerStatus,
        unresolvedBindings: Object.freeze(unresolved),
        sourceCompiledHash: inspected.document.integrity.compiledHash,
        compiledHashMatches: result.revision.compiledHash === inspected.document.integrity.compiledHash,
        activated: false,
      });
    },

    async resolveDraftBindings(principal, botId, revisionId, request) {
      const bot = await requireBot(principal, botId);
      exact(request, 'Bot imported Draft binding resolution', ['expectedUpdatedAt', 'mappings']);
      const revision = await store.get('bot_revisions', {
        id: validateUuid(revisionId, 'revisionId'),
        bot_id: bot.id,
      });
      if (!revision || revision.activated_at || !revision.portable_spec || !revision.spec_hash) {
        fail('Imported Bot Draft not found', 'bot_spec_import_draft_not_found', 404);
      }
      validatePortableSpec(revision.portable_spec);
      const requirements = collectRequirements(revision.portable_spec);
      const catalog = await buildBindingCatalog({ store, encryption, botId: bot.id });
      const existingRows = await listAll(store, 'bot_revision_binding_resolutions', {
        revision_id: revision.id,
      }, 2_000);
      const mappings = normalizeMappings(request.mappings);
      const existingMappings = existingRows.map((row) => ({
        kind: row.binding_kind,
        logicalKey: row.logical_key,
        localResourceId: row.local_resource_id,
      }));
      const merged = new Map(existingMappings.map((entry) => [
        `${entry.kind}\0${entry.logicalKey}`,
        entry,
      ]));
      for (const entry of mappings) {
        const key = `${entry.kind}\0${entry.logicalKey}`;
        const existing = merged.get(key);
        if (existing && existing.localResourceId !== entry.localResourceId) {
          fail('An imported binding resolution is immutable', 'bot_spec_mapping_immutable', 409);
        }
        merged.set(key, entry);
      }
      const resolved = resolveMappings(requirements, [...merged.values()], catalog);
      const contract = contractFromSpec(revision.portable_spec, requirements, resolved);
      const updated = await management.updateImportedDraftBindings(principal, bot.id, revision.id, {
        contract,
        expectedUpdatedAt: request.expectedUpdatedAt,
        specHash: revision.spec_hash,
      });
      const actorId = validateUuid(principal.id, 'principal.id');
      const existingKeys = new Set(existingRows.map((row) => `${row.binding_kind}\0${row.logical_key}`));
      for (const entry of resolved.values()) {
        const key = `${entry.requirement.kind}\0${entry.requirement.logicalKey}`;
        if (entry.id === NIL_UUID || existingKeys.has(key)) continue;
        await store.insert('bot_revision_binding_resolutions', {
          id: uuid(),
          revision_id: revision.id,
          binding_kind: entry.requirement.kind,
          logical_key: entry.requirement.logicalKey,
          portable_digest: entry.requirement.portableDigest,
          local_resource_id: entry.id,
          resolved_digest: entry.requirement.portableDigest,
          resolved_by: actorId,
        });
      }
      const unresolved = requirements.filter((requirement) => (
        resolved.get(`${requirement.kind}\0${requirement.logicalKey}`).id === NIL_UUID
      ));
      return Object.freeze({
        ...updated,
        unresolvedBindings: Object.freeze(unresolved),
        sourceCompiledHash: null,
      });
    },

    async listTrust(principal, botId = null) {
      requirePrincipal(principal);
      if (botId) await requireBot(principal, botId);
      else if (!isGlobalAdmin(principal)) {
        fail('Global administrator access is required', 'bot_global_admin_required', 403);
      }
      const [globalRows, botRows] = await Promise.all([
        listAll(store, 'bot_signer_trust', { scope: 'global' }, 1_000),
        botId ? listAll(store, 'bot_signer_trust', { scope: 'bot', bot_id: botId }, 1_000) : [],
      ]);
      return Object.freeze([...globalRows, ...botRows].map(publicTrust));
    },

    async setTrust(principal, request) {
      requirePrincipal(principal);
      exact(request, 'Bot signer trust', [
        'scope',
        'signerKeyId',
        'signerPublicKey',
        'status',
      ], ['botId']);
      if (!['global', 'bot'].includes(request.scope)
        || !['trusted', 'revoked'].includes(request.status)
        || (request.scope === 'global') !== (request.botId === undefined)) {
        fail('Bot signer trust scope is invalid', 'bot_spec_trust_invalid', 400);
      }
      const botId = request.scope === 'bot' ? validateUuid(request.botId, 'botId') : null;
      if (request.scope === 'global') {
        if (!isGlobalAdmin(principal)) {
          fail('Global administrator access is required', 'bot_global_admin_required', 403);
        }
      } else {
        await requireBot(principal, botId);
      }
      validateSignerIdentity(request.signerKeyId, request.signerPublicKey);
      const rows = await listAll(store, 'bot_signer_trust', {
        scope: request.scope,
        ...(botId ? { bot_id: botId } : {}),
      }, 1_000);
      const existing = rows.find((row) => row.signer_key_id === request.signerKeyId);
      if (existing && existing.signer_public_key !== request.signerPublicKey) {
        fail('Signer key identity conflicts with the trust store', 'bot_spec_signer_conflict', 409);
      }
      const timestamp = now().toISOString();
      const changes = {
        signer_public_key: request.signerPublicKey,
        status: request.status,
        trusted_by: validateUuid(principal.id, 'principal.id'),
        trusted_at: timestamp,
        revoked_at: request.status === 'revoked' ? timestamp : null,
      };
      const row = existing
        ? await store.updateIfRevision(
            'bot_signer_trust',
            { id: existing.id },
            changes,
            existing.updated_at,
          )
        : await store.insert('bot_signer_trust', {
            id: uuid(),
            scope: request.scope,
            bot_id: botId,
            signer_key_id: request.signerKeyId,
            ...changes,
          });
      await audit({
        principal,
        botId,
        targetType: 'bot_signer',
        targetId: request.signerKeyId,
        action: request.status === 'trusted' ? 'bot.signer.trust' : 'bot.signer.revoke',
        result: 'success',
        metadata: { scope: request.scope },
      });
      return publicTrust(row);
    },
  });
}
