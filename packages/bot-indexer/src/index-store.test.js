import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { encodeEmbedding } from './embeddings.js';
import { createIndexStore } from './index-store.js';

const document = ({
  namespace = 'bot:b1',
  documentId = 'd1',
  version = 'v1',
  text = 'alpha shared fact',
  vector = [1, 0],
} = {}) => ({
  namespace,
  documentId,
  version,
  metadata: { source: 'fixture' },
  chunks: [{
    ordinal: 0,
    text,
    bytes: Buffer.byteLength(text),
    embedding: encodeEmbedding(vector),
  }],
});

const withStore = async (operation, options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-index-store-'));
  const databasePath = path.join(directory, 'index.sqlite');
  let store;
  try {
    store = createIndexStore({ databasePath, ...options });
    await operation(store, databasePath);
  } finally {
    store?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
};

describe('local rebuildable Bot index store', () => {
  test('starts rebuild-required and persists a deterministic rebuild', async () => {
    await withStore(async (store, databasePath) => {
      assert.equal(store.status().state, 'rebuild_required');
      const result = store.rebuild([
        document({ namespace: 'channel:c1', documentId: 'private', text: 'private alpha' }),
        document(),
      ]);
      assert.deepEqual(result, { documentCount: 2, chunkCount: 2, storedBytes: result.storedBytes });
      assert.equal(store.status().state, 'ready');
      assert.deepEqual(store.ftsSearch(['bot:b1'], '"alpha"', 10).map((row) => row.documentId), ['d1']);
      store.close();
      store = null;
      const reopened = createIndexStore({ databasePath });
      try {
        assert.equal(reopened.status().state, 'ready');
        assert.equal(reopened.status().documentCount, 2);
      } finally {
        reopened.close();
      }
    });
  });

  test('isolates shared, user-private, and channel-only namespaces exactly', async () => {
    await withStore(async (store) => {
      store.rebuild([
        document({ namespace: 'bot:b1', documentId: 'shared' }),
        document({ namespace: 'bot:b1:user:u1', documentId: 'user-one' }),
        document({ namespace: 'bot:b1:user:u2', documentId: 'user-two' }),
        document({ namespace: 'channel:c1', documentId: 'channel-one' }),
        document({ namespace: 'channel:c2', documentId: 'channel-two' }),
      ]);
      const visible = store.ftsSearch(
        ['bot:b1', 'bot:b1:user:u1', 'channel:c1'],
        '"alpha"',
        10,
      ).map((row) => row.documentId).sort();
      assert.deepEqual(visible, ['channel-one', 'shared', 'user-one']);
    });
  });

  test('orders FTS matches by SQLite relevance before stable identity ties', async () => {
    await withStore(async (store) => {
      store.rebuild([
        document({ documentId: 'sparse', text: `alpha ${'filler '.repeat(80)}` }),
        document({ documentId: 'dense', text: 'alpha alpha alpha alpha' }),
      ]);
      assert.deepEqual(
        store.ftsSearch(['bot:b1'], '"alpha"', 10).map(({ documentId }) => documentId),
        ['dense', 'sparse'],
      );
    });
  });

  test('upserts idempotently, rejects changed canonical versions, and deletes by version', async () => {
    await withStore(async (store) => {
      store.rebuild([document()]);
      assert.deepEqual(store.upsert(document()), { changed: false, version: 'v1' });
      assert.throws(() => store.upsert(document({ text: 'changed' })), {
        code: 'bot_indexer_version_conflict',
      });
      assert.deepEqual(store.upsert(document({ version: 'v2', text: 'new beta' })), {
        changed: true, version: 'v2',
      });
      assert.throws(() => store.delete({ namespace: 'bot:b1', documentId: 'd1', version: 'v1' }), {
        code: 'bot_indexer_version_conflict',
      });
      assert.deepEqual(store.delete({ namespace: 'bot:b1', documentId: 'd1', version: 'v2' }), {
        changed: true,
      });
    });
  });

  test('recovers corrupt files as a fresh rebuild-required index', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-index-corrupt-'));
    const databasePath = path.join(directory, 'index.sqlite');
    try {
      await fs.writeFile(databasePath, 'this is not sqlite');
      const store = createIndexStore({ databasePath });
      try {
        assert.deepEqual(
          { state: store.status().state, reason: store.status().reason, recovered: store.status().recovered },
          { state: 'rebuild_required', reason: 'corrupt_index_recovered', recovered: true },
        );
      } finally {
        store.close();
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('enforces document, chunk, and byte caps before mutation', async () => {
    await withStore(async (store) => {
      assert.throws(() => store.rebuild([document(), document({ documentId: 'd2' })]), {
        code: 'bot_indexer_limit_exceeded',
      });
      assert.equal(store.status().documentCount, 0);
    }, { maxDocuments: 1, maxChunks: 2, maxStoredBytes: 1_024 });

    await withStore(async (store) => {
      assert.throws(() => store.rebuild([document({ text: 'x'.repeat(2_000) })]), {
        code: 'bot_indexer_limit_exceeded',
      });
    }, { maxDocuments: 10, maxChunks: 10, maxStoredBytes: 1_024 });

    await withStore(async (store) => {
      const first = document().chunks[0];
      assert.throws(() => store.rebuild([{
        ...document(),
        chunks: [first, { ...first, ordinal: 1 }],
      }]), { code: 'bot_indexer_limit_exceeded' });
    }, { maxDocuments: 10, maxChunks: 1, maxStoredBytes: 10_000 });
  });
});
