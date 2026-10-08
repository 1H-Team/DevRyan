import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startOwnedProcess } from '../../../../scripts/qa/process.mjs';
import { createRunRoot } from '../../../../scripts/qa/run-root.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const cache = path.join(repository, '.cache/browser-upgrade');
await fs.mkdir(cache, { recursive: true });
// Profile and session payloads go on pass (or interrupt); result, cleanup evidence and logs stay.
let owned;
const run = createRunRoot({ parent: cache, prefix: 'acceptance-', owner: 'packages/electron/tests/browser-inspection/upgrade-run.mjs',
  heavyNames: ['userData', 'sessionData', 'crashDumps'], onInterrupt: async () => { await owned?.stop().catch(() => {}); } });
const root = run.dir;
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps', 'home']) await fs.mkdir(path.join(root, key));
const install = path.resolve(process.argv[2] || path.join(cache, 'current'));
assert.ok(install.startsWith(`${repository}${path.sep}`), 'Use a repository-local managed install');
await fs.chmod(path.join(install, 'node_modules/agent-browser/bin', `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`), 0o755);
const require = createRequire(new URL('../../package.json', import.meta.url));
const env = {};
for (const key of ['PATH', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { HOME: path.join(root, 'home'), XDG_RUNTIME_DIR: '.',
  DEVRYAN_BROWSER_UPGRADE_NODE: process.execPath, DEVRYAN_BROWSER_UPGRADE_ROOT: root, DEVRYAN_BROWSER_UPGRADE_INSTALL: install });
owned = startOwnedProcess(require('electron'), [fileURLToPath(new URL('./upgrade-main.mjs', import.meta.url))], { cwd: install, env });
const { child } = owned;
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-32768); if (String(chunk).startsWith('Checking')) process.stdout.write(chunk); });
const timer = setTimeout(() => { void owned.stop().catch(() => {}); }, 180000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
const cleanup = await owned.stop();
await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
await fs.writeFile(path.join(root, 'process.log'), logs.replaceAll(root, '<FIXTURE>'));
console.log(`Evidence: ${root}`);
if (code !== 0) console.log(logs.slice(-6000));
assert.equal(code, 0, 'Actual agent-browser/Electron acceptance failed');
const evidence = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
assert.equal(evidence.status, 'passed');
assert.deepEqual(cleanup.remainingProcessIds, []);
assert.deepEqual(cleanup.signals, [], 'Fixture must clean its descendants before returning');
evidence.cleanup = cleanup;
evidence.checks.push('retained process ancestry: no surviving daemon, encoder, or Electron helper; no rescue signals');
if (evidence.versions.agentBrowser === '0.38.1') {
  for (const file of ['recording-webm.webm', 'recording-mp4.mp4', 'confined-false.webm', 'confined-true.webm']) {
    execFileSync(path.join(install, 'ffmpeg/ffmpeg'), ['-nostdin', '-v', 'error', '-i', path.join(root, file), '-f', 'null', '-'], { timeout: 10000, stdio: 'pipe' });
    assert.ok((await fs.stat(path.join(root, file.replace(/\.[^.]+$/, '.contact-sheet.png')))).size > 100);
  }
  evidence.checks.push('all four videos decode fully; contact-sheet artifacts exist');
}
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
run.finish('passed');
