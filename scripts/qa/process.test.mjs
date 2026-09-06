import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it } from 'node:test';
import { startOwnedProcess } from './process.mjs';
import { createQaProcessOwnership } from './process-ownership.mjs';

const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for owned-process evidence');
};

it('stops only the child group it owns and tolerates repeated cleanup', async () => {
  const first = startOwnedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {});
  const second = startOwnedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {});
  try {
    await Promise.all([once(first.child, 'spawn'), once(second.child, 'spawn')]);
    await first.stop();
    await first.stop();
    assert.doesNotThrow(() => second.check());
    assert.throws(() => first.check(), /exited/);
  } finally { await Promise.all([first.stop(), second.stop()]); }
});

it('retains and stops a detached native descendant after its wrapper has exited', async () => {
  const code = `const {spawn}=require('node:child_process');
    const native=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    console.log(native.pid);setInterval(()=>{},1000);`;
  const owner = startOwnedProcess(process.execPath, ['-e', code], {});
  const neighbour = startOwnedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {});
  let nativePid;
  try {
    await until(() => {
      nativePid = Number(owner.getLog().trim());
      return nativePid > 0 && owner.getCleanupEvidence().observedProcesses.some(row => row.pid === nativePid);
    });
    const exited = once(owner.child, 'exit');
    owner.child.kill('SIGTERM'); await exited;
    assert.doesNotThrow(() => process.kill(nativePid, 0), 'The separately detached child survives the wrapper exit');
    const evidence = await owner.stop();
    assert.deepEqual(evidence.remainingProcessIds, []);
    assert.equal(evidence.trackingClosed, true);
    assert.ok(evidence.observedProcesses.some(row => row.pid === nativePid));
    assert.doesNotThrow(() => neighbour.check(), 'An unrelated owned tree must remain alive');
    await owner.auditStopped();
    await assert.rejects(async () => process.kill(nativePid, 0), error => error.code === 'ESRCH');
  } finally {
    await Promise.all([owner.stop(), neighbour.stop()]);
  }
});

it('retained start identities reject PID reuse and final audit fails for live descendants', async () => {
  const child = { pid: 12345, exitCode: null, signalCode: null };
  let rows = [{ pid: child.pid, parentPid: process.pid, startIdentity: 'root-1', running: true },
    { pid: 12346, parentPid: child.pid, startIdentity: 'native-1', running: true },
    { pid: 12347, parentPid: 12346, startIdentity: 'language-1', running: true }];
  const signalled = [];
  const ownership = createQaProcessOwnership(child, { intervalMs: 60000, readSnapshot: async () => rows,
    signal: (pid, kind) => { signalled.push({ pid, kind }); rows = rows.filter(row => row.pid !== pid); } });
  try {
    await ownership.refresh();
    child.exitCode = 0;
    rows = [{ pid: 12346, parentPid: 1, startIdentity: 'native-1', running: true },
      { pid: 12347, parentPid: 12346, startIdentity: 'language-1', running: true }];
    await assert.rejects(ownership.auditStopped(), /owned processes remain/);
    rows = [{ pid: 12346, parentPid: 1, startIdentity: 'unrelated-reused-pid', running: true },
      { pid: 12347, parentPid: 1, startIdentity: 'language-1', running: true }];
    await ownership.terminateRemaining();
    assert.deepEqual(signalled, [{ pid: 12347, kind: 'SIGTERM' }]);
    assert.equal(rows[0].startIdentity, 'unrelated-reused-pid');
    assert.deepEqual((await ownership.auditStopped()).remainingProcessIds, []);
  } finally { await ownership.closeTracking(); }
});

it('an OS observation gap cannot be reported as successful cleanup even after recovery', async () => {
  const child = { pid: 12345, exitCode: null, signalCode: null };
  let fail = false;
  let rows = [{ pid: child.pid, parentPid: process.pid, startIdentity: 'root-1', running: true }];
  const ownership = createQaProcessOwnership(child, { intervalMs: 60000, readSnapshot: async () => {
    if (fail) throw new Error('OS enumeration unavailable');
    return rows;
  } });
  try {
    await ownership.refresh(); fail = true;
    await assert.rejects(ownership.refresh(), /observation failed/);
    fail = false; child.exitCode = 0; rows = [];
    await assert.rejects(ownership.auditStopped(), /observation is incomplete/);
    assert.ok(ownership.getEvidence().observationErrors.length > 0);
  } finally { await ownership.closeTracking(); }
});
