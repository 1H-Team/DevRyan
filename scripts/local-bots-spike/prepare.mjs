import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { command, parityDirectory, parityProject, prepareLocalCompose, repository, workspace } from './fixtures.mjs';

assert.equal(command('supabase', ['--version']).trim(), '2.117.0', 'Reverify the CLI networking/schema contract before changing its pinned version');
command('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(parityDirectory, { recursive: true, mode: 0o700 });
const configurationPath = path.join(parityDirectory, 'supabase/config.toml');
if (!existsSync(configurationPath)) command('supabase', ['init', '--workdir', parityDirectory, '--yes']);
let configuration = readFileSync(configurationPath, 'utf8');
assert(/project_id = "(?:supabase-parity|devryan-bots-spike-parity-20260920)"/.test(configuration), 'Not the disposable project');
configuration = configuration.replace(/^project_id = .+$/m, `project_id = "${parityProject}"`);
for (const [from, to] of [[54321, 56321], [54322, 56322], [54320, 56320], [54323, 56323], [54324, 56324], [54327, 56327], [54329, 56329], [8083, 56883]]) {
  configuration = configuration.replaceAll(String(from), String(to));
}
for (const section of ['studio', 'realtime', 'analytics', 'edge_runtime', 'inbucket', 'db.seed']) {
  configuration = configuration.replace(new RegExp(`(\\[${section.replaceAll('.', '\\.')}\\][\\s\\S]*?enabled = )true`), '$1false');
}
configuration = configuration.replace('# auto_expose_new_tables = true', 'auto_expose_new_tables = false');
writeFileSync(configurationPath, configuration);
for (const directory of ['migrations', 'tests']) {
  const source = path.join(repository, 'supabase', directory);
  const destination = path.join(parityDirectory, 'supabase', directory);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).filter((value) => value.endsWith('.sql'))) {
    const bytes = readFileSync(path.join(source, name));
    const target = path.join(destination, name);
    if (existsSync(target)) assert(bytes.equals(readFileSync(target)), 'Fixture migrations changed: use a fresh disposable environment');
    else writeFileSync(target, bytes, { flag: 'wx' });
  }
}
const networks = command('docker', ['network', 'ls', '--format', '{{.Name}}']).trim().split('\n');
if (!networks.includes(parityProject)) {
  command('docker', ['network', 'create', '--label', 'devryan.feasibility=20260920', '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', parityProject]);
} else {
  const label = command('docker', ['network', 'inspect', parityProject, '--format', '{{index .Labels "devryan.feasibility"}}']).trim();
  assert.equal(label, '20260920', 'Refusing an unrelated Docker network');
}
const compose = prepareLocalCompose();
command('docker', ['build', '-f', 'scripts/local-bots-spike/Dockerfile', '-t', 'devryan-bots-spike-pg:20260920', 'scripts/local-bots-spike'], { timeout: 300_000 });
command('docker', ['compose', '-f', compose, 'up', '-d', '--wait', '--wait-timeout', '60', 'db'], { timeout: 90_000 });
console.log('Disposable PostgreSQL and isolated Supabase configuration prepared. No cloud project is linked.');
