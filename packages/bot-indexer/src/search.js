import { decodeEmbedding } from './embeddings.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAMESPACES = 32;
const MAX_QUERY_BYTES = 16 * 1024;
const MAX_RESULTS = 50;
const RRF_CONSTANT = 60;

export class BotSearchError extends Error {
  constructor(message, code = 'bot_indexer_search_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotSearchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotSearchError(message, code, statusCode);
};

export function validateIndexNamespace(namespace) {
  if (typeof namespace !== 'string') fail('Index namespace is invalid');
  const parts = namespace.split(':');
  const valid = (parts.length === 2 && parts[0] === 'channel' && ID_PATTERN.test(parts[1]))
    || (parts.length === 2 && parts[0] === 'bot' && ID_PATTERN.test(parts[1]))
    || (parts.length === 4 && parts[0] === 'bot' && ID_PATTERN.test(parts[1])
      && parts[2] === 'user' && ID_PATTERN.test(parts[3]));
  if (!valid) fail('Index namespace is invalid');
  return namespace;
}

export function botIndexNamespaces({ botId, userId, channelId } = {}) {
  if (![botId, userId, channelId].every((value) => typeof value === 'string' && ID_PATTERN.test(value))) {
    fail('Bot index scope is invalid');
  }
  return Object.freeze([
    `bot:${botId}`,
    `bot:${botId}:user:${userId}`,
    `channel:${channelId}`,
  ]);
}

export function normalizeSearchNamespaces(namespaces) {
  if (!Array.isArray(namespaces) || namespaces.length === 0 || namespaces.length > MAX_NAMESPACES) {
    fail('Search namespaces are invalid');
  }
  const unique = [...new Set(namespaces.map(validateIndexNamespace))];
  if (unique.length !== namespaces.length) fail('Search namespaces must be unique');
  return Object.freeze(unique);
}

export function toFtsQuery(query) {
  if (typeof query !== 'string' || query.trim().length === 0
    || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    fail('Search query is invalid');
  }
  const tokens = query.normalize('NFKC').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 32) || [];
  if (tokens.length === 0) return null;
  return [...new Set(tokens)].map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

export function cosineSimilarity(left, right) {
  if ((!Array.isArray(left) && !ArrayBuffer.isView(left))
    || (!Array.isArray(right) && !ArrayBuffer.isView(right))
    || left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return Number.NEGATIVE_INFINITY;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

const resultKey = (result) => `${result.namespace}\0${result.documentId}\0${result.ordinal}`;

export function mergeHybridResults({ ftsResults, vectorResults, limit = 10 } = {}) {
  if (!Array.isArray(ftsResults) || !Array.isArray(vectorResults)
    || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    fail('Hybrid search inputs are invalid');
  }
  const merged = new Map();
  const add = (result, rank, source, weight) => {
    const key = resultKey(result);
    const current = merged.get(key) || { ...result, score: 0, sources: [] };
    current.score += weight / (RRF_CONSTANT + rank + 1);
    current.sources.push(source);
    merged.set(key, current);
  };
  ftsResults.forEach((result, rank) => add(result, rank, 'fts', 0.55));
  vectorResults.forEach((result, rank) => add(result, rank, 'vector', 0.45));
  return [...merged.values()]
    .sort((left, right) => right.score - left.score
      || left.namespace.localeCompare(right.namespace)
      || left.documentId.localeCompare(right.documentId)
      || left.ordinal - right.ordinal)
    .slice(0, limit)
    .map((result) => Object.freeze({ ...result, sources: Object.freeze(result.sources) }));
}

const compareVectorResults = (left, right) => right.vectorScore - left.vectorScore
  || left.namespace.localeCompare(right.namespace)
  || left.documentId.localeCompare(right.documentId)
  || left.ordinal - right.ordinal;

// Worst-first heap: one decode/score per candidate, O(k) retained rows, and
// O(log k) admission. Existing tie-breaking and cosine arithmetic stay exact.
export function createVectorAccumulator(queryVector, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    fail('Vector search inputs are invalid');
  }
  const heap = [];
  return {
    add(candidate) {
      const vectorScore = cosineSimilarity(queryVector, decodeEmbedding(candidate.embedding));
      if (!Number.isFinite(vectorScore)) return;
      const next = { ...candidate, vectorScore };
      if (heap.length < limit) {
        heap.push(next);
        let index = heap.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (compareVectorResults(heap[index], heap[parent]) <= 0) break;
          [heap[index], heap[parent]] = [heap[parent], heap[index]];
          index = parent;
        }
        return;
      }
      if (compareVectorResults(next, heap[0]) >= 0) return;
      heap[0] = next;
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compareVectorResults(heap[child + 1], heap[child]) > 0) child += 1;
        if (compareVectorResults(heap[child], heap[index]) <= 0) break;
        [heap[index], heap[child]] = [heap[child], heap[index]];
        index = child;
      }
    },
    results: () => heap.slice().sort(compareVectorResults),
  };
}

export function rankVectorCandidates(queryVector, candidates, limit = 50) {
  if (!Array.isArray(candidates)) fail('Vector search inputs are invalid');
  const accumulator = createVectorAccumulator(queryVector, limit);
  for (const candidate of candidates) accumulator.add(candidate);
  return accumulator.results();
}

export function createHybridSearch({ store, embeddings } = {}) {
  if (!store || typeof store.ftsSearch !== 'function' || typeof store.vectorCandidates !== 'function'
    || !embeddings || typeof embeddings.embed !== 'function') {
    fail('Hybrid search dependencies are invalid', 'bot_indexer_search_configuration_invalid', 500);
  }
  return Object.freeze({
    async search({ namespaces, query, limit = 10 } = {}) {
      const authorized = normalizeSearchNamespaces(namespaces);
      const ftsQuery = toFtsQuery(query);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) fail('Search limit is invalid');
      const status = store.status();
      if (status.state !== 'ready') {
        fail('Local retrieval index requires a rebuild', 'bot_indexer_rebuild_required', 503);
      }
      const [queryVector] = await embeddings.embed([query]);
      const candidateLimit = Math.min(500, Math.max(50, limit * 10));
      const ftsResults = ftsQuery ? store.ftsSearch(authorized, ftsQuery, candidateLimit) : [];
      const accumulator = createVectorAccumulator(queryVector, candidateLimit);
      const batchSize = 1_000;
      let cursor = null;
      for (let offset = 0; offset < status.chunkCount; offset += batchSize) {
        const candidates = typeof store.vectorCandidatesAfter === 'function'
          ? store.vectorCandidatesAfter(authorized, batchSize, cursor)
          : store.vectorCandidates(authorized, batchSize, offset);
        if (candidates.length === 0) break;
        for (const candidate of candidates) accumulator.add(candidate);
        const last = candidates[candidates.length - 1];
        cursor = { namespace: last.namespace, documentId: last.documentId, ordinal: last.ordinal };
        if (candidates.length < batchSize) break;
      }
      return Object.freeze({
        results: Object.freeze(mergeHybridResults({ ftsResults, vectorResults: accumulator.results(), limit })),
        namespaces: authorized,
        model: embeddings.model,
      });
    },
  });
}

export const BOT_SEARCH_LIMITS = Object.freeze({
  maxNamespaces: MAX_NAMESPACES,
  maxQueryBytes: MAX_QUERY_BYTES,
  maxResults: MAX_RESULTS,
});
