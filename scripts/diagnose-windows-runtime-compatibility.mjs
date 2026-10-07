// Bounded, publication-free experiments. Supplied LOCAL stdio does not modify
// Node/Bun's nested spawning behavior and cannot grant runtime admission.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindowsPrivateFile, createWindowsPrivateFileOwner, ensureWindowsPrivateDirectory } from '../packages/harness-runtime/lib/windows-private-files.js';
import { startSessionExecution } from '../packages/harness-runtime/lib/session-execution.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const runtimeCompatibilityCases = Object.freeze([
  { mode: 'direct', size: 0 }, { mode: 'direct', size: 4 }, { mode: 'direct', size: 262144 },
  { mode: 'sync-inherit', size: 262144 }, { mode: 'async-inherit', size: 262144 },
  { mode: 'sync-pipe', size: 262144 }, { mode: 'async-pipe', size: 262144 },
  { mode: 'ignore', size: 4 },
]);

// A real package build reads project inputs, produces a file, and verifies its
// bytes before emitting binary stdout/stderr. Nested APIs retain stock stdio.
export const runtimeCompatibilityProject = `
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const mode = process.argv[2];
const echo = () => {
  const data = fs.readFileSync(0);
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (manifest.name !== 'devryan-lpac-project' || manifest.scripts.build !== 'node project.cjs leaf') throw Error('Project identity changed');
  fs.writeFileSync('build-output.bin', data);
  if (!fs.readFileSync('build-output.bin').equals(data)) throw Error('Project build output changed');
  fs.writeSync(1, data); fs.writeSync(2, data);
};
if (mode === 'silent') process.exit(0);
else if (mode === 'leaf' || mode === 'direct') echo();
else if (mode === 'async-inherit' || mode === 'async-pipe') {
  const child = spawn(process.execPath, ['project.cjs', 'leaf'], { stdio: mode === 'async-inherit' ? [0, 1, 2] : ['pipe', 'pipe', 'pipe'] });
  child.once('error', () => process.exit(125));
  if (mode === 'async-pipe') {
    child.stdin.on('error', () => process.exit(125));
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.stdin.end(fs.readFileSync(0));
  }
  child.once('exit', (code, signal) => { process.exitCode = signal || code === null ? 125 : code; });
} else if (mode === 'sync-inherit' || mode === 'sync-pipe' || mode === 'ignore') {
  const input = mode === 'sync-inherit' ? undefined : fs.readFileSync(0);
  const child = spawnSync(process.execPath, ['project.cjs', mode === 'ignore' ? 'silent' : 'leaf'], {
    stdio: mode === 'sync-inherit' ? [0, 1, 2] : mode === 'ignore' ? 'ignore' : 'pipe',
    input: mode === 'sync-pipe' ? input : undefined, timeout: 10000, maxBuffer: 1048576,
  });
  if (child.error || child.status !== 0 || child.signal) process.exit(125);
  if (mode === 'sync-pipe') { fs.writeSync(1, child.stdout); fs.writeSync(2, child.stderr); }
} else process.exit(125);
`;

export function compatibilityPayload(size) {
  assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 262144);
  return Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
}

const pipeHash = bytes => {
  let result = 2166136261;
  for (const byte of bytes) result = Math.imul(result ^ byte, 16777619) >>> 0;
  return result;
};

export function validateLocalStdioReceipt(receipt, { mode, size }) {
  assert.deepEqual(Object.keys(receipt).sort(), ['admission', 'created', 'exitCode', 'inputBytes', 'inputError', 'protocol', 'settled',
    'stderrBytes', 'stderrError', 'stderrHash', 'stdoutBytes', 'stdoutError', 'stdoutHash', 'windowsError']);
  assert.equal(receipt.protocol, 'devryan.windows-local-stdio/1'); assert.equal(receipt.admission, false);
  assert.equal(receipt.created, true); assert.equal(receipt.settled, true);
  for (const key of ['exitCode', 'inputError', 'stdoutError', 'stderrError', 'windowsError']) assert.equal(receipt[key], 0);
  assert.equal(receipt.inputBytes, size);
  const expected = mode === 'ignore' ? Buffer.alloc(0) : compatibilityPayload(size);
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(receipt[`${stream}Bytes`], expected.length); assert.equal(receipt[`${stream}Hash`], pipeHash(expected));
  }
  return receipt;
}

export async function runWindowsRuntimeCompatibility(directory) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw Error('Actual native Windows runtime required');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = await fs.realpath(path.resolve(directory));
  assert.ok(root.startsWith(path.join(repo, '.cache') + path.sep));
  const launcher = path.join(root, `DevRyan-execution-win32-${process.arch}.exe`);
  const manifestBytes = await fs.readFile(`${launcher}.json`), manifest = JSON.parse(manifestBytes);
  const source = await fs.readFile(path.join(repo, 'packages/harness-runtime/native/session-execution-windows.c'));
  assert.equal(manifest.platform, 'win32'); assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.sourceSha256, hash(source)); assert.equal(hash(await fs.readFile(launcher)), manifest.sha256);
  const bun = JSON.parse(execFileSync('bun', ['-e', 'console.log(JSON.stringify({path:process.execPath,version:Bun.version,arch:process.arch}))'], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(bun.version, '1.3.14'); assert.equal(bun.arch, process.arch);
  const runtimes = [{ id: 'node', executable: process.execPath, version: process.versions.node }, { id: 'bun', executable: bun.path, version: bun.version }];
  const owner = createWindowsPrivateFileOwner({ launcher });
  const output = path.join(root, 'runtime-compatibility'); await fs.mkdir(output);
  const evidence = { protocol: 'devryan.windows-runtime-compatibility/1', source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceSha256: hash(source), supervisorSha256: manifest.sha256, manifestSha256: hash(manifestBytes), arch: process.arch,
    status: 'failed', admission: false, acceptance: false, runtimes: [], rows: [] };
  for (const runtime of runtimes) {
    const runtimeSource = await fs.realpath(runtime.executable);
    const sha256 = hash(await fs.readFile(runtimeSource)), size = (await fs.stat(runtimeSource)).size;
    evidence.runtimes.push({ id: runtime.id, version: runtime.version, sha256 });
    for (const cell of runtimeCompatibilityCases) {
      const fixture = path.join(output, `${runtime.id}-${cell.mode}-${cell.size}`);
      await ensureWindowsPrivateDirectory(launcher, fixture);
      const view = path.join(fixture, 'worktree'); await ensureWindowsPrivateDirectory(launcher, view);
      // The real executable and project are disposable, reviewed test inputs.
      // Ordinary host copies/writes do not bind the current user as owner.
      // Native creation gives every fixture file the required private identity.
      const executable = path.join(view, `${runtime.id}.exe`);
      await owner.streamFile(runtimeSource, executable, { expectedSha256: sha256, expectedSize: size });
      await createWindowsPrivateFile(launcher, path.join(view, 'package.json'), Buffer.from(JSON.stringify({ name: 'devryan-lpac-project', scripts: { build: 'node project.cjs leaf' } })));
      await createWindowsPrivateFile(launcher, path.join(view, 'project.cjs'), Buffer.from(runtimeCompatibilityProject));
      let stdout = '', stderr = '', handle, timer;
      const row = { runtime: runtime.id, ...cell, status: 'failed' };
      try {
        handle = await startSessionExecution({ launcher, lease: { viewDirectory: view }, command: launcher,
          args: ['--diagnose-local-stdio', String(cell.size), executable, 'project.cjs', cell.mode],
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT },
          onOutput: ({ stream, data }) => { if (stream === 'stdout') stdout = (stdout + data).slice(-8192); else stderr = (stderr + data).slice(-8192); } });
        row.termination = await Promise.race([handle.result, new Promise((_, reject) => { timer = setTimeout(() => { handle.cancel(); reject(Error('Bounded compatibility timeout')); }, 30000); })]);
        row.receipt = JSON.parse(stdout.trim());
        validateLocalStdioReceipt(row.receipt, cell);
        assert.equal(row.termination.confined, true); assert.equal(row.termination.terminated, true); assert.equal(row.termination.exitCode, 0);
        if (cell.mode !== 'ignore') assert.deepEqual(await fs.readFile(path.join(view, 'build-output.bin')), compatibilityPayload(cell.size));
        row.status = 'passed';
      } catch (error) { row.error = { code: error.code ?? null, message: error.message }; }
      finally {
        clearTimeout(timer);
        if (handle) { handle.cancel(); await handle.result.catch(() => {}); }
        await fs.writeFile(path.join(fixture, 'stdout.log'), stdout); await fs.writeFile(path.join(fixture, 'stderr.log'), stderr);
        row.stdoutSha256 = hash(stdout); row.stderrSha256 = hash(stderr); evidence.rows.push(row);
      }
    }
  }
  assert.equal(hash(await fs.readFile(launcher)), manifest.sha256); assert.deepEqual(await fs.readFile(`${launcher}.json`), manifestBytes);
  assert.equal(hash(await fs.readFile(path.join(repo, 'packages/harness-runtime/native/session-execution-windows.c'))), evidence.sourceSha256);
  evidence.status = evidence.rows.every(row => row.status === 'passed') ? 'passed' : 'failed';
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Pass only the owned supervisor output directory');
  const evidence = await runWindowsRuntimeCompatibility(process.argv[2]);
  console.log(JSON.stringify({ status: evidence.status, admission: false, rows: evidence.rows.map(({ runtime, mode, size, status }) => ({ runtime, mode, size, status })) }));
  process.exitCode = evidence.status === 'passed' ? 0 : 1;
}
