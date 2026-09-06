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

const waitForOwnedParentExit = child => new Promise(resolve => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  const finish = () => { clearTimeout(timer); child.off('exit', finish); child.off('error', finish); resolve(); };
  const timer = setTimeout(finish, 30_000);
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
  let cleanup;
  return {
    child,
    getLog: () => log,
    getCleanupEvidence: () => ownership.getEvidence(),
    auditStopped: () => ownership.auditStopped(),
    check: () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`QA child exited: ${child.exitCode ?? child.signalCode}`);
    },
    stop: () => cleanup ??= (async () => {
      // Host shutdown drains the journal and managed scheduler before stopping
      // its separately detached OpenCode process. Give that cleanup time to
      // finish before the generic short escalation kills the host owner.
      const failures = [];
      try {
        try { await ownership.refresh(); } catch (error) { failures.push(error); }
        // Signal the actual ChildProcess handle while it is alive, then use
        // retained identities for descendants. An old numeric PGID can be
        // reused after its group exits and must not authorize a later kill.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
        await waitForOwnedParentExit(child);
        try { await ownership.terminateRemaining(); } catch (error) { failures.push(error); }
        try { await ownership.auditStopped(); } catch (error) { failures.push(error); }
      } finally { await ownership.closeTracking(); }
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
      return ownership.getEvidence();
    })(),
  };
};
