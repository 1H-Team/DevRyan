import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const enabled = process.env.DEVRYAN_RUN_BOT_INDEXER_DOCKER_TESTS === '1';
const docker = process.env.DEVRYAN_DOCKER_BIN || 'docker';
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const token = 'd'.repeat(43);

const runDocker = async (args, options = {}) => execFileAsync(docker, args, {
  cwd: repositoryRoot,
  timeout: options.timeout || 10 * 60_000,
  maxBuffer: 8 * 1024 * 1024,
});

const waitForJson = async (url, pathname, body) => {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
      return payload;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('Timed out waiting for Bot indexer');
};

if (enabled) describe('Docker Bot index rebuild and isolation', () => {
  test('bakes the pinned model, persists authorized namespaces, and resets with its volume', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    const image = `devryan/bot-indexer-test:${suffix}`;
    const volume = `devryan-bot-indexer-test-${suffix}`;
    const network = `devryan-bot-indexer-test-${suffix}`;
    const containers = [];
    const cleanup = async () => {
      for (const container of containers.reverse()) {
        await runDocker(['rm', '--force', container]).catch(() => undefined);
      }
      await runDocker(['volume', 'rm', '--force', volume]).catch(() => undefined);
      await runDocker(['network', 'rm', network]).catch(() => undefined);
      await runDocker(['image', 'rm', '--force', image]).catch(() => undefined);
    };
    const start = async (label) => {
      const name = `devryan-bot-indexer-${label}-${suffix}`;
      containers.push(name);
      const { stdout } = await runDocker([
        'run', '--detach', '--name', name,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777',
        '--network', network,
        '--mount', `type=volume,source=${volume},target=/var/lib/devryan-bot-index`,
        '--publish', '127.0.0.1::43123',
        '--env', `DEVRYAN_BOT_INDEXER_TOKEN=${token}`,
        image,
      ]);
      assert.match(stdout.trim(), /^[0-9a-f]{64}$/);
      const port = (await runDocker(['port', name, '43123/tcp'])).stdout.trim().split(':').at(-1);
      const url = `http://127.0.0.1:${port}`;
      await waitForJson(url, '/healthz');
      return { name, url };
    };

    try {
      await runDocker([
        'build', '--file', 'packages/bot-indexer/Dockerfile', '--tag', image, '.',
      ], { timeout: 20 * 60_000 });
      await runDocker([
        'network', 'create',
        '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
        network,
      ]);
      const first = await start('first');
      assert.equal((await waitForJson(first.url, '/v1/status')).status.state, 'rebuild_required');
      await waitForJson(first.url, '/v1/rebuild', { documents: [
        { namespace: 'bot:b1', documentId: 'shared', version: 'v1', text: 'shared meteor fact' },
        { namespace: 'bot:b1:user:u1', documentId: 'u1', version: 'v1', text: 'private meteor one' },
        { namespace: 'bot:b1:user:u2', documentId: 'u2', version: 'v1', text: 'private meteor two' },
        { namespace: 'channel:c1', documentId: 'c1', version: 'v1', text: 'channel meteor one' },
      ] });
      const results = await waitForJson(first.url, '/v1/search', {
        namespaces: ['bot:b1', 'bot:b1:user:u1', 'channel:c1'], query: 'meteor', limit: 10,
      });
      assert.deepEqual(
        results.result.results.map(({ documentId }) => documentId).sort(),
        ['c1', 'shared', 'u1'],
      );
      await runDocker(['rm', '--force', first.name]);
      containers.splice(containers.indexOf(first.name), 1);

      const second = await start('second');
      assert.equal((await waitForJson(second.url, '/v1/status')).status.state, 'ready');
      const persisted = await waitForJson(second.url, '/v1/search', {
        namespaces: ['bot:b1:user:u1'], query: 'meteor', limit: 10,
      });
      assert.deepEqual(persisted.result.results.map(({ documentId }) => documentId), ['u1']);
      await runDocker(['rm', '--force', second.name]);
      containers.splice(containers.indexOf(second.name), 1);
      await runDocker(['volume', 'rm', '--force', volume]);
      await runDocker(['volume', 'create', volume]);

      const fresh = await start('fresh');
      assert.equal((await waitForJson(fresh.url, '/v1/status')).status.state, 'rebuild_required');
    } finally {
      await cleanup();
    }
  });
});
