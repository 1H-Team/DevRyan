// Disposable, offline acceptance check. No production containers, logins or
// images are changed. Run: node packages/bots-runtime/opencode/oauth.integration.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoot = path.join(root, '.tmp');
await fs.mkdir(temporaryRoot, { recursive: true });
const directory = await fs.mkdtemp(path.join(temporaryRoot, 'oauth-acceptance-'));
const name = `devryan-oauth-acceptance-${crypto.randomUUID()}`;
const image = process.env.DEVRYAN_OAUTH_FIXTURE_IMAGE || 'devryan/bot-opencode:dev';
const baked = process.env.DEVRYAN_OAUTH_FIXTURE_BAKED === '1';
try {
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=DevRyan disposable OAuth fixture', '-addext', 'subjectAltName=DNS:chatgpt.com,DNS:auth.openai.com,DNS:api.openai.com',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { encoding: 'utf8' });
  if (cert.status !== 0) throw new Error('Fixture certificate generation failed');
  const mounts = [
    [`${root}/packages/web/server/lib/opencode`, '/src/opencode'],
    [`${root}/packages/web/server/lib/bots`, '/src/bots'],
    [`${root}/packages/bots-runtime`, '/src/node_modules/@openchamber/bots-runtime'],
    [`${root}/packages/bots-runtime/opencode/oauth-fixture.mjs`, '/opt/devryan/oauth-fixture.mjs'],
    ...(!baked ? [
      [`${root}/packages/bots-runtime/opencode/devryan-bot-tools.mjs`, '/opt/devryan/devryan-bot-tools.mjs'],
      [`${root}/packages/web/server/default-config/plugins/devryan-openai-oauth.mjs`, '/opt/devryan/devryan-openai-oauth.mjs'],
    ] : []),
    [directory, '/fixture-tls'],
  ];
  const args = ['run', '--rm', '--name', name, '--network', 'none', '--user', '0', '--read-only',
    '--tmpfs', '/tmp:rw,exec', '--tmpfs', '/data:rw', '--tmpfs', '/workspace:rw',
    '--add-host', 'chatgpt.com:127.0.0.1', '--add-host', 'api.openai.com:127.0.0.1',
    '--add-host', 'auth.openai.com:127.0.0.1', '--add-host', 'host.docker.internal:127.0.0.1',
    '-e', 'HOME=/tmp/fixture-home', '-e', 'NODE_EXTRA_CA_CERTS=/fixture-tls/cert.pem',
    ...mounts.flatMap(([source, target]) => ['-v', `${source}:${target}:ro`]),
    '--entrypoint', 'node', image, '/opt/devryan/oauth-fixture.mjs'];
  const child = spawn('docker', args, { stdio: 'inherit' });
  const timer = setTimeout(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }, 180_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  if (code !== 0) throw new Error('Offline OAuth acceptance failed');
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  await fs.rm(directory, { recursive: true, force: true });
}
