import crypto, { randomUUID } from 'node:crypto';

import { decryptBotJson, encryptBotJson } from './encryption.js';
import { botSharedMemoryNamespace } from './indexer-client.js';
import { publicBotSourceScan, wipeBotSourceScan } from './source-scanner.js';
import {
  assertExactObject,
  normalizePageLimit,
  validateBoundedJsonObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const PENDING_SCAN_TTL_MS = 15 * 60 * 1_000;
const MAX_ROWS = 25_000;
const MAX_ARTIFACT_NAME = 255;
const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/yaml',
]);
const ARTIFACT_SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk|pk)_(?:live|test)_[a-z0-9]{16,}\b/i,
  /\bsk-[a-z0-9_-]{20,}\b/i,
  /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s'\"]{8,}/i,
]);

export class BotLibraryRuntimeError extends Error {
  constructor(message, code = 'bot_library_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotLibraryRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotLibraryRuntimeError(message, code, statusCode, details);
};

const metadataAad = (kind, id) => `devryan-bot-${kind}:${id}:v1`;

const normalizeDescriptor = ({ name, kind = 'filesystem' } = {}) => Object.freeze({
  name: validateBoundedString(name, 'Library source name', { maximum: 160 }),
  kind: ['filesystem', 'artifact'].includes(kind)
    ? kind
    : fail('Library source kind is invalid'),
});

const safeArtifactName = (value) => {
  const name = validateBoundedString(value, 'Artifact publication name', {
    maximum: MAX_ARTIFACT_NAME,
  });
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    fail('Artifact publication name is invalid');
  }
  return name;
};

const publicVersion = (row) => Object.freeze({
  id: row.id,
  sourceId: row.source_id,
  versionNumber: Number(row.version_number),
  objectIds: Object.freeze([...(row.object_ids || [])]),
  publishedBy: row.published_by,
  publishedAt: row.published_at,
});

const publicSource = (row, hostPath, provenance, currentVersion = null) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  descriptor: structuredClone(row.descriptor || {}),
  exclusions: structuredClone(row.exclusions || {}),
  provenance: structuredClone(provenance || {}),
  hostPath,
  currentPublishedVersionId: row.current_published_version_id || null,
  currentVersion: currentVersion ? publicVersion(currentVersion) : null,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  retiredAt: row.retired_at || null,
});

const manifestEntries = (manifest, version) => {
  if (Array.isArray(manifest?.files)) {
    return manifest.files.filter((entry) => entry && typeof entry === 'object').map((entry) => ({
      relativePath: typeof entry.relativePath === 'string' ? entry.relativePath : null,
      objectId: typeof entry.objectId === 'string' ? entry.objectId : null,
      contentType: typeof entry.contentType === 'string' ? entry.contentType : null,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      size: Number(entry.size) || 0,
      textBytes: Number(entry.textBytes) || 0,
    })).filter((entry) => entry.objectId);
  }
  const objectIds = Array.isArray(manifest?.objectIds)
    ? manifest.objectIds
    : Array.isArray(version?.object_ids) ? version.object_ids : [];
  return objectIds.map((objectId, index) => ({
    relativePath: null,
    objectId,
    contentType: null,
    sha256: null,
    size: 0,
    textBytes: 0,
    legacyOrdinal: index,
  }));
};

const compareScan = (previousManifest, scan) => {
  const previousEntries = manifestEntries(previousManifest, null);
  const previous = new Map(previousEntries
    .filter((entry) => entry.relativePath)
    .map((entry) => [entry.relativePath, entry]));
  const current = new Map(scan.files.map((entry) => [entry.relativePath, entry]));
  const added = [];
  const changed = [];
  const removed = [];
  let previousBytes = 0;
  for (const entry of previousEntries) previousBytes += Number(entry.size) || 0;
  for (const [relativePath, entry] of current) {
    const before = previous.get(relativePath);
    if (!before) added.push(relativePath);
    else if (before.sha256 !== entry.sha256) changed.push(relativePath);
  }
  for (const relativePath of previous.keys()) {
    if (!current.has(relativePath)) removed.push(relativePath);
  }
  return Object.freeze({
    added: Object.freeze(added.sort()),
    changed: Object.freeze(changed.sort()),
    removed: Object.freeze(removed.sort()),
    previousBytes,
    candidateBytes: scan.totalBytes,
    sizeDelta: scan.totalBytes - previousBytes,
    securityFindingCount: scan.findings.filter((entry) => (
      entry.severity === 'critical' || entry.severity === 'error'
    )).length,
  });
};

const publicPending = (pending) => Object.freeze({
  scanId: pending.id,
  botId: pending.botId,
  sourceId: pending.sourceId,
  sourceExpectedUpdatedAt: pending.sourceExpectedUpdatedAt,
  descriptor: structuredClone(pending.descriptor),
  scan: publicBotSourceScan(pending.scan),
  diff: pending.diff,
  expiresAt: pending.expiresAt,
});

const decodeIndexedText = (contentType, bytes) => {
  if (!TEXT_CONTENT_TYPES.has(contentType)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const indexDocument = ({ botId, versionId, sourceId, objectId, text }) => Object.freeze({
  namespace: botSharedMemoryNamespace(botId),
  documentId: `library:${versionId}:${objectId}`,
  version: versionId,
  text,
  metadata: Object.freeze({
    kind: 'library',
    botId,
    sourceId,
    libraryVersionId: versionId,
    objectId,
  }),
});

export function createBotLibraryRuntime({
  store,
  authorization,
  blobStore,
  scanner,
  encryption,
  indexer,
  dockerProvider = null,
  computerRuntimeManager = null,
  audit = async () => {},
  loadMemoryIndexDocuments = async () => [],
  uuid = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!store?.repositories?.bot_library_sources || !store.repositories.bot_library_versions
    || !store.repositories.bot_objects || !authorization
    || typeof authorization.requireManager !== 'function'
    || !blobStore || typeof blobStore.createLibraryObject !== 'function'
    || typeof blobStore.download !== 'function' || typeof blobStore.downloadAuthorized !== 'function'
    || !scanner || typeof scanner.scan !== 'function'
    || !encryption || typeof encryption.getKey !== 'function'
    || !indexer || typeof indexer.upsert !== 'function' || typeof indexer.search !== 'function'
    || typeof indexer.rebuild !== 'function' || typeof audit !== 'function'
    || typeof loadMemoryIndexDocuments !== 'function' || typeof uuid !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('Bot Library runtime is misconfigured');
  }

  const pendingScans = new Map();

  const listAll = async (repository, filters = {}, maximum = MAX_ROWS) => {
    const items = [];
    let cursor = null;
    do {
      const page = await repository.list({ filters, cursor, limit: 100 });
      items.push(...page.items);
      if (items.length > maximum) {
        fail('Bot Library collection is too large', 'bot_library_limit_exceeded', 413);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };

  const withKey = async (operation) => {
    let provided = null;
    let key = null;
    try {
      provided = await encryption.getKey();
      key = Buffer.from(provided || []);
      if (key.byteLength !== 32) {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      return await operation(key);
    } finally {
      key?.fill(0);
      if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
    }
  };

  const encryptMetadata = (kind, id, value) => withKey(async (key) => encryptBotJson({
    key,
    keyId: DEPLOYMENT_KEY_ID,
    value,
    associatedData: metadataAad(kind, id),
  }));

  const decryptMetadata = (kind, id, envelope) => withKey(async (key) => {
    try {
      return decryptBotJson({
        key,
        envelope,
        expectedKeyId: DEPLOYMENT_KEY_ID,
        associatedData: metadataAad(kind, id),
      });
    } catch {
      fail('Bot Library metadata failed integrity verification', 'bot_library_integrity_failed', 502);
    }
  });

  const loadSource = async (botId, sourceId) => {
    const source = await store.repositories.bot_library_sources.get({
      id: validateUuid(sourceId, 'sourceId'),
      bot_id: validateUuid(botId, 'botId'),
    });
    if (!source || source.retired_at) {
      fail('Bot Library source not found', 'bot_library_source_not_found', 404);
    }
    return source;
  };

  const loadVersion = async (versionId) => {
    const version = await store.repositories.bot_library_versions.get({
      id: validateUuid(versionId, 'libraryVersionId'),
    });
    if (!version) fail('Bot Library version not found', 'bot_library_version_not_found', 404);
    return version;
  };

  const decryptHostPath = async (source) => {
    if (!source.host_path_envelope) return null;
    const value = await decryptMetadata('library-source-path', source.id, source.host_path_envelope);
    if (value?.version !== 1 || typeof value.path !== 'string') {
      fail('Bot Library source path is invalid', 'bot_library_integrity_failed', 502);
    }
    return value.path;
  };

  const decryptSourceProvenance = async (source) => {
    const stored = source.provenance || {};
    if (stored?.algorithm !== 'aes-256-gcm') return structuredClone(stored);
    const value = await decryptMetadata('library-source-provenance', source.id, stored);
    if (value?.version !== 1 || !value.provenance || typeof value.provenance !== 'object'
      || Array.isArray(value.provenance)) {
      fail('Bot Library source provenance is invalid', 'bot_library_integrity_failed', 502);
    }
    return structuredClone(value.provenance);
  };

  const decryptManifest = (version) => decryptMetadata(
    'library-manifest',
    version.id,
    version.manifest_envelope,
  );

  const decryptDiff = async (version) => (
    version.diff_envelope
      ? decryptMetadata('library-diff', version.id, version.diff_envelope)
      : null
  );

  const prunePending = () => {
    const timestamp = now().getTime();
    for (const [id, pending] of pendingScans) {
      if (Date.parse(pending.expiresAt) > timestamp) continue;
      wipeBotSourceScan(pending.scan);
      pendingScans.delete(id);
    }
  };

  const createPending = async ({
    principal,
    botId,
    source = null,
    selectedPath = null,
    descriptor,
    exclusions,
    provenance,
    scan: suppliedScan = null,
  }) => {
    prunePending();
    const normalizedBotId = validateUuid(botId, 'botId');
    await authorization.requireManager(principal, normalizedBotId);
    const normalizedDescriptor = normalizeDescriptor(descriptor);
    const scan = suppliedScan || await scanner.scan({ selectedPath, exclusions });
    let retained = false;
    try {
      if (scan.files.length < 1) {
        fail('No publishable files remain after Library security checks', 'bot_library_scan_empty', 409, {
          findings: publicBotSourceScan(scan).findings,
        });
      }
      let previousManifest = null;
      if (source?.current_published_version_id) {
        previousManifest = await decryptManifest(await loadVersion(source.current_published_version_id));
      }
      const id = validateUuid(uuid(), 'scanId');
      const sourceId = source?.id || validateUuid(uuid(), 'sourceId');
      const pending = Object.freeze({
        id,
        principalId: validateUuid(principal?.id, 'principal.id'),
        botId: normalizedBotId,
        sourceId,
        sourceExpectedUpdatedAt: source?.updated_at || null,
        descriptor: normalizedDescriptor,
        exclusions: structuredClone(exclusions || scan.exclusions || {}),
        provenance: validateBoundedJsonObject(provenance || {}, 'Library source provenance'),
        selectedPath: scan.rootPath || selectedPath,
        scan,
        diff: compareScan(previousManifest, scan),
        expiresAt: new Date(now().getTime() + PENDING_SCAN_TTL_MS).toISOString(),
      });
      pendingScans.set(id, pending);
      retained = true;
      return pending;
    } finally {
      if (!retained) wipeBotSourceScan(scan);
    }
  };

  const cleanupCreatedObject = async (object) => {
    await store.storage.delete(object.storage_bucket, [object.storage_object_name]).catch(() => undefined);
    await store.deleteCreated('bot_objects', { id: object.id }).catch(() => undefined);
  };

  const indexDocumentsFromPublished = (pending, version, objects) => pending.scan.files
    .map((file, index) => ({ file, object: objects[index] }))
    .filter(({ file }) => typeof file.text === 'string' && file.text.trim())
    .map(({ file, object }) => indexDocument({
      botId: pending.botId,
      versionId: version.id,
      sourceId: pending.sourceId,
      objectId: object.id,
      text: file.text,
    }));

  const publishPending = async (principal, scanId, request, expectedBotId = null) => {
    assertExactObject(request, {
      label: 'Bot Library publication',
      required: ['confirmed', 'expectedSourceUpdatedAt'],
    });
    if (request.confirmed !== true) {
      fail('Manager publication confirmation is required', 'bot_library_confirmation_required', 409);
    }
    prunePending();
    const pending = pendingScans.get(validateUuid(scanId, 'scanId'));
    if (!pending) fail('Bot Library scan expired', 'bot_library_scan_expired', 410);
    if (expectedBotId && pending.botId !== validateUuid(expectedBotId, 'botId')) {
      fail('Bot Library scan not found', 'bot_library_scan_expired', 410);
    }
    await authorization.requireManager(principal, pending.botId);
    if (validateUuid(principal?.id, 'principal.id') !== pending.principalId) {
      fail('The Manager who reviewed this scan must publish it', 'bot_library_reviewer_mismatch', 403);
    }
    const expected = request.expectedSourceUpdatedAt;
    if (expected !== pending.sourceExpectedUpdatedAt) {
      fail('Bot Library source changed before publication', 'bot_library_version_conflict', 409);
    }

    let source = pending.sourceExpectedUpdatedAt
      ? await loadSource(pending.botId, pending.sourceId)
      : null;
    if (source && source.updated_at !== pending.sourceExpectedUpdatedAt) {
      fail('Bot Library source changed before publication', 'bot_library_version_conflict', 409);
    }
    let sourceCreated = false;
    const objects = [];
    let version = null;
    try {
      if (!source) {
        source = await store.repositories.bot_library_sources.insert({
          id: pending.sourceId,
          bot_id: pending.botId,
          descriptor: structuredClone(pending.descriptor),
          exclusions: structuredClone(pending.exclusions),
          provenance: await encryptMetadata('library-source-provenance', pending.sourceId, {
            version: 1,
            provenance: {
              kind: pending.descriptor.kind,
              importedBy: pending.principalId,
              ...structuredClone(pending.provenance),
            },
          }),
          host_path_envelope: pending.selectedPath
            ? await encryptMetadata('library-source-path', pending.sourceId, {
                version: 1,
                path: pending.selectedPath,
              })
            : null,
          current_published_version_id: null,
          created_by: pending.principalId,
          retired_at: null,
        });
        sourceCreated = true;
      }
      for (const file of pending.scan.files) {
        objects.push(await blobStore.createLibraryObject({
          principal,
          botId: pending.botId,
          contentType: file.contentType,
          bytes: file.bytes,
          provenance: {
            library: {
              sourceId: pending.sourceId,
              scanId: pending.id,
              publishedBy: pending.principalId,
            },
          },
        }));
      }
      const latest = await store.repositories.bot_library_versions.list({
        filters: { source_id: pending.sourceId },
        limit: 1,
      });
      const versionId = validateUuid(uuid(), 'libraryVersionId');
      const manifest = {
        version: 1,
        sourceId: pending.sourceId,
        files: pending.scan.files.map((file, index) => ({
          relativePath: file.relativePath,
          objectId: objects[index].id,
          contentType: file.contentType,
          sha256: file.sha256,
          size: file.size,
          textBytes: file.textBytes,
        })),
        findings: pending.scan.findings.map((entry) => ({ ...entry })),
      };
      version = await store.repositories.bot_library_versions.insert({
        id: versionId,
        source_id: pending.sourceId,
        version_number: Number(latest.items[0]?.version_number || 0) + 1,
        manifest_envelope: await encryptMetadata('library-manifest', versionId, manifest),
        diff_envelope: await encryptMetadata('library-diff', versionId, {
          version: 1,
          previousVersionId: source.current_published_version_id || null,
          ...pending.diff,
        }),
        object_ids: objects.map((object) => object.id),
        published_by: pending.principalId,
        published_at: now().toISOString(),
      });
      source = await store.repositories.bot_library_sources.updateIfRevision(
        { id: source.id, bot_id: pending.botId },
        { current_published_version_id: version.id },
        source.updated_at,
      );
    } catch (error) {
      if (version) {
        await store.deleteCreated('bot_library_versions', { id: version.id }).catch(() => undefined);
      }
      await Promise.all(objects.map(cleanupCreatedObject));
      if (sourceCreated) {
        await store.deleteCreated('bot_library_sources', { id: pending.sourceId }).catch(() => undefined);
      }
      if (error?.code === 'bot_revision_conflict' || error?.code === '23505') {
        fail('Bot Library source changed before publication', 'bot_library_version_conflict', 409);
      }
      throw error;
    } finally {
      pendingScans.delete(pending.id);
      wipeBotSourceScan(pending.scan);
    }

    const documents = indexDocumentsFromPublished(pending, version, objects);
    let indexSynchronized = true;
    await Promise.all(documents.map((document) => indexer.upsert(document)))
      .catch(() => { indexSynchronized = false; });
    await audit({
      principal,
      botId: pending.botId,
      targetType: 'bot_library_version',
      targetId: version.id,
      action: 'bot.library.publish',
      result: indexSynchronized ? 'success' : 'partial',
      metadata: {
        sourceId: pending.sourceId,
        versionNumber: Number(version.version_number),
        objectCount: objects.length,
        findingCount: pending.scan.findings.length,
        indexSynchronized,
      },
    });
    return Object.freeze({
      source: publicSource(source, pending.selectedPath, {
        kind: pending.descriptor.kind,
        importedBy: pending.principalId,
        ...structuredClone(pending.provenance),
      }, version),
      version: publicVersion(version),
      diff: pending.diff,
      indexSynchronized,
    });
  };

  const buildVersionIndexDocuments = async ({ source, version, manifest = null }) => {
    const decoded = manifest || await decryptManifest(version);
    const entries = manifestEntries(decoded, version);
    const documents = [];
    for (const entry of entries) {
      const object = await store.repositories.bot_objects.get({
        id: entry.objectId,
        bot_id: source.bot_id,
        visibility: 'library',
      });
      if (!object || object.deleted_at) continue;
      const { bytes } = await blobStore.downloadAuthorized({
        botId: source.bot_id,
        objectId: object.id,
      });
      try {
        const text = decodeIndexedText(object.content_type, bytes);
        if (text?.trim()) {
          documents.push(indexDocument({
            botId: source.bot_id,
            versionId: version.id,
            sourceId: source.id,
            objectId: object.id,
            text,
          }));
        }
      } finally {
        bytes.fill(0);
      }
    }
    return documents;
  };

  const listIndexDocuments = async ({ botId = null } = {}) => {
    const sources = await listAll(
      store.repositories.bot_library_sources,
      botId ? { bot_id: validateUuid(botId, 'botId') } : {},
    );
    const documents = [];
    for (const source of sources) {
      const versions = await listAll(
        store.repositories.bot_library_versions,
        { source_id: source.id },
      );
      for (const version of versions) {
        documents.push(...await buildVersionIndexDocuments({ source, version }));
        if (documents.length > MAX_ROWS) {
          fail('Bot Library index is too large', 'bot_library_limit_exceeded', 413);
        }
      }
    }
    return Object.freeze(documents);
  };

  const snapshotExactVersions = async ({ botId, versionIds } = {}) => {
    const normalizedBotId = validateUuid(botId, 'botId');
    if (!Array.isArray(versionIds) || versionIds.length > 1_000) {
      fail('Bot Library version snapshot is invalid');
    }
    const normalized = versionIds.map((id) => validateUuid(id, 'libraryVersionId'));
    if (new Set(normalized).size !== normalized.length) {
      fail('Bot Library version snapshot contains duplicates');
    }
    for (const versionId of normalized) {
      const version = await loadVersion(versionId);
      await loadSource(normalizedBotId, version.source_id);
    }
    return Object.freeze(normalized);
  };

  return Object.freeze({
    async scanImport(principal, botId, request) {
      assertExactObject(request, {
        label: 'Bot Library import scan',
        required: ['path', 'name', 'exclusions'],
      });
      const pending = await createPending({
        principal,
        botId,
        selectedPath: request.path,
        descriptor: { name: request.name, kind: 'filesystem' },
        exclusions: request.exclusions,
        provenance: { source: 'manager_selected_filesystem' },
      });
      return publicPending(pending);
    },

    async scanRefresh(principal, botId, sourceId, request) {
      assertExactObject(request, { label: 'Bot Library refresh scan', required: [] });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const source = await loadSource(normalizedBotId, sourceId);
      const selectedPath = await decryptHostPath(source);
      if (!selectedPath) {
        fail('This Library source cannot be refreshed from the filesystem', 'bot_library_refresh_unsupported', 409);
      }
      return publicPending(await createPending({
        principal,
        botId: normalizedBotId,
        source,
        selectedPath,
        descriptor: source.descriptor,
        exclusions: source.exclusions,
        provenance: await decryptSourceProvenance(source),
      }));
    },

    publishScan: (principal, botId, scanId, request) => publishPending(
      principal,
      scanId,
      request,
      botId,
    ),

    async publishArtifactBytes({
      principal,
      botId,
      sourceId = null,
      objectId,
      channelId,
      name,
      contentType,
      bytes,
      provenance = {},
    } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) {
        fail('Private artifact bytes are invalid');
      }
      const relativePath = safeArtifactName(name);
      const text = decodeIndexedText(contentType, bytes);
      if (text && ARTIFACT_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
        fail('Credential-like artifact content cannot be published', 'bot_library_secret_rejected', 409);
      }
      const existingSource = sourceId ? await loadSource(normalizedBotId, sourceId) : null;
      if (existingSource && existingSource.descriptor?.kind !== 'artifact') {
        fail(
          'Private artifacts can only append to an artifact Library source',
          'bot_library_source_kind_mismatch',
          409,
        );
      }
      const sourceProvenance = existingSource
        ? await decryptSourceProvenance(existingSource)
        : {
            source: 'private_artifact_publication',
            sourceObjectId: validateUuid(objectId, 'objectId'),
            sourceChannelId: validateUuid(channelId, 'channelId'),
            supplied: validateBoundedJsonObject(provenance, 'Artifact publication provenance'),
          };
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const scan = Object.freeze({
        rootPath: null,
        rootKind: 'file',
        exclusions: Object.freeze({ names: [], extensions: [], paths: [] }),
        files: Object.freeze([Object.freeze({
          relativePath,
          absolutePath: null,
          contentType,
          size: bytes.byteLength,
          textBytes: text ? Buffer.byteLength(text, 'utf8') : 0,
          sha256,
          text,
          bytes: Buffer.from(bytes),
        })]),
        findings: Object.freeze([]),
        totalBytes: bytes.byteLength,
      });
      const pending = await createPending({
        principal,
        botId: normalizedBotId,
        source: existingSource,
        descriptor: existingSource?.descriptor || { name: relativePath, kind: 'artifact' },
        exclusions: existingSource?.exclusions || {},
        provenance: sourceProvenance,
        scan,
      });
      return publishPending(principal, pending.id, {
        confirmed: true,
        expectedSourceUpdatedAt: pending.sourceExpectedUpdatedAt,
      });
    },

    async listForManager(principal, botId, { cursor = null, limit } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const page = await store.repositories.bot_library_sources.list({
        filters: { bot_id: normalizedBotId },
        cursor,
        limit: normalizePageLimit(limit),
      });
      const sources = await Promise.all(page.items.map(async (source) => {
        const currentVersion = source.current_published_version_id
          ? await loadVersion(source.current_published_version_id)
          : null;
        return publicSource(
          source,
          await decryptHostPath(source),
          await decryptSourceProvenance(source),
          currentVersion,
        );
      }));
      return Object.freeze({ sources: Object.freeze(sources), nextCursor: page.nextCursor || null });
    },

    // What the Bot actually has on its shared computer right now. This is a
    // live read of the container, not curated Library content, so it reports an
    // offline computer rather than starting one.
    async listComputerFiles(principal, botId, { path = null, scope: requestedScope = 'workspace' } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const decision = await authorization.requireManager(principal, normalizedBotId);
      if (!['workspace', 'container'].includes(requestedScope)) {
        fail('Bot computer-files scope is invalid', 'bot_request_invalid', 400);
      }
      // Everyone, administrators included, starts in the Bot's workspace; the
      // whole container is an explicit, audited request that only a global
      // administrator can make.
      if (requestedScope === 'container' && decision.decision?.reason !== 'global_admin') {
        fail('Bot computer scope requires a global administrator', 'bot_computer_scope_forbidden', 403);
      }
      const scope = requestedScope;
      const rootLabel = scope === 'container' ? 'Computer' : 'Workspace';
      const providerAvailable = scope === 'container'
        ? dockerProvider?.containerListAvailable === true
        : dockerProvider?.workspaceListAvailable === true;
      if (!providerAvailable) {
        return Object.freeze({
          available: false,
          state: 'unsupported',
          scope,
          rootLabel,
          path: '',
          entries: Object.freeze([]),
          truncated: false,
        });
      }
      try {
        const target = {
          botId: normalizedBotId,
          tenancy: decision.bot?.tenancy || 'team',
          ownerUserId: validateUuid(principal.id, 'principal.id'),
          path,
        };
        const listing = scope === 'container'
          ? await dockerProvider.listContainerFilesystem(target)
          : await dockerProvider.listWorkspace(target);
        const entries = scope === 'container'
          ? listing.entries
          : Object.freeze(listing.entries.map((entry) => Object.freeze({
              path: entry.path,
              name: entry.name,
              kind: entry.type === 'dir' ? 'directory' : 'file',
              size: entry.size,
              modifiedAt: entry.modifiedAt,
              restricted: false,
            })));
        if (scope === 'container') {
          await audit({
            principal,
            botId: normalizedBotId,
            targetType: 'bot_computer',
            targetId: normalizedBotId,
            action: 'bot.computer.files.list_container',
            result: 'success',
            metadata: { path: listing.path },
          });
        }
        return Object.freeze({
          available: true,
          state: listing.state === 'stopped' ? 'offline' : 'ready',
          scope,
          rootLabel,
          path: listing.path,
          entries,
          truncated: listing.truncated,
        });
      } catch (error) {
        const startupFailure = computerRuntimeManager?.getFailure?.(normalizedBotId);
        if (startupFailure) {
          return Object.freeze({
            available: false,
            state: 'runtime_degraded',
            code: startupFailure.code,
            scope,
            rootLabel,
            path: typeof path === 'string' ? path : '',
            entries: Object.freeze([]),
            truncated: false,
          });
        }
        const unavailableStates = {
          bot_supervisor_workspace_unavailable: 'offline',
          bot_runtime_unsupported_host: 'unsupported',
          bot_runtime_docker_not_installed: 'docker_not_installed',
          bot_runtime_docker_unavailable: 'docker_stopped',
          bot_runtime_setup_required: 'setup_required',
          bot_runtime_update_required: 'image_update_available',
          bot_runtime_degraded: 'runtime_degraded',
        };
        const state = unavailableStates[error?.code];
        if (state) {
          return Object.freeze({
            available: false,
            state,
            code: error.code,
            scope,
            rootLabel,
            path: typeof path === 'string' ? path : '',
            entries: Object.freeze([]),
            truncated: false,
          });
        }
        throw error;
      }
    },

    async getVersionForManager(principal, botId, versionId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const version = await loadVersion(versionId);
      const source = await loadSource(normalizedBotId, version.source_id);
      return Object.freeze({
        source: publicSource(
          source,
          await decryptHostPath(source),
          await decryptSourceProvenance(source),
          version,
        ),
        version: publicVersion(version),
        manifest: structuredClone(await decryptManifest(version)),
        diff: structuredClone(await decryptDiff(version)),
      });
    },

    async snapshotForRun({ botId, configuredVersionIds } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      if (!Array.isArray(configuredVersionIds) || configuredVersionIds.length > 1_000) {
        fail('Bot Library revision binding is invalid');
      }
      const configured = await Promise.all(configuredVersionIds.map((configuredId) => (
        loadVersion(configuredId)
      )));
      const sourceIds = [...new Set(configured.map((version) => version.source_id))];
      const sources = new Map((await Promise.all(sourceIds.map(async (sourceId) => (
        [sourceId, await loadSource(normalizedBotId, sourceId)]
      )))).map(([sourceId, source]) => [sourceId, source]));
      const snapshots = [];
      const seenSources = new Set();
      for (const version of configured) {
        const source = sources.get(version.source_id);
        if (!source.current_published_version_id) {
          fail('Bot Library source has no published version', 'bot_library_version_unavailable', 409);
        }
        if (seenSources.has(source.id)) continue;
        seenSources.add(source.id);
        snapshots.push(validateUuid(source.current_published_version_id, 'currentPublishedVersionId'));
      }
      return Object.freeze(snapshots);
    },

    async resolveVersionObjects({ botId, versionIds } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      if (!Array.isArray(versionIds) || versionIds.length > 1_000) {
        fail('Bot Library version snapshot is invalid');
      }
      const resolved = [];
      for (const versionId of versionIds) {
        const version = await loadVersion(versionId);
        const source = await loadSource(normalizedBotId, version.source_id);
        const manifest = await decryptManifest(version);
        resolved.push(Object.freeze({
          source,
          version,
          manifest,
          entries: Object.freeze(manifestEntries(manifest, version)),
        }));
      }
      return Object.freeze(resolved);
    },

    async search({ botId, libraryVersionIds, query, limit = 24 } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const authorized = new Set(await snapshotExactVersions({
        botId: normalizedBotId,
        versionIds: libraryVersionIds,
      }));
      const result = await indexer.search({
        namespaces: [botSharedMemoryNamespace(normalizedBotId)],
        query: validateBoundedString(query, 'Library search query', { maximum: 16 * 1024 }),
        limit: 50,
      });
      return Object.freeze((Array.isArray(result?.results) ? result.results : [])
        .filter((entry) => entry?.metadata?.kind === 'computer_resource'
          || (entry?.metadata?.kind === 'library'
            && authorized.has(entry.metadata.libraryVersionId)))
        .slice(0, Math.max(1, Math.min(24, Number(limit) || 24)))
        .map((entry) => Object.freeze({
          sourceId: typeof entry.metadata.sourceId === 'string' ? entry.metadata.sourceId : null,
          libraryVersionId: typeof entry.metadata.libraryVersionId === 'string'
            ? entry.metadata.libraryVersionId
            : null,
          text: entry.text,
        })));
    },

    snapshotExactVersions,

    listIndexDocuments,

    async rebuildIndex(principal, botId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const [memoryDocuments, libraryDocuments] = await Promise.all([
        loadMemoryIndexDocuments(),
        listIndexDocuments(),
      ]);
      const documents = [...memoryDocuments, ...libraryDocuments];
      if (documents.length > MAX_ROWS) {
        fail('Bot retrieval index is too large', 'bot_library_limit_exceeded', 413);
      }
      const result = await indexer.rebuild(documents);
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_index',
        targetId: normalizedBotId,
        action: 'bot.library.rebuild_index',
        result: 'success',
        metadata: {
          documentCount: documents.length,
          memoryDocumentCount: memoryDocuments.length,
          libraryDocumentCount: libraryDocuments.length,
        },
      });
      return Object.freeze({
        result: structuredClone(result),
        documentCount: documents.length,
        memoryDocumentCount: memoryDocuments.length,
        libraryDocumentCount: libraryDocuments.length,
      });
    },

    async shutdown() {
      for (const pending of pendingScans.values()) wipeBotSourceScan(pending.scan);
      pendingScans.clear();
    },

    getPendingScanCount: () => pendingScans.size,
  });
}
