import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, images, localDatabase, localPort, localProject, sql, workspace } from './fixtures.mjs';

const compose = path.join(workspace, 'compose.json');
const countsSql = "select json_build_object('bots',(select count(*) from public.bots),'objects',(select count(*) from public.bot_objects));";
const before = JSON.parse(sql(localDatabase, countsSql));
command('docker', ['compose', '-f', compose, 'stop'], { timeout: 90_000 });
const warmStart = performance.now();
command('docker', ['compose', '-f', compose, 'up', '-d', '--wait', '--wait-timeout', '90'], { timeout: 100_000 });
const credentials = JSON.parse(await readFile(path.join(workspace, 'local-credentials.json'), 'utf8'));
async function ready() {
  const response = await fetch(`http://127.0.0.1:${localPort}/rpc/devryan_bot_schema_version`, {
    method: 'POST', headers: { Authorization: `Bearer ${credentials.serviceKey}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
}
for (let attempt = 0; ; attempt += 1) {
  try { await ready(); break; }
  catch (error) { if (attempt >= 30) throw error; await new Promise((resolve) => setTimeout(resolve, 500)); }
}
const warmRestartMs = Math.round(performance.now() - warmStart);
assert.deepEqual(JSON.parse(sql(localDatabase, countsSql)), before);
const stats = command('docker', ['stats', '--no-stream', '--format', '{{json .}}', localDatabase, `${localProject}-rest-1`]);
const imageDetails = JSON.parse(command('docker', ['image', 'inspect', 'devryan-bots-spike-pg:20260920', images.postgrest]));
const architectures = {};
for (const [name, image] of Object.entries(images)) {
  const manifest = JSON.parse(command('docker', ['buildx', 'imagetools', 'inspect', image, '--raw'], { timeout: 60_000 }));
  const platforms = manifest.manifests.map(({ platform }) => `${platform.os}/${platform.architecture}`);
  assert(platforms.includes('linux/amd64') && platforms.includes('linux/arm64'));
  architectures[name] = [...new Set(platforms.filter((platform) => platform.startsWith('linux/')))];
}
const inventory = JSON.parse(sql(localDatabase, `select json_build_object(
 'postgres',current_setting('server_version'),
 'botTables',(select count(*) from pg_tables where schemaname='public' and (tablename='bots' or tablename like 'bot_%')),
 'forcedRlsTables',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname='bots' or c.relname like 'bot_%') and c.relrowsecurity and c.relforcerowsecurity),
 'postgresTcpListener',current_setting('listen_addresses'),
 'extensions',(select json_agg(extname) from pg_extension));`));
assert.equal(inventory.botTables, inventory.forcedRlsTables);
assert.equal(inventory.postgresTcpListener, '');
const coldName = `${localProject}-cold-probe`;
let created = false;
const coldStart = performance.now();
let coldInitializationMs;
try {
  command('docker', ['run', '-d', '--name', coldName, '--label', `devryan.feasibility=${localProject}`,
    '--network', 'none', '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=256m',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'devryan-bots-spike-pg:20260920', 'postgres', '-c', 'listen_addresses=']);
  created = true;
  for (let attempt = 0; ; attempt += 1) {
    try {
      assert.equal(command('docker', ['exec', '--user', 'postgres', coldName, 'psql', '-XAt', '-U', 'postgres', '-c', 'select 1;']).trim(), '1');
      break;
    } catch (error) { if (attempt >= 60) throw error; await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  coldInitializationMs = Math.round(performance.now() - coldStart);
} finally {
  if (created) command('docker', ['rm', '-f', coldName]); // Owned tmpfs-only disposable probe.
}
const result = { version: 1, hostArchitecture: process.arch, warmRestartMs, coldInitializationMs,
  inventory, architectures, stats: stats.trim().split('\n').map(JSON.parse),
  images: imageDetails.map((image) => ({ id: image.Id, bytes: image.Size, architecture: image.Architecture })),
  caveat: 'One development-machine sample, images already downloaded; not a production performance SLA.' };
await writeFile(path.join(workspace, 'measurements.json'), JSON.stringify(result, null, 2));
console.log(`PASS: warm restart ${warmRestartMs} ms; empty PostgreSQL initialization ${coldInitializationMs} ms; record counts preserved; ARM64/AMD64 image manifests verified`);
