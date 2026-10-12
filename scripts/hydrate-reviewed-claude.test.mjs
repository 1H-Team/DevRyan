import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { hydrateReviewedClaude } from './hydrate-reviewed-claude.mjs';
import { REVIEWED_CLAUDE_ASSETS } from '../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';

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
    await assert.rejects(hydrateReviewedClaude({ repository, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.280.tgz');
      assert.equal(options.redirect, 'error');
      return new Response('corrupt archive');
    } }), /archive integrity mismatch/);
    await assert.rejects(fs.stat(path.join(repository, relative)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(path.join(repository, relative))), []);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('the reviewed executable, captured metadata and source manifest pin the model-compatible CLI consistently', async () => {
  const root = new URL('../packages/web/runtime/reviewed-inputs/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', root), 'utf8'));
  const capture = manifest.inputs.find(input => input.id === 'claude-1.8.0');
  const asset = capture.files.find(file => file.path === 'assets/' + REVIEWED_CLAUDE_ASSETS.claude.path);
  const metadata = JSON.parse(await fs.readFile(new URL('claude-1.8.0/node_modules/@anthropic-ai/claude-code-darwin-arm64/package.json', root), 'utf8'));
  const provenance = JSON.parse(await fs.readFile(new URL('claude-1.8.0/provenance.json', root), 'utf8'));
  assert.equal(REVIEWED_CLAUDE_ASSETS.claude.version, '2.1.280');
  assert.equal(metadata.version, REVIEWED_CLAUDE_ASSETS.claude.version);
  assert.equal(asset.sha256, REVIEWED_CLAUDE_ASSETS.claude.sha256);
  assert.equal(asset.size, 217254576);
  assert.equal(provenance.nativeExecutable.version, metadata.version);
  assert.equal(provenance.nativeExecutable.sha256, asset.sha256);
  assert.equal(provenance.nativeExecutable.archiveIntegrity, 'sha512-ctkNgja8Yi2kngVFPO2667k6zbtJwjQ+dOTeEp1XmzHcoDFdaee4h4WVgZllsewm/Io+pPPPSFQVdGHOtdE/1A==');
});
