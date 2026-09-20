import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeEmbedding, decodeEmbedding } from './embeddings.js';
import {
  botIndexNamespaces,
  createHybridSearch,
  createVectorAccumulator,
  cosineSimilarity,
  mergeHybridResults,
  rankVectorCandidates,
  toFtsQuery,
  validateIndexNamespace,
} from './search.js';

const row = (documentId, ordinal = 0) => ({
  namespace: 'bot:bot-1', documentId, ordinal, text: documentId, metadata: {}, version: 'v1',
});

describe('Bot hybrid retrieval', () => {
  test('bounded accumulation matches a full exact sort across batches and tied scores', () => {
    const query = new Float32Array([1, 0]);
    const candidates = Array.from({ length: 3200 }, (_, i) => ({ ...row(`doc-${i % 701}`, i),
      namespace: i % 2 ? 'channel:c1' : 'bot:bot-1', embedding: encodeEmbedding([1 + (i % 17), 1 + (i % 11)]) }));
    const reference = candidates.map(candidate => ({ ...candidate,
      vectorScore: cosineSimilarity(query, decodeEmbedding(candidate.embedding)),
    })).sort((a, b) => b.vectorScore - a.vectorScore || a.namespace.localeCompare(b.namespace)
      || a.documentId.localeCompare(b.documentId) || a.ordinal - b.ordinal);
    for (const limit of [1, 10, 50, 500]) {
      const accumulator = createVectorAccumulator(query, limit);
      for (const candidate of candidates) accumulator.add(candidate);
      assert.deepEqual(accumulator.results(), reference.slice(0, limit));
    }
  });
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
