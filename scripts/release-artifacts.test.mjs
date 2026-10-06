import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeWebArtifact, stageWebArtifact, verifyWebArtifact, verifyPreparedMetadata, assertBotInputPreparation, assertReleaseWritesAllowed } from './release-artifacts.mjs';
import { packagePrepared } from '../packages/electron/scripts/package-prepared.mjs';

const identity = { revision: 'a'.repeat(40), release: '1.2.3', lockfile: 'b'.repeat(64) };
test('Bot input preparation requires a source-bound manual tag and never overrides dry-run refusal', () => {
  const ref = `refs/tags/v${identity.release}-bot-inputs-${identity.revision.slice(0, 12)}`;
  const environment = { RELEASE_BOT_INPUTS_ONLY: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: identity.revision, GITHUB_REF: ref, GITHUB_REPOSITORY: '1H-Team/DevRyan',
    GITHUB_WORKFLOW_REF: `1H-Team/DevRyan/.github/workflows/release.yml@${ref}` };
  assert.equal(assertBotInputPreparation(environment, identity.release), true);
  assertReleaseWritesAllowed(environment);
  assert.throws(() => assertReleaseWritesAllowed({ ...environment, RELEASE_DRY_RUN: 'true' }), { code: 'release_dry_run_write_forbidden' });
  assert.throws(() => assertBotInputPreparation(environment, '1.2.4'), { code: 'bot_input_preparation_identity_invalid' });
  for (const change of [{ RELEASE_BOT_INPUTS_ONLY: 'yes' }, { GITHUB_ACTIONS: undefined }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_SHA: 'a'.repeat(39) }, { GITHUB_REF: 'refs/heads/release/2.0.2' },
    { GITHUB_REF: 'refs/tags/v1.2.3' }, { GITHUB_REPOSITORY: '1H-Team/DevRyan/other' },
    { GITHUB_WORKFLOW_REF: `1H-Team/DevRyan/.github/workflows/other.yml@${ref}` }]) {
    assert.throws(() => assertReleaseWritesAllowed({ ...environment, ...change }), { code: 'bot_input_preparation_identity_invalid' });
  }
  assert.equal(assertBotInputPreparation({}), false);
  assert.equal(assertBotInputPreparation({ RELEASE_BOT_INPUTS_ONLY: 'false' }), false);
});

test('web handoff preserves hidden manifests and rejects changed identity, missing and corrupt files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-web-artifact-'));
  try {
    const source = path.join(root, 'source');
    await fs.mkdir(path.join(source, '.vite'), { recursive: true });
    for (const name of ['index.html', 'mini-chat.html', 'browser.html', 'sw.js', '.vite/manifest.json']) await fs.writeFile(path.join(source, name), name);
    const metadata = await describeWebArtifact(source, identity);
    await stageWebArtifact({ source, metadata, identity, destination: path.join(root, 'staged') });
    await verifyWebArtifact(path.join(root, 'staged'), metadata, identity);
    await assert.rejects(verifyWebArtifact(source, metadata, { ...identity, revision: 'c'.repeat(40) }), /mismatch/);
    await fs.writeFile(path.join(source, 'sw.js'), 'corrupt');
    await assert.rejects(verifyWebArtifact(source, metadata, identity), /mismatch/);
    await fs.rm(path.join(source, 'index.html'));
    await assert.rejects(verifyWebArtifact(source, metadata, identity), /Missing/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('prepared native archive is bound to architecture, commit and bytes', () => {
  const metadata = { version: 1, kind: 'electron-prepared', ...identity, arch: 'arm64', archiveHash: 'abc' };
  verifyPreparedMetadata(metadata, identity, 'arm64', 'abc');
  assert.throws(() => verifyPreparedMetadata(metadata, identity, 'x64', 'abc'), /mismatch/);
  assert.throws(() => verifyPreparedMetadata(metadata, identity, 'arm64', 'def'), /mismatch/);
  assert.throws(() => verifyPreparedMetadata(metadata, { ...identity, lockfile: 'other' }, 'arm64', 'abc'), /mismatch/);
});

test('packaging requires verified manifest before invoking builder and verifies built artifacts', async () => {
  const calls = [];
  const options = { arch: 'x64', builder: () => 'builder', execute: (args) => calls.push(args),
    stageManifest: async (args) => { assert.equal(args.required, true); calls.push('manifest'); },
    verifyRuntime: async (args) => { assert.equal(args.arch, 'x64'); calls.push('revert-runtime'); } };
  await packagePrepared(options);
  assert.deepEqual(calls, ['manifest', 'revert-runtime', ['builder'], ['./scripts/verify-runtime-service-package.mjs', '--arch', 'x64']]);
  calls.length = 0;
  await assert.rejects(packagePrepared({ ...options, stageManifest: async () => { throw new Error('invalid'); } }), /invalid/);
  assert.equal(calls.length, 0);
  await assert.rejects(packagePrepared({ ...options, verifyRuntime: async () => { throw new Error('unverified runtime'); } }), /unverified runtime/);
  assert.deepEqual(calls, ['manifest']);
  await assert.rejects(packagePrepared({ ...options, execute: () => { throw new Error('builder failed'); } }), /builder failed/);
});
