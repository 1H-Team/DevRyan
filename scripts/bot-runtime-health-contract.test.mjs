import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createBotRuntimeImageSmokeEnvironment,
  smokeBotRuntimeImages,
} from './smoke-bot-runtime-images.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];
const IMAGE_KEYS = ['supervisor', 'engine-proxy', 'egress', 'indexer', 'opencode', 'computer'];

const releaseManifest = () => ({
  version: 2,
  channel: 'release',
  releaseId: '1.1.9',
  sourceRevision: '1'.repeat(40),
  openCodeVersion: '1.18.25',
  schemaVersion: '20260827100000',
  pluginHash: `sha256:${'2'.repeat(64)}`,
  images: Object.fromEntries(IMAGE_KEYS.map((key, index) => [key, {
    name: `devryan-bot-${key}`,
    repository: `ghcr.io/1h-team/devryan-bot-${key}`,
    indexDigest: `sha256:${String(index + 1).repeat(64)}`,
    platforms: {
      'linux/amd64': {
        digest: `sha256:${'a'.repeat(63)}${index}`,
        sbomDigest: `sha256:${'b'.repeat(63)}${index}`,
        provenanceDigest: `sha256:${'c'.repeat(63)}${index}`,
      },
      'linux/arm64': {
        digest: `sha256:${'d'.repeat(63)}${index}`,
        sbomDigest: `sha256:${'e'.repeat(63)}${index}`,
        provenanceDigest: `sha256:${'f'.repeat(63)}${index}`,
      },
    },
  }])),
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe('Bot runtime container health contract', () => {
  test('requires every fixed service health check to terminate explicitly', async () => {
    for (const packageName of ['bot-supervisor', 'bot-engine-proxy', 'bot-egress', 'bot-indexer']) {
      const dockerfile = await fs.readFile(
        path.join(repositoryRoot, 'packages', packageName, 'Dockerfile'),
        'utf8',
      );
      assert.match(dockerfile, /process\.exit\(r\.ok\?0:1\)/);
      assert.match(dockerfile, /\(\)=>process\.exit\(1\)/);
      assert.doesNotMatch(dockerfile, /\{if\(!r\.ok\)process\.exit\(1\)\}/);
    }
  });

  test('selects immutable architecture-matched image references and private runtime values', () => {
    const environment = createBotRuntimeImageSmokeEnvironment({
      manifest: releaseManifest(),
      architecture: 'x64',
      hostRuntimeRoot: '/tmp/devryan-runtime-smoke',
      dockerSocketGid: 20,
      environment: { PATH: '/usr/bin' },
    });

    assert.equal(
      environment.DEVRYAN_BOT_SUPERVISOR_IMAGE,
      `ghcr.io/1h-team/devryan-bot-supervisor@sha256:${'a'.repeat(63)}0`,
    );
    assert.equal(
      environment.DEVRYAN_BOT_COMPUTER_IMAGE,
      `ghcr.io/1h-team/devryan-bot-computer@sha256:${'a'.repeat(63)}5`,
    );
    assert.equal(environment.DEVRYAN_BOT_SUPERVISOR_TOKEN.length, 43);
    assert.match(environment.DEVRYAN_BOT_DEPLOYMENT_ID, /^deployment-[0-9a-f]{24}$/);
    assert.equal(environment.DEVRYAN_DOCKER_SOCKET_GID, '20');
  });

  test('waits for the published fixed-service topology and always schedules cleanup', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-health-contract-'));
    temporaryDirectories.push(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const socketPath = path.join(directory, 'docker.sock');
    await fs.writeFile(manifestPath, `${JSON.stringify(releaseManifest())}\n`);
    await fs.writeFile(socketPath, 'fixture');
    const calls = [];

    await smokeBotRuntimeImages({
      manifestPath,
      architecture: 'x64',
      dockerSocketPath: socketPath,
      runner: (args, options) => calls.push({ args, options }),
    });

    assert.equal(calls.length, 2);
    for (const argument of [
      'up', '--detach', '--remove-orphans', '--wait', '--wait-timeout', '120',
      'supervisor', 'engine-proxy', 'egress', 'indexer',
    ]) {
      assert.ok(calls[0].args.includes(argument));
    }
    assert.equal(calls[0].options.timeoutMs, 180_000);
    for (const argument of ['down', '--remove-orphans']) {
      assert.ok(calls[1].args.includes(argument));
    }
  });
});
