import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { BOT_RUNTIME_IMAGE_KEYS } from '../packages/electron/bot-runtime-manifest.mjs';
import { BOT_RUNTIME_IMAGE_DEFINITIONS } from './build-bot-runtime-images.mjs';
import {
  BOT_RUNTIME_IMAGE_SIGNER_ISSUER,
  botRuntimeImageInputTag,
  botRuntimeImageSignerIdentity,
  readBotRuntimeImageInputs,
} from './bot-runtime-image-inputs.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'a'.repeat(40);

async function checkout(t, extra = []) {
  const parent = path.join(repository, '.cache/test-fixtures');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'release-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of [
    'package.json', 'bun.lock', 'scripts/release-ci.mjs',
    'scripts/release-artifacts.mjs', 'scripts/build-bot-runtime-images.mjs',
    'scripts/verify-bot-runtime-images.mjs', 'scripts/bot-runtime-image-inputs.mjs',
    'packages/electron/bot-runtime-manifest.mjs',
    'packages/electron/release-assets.mjs', 'scripts/verify-release-assets.mjs',
    'packages/web/server/lib/opencode/version-policy.js',
    ...extra,
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(repository, file), path.join(root, file));
  }
  return root;
}

function run(root, operation, environment = {}) {
  return spawnSync(process.execPath, ['scripts/release-ci.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { GITHUB_SHA: revision, GITHUB_REPOSITORY_OWNER: '1H-Team',
      RELEASE_OPERATION: operation, ...environment },
  });
}

test('image planning succeeds in a checkout without installed runtime dependencies', async t => {
  const root = await checkout(t), output = path.join(root, 'image-output');
  const result = run(root, 'image-plan', { IMAGE_KEY: 'computer', GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  const fields = await fs.readFile(output, 'utf8');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(fields, `dockerfile=packages/bot-computer/Dockerfile\nrepository=ghcr.io/1h-team/devryan-bot-computer\ntags=ghcr.io/1h-team/devryan-bot-computer:${version},ghcr.io/1h-team/devryan-bot-computer:sha-${revision.slice(0, 12)}\n`);
});

test('prepared import checks archive identity before dependencies have been restored', async t => {
  const root = await checkout(t), output = path.join(root, 'artifacts');
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'prepared.json'), '{}');
  await fs.writeFile(path.join(output, 'prepared.tar.zst'), 'not a prepared archive');
  const result = run(root, 'prepare-import', { ELECTRON_BUILDER_ARCH: 'arm64' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Prepared Electron artifact mismatch/);
  assert.equal(result.error, undefined);
});

// Image sources plus the release metadata inputs, without installed dependencies.
async function imageCheckout(t) {
  const files = new Set(['packages/web/server/lib/multi-user/auth-compat.js']);
  for (const key of BOT_RUNTIME_IMAGE_KEYS) {
    files.add(BOT_RUNTIME_IMAGE_DEFINITIONS[key].packageJson);
    for (const entry of (await readBotRuntimeImageInputs({ key, root: repository })).files) files.add(entry.file);
  }
  return checkout(t, [...files]);
}

const digestOf = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

// Fake docker and cosign executables: the only binaries on PATH, so no real registry is reached.
async function fakeRegistry(root, { missing = false } = {}) {
  const directory = path.join(root, 'fake-registry'), bin = path.join(directory, 'bin');
  await fs.mkdir(bin, { recursive: true });
  // The checkout's package.json is an ES module scope; the fake executables are CommonJS.
  await fs.writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  const attestations = ['c', 'd'].map((character) => Buffer.from(JSON.stringify({ layers: [
    { digest: `sha256:${character.repeat(64)}`, annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' } },
    { digest: `sha256:${'f'.repeat(64)}`, annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' } },
  ] })));
  const index = Buffer.from(JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    { digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
    ...attestations.map((bytes, position) => ({ digest: digestOf(bytes), annotations: {
      'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': `sha256:${'ab'[position].repeat(64)}`,
    } })),
  ] }));
  await fs.writeFile(path.join(directory, 'index.json'), index);
  await fs.writeFile(path.join(directory, `${digestOf(index).slice(7)}.json`), index);
  for (const bytes of attestations) await fs.writeFile(path.join(directory, `${digestOf(bytes).slice(7)}.json`), bytes);
  const log = path.join(directory, 'calls.log');
  const program = (body) => `#!${process.execPath}\nconst fs = require('node:fs'), path = require('node:path');\nconst args = process.argv.slice(2), directory = ${JSON.stringify(directory)};\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([path.basename(process.argv[1]), ...args]) + '\\n');\n${body}\n`;
  await fs.writeFile(path.join(bin, 'docker'), program(`
if (args[0] === 'manifest') {
  if (${missing}) { process.stderr.write('manifest unknown'); process.exit(1); }
  process.exit(0);
}
if (args.slice(0, 4).join(' ') === 'buildx imagetools inspect --raw') {
  const reference = args[4];
  const file = reference.includes(':in-') ? 'index.json' : reference.split('@sha256:')[1] + '.json';
  process.stdout.write(fs.readFileSync(path.join(directory, file)));
  process.exit(0);
}
if (args.slice(0, 4).join(' ') === 'buildx imagetools create --tag') process.exit(0);
process.exit(2);`), { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'cosign'), program(`
if (args[0] === 'verify') { process.stdout.write('[{"critical":{}}]'); process.exit(0); }
if (args[0] === 'sign') process.exit(0);
process.exit(2);`), { mode: 0o755 });
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { PATH: bin, indexDigest: digestOf(index), calls };
}

const version = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8')).version;
const workflow = { GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_REF: `refs/tags/v${version}`, GITHUB_WORKFLOW_REF: `1H-Team/DevRyan/.github/workflows/release.yml@refs/tags/v${version}` };
const inputRef = `refs/tags/v${version}-bot-inputs-${revision.slice(0, 12)}`;
const preparation = { ...workflow, RELEASE_BOT_INPUTS_ONLY: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: inputRef, GITHUB_WORKFLOW_REF: `1H-Team/DevRyan/.github/workflows/release.yml@${inputRef}` };

test('Bot-only preparation plans immutable image tags and refuses every application operation before writing', async t => {
  const root = await checkout(t), output = path.join(root, 'image-output');
  let result = run(root, 'image-plan', { ...preparation, IMAGE_KEY: 'rest', GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await fs.readFile(output, 'utf8'), new RegExp(`tags=ghcr.io/1h-team/devryan-bot-rest:sha-${revision.slice(0, 12)}\\n$`));
  await fs.rm(output);
  for (const operation of ['asset-describe', 'web-pack', 'web-describe', 'web-stage', 'prepare-export', 'prepare-import']) {
    result = run(root, operation, { ...preparation, GITHUB_OUTPUT: output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bot input preparation prohibits application release operations/);
    assert.equal(await fs.stat(path.join(root, 'artifacts')).catch(() => null), null);
    assert.equal(await fs.stat(output).catch(() => null), null);
  }
  result = run(root, 'image-plan', { ...preparation, GITHUB_SHA: 'b'.repeat(40), IMAGE_KEY: 'rest', GITHUB_OUTPUT: output });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Bot input preparation requires/);
  assert.equal(await fs.stat(output).catch(() => null), null);
});

test('Bot-only preparation signs trusted input tags and dry runs still make no registry writes', async t => {
  const root = await imageCheckout(t), registry = await fakeRegistry(root);
  const signing = { ...preparation, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture',
    IMAGE_KEY: 'rest', IMAGE_DIGEST: registry.indexDigest, PATH: registry.PATH };
  const result = run(root, 'image-sign', signing);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(new RegExp(botRuntimeImageSignerIdentity('1H-Team/DevRyan')).test(`https://github.com/${preparation.GITHUB_WORKFLOW_REF}`));
  const { digest } = await readBotRuntimeImageInputs({ key: 'rest', root });
  assert.ok((await registry.calls()).some(call => call.includes(`ghcr.io/1h-team/devryan-bot-rest:${botRuntimeImageInputTag(digest)}`)));
  await fs.rm(path.join(root, 'fake-registry/calls.log'));
  for (const change of [{ RELEASE_DRY_RUN: 'true' }, { GITHUB_REF: workflow.GITHUB_REF }, { GITHUB_EVENT_NAME: 'push' }]) {
    const refused = run(root, 'image-sign', { ...signing, ...change });
    assert.notEqual(refused.status, 0);
    assert.deepEqual(await registry.calls(), []);
  }
});

test('image resolution reuses a verified input-tagged image as an image-sign result', async t => {
  const root = await imageCheckout(t), output = path.join(root, 'image-output');
  const registry = await fakeRegistry(root);
  const result = run(root, 'image-resolve', { ...workflow, IMAGE_KEY: 'rest', GITHUB_OUTPUT: output, PATH: registry.PATH });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), 'build=[]\n');
  const reused = JSON.parse(await fs.readFile(path.join(root, 'artifacts/rest.json'), 'utf8'));
  assert.equal(reused.key, 'rest');
  assert.equal(reused.releaseId, version);
  assert.equal(reused.sourceRevision, revision);
  assert.equal(reused.image.repository, 'ghcr.io/1h-team/devryan-bot-rest');
  assert.equal(reused.image.indexDigest, registry.indexDigest);
  const { digest } = await readBotRuntimeImageInputs({ key: 'rest', root });
  const calls = await registry.calls();
  assert.ok(calls.some((call) => call.join(' ') === `docker manifest inspect ghcr.io/1h-team/devryan-bot-rest:${botRuntimeImageInputTag(digest)}`));
  const verified = calls.filter((call) => call[0] === 'cosign');
  assert.equal(verified.length, 3);
  for (const call of verified) {
    assert.deepEqual(call.slice(1, 6), ['verify', '--certificate-identity-regexp', botRuntimeImageSignerIdentity('1H-Team/DevRyan'), '--certificate-oidc-issuer', BOT_RUNTIME_IMAGE_SIGNER_ISSUER]);
  }
  assert.ok(!calls.some((call) => call.includes('create') || call.includes('sign')));
});

test('image resolution sends missing images and deliberate refreshes to the build list', async t => {
  const root = await imageCheckout(t), output = path.join(root, 'image-output');
  const registry = await fakeRegistry(root, { missing: true });
  let result = run(root, 'image-resolve', { ...workflow, IMAGE_KEY: 'rest', GITHUB_OUTPUT: output, PATH: registry.PATH });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), 'build=["rest"]\n');
  assert.equal(await fs.stat(path.join(root, 'artifacts/rest.json')).catch(() => null), null);
  assert.ok(!(await registry.calls()).some((call) => call[0] === 'cosign'));
  await fs.rm(path.join(root, 'fake-registry/calls.log'));
  await fs.rm(output);
  result = run(root, 'image-resolve', { ...workflow, IMAGE_KEY: 'rest', GITHUB_OUTPUT: output, PATH: registry.PATH, REBUILD_BOT_IMAGES: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), 'build=["rest"]\n');
  assert.deepEqual(await registry.calls(), []);
  for (const invalid of [{ REBUILD_BOT_IMAGES: 'yes' }, { IMAGE_KEY: 'unknown' }]) {
    result = run(root, 'image-resolve', { ...workflow, IMAGE_KEY: 'rest', GITHUB_OUTPUT: output, PATH: registry.PATH, ...invalid });
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
  }
});

test('image signing tags the signed index with its input digest only on tag-triggered release runs', async t => {
  const root = await imageCheckout(t);
  const registry = await fakeRegistry(root);
  const signing = { ...workflow, GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture',
    IMAGE_KEY: 'rest', IMAGE_DIGEST: registry.indexDigest, PATH: registry.PATH };
  let result = run(root, 'image-sign', signing);
  assert.equal(result.status, 0, result.stderr);
  const { digest } = await readBotRuntimeImageInputs({ key: 'rest', root });
  const repositoryName = 'ghcr.io/1h-team/devryan-bot-rest';
  const created = (await registry.calls()).filter((call) => call.includes('create'));
  assert.deepEqual(created, [['docker', 'buildx', 'imagetools', 'create', '--tag', `${repositoryName}:${botRuntimeImageInputTag(digest)}`, `${repositoryName}@${registry.indexDigest}`]]);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'artifacts/rest.json'), 'utf8')).image.indexDigest, registry.indexDigest);
  await fs.rm(path.join(root, 'fake-registry/calls.log'));
  result = run(root, 'image-sign', { ...signing, GITHUB_REF: 'refs/heads/release/2.0.2', GITHUB_WORKFLOW_REF: '1H-Team/DevRyan/.github/workflows/release.yml@refs/heads/release/2.0.2' });
  assert.equal(result.status, 0, result.stderr);
  const calls = await registry.calls();
  assert.ok(calls.some((call) => call[0] === 'cosign' && call[1] === 'sign'));
  assert.ok(!calls.some((call) => call.includes('create')));
});

test('dry-run image resolution is read-only and signing refuses before reaching a registry', async t => {
  const root = await imageCheckout(t), output = path.join(root, 'image-output');
  const registry = await fakeRegistry(root);
  let result = run(root, 'image-resolve', { ...workflow, RELEASE_DRY_RUN: 'true', IMAGE_KEY: 'rest', GITHUB_OUTPUT: output, PATH: registry.PATH });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(await registry.calls()).some(call => call.includes('create') || call.includes('sign')));
  await fs.rm(path.join(root, 'fake-registry/calls.log'));
  result = run(root, 'image-sign', { ...workflow, RELEASE_DRY_RUN: 'true', IMAGE_KEY: 'rest', IMAGE_DIGEST: registry.indexDigest, PATH: registry.PATH });
  assert.notEqual(result.status, 0);assert.match(result.stderr, /dry runs prohibit external publication/);
  assert.deepEqual(await registry.calls(), []);
  result = run(root, 'image-resolve', { ...workflow, RELEASE_DRY_RUN: 'true', REBUILD_BOT_IMAGES: 'true', IMAGE_KEY: 'rest', GITHUB_OUTPUT: output, PATH: registry.PATH });
  assert.notEqual(result.status, 0);assert.match(result.stderr, /Dry run cannot publish new Bot images/);
  assert.deepEqual(await registry.calls(), []);
});

test('packaged asset description emits the actual SHA-256 and refuses escaped directories', async t => {
  const root = await checkout(t), output = path.join(root, 'asset-output'), directory = path.join(root, 'installers');
  await fs.mkdir(directory);
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const bytes = Buffer.from('disposable installer');
  await fs.writeFile(path.join(directory, `DevRyan-${version}-arm64.dmg`), bytes);
  const result = run(root, 'asset-describe', { RELEASE_ASSET_PLATFORM: 'macos-arm64', RELEASE_ASSET_DIRECTORY: directory, GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), `sha256=${digestOf(bytes).slice(7)}\n`);
  assert.notEqual(run(root, 'asset-describe', { RELEASE_ASSET_PLATFORM: 'macos-arm64', RELEASE_ASSET_DIRECTORY: repository, GITHUB_OUTPUT: output }).status, 0);
});
