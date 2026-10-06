import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { beginWindowsPrivateStream, createWindowsPrivateFileOwner, parseWindowsNamespaceDurability } from '../harness-runtime/lib/windows-private-files.js';

const exec = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
export const WINDOWS_UPDATE_TREE_TOKEN = /^[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]{64}:(?:0|[1-9][0-9]*):[1-9][0-9]*$/;
export const WINDOWS_UPDATE_FILE_TOKEN = /^[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]{64}:(?:0|[1-9][0-9]*)$/;
export function parseWindowsUpdateFile(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw fail('update_file_unverified');
  let value; try { value = JSON.parse(raw); } catch { throw fail('update_file_unverified'); }
  if (!value || Object.keys(value).sort().join(',') !== 'protocol,size,token' || value.protocol !== 'devryan.windows-update-file/1'
    || typeof value.token !== 'string' || !WINDOWS_UPDATE_FILE_TOKEN.test(value.token) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 8 * 1024 ** 3
    || Number(value.token.split(':')[3]) !== value.size) throw fail('update_file_unverified');
  return value;
}
export const isWindowsUpdatePath = value => typeof value === 'string' && path.win32.isAbsolute(value)
  && path.win32.parse(value).root.length === 3 && value[1] === ':' && value.charCodeAt(2) === 92
  && path.win32.resolve(value) === value && ![...value].some(char => char.charCodeAt(0) < 32);
const absolute = isWindowsUpdatePath;
export function parseWindowsUpdateTree(raw, namespaceFlushed) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw fail('update_tree_unverified');
  let value; try { value = JSON.parse(raw); } catch { throw fail('update_tree_unverified'); }
  if (!value || Object.keys(value).sort().join(',') !== 'namespaceFlushed,protocol,token'
    || value.protocol !== 'devryan.windows-update-tree/1' || value.namespaceFlushed !== namespaceFlushed
    || typeof value.token !== 'string' || !WINDOWS_UPDATE_TREE_TOKEN.test(value.token)) throw fail('update_tree_unverified');
  const parts = value.token.split(':');
  if (!Number.isSafeInteger(Number(parts[3])) || Number(parts[3]) > 8 * 1024 ** 3
    || !Number.isSafeInteger(Number(parts[4])) || Number(parts[4]) < 1 || Number(parts[4]) > 65536) throw fail('update_tree_unverified');
  return value.token;
}
export function parseWindowsNsisReceipt(value, nonce) {
  if (!value || Object.keys(value).sort().join(',') !== 'exitCode,namespaceFlushed,nonce,protocol,status,targetToken,terminated'
    || value.protocol !== 'devryan.windows-nsis-owner/1' || value.status !== 'settled' || value.nonce !== nonce
    || value.terminated !== true || value.namespaceFlushed !== true || !Number.isSafeInteger(value.exitCode)
    || value.exitCode < 0 || value.exitCode > 0xffffffff || typeof value.targetToken !== 'string' || !WINDOWS_UPDATE_TREE_TOKEN.test(value.targetToken)) throw fail('update_termination_unconfirmed');
  try { parseWindowsUpdateTree(JSON.stringify({ protocol: 'devryan.windows-update-tree/1', token: value.targetToken, namespaceFlushed: true }), true); }
  catch { throw fail('update_termination_unconfirmed'); }
  return value;
}

/** The host must verify this exact native launcher before constructing an owner.
 * This module never substitutes Node filesystem mode bits for Windows privacy. */
export function createWindowsUpdateOwner({ launcher, assertHeld = () => {}, verifyLauncher = async () => {} }) {
  if (process.platform !== 'win32' || !absolute(launcher)) throw fail('update_platform_unsupported');
  const files = createWindowsPrivateFileOwner({ launcher });
  const operation = async (name, args, timeout = 120_000) => {
    await verifyLauncher();
    assertHeld();
    if (!args.every(value => typeof value === 'string' && !/[\u0000-\u001f]/.test(value))) throw fail('update_owner_arguments_invalid');
    try { const result = await exec(launcher, [name, ...args], { timeout, maxBuffer: 4096, windowsHide: true }); assertHeld(); return result.stdout; }
    catch (error) {
      if (/private namespace durability prerequisite failed/.test(error.stderr ?? '')) throw fail('update_namespace_durability_unavailable');
      if (/update tree held input failed \((?:2|3)\)/.test(error.stderr ?? '')) throw fail('ENOENT');
      if (name === '--inspect-update-file' && /update download private file failed \(2\)/.test(error.stderr ?? '')) throw fail('ENOENT');
      if (name === '--inspect-process' && /process identity handle failed \(87\)/.test(error.stderr ?? '')) throw fail('update_owner_gone');
      throw fail('update_native_operation_refused');
    }
  };
  const tree = async target => {
    if (!absolute(target)) throw fail('update_location_invalid');
    return parseWindowsUpdateTree(await operation('--inspect-update-tree', [target]), false);
  };
  const transition = async (name, source, destination, expected) => {
    if (!absolute(source) || !absolute(destination) || typeof expected !== 'string' || !WINDOWS_UPDATE_TREE_TOKEN.test(expected)) throw fail('update_location_invalid');
    return parseWindowsUpdateTree(await operation(name, [source, destination, expected]), true);
  };
  const version = async target => {
    const value = JSON.parse(await operation('--inspect-update-version', [path.win32.join(target, 'DevRyan.exe')]));
    if (!value || Object.keys(value).sort().join(',') !== 'arch,protocol,version' || value.protocol !== 'devryan.windows-update-version/1'
      || !/^\d+\.\d+\.\d+$/.test(value.version ?? '') || !['x64', 'arm64'].includes(value.arch)) throw fail('update_version_unverified');
    return { version: value.version, arch: value.arch };
  };
  const processIdentity = async pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw fail('update_owner_identity_invalid');
    let raw;
    try { raw = await operation('--inspect-process', [String(pid)], 5000); }
    catch (error) { if (error.code === 'update_owner_gone') return null; throw error; }
    const value = JSON.parse(raw);
    if (!value || value.protocol !== 'devryan.windows-process-identity/1' || value.pid !== pid
      || !/^win32:[a-f0-9]{16}$/.test(value.startIdentity ?? '') || typeof value.active !== 'boolean') throw fail('update_owner_identity_unavailable');
    return value;
  };
  const holdInstaller = async intent => {
    await verifyLauncher();
    assertHeld();
    const args = [intent.file, intent.sha256, String(intent.size), intent.target, intent.previousToken,
      String(intent.ownerPID), intent.ownerStart, intent.nonce, intent.receipt];
    if (!absolute(intent.file) || !absolute(intent.target) || !absolute(intent.receipt) || !/^[a-f0-9]{32}$/.test(intent.nonce)
      || !/^[a-f0-9]{64}$/.test(intent.sha256) || !Number.isSafeInteger(intent.size) || intent.size <= 0
      || intent.size > 8 * 1024 ** 3 || !WINDOWS_UPDATE_TREE_TOKEN.test(intent.previousToken)) throw fail('update_intent_invalid');
    const child = spawn(launcher, ['--hold-nsis-installer', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', heldResolve, heldReject;
    const held = new Promise((resolve, reject) => { heldResolve = resolve; heldReject = reject; });
    const timer = setTimeout(() => { heldReject(fail('update_installer_start_timeout')); child.stdin.destroy(); }, 30_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 4096) { heldReject(fail('update_installer_reply_invalid')); child.stdin.destroy(); return; }
      if (!output.includes('\n')) return;
      try {
        const value = JSON.parse(output.split('\n')[0]);
        if (Object.keys(value).sort().join(',') !== 'nonce,protocol,status' || value.protocol !== 'devryan.windows-nsis-owner/1'
          || value.status !== 'held' || value.nonce !== intent.nonce) throw fail('update_installer_reply_invalid');
        clearTimeout(timer); heldResolve();
      } catch (error) { heldReject(error); child.stdin.destroy(); }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(0, 4096); });
    child.stdin.on('error', () => {});
    const result = new Promise((resolve, reject) => {
      child.once('error', () => { clearTimeout(timer); heldReject(fail('update_installer_start_failed')); reject(fail('update_installer_start_failed')); });
      child.once('close', async code => {
        clearTimeout(timer);
        try {
          const lines = output.trim().split('\n');
          if (lines.length !== 2) throw fail(/namespace durability/.test(errors) ? 'update_namespace_durability_unavailable' : 'update_termination_unconfirmed');
          const receipt = parseWindowsNsisReceipt(JSON.parse(lines[1]), intent.nonce);
          if (code !== receipt.exitCode) throw fail('update_termination_unconfirmed');
          const durable = JSON.parse((await files.read(intent.receipt)).bytes.toString('utf8'));
          if (JSON.stringify(parseWindowsNsisReceipt(durable, intent.nonce)) !== JSON.stringify(receipt)) throw fail('update_termination_unconfirmed');
          resolve(receipt);
        } catch (error) { heldReject(error); reject(error); }
      });
    });
    void result.catch(() => {});
    try {
      await held;
      const identity = await processIdentity(child.pid);
      if (!identity?.active) throw fail('update_owner_identity_unavailable');
      return { pid: child.pid, start: identity.startIdentity,
        install: async () => { assertHeld(); child.stdin.end('install\n'); const receipt = await result; assertHeld(); return receipt; }, release: () => child.stdin.end() };
    } catch (error) { child.stdin.end(); await result.catch(() => {}); throw error; }
  };
  const holdInputs = async intent => {
    await verifyLauncher();
    const child = spawn(launcher, ['--hold-update-inputs', intent.launcher, intent.launcherSha256, intent.helper, intent.helperSha256],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorOutput = '', exited = false, readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', error => { readyReject(error); reject(error); });
      child.once('close', code => { exited = true; code === 0 ? resolve() : reject(fail('update_helper_hold_lost')); readyReject(fail('update_helper_hold_lost')); });
    }); void closed.catch(() => {});
    const timeout = setTimeout(() => { readyReject(fail('update_helper_hold_timeout')); child.stdin.end(); }, 30_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8'); if (output.length > 4096) { readyReject(fail('update_helper_hold_invalid')); child.stdin.end(); return; }
      if (!output.endsWith('\n')) return;
      try {
        const value = JSON.parse(output);
        if (Object.keys(value).sort().join(',') !== 'helperToken,launcherToken,protocol' || value.protocol !== 'devryan.windows-update-inputs/1'
          || value.launcherToken !== intent.launcherToken || value.helperToken !== intent.helperToken) throw fail('update_helper_changed');
        readyResolve();
      } catch (error) { readyReject(error); child.stdin.end(); }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString('utf8')).slice(0, 4096); });
    child.stdin.on('error', () => {});
    try { await ready; } catch (error) { child.stdin.end(); await closed.catch(() => {}); throw error; } finally { clearTimeout(timeout); }
    return { assertHeld: () => { if (exited || errorOutput) throw fail('update_helper_hold_lost'); },
      release: async () => { child.stdin.end(); await closed; } };
  };
  const beginDownload = async (file, { offset, size, expected }) => {
    await verifyLauncher(); assertHeld();
    const mapped = error => fail(error.code === 'private_windows_namespace_durability_unavailable' ? 'update_namespace_durability_unavailable'
      : error.code === 'private_windows_stream_termination_unconfirmed' ? 'update_download_termination_unconfirmed'
      : error.code === 'private_windows_stream_timeout' ? 'update_download_writer_timeout' : 'update_download_write_failed');
    let stream;
    try {
      stream = beginWindowsPrivateStream(launcher, file, { offset, maximum: size, expected });
      await stream.ready; assertHeld();
    } catch (error) { if (stream) await stream.cancel().catch(cancellation => { throw mapped(cancellation); }); throw mapped(error); }
    return { write: async bytes => { assertHeld(); try { await stream.write(bytes); assertHeld(); } catch (error) { throw mapped(error); } },
      finish: async () => { try { const result = await stream.finish(); assertHeld(); return result; } catch (error) { throw mapped(error); } } };
  };
  const waitOwner = async (pid, start) => {
    await verifyLauncher();
    assertHeld();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^win32:[a-f0-9]{16}$/.test(start ?? '')) throw fail('update_owner_identity_invalid');
    const child = spawn(launcher, ['--wait-update-owner', String(pid), start], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 4096) return readyReject(fail('update_owner_drain_unconfirmed'));
      if (output.includes('\n')) {
        try { const value = JSON.parse(output.split('\n')[0]); if (value.protocol !== 'devryan.windows-update-drain/1' || value.status !== 'held') throw fail('update_owner_drain_unconfirmed'); readyResolve(); }
        catch (error) { readyReject(error); }
      }
    }); child.stderr.on('data', () => {});
    const settled = new Promise((resolve, reject) => {
      child.once('error', error => { readyReject(error); reject(error); });
      child.once('close', code => {
        try { const lines = output.trim().split('\n'), value = JSON.parse(lines[1]); if (code !== 0 || lines.length !== 2 || value.protocol !== 'devryan.windows-update-drain/1' || value.status !== 'settled') throw fail('update_owner_drain_unconfirmed'); assertHeld(); resolve(); }
        catch (error) { readyReject(error); reject(error); }
      });
    }); void settled.catch(() => {}); await ready; return { settled };
  };
  const terminateProcess = async (pid, start, { graceful = false } = {}) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^win32:[a-f0-9]{16}$/.test(start ?? '') || typeof graceful !== 'boolean') throw fail('update_owner_identity_invalid');
    const value = JSON.parse(await operation('--terminate-update-process', [String(pid), start, graceful ? 'graceful' : 'terminate'], 40_000));
    if (!value || Object.keys(value).sort().join(',') !== 'graceful,pid,protocol,rootExited,startIdentity'
      || value.protocol !== 'devryan.windows-update-process-exit/1' || value.pid !== pid || value.startIdentity !== start
      || value.graceful !== graceful || value.rootExited !== true) throw fail('update_owner_drain_unconfirmed');
    return value;
  };
  const restoreRegistration = async (target, expected, previousVersion, installedVersion) => {
    if (!absolute(target) || !WINDOWS_UPDATE_TREE_TOKEN.test(expected ?? '') || [previousVersion, installedVersion].some(value => !/^\d+\.\d+\.\d+$/.test(value ?? ''))) throw fail('update_registration_invalid');
    const value = JSON.parse(await operation('--restore-update-registration', [target, expected, previousVersion, installedVersion]));
    if (!value || Object.keys(value).sort().join(',') !== 'protocol,registryFlushed,version' || value.protocol !== 'devryan.windows-update-registration/1'
      || value.registryFlushed !== true || value.version !== previousVersion) throw fail('update_registration_unconfirmed');
    return value;
  };
  const guarded = operation_ => async (...args) => { await verifyLauncher(); assertHeld(); const result = await operation_(...args); assertHeld(); return result; };
  return Object.freeze({ launcher, read: guarded(files.read), write: guarded(files.write), recover: guarded(files.recover), ensureDirectory: guarded(files.ensureDirectory),
    tree, version, processIdentity, holdInstaller, holdInputs, beginDownload, waitOwner, terminateProcess, restoreRegistration, assertHeld,
    file: async target => parseWindowsUpdateFile(await operation('--inspect-update-file', [target])),
    clone: (source, destination, expected) => transition('--clone-update-tree', source, destination, expected),
    rename: (source, destination, expected) => transition('--rename-update-tree', source, destination, expected),
    remove: async (target, expected) => parseWindowsUpdateTree(await operation('--remove-update-tree', [target, expected]), true),
    namespace: async target => parseWindowsNamespaceDurability(await operation('--inspect-namespace-durability', [target], 5000)) });
}
