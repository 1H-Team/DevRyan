import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw Error('Native Windows filesystem required');
if (process.argv.length !== 3) throw Error('Expected owned supervisor output directory');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.realpath(path.resolve(process.argv[2]));
assert.ok(root.startsWith(repo + path.sep));
const binary = path.join(root, `DevRyan-execution-win32-${process.arch}.exe`), manifestFile = binary + '.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await fs.readFile(manifestFile), manifest = JSON.parse(manifestBytes);
assert.equal(manifest.platform, 'win32'); assert.equal(manifest.arch, process.arch);
assert.equal(manifest.sourceSha256, hash(await fs.readFile(path.join(repo, 'packages/harness-runtime/native/session-execution-windows.c'))));
const pin = async () => {
  assert.equal(await fs.realpath(binary), binary);
  assert.equal(hash(await fs.readFile(binary)), manifest.sha256);
  assert.deepEqual(await fs.readFile(manifestFile), manifestBytes);
};
const call = (operation, target, input) => {
  const value = JSON.parse(execFileSync(binary, [operation, target], { input, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }));
  assert.deepEqual(Object.keys(value).sort(), ['currentOwner', 'fileId', 'linkCount', 'privateAcl', 'protocol', 'reparsePoint', 'type', 'volume']);
  assert.equal(value.protocol, 'devryan.windows-file-identity/1');
  assert.match(value.volume, /^[a-f0-9]{16}$/); assert.match(value.fileId, /^[a-f0-9]{32}$/);
  for (const key of ['currentOwner', 'privateAcl', 'reparsePoint']) assert.equal(typeof value[key], 'boolean');
  assert.ok(Number.isInteger(value.linkCount) && value.linkCount > 0);
  assert.ok(['directory', 'file'].includes(value.type));
  return value;
};
const refused = (operation, target) => {
  const result = spawnSync(binary, [operation, target], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(result.status, 125); assert.equal(result.stdout, '');
};
const parent = path.join(repo, '.cache/test-fixtures');
const fixture = await fs.mkdtemp(path.join(parent, 'windows-filesystem-'));
const evidence = { schema: 1, status: 'failed', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  platform: process.platform, arch: process.arch, supervisorSha256: manifest.sha256, manifestSha256: hash(manifestBytes),
  scope: 'SDK no-follow file identity, private ACL creation and anchored parent refusal; no execution/admission authority', checks: [] };
let locked, closed;
try {
  await pin();
  await fs.chmod(fixture, 0o700);
  assert.equal(call('--inspect-path', fixture).privateAcl, false, 'POSIX modes attested an inherited Windows ACL');
  evidence.checks.push('mode-bits-do-not-attest-private-acl');
  const privatePath = path.join(fixture, 'Private-Δ-工作');
  const privateDirectory = call('--create-private-directory', privatePath);
  assert.equal(privateDirectory.privateAcl, true); assert.equal(privateDirectory.currentOwner, true);
  assert.equal(privateDirectory.reparsePoint, false); assert.equal(privateDirectory.type, 'directory');
  assert.deepEqual(call('--inspect-path', privatePath), privateDirectory);
  refused('--create-private-directory', privatePath);
  assert.deepEqual(call('--inspect-path', privatePath), privateDirectory);
  evidence.checks.push('exclusive-private-unicode-directory', 'stable-no-follow-directory-identity', 'existing-directory-preserved');
  const ordinary = path.join(privatePath, 'ordinary-node-file');
  await fs.writeFile(ordinary, 'ordinary owner observation\n', { flag: 'wx' });
  evidence.ordinaryFile = call('--inspect-path', ordinary);
  assert.equal(evidence.ordinaryFile.privateAcl, false);
  const file = path.join(privatePath, 'Case-Fixture.txt');
  const created = call('--create-private-file', file, 'owned filesystem fixture\n');
  const original = call('--inspect-path', file);
  assert.deepEqual(original, created); assert.equal(original.privateAcl, true);
  assert.equal(original.currentOwner, true); assert.equal(original.type, 'file'); assert.equal(original.linkCount, 1);
  assert.equal(original.reparsePoint, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'owned filesystem fixture\n');
  refused('--create-private-file', file);
  assert.equal(await fs.readFile(file, 'utf8'), 'owned filesystem fixture\n');
  for (const name of ['CON', 'NUL.txt', 'COM1', 'LPT²', 'CONIN$', 'CONOUT$', 'trailing.', 'trailing ', 'file:stream']) {
    refused('--create-private-file', path.join(privatePath, name));
  }
  evidence.checks.push('ordinary-file-is-not-private-proof', 'exclusive-private-file-owner-and-contents', 'reserved-and-stream-name-refusal');
  assert.deepEqual(call('--inspect-path', file.toUpperCase()), original);
  evidence.checks.push('native-case-equivalence', 'file-identity-stability');
  const linked = path.join(privatePath, 'hard-link.txt'); await fs.link(file, linked);
  const links = call('--inspect-path', linked);
  assert.equal(links.fileId, original.fileId); assert.equal(links.volume, original.volume); assert.equal(links.linkCount, 2);
  assert.equal(call('--inspect-path', file).linkCount, 2);
  evidence.checks.push('hard-link-shared-identity-and-count');
  const target = path.join(fixture, 'target');
  call('--create-private-directory', target);
  const junction = path.join(privatePath, 'junction'); await fs.symlink(target, junction, 'junction');
  const reparse = call('--inspect-path', junction);
  assert.equal(reparse.reparsePoint, true); assert.notEqual(reparse.fileId, call('--inspect-path', target).fileId);
  const targetFile = path.join(target, 'owned.txt');
  call('--create-private-file', targetFile, 'owned target identity\n');
  refused('--inspect-path', path.join(junction, 'owned.txt'));
  assert.equal(await fs.readFile(targetFile, 'utf8'), 'owned target identity\n');
  refused('--create-private-directory', path.join(junction, 'escape'));
  assert.deepEqual(await fs.readdir(target), ['owned.txt']);
  refused('--create-private-directory', path.join(privatePath, '..') + '\\..\\escape');
  refused('--create-private-directory', 'relative-directory');
  evidence.checks.push('junction-not-followed', 'reparse-parent-inspection-refusal', 'reparse-parent-refusal', 'relative-and-parent-traversal-refusal');
  const quoted = file.replaceAll("'", "''");
  locked = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$stream = [System.IO.File]::Open('${quoted}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::WriteLine('ready'); Start-Sleep -Seconds 30 } finally { $stream.Dispose() }`],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => locked.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned file lock did not start')), 10000);
    locked.once('error', error => { clearTimeout(timer); reject(error); });
    locked.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  refused('--inspect-path', file);
  assert.equal(await fs.readFile(file, 'utf8').then(() => false, () => true), true);
  evidence.checks.push('locked-file-refuses-unproved-identity');
  await pin();
  evidence.status = 'passed'; evidence.privateDirectory = privateDirectory;
} catch (error) {
  evidence.error = { code: error.code ?? null, message: error.message.replaceAll(fixture, '<FIXTURE>'), stack: error.stack?.split('\n').slice(0, 4).join('\n').replaceAll(fixture, '<FIXTURE>') };
} finally {
  if (locked && locked.exitCode === null && locked.signalCode === null) locked.kill('SIGTERM');
  if (closed) {
    let timer;
    try {
      evidence.lockOwnerExit = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned lock process did not exit')), 10000); })]);
    } catch (error) { evidence.status = 'failed'; evidence.cleanupError = error.message; }
    finally { clearTimeout(timer); }
  }
  await fs.writeFile(path.join(root, 'filesystem-boundary-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.status === 'passed' ? 0 : 1;
