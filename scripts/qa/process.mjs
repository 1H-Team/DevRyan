import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { useDetachedChildren } from '../dev-child-utils.mjs';
import { createQaProcessOwnership } from './process-ownership.mjs';

export const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const waitForOwnedParentExit = (child, timeoutMs = 30000) => new Promise(resolve => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  const finish = () => { clearTimeout(timer); child.off('exit', finish); child.off('error', finish); resolve(); };
  const timer = setTimeout(finish, timeoutMs);
  child.once('exit', finish); child.once('error', finish);
});

// Keep handles only to children created by this run. Never discover/kill a
// running user's app by name, port, or executable path.
export const startOwnedProcess = (command, args, options) => {
  const child = spawn(command, args, { ...options, detached: useDetachedChildren, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let spawnError = null;
  const capture = (chunk) => { log = (log + chunk.toString()).slice(-64 * 1024); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => { spawnError = error; });
  const ownership = createQaProcessOwnership(child);
  let exitAt = null, shutdownStartedAt = null, shutdownFinishedAt = null;
  const parentSignals = [];
  child.once('exit', () => { exitAt = Date.now(); });
  const evidence = () => ({ ...ownership.getEvidence(), exitCode: child.exitCode, exitSignal: child.signalCode, exitAt,
    shutdownStartedAt, shutdownDurationMs: shutdownStartedAt === null ? null : (shutdownFinishedAt ?? Date.now()) - shutdownStartedAt,
    parentSignals: [...parentSignals] });
  let cleanup;
  return {
    child,
    getLog: () => log,
    getCleanupEvidence: evidence,
    auditStopped: () => ownership.auditStopped(),
    check: () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`QA child exited: ${child.exitCode ?? child.signalCode}`);
    },
    stop: ({ deadline } = {}) => cleanup ??= (async () => {
      shutdownStartedAt = Date.now();
      // Host shutdown drains the journal and managed scheduler before stopping
      // its separately detached OpenCode process. Give that cleanup time to
      // finish before the generic short escalation kills the host owner.
      const failures = [];
      try {
        try { await ownership.refresh(); } catch (error) { failures.push(error); }
        // Signal the actual ChildProcess handle while it is alive, then use
        // retained identities for descendants. An old numeric PGID can be
        // reused after its group exits and must not authorize a later kill.
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGINT'); parentSignals.push({ signal: 'SIGINT', at: Date.now() });
        }
        await waitForOwnedParentExit(child, deadline === undefined ? 30000 : Math.max(0, Math.min(30000, deadline - performance.now() - 10000)));
        try { await ownership.terminateRemaining({ deadline }); } catch (error) { failures.push(error); }
        try { await ownership.auditStopped(); } catch (error) { failures.push(error); }
      } finally { await ownership.closeTracking(); shutdownFinishedAt = Date.now(); }
      if (deadline !== undefined && performance.now() >= deadline) failures.push(Error('Owned process cleanup exceeded its phase deadline'));
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
      return evidence();
    })(),
  };
};
