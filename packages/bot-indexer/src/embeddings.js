import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BOT_EMBEDDING_MODEL = Object.freeze({
  id: 'Xenova/all-MiniLM-L6-v2',
  revision: '08a308f628bc9d6774b7922f319eb1b65afa1a82',
  quantized: true,
  onnxSha256: '2f9a2cd8a5955f62908d5087be47516e9d91849f50579c3e47c73fd2c563b224',
});

const MAX_EMBEDDING_BATCH = 256;
const MAX_EMBEDDING_TEXT_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

export class BotEmbeddingError extends Error {
  constructor(message, code = 'bot_indexer_embedding_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotEmbeddingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotEmbeddingError(message, code, statusCode);
};

const normalizeVector = (raw) => {
  if (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) {
    fail('Embedding model returned an invalid vector', 'bot_indexer_embedding_failed', 502);
  }
  const vector = Float32Array.from(raw);
  if (vector.length === 0 || vector.length > 4_096) {
    fail('Embedding model returned an invalid dimension', 'bot_indexer_embedding_failed', 502);
  }
  let magnitudeSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      fail('Embedding model returned a non-finite value', 'bot_indexer_embedding_failed', 502);
    }
    magnitudeSquared += value * value;
  }
  if (magnitudeSquared === 0) {
    fail('Embedding model returned an empty direction', 'bot_indexer_embedding_failed', 502);
  }
  const magnitude = Math.sqrt(magnitudeSquared);
  for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
  return vector;
};

const normalizeBatchOutput = (output, expectedCount) => {
  const raw = typeof output?.tolist === 'function' ? output.tolist() : output;
  const rows = expectedCount === 1 && Array.isArray(raw) && typeof raw[0] === 'number'
    ? [raw]
    : raw;
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    fail('Embedding model returned an invalid batch', 'bot_indexer_embedding_failed', 502);
  }
  const normalized = rows.map(normalizeVector);
  const dimension = normalized[0]?.length;
  if (!dimension || normalized.some((vector) => vector.length !== dimension)) {
    fail('Embedding model returned inconsistent dimensions', 'bot_indexer_embedding_failed', 502);
  }
  return Object.freeze(normalized);
};

const validateTexts = (texts) => {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBEDDING_BATCH
    || texts.some((value) => typeof value !== 'string' || value.length === 0)
    || Buffer.byteLength(texts.join(''), 'utf8') > MAX_EMBEDDING_TEXT_BYTES) {
    fail('Embedding batch is invalid');
  }
  return texts;
};

const defaultPipelineLoader = async ({ cacheDirectory, model }) => {
  const transformers = await import('@xenova/transformers');
  transformers.env.cacheDir = cacheDirectory;
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  return transformers.pipeline('feature-extraction', model.id, {
    revision: model.revision,
    quantized: model.quantized,
  });
};

export function createEmbeddingService({
  cacheDirectory,
  model = BOT_EMBEDDING_MODEL,
  loadPipeline = defaultPipelineLoader,
} = {}) {
  if (typeof cacheDirectory !== 'string' || !path.isAbsolute(cacheDirectory)
    || !model || typeof model.id !== 'string' || !REVISION_PATTERN.test(model.revision)
    || typeof loadPipeline !== 'function') {
    fail('Embedding service configuration is invalid', 'bot_indexer_embedding_configuration_invalid', 500);
  }
  let pipelinePromise;
  const getPipeline = async () => {
    pipelinePromise ||= Promise.resolve(loadPipeline({ cacheDirectory, model })).catch((error) => {
      pipelinePromise = undefined;
      throw new BotEmbeddingError(
        `Offline embedding model is unavailable: ${error instanceof Error ? error.message : 'load failed'}`,
        'bot_indexer_model_unavailable',
        503,
      );
    });
    return pipelinePromise;
  };
  return Object.freeze({
    model,
    async embed(texts) {
      validateTexts(texts);
      const extractor = await getPipeline();
      let output;
      try {
        output = await extractor(texts, { pooling: 'mean', normalize: true });
      } catch (error) {
        throw new BotEmbeddingError(
          `Embedding failed: ${error instanceof Error ? error.message : 'model failure'}`,
          'bot_indexer_embedding_failed',
          502,
        );
      }
      return normalizeBatchOutput(output, texts.length);
    },
  });
}

export function encodeEmbedding(vector) {
  const normalized = normalizeVector(vector);
  const buffer = Buffer.allocUnsafe(normalized.length * 4);
  for (let index = 0; index < normalized.length; index += 1) {
    buffer.writeFloatLE(normalized[index], index * 4);
  }
  return buffer;
}

export function decodeEmbedding(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0 || buffer.byteLength > 16 * 1024) {
    fail('Stored embedding is invalid', 'bot_indexer_corrupt', 500);
  }
  const vector = new Float32Array(buffer.byteLength / 4);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = buffer.readFloatLE(index * 4);
  }
  return vector;
}

const hashFile = async (filePath) => {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
};

export async function verifyEmbeddingCache({ cacheDirectory, manifestPath } = {}) {
  if (typeof cacheDirectory !== 'string' || !path.isAbsolute(cacheDirectory)
    || typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) {
    fail('Embedding cache verification paths are invalid', 'bot_indexer_model_manifest_invalid', 500);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    fail('Embedding cache manifest is unavailable', 'bot_indexer_model_manifest_invalid', 503);
  }
  if (manifest?.model?.id !== BOT_EMBEDDING_MODEL.id
    || manifest?.model?.revision !== BOT_EMBEDDING_MODEL.revision
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('Embedding cache manifest does not match the pinned model', 'bot_indexer_model_manifest_invalid', 503);
  }
  let foundPinnedOnnx = false;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || path.isAbsolute(entry.path)
      || entry.path.includes('..') || !SHA256_PATTERN.test(entry.sha256)) {
      fail('Embedding cache manifest contains an invalid file', 'bot_indexer_model_manifest_invalid', 503);
    }
    const actual = await hashFile(path.join(cacheDirectory, entry.path)).catch(() => null);
    if (actual !== entry.sha256) {
      fail('Embedding cache integrity check failed', 'bot_indexer_model_integrity_failed', 503);
    }
    if (entry.sha256 === BOT_EMBEDDING_MODEL.onnxSha256) foundPinnedOnnx = true;
  }
  if (!foundPinnedOnnx) {
    fail('Pinned embedding graph is absent from the cache manifest', 'bot_indexer_model_integrity_failed', 503);
  }
  return Object.freeze({ files: manifest.files.length, model: BOT_EMBEDDING_MODEL });
}

export const BOT_EMBEDDING_LIMITS = Object.freeze({
  maxBatch: MAX_EMBEDDING_BATCH,
  maxTextBytes: MAX_EMBEDDING_TEXT_BYTES,
});
