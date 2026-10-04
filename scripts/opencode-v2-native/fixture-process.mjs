import { spawn } from 'node:child_process';
import { createQaProcessOwnership } from '../qa/process-ownership.mjs';
import { useDetachedChildren } from '../dev-child-utils.mjs';

export const startNativeFixtureProcess = (command, args, options) => {
  const child = spawn(command, args, { ...options, detached: useDetachedChildren, stdio: ['pipe', 'pipe', 'pipe'] });
  const ownership = createQaProcessOwnership(child);
  const pending = new Map();
  let nextID = 1;
  let log = '';
  let buffer = '';
  let failure;
  let closing;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = error => {
    failure ??= error;
    readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  // A handler is attached immediately, including an early spawn failure.
  ready.catch(() => {});
  const readyTimer = setTimeout(() => fail(new Error('Native fixture boot timed out')), 60_000);
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    if (code !== 0 || pending.size) fail(new Error(`Native fixture exited: ${code ?? signal}`));
  });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-64 * 1024); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { fail(new Error('Native fixture output exceeded bound')); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.startsWith('DEVRYAN_NATIVE_ACCEPTANCE ')) { log = (log + line + '\n').slice(-64 * 1024); continue; }
      try {
        const record = JSON.parse(line.slice('DEVRYAN_NATIVE_ACCEPTANCE '.length));
        if (record.type === 'ready') { clearTimeout(readyTimer); readyResolve(record); }
        else if (record.type === 'failed' || record.type === 'cleanup_failed') fail(Object.assign(new Error(record.error), { nativeError: record.nativeError }));
        else {
          const item = pending.get(record.id);
          if (!item) throw new Error('Native fixture reply identity mismatch');
          pending.delete(record.id); clearTimeout(item.timer);
          if (record.ok) item.resolve(record); else item.reject(Object.assign(new Error(record.error), { nativeError: record.nativeError }));
        }
      } catch (error) { fail(error); }
    }
  });
  const call = input => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = nextID++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native fixture command timed out: ${input.action}`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...input, id })}\n`, error => { if (error) fail(error); });
  });
  return { ready, call, child, getLog: () => log,
    crash: () => closing ??= (async () => {
      const errors = [];
      try {
        await ownership.refresh();
        if (child.exitCode === null && child.signalCode === null) {
          if (!child.kill('SIGKILL')) throw new Error('Owned native controller crash was not delivered');
          await new Promise((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
            const timer = setTimeout(() => reject(new Error('Owned native controller did not exit after crash')), 5_000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
        await ownership.terminateRemaining(); await ownership.auditStopped();
      } catch (error) { errors.push(error); }
      finally { clearTimeout(readyTimer); await ownership.closeTracking(); }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Native controller crash cleanup failed'), { evidence: ownership.getEvidence() });
      return { ...ownership.getEvidence(), terminationSource: 'owned-controller-SIGKILL-and-exit-event' };
    })(),
    stop: () => closing ??= (async () => {
      const errors = [];
      try {
        await ownership.refresh();
        if (child.exitCode === null && child.signalCode === null) {
          try { await call({ action: 'close' }); } catch (error) { errors.push(error); child.kill('SIGINT'); }
          await new Promise(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
            const timer = setTimeout(resolve, 15_000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
        await ownership.terminateRemaining(); await ownership.auditStopped();
      } catch (error) { errors.push(error); }
      finally { clearTimeout(readyTimer); await ownership.closeTracking(); }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Native fixture cleanup failed'), { evidence: ownership.getEvidence() });
      return ownership.getEvidence();
    })() };
};
