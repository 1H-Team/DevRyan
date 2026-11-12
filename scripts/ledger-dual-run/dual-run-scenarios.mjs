// Scenarios of the ledger dual run. Each has a fixture (what the stage holds
// before the first call) and a script that drives the ledger through the
// product host as the server does: leases with the agent's edits in their
// views, receipts, publications, reverts, warms, reconciliation after outside
// changes, concurrent sessions, maintenance and reopening in a new process.
import path from 'node:path';
import { NON_ASCII_TEXT, cloneDirectory, generator, writeProject } from './dual-run-fixture.mjs';

// ---------------------------------------------------------------- fixtures
const generated = (size) => async (stage) => { await writeProject(path.join(stage, 'project'), { size }); };

// ---------------------------------------------------------------- helpers
const scope = (s, session, user, call, extra = {}) => ({ directory: s.project, sessionID: session, userMessageID: user, messageID: `${user}-assistant`, callID: call, ...extra });

/** One confined edit: begin, claim, the agent's changes inside the view, receipt, finish, receipt read, cleanup. */
async function confinedEdit(s, label, { session = 's1', user, call, edit }) {
  await s.call(`${label}:prompt`, 'registerPrompt', { directory: s.project, sessionID: session, userMessageID: user });
  const lease = await s.call(`${label}:begin`, 'begin', scope(s, session, user, call));
  await s.call(`${label}:claim`, 'claimLease', { directory: s.project, token: lease.token, kind: 'process' });
  await edit(lease.workingDirectory, lease);
  await s.terminate(lease);
  await s.call(`${label}:finish`, 'finish', { directory: s.project, token: lease.token });
  await s.call(`${label}:receipt`, 'executionReceipt', { directory: s.project, token: lease.token });
  await s.call(`${label}:cleanup`, 'cleanupLease', { directory: s.project, token: lease.token });
  return lease;
}
const hunks = (text, count, tag) => {
  const lines = text.split('\n');
  for (let index = 0; index < count; index += 1) {
    const at = Math.floor(((index + 1) * lines.length) / (count + 1));
    lines.splice(at, 1, `// ${tag} hunk ${index}`);
  }
  return lines.join('\n');
};
const read = async (s, file) => (await s.fs.read(file)).toString('latin1');
const outcomes = (s, label, session, calls) => s.call(label, 'executionOutcomes', { directory: s.project, sessionID: session,
  calls: calls.map(([user, call]) => ({ messageID: `${user}-assistant`, callID: call })) });
const settleRevert = async (s, label, input) => {
  const tx = await s.call(`${label}:prepare`, 'prepareRevert', input);
  return s.call(`${label}:settle`, 'settleRevert', { directory: s.project, transactionID: tx.id, commit: true });
};

// ---------------------------------------------------------------- scenarios
export const SCENARIOS = Object.freeze([
  {
    name: 'smoke',
    description: 'One confined edit (two hunks) on a tiny project: the self-test.',
    fixture: generated('tiny'),
    async script(s) {
      await confinedEdit(s, 'edit', { user: 'u1', call: 'c1', edit: async (view) => {
        const file = path.join(view, 'src/m0/f0.js');
        await s.fs.write(file, hunks(await read(s, file), 2, 'smoke'));
      } });
      await outcomes(s, 'outcomes', 's1', [['u1', 'c1']]);
    },
  },
  {
    name: 'first-build',
    description: 'First build of a ledger on a few hundred mixed files (text, binary, symlinks, an executable, an 8 MiB+ file), then a refresh warm.',
    fixture: generated('full'),
    async script(s) {
      await s.call('warm', 'warm', { directory: s.project });
      await s.call('warm-refresh', 'warm', { directory: s.project, refresh: true });
      await s.call('directories', 'projectDirectories');
    },
  },
  {
    name: 'edits',
    description: 'Confined edits: several hunks in one file; several files; non-ASCII text; create, delete, rename; a mode change; the large file.',
    fixture: generated('full'),
    async script(s) {
      await confinedEdit(s, 'hunks', { user: 'u1', call: 'c1', edit: async (view) => {
        const file = path.join(view, 'src/m1/f1.js');
        await s.fs.write(file, hunks(await read(s, file), 6, 'hunks'));
      } });
      await confinedEdit(s, 'several', { user: 'u2', call: 'c2', edit: async (view) => {
        for (const name of ['src/m2/f2.js', 'src/m3/f3.js', 'src/m4/f4.js']) {
          const file = path.join(view, name);
          await s.fs.write(file, hunks(await read(s, file), 3, 'several'));
        }
      } });
      await confinedEdit(s, 'non-ascii', { user: 'u3', call: 'c3', edit: async (view) => {
        await s.fs.append(path.join(view, 'docs/ünïcödé-名前.txt'), `Ajout: ${NON_ASCII_TEXT}`);
        await s.fs.write(path.join(view, 'docs/note-1.md'), `# Nötë\n\n${NON_ASCII_TEXT.repeat(3)}`);
      } });
      await confinedEdit(s, 'tree-changes', { user: 'u4', call: 'c4', edit: async (view) => {
        await s.fs.write(path.join(view, 'src/new/created.js'), 'export const created = true;\n');
        await s.fs.write(path.join(view, 'assets/new.bin'), generator(7).bytes(2048));
        await s.fs.rm(path.join(view, 'src/m5/f5.js'));
        await s.fs.rename(path.join(view, 'src/m6/f6.js'), path.join(view, 'src/m6/renamed.js'));
        await s.fs.chmod(path.join(view, 'src/m7/f7.js'), 0o755);
        await s.fs.symlink('../src/new/created.js', path.join(view, 'links/to-created'));
      } });
      await confinedEdit(s, 'large', { user: 'u5', call: 'c5', edit: async (view) => {
        await s.fs.append(path.join(view, 'big/large.txt'), 'appended past the text limit\n');
      } });
      await outcomes(s, 'outcomes', 's1', [['u1', 'c1'], ['u2', 'c2'], ['u3', 'c3'], ['u4', 'c4'], ['u5', 'c5']]);
      await s.call('captured', 'capturedSessionState', { directory: s.project, sessionID: 's1' });
    },
  },
  {
    name: 'undo',
    description: 'Two operations, then an undo of the first, then a redo.',
    fixture: generated('small'),
    async script(s) {
      await confinedEdit(s, 'first', { user: 'u1', call: 'c1', edit: async (view) => {
        const file = path.join(view, 'src/m0/f0.js');
        await s.fs.write(file, hunks(await read(s, file), 3, 'first'));
        await s.fs.write(path.join(view, 'src/first-new.js'), 'first\n');
      } });
      await confinedEdit(s, 'second', { user: 'u2', call: 'c2', edit: async (view) => {
        const file = path.join(view, 'src/m1/f1.js');
        await s.fs.write(file, hunks(await read(s, file), 2, 'second'));
        const shared = path.join(view, 'src/m0/f0.js');
        await s.fs.append(shared, '// second touches the first file too\n');
      } });
      await settleRevert(s, 'revert-first', { directory: s.project, sessionID: 's1', messageID: 'u1' });
      await s.call('pending', 'pendingTransactions', { directory: s.project });
      const redo = await s.attempt('redo:prepare', 'prepareRedo', { directory: s.project, sessionID: 's1' });
      if (redo.ok && redo.value?.id) await s.call('redo:settle', 'settleRevert', { directory: s.project, transactionID: redo.value.id, commit: true });
      await outcomes(s, 'outcomes', 's1', [['u1', 'c1'], ['u2', 'c2']]);
    },
  },
  {
    name: 'reconcile',
    description: 'Files changed outside any lease (edit, create, delete), then a lease and a refresh warm reconcile them.',
    fixture: generated('small'),
    async script(s) {
      await s.call('warm', 'warm', { directory: s.project });
      await s.fs.append(path.join(s.project, 'src/m2/f2.js'), '// changed outside a lease\n');
      await s.fs.write(path.join(s.project, 'outside-new.txt'), 'created outside\n');
      await s.fs.rm(path.join(s.project, 'src/m3/f3.js'));
      await confinedEdit(s, 'after-outside', { user: 'u1', call: 'c1', edit: async (view) => {
        await s.fs.append(path.join(view, 'src/m4/f4.js'), '// inside\n');
      } });
      await s.fs.append(path.join(s.project, 'src/m4/f4.js'), '// outside again\n');
      await s.call('warm-refresh', 'warm', { directory: s.project, refresh: true });
      await s.call('freshness', 'viewFreshness', { directory: s.project, sessionID: 's1' });
    },
  },
  {
    name: 'concurrent',
    description: 'Calls in two sessions issued together: begins, finishes and cleanups racing for the ledger lock.',
    concurrent: true,
    fixture: generated('small'),
    async script(s) {
      for (const [session, user] of [['s1', 'u1'], ['s2', 'u2']]) await s.call(`prompt-${session}`, 'registerPrompt', { directory: s.project, sessionID: session, userMessageID: user });
      const [a, b] = await s.parallel([['begin-s1', 'begin', scope(s, 's1', 'u1', 'c1')], ['begin-s2', 'begin', scope(s, 's2', 'u2', 'c2')]]);
      await s.parallel([['claim-s1', 'claimLease', { directory: s.project, token: a.token, kind: 'process' }], ['claim-s2', 'claimLease', { directory: s.project, token: b.token, kind: 'process' }]]);
      await s.fs.append(path.join(a.workingDirectory, 'src/m8/f8.js'), '// session one\n');
      await s.fs.append(path.join(b.workingDirectory, 'src/m9/f9.js'), '// session two\n');
      await s.terminate(a); await s.terminate(b);
      await s.parallel([['finish-s1', 'finish', { directory: s.project, token: a.token }], ['finish-s2', 'finish', { directory: s.project, token: b.token }]]);
      await s.parallel([['cleanup-s1', 'cleanupLease', { directory: s.project, token: a.token }], ['cleanup-s2', 'cleanupLease', { directory: s.project, token: b.token }],
        ['leases', 'activeLeases', { directory: s.project }]]);
    },
  },
  {
    name: 'maintenance',
    description: 'Packing between operations: edits, then a new process whose ledger packs at once, then more edits in a third process.',
    fixture: generated('small'),
    async script(s) {
      for (let index = 1; index <= 3; index += 1) {
        await confinedEdit(s, `before-${index}`, { user: `u${index}`, call: `c${index}`, edit: async (view) => { await s.fs.append(path.join(view, `src/m${index}/f${index}.js`), `// before pack ${index}\n`); } });
      }
      // A process whose first act is maintenance: nothing commits in it before
      // `maintainLedger` returns, so the packing is the same in every run.
      await s.restart({ maintenance: { looseObjects: 1, packs: 1_000_000_000, commits: 1_000_000_000 } });
      await s.call('maintain', 'maintainLedger', { directory: s.project });
      await s.call('maintain-drain', 'drain');
      await s.restart();
      await confinedEdit(s, 'after-pack', { user: 'u4', call: 'c4', edit: async (view) => { await s.fs.append(path.join(view, 'src/m1/f1.js'), '// after pack\n'); } });
      await settleRevert(s, 'revert-after-pack', { directory: s.project, sessionID: 's1', messageID: 'u2' });
    },
  },
  {
    name: 'reopen',
    description: 'A ledger reopened by a new process: leases, outcomes and receipts read back, then a new edit and a revert across the restart.',
    fixture: generated('small'),
    async script(s) {
      await confinedEdit(s, 'before', { user: 'u1', call: 'c1', edit: async (view) => { await s.fs.append(path.join(view, 'src/m0/f0.js'), '// before reopen\n'); } });
      const open = await s.call('open-lease', 'begin', scope(s, 's1', 'u2', 'c2'));
      await s.restart();
      await s.call('leases', 'activeLeases', { directory: s.project });
      await s.call('cleanup-pending', 'pendingCleanup', { directory: s.project });
      await outcomes(s, 'outcomes', 's1', [['u1', 'c1'], ['u2', 'c2']]);
      await s.call('cancel-open', 'cancelLease', { directory: s.project, token: open.token });
      await s.call('cleanup-open', 'cleanupLease', { directory: s.project, token: open.token });
      await confinedEdit(s, 'after', { user: 'u3', call: 'c3', edit: async (view) => { await s.fs.append(path.join(view, 'src/m0/f0.js'), '// after reopen\n'); } });
      await settleRevert(s, 'revert-before', { directory: s.project, sessionID: 's1', messageID: 'u1' });
    },
  },
  {
    name: 'guards',
    description: 'Host callbacks: an input guard that passes and one that refuses, under the lock.',
    fixture: generated('small'),
    async script(s) {
      await s.call('prompt', 'registerPrompt', { directory: s.project, sessionID: 's1', userMessageID: 'u1' });
      const { revision } = await s.call('admission', 'nativeAdmissionState', { directory: s.project, sessionID: 's1' });
      await s.call('guarded', 'cancelUnstartedCall', { ...scope(s, 's1', 'u1', 'guarded'), requireAbsent: true, guard: { admissionRevision: revision, assertCurrent: { $fn: 'noop' } } });
      await s.attempt('refused', 'cancelUnstartedCall', { ...scope(s, 's1', 'u1', 'refused'), requireAbsent: true,
        guard: { admissionRevision: revision, assertCurrent: { $fn: 'throw', code: 'native_permit_revoked' } } });
      await outcomes(s, 'outcomes', 's1', [['u1', 'guarded'], ['u1', 'refused']]);
    },
  },
  {
    name: 'host-conduct',
    description: 'The host side of the seam: calls inside an execution admission (a live deadline, cancellable, metered), a call its caller aborts right after posting it, and a receipt stream the caller stops after one chunk.',
    fixture: generated('tiny'),
    async script(s) {
      await s.call('prompt', 'registerPrompt', { directory: s.project, sessionID: 's1', userMessageID: 'u1' });
      // The deadline crosses the seam as an absolute time; a replay re-bases it on its own clock.
      await s.admitted('warm-admitted', 'warm', [{ directory: s.project }], { deadlineMs: 600_000 });
      const lease = await s.admitted('begin-admitted', 'begin', [scope(s, 's1', 'u1', 'c1')], { deadlineMs: 600_000 });
      await s.call('claim', 'claimLease', { directory: s.project, token: lease.value.token, kind: 'process' });
      const file = path.join(lease.value.workingDirectory, 'src/m0/f0.js');
      await s.fs.write(file, hunks(await read(s, file), 2, 'conduct'));
      await s.terminate(lease.value);
      await s.call('finish', 'finish', { directory: s.project, token: lease.value.token });
      // `abort` posted by the host right behind the call.
      await s.admitted('begin-aborted', 'begin', [scope(s, 's1', 'u1', 'c2')], { abort: true });
      // The caller reads one chunk of the receipt and stops: `stream-return`.
      await s.admitted('receipt-partial', 'executionReceipt', [{ directory: s.project, token: lease.value.token }], { chunks: 1 });
      await s.call('receipt-full', 'executionReceipt', { directory: s.project, token: lease.value.token });
      await s.call('cleanup', 'cleanupLease', { directory: s.project, token: lease.value.token });
      await outcomes(s, 'outcomes', 's1', [['u1', 'c1'], ['u1', 'c2']]);
    },
  },
]);

export const scenarioNamed = (name, extra = []) => {
  const found = [...SCENARIOS, ...extra].find((scenario) => scenario.name === name);
  if (!found) throw new TypeError(`unknown scenario ${name}; known: ${[...SCENARIOS, ...extra].map((scenario) => scenario.name).join(', ')}`);
  return found;
};

/** A probe: the read paths a reopened ledger serves first, plus a refresh warm (recovery runs under its lock). */
export const probeScenario = ({ name = 'probe', fixture, sessions = ['s1', 's2'] }) => ({
  name, description: 'Read back an existing ledger in a new process.', fixture,
  async script(s) {
    await s.call('directories', 'projectDirectories');
    await s.call('leases', 'activeLeases', { directory: s.project });
    await s.call('pending', 'pendingTransactions', { directory: s.project });
    await s.call('cleanup', 'pendingCleanup', { directory: s.project });
    for (const session of sessions) await s.call(`captured-${session}`, 'capturedSessionState', { directory: s.project, sessionID: session });
    await s.call('warm', 'warm', { directory: s.project, refresh: true });
    for (const session of sessions) await s.call(`captured-after-${session}`, 'capturedSessionState', { directory: s.project, sessionID: session });
  },
});

/** Fixture: a copy of a parked stage (its project and ledger), for cross-reading and crash recovery. */
export const copyOf = (parked) => async (stage) => {
  for (const part of ['project', 'ledger']) {
    try { cloneDirectory(path.join(parked, part), path.join(stage, part)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
};
