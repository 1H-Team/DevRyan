import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const protocol = 'devryan.macos-gui-prerequisites/1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function requireDisposableMacRunner(env = process.env, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'arm64' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'macOS'
    || env.GITHUB_REPOSITORY !== '1H-Team/DevRyan' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) {
    throw Error('An ephemeral GitHub-hosted macOS ARM64 runner is required');
  }
}

export function readGuiPrerequisite(raw) {
  assert.equal(typeof raw, 'string'); assert.ok(Buffer.byteLength(raw) <= 4096);
  const value = JSON.parse(raw);
  assert.equal(value.protocol, protocol); assert.ok(['ready', 'unavailable'].includes(value.status));
  assert.deepEqual(Object.keys(value.checks).sort(), ['loggedIn', 'onConsole', 'sameUser', 'screenCapture']);
  for (const check of Object.values(value.checks)) assert.equal(typeof check, 'boolean');
  if (value.status === 'ready') {
    assert.ok(Object.values(value.checks).every(check => check === true));
    assert.equal(value.visible, true); assert.ok(Number.isSafeInteger(value.windowId) && value.windowId > 0);
  }
  return value;
}

export async function probeDisposableMacGui() {
  requireDisposableMacRunner();
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  assert.equal(sourceCommit, process.env.GITHUB_SHA);
  const output = path.join(repo, '.cache/macos-gui-prerequisites');
  await fs.mkdir(output, { mode: 0o700 });
  assert.equal(await fs.realpath(output), output);
  const source = path.join(repo, 'scripts/qa/macos-gui-prerequisites.swift'), binary = path.join(output, 'DevRyan-gui-prerequisite');
  const evidence = { protocol, sourceCommit, runner: process.env.RUNNER_OS, arch: process.arch,
    status: 'failed', continuity: 'not-run', sourceSha256: hash(await fs.readFile(source)), checks: {} };
  let child, closed, timer;
  try {
    evidence.os = (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim();
    evidence.consoleOwner = Number((await exec('/usr/bin/stat', ['-f', '%u', '/dev/console'])).stdout.trim());
    if (evidence.consoleOwner !== process.getuid() || evidence.consoleOwner === 0) {
      evidence.status = 'unavailable'; evidence.reason = 'No owned console login'; return evidence;
    }
    const bootstrap = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}`], { timeout: 5000, maxBuffer: 1048576 })
      .then(() => true, () => false);
    evidence.checks.guiBootstrap = bootstrap;
    if (!bootstrap) { evidence.status = 'unavailable'; evidence.reason = 'GUI bootstrap unavailable'; return evidence; }
    await exec('/usr/bin/xcrun', ['swiftc', source, '-o', binary], { timeout: 60000, maxBuffer: 65536 });
    evidence.binarySha256 = hash(await fs.readFile(binary));
    child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    const result = await new Promise((resolve, reject) => {
      let raw = '';
      child.stdout.on('data', bytes => {
        raw += bytes;
        if (Buffer.byteLength(raw) > 4096) { reject(Error('Oversized GUI probe')); return; }
        if (raw.includes('\n')) { try { resolve(readGuiPrerequisite(raw)); } catch (error) { reject(error); } }
      });
      child.once('error', reject);
      void closed.then(() => { if (!raw.includes('\n')) reject(Error('GUI probe exited before readiness')); }, reject);
      timer = setTimeout(() => reject(Error('GUI readiness timed out')), 15000);
    });
    clearTimeout(timer); evidence.probe = result;
    if (result.status === 'unavailable') { evidence.status = 'unavailable'; evidence.reason = 'WindowServer or capture prerequisite unavailable'; return evidence; }
    const screenshot = path.join(output, 'DevRyan-gui-prerequisite.png');
    await exec('/usr/sbin/screencapture', ['-x', '-l', String(result.windowId), screenshot], { timeout: 5000, maxBuffer: 65536 });
    const bytes = await fs.readFile(screenshot);
    assert.ok(bytes.length > 1024); assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    evidence.screenshot = { name: path.basename(screenshot), size: bytes.length, sha256: hash(bytes) };
    evidence.status = 'passed';
    return evidence;
  } catch (error) {
    evidence.reason = error instanceof Error ? error.message : 'GUI probe failed'; return evidence;
  } finally {
    clearTimeout(timer);
    if (child) {
      child.stdin.end();
      try {
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('GUI probe cleanup timed out')), 5000); })]);
      } catch { evidence.status = 'failed'; evidence.reason = 'GUI probe cleanup failed'; child.kill('SIGKILL'); await closed.catch(() => {}); }
      finally { clearTimeout(timer); }
    }
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await probeDisposableMacGui();
  console.log(JSON.stringify(evidence));
  process.exitCode = evidence.status === 'failed' ? 1 : 0;
}
