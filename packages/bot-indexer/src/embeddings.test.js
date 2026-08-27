import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  BOT_EMBEDDING_MODEL,
  createEmbeddingService,
  decodeEmbedding,
  encodeEmbedding,
  verifyEmbeddingCache,
} from './embeddings.js';

describe('offline Bot embeddings', () => {
  test('pins the model and normalizes deterministic batches', async () => {
    const calls = [];
    const service = createEmbeddingService({
      cacheDirectory: '/models',
      loadPipeline: async (configuration) => {
        calls.push(configuration);
        return async (texts, options) => {
          calls.push({ texts, options });
          return { tolist: () => texts.map((text) => [text.length, 2]) };
        };
      },
    });
    const vectors = await service.embed(['one', 'three']);
    assert.equal(calls[0].model.revision, BOT_EMBEDDING_MODEL.revision);
    assert.deepEqual(calls[1].options, { pooling: 'mean', normalize: true });
    assert.equal(vectors.length, 2);
    assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 1e-6);
    assert.deepEqual([...decodeEmbedding(encodeEmbedding(vectors[1]))], [...vectors[1]]);
  });

  test('loads a pipeline once and refuses malformed vectors', async () => {
    let loads = 0;
    const service = createEmbeddingService({
      cacheDirectory: '/models',
      loadPipeline: async () => {
        loads += 1;
        return async () => ({ tolist: () => [[1, 0]] });
      },
    });
    await service.embed(['a']);
    await service.embed(['b']);
    assert.equal(loads, 1);
    assert.throws(() => encodeEmbedding([Number.NaN]), { code: 'bot_indexer_embedding_failed' });
  });

  test('verifies every cached file and requires the pinned ONNX graph hash', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-index-model-'));
    try {
      const graphPath = path.join(directory, 'model_quantized.onnx');
      await fs.writeFile(graphPath, 'fixture');
      const manifestPath = path.join(directory, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify({
        model: BOT_EMBEDDING_MODEL,
        files: [{
          path: 'model_quantized.onnx',
          sha256: BOT_EMBEDDING_MODEL.onnxSha256,
        }],
      }));
      await assert.rejects(() => verifyEmbeddingCache({ cacheDirectory: directory, manifestPath }), {
        code: 'bot_indexer_model_integrity_failed',
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
