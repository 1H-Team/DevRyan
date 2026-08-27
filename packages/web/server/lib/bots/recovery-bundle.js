import crypto, { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  assertExactObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

export const BOT_RECOVERY_FORMAT = 'DevRyan.BotRecovery';
export const BOT_RECOVERY_VERSION = 1;
export const BOT_RECOVERY_SCHEMA_VERSION = '20260826140000';
export const BOT_RECOVERY_IMAGE_SCHEMA_VERSION = 1;
const BOT_RECOVERY_LEGACY_SCHEMA_VERSIONS = Object.freeze([
  '20260823100000',
  '20260823150227',
]);

const MAGIC = Buffer.from('DEVRYAN-BOT-RECOVERY\n', 'ascii');
const AAD = Buffer.from('DevRyan Bot Recovery:v1', 'utf8');
const HEADER_BYTES = 4;
const HEADER_MAX_BYTES = 16 * 1024;
const BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
const PAYLOAD_MAX_BYTES = 384 * 1024 * 1024;
const PASSPHRASE_MIN_LENGTH = 12;
const PASSPHRASE_MAX_LENGTH = 1_024;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SECTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SECTION_CLASSIFICATIONS = new Set(['protected', 'secret']);
const SECTION_NAMES = new Set([
  'deployment_key',
  'configuration',
  'selected_objects',
  'connector_vault',
  'environment_secrets',
  'browser_profiles',
]);
const RESTORE_MODES = new Set(['empty', 'merge']);
const scryptAsync = promisify(crypto.scrypt);

export class BotRecoveryBundleError extends Error {
  constructor(message, code = 'bot_recovery_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotRecoveryBundleError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details) => {
  throw new BotRecoveryBundleError(message, code, statusCode, details);
};

const exact = (value, shape) => {
  try {
    assertExactObject(value, shape);
  } catch (error) {
    fail(error.message);
  }
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const normalizePassphrase = (value) => {
  if (typeof value !== 'string'
    || value.length < PASSPHRASE_MIN_LENGTH
    || value.length > PASSPHRASE_MAX_LENGTH
    || /[\u0000\r\n]/u.test(value)) {
    fail(
      `Recovery passphrase must contain ${PASSPHRASE_MIN_LENGTH}–${PASSPHRASE_MAX_LENGTH} characters`,
      'bot_recovery_passphrase_invalid',
    );
  }
  return value;
};

const decodeBase64 = (value, label, expectedBytes = null) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > BUNDLE_MAX_BYTES * 2) {
    fail(`${label} is invalid`, 'bot_recovery_corrupt');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expectedBytes !== null && bytes.byteLength !== expectedBytes)) {
    bytes.fill(0);
    fail(`${label} is invalid`, 'bot_recovery_corrupt');
  }
  return bytes;
};

const normalizeCompatibility = (value) => {
  const compatibility = value || {};
  exact(compatibility, {
    label: 'Recovery compatibility',
    required: ['schemaVersion', 'imageSchemaVersion'],
  });
  const schemaVersion = validateBoundedString(
    compatibility.schemaVersion,
    'schemaVersion',
    { maximum: 120 },
  );
  if (!Number.isSafeInteger(compatibility.imageSchemaVersion)
    || compatibility.imageSchemaVersion < 1
    || compatibility.imageSchemaVersion > 1_000_000) {
    fail('Recovery image schema version is invalid', 'bot_recovery_compatibility_invalid');
  }
  return Object.freeze({ schemaVersion, imageSchemaVersion: compatibility.imageSchemaVersion });
};

const normalizeSectionInput = (name, value) => {
  if (!SECTION_NAME_PATTERN.test(name)
    || !value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Recovery section is invalid');
  }
  exact(value, {
    label: `Recovery section ${name}`,
    required: ['classification', 'mediaType', 'bytes'],
  });
  if (!SECTION_CLASSIFICATIONS.has(value.classification)) {
    fail('Recovery section classification is invalid');
  }
  const mediaType = validateBoundedString(value.mediaType, 'mediaType', {
    maximum: 160,
    pattern: /^[a-z0-9][a-z0-9.+/-]*$/,
  });
  const bytes = Buffer.from(value.bytes || []);
  if (bytes.byteLength < 1 || bytes.byteLength > PAYLOAD_MAX_BYTES) {
    bytes.fill(0);
    fail('Recovery section size is invalid', 'bot_recovery_limit_exceeded', 413);
  }
  return Object.freeze({ classification: value.classification, mediaType, bytes });
};

const parseJson = (bytes, label) => {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    fail(`${label} is corrupt`, 'bot_recovery_corrupt');
  }
};

const validateOpenedPayload = (payload) => {
  exact(payload, {
    label: 'Recovery payload',
    required: ['manifest', 'sections'],
  });
  const { manifest, sections } = payload;
  exact(manifest, {
    label: 'Recovery manifest',
    required: [
      'format',
      'version',
      'schemaVersion',
      'imageSchemaVersion',
      'createdAt',
      'bot',
      'sections',
    ],
  });
  if (manifest.format !== BOT_RECOVERY_FORMAT || manifest.version !== BOT_RECOVERY_VERSION
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    fail('Recovery manifest version is unsupported', 'bot_recovery_version_unsupported', 409);
  }
  const compatibility = normalizeCompatibility({
    schemaVersion: manifest.schemaVersion,
    imageSchemaVersion: manifest.imageSchemaVersion,
  });
  exact(manifest.bot, {
    label: 'Recovery Bot identity',
    required: ['id', 'name'],
  });
  const bot = Object.freeze({
    id: validateUuid(manifest.bot.id, 'manifest.bot.id'),
    name: validateBoundedString(manifest.bot.name, 'manifest.bot.name', { maximum: 120 }),
  });
  if (!manifest.sections || typeof manifest.sections !== 'object' || Array.isArray(manifest.sections)
    || !sections || typeof sections !== 'object' || Array.isArray(sections)) {
    fail('Recovery section manifest is invalid', 'bot_recovery_corrupt');
  }
  const descriptorNames = Object.keys(manifest.sections).sort();
  const sectionNames = Object.keys(sections).sort();
  if (descriptorNames.join('\0') !== sectionNames.join('\0') || sectionNames.length < 2) {
    fail('Recovery sections do not match the manifest', 'bot_recovery_corrupt');
  }
  if (sectionNames.some((name) => !SECTION_NAMES.has(name))
    || !['deployment_key', 'configuration', 'selected_objects'].every((name) => sectionNames.includes(name))) {
    fail('Recovery section inventory is unsupported', 'bot_recovery_version_unsupported', 409);
  }
  const opened = {};
  for (const name of sectionNames) {
    if (!SECTION_NAME_PATTERN.test(name)) fail('Recovery section name is invalid', 'bot_recovery_corrupt');
    const descriptor = manifest.sections[name];
    const section = sections[name];
    exact(descriptor, {
      label: `Recovery section descriptor ${name}`,
      required: ['classification', 'mediaType', 'bytes', 'sha256'],
    });
    exact(section, {
      label: `Recovery section payload ${name}`,
      required: ['classification', 'mediaType', 'bytes', 'sha256', 'data'],
    });
    if (!SECTION_CLASSIFICATIONS.has(descriptor.classification)
      || section.classification !== descriptor.classification
      || section.mediaType !== descriptor.mediaType
      || section.bytes !== descriptor.bytes
      || section.sha256 !== descriptor.sha256
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
      || descriptor.bytes > PAYLOAD_MAX_BYTES || !HASH_PATTERN.test(descriptor.sha256)) {
      fail('Recovery section descriptor is invalid', 'bot_recovery_corrupt');
    }
    const bytes = decodeBase64(section.data, `Recovery section ${name}`, descriptor.bytes);
    if (sha256(bytes) !== descriptor.sha256) {
      bytes.fill(0);
      fail('Recovery section hash does not match', 'bot_recovery_corrupt');
    }
    opened[name] = Object.freeze({
      classification: descriptor.classification,
      mediaType: descriptor.mediaType,
      bytes,
    });
  }
  return Object.freeze({
    manifest: Object.freeze({
      ...structuredClone(manifest),
      bot,
      schemaVersion: compatibility.schemaVersion,
      imageSchemaVersion: compatibility.imageSchemaVersion,
    }),
    sections: Object.freeze(opened),
  });
};

export async function createEncryptedBotRecoveryBundle({
  passphrase,
  bot,
  compatibility = {
    schemaVersion: BOT_RECOVERY_SCHEMA_VERSION,
    imageSchemaVersion: BOT_RECOVERY_IMAGE_SCHEMA_VERSION,
  },
  sections,
  createdAt = new Date().toISOString(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const normalizedPassphrase = normalizePassphrase(passphrase);
  const normalizedCompatibility = normalizeCompatibility(compatibility);
  const normalizedBot = Object.freeze({
    id: validateUuid(bot?.id, 'bot.id'),
    name: validateBoundedString(bot?.name, 'bot.name', { maximum: 120 }),
  });
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
    || !sections || typeof sections !== 'object' || Array.isArray(sections)) {
    fail('Recovery bundle input is invalid');
  }
  const sectionPayloads = {};
  const sectionDescriptors = {};
  for (const [name, value] of Object.entries(sections)) {
    if (!SECTION_NAMES.has(name)) {
      fail('Recovery section is unsupported', 'bot_recovery_version_unsupported', 409);
    }
    const normalized = normalizeSectionInput(name, value);
    try {
      const descriptor = Object.freeze({
        classification: normalized.classification,
        mediaType: normalized.mediaType,
        bytes: normalized.bytes.byteLength,
        sha256: sha256(normalized.bytes),
      });
      sectionDescriptors[name] = descriptor;
      sectionPayloads[name] = {
        ...descriptor,
        data: normalized.bytes.toString('base64'),
      };
    } finally {
      normalized.bytes.fill(0);
    }
  }
  if (!sectionPayloads.deployment_key || !sectionPayloads.configuration
    || !sectionPayloads.selected_objects) {
    fail('Recovery bundle requires deployment key, configuration, and selected object sections');
  }
  const plaintext = Buffer.from(JSON.stringify({
    manifest: {
      format: BOT_RECOVERY_FORMAT,
      version: BOT_RECOVERY_VERSION,
      schemaVersion: normalizedCompatibility.schemaVersion,
      imageSchemaVersion: normalizedCompatibility.imageSchemaVersion,
      createdAt,
      bot: normalizedBot,
      sections: sectionDescriptors,
    },
    sections: sectionPayloads,
  }), 'utf8');
  if (plaintext.byteLength > PAYLOAD_MAX_BYTES) {
    plaintext.fill(0);
    fail('Recovery bundle is too large', 'bot_recovery_limit_exceeded', 413);
  }
  const salt = Buffer.from(randomBytes(SALT_BYTES));
  const iv = Buffer.from(randomBytes(IV_BYTES));
  if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES) {
    plaintext.fill(0);
    salt.fill(0);
    iv.fill(0);
    fail('Recovery entropy source failed', 'bot_recovery_encryption_failed', 500);
  }
  let key = null;
  try {
    key = Buffer.from(await scryptAsync(normalizedPassphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.from(JSON.stringify({
      format: BOT_RECOVERY_FORMAT,
      version: BOT_RECOVERY_VERSION,
      kdf: {
        name: 'scrypt',
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        salt: salt.toString('base64'),
      },
      cipher: {
        name: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
      },
      ciphertextBytes: ciphertext.byteLength,
      ciphertextSha256: sha256(ciphertext),
    }), 'utf8');
    if (header.byteLength > HEADER_MAX_BYTES) {
      ciphertext.fill(0);
      tag.fill(0);
      fail('Recovery bundle header is too large', 'bot_recovery_encryption_failed', 500);
    }
    const length = Buffer.alloc(HEADER_BYTES);
    length.writeUInt32BE(header.byteLength);
    const bundle = Buffer.concat([MAGIC, length, header, ciphertext]);
    ciphertext.fill(0);
    tag.fill(0);
    if (bundle.byteLength > BUNDLE_MAX_BYTES) {
      bundle.fill(0);
      fail('Recovery bundle is too large', 'bot_recovery_limit_exceeded', 413);
    }
    return bundle;
  } finally {
    plaintext.fill(0);
    salt.fill(0);
    iv.fill(0);
    key?.fill(0);
  }
}

export async function openEncryptedBotRecoveryBundle({ passphrase, bundle } = {}) {
  const normalizedPassphrase = normalizePassphrase(passphrase);
  const bytes = Buffer.from(bundle || []);
  if (bytes.byteLength < MAGIC.byteLength + HEADER_BYTES + 1
    || bytes.byteLength > BUNDLE_MAX_BYTES
    || !bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    fail('Recovery bundle is corrupt or truncated', 'bot_recovery_corrupt');
  }
  const headerLength = bytes.readUInt32BE(MAGIC.byteLength);
  const headerStart = MAGIC.byteLength + HEADER_BYTES;
  const ciphertextStart = headerStart + headerLength;
  if (headerLength < 1 || headerLength > HEADER_MAX_BYTES || ciphertextStart >= bytes.byteLength) {
    fail('Recovery bundle is corrupt or truncated', 'bot_recovery_corrupt');
  }
  const header = parseJson(bytes.subarray(headerStart, ciphertextStart), 'Recovery bundle header');
  exact(header, {
    label: 'Recovery bundle header',
    required: [
      'format',
      'version',
      'kdf',
      'cipher',
      'ciphertextBytes',
      'ciphertextSha256',
    ],
  });
  exact(header.kdf, {
    label: 'Recovery KDF header',
    required: ['name', 'N', 'r', 'p', 'salt'],
  });
  exact(header.cipher, {
    label: 'Recovery cipher header',
    required: ['name', 'iv', 'tag'],
  });
  if (header.format !== BOT_RECOVERY_FORMAT || header.version !== BOT_RECOVERY_VERSION
    || header.kdf.name !== 'scrypt' || header.kdf.N !== SCRYPT_N
    || header.kdf.r !== SCRYPT_R || header.kdf.p !== SCRYPT_P
    || header.cipher.name !== 'aes-256-gcm') {
    fail('Recovery bundle version or cryptography is unsupported', 'bot_recovery_version_unsupported', 409);
  }
  if (!Number.isSafeInteger(header.ciphertextBytes)
    || header.ciphertextBytes !== bytes.byteLength - ciphertextStart
    || !HASH_PATTERN.test(header.ciphertextSha256)) {
    fail('Recovery bundle is corrupt or truncated', 'bot_recovery_corrupt');
  }
  const ciphertext = bytes.subarray(ciphertextStart);
  if (sha256(ciphertext) !== header.ciphertextSha256) {
    fail('Recovery bundle is corrupt or truncated', 'bot_recovery_corrupt');
  }
  const salt = decodeBase64(header.kdf.salt, 'Recovery KDF salt', SALT_BYTES);
  const iv = decodeBase64(header.cipher.iv, 'Recovery cipher IV', IV_BYTES);
  const tag = decodeBase64(header.cipher.tag, 'Recovery cipher tag', TAG_BYTES);
  let key = null;
  let plaintext = null;
  try {
    key = Buffer.from(await scryptAsync(normalizedPassphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      fail(
        'Recovery passphrase is wrong or the bundle integrity check failed',
        'bot_recovery_passphrase_or_integrity_invalid',
        400,
      );
    }
    if (plaintext.byteLength > PAYLOAD_MAX_BYTES) {
      fail('Recovery bundle payload is too large', 'bot_recovery_limit_exceeded', 413);
    }
    return validateOpenedPayload(parseJson(plaintext, 'Recovery payload'));
  } finally {
    salt.fill(0);
    iv.fill(0);
    tag.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

const jsonSection = (value, classification = 'protected') => ({
  classification,
  mediaType: 'application/json',
  bytes: Buffer.from(JSON.stringify(value), 'utf8'),
});

const parseSectionJson = (section, label) => {
  if (!section || section.mediaType !== 'application/json') {
    fail(`${label} section is unavailable`, 'bot_recovery_corrupt');
  }
  return parseJson(section.bytes, label);
};

export function createBotRecoveryBundleRuntime({
  adapter,
  encryption,
  credentialVault = null,
  environmentSecretVault = null,
  browserProfiles = null,
  compatibility = {
    schemaVersion: BOT_RECOVERY_SCHEMA_VERSION,
    imageSchemaVersion: BOT_RECOVERY_IMAGE_SCHEMA_VERSION,
  },
  isGlobalAdmin = () => false,
  audit = async () => {},
  now = () => new Date(),
  uuid = randomUUID,
} = {}) {
  if (!adapter || typeof adapter.exportConfiguration !== 'function'
    || typeof adapter.inspectRestore !== 'function' || typeof adapter.restore !== 'function'
    || typeof encryption?.getKey !== 'function' || typeof isGlobalAdmin !== 'function'
    || typeof audit !== 'function' || typeof now !== 'function' || typeof uuid !== 'function') {
    throw new TypeError('Bot recovery bundle runtime is misconfigured');
  }
  const normalizedCompatibility = normalizeCompatibility(compatibility);
  const compatibleSchemaVersions = normalizedCompatibility.schemaVersion === BOT_RECOVERY_SCHEMA_VERSION
    ? new Set([BOT_RECOVERY_SCHEMA_VERSION, ...BOT_RECOVERY_LEGACY_SCHEMA_VERSIONS])
    : new Set([normalizedCompatibility.schemaVersion]);

  const exportBundle = async (principal, botId, request) => {
    exact(request, {
      label: 'Recovery export request',
      required: [
        'passphrase',
        'includeLibraryObjects',
        'includeWorkspaceObjects',
        'includeConnectorVault',
        'confirmConnectorVault',
        'includeEnvironmentSecrets',
        'confirmEnvironmentSecrets',
        'includeBrowserProfiles',
        'confirmBrowserProfiles',
      ],
    });
    const normalizedBotId = validateUuid(botId, 'botId');
    if ([
      request.includeConnectorVault,
      request.confirmConnectorVault,
      request.includeEnvironmentSecrets,
      request.confirmEnvironmentSecrets,
      request.includeBrowserProfiles,
      request.confirmBrowserProfiles,
      request.includeLibraryObjects,
      request.includeWorkspaceObjects,
    ].some((value) => typeof value !== 'boolean')) {
      fail('Recovery export section choices are invalid');
    }
    if (request.includeConnectorVault && request.confirmConnectorVault !== true) {
      fail('Connector vault export requires separate high-risk confirmation', 'bot_recovery_secret_confirmation_required', 409);
    }
    if (request.includeEnvironmentSecrets && request.confirmEnvironmentSecrets !== true) {
      fail('Environment-secret export requires separate high-risk confirmation',
        'bot_recovery_secret_confirmation_required', 409);
    }
    if (request.includeBrowserProfiles && request.confirmBrowserProfiles !== true) {
      fail('Browser profile export requires separate high-risk confirmation', 'bot_recovery_secret_confirmation_required', 409);
    }
    const snapshot = await adapter.exportConfiguration(principal, normalizedBotId, {
      includeLibraryObjects: request.includeLibraryObjects,
      includeWorkspaceObjects: request.includeWorkspaceObjects,
      includeConnectorVault: request.includeConnectorVault,
      includeEnvironmentSecrets: request.includeEnvironmentSecrets,
      includeBrowserProfiles: request.includeBrowserProfiles,
    });
    const bot = Object.freeze({
      id: validateUuid(snapshot?.bot?.id, 'snapshot.bot.id'),
      name: validateBoundedString(snapshot?.bot?.name, 'snapshot.bot.name', { maximum: 120 }),
    });
    if (bot.id !== normalizedBotId) fail('Recovery export Bot identity changed', 'bot_recovery_conflict', 409);
    const sections = {
      configuration: jsonSection(snapshot.configuration),
      selected_objects: jsonSection({ objects: snapshot.objects || [] }),
    };
    let suppliedKey = null;
    let deploymentKey = null;
    try {
      suppliedKey = await encryption.getKey();
      deploymentKey = Buffer.from(suppliedKey || []);
      if (deploymentKey.byteLength !== KEY_BYTES) {
        fail('Bot deployment key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      sections.deployment_key = {
        classification: 'protected',
        mediaType: 'application/octet-stream',
        bytes: deploymentKey,
      };
      if (request.includeConnectorVault) {
        if (typeof credentialVault?.exportForBot !== 'function') {
          fail('Connector vault recovery export is unavailable', 'bot_recovery_connector_vault_unavailable', 503);
        }
        const exportedVault = await credentialVault.exportForBot(normalizedBotId);
        try {
          sections.connector_vault = {
            classification: 'secret',
            mediaType: 'application/json',
            bytes: Buffer.from(exportedVault),
          };
        } finally {
          if (Buffer.isBuffer(exportedVault) || exportedVault instanceof Uint8Array) exportedVault.fill(0);
        }
      }
      if (request.includeEnvironmentSecrets) {
        if (typeof environmentSecretVault?.exportForBot !== 'function') {
          fail('Environment-secret recovery export is unavailable',
            'bot_recovery_environment_secrets_unavailable', 503);
        }
        const exportedEnvironment = await environmentSecretVault.exportForBot(normalizedBotId);
        try {
          sections.environment_secrets = {
            classification: 'secret',
            mediaType: 'application/json',
            bytes: Buffer.from(exportedEnvironment),
          };
        } finally {
          exportedEnvironment.fill?.(0);
        }
      }
      if (request.includeBrowserProfiles) {
        if (typeof browserProfiles?.exportForBot !== 'function') {
          fail('Browser profile recovery export is unavailable', 'bot_recovery_browser_profiles_unavailable', 503);
        }
        const exportedProfiles = await browserProfiles.exportForBot(
          normalizedBotId,
          snapshot.browserScopes || [],
        );
        try {
          sections.browser_profiles = {
            classification: 'secret',
            mediaType: 'application/vnd.devryan.bot-browser-profiles',
            bytes: Buffer.from(exportedProfiles),
          };
        } finally {
          if (Buffer.isBuffer(exportedProfiles) || exportedProfiles instanceof Uint8Array) {
            exportedProfiles.fill(0);
          }
        }
      }
      const bundle = await createEncryptedBotRecoveryBundle({
        passphrase: request.passphrase,
        bot,
        compatibility: normalizedCompatibility,
        sections,
        createdAt: now().toISOString(),
      });
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_recovery_bundle',
        targetId: validateUuid(uuid(), 'recoveryExportId'),
        action: 'bot.recovery.exported',
        result: 'success',
        metadata: {
          libraryObjectsIncluded: request.includeLibraryObjects,
          workspaceObjectsIncluded: request.includeWorkspaceObjects,
          connectorVaultIncluded: request.includeConnectorVault,
          environmentSecretsIncluded: request.includeEnvironmentSecrets,
          browserProfilesIncluded: request.includeBrowserProfiles,
          bundleSize: bundle.byteLength,
        },
      });
      return Object.freeze({ bundle, bot });
    } finally {
      deploymentKey?.fill(0);
      if (Buffer.isBuffer(suppliedKey) || suppliedKey instanceof Uint8Array) suppliedKey.fill(0);
      for (const section of Object.values(sections)) section.bytes?.fill?.(0);
    }
  };

  const restoreBundle = async (principal, request) => {
    exact(request, {
      label: 'Recovery restore request',
      required: ['passphrase', 'mode', 'bundle'],
    });
    if (!isGlobalAdmin(principal)) {
      fail('Global administrator is required for Bot recovery restore', 'bot_global_admin_required', 403);
    }
    if (!RESTORE_MODES.has(request.mode)) fail('Recovery restore mode is invalid');
    const opened = await openEncryptedBotRecoveryBundle({
      passphrase: request.passphrase,
      bundle: request.bundle,
    });
    try {
      if (!compatibleSchemaVersions.has(opened.manifest.schemaVersion)
        || opened.manifest.imageSchemaVersion !== normalizedCompatibility.imageSchemaVersion) {
        fail('Recovery bundle is not compatible with this deployment', 'bot_recovery_incompatible', 409, {
          expectedSchemaVersion: normalizedCompatibility.schemaVersion,
          expectedImageSchemaVersion: normalizedCompatibility.imageSchemaVersion,
        });
      }
      const configuration = parseSectionJson(opened.sections.configuration, 'Recovery configuration');
      const objectDocument = parseSectionJson(opened.sections.selected_objects, 'Recovery objects');
      if (!Array.isArray(objectDocument.objects)
        || Object.keys(objectDocument).sort().join('\0') !== 'objects') {
        fail('Recovery objects section is invalid', 'bot_recovery_corrupt');
      }
      const deploymentKey = opened.sections.deployment_key?.bytes;
      if (!deploymentKey || deploymentKey.byteLength !== KEY_BYTES) {
        fail('Recovery deployment key is invalid', 'bot_recovery_corrupt');
      }
      const restoreInput = Object.freeze({
        principal,
        mode: request.mode,
        manifest: opened.manifest,
        configuration,
        objects: objectDocument.objects,
        deploymentKey,
        connectorVault: opened.sections.connector_vault?.bytes || null,
        environmentSecrets: opened.sections.environment_secrets?.bytes || null,
        browserProfiles: opened.sections.browser_profiles?.bytes || null,
      });
      await adapter.inspectRestore(restoreInput);
      const result = await adapter.restore(restoreInput);
      await audit({
        principal,
        botId: opened.manifest.bot.id,
        targetType: 'bot_recovery_bundle',
        targetId: opened.manifest.bot.id,
        action: 'bot.recovery.restored',
        result: 'success',
        metadata: {
          mode: request.mode,
          connectorVaultIncluded: Boolean(restoreInput.connectorVault),
          environmentSecretsIncluded: Boolean(restoreInput.environmentSecrets),
          browserProfilesIncluded: Boolean(restoreInput.browserProfiles),
        },
      });
      return Object.freeze({
        restored: true,
        bot: opened.manifest.bot,
        mode: request.mode,
        result: structuredClone(result || {}),
      });
    } finally {
      for (const section of Object.values(opened.sections)) section.bytes.fill(0);
    }
  };

  return Object.freeze({ exportBundle, restoreBundle });
}
