// Harness overhead budgets for native tool calls, counted through the ledger's
// injected Git runner: processes started by ledger stores and state commits
// (`update-ref refs/devryan/state`). Counts are deterministic where timings
// are not, so a regression that adds a process or a commit per call fails here.
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitRecords, gitTokens, readGitObject } from './session-changes-git.js';
import { cleanupRoots, fixture, manyFiles, test } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);

const countingRunner = () => {
  const counts = { processes: 0, commits: 0, reads: 0 };
  const note = (args) => {
    counts.processes += 1;
    if (args.includes('update-ref') && args.includes('refs/devryan/state')) counts.commits += 1;
  };
  return { counts, gitRunner: {
    git: (cwd, args, options) => { note(args); return git(cwd, args, options); },
    gitTokens: (cwd, args, options) => { note(args); return gitTokens(cwd, args, options); },
    gitRecords: (cwd, args, rows) => { note(args); return gitRecords(cwd, args, rows); },
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
    const { counts, gitRunner } = countingRunner();
    const f = await fixture({ gitRunner });
    const step = (user, call) => ({ directory: f.directory, sessionID: 's', userMessageID: user, messageID: `${user}-assistant`, callID: call });
    const read = async (identity) => {
      const { generation } = await f.runtime.admitDirect(identity);
      return f.runtime.finishDirect({ ...identity, token: randomUUID(), generation, executionFingerprint: digest });
    };
    await read(step('u0', 'warm'));
    const single = await measure(counts, () => read(step('u0', 'single')));
    expect(single.commits).toBe(1);
    // Commit plumbing only: hash-object, update-index, write-tree, update-ref.
    expect(single.processes).toBeLessThanOrEqual(4);
    const parallel = await measure(counts, () => Promise.all(Array.from({ length: 8 }, (_, index) => read(step('u1', `p${index}`)))));
    expect(parallel.commits).toBe(1);
    expect(parallel.processes).toBeLessThanOrEqual(4);
    // Separate requests a few milliseconds apart: the first may commit alone,
    // every later one joins the batch queued behind it.
    const staggered = await measure(counts, () => Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await new Promise((resolve) => setTimeout(resolve, index * 2));
      return read(step('u2', `q${index}`));
    })));
    expect(staggered.commits).toBeLessThanOrEqual(2);
    expect(staggered.processes).toBeLessThanOrEqual(8);
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
    expect(measured.processes).toBeLessThanOrEqual(42);
  });
});
