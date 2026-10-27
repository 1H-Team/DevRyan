import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { openChangeStore } from './session-changes-store.js';
import { commitTreeChanges, objectID, parseTree, serializeTree, writeLooseObject } from './session-changes-trees.js';

test('an eager blob write failure stays observed while tree reads wait, then rejects the commit unchanged', async () => {
  const treeRead = Promise.withResolvers();
  const cause = Object.assign(Error('fixture storage write failed'), { code: 'ENOSPC' });
  const result = commitTreeChanges({ tree: 'a'.repeat(40), changes: new Map([['file.json', 'new content']]), oidLength: 40,
    readTree: () => treeRead.promise, writeObject: async () => { throw cause; } }).then(() => undefined, error => error);
  // Cross an event-loop boundary before the tree can attach its blob awaits.
  await new Promise(resolve => setImmediate(resolve));
  treeRead.resolve(Buffer.alloc(0));
  expect(await result).toBe(cause);
});

// Direct tree commits must name exactly the tree Git's index would have
// written for the same transaction, in both object formats, including
// removals that empty a directory and replacements of existing values.
const roots = [];
afterEach(async () => {
  delete process.env.DEVRYAN_LEDGER_DIRECT_TREES;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const repository = async (format) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-trees-')); roots.push(root);
  const gitDir = path.join(root, 'git');
  await git(root, ['init', '--bare', '--quiet', `--object-format=${format}`, gitDir]);
  return { root, gitDir };
};

// A deterministic pseudo-random transaction history over nested keys.
const history = () => {
  let seed = 7;
  const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  const kinds = ['files', 'leases', 'bases/aa', 'bases/ab', 'runs/x-y', 'runs/x_y', 'a-b', 'a', 'a_b'];
  const steps = [];
  for (let step = 0; step < 24; step += 1) {
    const writes = [];
    for (let index = 0; index < 1 + random(12); index += 1) {
      const kind = kinds[random(kinds.length)];
      const name = `${kind}/${String(random(40)).padStart(4, '0')}.json`;
      writes.push([name, random(5) === 0 ? null : { step, index, text: 'x'.repeat(random(64)) }]);
    }
    steps.push(writes);
  }
  return steps;
};

const replay = async ({ root, gitDir }, steps) => {
  const trees = [];
  for (const writes of steps) {
    const db = await openChangeStore(root, gitDir);
    for (const [key, value] of writes) value === null ? db.remove(key) : db.set(key, value);
    await db.commit();
    trees.push(db.tree);
  }
  return trees;
};

for (const format of ['sha1', 'sha256']) {
  test(`direct commits write the same trees as Git's index (${format})`, async () => {
    const steps = history();
    process.env.DEVRYAN_LEDGER_DIRECT_TREES = '0';
    const indexed = await replay(await repository(format), steps);
    process.env.DEVRYAN_LEDGER_DIRECT_TREES = '1';
    const direct = await repository(format);
    expect(await replay(direct, steps)).toEqual(indexed);
    // Git itself accepts every written object and the final ref.
    await git(direct.root, ['--git-dir', direct.gitDir, 'fsck', '--strict', '--no-dangling']);
    expect((await git(direct.root, ['--git-dir', direct.gitDir, 'rev-parse', 'refs/devryan/state'])).toString().trim()).toBe(indexed.at(-1));
  });
}

test('removing every key leaves the empty tree, and an unchanged write stages nothing', async () => {
  const repo = await repository('sha1');
  const first = await openChangeStore(repo.root, repo.gitDir);
  first.set('only/one.json', { a: 1 });
  await first.commit();
  const second = await openChangeStore(repo.root, repo.gitDir);
  second.remove('only/one.json');
  await second.commit();
  expect(second.tree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const third = await openChangeStore(repo.root, repo.gitDir);
  expect(await third.get('only/one.json')).toBeNull();
});

test('tree entries round-trip and sort subtrees as if they ended in a slash', () => {
  const oid = 'a'.repeat(40);
  const entries = [{ mode: '100644', name: 'a.b', oid }, { mode: '40000', name: 'a', oid }, { mode: '100644', name: 'a-b', oid }];
  const parsed = parseTree(serializeTree(entries), 40);
  // '-' (0x2d) < '.' (0x2e) < '/' (0x2f): "a-b", "a.b", then the subtree "a/".
  expect(parsed.map((entry) => entry.name)).toEqual(['a-b', 'a.b', 'a']);
  expect(parsed[2]).toEqual({ mode: '40000', name: 'a', oid });
});

test('a loose object write retries when packing removed its fan-out directory, and freshens an existing object', async () => {
  const { gitDir } = await repository('sha1');
  const content = Buffer.from('{"retry":true}');
  const write = fs.writeFile.bind(fs);
  let removed = false;
  const spy = spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    if (!removed && String(file).includes('tmp_obj_')) {
      removed = true;
      // As `git prune-packed` does with an emptied fan-out directory.
      await fs.rm(path.dirname(String(file)), { recursive: true, force: true });
    }
    return write(file, ...args);
  });
  let oid;
  try { oid = await writeLooseObject(gitDir, 'blob', content, 40); } finally { spy.mockRestore(); }
  expect(removed).toBe(true);
  expect(oid).toBe(objectID('blob', content, 40));
  expect((await git(gitDir, ['--git-dir', gitDir, 'cat-file', '-p', oid])).toString()).toBe('{"retry":true}');
  const target = path.join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  await fs.utimes(target, old, old);
  expect(await writeLooseObject(gitDir, 'blob', content, 40)).toBe(oid);
  expect((await fs.stat(target)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
});

test('macOS EINVAL from a fan-out directory removed mid-create is retried; EINVAL with the directory intact is not', async () => {
  const { gitDir } = await repository('sha1');
  const content = Buffer.from('{"einval":true}');
  const write = fs.writeFile.bind(fs);
  let calls = 0;
  const einval = () => Object.assign(new Error('EINVAL: invalid argument, open'), { code: 'EINVAL' });
  let spy = spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    if (String(file).includes('tmp_obj_') && calls++ === 0) {
      await fs.rm(path.dirname(String(file)), { recursive: true, force: true });
      throw einval();
    }
    return write(file, ...args);
  });
  let oid;
  try { oid = await writeLooseObject(gitDir, 'blob', content, 40); } finally { spy.mockRestore(); }
  expect(calls).toBe(2);
  expect((await git(gitDir, ['--git-dir', gitDir, 'cat-file', '-p', oid])).toString()).toBe('{"einval":true}');
  calls = 0;
  spy = spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => {
    if (String(file).includes('tmp_obj_')) { calls += 1; throw einval(); }
    return write(file, ...args);
  });
  try { await expect(writeLooseObject(gitDir, 'blob', Buffer.from('{"kept":true}'), 40)).rejects.toMatchObject({ code: 'EINVAL' }); }
  finally { spy.mockRestore(); }
  expect(calls).toBe(1);
});
