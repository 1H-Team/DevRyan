import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readResponseBody } from '../opencode-client/envelope.js';

export const STANDARD_OPENCODE_VERSION = '2.0.20';
const execFileAsync = promisify(execFile);
const failure = (code, message = code) => Object.assign(new Error(message), { code, statusCode: 503 });
const waitForExit = (exited, timeoutMs) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), timeoutMs);
  void exited.then(() => { clearTimeout(timer); resolve(true); });
});
const allocatePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port;
    listener.close(error => error ? reject(error) : resolve(port));
  });
});

/** Ordinary child ownership. This produces no confinement or durable termination receipt. */
export function createStandardPreviewLifecycle({ binary, dataDirectory, workingDirectory, configFile,
  environment = process.env, platform = process.platform, spawnProcess = spawn,
  runFile = execFileAsync, fetchImpl = fetch, reservePort = allocatePort,
  startupTimeoutMs = 30_000, isCatalogReady = async () => true, onChanged = () => {}, onBeforeStop = () => {} } = {}) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || binary.includes('\0')) throw failure('standard_preview_binary_required');
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw failure('standard_preview_data_directory_required');
  if (typeof workingDirectory !== 'string' || !path.isAbsolute(workingDirectory)) throw failure('standard_preview_working_directory_required');
  if (configFile !== undefined && (typeof configFile !== 'string' || !path.isAbsolute(configFile))) throw failure('standard_preview_config_file_invalid');
  const roots = path.join(dataDirectory, 'runtime');
  // Do not adopt ambient runtime selection, native flags, provider keys or credentials.
  const inheritedSystemKeys = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GIT_EXEC_PATH']);
  const childEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => inheritedSystemKeys.has(key.toUpperCase())));
  Object.assign(childEnvironment, {
    HOME: path.join(roots, 'home'), USERPROFILE: path.join(roots, 'home'), OPENCODE_TEST_HOME: path.join(roots, 'home'),
    XDG_DATA_HOME: path.join(roots, 'data'), XDG_CONFIG_HOME: path.join(roots, 'config'),
    XDG_CACHE_HOME: path.join(roots, 'cache'), XDG_STATE_HOME: path.join(roots, 'state'),
    APPDATA: path.join(roots, 'config'), LOCALAPPDATA: path.join(roots, 'data'),
    TMPDIR: path.join(roots, 'tmp'), TEMP: path.join(roots, 'tmp'), TMP: path.join(roots, 'tmp'),
    OPENCODE_DB: path.join(roots, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  });
  // Programmatic disposable-fixture option, never inherited from environment or HTTP settings.
  if (configFile !== undefined) Object.assign(childEnvironment, { OPENCODE_CONFIG: configFile,
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
  let child, childClosed, authHeaders = {}, epoch = 0, ready = false, baseUrl = '', port = null;
  const closedChildren = new WeakSet();
  let startPromise, stopPromise, shuttingDown = false, lastError = null;
  const changed = () => onChanged();
  const getRuntime = () => ({ generation: 2, version: STANDARD_OPENCODE_VERSION, baseUrl, epoch,
    runtimeMode: 'standard-preview', paths: { state: childEnvironment.XDG_STATE_HOME,
      config: path.join(childEnvironment.XDG_CONFIG_HOME, 'opencode'), data: path.join(childEnvironment.XDG_DATA_HOME, 'opencode') } });
  const getAuthHeaders = () => ({ ...authHeaders });
  const snapshot = () => ({ ready, port, epoch, lastError, version: ready ? STANDARD_OPENCODE_VERSION : null, running: Boolean(child) });
  const probe = async (signal = AbortSignal.timeout(5000)) => {
    if (!child || !baseUrl) return false;
    const response = await fetchImpl(`${baseUrl}/api/info`, { headers: authHeaders, signal });
    if (!response.ok) return false;
    const body = await readResponseBody(response, { maxResponseBytes: 64 * 1024, signal });
    return body.parsed && body.value?.version === STANDARD_OPENCODE_VERSION;
  };
  const stop = async () => {
    if (stopPromise) return stopPromise;
    const owned = child;
    ready = false; epoch += 1; changed();
    stopPromise = Promise.resolve().then(async () => {
      await onBeforeStop();
      if (!owned) return;
      // Only the current, still-live child may supply the PID. Never scan ports or kill inherited processes.
      if (child === owned && Number.isSafeInteger(owned.pid) && owned.exitCode === null && owned.signalCode === null) {
        if (platform === 'win32') {
          await runFile('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
            .catch(error => { if (owned.exitCode === null && owned.signalCode === null) throw error; });
        } else owned.kill('SIGTERM');
      }
      const exited = await waitForExit(childClosed, 5000);
      if (!exited) {
        if (platform !== 'win32' && child === owned) owned.kill('SIGKILL');
        const finalExit = await waitForExit(childClosed, 5000);
        if (!finalExit) throw failure('standard_preview_process_stop_failed');
      }
    }).finally(() => { stopPromise = undefined;
      if (child === owned && (!owned || closedChildren.has(owned))) { child = undefined; baseUrl = ''; port = null; authHeaders = {}; }
      changed(); });
    return stopPromise;
  };
  const start = () => {
    if (shuttingDown) return Promise.reject(failure('standard_preview_shutting_down'));
    if (startPromise) return startPromise;
    if (ready && child) return Promise.resolve(snapshot());
    startPromise = (async () => {
      if (child) await stop();
      await fs.mkdir(workingDirectory, { recursive: true });
      await Promise.all(['home', 'data', 'config', 'cache', 'state', 'tmp'].map(directory => fs.mkdir(path.join(roots, directory), { recursive: true })));
      const version = await runFile(binary, ['--version'], { env: childEnvironment, cwd: workingDirectory, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
      if (!/^(?:opencode v)?2\.0\.20$/.test(String(version.stdout).trim())) throw failure('standard_preview_version_mismatch');
      port = await reservePort(); baseUrl = `http://127.0.0.1:${port}`; epoch += 1;
      const password = randomBytes(32).toString('base64url');
      authHeaders = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
      const owned = spawnProcess(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        env: { ...childEnvironment, OPENCODE_SERVER_PASSWORD: password }, cwd: workingDirectory,
        windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'ignore'],
      });
      child = owned; lastError = null;
      childClosed = new Promise(resolve => {
        const closed = () => { closedChildren.add(owned); ready = false; if (child === owned) { epoch += 1; changed(); } resolve(); };
        owned.once('close', closed);
        owned.once('error', () => { lastError = 'standard_preview_process_failed'; if (!Number.isSafeInteger(owned.pid)) closed(); });
      });
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline && child === owned && owned.exitCode === null && owned.signalCode === null && !lastError) {
        if (await probe().catch(() => false)) {
          // A misconfigured stock runtime must not become an unauthenticated listener.
          const unauthenticated = await fetchImpl(`${baseUrl}/api/info`, { signal: AbortSignal.timeout(5000) });
          await unauthenticated.body?.cancel();
          if (unauthenticated.status !== 401) throw failure('standard_preview_authentication_required');
          if (closedChildren.has(owned) || shuttingDown) throw failure('standard_preview_process_failed');
          if (await isCatalogReady().catch(() => false)) { ready = true; changed(); return snapshot(); }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw failure('standard_preview_runtime_not_ready');
    })().catch(async error => {
      lastError = error.code || 'standard_preview_start_failed';
      try { await stop(); } catch { lastError = 'standard_preview_process_stop_failed'; }
      changed(); throw failure(lastError);
    }).finally(() => { startPromise = undefined; });
    return startPromise;
  };
  return { start, stop, probe, getRuntime, getAuthHeaders, snapshot,
    restart: async () => { await stop(); return start(); },
    close: async () => { shuttingDown = true; await startPromise?.catch(() => {}); await stop(); } };
}
