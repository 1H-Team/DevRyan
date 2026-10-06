import { afterEach, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { changeKey } from './session-changes-store.js';
import { createViewMaterializer } from './session-mutation-files.js';
import { withExecutionAdmission } from './execution-admission.js';

// Fresh-view materialization clones verified objects straight into a view the
// preparation created, and reconciliation installs identical-content
// re-stamps in large batches. Both keep the per-lease isolation and publication
// contracts of the general writer they replace.
const roots = [];
const test = (name, body) => bunTest(name, body, 120_000);
afterEach(async () => {
  delete process.env.DEVRYAN_VIEW_FAST_MATERIALIZE;
  delete process.env.DEVRYAN_LEDGER_RESTAMP_BATCH;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-views-')); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  const runtime = createSessionMutationRuntime({ directory: storage });
  const put = async (name, value, mode) => {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    if (mode !== undefined) await fs.chmod(file, mode);
  };
  let call = 0;
  const begin = (options = {}) => {
    call += 1;
    const input = { directory, sessionID: `s${call}`, userMessageID: `p${call}`, messageID: `m${call}`, callID: `c${call}` };
    if (!options.summary) return runtime.begin(input);
    const records = [];
    return withExecutionAdmission(input, () => runtime.begin(input), {
      timeoutMs: 110_000, onDiagnostic: (record) => records.push(record), summary: { minMs: 0 },
    }).then((lease) => ({ lease, records }));
  };
  const finish = async (lease) => {
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
      JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }), { flag: 'wx', mode: 0o600 });
    await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
    return runtime.finish({ directory, token: lease.token });
  };
  return { root, directory, storage, runtime, put, begin, finish };
}

// Type, permission bits, bytes and link targets of every view entry except
// the view's own Git metadata.
async function describeTree(base) {
  const rows = [];
  const walk = async (relative) => {
    for (const entry of await fs.readdir(path.join(base, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === '.git') continue;
      const full = path.join(base, name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) rows.push([name, 'link', await fs.readlink(full)]);
      else if (stat.isDirectory()) { rows.push([name, 'directory']); await walk(name); }
      else rows.push([name, 'file', stat.mode & 0o777, (await fs.readFile(full)).toString('base64')]);
    }
  };
  await walk('');
  return rows.sort((left, right) => left[0].localeCompare(right[0]));
}

const steps = (records) => {
  const admission = records.find((record) => record.phase === 'admission' && record.state === 'completed');
  return Object.fromEntries(String(admission?.steps ?? '').split(',').filter(Boolean).map((step) => {
    const [phase, value] = step.split(':');
    return [phase, Number(value.split('/')[0])];
  }));
};

test('the fast materializer builds the same view and publication reuses its untouched stamps', async () => {
  const f = await fixture();
  await f.put('.gitignore', 'node_modules/\n');
  await f.put('node_modules/dep/index.js', 'dependency');
  await f.put('src/deep/nested/a.js', 'export const a = 1;\n');
  await f.put('bin/run.sh', '#!/bin/sh\necho run\n', 0o755);
  await f.put('private.txt', 'owner only', 0o600);
  await f.put('empty.txt', '');
  await f.put('assets/blob.bin', Buffer.from([0, 1, 2, 0, 255, 0]));
  await f.put('docs/résumé ü.md', '# unicode\n');
  await fs.symlink('src/deep/nested/a.js', path.join(f.directory, 'file-link'));
  await fs.symlink('src', path.join(f.directory, 'dir-link'));

  const fast = await f.begin();
  const fastTree = await describeTree(fast.viewDirectory);
  expect((await f.finish(fast)).files).toEqual([]);

  process.env.DEVRYAN_VIEW_FAST_MATERIALIZE = '0';
  const legacy = await f.begin();
  expect(await describeTree(legacy.viewDirectory)).toEqual(fastTree);
  expect((await f.finish(legacy)).files).toEqual([]);
  delete process.env.DEVRYAN_VIEW_FAST_MATERIALIZE;

  expect(fastTree).toContainEqual(['bin/run.sh', 'file', 0o755, Buffer.from('#!/bin/sh\necho run\n').toString('base64')]);
  expect(fastTree).toContainEqual(['private.txt', 'file', 0o600, Buffer.from('owner only').toString('base64')]);
  expect(fastTree).toContainEqual(['file-link', 'link', 'src/deep/nested/a.js']);
  expect(fastTree).toContainEqual(['dir-link', 'link', 'src']);
  // Dependency inputs stay links (to the host-owned module overlay).
  expect(fastTree.find((row) => row[0] === 'node_modules')?.[1]).toBe('link');

  // Only the edited file publishes: every other view entry kept the stamp its
  // base record captured at materialization.
  const edited = await f.begin();
  await fs.writeFile(path.join(edited.viewDirectory, 'src/deep/nested/a.js'), 'export const a = 2;\n');
  expect((await f.finish(edited)).files).toEqual([{ path: 'src/deep/nested/a.js', status: 'modified' }]);
  expect(await fs.readFile(path.join(f.directory, 'src/deep/nested/a.js'), 'utf8')).toBe('export const a = 2;\n');
});

test('the materializer never writes through planted links and defers existing entries', async () => {
  const f = await fixture();
  await f.put('dir/a.txt', 'a'); await f.put('b.txt', 'b');
  const warm = await f.begin();
  await f.finish(warm);
  const ledger = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const [objectHash] = (await fs.readdir(path.join(ledger, 'objects'))).filter((name) => /^[a-f0-9]{64}$/.test(name));
  expect(objectHash).toBeDefined();
  const entry = { hash: objectHash, mode: '100644' };
  const repo = { root: ledger };

  const view = path.join(f.root, 'view'), outside = path.join(f.root, 'outside');
  await fs.mkdir(view); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(view, 'dir'));
  const materialize = createViewMaterializer(repo, view);
  await expect(materialize('dir/a.txt', entry, 0o644)).rejects.toMatchObject({ code: 'unsupported_path' });
  expect(await fs.readdir(outside)).toEqual([]);

  await fs.symlink(path.join(outside, 'target'), path.join(view, 'b.txt'));
  expect(await materialize('b.txt', entry, 0o644)).toBeNull();
  expect(await fs.readdir(outside)).toEqual([]);
  await expect(materialize('../escape.txt', entry, 0o644)).rejects.toMatchObject({ code: 'unsupported_path' });
  expect(await materialize('link', { ...entry, mode: '120000' }, null)).toBeNull();

  const made = [];
  const counted = createViewMaterializer(repo, path.join(f.root, 'counted'), { io: (action) => { made.push(1); return action(); } });
  await fs.mkdir(path.join(f.root, 'counted'));
  const stats = await Promise.all(['x/y/1.txt', 'x/y/2.txt', 'x/z/3.txt', 'x/4.txt']
    .map((file) => counted(file, entry, 0o640)));
  expect(stats.every((stat) => stat && (Number(stat.mode) & 0o777) === 0o640)).toBe(true);
  expect(made).toHaveLength(4);

  await fs.writeFile(path.join(ledger, 'objects', objectHash), 'corrupted');
  const fresh = path.join(f.root, 'fresh');
  await fs.mkdir(fresh);
  await expect(createViewMaterializer(repo, fresh)('c.txt', entry, 0o644)).rejects.toMatchObject({ code: 'invalid_change_record' });
});

test('a cancelled fast preparation cleans up and the next call prepares normally', async () => {
  const f = await fixture();
  for (let index = 0; index < 200; index += 1) await f.put(`many/${index}.txt`, `file ${index}`);
  const warm = await f.begin();
  await f.finish(warm);

  const controller = new AbortController();
  const input = { directory: f.directory, sessionID: 'cancel', userMessageID: 'pc', messageID: 'mc', callID: 'cc' };
  const attempt = withExecutionAdmission(input, () => f.runtime.begin(input), { signal: controller.signal, timeoutMs: 60_000 });
  setTimeout(() => controller.abort(Object.assign(new Error('cancelled'), { code: 'execution_cancelled' })), 5);
  await attempt.then(() => {}, () => {});

  const next = await f.begin();
  expect(await fs.readFile(path.join(next.viewDirectory, 'many/199.txt'), 'utf8')).toBe('file 199');
  expect((await f.finish(next)).files).toEqual([]);
});

test('identical-content re-stamps install in large batches while content changes keep small batches', async () => {
  const f = await fixture();
  const count = 600;
  for (let index = 0; index < count; index += 1) await f.put(`restamp/${index}.txt`, `same ${index}`);
  const first = await f.begin({ summary: true });
  await f.finish(first.lease);
  expect(steps(first.records).view_files).toBe(1);
  expect(steps(first.records).view_git).toBe(1);
  expect(steps(first.records).view_inputs).toBe(1);

  // Identical bytes, new inode/ctime: every row is a re-stamp.
  for (let index = 0; index < count; index += 1) {
    const file = path.join(f.directory, `restamp/${index}.txt`);
    await fs.rm(file); await fs.writeFile(file, `same ${index}`);
  }
  const batched = await f.begin({ summary: true });
  // Reservation, pin and ready transactions commit on every call; the whole
  // re-stamp adds exactly one install.
  expect(steps(batched.records).ledger_commit).toBe(4);
  expect(batched.records.some((record) => record.phase === 'reconciliation_restamp' && record.count === count)).toBe(true);
  await f.finish(batched.lease);

  const settled = await f.begin({ summary: true });
  expect(steps(settled.records).ledger_commit).toBe(3);
  await f.finish(settled.lease);

  for (let index = 0; index < count; index += 1) {
    const file = path.join(f.directory, `restamp/${index}.txt`);
    await fs.rm(file); await fs.writeFile(file, `same ${index}`);
  }
  process.env.DEVRYAN_LEDGER_RESTAMP_BATCH = '0';
  const legacy = await f.begin({ summary: true });
  expect(steps(legacy.records).ledger_commit).toBe(Math.ceil(count / 128) + 3);
  await f.finish(legacy.lease);
  delete process.env.DEVRYAN_LEDGER_RESTAMP_BATCH;

  for (let index = 0; index < 300; index += 1) await f.put(`restamp/${index}.txt`, `changed ${index}`);
  const changed = await f.begin({ summary: true });
  expect(steps(changed.records).ledger_commit).toBe(Math.ceil(300 / 128) + 3);
  expect(changed.records.some((record) => record.phase === 'reconciliation_install' && record.count === 300)).toBe(true);
  expect(await fs.readFile(path.join(changed.lease.viewDirectory, 'restamp/0.txt'), 'utf8')).toBe('changed 0');
  await f.finish(changed.lease);
});
