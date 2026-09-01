import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DISPLAY_PATTERN = /^:([1-9]\d{0,3})$/u;
const DISPLAY_START_TIMEOUT_MS = 10_000;

export class VirtualDisplayError extends Error {
  constructor(message, code = 'DEVRYAN_BOT_DISPLAY_CONFIG_INVALID') {
    super(message);
    this.name = 'VirtualDisplayError';
    this.code = code;
    this.statusCode = 500;
  }
}

const waitForExit = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null) {
    resolve(true);
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve(false);
  }, timeoutMs);
  child.once('exit', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(true);
  });
});

export async function startVirtualDisplay({
  executablePath = '/usr/bin/Xvfb',
  display = ':99',
  spawnImpl = spawn,
  fsPromises = fs,
  timeoutMs = DISPLAY_START_TIMEOUT_MS,
} = {}) {
  const match = DISPLAY_PATTERN.exec(display);
  if (!match || typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
    || path.basename(executablePath) !== 'Xvfb' || typeof spawnImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new VirtualDisplayError('Virtual display configuration is invalid');
  }

  const socketPath = `/tmp/.X11-unix/X${match[1]}`;
  const child = spawnImpl(executablePath, [
    display,
    '-screen', '0', '1280x720x24',
    '-nolisten', 'tcp',
    '-noreset',
  ], {
    env: {
      LANG: 'C.UTF-8',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TMPDIR: '/tmp',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });

  let ready = false;
  let closed = false;
  let spawnError = null;
  const terminationListeners = new Set();
  const notifyTerminated = () => {
    ready = false;
    if (closed) return;
    for (const listener of terminationListeners) listener('DEVRYAN_BOT_DISPLAY_CLOSED');
    terminationListeners.clear();
  };
  child.once('error', (error) => { spawnError = error; });
  child.once('exit', notifyTerminated);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null) {
      throw new VirtualDisplayError(
        'Virtual display exited during startup',
        'DEVRYAN_BOT_DISPLAY_START_FAILED',
      );
    }
    try {
      await fsPromises.access(socketPath);
      ready = true;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new VirtualDisplayError(
          'Virtual display readiness check failed',
          'DEVRYAN_BOT_DISPLAY_START_FAILED',
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!ready) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw new VirtualDisplayError(
      'Virtual display startup timed out',
      'DEVRYAN_BOT_DISPLAY_START_FAILED',
    );
  }

  return Object.freeze({
    display,
    status: () => Object.freeze({ ready: ready && child.exitCode === null }),
    onTerminated(listener) {
      if (typeof listener !== 'function') return () => undefined;
      if (!ready || child.exitCode !== null) {
        queueMicrotask(() => listener('DEVRYAN_BOT_DISPLAY_CLOSED'));
        return () => undefined;
      }
      terminationListeners.add(listener);
      return () => terminationListeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      ready = false;
      terminationListeners.clear();
      if (child.exitCode === null) child.kill('SIGTERM');
      if (!await waitForExit(child, 2_000)) child.kill('SIGKILL');
      await waitForExit(child, 1_000);
    },
  });
}
