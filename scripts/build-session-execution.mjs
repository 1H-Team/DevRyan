import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
  throw new Error('The native execution helper has not been implemented for this platform');
}
const output = path.resolve(process.argv.slice(2).find((arg) => arg !== '--verify') || path.join(root, '.cache/session-execution'));
const windows = process.platform === 'win32';
const source = path.join(root, `packages/harness-runtime/native/session-execution${windows ? '-windows' : ''}.c`);
const name = `DevRyan-execution-${process.platform}-${process.arch}${windows ? '.exe' : ''}`;
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const temporary = path.join(output, `${name}.${process.pid}.tmp`);
try {
  const flags = windows ? ['/nologo', '/std:c11', '/W4', '/WX', '/O2', '/D_CRT_SECURE_NO_WARNINGS',
    source, `/Fe:${temporary}`, `/Fo:${temporary}.obj`, '/link', 'advapi32.lib', 'user32.lib']
    : ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', temporary];
  await promisify(execFile)(process.env.CC || (windows ? 'cl.exe' : 'cc'), flags,
    { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 });
  await fs.chmod(temporary, 0o755);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = { version: 1, policy: 2, acceptance: false, platform: process.platform, arch: process.arch, binary: name,
    sha256: hash(await fs.readFile(temporary)), sourceSha256: hash(await fs.readFile(source)) };
  if (process.platform === 'darwin') {
    const spawnSource = path.join(root, 'packages/harness-runtime/native/session-spawn-darwin.c');
    const spawnLibrary = `${name}-spawn.dylib`;
    // The library is inserted into every confined child. Apple arm64 system
    // binaries such as /bin/cat are arm64e and refuse an arm64-only library.
    const architectures = process.arch === 'arm64' ? ['-arch', 'arm64', '-arch', 'arm64e'] : [];
    await promisify(execFile)(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-dynamiclib',
      ...architectures, spawnSource, '-o', path.join(output, spawnLibrary)], { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 });
    manifest.spawnLibrary = spawnLibrary;
    manifest.spawnSha256 = hash(await fs.readFile(path.join(output, spawnLibrary)));
  }
  await fs.rename(temporary, path.join(output, name));
  const manifestPath = path.join(output, `${name}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  if (process.argv.includes('--verify')) {
    await promisify(execFile)(process.execPath, [path.join(root, 'scripts/verify-session-execution.mjs')], {
      cwd: root, env: { ...process.env, DEVRYAN_TEST_EXECUTION_LAUNCHER: path.join(output, name) },
      timeout: 300_000, maxBuffer: 1024 * 1024,
    });
    manifest.acceptance = true;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(path.join(output, name));
} finally { await fs.rm(temporary, { force: true }); await fs.rm(`${temporary}.obj`, { force: true }); }
