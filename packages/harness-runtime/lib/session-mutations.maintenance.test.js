import { afterEach, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { changeKey } from './session-changes-store.js';
import { cleanupRoots, fixture, ledgerState, manyFiles, test } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);

const objectStats = async (root) => Object.fromEntries((await git(root, ['--git-dir', path.join(root, 'git'), 'count-objects', '-v'])).toString()
  .trim().split('\n').map((line) => line.split(': ')).map(([name, value]) => [name, Number(value)]));
const looseObjects = async (root) => {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, 'git', 'objects'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    for (const object of await fs.readdir(path.join(root, 'git', 'objects', entry.name))) files.push(path.join(root, 'git', 'objects', entry.name, object));
  }
  return files;
};
// Time passes between runtime processes: objects too young for the prune
// grace at one process's maintenance are old enough at the next.
const age = async (root, hours) => {
  const then = new Date(Date.now() - hours * 3_600_000);
  for (const file of await looseObjects(root)) await fs.utimes(file, then, then);
};

test('short-lived runtimes keep a ledger\'s loose objects bounded with the production prune grace', async () => {
  // The commit trigger never fires: each process commits far fewer times.
  const maintenance = { looseObjects: 40, commits: 1_000_000 };
  const f = await fixture({ maintenance });
  await manyFiles(f, 30);
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  let sequence = 0;
  const counts = [];
  for (let restart = 0; restart < 6; restart += 1) {
    const runtime = createSessionMutationRuntime({ directory: f.storage, maintenance });
    for (let call = 0; call < 3; call += 1) {
      const index = sequence++;
      const lease = await runtime.begin({ directory: f.directory, sessionID: 's', userMessageID: `p${index}`, messageID: `p${index}-assistant`, callID: `c${index}` });
      await fs.writeFile(path.join(lease.viewDirectory, `d${index % 17}/e${index % 5}/f${index % 30}.txt`), `edit ${index}\n`);
      await runtime.finish({ directory: f.directory, token: lease.token });
    }
    await runtime.drain();
    counts.push((await objectStats(root)).count);
    await age(root, 3);
  }
  // Without the per-process check the count only grows (several hundred here).
  expect(counts[0]).toBeGreaterThanOrEqual(maintenance.looseObjects);
  expect(Math.max(...counts.slice(1))).toBeLessThan(counts[0]);
  expect((await objectStats(root)).packs).toBeGreaterThanOrEqual(1);
  // Packing and pruning keep every record exact.
  const state = await ledgerState(f);
  expect(Object.keys(state).length).toBeGreaterThanOrEqual(30);
  expect(await f.read(`d${(sequence - 1) % 17}/e${(sequence - 1) % 5}/f${(sequence - 1) % 30}.txt`)).toBe(`edit ${sequence - 1}\n`);
});

test('a failed maintenance step journals its Git command and failure class, never a path', async () => {
  const diagnostics = [];
  const f = await fixture({ maintenance: { looseObjects: 1, packs: 1_000, commits: 1_000_000 }, onDiagnostic: (record) => diagnostics.push(record) });
  await f.write('a.txt', 'a\n');
  await f.finish(await f.begin('s', 'p0', 'c0'));
  await f.runtime.drain();
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  // A reachable object that cannot be read makes `repack` fail.
  const head = (await git(root, ['--git-dir', path.join(root, 'git'), 'rev-parse', 'refs/devryan/state'])).toString().trim();
  const file = path.join(root, 'git', 'objects', head.slice(0, 2), head.slice(2));
  await fs.chmod(file, 0o600); await fs.writeFile(file, 'corrupted');
  diagnostics.length = 0;
  await f.runtime.maintainLedger({ directory: f.directory });
  const failed = diagnostics.find((record) => record.phase === 'ledger_maintenance');
  expect(failed).toMatchObject({ state: 'failed', code: 'capture_git_failed', command: 'repack', failure: 'corrupt' });
  expect(JSON.stringify(diagnostics)).not.toContain(f.root);
  expect(JSON.stringify(diagnostics)).not.toContain(head);
});
