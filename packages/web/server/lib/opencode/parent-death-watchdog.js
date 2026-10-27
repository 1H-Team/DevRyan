import { spawn } from 'node:child_process';

// Blocks until the owning server's end of stdin closes (the server exited for
// any reason, including SIGKILL or a crash), then signals the OpenCode process
// group only if that PID still runs our exact `serve --port N` command line.
// A process it cannot identify is never touched.
const WATCHDOG_SCRIPT = [
  'read -r _',
  'owned() { c=$(ps -o command= -p "$1" 2>/dev/null); case "$c" in *" $4 "*"$3 $2 "*|*" $4 "*"$3 $2") return 0;; esac; return 1; }',
  'owned "$1" "$2" "$3" "$4" || exit 0',
  'kill -TERM -- -"$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null',
  'i=0; while [ $i -lt 30 ]; do owned "$1" "$2" "$3" "$4" || exit 0; sleep 0.1; i=$((i+1)); done',
  'kill -KILL -- -"$1" 2>/dev/null || kill -KILL "$1" 2>/dev/null',
].join('\n');

// The same parent-death contract for a child identified by its exact argv
// (ps joins argv with spaces). Used for helpers such as `cloudflared` whose
// command line carries no port or private instance nonce.
const COMMAND_WATCHDOG_SCRIPT = [
  'read -r _',
  'owned() { [ "$(ps -ww -o command= -p "$1" 2>/dev/null)" = "$2" ]; }',
  'owned "$1" "$2" || exit 0',
  'kill -TERM -- -"$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null',
  'i=0; while [ $i -lt 30 ]; do owned "$1" "$2" || exit 0; sleep 0.1; i=$((i+1)); done',
  'kill -KILL -- -"$1" 2>/dev/null || kill -KILL "$1" 2>/dev/null',
].join('\n');

const spawnWatchdog = ({ args, code, spawnImpl }) => {
  // A failed spawn is reported, never silent: the caller must not keep a
  // server that nothing ties to this process.
  const unavailable = (cause) => ({ pid: null, error: { code,
    cause: typeof cause?.code === 'string' ? cause.code : null }, dispose() {} });
  let watchdog;
  try {
    watchdog = spawnImpl('/bin/sh', ['-c', ...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
      // Its own group: a signal to this server's group must not take the
      // watchdog down before it can clean up.
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    return unavailable(error);
  }
  if (!watchdog || typeof watchdog.on !== 'function' || !Number.isSafeInteger(watchdog.pid)) {
    try { watchdog?.kill?.('SIGKILL'); } catch { /* Never started. */ }
    return unavailable(null);
  }
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
};

/** Ties a managed OpenCode server's lifetime to this process on POSIX hosts.
 * Dispose it when the child exits or is closed normally. */
export function startParentDeathWatchdog({ childPid, port, nativeInstanceID, migrationInstanceID, providerInstanceID, platform = process.platform, spawnImpl = spawn } = {}) {
  const instanceID = providerInstanceID ?? migrationInstanceID ?? nativeInstanceID;
  const native = typeof instanceID === 'string' && /^[a-f0-9-]{32,64}$/.test(instanceID);
  if (platform === 'win32' || !Number.isSafeInteger(childPid) || childPid <= 0 || (!native && (!Number.isSafeInteger(port) || port <= 0))) {
    return { pid: null, dispose() {} };
  }
  return spawnWatchdog({ code: 'managed_opencode_watchdog_unavailable', spawnImpl, args: [WATCHDOG_SCRIPT, 'devryan-opencode-watchdog',
    String(childPid), native ? instanceID : String(port), native ? '--native-instance' : '--port',
    providerInstanceID ? '--provider-worker' : migrationInstanceID ? '--migrate' : 'serve'] });
}

/** Ties a child identified by its exact argv to this process on POSIX hosts.
 * Dispose it when the child exits or is stopped normally. */
export function startCommandParentDeathWatchdog({ childPid, argv, code = 'child_watchdog_unavailable', platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform === 'win32' || !Number.isSafeInteger(childPid) || childPid <= 0 || !Array.isArray(argv) || argv.length === 0
    || !argv.every((value) => typeof value === 'string' && value.length > 0 && !/[\0\n\r]/.test(value))) {
    return { pid: null, dispose() {} };
  }
  return spawnWatchdog({ code, spawnImpl, args: [COMMAND_WATCHDOG_SCRIPT, 'devryan-child-watchdog', String(childPid), argv.join(' ')] });
}
