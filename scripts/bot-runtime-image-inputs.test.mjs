import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BOT_RUNTIME_IMAGE_KEYS } from '../packages/electron/bot-runtime-manifest.mjs';
import { assembleBotRuntimeImages } from './build-bot-runtime-images.mjs';
import {
  BOT_RUNTIME_IMAGE_SIGNER_ISSUER,
  botRuntimeImageInputTag,
  botRuntimeImageSignerIdentity,
  readBotRuntimeImageInputs,
  resolveBotRuntimeImages,
  tagBotRuntimeImageInputs,
} from './bot-runtime-image-inputs.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentVersion = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
const revision = '1'.repeat(40);
const repositoryPrefix = 'ghcr.io/1h-team';
const digestOf = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const pinned = `node:22.13.1-alpine@sha256:${'e'.repeat(64)}`;

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-inputs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, content, mode = 0o644) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
    await fs.chmod(path.join(root, file), mode);
  };
  for (const [file, content] of Object.entries(files)) await write(file, content);
  const digest = async () => (await readBotRuntimeImageInputs({ key: 'supervisor', root })).digest;
  return { root, write, digest };
}

const supervisorFiles = (dockerfile = '') => ({
  '.dockerignore': 'node_modules\n',
  'packages/bot-supervisor/Dockerfile': `FROM ${pinned} AS base\nFROM base\nCOPY --chown=1:1 packages/bot-supervisor/package.json ./package.json\nCOPY --chown=1:1 \\\n  packages/bot-supervisor/src \\\n  ./src\nCOPY --from=base /etc/hosts /tmp/hosts\n${dockerfile}`,
  'packages/bot-supervisor/package.json': JSON.stringify({ name: 'devryan-bot-supervisor', version: '1.0.0', type: 'module' }),
  'packages/bot-supervisor/src/server.js': 'export {};\n',
  'packages/bot-supervisor/src/lib/a.js': 'export const a = 1;\n',
  'packages/bot-supervisor/README.md': 'not copied\n',
});

describe('Bot runtime image input digest', () => {
  test('every release image has a digest-pinned base and a stable input digest', async () => {
    for (const key of BOT_RUNTIME_IMAGE_KEYS) {
      const first = await readBotRuntimeImageInputs({ key, root: repositoryRoot });
      const second = await readBotRuntimeImageInputs({ key, root: repositoryRoot });
      assert.match(first.digest, /^sha256:[0-9a-f]{64}$/, key);
      assert.equal(first.digest, second.digest, key);
      assert.ok(first.files.some((entry) => entry.file.endsWith('Dockerfile')), key);
    }
    const opencode = await readBotRuntimeImageInputs({ key: 'opencode', root: repositoryRoot });
    assert.ok(opencode.files.some((entry) => entry.file === 'packages/web/server/lib/opencode/imagegen-model-hotfix.js'));
    const indexer = await readBotRuntimeImageInputs({ key: 'indexer', root: repositoryRoot });
    assert.ok(indexer.files.some((entry) => entry.file === 'packages/bot-indexer/src/search.js'));
    assert.ok(indexer.files.some((entry) => entry.file === 'packages/bot-indexer/package-lock.json'));
  });

  test('covers copied files, directories, modes, ignore rules and the Dockerfile', async t => {
    const { write, digest } = await fixture(t, supervisorFiles());
    const base = await digest();
    await write('packages/bot-supervisor/README.md', 'changed but never copied\n');
    assert.equal(await digest(), base);
    for (const [file, content, mode] of [
      ['packages/bot-supervisor/src/lib/a.js', 'export const a = 2;\n'],
      ['packages/bot-supervisor/src/lib/new.js', 'export {};\n'],
      ['packages/bot-supervisor/src/server.js', 'export {};\n', 0o755],
      ['.dockerignore', 'node_modules\ndist\n'],
      ['packages/bot-supervisor/Dockerfile.dockerignore', '*\n'],
    ]) {
      const before = await digest();
      await write(file, content, mode);
      assert.notEqual(await digest(), before, file);
    }
  });

  test('normalizes only the root package version away', async t => {
    const { write, digest } = await fixture(t, {
      ...supervisorFiles('COPY packages/bot-supervisor/package-lock.json ./\n'),
      'packages/bot-supervisor/package-lock.json': JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/y': { version: '2.0.0' } } }),
    });
    const base = await digest();
    await write('packages/bot-supervisor/package.json', JSON.stringify({ name: 'devryan-bot-supervisor', version: '9.9.9', type: 'module' }));
    await write('packages/bot-supervisor/package-lock.json', JSON.stringify({ name: 'x', version: '9.9.9', lockfileVersion: 3, packages: { '': { name: 'x', version: '9.9.9' }, 'node_modules/y': { version: '2.0.0' } } }));
    assert.equal(await digest(), base);
    await write('packages/bot-supervisor/package-lock.json', JSON.stringify({ name: 'x', version: '9.9.9', lockfileVersion: 3, packages: { '': { name: 'x', version: '9.9.9' }, 'node_modules/y': { version: '2.0.1' } } }));
    assert.notEqual(await digest(), base);
    await write('packages/bot-supervisor/package.json', JSON.stringify({ name: 'devryan-bot-supervisor', version: '9.9.9', type: 'commonjs' }));
    assert.notEqual(await digest(), base);
  });

  test('fails closed on inputs it cannot address by content', async t => {
    for (const [name, dockerfile] of [
      ['unpinned base', 'FROM node:22.13.1-alpine\n'],
      ['remote ADD', 'ADD https://example.com/x /x\n'],
      ['glob source', 'COPY packages/bot-supervisor/src/*.js ./\n'],
      ['heredoc', 'COPY <<EOF /x\nhello\nEOF\n'],
      ['escaping source', 'COPY ../outside /x\n'],
      ['bind mount', 'RUN --mount=type=bind,source=packages,target=/p true\n'],
    ]) {
      const { digest } = await fixture(t, supervisorFiles(dockerfile));
      await assert.rejects(digest(), { code: 'bot_runtime_image_inputs_unaddressable' }, name);
    }
    const { root, digest } = await fixture(t, supervisorFiles());
    await fs.symlink('server.js', path.join(root, 'packages/bot-supervisor/src/link.js'));
    await assert.rejects(digest(), { code: 'bot_runtime_image_inputs_unaddressable' });
  });

  test('names the input tag and pins the signer to tag-triggered release.yml runs', () => {
    assert.equal(botRuntimeImageInputTag(`sha256:${'a'.repeat(64)}`), `in-${'a'.repeat(64)}`);
    assert.throws(() => botRuntimeImageInputTag('sha256:abc'));
    const identity = new RegExp(botRuntimeImageSignerIdentity('1H-Team/DevRyan'));
    assert.equal(identity.test('https://github.com/1H-Team/DevRyan/.github/workflows/release.yml@refs/tags/v2.0.2'), true);
    assert.equal(identity.test('https://github.com/1H-Team/DevRyan/.github/workflows/release.yml@refs/tags/v2.0.2-rc.1'), true);
    for (const subject of [
      'https://github.com/1H-Team/DevRyan/.github/workflows/release.yml@refs/heads/main',
      'https://github.com/1H-Team/DevRyan/.github/workflows/other.yml@refs/tags/v2.0.2',
      'https://github.com/1H-Team/DevRyanX/.github/workflows/release.yml@refs/tags/v2.0.2',
      'https://github.com/1H-Team/DevRyan/.github/workflows/releaseXyml@refs/tags/v2.0.2',
      'https://github.com/attacker/DevRyan/.github/workflows/release.yml@refs/tags/v2.0.2',
    ]) assert.equal(identity.test(subject), false, subject);
    assert.throws(() => botRuntimeImageSignerIdentity('not a repository'));
    assert.equal(BOT_RUNTIME_IMAGE_SIGNER_ISSUER, 'https://token.actions.githubusercontent.com');
  });
});

const registryFixture = () => {
  const attestation = (sbom, provenance) => Buffer.from(JSON.stringify({ layers: [
    { digest: `sha256:${sbom.repeat(64)}`, annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' } },
    { digest: `sha256:${provenance.repeat(64)}`, annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' } },
  ] }));
  const attestations = new Map([attestation('c', 'd'), attestation('e', 'f')].map((bytes) => [digestOf(bytes), bytes]));
  const [amd64Attestation, arm64Attestation] = [...attestations.keys()];
  const index = Buffer.from(JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    { digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
    { digest: amd64Attestation, annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': `sha256:${'a'.repeat(64)}` } },
    { digest: arm64Attestation, annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': `sha256:${'b'.repeat(64)}` } },
  ] }));
  const calls = [];
  const state = { missing: new Set(), private: new Set(), unsigned: new Set(), incomplete: new Set() };
  const keyOf = (reference) => reference.split('/').at(-1).replace(/^devryan-bot-/, '').split(/[:@]/)[0];
  const runner = {
    run: (file, args) => { calls.push([file, ...args]); },
    capture: (file, args) => {
      calls.push([file, ...args]);
      const reference = args.at(-1), key = keyOf(reference);
      if (file === 'cosign') {
        if (state.unsigned.has(key)) throw Object.assign(new Error('no signatures'), { code: 'bot_runtime_image_command_failed' });
        return Buffer.from('[{"critical":{}}]');
      }
      if (reference.includes(':in-')) return index;
      const bytes = attestations.get(reference.split('@')[1]);
      if (!bytes) throw new Error(`unexpected ${reference}`);
      return state.incomplete.has(key) ? Buffer.from('{"layers":[]}') : bytes;
    },
  };
  const probe = async (reference, { environment }) => {
    assert.ok(environment.DOCKER_CONFIG);
    calls.push(['probe', reference]);
    const key = keyOf(reference);
    if (state.missing.has(key)) return { exitCode: 1, stderr: 'manifest unknown' };
    if (state.private.has(key)) return { exitCode: 1, stderr: 'unauthorized: authentication required' };
    return { exitCode: 0 };
  };
  return { runner, probe, calls, state, indexDigest: digestOf(index) };
};

describe('Bot runtime image resolution', () => {
  const identity = { version: currentVersion, revision, repositoryPrefix, workflowRepository: '1H-Team/DevRyan', root: repositoryRoot };

  test('reuses only fully verified images and emits image-sign results the assembly accepts', async () => {
    const registry = registryFixture();
    for (const key of ['egress', 'computer', 'rest', 'database']) registry.state[{ egress: 'missing', computer: 'unsigned', rest: 'private', database: 'incomplete' }[key]].add(key);
    const resolution = await resolveBotRuntimeImages({ ...identity, runner: registry.runner, probe: registry.probe });
    assert.deepEqual(resolution.build, ['egress', 'computer', 'database', 'rest']);
    assert.deepEqual(resolution.reasons, { egress: 'missing', computer: 'signature_unverified', database: 'attestations_incomplete', rest: 'not_public' });
    assert.deepEqual(resolution.reused.map((result) => result.key), ['supervisor', 'engine-proxy', 'indexer', 'opencode']);
    assert.deepEqual(Object.keys(resolution.inputs), [...BOT_RUNTIME_IMAGE_KEYS]);
    const supervisor = resolution.reused[0];
    assert.equal(supervisor.image.indexDigest, registry.indexDigest);
    assert.equal(supervisor.image.repository, `${repositoryPrefix}/devryan-bot-supervisor`);
    assert.equal(supervisor.releaseId, currentVersion);
    assert.equal(supervisor.sourceRevision, revision);
    const tag = `${repositoryPrefix}/devryan-bot-supervisor:${botRuntimeImageInputTag(resolution.inputs.supervisor)}`;
    assert.ok(registry.calls.some((call) => call.join(' ') === `probe ${tag}`));
    const verified = registry.calls.filter((call) => call[0] === 'cosign' && call.at(-1).includes('devryan-bot-supervisor@')).map((call) => call.at(-1));
    assert.deepEqual(verified.sort(), [registry.indexDigest, `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`].map((digest) => `${repositoryPrefix}/devryan-bot-supervisor@${digest}`).sort());
    const cosign = registry.calls.find((call) => call[0] === 'cosign');
    assert.deepEqual(cosign.slice(1, 6), ['verify', '--certificate-identity-regexp', botRuntimeImageSignerIdentity('1H-Team/DevRyan'), '--certificate-oidc-issuer', BOT_RUNTIME_IMAGE_SIGNER_ISSUER]);
    for (const anonymous of [registry.indexDigest, `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`]) {
      assert.ok(registry.calls.some((call) => call.join(' ') === `probe ${repositoryPrefix}/devryan-bot-supervisor@${anonymous}`));
    }
    const built = resolution.build.map((key) => ({ ...supervisor, key, image: { ...supervisor.image, name: `devryan-bot-${key}`, repository: `${repositoryPrefix}/devryan-bot-${key}` } }));
    const manifest = await assembleBotRuntimeImages({ version: currentVersion, revision, repositoryPrefix, results: [...resolution.reused, ...built] });
    assert.equal(Object.keys(manifest.images).length, 8);
  });

  test('a deliberate refresh rebuilds every image without touching the registry', async () => {
    const registry = registryFixture();
    const resolution = await resolveBotRuntimeImages({ ...identity, rebuild: true, runner: registry.runner, probe: registry.probe });
    assert.deepEqual(resolution.build, [...BOT_RUNTIME_IMAGE_KEYS]);
    assert.deepEqual(resolution.reused, []);
    assert.ok(Object.values(resolution.reasons).every((reason) => reason === 'rebuild_requested'));
    assert.deepEqual(registry.calls, []);
  });
});

describe('Bot runtime image input tagging', () => {
  const repository = `${repositoryPrefix}/devryan-bot-supervisor`;
  const inputDigest = `sha256:${'7'.repeat(64)}`;
  const environment = { GITHUB_REPOSITORY: '1H-Team/DevRyan', GITHUB_REF: 'refs/tags/v2.0.2', GITHUB_WORKFLOW_REF: '1H-Team/DevRyan/.github/workflows/release.yml@refs/tags/v2.0.2' };

  test('tags the signed index after verifying the tag resolves to the same digest', async () => {
    const index = Buffer.from('{"index":true}'), calls = [];
    const runner = { run: (...call) => calls.push(call), capture: (...call) => { calls.push(call); return index; } };
    const reference = await tagBotRuntimeImageInputs({ repository, indexDigest: digestOf(index), inputDigest, environment, runner });
    assert.equal(reference, `${repository}:in-${'7'.repeat(64)}`);
    assert.deepEqual(calls.map(([file, args]) => [file, ...args]), [
      ['docker', 'buildx', 'imagetools', 'create', '--tag', reference, `${repository}@${digestOf(index)}`],
      ['docker', 'buildx', 'imagetools', 'inspect', '--raw', reference],
    ]);
    await assert.rejects(tagBotRuntimeImageInputs({ repository, indexDigest: `sha256:${'0'.repeat(64)}`, inputDigest, environment, runner }), { code: 'bot_runtime_image_input_tag_mismatch' });
  });

  test('never tags images a later release could not verify', async () => {
    const runner = { run: () => assert.fail('tagged'), capture: () => assert.fail('tagged') };
    for (const override of [
      { GITHUB_REF: 'refs/heads/release/2.0.2', GITHUB_WORKFLOW_REF: '1H-Team/DevRyan/.github/workflows/release.yml@refs/heads/release/2.0.2' },
      { GITHUB_WORKFLOW_REF: '1H-Team/DevRyan/.github/workflows/other.yml@refs/tags/v2.0.2' },
      { GITHUB_REPOSITORY: undefined },
    ]) {
      assert.equal(await tagBotRuntimeImageInputs({ repository, indexDigest: `sha256:${'0'.repeat(64)}`, inputDigest, environment: { ...environment, ...override }, runner }), null);
    }
  });
});
