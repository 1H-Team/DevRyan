import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { openChangeStore } from './session-changes-store.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-change-store-')); roots.push(root);
  const gitDir = path.join(root, 'git');
  await git(root, ['init', '--bare', '--quiet', gitDir]);
  return { root, gitDir, open: () => openChangeStore(root, gitDir) };
}

test('rewriting a value unchanged since it was read stages nothing and commits nothing', async () => {
  const s = await store();
  const first = await s.open();
  first.set('sessions/a.json', { id: 'a', generation: 0, pending: null });
  first.set('meta.json', { version: 1, sequence: 3 });
  await first.commit();
  const tree = first.tree;

  const second = await s.open();
  const session = await second.get('sessions/a.json');
  second.set('sessions/a.json', { ...session });
  const missing = await second.get('sessions/missing.json');
  expect(missing).toBeNull();
  second.remove('sessions/missing.json');
  expect(second.pendingCount).toBe(0);
  await second.commit();
  expect(second.tree).toBe(tree);

  // A real change still commits, and a value read before that commit is not
  // treated as a baseline for the next transaction on the same store.
  second.set('sessions/a.json', { ...session, generation: 1 });
  expect(second.pendingCount).toBe(1);
  await second.commit();
  expect(second.tree).not.toBe(tree);
  second.set('sessions/a.json', { ...session });
  expect(second.pendingCount).toBe(1);
  await second.commit();
  expect(await (await s.open()).get('sessions/a.json')).toEqual(session);
});

test('an unread key is always staged, and a changed-then-restored value still commits', async () => {
  const s = await store();
  const first = await s.open();
  first.set('files/x.json', { v: 1 });
  await first.commit();
  const second = await s.open();
  second.set('files/x.json', { v: 1 });
  expect(second.pendingCount).toBe(1);
  const third = await s.open();
  await third.get('files/x.json');
  third.set('files/x.json', { v: 2 });
  third.set('files/x.json', { v: 1 });
  expect(third.pendingCount).toBe(1);
});
