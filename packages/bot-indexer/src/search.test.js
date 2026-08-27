import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeEmbedding } from './embeddings.js';
import {
  botIndexNamespaces,
  createHybridSearch,
  mergeHybridResults,
  rankVectorCandidates,
  toFtsQuery,
  validateIndexNamespace,
} from './search.js';

const row = (documentId, ordinal = 0) => ({
  namespace: 'bot:bot-1', documentId, ordinal, text: documentId, metadata: {}, version: 'v1',
});

describe('Bot hybrid retrieval', () => {
  test('constructs only exact shared, private, and channel namespaces', () => {
    assert.deepEqual(botIndexNamespaces({ botId: 'b1', userId: 'u1', channelId: 'c1' }), [
      'bot:b1', 'bot:b1:user:u1', 'channel:c1',
    ]);
    assert.equal(validateIndexNamespace('bot:b1:user:u1'), 'bot:b1:user:u1');
    assert.throws(() => validateIndexNamespace('bot:b1:user:*'), { code: 'bot_indexer_search_invalid' });
    assert.equal(toFtsQuery('alpha OR "beta"'), '"alpha" OR "or" OR "beta"');
  });

  test('ranks vectors by cosine similarity', () => {
    const ranked = rankVectorCandidates(new Float32Array([1, 0]), [
      { ...row('far'), embedding: encodeEmbedding([0, 1]) },
      { ...row('near'), embedding: encodeEmbedding([0.99, 0.01]) },
    ]);
    assert.deepEqual(ranked.map(({ documentId }) => documentId), ['near', 'far']);
  });

  test('uses reciprocal-rank fusion and stable tie breaking', () => {
    const merged = mergeHybridResults({
      ftsResults: [row('lexical'), row('both')],
      vectorResults: [row('both'), row('semantic')],
      limit: 3,
    });
    assert.equal(merged[0].documentId, 'both');
    assert.deepEqual(merged[0].sources, ['fts', 'vector']);
  });

  test('never widens an authorized namespace set', async () => {
    const calls = [];
    const store = {
      status: () => ({ state: 'ready', chunkCount: 1 }),
      ftsSearch: (namespaces) => { calls.push(namespaces); return [row('lexical')]; },
      vectorCandidates: (namespaces) => { calls.push(namespaces); return []; },
    };
    const search = createHybridSearch({
      store,
      embeddings: { model: { id: 'fixture' }, embed: async () => [new Float32Array([1, 0])] },
    });
    const namespaces = ['bot:b1:user:u1', 'channel:c1'];
    const result = await search.search({ namespaces, query: 'private fact' });
    assert.deepEqual(calls, [namespaces, namespaces]);
    assert.deepEqual(result.namespaces, namespaces);
  });
});
