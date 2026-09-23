import { spawn } from 'node:child_process';

// Blocks until the owning server's end of stdin closes (the server exited for
// any reason, including SIGKILL or a crash), then signals the OpenCode process
// group only if that PID still runs our exact `serve --port N` command line.
// A process it cannot identify is never touched.
const WATCHDOG_SCRIPT = [
  'read -r _',
  'owned() { c=$(ps -o command= -p "$1" 2>/dev/null); case "$c" in *" serve "*"--port $2 "*|*" serve "*"--port $2") return 0;; esac; return 1; }',
  'owned "$1" "$2" || exit 0',
  'kill -TERM -- -"$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null',
  'i=0; while [ $i -lt 30 ]; do owned "$1" "$2" || exit 0; sleep 0.1; i=$((i+1)); done',
  'kill -KILL -- -"$1" 2>/dev/null || kill -KILL "$1" 2>/dev/null',
].join('\n');

/** Ties a managed OpenCode server's lifetime to this process on POSIX hosts.
 * Dispose it when the child exits or is closed normally. */
export function startParentDeathWatchdog({ childPid, port, platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform === 'win32' || !Number.isSafeInteger(childPid) || childPid <= 0 || !Number.isSafeInteger(port) || port <= 0) {
    return { pid: null, dispose() {} };
  }
  let watchdog;
  try {
    watchdog = spawnImpl('/bin/sh', ['-c', WATCHDOG_SCRIPT, 'devryan-opencode-watchdog', String(childPid), String(port)], {
      stdio: ['pipe', 'ignore', 'ignore'],
      // Its own group: a signal to this server's group must not take the
      // watchdog down before it can clean up.
      detached: true,
      windowsHide: true,
    });
  } catch {
    return { pid: null, dispose() {} };
  }
  if (!watchdog || typeof watchdog.on !== 'function') return { pid: null, dispose() {} };
  watchdog.on('error', () => {});
  watchdog.stdin?.on('error', () => {});
  watchdog.unref();
  watchdog.stdin?.unref?.();
  let disposed = false;
  return {
    pid: watchdog.pid ?? null,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { watchdog.kill('SIGKILL'); } catch { /* Already gone. */ }
    },
  };
}
