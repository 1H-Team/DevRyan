import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const BOT_RUNTIME_MANIFEST_VERSION = 1;
export const BOT_RUNTIME_RELEASE_MANIFEST_VERSION = 2;
export const BOT_RUNTIME_IMAGE_KEYS = Object.freeze([
  'supervisor',
  'engine-proxy',
  'egress',
  'indexer',
  'opencode',
  'computer',
]);
export const BOT_RUNTIME_RELEASE_PLATFORM_KEYS = Object.freeze([
  'linux/amd64',
  'linux/arm64',
]);

const RELEASE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RELEASE_REPOSITORY_PATTERN = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const RELEASE_ID_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?$/;
const RELEASE_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RELEASE_SCHEMA_PATTERN = /^\d{14}$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?$/;

export class BotRuntimeManifestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BotRuntimeManifestError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotRuntimeManifestError(message, code);
};

export const normalizeBotRuntimeArchitecture = (architecture) => {
  const normalized = String(architecture || '').trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64') return 'amd64';
  if (normalized === 'arm64') return 'arm64';
  fail('Bot runtime architecture must be arm64 or amd64', 'bot_runtime_architecture_unsupported');
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const fingerprintManifest = (manifest) => (
  `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(manifest))).digest('hex')}`
);

const ensureExactKeys = (value, expected, code) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    fail('Bot runtime manifest shape is invalid', code);
  }
};

const validateImageInventory = (images) => {
  ensureExactKeys(images, BOT_RUNTIME_IMAGE_KEYS, 'bot_runtime_manifest_invalid');
};

const exactTrimmedString = (value, pattern) => (
  typeof value === 'string' && value === value.trim() && pattern.test(value)
);

const freezeReleaseSourceManifest = (manifest) => {
  for (const image of Object.values(manifest.images)) {
    for (const platform of Object.values(image.platforms)) Object.freeze(platform);
    Object.freeze(image.platforms);
    Object.freeze(image);
  }
  Object.freeze(manifest.images);
  return Object.freeze(manifest);
};

export const validateBotRuntimeReleaseSourceManifest = (raw) => {
  ensureExactKeys(
    raw,
    [
      'version',
      'channel',
      'releaseId',
      'sourceRevision',
      'openCodeVersion',
      'schemaVersion',
      'pluginHash',
      'images',
    ],
    'bot_runtime_manifest_invalid',
  );
  if (raw.version !== BOT_RUNTIME_RELEASE_MANIFEST_VERSION || raw.channel !== 'release'
    || raw.releaseId?.length > 120
    || !exactTrimmedString(raw.releaseId, RELEASE_ID_PATTERN)
    || !exactTrimmedString(raw.sourceRevision, RELEASE_REVISION_PATTERN)
    || !exactTrimmedString(raw.openCodeVersion, RELEASE_VERSION_PATTERN)
    || !exactTrimmedString(raw.schemaVersion, RELEASE_SCHEMA_PATTERN)
    || !exactTrimmedString(raw.pluginHash, RELEASE_DIGEST_PATTERN)) {
    fail('Bot runtime release metadata is invalid', 'bot_runtime_manifest_invalid');
  }
  validateImageInventory(raw.images);
  const images = {};
  for (const key of BOT_RUNTIME_IMAGE_KEYS) {
    const image = raw.images[key];
    ensureExactKeys(
      image,
      ['name', 'repository', 'indexDigest', 'platforms'],
      'bot_runtime_manifest_invalid',
    );
    const expectedName = `devryan-bot-${key}`;
    if (image.name !== expectedName
      || image.repository?.length > 255
      || !exactTrimmedString(image.repository, RELEASE_REPOSITORY_PATTERN)
      || !image.repository.endsWith(`/${expectedName}`)
      || !exactTrimmedString(image.indexDigest, RELEASE_DIGEST_PATTERN)) {
      fail('Bot runtime release image metadata is invalid', 'bot_runtime_manifest_invalid');
    }
    ensureExactKeys(
      image.platforms,
      BOT_RUNTIME_RELEASE_PLATFORM_KEYS,
      'bot_runtime_manifest_invalid',
    );
    const platforms = {};
    for (const platformKey of BOT_RUNTIME_RELEASE_PLATFORM_KEYS) {
      const platform = image.platforms[platformKey];
      ensureExactKeys(
        platform,
        ['digest', 'sbomDigest', 'provenanceDigest'],
        'bot_runtime_manifest_invalid',
      );
      if (!exactTrimmedString(platform.digest, RELEASE_DIGEST_PATTERN)
        || !exactTrimmedString(platform.sbomDigest, RELEASE_DIGEST_PATTERN)
        || !exactTrimmedString(platform.provenanceDigest, RELEASE_DIGEST_PATTERN)) {
        fail('Bot runtime platform metadata is invalid', 'bot_runtime_manifest_invalid');
      }
      platforms[platformKey] = {
        digest: platform.digest,
        sbomDigest: platform.sbomDigest,
        provenanceDigest: platform.provenanceDigest,
      };
    }
    images[key] = {
      name: expectedName,
      repository: image.repository,
      indexDigest: image.indexDigest,
      platforms,
    };
  }
  return freezeReleaseSourceManifest({
    version: BOT_RUNTIME_RELEASE_MANIFEST_VERSION,
    channel: 'release',
    releaseId: raw.releaseId,
    sourceRevision: raw.sourceRevision,
    openCodeVersion: raw.openCodeVersion,
    schemaVersion: raw.schemaVersion,
    pluginHash: raw.pluginHash,
    images,
  });
};

const freezeManifest = (manifest) => {
  for (const image of Object.values(manifest.images)) Object.freeze(image);
  Object.freeze(manifest.images);
  return Object.freeze(manifest);
};

const normalizeArchitectureReleaseManifest = ({ releaseId, architecture, images }) => {
  const normalizedArchitecture = normalizeBotRuntimeArchitecture(architecture);
  if (releaseId?.length > 120 || !exactTrimmedString(releaseId, RELEASE_ID_PATTERN)) {
    fail('Bot runtime release identifier is invalid', 'bot_runtime_manifest_invalid');
  }
  validateImageInventory(images);
  const normalizedImages = {};
  for (const key of BOT_RUNTIME_IMAGE_KEYS) {
    const image = images[key];
    ensureExactKeys(image, ['repository', 'digest'], 'bot_runtime_manifest_invalid');
    const repository = typeof image.repository === 'string' ? image.repository.trim() : '';
    const digest = typeof image.digest === 'string' ? image.digest.trim() : '';
    if (repository !== image.repository || repository.length > 255 || digest !== image.digest
      || !RELEASE_REPOSITORY_PATTERN.test(repository) || !RELEASE_DIGEST_PATTERN.test(digest)) {
      fail('Bot runtime release image must use an immutable OCI digest', 'bot_runtime_manifest_invalid');
    }
    normalizedImages[key] = { repository, digest, reference: `${repository}@${digest}` };
  }
  const normalized = {
    version: BOT_RUNTIME_MANIFEST_VERSION,
    channel: 'release',
    releaseId,
    architecture: normalizedArchitecture,
    images: normalizedImages,
  };
  return freezeManifest({ ...normalized, fingerprint: fingerprintManifest(normalized) });
};

export const validateBotRuntimeManifest = (raw, {
  isPackaged,
  architecture = process.arch,
} = {}) => {
  const expectedArchitecture = normalizeBotRuntimeArchitecture(architecture);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('Bot runtime manifest version is unsupported', 'bot_runtime_manifest_invalid');
  }

  if (isPackaged) {
    const releaseManifest = validateBotRuntimeReleaseSourceManifest(raw);
    const platformKey = `linux/${expectedArchitecture}`;
    return normalizeArchitectureReleaseManifest({
      releaseId: releaseManifest.releaseId,
      architecture: expectedArchitecture,
      images: Object.fromEntries(BOT_RUNTIME_IMAGE_KEYS.map((key) => [key, {
        repository: releaseManifest.images[key].repository,
        digest: releaseManifest.images[key].platforms[platformKey].digest,
      }])),
    });
  }

  if (raw.version !== BOT_RUNTIME_MANIFEST_VERSION) {
    fail('Bot runtime manifest version is unsupported', 'bot_runtime_manifest_invalid');
  }
  ensureExactKeys(raw, ['version', 'channel', 'images'], 'bot_runtime_manifest_invalid');
  if (raw.channel !== 'development') {
    fail('Development Bot runtime requires the local manifest', 'bot_runtime_manifest_invalid');
  }
  validateImageInventory(raw.images);
  const images = {};
  for (const key of BOT_RUNTIME_IMAGE_KEYS) {
    const image = raw.images[key];
    ensureExactKeys(image, ['reference'], 'bot_runtime_manifest_invalid');
    const expectedReference = `devryan/bot-${key}:dev`;
    if (image.reference !== expectedReference) {
      fail('Development Bot runtime image tag is invalid', 'bot_runtime_manifest_invalid');
    }
    images[key] = { reference: expectedReference, repository: null, digest: null };
  }
  const normalized = {
    version: BOT_RUNTIME_MANIFEST_VERSION,
    channel: 'development',
    releaseId: 'development',
    architecture: expectedArchitecture,
    images,
  };
  return freezeManifest({ ...normalized, fingerprint: fingerprintManifest(normalized) });
};

export const validateInstalledBotRuntimeManifest = (raw, { architecture } = {}) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('Installed Bot runtime manifest is invalid', 'bot_runtime_manifest_invalid');
  }
  ensureExactKeys(
    raw,
    ['version', 'channel', 'releaseId', 'architecture', 'images', 'fingerprint'],
    'bot_runtime_manifest_invalid',
  );
  const expectedArchitecture = normalizeBotRuntimeArchitecture(architecture || raw.architecture);
  let normalized;
  if (raw.channel === 'release') {
    const images = {};
    validateImageInventory(raw.images);
    for (const key of BOT_RUNTIME_IMAGE_KEYS) {
      ensureExactKeys(
        raw.images[key],
        ['repository', 'digest', 'reference'],
        'bot_runtime_manifest_invalid',
      );
      images[key] = {
        repository: raw.images[key].repository,
        digest: raw.images[key].digest,
      };
    }
    normalized = normalizeArchitectureReleaseManifest({
      releaseId: raw.releaseId,
      architecture: raw.architecture,
      images,
    });
    if (normalized.architecture !== expectedArchitecture) {
      fail('Installed Bot runtime architecture does not match this app', 'bot_runtime_architecture_mismatch');
    }
  } else if (raw.channel === 'development') {
    const images = {};
    validateImageInventory(raw.images);
    for (const key of BOT_RUNTIME_IMAGE_KEYS) {
      ensureExactKeys(
        raw.images[key],
        ['repository', 'digest', 'reference'],
        'bot_runtime_manifest_invalid',
      );
      if (raw.images[key].repository !== null || raw.images[key].digest !== null) {
        fail('Installed development image metadata is invalid', 'bot_runtime_manifest_invalid');
      }
      images[key] = { reference: raw.images[key].reference };
    }
    normalized = validateBotRuntimeManifest({
      version: raw.version,
      channel: raw.channel,
      images,
    }, { isPackaged: false, architecture: expectedArchitecture });
  } else {
    fail('Installed Bot runtime channel is invalid', 'bot_runtime_manifest_invalid');
  }
  const imageMetadataMatches = BOT_RUNTIME_IMAGE_KEYS.every((key) => (
    JSON.stringify(normalized.images[key]) === JSON.stringify(raw.images[key])
  ));
  if (!imageMetadataMatches
    || normalized.releaseId !== raw.releaseId
    || normalized.architecture !== raw.architecture
    || normalized.fingerprint !== raw.fingerprint) {
    fail('Installed Bot runtime manifest fingerprint is invalid', 'bot_runtime_manifest_invalid');
  }
  return normalized;
};

export async function loadBotRuntimeManifest({
  manifestPath,
  isPackaged,
  architecture = process.arch,
  fsPromises = fs,
} = {}) {
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) {
    fail('Bot runtime manifest path must be absolute', 'bot_runtime_manifest_invalid');
  }
  let raw;
  try {
    raw = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && isPackaged) {
      fail('Packaged Bot runtime manifest is missing', 'bot_runtime_manifest_required');
    }
    fail('Bot runtime manifest cannot be read', 'bot_runtime_manifest_invalid');
  }
  return validateBotRuntimeManifest(raw, { isPackaged, architecture });
}

export async function verifyBotRuntimeReleaseManifest({
  manifestPath,
  architecture = process.arch,
} = {}) {
  return loadBotRuntimeManifest({ manifestPath, isPackaged: true, architecture });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const command = process.argv[2];
  const manifestPath = process.argv[3] ? path.resolve(process.argv[3]) : '';
  if (command !== '--verify-release' || !manifestPath) {
    console.error('Usage: node bot-runtime-manifest.mjs --verify-release <manifest.json>');
    process.exit(1);
  }
  verifyBotRuntimeReleaseManifest({ manifestPath }).then(
    () => console.log(`[bots] verified release runtime manifest: ${manifestPath}`),
    (error) => {
      console.error(`[bots] release runtime manifest verification failed (${error?.code || 'unknown'})`);
      process.exitCode = 1;
    },
  );
}
