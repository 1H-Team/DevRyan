import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decryptBotJson, encryptBotJson } from './encryption.js';
import { botSharedMemoryNamespace } from './indexer-client.js';
import { assertExactObject, validateUuid } from './validation.js';

const MAX_FILES = 250;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_INDEXED_TEXT_BYTES = 512 * 1024;
const MAX_INDEX_DOCUMENTS = 25_000;
const MANIFEST_VERSION = 2;
const DEPLOYMENT_KEY_ID = 'deployment-v1';
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx)|credentials\.json)$/iu;

export class BotComputerResourcesError extends Error {
  constructor(message, code = 'bot_computer_resource_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotComputerResourcesError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotComputerResourcesError(message, code, statusCode);
};

const safeSegment = (value) => {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)
    || ['.devryan', '.opencode'].includes(normalized.toLowerCase())) {
    fail('A selected resource has an unsupported name');
  }
  return normalized;
};

const decodeText = (bytes) => {
  if (bytes.byteLength > MAX_INDEXED_TEXT_BYTES || bytes.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
};

const resourceDocumentId = (resourcePath) => (
  `computer-resource:${crypto.createHash('sha256').update(resourcePath, 'utf8').digest('hex')}`
);

const resourceProjectionAad = ({ botId, computerPath, documentId, version }) => (
  `devryan-bot-computer-resource:${botId}:${computerPath}:${documentId}:${version}:v1`
);

const publicResource = (entry) => Object.freeze({
  computerPath: entry.computerPath,
  sourcePath: entry.sourcePath,
  kind: entry.kind,
  ...(typeof entry.importedAt === 'string' ? { importedAt: entry.importedAt } : {}),
});

const readManifest = async (filename, expectedBotId) => {
  try {
    const parsed = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (![1, MANIFEST_VERSION].includes(parsed?.version) || !Array.isArray(parsed.resources)
      || (parsed.version === MANIFEST_VERSION && parsed.botId !== expectedBotId)) {
      fail(
        'Bot computer resource manifest failed integrity verification',
        'bot_computer_resource_integrity_failed',
        502,
      );
    }
    return parsed.resources
      .filter((entry) => (
        entry && typeof entry.computerPath === 'string'
        && typeof entry.sourcePath === 'string'
        && ['file', 'directory'].includes(entry.kind)
      ))
      .map((entry) => ({
        computerPath: entry.computerPath,
        sourcePath: entry.sourcePath,
        kind: entry.kind,
        ...(typeof entry.importedAt === 'string' ? { importedAt: entry.importedAt } : {}),
        ...(entry.indexProjection && typeof entry.indexProjection === 'object'
          ? { indexProjection: entry.indexProjection }
          : {}),
      }));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error instanceof BotComputerResourcesError) throw error;
    fail(
      'Bot computer resource manifest failed integrity verification',
      'bot_computer_resource_integrity_failed',
      502,
    );
  }
};

const writeManifest = async (filename, botId, resources) => {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ version: MANIFEST_VERSION, botId, resources }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.rename(temporary, filename);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const collectFiles = async (sourcePath) => {
  const rootStats = await fs.lstat(sourcePath).catch(() => null);
  if (!rootStats || (!rootStats.isFile() && !rootStats.isDirectory()) || rootStats.isSymbolicLink()) {
    fail('Choose a regular file or folder', 'bot_computer_resource_not_found', 404);
  }
  const rootName = safeSegment(path.basename(sourcePath));
  const files = [];
  const skipped = [];
  const normalizedPaths = new Set();
  let totalBytes = 0;

  const visit = async (absolutePath, relativeSegments) => {
    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      skipped.push({ path: absolutePath, reason: 'unsupported_entry' });
      return;
    }
    if (SECRET_NAME.test(path.basename(absolutePath))) {
      skipped.push({ path: absolutePath, reason: 'secret_like_name' });
      return;
    }
    if (stats.isDirectory()) {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (files.length >= MAX_FILES) fail('The selected folder contains too many files', 'bot_computer_resource_limit', 413);
        const childPath = path.join(absolutePath, entry.name);
        if (SECRET_NAME.test(entry.name)) {
          skipped.push({ path: childPath, reason: 'secret_like_name' });
          continue;
        }
        let childName;
        try {
          childName = safeSegment(entry.name);
        } catch {
          skipped.push({ path: childPath, reason: 'unsupported_name' });
          continue;
        }
        await visit(childPath, [...relativeSegments, childName]);
      }
      return;
    }
    if (stats.size === 0) {
      skipped.push({ path: absolutePath, reason: 'empty_file' });
      return;
    }
    if (stats.size > MAX_FILE_BYTES || totalBytes + stats.size > MAX_TOTAL_BYTES) {
      fail('The selected resources are too large', 'bot_computer_resource_limit', 413);
    }
    totalBytes += stats.size;
    const resourcePath = relativeSegments.join('/');
    if (normalizedPaths.has(resourcePath)) {
      fail('Two selected files resolve to the same safe resource name');
    }
    normalizedPaths.add(resourcePath);
    files.push({
      absolutePath,
      resourcePath,
      size: stats.size,
    });
  };

  await visit(sourcePath, [rootName]);
  return Object.freeze({
    rootName,
    rootKind: rootStats.isDirectory() ? 'directory' : 'file',
    files: Object.freeze(files),
    skipped: Object.freeze(skipped),
    totalBytes,
  });
};

export function createBotComputerResources({
  dataDirectory,
  authorization,
  dockerProvider,
  computerRuntimeManager,
  encryption,
  getIndexer = () => null,
  audit = async () => {},
  uuid = randomUUID,
  now = () => new Date(),
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || !authorization || typeof authorization.requireManager !== 'function'
    || !dockerProvider || typeof dockerProvider.importSharedFile !== 'function'
    || !computerRuntimeManager || typeof computerRuntimeManager.ensureBot !== 'function'
    || typeof getIndexer !== 'function' || typeof audit !== 'function') {
    throw new TypeError('Bot computer resources are misconfigured');
  }

  const manifestPath = (botId) => path.join(dataDirectory, 'bots', 'computer-resources', `${botId}.json`);

  const withKey = async (operation) => {
    let provided = null;
    let key = null;
    try {
      if (typeof encryption?.getKey !== 'function') {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
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

  const encryptProjection = ({ botId, computerPath, documentId, version, text }) => (
    withKey(async (key) => encryptBotJson({
      key,
      keyId: DEPLOYMENT_KEY_ID,
      value: { version: 1, text },
      associatedData: resourceProjectionAad({ botId, computerPath, documentId, version }),
    }))
  );

  const decryptProjection = ({ botId, computerPath, indexProjection }) => withKey(async (key) => {
    const { documentId, version, envelope } = indexProjection || {};
    if (typeof documentId !== 'string' || typeof version !== 'string' || !envelope) {
      fail(
        'Bot computer resource index failed integrity verification',
        'bot_computer_resource_integrity_failed',
        502,
      );
    }
    let value;
    try {
      value = decryptBotJson({
        key,
        envelope,
        expectedKeyId: DEPLOYMENT_KEY_ID,
        associatedData: resourceProjectionAad({ botId, computerPath, documentId, version }),
      });
    } catch {
      fail(
        'Bot computer resource index failed integrity verification',
        'bot_computer_resource_integrity_failed',
        502,
      );
    }
    if (value?.version !== 1 || typeof value.text !== 'string' || !value.text.trim()
      || Buffer.byteLength(value.text, 'utf8') > MAX_INDEXED_TEXT_BYTES) {
      fail(
        'Bot computer resource index failed integrity verification',
        'bot_computer_resource_integrity_failed',
        502,
      );
    }
    return Object.freeze({ documentId, version, text: value.text });
  });

  const indexDocument = ({ botId, computerPath, documentId, version, text }) => Object.freeze({
    namespace: botSharedMemoryNamespace(botId),
    documentId,
    version,
    text,
    metadata: {
      kind: 'computer_resource',
      botId,
      computerPath,
    },
  });

  return Object.freeze({
    async list(principal, botId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const resources = await readManifest(manifestPath(normalizedBotId), normalizedBotId);
      return Object.freeze({ resources: Object.freeze(resources.map(publicResource)) });
    },

    async listIndexDocuments({ botId = null } = {}) {
      let botIds;
      if (botId) {
        botIds = [validateUuid(botId, 'botId')];
      } else {
        const directory = path.join(dataDirectory, 'bots', 'computer-resources');
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
          if (error?.code === 'ENOENT') return [];
          throw error;
        });
        botIds = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => {
            try {
              return validateUuid(entry.name.slice(0, -'.json'.length), 'botId');
            } catch {
              fail(
                'Bot computer resource manifest failed integrity verification',
                'bot_computer_resource_integrity_failed',
                502,
              );
            }
          });
      }
      const documents = [];
      for (const normalizedBotId of botIds) {
        const resources = await readManifest(manifestPath(normalizedBotId), normalizedBotId);
        for (const resource of resources) {
          if (!resource.indexProjection) continue;
          const projection = await decryptProjection({
            botId: normalizedBotId,
            computerPath: resource.computerPath,
            indexProjection: resource.indexProjection,
          });
          documents.push(indexDocument({
            botId: normalizedBotId,
            computerPath: resource.computerPath,
            ...projection,
          }));
          if (documents.length > MAX_INDEX_DOCUMENTS) {
            fail('Bot computer resource index is too large', 'bot_computer_resource_limit', 413);
          }
        }
      }
      return Object.freeze(documents);
    },

    async importPath(principal, botId, request) {
      assertExactObject(request, { label: 'Bot computer resource import', required: ['path'] });
      const normalizedBotId = validateUuid(botId, 'botId');
      const decision = await authorization.requireManager(principal, normalizedBotId);
      const sourcePath = typeof request.path === 'string' ? request.path.trim() : '';
      if (!path.isAbsolute(sourcePath) || sourcePath.includes('\0')) {
        fail('Choose an absolute local file or folder path');
      }
      if (!decision.bot.active_revision_id) {
        fail('Activate this Bot before adding computer resources', 'bot_not_active', 409);
      }
      await computerRuntimeManager.ensureBot(decision.bot);
      const collected = await collectFiles(sourcePath);
      if (collected.files.length === 0) {
        fail('The selected resource does not contain any non-empty supported files');
      }
      const imported = [];
      const persistedImports = [];
      const indexDocuments = [];
      for (const file of collected.files) {
        const bytes = await fs.readFile(file.absolutePath);
        try {
          const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
          const computerPath = `Resources/${file.resourcePath}`;
          const text = decodeText(bytes);
          const documentId = text ? resourceDocumentId(file.resourcePath) : null;
          const indexProjection = text ? Object.freeze({
            documentId,
            version: sha256,
            envelope: await encryptProjection({
              botId: normalizedBotId,
              computerPath,
              documentId,
              version: sha256,
              text,
            }),
          }) : null;
          const result = await dockerProvider.importSharedFile({
            botId: normalizedBotId,
            channelId: validateUuid(uuid(), 'resourceChannelId'),
            messageId: validateUuid(uuid(), 'resourceMessageId'),
            filename: file.resourcePath.split('/').at(-1),
            resourcePath: file.resourcePath,
            bytes,
          });
          if (text) indexDocuments.push(indexDocument({
            botId: normalizedBotId,
            computerPath,
            documentId,
            version: sha256,
            text,
          }));
          imported.push(Object.freeze({
            computerPath,
            sourcePath: file.absolutePath,
            kind: 'file',
            bytes: result.bytes,
            sha256: result.sha256,
          }));
          persistedImports.push({
            computerPath,
            sourcePath: file.absolutePath,
            kind: 'file',
            ...(indexProjection ? { indexProjection } : {}),
          });
        } finally {
          bytes.fill(0);
        }
      }
      const existing = await readManifest(manifestPath(normalizedBotId), normalizedBotId);
      const nextByPath = new Map(existing.map((entry) => [entry.computerPath, entry]));
      const importedAt = now().toISOString();
      nextByPath.set(`Resources/${collected.rootName}`, {
        computerPath: `Resources/${collected.rootName}`,
        sourcePath,
        kind: collected.rootKind,
        importedAt,
      });
      for (const entry of persistedImports) {
        nextByPath.set(entry.computerPath, {
          computerPath: entry.computerPath,
          sourcePath: entry.sourcePath,
          kind: 'file',
          importedAt,
          ...(entry.indexProjection ? { indexProjection: entry.indexProjection } : {}),
        });
      }
      await writeManifest(manifestPath(normalizedBotId), normalizedBotId, [...nextByPath.values()]);
      const indexer = getIndexer();
      let indexSynchronized = indexDocuments.length === 0 || Boolean(indexer);
      if (indexer) {
        for (const document of indexDocuments) {
          await indexer.upsert(document).catch(() => { indexSynchronized = false; });
        }
      }
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_computer',
        targetId: normalizedBotId,
        action: 'bot.computer.resource.import',
        result: indexSynchronized ? 'success' : 'partial',
        metadata: {
          fileCount: imported.length,
          skippedCount: collected.skipped.length,
          totalBytes: collected.totalBytes,
          indexSynchronized,
        },
      });
      return Object.freeze({
        imported: Object.freeze(imported),
        skipped: collected.skipped,
        rootComputerPath: `Resources/${collected.rootName}`,
        indexSynchronized,
      });
    },
  });
}
