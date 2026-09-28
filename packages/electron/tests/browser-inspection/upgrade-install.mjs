// Opt-in real registry/release installation into repository-local disposable data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createAgentBrowserInstaller, AGENT_BROWSER_VERSION, resolveAgentBrowserBinaryName } from '../../../web/server/lib/agent-browser/install.js';
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const cache = path.join(repository, '.cache/browser-upgrade');
const root = await fs.mkdtemp(path.join(cache, 'install-'));
const homeDir = path.join(root, 'home'); await fs.mkdir(homeDir);
const bunExecutable = process.argv[2];
assert.ok(bunExecutable && path.isAbsolute(bunExecutable), 'Pass the absolute supported Bun executable');
const env = { PATH: process.env.PATH, HOME: homeDir, BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache') };
const installer = createAgentBrowserInstaller({ dataRoot: root, homeDir, bunExecutable, env });
const results = [];
for (const [name, action] of [['fresh', () => installer.ensureInstalled()], ['no-op', () => installer.ensureInstalled()], ['repair', () => installer.repair()]]) {
  const status = await action(); results.push({ name, status });
  assert.equal(status.ok, true, JSON.stringify(status.issues));
  assert.equal(status.installedVersion, AGENT_BROWSER_VERSION);
  assert.equal(status.recording.ok, true, JSON.stringify(status.recording.issues));
  if (name === 'no-op') assert.equal(status.changed, false);
}
const installed = results[0].status;
const packageRoot = path.dirname(path.dirname(installed.binaryPath));
const layout = [];
for (const [platform, arch, musl] of [['darwin','arm64'],['darwin','x64'],['linux','arm64'],['linux','x64'],['linux','arm64',true],['linux','x64',true],['win32','x64']]) {
  const name = resolveAgentBrowserBinaryName({ platform, arch, musl: !!musl });
  assert.ok((await fs.stat(path.join(packageRoot, 'bin', name))).size > 1000);
  layout.push(name);
}
// The managed native executable does not need a Node shim on PATH.
assert.equal(execFileSync(installed.binaryPath, ['--version'], { env: { HOME: homeDir, PATH: '' }, encoding: 'utf8' }).trim(), `agent-browser ${AGENT_BROWSER_VERSION}`);
const baseline = path.join(cache, 'baseline/node_modules/agent-browser');
assert.equal(JSON.parse(await fs.readFile(path.join(baseline, 'package.json'))).version, '0.33.2', 'Stage the exact baseline package for the upgrade check');
await fs.rm(packageRoot, { recursive: true });
await fs.cp(baseline, packageRoot, { recursive: true });
const upgraded = await installer.ensureInstalled();
results.push({ name: 'upgrade-from-0.33.2', status: upgraded });
assert.equal(upgraded.ok, true, JSON.stringify(upgraded.issues));
assert.equal(upgraded.installedVersion, AGENT_BROWSER_VERSION);
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ results, layout, nodeIndependentNativeVersion: true,
  unavailableExecutionPlatforms: layout.filter(name => name !== path.basename(installed.binaryPath)) }, null, 2));
console.log(JSON.stringify({ root, installRoot: path.dirname(path.dirname(packageRoot)), status: 'passed', checks: results.map(row => row.name), layout }));
