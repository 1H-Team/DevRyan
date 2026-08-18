import { spawnSync } from 'node:child_process';

import {
  isManagedOpenCodeProcessCommand,
  isProcessRunning,
  readManagedOpenCodeRegistry,
  readProcessCommand,
  terminateManagedOpenCodePid,
} from './managed-process-registry.js';

/**
 * OpenCode's "ChatGPT Pro/Plus (browser)" sign-in binds this fixed loopback port to receive the
 * OAuth callback. Its helper assigns the server handle *before* `listen()` resolves and never
 * clears it when the listen fails, so a single EADDRINUSE poisons that OpenCode process for good:
 * every later browser sign-in short-circuits on the cached handle, hands the browser a redirect
 * URI nobody is listening on, and dies five minutes later on an opaque callback timeout.
 *
 * We cannot fix the vendored binary, but we can refuse to start a flow that is already doomed —
 * turning a silent five-minute hang into an actionable error naming the process in the way.
 */
export const OPENAI_OAUTH_LOOPBACK_PORT = 1455;

const resolvePlatform = (options) => options.platform || process.platform;

/** PIDs listening on `port`, excluding our own. Empty on Windows (no lsof) and on any failure. */
export const listPortListenerPids = (port, options = {}) => {
  const numericPort = Number(port);
  if (!Number.isFinite(numericPort) || numericPort <= 0 || numericPort > 65535) return [];
  if (resolvePlatform(options) === 'win32') return [];

  const spawnSyncImpl = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  const selfPid = options.selfPid ?? process.pid;

  let stdout = '';
  try {
    const result = spawnSyncImpl('lsof', ['-nP', '-t', `-iTCP:${Math.trunc(numericPort)}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    });
    stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  } catch {
    return [];
  }

  return [...new Set(
    stdout
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== selfPid),
  )];
};

/**
 * Classify whoever holds the loopback port. A holder is only ever considered reapable when it
 * meets the same bar the startup orphan reaper already uses — a registry record whose owning
 * DevRyan process is gone, and whose command line still looks like the OpenCode server we
 * recorded. Unknown processes are reported, never touched.
 */
export const inspectOAuthLoopbackPort = (options = {}) => {
  const port = options.port ?? OPENAI_OAUTH_LOOPBACK_PORT;
  const ownerPid = options.ownerPid ?? process.pid;
  const pids = typeof options.listPortListenerPids === 'function'
    ? options.listPortListenerPids(port, options)
    : listPortListenerPids(port, options);

  if (pids.length === 0) {
    return { port, busy: false, holders: [] };
  }

  const records = readManagedOpenCodeRegistry(options);
  const isRunning = typeof options.isProcessRunning === 'function'
    ? options.isProcessRunning
    : (pid) => isProcessRunning(pid);
  const commandReader = typeof options.readProcessCommand === 'function'
    ? options.readProcessCommand
    : (pid) => readProcessCommand(pid, options);

  const holders = pids.map((pid) => {
    const record = records.find((entry) => entry.childPid === pid) ?? null;
    const command = commandReader(pid);
    const looksLikeOpenCode = isManagedOpenCodeProcessCommand(command, record ?? { binary: 'opencode' });
    const ownedByThisHost = Boolean(record) && record.ownerPid === ownerPid;
    const ownerAlive = record ? isRunning(record.ownerPid) : null;

    return {
      pid,
      command,
      tracked: Boolean(record),
      looksLikeOpenCode,
      ownedByThisHost,
      ownerAlive,
      reapable: Boolean(record) && !ownedByThisHost && ownerAlive === false && looksLikeOpenCode,
    };
  });

  return { port, busy: true, holders };
};

export const describeOAuthLoopbackConflict = ({ port, holders }) => {
  const describeHolder = (holder) => {
    const raw = typeof holder.command === 'string' ? holder.command.trim() : '';
    if (!raw) return `PID ${holder.pid} (unknown process)`;
    // `ps` renders embedded newlines as literal octal escapes, which plain whitespace
    // collapsing leaves behind and which turn the message into an unreadable smear.
    const command = raw.replace(/\\0\d\d/g, ' ').replace(/\s+/g, ' ').trim();
    const truncated = command.length > 120 ? `${command.slice(0, 120)}…` : command;
    return `PID ${holder.pid} (${truncated})`;
  };

  const blockers = holders.filter((holder) => !holder.ownedByThisHost);
  const subject = blockers.length === 1 ? 'another process is' : `${blockers.length} other processes are`;

  return `OpenAI browser sign-in needs local port ${port}, but ${subject} already listening on it: `
    + `${blockers.map(describeHolder).join('; ')}. `
    + 'Quit that process (or use the headless sign-in method) and try again. '
    + 'Starting the flow now would leave the browser waiting for a callback that never arrives.';
};

/**
 * Preflight for the OpenAI browser OAuth flow. Reaps only provably-orphaned OpenCode servers,
 * then reports whether the flow can safely proceed.
 */
export const ensureOAuthLoopbackPortAvailable = async (options = {}) => {
  let inspection = typeof options.inspectOAuthLoopbackPort === 'function'
    ? options.inspectOAuthLoopbackPort(options)
    : inspectOAuthLoopbackPort(options);

  const canProceed = (result) => !result.busy || result.holders.every((holder) => holder.ownedByThisHost);
  if (canProceed(inspection)) {
    return { ok: true, reaped: [], inspection };
  }

  const terminate = typeof options.terminateManagedOpenCodePid === 'function'
    ? options.terminateManagedOpenCodePid
    : (pid) => terminateManagedOpenCodePid(pid, options);

  const reaped = [];
  for (const holder of inspection.holders.filter((entry) => entry.reapable)) {
    const terminated = await Promise.resolve(terminate(holder.pid)).catch(() => false);
    if (terminated) reaped.push(holder.pid);
  }

  if (reaped.length > 0) {
    inspection = typeof options.inspectOAuthLoopbackPort === 'function'
      ? options.inspectOAuthLoopbackPort(options)
      : inspectOAuthLoopbackPort(options);
    if (canProceed(inspection)) {
      return { ok: true, reaped, inspection };
    }
  }

  return {
    ok: false,
    reaped,
    inspection,
    message: describeOAuthLoopbackConflict(inspection),
  };
};
