import fs from 'node:fs/promises';
import path from 'node:path';

import { readJsonGuarded, writeFileAtomic } from './atomic-file.js';

const STORE_VERSION = 1;
const SAFE_KEY = /^[a-zA-Z0-9._:-]+$/;

const normalizeKey = (value) => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || !SAFE_KEY.test(key)) {
    throw new TypeError('record key contains unsupported characters');
  }
  return key;
};

export const createRecordStore = (options = {}) => {
  const directory = path.resolve(options.directory);
  const fsApi = options.fs ?? fs;
  const version = options.version ?? STORE_VERSION;
  const validateRecord = typeof options.validateRecord === 'function'
    ? options.validateRecord
    : (record) => record;
  const maxReadBytes = options.maxReadBytes;
  const logger = options.logger ?? console;
  const tails = new Map();
  const pending = new Set();
  let initialized = false;
  let quarantineCount = 0;

  const filePathFor = (key) => path.join(directory, `${normalizeKey(key)}.json`);

  const validateEnvelope = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('record envelope must be an object');
    }
    if (value.version !== version) {
      throw new TypeError(`record version must be ${version}`);
    }
    const key = normalizeKey(value.key);
    return {
      version,
      key,
      record: validateRecord(value.record, key),
    };
  };

  const initialize = async () => {
    if (initialized) return;
    await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
    initialized = true;
  };

  const enqueue = (key, task) => {
    const normalized = normalizeKey(key);
    const previous = tails.get(normalized) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const settled = operation.finally(() => {
      pending.delete(settled);
      if (tails.get(normalized) === settled) tails.delete(normalized);
    });
    tails.set(normalized, settled);
    pending.add(settled);
    return operation;
  };

  const readRecord = async (key) => {
    await initialize();
    const normalized = normalizeKey(key);
    await (tails.get(normalized) ?? Promise.resolve()).catch(() => undefined);
    const envelope = await readJsonGuarded(filePathFor(normalized), {
      fs: fsApi,
      maxBytes: maxReadBytes,
      quarantineDir: path.join(directory, 'quarantine'),
      validate: validateEnvelope,
      onQuarantine: ({ quarantinedPath, error }) => {
        quarantineCount += 1;
        logger.warn?.('[HarnessRecordStore] Quarantined invalid record', {
          key: normalized,
          quarantinedPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    });
    return envelope?.record ?? null;
  };

  const writeRecord = (key, record) => enqueue(key, async () => {
    await initialize();
    const normalized = normalizeKey(key);
    const validated = validateRecord(record, normalized);
    await writeFileAtomic(
      filePathFor(normalized),
      `${JSON.stringify({ version, key: normalized, record: validated }, null, 2)}\n`,
      { fs: fsApi },
    );
    return validated;
  });

  const deleteRecord = (key) => enqueue(key, async () => {
    await initialize();
    await fsApi.rm(filePathFor(key), { force: true });
  });

  const listRecords = async () => {
    await initialize();
    await Promise.allSettled([...tails.values()]);
    const entries = await fsApi.readdir(directory, { withFileTypes: true });
    const records = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const key = entry.name.slice(0, -'.json'.length);
      if (!SAFE_KEY.test(key)) continue;
      const record = await readRecord(key);
      if (record !== null) records.push({ key, record });
    }
    return records;
  };

  const reconcile = async (reconciler) => {
    const records = await listRecords();
    const results = [];
    for (const entry of records) {
      const next = await reconciler(entry.record, entry.key);
      if (next === null) {
        await deleteRecord(entry.key);
        results.push({ key: entry.key, action: 'deleted' });
      } else if (next !== undefined && next !== entry.record) {
        await writeRecord(entry.key, next);
        results.push({ key: entry.key, action: 'updated', record: next });
      } else {
        results.push({ key: entry.key, action: 'unchanged', record: entry.record });
      }
    }
    return results;
  };

  const drain = async () => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  };

  return {
    directory,
    initialize,
    readRecord,
    writeRecord,
    deleteRecord,
    listRecords,
    reconcile,
    drain,
    getDiagnostics: () => ({
      directory,
      initialized,
      pendingWrites: pending.size,
      quarantineCount,
    }),
  };
};

export { STORE_VERSION };
