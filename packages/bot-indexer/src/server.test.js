import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createIndexStore } from './index-store.js';
import {
  createIndexerAuthenticator,
  createIndexerService,
  startIndexerService,
} from './server.js';

const TOKEN = 'a'.repeat(43);

const fixtureEmbeddings = Object.freeze({
  model: Object.freeze({ id: 'fixture', revision: 'fixture' }),
  async embed(texts) {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      const vector = new Float32Array([
        normalized.includes('alpha') ? 1 : 0.05,
        normalized.includes('beta') ? 1 : 0.05,
      ]);
      const magnitude = Math.hypot(...vector);
      return vector.map((value) => value / magnitude);
    });
  },
});

describe('host-only Bot indexer HTTP service', () => {
  let directory;
  let runtime;
  let baseUrl;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-index-server-'));
    const store = createIndexStore({ databasePath: path.join(directory, 'index.sqlite') });
    runtime = await startIndexerService({
      token: TOKEN,
      port: 0,
      host: '127.0.0.1',
      store,
      embeddings: fixtureEmbeddings,
    });
    baseUrl = `http://127.0.0.1:${runtime.address.port}`;
  });

  afterEach(async () => {
    await runtime?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const request = (pathname, body, token = TOKEN) => fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  test('leaves only health unauthenticated', async () => {
    assert.deepEqual(await (await request('/healthz', undefined, null)).json(), { ok: true });
    const response = await request('/v1/status', undefined, null);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'bot_indexer_auth_required');
  });

  test('rebuilds, searches exact namespaces, upserts, and deletes', async () => {
    const rebuild = await request('/v1/rebuild', { documents: [
      { namespace: 'bot:b1', documentId: 'shared', version: 'v1', text: 'alpha shared' },
      { namespace: 'bot:b1:user:u1', documentId: 'u1', version: 'v1', text: 'alpha private one' },
      { namespace: 'bot:b1:user:u2', documentId: 'u2', version: 'v1', text: 'alpha private two' },
    ] });
    assert.equal(rebuild.status, 200);

    const search = await request('/v1/search', {
      namespaces: ['bot:b1', 'bot:b1:user:u1'],
      query: 'alpha',
      limit: 10,
    });
    const ids = (await search.json()).result.results.map(({ documentId }) => documentId).sort();
    assert.deepEqual(ids, ['shared', 'u1']);

    const upsert = await request('/v1/upsert', { document: {
      namespace: 'channel:c1', documentId: 'summary', version: 'v1', text: 'beta summary',
    } });
    assert.equal(upsert.status, 200);
    const deletion = await request('/v1/delete', {
      namespace: 'channel:c1', documentId: 'summary', version: 'v1',
    });
    assert.deepEqual((await deletion.json()).result, { changed: true });
  });

  test('reports a new volume as rebuild-required and rejects premature search', async () => {
    const status = await request('/v1/status');
    assert.equal((await status.json()).status.state, 'rebuild_required');
    const search = await request('/v1/search', {
      namespaces: ['bot:b1'], query: 'alpha', limit: 3,
    });
    assert.equal(search.status, 503);
    assert.equal((await search.json()).error.code, 'bot_indexer_rebuild_required');
  });

  test('uses timing-safe exact bearer syntax', () => {
    const authenticate = createIndexerAuthenticator(TOKEN);
    assert.doesNotThrow(() => authenticate(`Bearer ${TOKEN}`));
    assert.throws(() => authenticate(`bearer ${TOKEN}`), { code: 'bot_indexer_auth_required' });
    assert.throws(() => authenticate(`Bearer ${TOKEN}x`), { code: 'bot_indexer_auth_required' });
  });

  test('serializes concurrent mutations', async () => {
    const store = {
      status: () => ({ state: 'ready', chunkCount: 0 }),
      ftsSearch: () => [],
      vectorCandidates: () => [],
      rebuild: () => ({}),
      delete: () => ({}),
      upsert: () => ({}),
    };
    let active = 0;
    let maximum = 0;
    const service = createIndexerService({
      store,
      embeddings: {
        ...fixtureEmbeddings,
        async embed(texts) {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return fixtureEmbeddings.embed(texts);
        },
      },
    });
    await Promise.all([
      service.upsert({ namespace: 'bot:b1', documentId: 'd1', version: 'v1', text: 'alpha' }),
      service.upsert({ namespace: 'bot:b1', documentId: 'd2', version: 'v1', text: 'beta' }),
    ]);
    assert.equal(maximum, 1);
  });
});
