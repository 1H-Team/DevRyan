import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { hydrateReviewedClaude } from './hydrate-reviewed-claude.mjs';

const cache = new URL('../.cache/release-2.0.0/', import.meta.url);
const relative = 'packages/web/runtime/reviewed-inputs/claude-1.8.0/assets/DevRyan-Claude-darwin-arm64';

test('a changed existing binary is preserved and never replaced by a download', async () => {
  await fs.mkdir(cache, { recursive: true });
  const repository = await fs.mkdtemp(new URL('hydrate-existing-', cache));
  try {
    const destination = path.join(repository, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'changed binary');
    await assert.rejects(hydrateReviewedClaude({ repository, fetchImpl: () => { throw new Error('must not download'); } }), /binary integrity mismatch/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'changed binary');
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('a corrupt download installs no executable and removes temporary bytes', async () => {
  await fs.mkdir(cache, { recursive: true });
  const repository = await fs.mkdtemp(new URL('hydrate-corrupt-', cache));
  try {
    await assert.rejects(hydrateReviewedClaude({ repository, fetchImpl: async () => new Response('corrupt archive') }), /archive integrity mismatch/);
    await assert.rejects(fs.stat(path.join(repository, relative)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(path.join(repository, relative))), []);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});
