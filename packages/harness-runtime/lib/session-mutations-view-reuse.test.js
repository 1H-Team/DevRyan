// A session's published lease parks its private view; the session's next
// preparation adopts every file still exactly as materialized and copies only
// the rest. The adopted view must equal a full copy, file by file.
import { afterEach, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { changeKey } from './session-changes-store.js';
import { withExecutionPreparation } from './execution-admission.js';
import { cleanupRoots, fixture, manyFiles, test, withEnv } from '../test/session-mutations-fixture.js';

afterEach(cleanupRoots);

const steps = (record) => Object.fromEntries(String(record?.steps ?? '').split(',').filter(Boolean).map((step) => {
  const [phase, value] = step.split(':');
  return [phase, Number(value.split('/')[0])];
}));
// One confined call: preparation (with its summary steps), an optional edit
// of the view, a termination receipt, publication and cleanup.
const prepare = async (f, sessionID, callID) => {
  const records = [];
  const lease = await withExecutionPreparation({ sessionID, callID }, () => f.begin(sessionID, `u-${callID}`, callID),
    { onDiagnostic: (record) => records.push(record), summary: { minMs: 0 } });
  return { lease, steps: steps(records.find((record) => record.phase === 'preparation' && record.state === 'completed')) };
};
const complete = async (f, lease, edit) => {
  await f.runtime.claimLease({ directory: f.directory, token: lease.token, kind: 'process' });
  await edit?.(lease.viewDirectory);
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
  const result = await f.finish(lease);
  await f.runtime.cleanupLease({ directory: f.directory, token: lease.token });
  return result;
};
// Type, permission bits, bytes and link targets of every view entry except
// the view's own Git metadata, directories included.
async function describeTree(base) {
  const rows = [];
  const walk = async (relative) => {
    for (const entry of await fs.readdir(path.join(base, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === '.git') continue;
      const full = path.join(base, name), stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) rows.push([name, 'link', await fs.readlink(full)]);
      else if (stat.isDirectory()) { rows.push([name, 'directory', stat.mode & 0o7777]); await walk(name); }
      else rows.push([name, 'file', stat.mode & 0o7777, stat.nlink, (await fs.readFile(full)).toString('base64')]);
    }
  };
  await walk('');
  return rows.sort((left, right) => left[0].localeCompare(right[0]));
}
const inode = async (view, file) => (await fs.lstat(path.join(view, file), { bigint: true })).ino;
const standbyRoot = async (f) => path.join(f.storage, changeKey(await fs.realpath(f.directory)), 'view-standby');
const withInput = async (f) => {
  await f.write('.gitignore', 'node_modules/\n');
  await fs.mkdir(path.join(f.directory, 'node_modules', 'dep'), { recursive: true });
  await f.write('node_modules/dep/index.js', 'dependency');
};

test('a later lease adopts the parked view: it equals a full copy and copies only changed files', async () => {
  const f = await fixture();
  await manyFiles(f, 120);
  await withInput(f);
  const first = await prepare(f, 's', 'c1');
  const total = first.steps.view_copied;
  expect(total).toBeGreaterThan(120);
  expect(first.steps.view_reused).toBe(0);
  const unchanged = await inode(first.lease.viewDirectory, 'd6/e1/f6.txt');
  await complete(f, first.lease, async (view) => {
    await fs.appendFile(path.join(view, 'd0/e0/f0.txt'), 'edited\n');
    await fs.writeFile(path.join(view, 'd1/e1/new.txt'), 'new file\n');
    await fs.chmod(path.join(view, 'run.sh'), 0o700);
    // Not published, so only adoption can carry them: directory metadata, the
    // view's Git metadata and a link standing in for a dependency input.
    await fs.chmod(path.join(view, 'd2'), 0o700);
    await fs.mkdir(path.join(view, '.git', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(view, '.git', 'hooks', 'planted'), 'never adopted');
  });
  // External edits while the view is parked.
  await f.write('d3/e3/f3.txt', 'external\n');
  await fs.rm(path.join(f.directory, 'd4/e4/f4.txt'));
  await f.write('d5/added.txt', 'added\n');

  const second = await prepare(f, 's', 'c2');
  // The edited, added and re-moded files, plus the external modification and
  // addition, are copied; every other file is adopted.
  expect(second.steps.view_copied).toBe(5);
  expect(second.steps.view_reused).toBe(total + 1 - 5);
  expect(await inode(second.lease.viewDirectory, 'd6/e1/f6.txt')).toBe(unchanged);
  // A full copy for another session holds exactly the same tree.
  const fresh = await prepare(f, 'other', 'c3');
  expect(fresh.steps.view_reused).toBe(0);
  expect(await describeTree(second.lease.viewDirectory)).toEqual(await describeTree(fresh.lease.viewDirectory));
  expect((await describeTree(second.lease.viewDirectory)).find((row) => row[0] === 'node_modules')?.[1]).toBe('link');
  await expect(fs.access(path.join(second.lease.viewDirectory, '.git', 'hooks', 'planted'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(path.join(second.lease.viewDirectory, 'd4/e4/f4.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

  // Publication from an adopted view is unchanged: only the edited file.
  const result = await complete(f, second.lease, (view) => fs.appendFile(path.join(view, 'd7/e2/f7.txt'), 'second\n'));
  expect(result.files).toEqual([{ path: 'd7/e2/f7.txt', status: 'modified' }]);
  expect(await f.read('d7/e2/f7.txt')).toEndWith('second\n');
  await complete(f, fresh.lease);
  const third = await prepare(f, 's', 'c4');
  expect(third.steps.view_copied).toBe(1);
  await complete(f, third.lease);
  await f.runtime.drain();
});

test('only provably untouched parked files are adopted, never through a planted link', async () => {
  const f = await fixture();
  await manyFiles(f, 40);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  const first = await prepare(f, 's', 'c1');
  await complete(f, first.lease);
  // Another session never adopts this session's view.
  const other = await prepare(f, 'other', 'c2');
  expect(other.steps.view_reused).toBe(0);
  await complete(f, other.lease);

  // Tamper with every parked view: a same-size rewrite, a link where a
  // directory was, and a hard link shared with a directory outside.
  const parent = await standbyRoot(f);
  const parked = await fs.readdir(parent);
  expect(parked).toHaveLength(2);
  for (const [index, name] of parked.entries()) {
    const view = path.join(parent, name), target = path.join(view, 'd0/e0/f0.txt');
    const size = (await fs.stat(target)).size;
    await fs.writeFile(target, 'x'.repeat(size));
    await fs.rm(path.join(view, 'd1'), { recursive: true });
    await fs.symlink(outside, path.join(view, 'd1'));
    await fs.link(path.join(view, 'd2/e2/f2.txt'), path.join(outside, `hard${index}`));
  }
  const second = await prepare(f, 's', 'c3');
  // f0, the three files under d1 and f2 are copied again.
  expect(second.steps.view_copied).toBe(5);
  expect((await fs.readdir(outside)).sort()).toEqual(['hard0', 'hard1']);
  const view = second.lease.viewDirectory;
  expect((await fs.lstat(path.join(view, 'd1'))).isDirectory()).toBe(true);
  expect(await fs.readFile(path.join(view, 'd0/e0/f0.txt'), 'utf8')).toBe(await f.read('d0/e0/f0.txt'));
  expect((await fs.lstat(path.join(view, 'd2/e2/f2.txt'))).nlink).toBe(1);
  const fresh = await prepare(f, 'third', 'c4');
  expect(await describeTree(view)).toEqual(await describeTree(fresh.lease.viewDirectory));
  // Writing the adopted view never reaches the outside directory.
  await complete(f, second.lease, (directory) => fs.writeFile(path.join(directory, 'd1/f1.txt'), 'confined\n'));
  expect((await fs.readdir(outside)).sort()).toEqual(['hard0', 'hard1']);
  await complete(f, fresh.lease);
  await f.runtime.drain();
});

test('cancelled leases are never parked, and DEVRYAN_VIEW_REUSE=0 copies every file', async () => {
  const f = await fixture();
  await manyFiles(f, 20);
  const cancelled = await prepare(f, 's', 'c1');
  await f.runtime.cancelLease({ directory: f.directory, token: cancelled.lease.token });
  await f.runtime.cleanupLease({ directory: f.directory, token: cancelled.lease.token });
  const next = await prepare(f, 's', 'c2');
  expect(next.steps.view_reused).toBe(0);
  await withEnv({ DEVRYAN_VIEW_REUSE: '0' }, async () => {
    await complete(f, next.lease);
    const later = await prepare(f, 's', 'c3');
    expect(later.steps.view_reused).toBe(0);
    await complete(f, later.lease);
  });
  // Neither a cancelled nor a kill-switched lease left a standby behind.
  expect(await fs.readdir(await standbyRoot(f)).catch((cause) => cause.code)).toBe('ENOENT');
  const enabled = await prepare(f, 's', 'c4');
  expect(enabled.steps.view_reused).toBe(0);
  await complete(f, enabled.lease);
  expect((await prepare(f, 's', 'c5')).steps.view_copied).toBe(0);
  await f.runtime.drain();
});
