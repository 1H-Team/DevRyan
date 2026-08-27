import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import Database from 'better-sqlite3';

import { decodeEmbedding } from './embeddings.js';
import { validateIndexNamespace } from './search.js';

const INDEX_FORMAT_VERSION = 1;
const DEFAULT_MAX_DOCUMENTS = 25_000;
const DEFAULT_MAX_CHUNKS = 250_000;
const DEFAULT_MAX_STORED_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
let builtInFts5Available;

const hasBuiltInFts5 = () => {
  if (builtInFts5Available !== undefined) return builtInFts5Available;
  let probe;
  try {
    probe = new DatabaseSync(':memory:');
    const row = probe.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get();
    builtInFts5Available = Number(row?.enabled) === 1;
  } catch {
    builtInFts5Available = false;
  } finally {
    probe?.close();
  }
  return builtInFts5Available;
};

const defaultDatabase = (filePath) => (hasBuiltInFts5()
  ? new DatabaseSync(filePath)
  : new Database(filePath));

export class BotIndexStoreError extends Error {
  constructor(message, code = 'bot_indexer_store_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotIndexStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotIndexStoreError(message, code, statusCode);
};

const isCorruption = (error) => /SQLITE_(?:CORRUPT|NOTADB)|not a database|malformed/i.test(
  `${error?.code || ''} ${error?.message || ''}`,
);

const removeDatabaseFiles = (databasePath) => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
};

const initializeSchema = (database) => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS documents (
      namespace TEXT NOT NULL,
      document_id TEXT NOT NULL,
      version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
      stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, document_id)
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL,
      document_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      text TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes > 0),
      embedding BLOB NOT NULL,
      UNIQUE (namespace, document_id, ordinal),
      FOREIGN KEY (namespace, document_id)
        REFERENCES documents(namespace, document_id) ON DELETE CASCADE
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE INDEX IF NOT EXISTS chunks_namespace_document
      ON chunks(namespace, document_id, ordinal);
  `);
  const insertMetadata = database.prepare(
    'INSERT OR IGNORE INTO index_metadata(key, value) VALUES (?, ?)',
  );
  insertMetadata.run('format_version', String(INDEX_FORMAT_VERSION));
  insertMetadata.run('state', 'rebuild_required');
  insertMetadata.run('reason', 'index_not_built');
  const quickCheck = database.prepare('PRAGMA quick_check(1)').get();
  if (!quickCheck || Object.values(quickCheck)[0] !== 'ok') {
    throw new Error('SQLite index is malformed');
  }
};

const openDatabase = (databasePath, databaseFactory) => {
  const database = databaseFactory(databasePath);
  initializeSchema(database);
  return database;
};

const parseMetadata = (value) => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    fail('Stored index metadata is corrupt', 'bot_indexer_corrupt', 500);
  }
};

const validateLimits = ({ maxDocuments, maxChunks, maxStoredBytes }) => {
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1_000_000
    || !Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 5_000_000
    || !Number.isInteger(maxStoredBytes) || maxStoredBytes < 1 || maxStoredBytes > 2 ** 40) {
    fail('Index capacity limits are invalid', 'bot_indexer_configuration_invalid', 500);
  }
};

const canonicalDocument = (document) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('Index document is invalid');
  }
  const namespace = validateIndexNamespace(document.namespace);
  const { documentId, version } = document;
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)
    || typeof version !== 'string' || !VERSION_PATTERN.test(version)
    || !Array.isArray(document.chunks) || document.chunks.length === 0 || document.chunks.length > 4_096) {
    fail('Index document identity or chunks are invalid');
  }
  const metadata = document.metadata === undefined ? {} : document.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('Index document metadata is invalid');
  }
  let metadataJson;
  try {
    metadataJson = JSON.stringify(metadata);
  } catch {
    fail('Index document metadata is not serializable');
  }
  if (Buffer.byteLength(metadataJson, 'utf8') > MAX_METADATA_BYTES) {
    fail('Index document metadata is too large', 'bot_indexer_limit_exceeded', 413);
  }
  let sourceBytes = 0;
  let storedBytes = Buffer.byteLength(metadataJson, 'utf8')
    + Buffer.byteLength(namespace + documentId + version, 'utf8');
  const hash = crypto.createHash('sha256');
  const chunks = document.chunks.map((chunk, index) => {
    if (!chunk || typeof chunk !== 'object' || chunk.ordinal !== index
      || typeof chunk.text !== 'string' || chunk.text.length === 0
      || !Buffer.isBuffer(chunk.embedding)) {
      fail('Index document chunk is invalid');
    }
    const bytes = Buffer.byteLength(chunk.text, 'utf8');
    if (bytes !== chunk.bytes) fail('Index document chunk byte count is invalid');
    decodeEmbedding(chunk.embedding);
    sourceBytes += bytes;
    storedBytes += bytes + chunk.embedding.byteLength;
    hash.update(String(index));
    hash.update('\0');
    hash.update(chunk.text, 'utf8');
    hash.update('\0');
    hash.update(chunk.embedding);
    return Object.freeze({
      ordinal: index,
      text: chunk.text,
      bytes,
      embedding: Buffer.from(chunk.embedding),
    });
  });
  return Object.freeze({
    namespace,
    documentId,
    version,
    metadataJson,
    chunks: Object.freeze(chunks),
    sourceBytes,
    storedBytes,
    contentHash: hash.digest('hex'),
  });
};

const rowToResult = (row) => Object.freeze({
  namespace: row.namespace,
  documentId: row.document_id,
  version: row.version,
  ordinal: Number(row.ordinal),
  text: row.text,
  metadata: parseMetadata(row.metadata_json),
  ...(row.embedding ? { embedding: Buffer.from(row.embedding) } : {}),
  ...(Number.isFinite(row.rank) ? { ftsScore: -Number(row.rank) } : {}),
});

export function createIndexStore({
  databasePath = '/var/lib/devryan-bot-index/index.sqlite',
  maxDocuments = DEFAULT_MAX_DOCUMENTS,
  maxChunks = DEFAULT_MAX_CHUNKS,
  maxStoredBytes = DEFAULT_MAX_STORED_BYTES,
  now = () => new Date(),
  databaseFactory = defaultDatabase,
} = {}) {
  validateLimits({ maxDocuments, maxChunks, maxStoredBytes });
  if ((databasePath !== ':memory:' && (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)))
    || typeof now !== 'function' || typeof databaseFactory !== 'function') {
    fail('Index store configuration is invalid', 'bot_indexer_configuration_invalid', 500);
  }
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
  }

  let database;
  let recovered = false;
  let closed = false;
  try {
    database = openDatabase(databasePath, databaseFactory);
  } catch (error) {
    try { database?.close(); } catch { /* Ignore a failed close on corrupt input. */ }
    if (databasePath === ':memory:' || !isCorruption(error)) throw error;
    removeDatabaseFiles(databasePath);
    database = openDatabase(databasePath, databaseFactory);
    database.prepare('UPDATE index_metadata SET value = ? WHERE key = ?')
      .run('corrupt_index_recovered', 'reason');
    recovered = true;
  }

  const getMetadata = database.prepare('SELECT value FROM index_metadata WHERE key = ?');
  const setMetadata = database.prepare(`
    INSERT INTO index_metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const existingDocument = database.prepare(`
    SELECT version, content_hash, stored_bytes,
      (SELECT count(*) FROM chunks WHERE namespace = ? AND document_id = ?) AS chunk_count
    FROM documents WHERE namespace = ? AND document_id = ?
  `);
  const totals = database.prepare(`
    SELECT count(*) AS document_count,
      coalesce(sum(stored_bytes), 0) AS stored_bytes,
      (SELECT count(*) FROM chunks) AS chunk_count
    FROM documents
  `);
  const insertDocument = database.prepare(`
    INSERT INTO documents(
      namespace, document_id, version, content_hash, metadata_json,
      source_bytes, stored_bytes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = database.prepare(`
    INSERT INTO chunks(namespace, document_id, ordinal, text, bytes, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteDocument = database.prepare(
    'DELETE FROM documents WHERE namespace = ? AND document_id = ?',
  );

  const transaction = (operation) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  };

  const enforceTotals = ({ documentCount, chunkCount, storedBytes }) => {
    if (documentCount > maxDocuments || chunkCount > maxChunks || storedBytes > maxStoredBytes) {
      fail('Local index capacity would be exceeded', 'bot_indexer_limit_exceeded', 413);
    }
  };

  const insertCanonical = (document, timestamp) => {
    insertDocument.run(
      document.namespace,
      document.documentId,
      document.version,
      document.contentHash,
      document.metadataJson,
      document.sourceBytes,
      document.storedBytes,
      timestamp,
    );
    for (const chunk of document.chunks) {
      insertChunk.run(
        document.namespace,
        document.documentId,
        chunk.ordinal,
        chunk.text,
        chunk.bytes,
        chunk.embedding,
      );
    }
  };

  const store = {
    status() {
      const summary = totals.get();
      return Object.freeze({
        state: getMetadata.get('state')?.value || 'rebuild_required',
        reason: getMetadata.get('reason')?.value || null,
        recovered,
        sqliteDriver: hasBuiltInFts5() ? 'node:sqlite' : 'better-sqlite3',
        formatVersion: INDEX_FORMAT_VERSION,
        documentCount: Number(summary.document_count),
        chunkCount: Number(summary.chunk_count),
        storedBytes: Number(summary.stored_bytes),
        limits: Object.freeze({ maxDocuments, maxChunks, maxStoredBytes }),
      });
    },

    upsert(rawDocument) {
      const document = canonicalDocument(rawDocument);
      return transaction(() => {
        const current = existingDocument.get(
          document.namespace,
          document.documentId,
          document.namespace,
          document.documentId,
        );
        if (current?.version === document.version && current.content_hash !== document.contentHash) {
          fail('The same canonical version has different content', 'bot_indexer_version_conflict', 409);
        }
        if (current?.version === document.version && current.content_hash === document.contentHash) {
          return Object.freeze({ changed: false, version: document.version });
        }
        const summary = totals.get();
        enforceTotals({
          documentCount: Number(summary.document_count) + (current ? 0 : 1),
          chunkCount: Number(summary.chunk_count) - Number(current?.chunk_count || 0) + document.chunks.length,
          storedBytes: Number(summary.stored_bytes) - Number(current?.stored_bytes || 0) + document.storedBytes,
        });
        if (current) deleteDocument.run(document.namespace, document.documentId);
        insertCanonical(document, now().toISOString());
        return Object.freeze({ changed: true, version: document.version });
      });
    },

    delete({ namespace, documentId, version } = {}) {
      validateIndexNamespace(namespace);
      if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)
        || typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        fail('Index delete identity is invalid');
      }
      return transaction(() => {
        const current = existingDocument.get(namespace, documentId, namespace, documentId);
        if (!current) return Object.freeze({ changed: false });
        if (current.version !== version) {
          fail('Delete version does not match the canonical index version', 'bot_indexer_version_conflict', 409);
        }
        deleteDocument.run(namespace, documentId);
        return Object.freeze({ changed: true });
      });
    },

    rebuild(rawDocuments) {
      if (!Array.isArray(rawDocuments)) fail('Rebuild documents are invalid');
      const documents = rawDocuments.map(canonicalDocument)
        .sort((left, right) => left.namespace.localeCompare(right.namespace)
          || left.documentId.localeCompare(right.documentId));
      const keys = new Set();
      let chunks = 0;
      let bytes = 0;
      for (const document of documents) {
        const key = `${document.namespace}\0${document.documentId}`;
        if (keys.has(key)) fail('Rebuild contains a duplicate document');
        keys.add(key);
        chunks += document.chunks.length;
        bytes += document.storedBytes;
      }
      enforceTotals({ documentCount: documents.length, chunkCount: chunks, storedBytes: bytes });
      return transaction(() => {
        database.exec('DELETE FROM documents;');
        const timestamp = now().toISOString();
        for (const document of documents) insertCanonical(document, timestamp);
        setMetadata.run('state', 'ready');
        setMetadata.run('reason', 'rebuild_complete');
        recovered = false;
        return Object.freeze({
          documentCount: documents.length,
          chunkCount: chunks,
          storedBytes: bytes,
        });
      });
    },

    markRebuildRequired(reason = 'canonical_sources_changed') {
      if (typeof reason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(reason)) {
        fail('Rebuild reason is invalid');
      }
      transaction(() => {
        setMetadata.run('state', 'rebuild_required');
        setMetadata.run('reason', reason);
      });
    },

    ftsSearch(namespaces, ftsQuery, limit) {
      const exact = namespaces.map(validateIndexNamespace);
      if (exact.length === 0 || exact.length > 32 || typeof ftsQuery !== 'string'
        || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        fail('FTS query is invalid');
      }
      const placeholders = exact.map(() => '?').join(', ');
      const statement = database.prepare(`
        SELECT c.namespace, c.document_id, c.ordinal, c.text,
          d.version, d.metadata_json, bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        JOIN documents d ON d.namespace = c.namespace AND d.document_id = c.document_id
        WHERE chunks_fts MATCH ? AND c.namespace IN (${placeholders})
        ORDER BY rank ASC, c.namespace ASC, c.document_id ASC, c.ordinal ASC
        LIMIT ?
      `);
      return statement.all(ftsQuery, ...exact, limit).map(rowToResult);
    },

    vectorCandidates(namespaces, limit, offset = 0) {
      const exact = namespaces.map(validateIndexNamespace);
      if (exact.length === 0 || exact.length > 32
        || !Number.isInteger(limit) || limit < 1 || limit > 5_000
        || !Number.isInteger(offset) || offset < 0 || offset > maxChunks) {
        fail('Vector candidate request is invalid');
      }
      const placeholders = exact.map(() => '?').join(', ');
      const statement = database.prepare(`
        SELECT c.namespace, c.document_id, c.ordinal, c.text, c.embedding,
          d.version, d.metadata_json
        FROM chunks c
        JOIN documents d ON d.namespace = c.namespace AND d.document_id = c.document_id
        WHERE c.namespace IN (${placeholders})
        ORDER BY c.namespace ASC, c.document_id ASC, c.ordinal ASC
        LIMIT ? OFFSET ?
      `);
      return statement.all(...exact, limit, offset).map(rowToResult);
    },

    close() {
      if (closed) return;
      closed = true;
      try { database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* In-memory databases have no WAL. */ }
      database.close();
    },
  };
  return Object.freeze(store);
}

export const BOT_INDEX_STORE_LIMITS = Object.freeze({
  defaultMaxDocuments: DEFAULT_MAX_DOCUMENTS,
  defaultMaxChunks: DEFAULT_MAX_CHUNKS,
  defaultMaxStoredBytes: DEFAULT_MAX_STORED_BYTES,
  maxMetadataBytes: MAX_METADATA_BYTES,
});
