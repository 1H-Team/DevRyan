import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectMutationFile } from './session-mutation-files.js';
import { openChangeStore } from './session-changes-store.js';
import { markObjectDirectoryPending, markObjectIfUnsynced, syncPendingObjectDirectory } from './object-durability.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const fixture = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-objects-'))); roots.push(root);
  const project = path.join(root, 'project'), store = path.join(root, 'store'), gitDir = path.join(store, 'git');
  await fs.mkdir(project); await fs.mkdir(store);
  execFileSync('git', ['init', '--quiet', '--bare', gitDir]);
  return { project, repo: { root: store, directory: project }, gitDir };
};

test('known content is hashed without another copy, sync or link', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.project, 'a.txt'), 'same bytes\n');
  const first = await inspectMutationFile(f.repo, 'a.txt');
  const link = spyOn(fs, 'link'), open = spyOn(fs, 'open');
  try {
    await fs.writeFile(path.join(f.project, 'b.txt'), 'same bytes\n');
    const second = await inspectMutationFile(f.repo, 'b.txt');
    expect(second.hash).toBe(first.hash);
    expect(link).not.toHaveBeenCalled();
    // Only the source file is opened; nothing is written into the object store.
    expect(open.mock.calls.every(([file]) => !String(file).startsWith(path.join(f.repo.root, 'objects')))).toBe(true);
  } finally { link.mockRestore(); open.mockRestore(); }
});

test('a new object directory entry is synced before the ledger commit that can reference it', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.project, 'new.txt'), 'new bytes\n');
  const order = [];
  const realOpen = fs.open.bind(fs);
  const open = spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
    const handle = await realOpen(file, ...rest);
    if (String(file) === path.join(f.repo.root, 'objects')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { order.push('objects-sync'); return sync(); };
    }
    return handle;
  });
  try {
    await inspectMutationFile(f.repo, 'new.txt');
    expect(order).toEqual([]);
    const db = await openChangeStore(f.repo.root, f.gitDir);
    db.set('meta.json', { sequence: 1 });
    await db.commit();
    expect(order).toEqual(['objects-sync']);
    db.set('meta.json', { sequence: 2 });
    await db.commit();
    expect(order).toEqual(['objects-sync']);
  } finally { open.mockRestore(); }
});

const objectRoot = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-objects-sync-'))); roots.push(root);
  await fs.mkdir(path.join(root, 'objects'));
  return root;
};
const gatedSyncs = (objects) => {
  const events = [], gates = [];
  const realOpen = fs.open.bind(fs);
  const spy = spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
    const handle = await realOpen(file, ...rest);
    if (String(file) === objects) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { events.push('sync-start'); await new Promise((resolve) => gates.push(resolve)); await sync(); events.push('sync-end'); };
    }
    return handle;
  });
  return { events, gates, restore: () => spy.mockRestore() };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a concurrent commit waits for an objects sync already in flight', async () => {
  const root = await objectRoot(), objects = path.join(root, 'objects');
  const syncs = gatedSyncs(objects);
  try {
    markObjectDirectoryPending(objects);
    const first = syncPendingObjectDirectory(root);
    await tick();
    const second = syncPendingObjectDirectory(root).then(() => syncs.events.push('second-done'));
    await tick();
    expect(syncs.events).toEqual(['sync-start']);
    syncs.gates.shift()();
    await Promise.all([first, second]);
    expect(syncs.events).toEqual(['sync-start', 'sync-end', 'second-done']);
  } finally { syncs.restore(); }
});

test('an existing object linked since the last sync began is synced before a commit', async () => {
  const root = await objectRoot(), objects = path.join(root, 'objects');
  const syncs = gatedSyncs(objects);
  try {
    // Linked by another process (or one that exited before committing).
    markObjectIfUnsynced(objects, Date.now());
    const commit = syncPendingObjectDirectory(root);
    await tick();
    syncs.gates.shift()();
    await commit;
    expect(syncs.events).toEqual(['sync-start', 'sync-end']);
    // Linked before that sync began: already durable.
    markObjectIfUnsynced(objects, Date.now() - 60_000);
    await syncPendingObjectDirectory(root);
    expect(syncs.events).toEqual(['sync-start', 'sync-end']);
  } finally { syncs.restore(); }
});
