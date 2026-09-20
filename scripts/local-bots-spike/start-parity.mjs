import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { command, parityDirectory, parityProject, workspace } from './fixtures.mjs';

// The CLI leaves HostIp empty and Docker Desktop 29 can ignore a bridge's
// default host binding. An invocation-scoped private Unix proxy pins only this
// disposable project's published ports before Docker creates the containers.
// It never logs request bodies (they contain synthetic fixture credentials).
const context = command('docker', ['context', 'show']).trim();
const endpoint = command('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
assert(endpoint.startsWith('unix://'), 'A local Docker Unix socket is required');
const socketPath = path.join(workspace, 'docker-fixture.sock');
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (incoming.method === 'POST' && /\/containers\/create(?:\?|$)/.test(incoming.url)) {
      const configuration = JSON.parse(body.toString('utf8'));
      assert.equal(configuration.Labels?.['com.supabase.cli.project'], parityProject);
      for (const entries of Object.values(configuration.HostConfig?.PortBindings || {})) {
        for (const entry of entries) entry.HostIp = '127.0.0.1';
      }
      body = Buffer.from(JSON.stringify(configuration));
    }
    const headers = { ...incoming.headers, 'content-length': String(body.length) };
    delete headers['transfer-encoding'];
    const upstream = http.request({ socketPath: endpoint.slice(7), method: incoming.method,
      path: incoming.url, headers }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end('Disposable Docker transport failed'); });
    upstream.end(body);
  } catch {
    outgoing.writeHead(403);
    outgoing.end('Disposable Docker fixture boundary rejected the operation');
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
await chmod(socketPath, 0o600);
const environment = { ...process.env, DOCKER_HOST: `unix://${socketPath}`, SUPABASE_TELEMETRY_DISABLED: '1' };
delete environment.DOCKER_CONTEXT;
const child = spawn('supabase', ['start', '--workdir', parityDirectory, '--network-id', parityProject,
  '--exclude', 'studio,imgproxy,realtime,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta'],
{ env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let failureCode = 'unknown';
// Never forward the CLI's status/credential output to an agent or terminal log.
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
  const match = chunk.toString('utf8').match(/"code":"([A-Za-z]+Error)"/);
  if (match) failureCode = match[1];
});
const timeout = setTimeout(() => child.kill('SIGTERM'), 600_000);
try {
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  assert.equal(status, 0, `Disposable Supabase start failed (${failureCode})`);
  const names = command('docker', ['ps', '--filter', `label=com.supabase.cli.project=${parityProject}`, '--format', '{{.Names}}']).trim().split('\n').filter(Boolean);
  assert(names.length >= 4, 'Disposable Supabase stack is incomplete');
  for (const name of names) {
    const ports = JSON.parse(command('docker', ['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']));
    for (const entries of Object.values(ports)) for (const entry of entries || []) assert.equal(entry.HostIp, '127.0.0.1');
  }
  console.log('PASS: every Supabase fixture listener is explicitly bound to loopback');
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await unlink(socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
