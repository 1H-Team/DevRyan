import path from 'node:path';
import { execFile } from 'node:child_process';

/** @typedef {{ protocol: 'devryan.windows-file-identity/1', volume: string, fileId: string,
 * type: 'file' | 'directory', reparsePoint: boolean, linkCount: number,
 * currentOwner: boolean, privateAcl: boolean }} WindowsFileIdentity */
const refused = () => Object.assign(new Error('private_windows_file_unverified'), { code: 'private_windows_file_unverified' });

/** @returns {WindowsFileIdentity} */
export function parseWindowsFileIdentity(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value;
  try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'currentOwner,fileId,linkCount,privateAcl,protocol,reparsePoint,type,volume'
    || value.protocol !== 'devryan.windows-file-identity/1' || typeof value.volume !== 'string' || !/^[a-f0-9]{16}$/.test(value.volume)
    || typeof value.fileId !== 'string' || !/^[a-f0-9]{32}$/.test(value.fileId) || !['file', 'directory'].includes(value.type)
    || !Number.isSafeInteger(value.linkCount) || value.linkCount < 1
    || ['reparsePoint', 'currentOwner', 'privateAcl'].some(key => typeof value[key] !== 'boolean')) throw refused();
  return value;
}

// The caller owns launcher verification. Native compilation probes deliberately
// use unaccepted helpers; this operation grants no execution admission.
async function nativeFileOperation(launcher, operation, target, bytes) {
  if (process.platform !== 'win32' || typeof launcher !== 'string' || !path.win32.isAbsolute(launcher)
    || typeof target !== 'string' || !/^[A-Za-z]:\\/.test(target) || path.win32.resolve(target) !== target
    || /[\u0000-\u001f]/.test(target)) throw refused();
  const raw = await new Promise((resolve, reject) => {
    const child = execFile(launcher, [operation, target], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        const failure = refused();
        if (operation.startsWith('--create-private-') && error.code === 125
          && /^exclusive private (?:directory|file) failed \((?:80|183)\)\r?\n$/.test(stderr)) failure.code = 'EEXIST';
        reject(failure);
      });
    child.stdin.on('error', () => {}); // The callback reports a refused or closed helper.
    child.stdin.end(bytes);
  });
  return parseWindowsFileIdentity(raw);
}

function requirePrivate(identity, type) {
  if (identity.type !== type || identity.reparsePoint || !identity.currentOwner || !identity.privateAcl
    || type === 'file' && identity.linkCount !== 1) throw refused();
  return identity;
}

export async function ensureWindowsPrivateDirectory(launcher, directory) {
  let identity;
  try { identity = await nativeFileOperation(launcher, '--create-private-directory', directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    identity = await nativeFileOperation(launcher, '--inspect-path', directory);
  }
  return requirePrivate(identity, 'directory');
}

export async function createWindowsPrivateFile(launcher, file, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1048576) throw refused();
  return requirePrivate(await nativeFileOperation(launcher, '--create-private-file', file, bytes), 'file');
}
