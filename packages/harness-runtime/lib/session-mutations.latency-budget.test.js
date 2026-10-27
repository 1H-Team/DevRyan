// Harness overhead budgets for native tool calls, counted through the ledger's
// injected Git runner: processes started by ledger stores and state commits
// (`update-ref refs/devryan/state`). Counts are deterministic where timings
// are not, so a regression that adds a process or a commit per call fails here.
// Budgets assume the default direct tree commits (DEVRYAN_LEDGER_DIRECT_TREES).
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitRecords, gitTokens, readGitObject } from './session-changes-git.js';
import { withExecutionPreparation } from './execution-admission.js';
import { cleanupRoots, fixture, manyFiles, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);

const isStateCommit = (args) => args.includes('update-ref') && args.includes('refs/devryan/state');
const countingRunner = () => {
  const counts = { processes: 0, commits: 0, reads: 0 };
  let held;
  // Counts every process; a held state commit waits for its gate first.
  const pass = (args, run) => {
    counts.processes += 1;
    if (!isStateCommit(args)) return run();
    counts.commits += 1;
    if (!held) return run();
    const gate = held; held = undefined;
    return gate.then(run);
  };
  return { counts, holdNextCommit: (gate) => { held = gate; }, gitRunner: {
    git: (cwd, args, options) => pass(args, () => git(cwd, args, options)),
    gitTokens: (cwd, args, options) => pass(args, () => gitTokens(cwd, args, options)),
    gitRecords: (cwd, args, rows) => pass(args, () => gitRecords(cwd, args, rows)),
    readObject: (cwd, args, name, options) => { counts.reads += 1; return readGitObject(cwd, args, name, options); },
  } };
};
const measure = async (counts, action) => {
  const before = { ...counts };
  await action();
  return Object.fromEntries(Object.keys(counts).map((name) => [name, counts[name] - before[name]]));
};
const digest = 'b'.repeat(64);

describe('native tool harness budgets', () => {
  test('direct reads: one commit per call, one per parallel batch, no process per lookup', async () => {
    const { counts, gitRunner, holdNextCommit } = countingRunner();
    const f = await fixture({ gitRunner });
    const step = (user, call) => ({ directory: f.directory, sessionID: 's', userMessageID: user, messageID: `${user}-assistant`, callID: call });
    const read = async (identity) => {
      const { generation } = await f.runtime.admitDirect(identity);
      return f.runtime.finishDirect({ ...identity, token: randomUUID(), generation, executionFingerprint: digest });
    };
    await read(step('u0', 'warm'));
    const single = await measure(counts, () => read(step('u0', 'single')));
    expect(single.commits).toBe(1);
    // A direct tree commit runs one process, the guarded update-ref (it was
    // hash-object, update-index, write-tree and update-ref through the index).
    expect(single.processes).toBeLessThanOrEqual(1);
    const parallel = await measure(counts, () => Promise.all(Array.from({ length: 8 }, (_, index) => read(step('u1', `p${index}`)))));
    expect(parallel.commits).toBe(1);
    expect(parallel.processes).toBeLessThanOrEqual(1);
    // Separate requests a few milliseconds apart: the first may commit alone,
    // every later one joins the batch queued behind it. The first commit is
    // held until every finish has queued, so a fast runner cannot complete it
    // before the last request arrives; the deadline only prevents a hang.
    let arrived = 0, allArrived;
    const opened = Promise.race([new Promise((resolve) => { allArrived = () => resolve('arrived'); }),
      new Promise((resolve) => setTimeout(() => resolve('deadline'), 5_000).unref?.())]);
    holdNextCommit(opened);
    const staggered = await measure(counts, () => Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await new Promise((resolve) => setTimeout(resolve, index * 2));
      const identity = step('u2', `q${index}`);
      const { generation } = await f.runtime.admitDirect(identity);
      const finished = f.runtime.finishDirect({ ...identity, token: randomUUID(), generation, executionFingerprint: digest });
      if (++arrived === 8) allArrived();
      return finished;
    })));
    expect(await opened).toBe('arrived');
    expect(staggered.commits).toBeLessThanOrEqual(2);
    expect(staggered.processes).toBeLessThanOrEqual(2);
    expect((await f.runtime.executionOutcomes({ directory: f.directory, sessionID: 's',
      calls: Array.from({ length: 8 }, (_, index) => ({ messageID: 'u2-assistant', callID: `q${index}` })) }))
      .every((row) => row.outcome === 'finished')).toBe(true);
  });

  test('single-file confined edit: bounded commits and processes; a repeat edit restamps nothing', async () => {
    const { counts, gitRunner } = countingRunner();
    const f = await fixture({ gitRunner });
    await manyFiles(f, 60);
    const edit = async (index) => {
      const lease = await f.begin('s', `e${index}`, `edit${index}`);
      await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
      await fs.appendFile(path.join(lease.viewDirectory, 'd0/e0/f0.txt'), `edit ${index}\n`);
      await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
        JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
      expect((await f.finish(lease)).files).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
      await f.runtime.executionReceipt({ directory: f.directory, token: lease.token });
      await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
    };
    await edit(0);
    const measured = await measure(counts, () => edit(1));
    // Reserve, pin, ready, claim, publication intent and completion, cleanup:
    // each is a distinct durable state of the confined protocol. Publication
    // stamps the files it writes, so the next observation commits nothing.
    expect(measured.commits).toBeLessThanOrEqual(7);
    // 41 through Git's index; direct tree commits leave one update-ref per commit.
    expect(measured.processes).toBeLessThanOrEqual(16);
  });

  test('object reads per confined edit do not grow with the number of project files', async () => {
    const readsPerEdit = async (files) => {
      const { counts, gitRunner } = countingRunner();
      const f = await fixture({ gitRunner });
      await manyFiles(f, files);
      const edit = async (index) => {
        const lease = await f.begin('s', `e${index}`, `edit${index}`);
        await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
        await fs.appendFile(path.join(lease.viewDirectory, 'd0/e0/f0.txt'), `edit ${index}\n`);
        await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
          JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
        await f.finish(lease);
        await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
      };
      await edit(0);
      return (await measure(counts, () => edit(1))).reads;
    };
    const small = await readsPerEdit(60), large = await readsPerEdit(240);
    // The committed file index re-reads only documents whose object changed;
    // it used to read and parse every file document after each publication.
    expect(large - small).toBeLessThanOrEqual(8);
  });

  test('a session\'s later edits copy only the files that changed since its previous view, not the project', async () => {
    const { counts, gitRunner } = countingRunner();
    const f = await fixture({ gitRunner });
    await manyFiles(f, 60);
    const copies = (records) => Object.fromEntries((records.find((record) => record.phase === 'preparation' && record.state === 'completed')?.steps ?? '')
      .split(',').filter((step) => /^view_(copied|reused):/.test(step)).map((step) => [step.split(':')[0], Number(step.split(':')[1].split('/')[0])]));
    const edit = async (index, sessionID = 's') => {
      const records = [];
      const lease = await withExecutionPreparation({ sessionID, callID: `edit${index}` }, () => f.begin(sessionID, `e${index}`, `edit${index}`),
        { onDiagnostic: (record) => records.push(record), summary: { minMs: 0 } });
      await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
      await fs.appendFile(path.join(lease.viewDirectory, 'd0/e0/f0.txt'), `edit ${index}\n`);
      await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
        JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
      expect((await f.finish(lease)).files).toEqual([{ path: 'd0/e0/f0.txt', status: 'modified' }]);
      await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
      return copies(records);
    };
    const first = await edit(0);
    expect(first.view_reused).toBe(0);
    expect(first.view_copied).toBeGreaterThan(60);
    // Every later lease re-copies exactly the file the previous one edited.
    for (let index = 1; index <= 3; index += 1) expect(await edit(index)).toEqual({ view_copied: 1, view_reused: first.view_copied - 1 });
    let later;
    const measured = await measure(counts, async () => { later = await edit(4); });
    expect(later.view_copied).toBe(1);
    // The same durable protocol states as a full copy (see the single-file edit budget).
    expect(measured.commits).toBeLessThanOrEqual(7);
    // A session without a previous view adopts another session's standby;
    // with shared standbys off it copies everything.
    expect((await edit(5, 'other')).view_reused).toBeGreaterThan(60);
    expect((await withEnv({ DEVRYAN_VIEW_SHARED_STANDBY: '0' }, () => edit(6, 'third'))).view_reused).toBe(0);
  });

  test('read-only shell: no reconciliation, no view copy, and an empty publication', async () => {
    const { counts, gitRunner } = countingRunner();
    const f = await fixture({ gitRunner });
    await manyFiles(f, 60);
    const shell = async (index) => {
      const records = [];
      const lease = await withExecutionPreparation({ directory: f.directory, sessionID: 's', callID: `r${index}`, kind: 'shell' },
        () => f.begin('s', `r${index}`, `shell${index}`, { kind: 'process', preparation: 'read-only' }),
        { onDiagnostic: (record) => records.push(record), summary: { minMs: 0 } });
      expect(lease).toMatchObject({ state: 'ready', preparation: 'read-only' });
      // The private view is empty: the command reads the live project instead.
      expect(await fs.readdir(lease.viewDirectory)).toEqual([]);
      await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
      // Nothing a read-only lease's view holds is ever published.
      await fs.writeFile(path.join(lease.viewDirectory, 'stray.txt'), 'never published');
      await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
        JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
      expect((await f.finish(lease)).files).toEqual([]);
      expect((await f.runtime.executionReceipt({ directory: f.directory, token: lease.token })).files).toEqual([]);
      await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
      return records.find((record) => record.phase === 'preparation' && record.state === 'completed');
    };
    await shell(0);
    let summary;
    const measured = await measure(counts, async () => { summary = await shell(1); });
    // The phases that cost 2.5 s (reconciliation) and 3.8 s (view_files) at p50 in live QA never run.
    for (const phase of ['reconciliation', 'view_files', 'view_commit', 'view_git', 'view_inputs']) expect(summary.steps).not.toContain(`${phase}:`);
    // Reserve, ready, claim, publication, cleanup; no pin and no view Git repository.
    expect(measured.commits).toBeLessThanOrEqual(5);
    expect(measured.processes).toBeLessThanOrEqual(7);
    expect(await fs.access(path.join(f.directory, 'stray.txt')).then(() => true, () => false)).toBe(false);
    // A read-only lease cannot be claimed as a control call, nor reserved as one.
    const other = await f.begin('s', 'r2', 'shell2', { kind: 'process', preparation: 'read-only' });
    await expect(f.runtime.claimLease({ directory: f.directory, token: other.token, kind: 'control' })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
    await expect(f.begin('s', 'r3', 'shell3', { kind: 'control', preparation: 'read-only' })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
    await expect(f.begin('s', 'r2', 'shell2', { kind: 'process' })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  });
});
