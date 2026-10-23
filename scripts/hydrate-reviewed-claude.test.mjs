import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadPinnedClaude, hydrateReviewedClaude } from './hydrate-reviewed-claude.mjs';
import { REVIEWED_CLAUDE_ASSETS } from '../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';

const relative = 'packages/web/runtime/reviewed-inputs/claude-1.8.0/assets/DevRyan-Claude-darwin-arm64';

test('portable hydration verifies the pinned archive before writing an executable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-hydrate-portable-'));
  try {
    await assert.rejects(downloadPinnedClaude(directory, async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.302.tgz');
      assert.equal(options.redirect, 'error');
      return new Response('corrupt archive');
    }), /claude_archive_integrity/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a changed existing binary is preserved and never replaced by a download', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-hydrate-existing-'));
  try {
    const destination = path.join(repository, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'changed binary');
    await assert.rejects(hydrateReviewedClaude({ repository, fetchImpl: () => { throw new Error('must not download'); } }), /binary integrity mismatch/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'changed binary');
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('a corrupt download installs no executable and removes temporary bytes', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-hydrate-corrupt-'));
  try {
    await assert.rejects(hydrateReviewedClaude({ repository, fetchImpl: async (url, options) => {
      if (url.endsWith('/2.1.302')) return Response.json({ name: '@anthropic-ai/claude-code-darwin-arm64', version: '2.1.302', dist: { tarball: 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.302.tgz', integrity: 'sha512-h0MlQtldJnHXdPB6KGQ6rYQocvNTEXBI+NW4791OD2mIZcq6fHrV4PsM+XK297OL0+wVENlDHtlBj1BL/3S52A==' } });
      assert.equal(url, 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.302.tgz');
      assert.equal(options.redirect, 'error');
      return new Response('corrupt archive');
    } }), /claude_archive_integrity/);
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
  assert.equal(REVIEWED_CLAUDE_ASSETS.claude.version, '2.1.302');
  assert.equal(metadata.version, REVIEWED_CLAUDE_ASSETS.claude.version);
  assert.equal(asset.sha256, REVIEWED_CLAUDE_ASSETS.claude.sha256);
  assert.equal(asset.size, 267956720);
  assert.equal(provenance.nativeExecutable.version, metadata.version);
  assert.equal(provenance.nativeExecutable.sha256, asset.sha256);
  assert.equal(provenance.nativeExecutable.archiveIntegrity, 'sha512-h0MlQtldJnHXdPB6KGQ6rYQocvNTEXBI+NW4791OD2mIZcq6fHrV4PsM+XK297OL0+wVENlDHtlBj1BL/3S52A==');
});

test('a worktree reuses a verified copy from the main checkout and ignores an unverified one', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-hydrate-worktree-'));
  const corrupt = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-hydrate-source-'));
  try {
    await fs.mkdir(path.dirname(path.join(corrupt, relative)), { recursive: true });
    await fs.writeFile(path.join(corrupt, relative), 'not the reviewed binary');
    // The unverified source is skipped, so hydration falls through to a download.
    await assert.rejects(hydrateReviewedClaude({ repository, sources: [corrupt], fetchImpl: async () => { throw new Error('download attempted'); } }), /download attempted/);
    await assert.rejects(fs.stat(path.join(repository, relative)), { code: 'ENOENT' });

    const checkout = path.resolve(import.meta.dirname, '..');
    const reviewed = path.join(checkout, relative);
    const available = await fs.stat(reviewed).then(stat => stat.size === 267956720, () => false);
    if (!available) return;
    const installed = await hydrateReviewedClaude({ repository, sources: [checkout], fetchImpl: () => { throw new Error('must not download'); } });
    assert.equal(installed, path.join(repository, relative));
    assert.equal((await fs.stat(installed)).size, 267956720);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
    await fs.rm(corrupt, { recursive: true, force: true });
  }
});
