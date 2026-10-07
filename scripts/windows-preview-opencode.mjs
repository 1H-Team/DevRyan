import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sha256File } from './windows-preview-release.mjs';
import { WINDOWS_PREVIEW_OPENCODE_VERSION as version } from '../packages/electron/windows-preview.mjs';
import { WINDOWS_PREVIEW_OPENCODE_PINS } from '../packages/electron/windows-preview.mjs';

export { WINDOWS_PREVIEW_OPENCODE_PINS };
const bounded = maximum => {
  let size = 0;
  return new Transform({ transform(bytes, _, callback) {
    size += bytes.length;
    callback(size > maximum ? new Error('windows_preview_download_bound') : null, bytes);
  } });
};
export function assertPreviewPeArchitecture(bytes, arch) {
  const machine = { x64: 0x8664, arm64: 0xaa64 }[arch];
  if (!machine || bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('windows_preview_pe_invalid');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset + 26 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(offset + 4) !== machine || bytes.readUInt16LE(offset + 24) !== 0x20b) throw new Error('windows_preview_pe_architecture_mismatch');
}
export async function verifyPreviewExecutable(file, arch) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1_000_000 || stat.size > 256 * 1024 * 1024) throw new Error('windows_preview_executable_invalid');
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    assertPreviewPeArchitecture(bytes.subarray(0, bytesRead), arch);
  } finally { await handle.close(); }
  return { arch, size: stat.size, sha256: await sha256File(file) };
}
export async function stageWindowsPreviewOpencode({ directory, arch, fetchImpl = fetch }) {
  const pin = WINDOWS_PREVIEW_OPENCODE_PINS[arch];
  if (!pin || !path.isAbsolute(directory)) throw new Error('windows_preview_stage_invalid');
  await fs.mkdir(directory, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(directory, '.stock-'));
  try {
    const url = `https://registry.npmjs.org/${pin.package}/-/${pin.package.split('/')[1]}-${version}.tgz`;
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error('windows_preview_download_failed');
    const archive = path.join(scratch, 'stock.tgz');
    await pipeline(Readable.fromWeb(response.body), bounded(256 * 1024 * 1024), createWriteStream(archive, { flags: 'wx' }));
    const digest = createHash('sha512');
    for await (const bytes of createReadStream(archive)) digest.update(bytes);
    if (`sha512-${digest.digest('base64')}` !== pin.integrity) throw new Error('windows_preview_archive_integrity_failed');
    // Extract exact regular file contents to an owned file; tar never chooses
    // a destination path from the archive or installs npm lifecycle scripts.
    const binary = path.join(scratch, 'opencode.exe');
    const child = spawn('tar', ['-xOzf', archive, 'package/bin/opencode.exe'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.resume();
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('windows_preview_extract_failed')));
    });
    const timeout = setTimeout(() => child.kill(), 60_000);
    try { await Promise.all([pipeline(child.stdout, bounded(256 * 1024 * 1024), createWriteStream(binary, { flags: 'wx' })), completion]); }
    catch (error) { child.kill(); await completion.catch(() => {}); throw error; }
    finally { clearTimeout(timeout); }
    const identity = await verifyPreviewExecutable(binary, arch);
    const destination = path.join(directory, 'opencode.exe');
    await fs.copyFile(binary, destination, fs.constants.COPYFILE_EXCL);
    const receipt = { schema: 1, package: pin.package, version, integrity: pin.integrity, archiveURL: url, ...identity };
    await fs.writeFile(path.join(directory, 'opencode.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, arch] = process.argv.slice(2);
  if (process.argv.length !== 4 || process.platform !== 'win32' || process.arch !== arch) throw new Error('windows_preview_native_host_required');
  const receipt = await stageWindowsPreviewOpencode({ directory: path.resolve(directory), arch });
  const profile = await fs.mkdtemp(path.join(path.resolve(directory), '.version-'));
  try {
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile,
      XDG_STATE_HOME: profile, XDG_CACHE_HOME: profile };
    const { stdout, stderr } = await promisify(execFile)(path.join(path.resolve(directory), 'opencode.exe'), ['--version'],
      { cwd: profile, env, timeout: 30_000, maxBuffer: 4096, windowsHide: true });
    if (stdout.trim() !== `opencode v${version}` || stderr.trim()) throw new Error('windows_preview_native_version_mismatch');
    console.log(JSON.stringify({ package: receipt.package, version, arch, sha256: receipt.sha256 }));
  } finally { await fs.rm(profile, { recursive: true, force: true }); }
}
