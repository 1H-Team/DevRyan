import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertWindowsBinaryArchitecture, REVIEWED_WINDOWS_EXECUTABLES as pins } from '../packages/web/server/lib/opencode/runtime-host/reviewed-windows-assets.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const bounded = maximum => {
  let size = 0;
  return new Transform({ transform(bytes, _, callback) {
    size += bytes.length;
    callback(size > maximum ? fail('windows_reviewed_download_bound') : null, bytes);
  } });
};
async function digest(file, algorithm = 'sha256', encoding = 'hex') {
  const value = createHash(algorithm);
  for await (const bytes of createReadStream(file)) value.update(bytes);
  return value.digest(encoding);
}
async function verify(file, pin, arch) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== pin.size || await fs.realpath(file) !== file
    || await digest(file) !== pin.sha256) throw fail('windows_reviewed_binary_invalid');
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(65536), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    assertWindowsBinaryArchitecture(bytes.subarray(0, bytesRead), arch);
  } finally { await handle.close(); }
}

// Build inputs only. The original six-family closure and Mac hydration remain
// unchanged; these candidates cannot supply confinement or admission authority.
export async function hydrateWindowsReviewedExecutables({ repository = root, arch, fetchImpl = fetch } = {}) {
  if (!Object.hasOwn(pins, arch)) throw fail('windows_reviewed_architecture_invalid');
  if (await fs.realpath(repository) !== repository) throw fail('windows_reviewed_root_invalid');
  const directory = path.join(repository, '.cache/windows-native', arch, 'assets');
  await fs.mkdir(directory, { recursive: true });
  if (await fs.realpath(directory) !== directory) throw fail('windows_reviewed_root_invalid');
  const assets = [];
  for (const [kind, pin] of Object.entries(pins[arch])) {
    const name = `DevRyan-${kind === 'ast' ? 'ast-grep' : 'Claude'}-win32-${arch}.exe`;
    const destination = path.join(directory, name);
    const archiveName = `${pin.package.split('/')[1]}-${pin.version}.tgz`;
    const url = `https://registry.npmjs.org/${pin.package}/-/${archiveName}`;
    let present = true;
    try { await verify(destination, pin, arch); }
    catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
    if (!present) {
      const scratch = await fs.mkdtemp(path.join(directory, '.download-'));
      try {
        const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.body) throw fail('windows_reviewed_download_failed');
        const archive = path.join(scratch, 'asset.tgz');
        await pipeline(Readable.fromWeb(response.body), bounded(256 * 1024 * 1024), createWriteStream(archive, { flags: 'wx' }));
        if (`sha512-${await digest(archive, 'sha512', 'base64')}` !== pin.integrity) throw fail('windows_reviewed_archive_invalid');
        const binary = path.join(scratch, 'asset.exe');
        const child = spawn('tar', ['-xOzf', archive, pin.member], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const completion = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', code => code === 0 ? resolve() : reject(fail('windows_reviewed_extraction_failed')));
        });
        try { await Promise.all([pipeline(child.stdout, bounded(pin.size), createWriteStream(binary, { flags: 'wx' })), completion]); }
        catch (error) { child.kill(); await completion.catch(() => {}); throw error; }
        await verify(binary, pin, arch);
        await fs.link(binary, destination);
      } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    }
    await verify(destination, pin, arch);
    assets.push({ kind, path: name, package: pin.package, version: pin.version, archiveURL: url, integrity: pin.integrity, size: pin.size, sha256: pin.sha256 });
  }
  return { directory, assets };
}

async function qualify() {
  if (process.argv.length !== 2) throw fail('windows_reviewed_arguments_invalid');
  if (process.platform !== 'win32' || !Object.hasOwn(pins, process.arch)) throw fail('windows_reviewed_native_host_required');
  const output = path.join(root, '.cache/windows-native', process.arch);
  const report = { schema: 1, status: 'failed', platform: process.platform, arch: process.arch,
    scope: 'Pinned executable PE identity and native version checks only; no confinement, controller or runtime admission acceptance' };
  await fs.mkdir(output, { recursive: true });
  if (await fs.realpath(output) !== output) throw fail('windows_reviewed_root_invalid');
  try {
    const { directory, assets } = await hydrateWindowsReviewedExecutables({ arch: process.arch });
    report.assets = assets; report.probes = [];
    const scratch = await fs.mkdtemp(path.join(output, 'version-home-'));
    try {
      const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
      Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TEMP: scratch, TMP: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
        CLAUDE_CONFIG_DIR: scratch, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_COLOR: '1' });
      for (const asset of assets) {
        const result = await promisify(execFile)(path.join(directory, asset.path), ['--version'], { cwd: scratch, env, windowsHide: true, timeout: 30000, maxBuffer: 4096 });
        assert.equal(result.stdout.trim(), asset.kind === 'ast' ? `ast-grep ${asset.version}` : `${asset.version} (Claude Code)`);
        assert.equal(result.stderr.trim(), '');
        await verify(path.join(directory, asset.path), pins[process.arch][asset.kind], process.arch);
        report.probes.push({ kind: asset.kind, version: asset.version, versionOutputSha256: hash(result.stdout), status: 'passed' });
      }
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    report.status = 'asset-candidate-passed';
  } catch (error) { report.errorCode = /^windows_reviewed_[a-z_]+$/.test(error.code ?? '') ? error.code : 'windows_reviewed_execution_failed'; }
  await fs.writeFile(path.join(output, 'reviewed-executables-evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, errorCode: report.errorCode, output }));
  if (report.status !== 'asset-candidate-passed') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  qualify().catch(error => { console.error(/^windows_reviewed_[a-z_]+$/.test(error.code ?? '') ? error.code : 'windows_reviewed_execution_failed'); process.exitCode = 1; });
}
