import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, readGitObject } from './session-changes-git.js';
import { openChangeStore } from './session-changes-store.js';
import { commitTreeChanges, listedRowText, listTreeRows, objectID, parseTree, removeTemporaryFile, serializeTree, writeLooseObject } from './session-changes-trees.js';

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
    // Two full Git replays per case: about 1 s alone, over Bun's 5 s default when the whole suite runs beside it.
  }, 30_000);
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

// serializeTree encodes each sort key once. The reference is the earlier form,
// which encoded both keys on every comparison: the bytes must be identical on
// seeded names that are long, differ only in their last byte, sit around the
// characters that sort next to '/' ('-', '.', '/', '0'), carry bytes above
// 0x7f, and repeat (equal keys keep their input order).
test('serializeTree orders entries exactly as the per-comparison encoding did', () => {
  const reference = (entries) => {
    const sortName = (entry) => entry.mode === '40000' ? `${entry.name}/` : entry.name;
    const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(sortName(a), 'latin1'), Buffer.from(sortName(b), 'latin1')));
    return Buffer.concat(sorted.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`, 'latin1'), Buffer.from(entry.oid, 'hex')]));
  };
  let seed = 3;
  const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 12) % limit; }; // high bits: the low ones cycle
  const near = ['-', '.', '/', '0', 'a', 'A', '\x7f', '\x80', '\xff', ' '];
  const character = () => random(3) ? near[random(near.length)] : String.fromCharCode(1 + random(255));
  const stem = () => Array.from({ length: random(3) ? 1 + random(8) : 200 + random(300) }, character).join('').replaceAll('/', '.');
  for (let round = 0; round < 300; round += 1) {
    const oidLength = round % 2 ? 64 : 40, entries = [];
    const base = stem();
    for (let index = 0, count = 1 + random(24); index < count; index += 1) {
      const pick = random(4);
      const name = pick === 0 ? base : pick === 1 ? `${base.slice(0, -1)}${near[random(near.length)].replace('/', '.')}` : pick === 2 ? `${base}${near[random(near.length)].replace('/', '-')}` : stem();
      entries.push({ mode: random(2) ? '40000' : '100644', name: name || 'x', oid: random(16).toString(16).repeat(oidLength) });
    }
    expect(serializeTree(entries).equals(reference(entries))).toBe(true);
  }
});

test('removeTemporaryFile removes a file, accepts a missing one and rethrows anything else', async () => {
  const { root } = await repository('sha1');
  const file = path.join(root, 'tmp_obj_fixture');
  await fs.writeFile(file, 'x', { mode: 0o444, flag: 'wx' });
  await removeTemporaryFile(file);
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await removeTemporaryFile(file);
  await removeTemporaryFile(path.join(root, 'missing', 'tmp_obj_fixture'));
  await fs.mkdir(file);
  await expect(removeTemporaryFile(file)).rejects.toBeDefined();
  expect((await fs.lstat(file)).isDirectory()).toBe(true);
});

// listTreeRows must print exactly what `git ls-tree -r -l -z` prints, row for
// row and byte for byte, through the same persistent reader the store uses.
const gitListing = async (gitDir, tree) => {
  const out = await git(gitDir, ['--git-dir', gitDir, 'ls-tree', '-r', '-l', '-z', tree], { limit: 64 * 1024 * 1024 });
  const rows = [];
  for (let at = 0, end; (end = out.indexOf(0, at)) !== -1; at = end + 1) rows.push(out.subarray(at, end).toString());
  return rows;
};
const readerListing = (gitDir, tree, oidLength) => listTreeRows({ tree, oidLength,
  readTree: async (oid) => { const found = await readGitObject(gitDir, ['--git-dir', gitDir], oid); return found?.type === 'tree' ? found.data : null; },
  sizeOf: async (oid) => { const found = await readGitObject(gitDir, ['--git-dir', gitDir], oid, { check: true }); return found?.type === 'blob' ? found.size : null; } });

for (const format of ['sha1', 'sha256']) {
  test(`listTreeRows lists generated trees exactly as git ls-tree does (${format})`, async () => {
    const { gitDir } = await repository(format), oidLength = format === 'sha1' ? 40 : 64;
    let seed = format === 'sha1' ? 5 : 9;
    const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 12) % limit; }; // high bits: the low ones cycle
    // Bytes Git keeps verbatim in names, including invalid UTF-8 and a split sequence.
    const near = ['-', '.', '0', 'a', 'A', 'b', '_', 'Z', '9', '\x7f', '\x80', '\xff', ' ', '\t', '\n', '\\', '"', '\xc3\xa9', '\xe2\x82'];
    const name = () => Array.from({ length: 1 + random(6) }, () => random(3) ? near[random(near.length)] : String.fromCharCode(1 + random(255))).join('').replaceAll('/', '_');
    const blobs = new Map();
    const blob = async (text) => {
      if (!blobs.has(text)) blobs.set(text, (await git(gitDir, ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: text })).toString().trim());
      return blobs.get(text);
    };
    const tree = async (lines) => (await git(gitDir, ['--git-dir', gitDir, 'mktree', '-z', '--missing'], { input: Buffer.concat(lines.flatMap((line) => [line, Buffer.from([0])])) })).toString().trim();
    const make = async (depth) => {
      const names = new Set(), lines = [];
      for (let index = 0, count = random(depth ? 6 : 9); index < count; index += 1) {
        const entry = name(); if (names.has(entry)) continue; names.add(entry);
        const kind = random(10), bytes = Buffer.from(entry, 'latin1');
        const line = kind < 3 && depth < 4 ? `040000 tree ${await make(depth + 1)}`
          : kind === 3 ? `100755 blob ${await blob(`x${random(50)}`)}` : kind === 4 ? `120000 blob ${await blob('target')}`
            : kind === 5 ? `160000 commit ${'c'.repeat(oidLength)}` : `100644 blob ${await blob('y'.repeat(random(20) * 97))}`;
        lines.push(Buffer.concat([Buffer.from(`${line}\t`), bytes]));
      }
      return tree(lines);
    };
    let rows = 0, prefixed = 0;
    for (let round = 0; round < 40; round += 1) {
      const root = round === 0 ? await tree([]) : await make(0);
      const expected = await gitListing(gitDir, root);
      expect((await readerListing(gitDir, root, oidLength)).map(listedRowText)).toEqual(expected);
      rows += expected.length;
      // Reads split into batches of three give the same rows.
      const batched = await listTreeRows({ tree: root, oidLength, batch: 3,
        readTree: async (oid) => { const found = await readGitObject(gitDir, ['--git-dir', gitDir], oid); return found?.type === 'tree' ? found.data : null; },
        sizeOf: async (oid) => { const found = await readGitObject(gitDir, ['--git-dir', gitDir], oid, { check: true }); return found?.type === 'blob' ? found.size : null; } });
      expect(batched.map(listedRowText)).toEqual(expected);
      // A subtree listed under its path, as `ls-tree -r -l -z <outer> -- <path>/` (literal)
      // prints it, beside siblings that share the path's leading bytes.
      const outer = await tree([`040000 tree ${root}\tp_${round}`, `100644 blob ${await blob('s')}\tp_${round}-x`,
        `040000 tree ${root}\tp_${round}0`, `040000 tree ${root}\tp_${round}-`].map((line) => Buffer.from(line)));
      for (const entry of parseTree((await readGitObject(gitDir, ['--git-dir', gitDir], outer)).data, oidLength)) {
        if (entry.mode !== '40000' || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue; // the store's prefix alphabet
        const out = await git(gitDir, ['--git-dir', gitDir, '--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', outer, '--', `${entry.name}/`]);
        const under = out.length ? out.subarray(0, -1).toString().split('\0') : [];
        const listed = await listTreeRows({ tree: entry.oid, oidLength, prefix: `${entry.name}/`,
          readTree: async (oid) => (await readGitObject(gitDir, ['--git-dir', gitDir], oid))?.data ?? null,
          sizeOf: async (oid) => (await readGitObject(gitDir, ['--git-dir', gitDir], oid, { check: true }))?.size ?? null });
        expect(listed.map(listedRowText)).toEqual(under);
        prefixed += 1;
      }
    }
    expect(rows).toBeGreaterThan(200);
    expect(prefixed).toBe(120);
    // A missing blob (Git prints "BAD"), a missing subtree, an unlisted mode
    // and a non-tree are never answered: the caller asks Git.
    const missing = 'd'.repeat(oidLength);
    expect(await readerListing(gitDir, await tree([Buffer.from(`100644 blob ${missing}\tgone`)]), oidLength)).toBeNull();
    expect(await readerListing(gitDir, await tree([Buffer.from(`040000 tree ${missing}\tgone`)]), oidLength)).toBeNull();
    expect(await readerListing(gitDir, await blob('not a tree'), oidLength)).toBeNull();
    const odd = Buffer.concat([Buffer.from(`100664 `), Buffer.from('odd\0'), Buffer.from(await blob('odd'), 'hex')]);
    expect(await readerListing(gitDir, await writeLooseObject(gitDir, 'tree', odd, oidLength), oidLength)).toBeNull();
    // Review S5: a tree out of Git's order or with a repeated name, at the
    // root or below it, is never answered either.
    const entry = (mode, name, oid) => Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'latin1'), Buffer.from(oid, 'hex')]);
    const raw = (entries) => writeLooseObject(gitDir, 'tree', Buffer.concat(entries), oidLength);
    const one = await blob('one'), sub = await tree([Buffer.from(`100644 blob ${one}\tone.json`)]);
    const malformed = {
      'two subtrees': [entry('40000', 'runs', sub), entry('40000', 'runs', sub)],
      'a subtree and a file': [entry('100644', 'runs', one), entry('40000', 'runs', sub)],
      'a file, a sibling and a subtree': [entry('100644', 'runs', one), entry('100644', 'runs-x', one), entry('40000', 'runs', sub)],
      'two files': [entry('100644', 'a.json', one), entry('100644', 'a.json', one)],
      'unsorted files': [entry('100644', 'b.json', one), entry('100644', 'a.json', one)],
      'a subtree sorted as a file': [entry('40000', 'a', sub), entry('100644', 'a-b', one)],
    };
    for (const [name, entries] of Object.entries(malformed)) {
      const bad = await raw(entries);
      expect({ name, root: await readerListing(gitDir, bad, oidLength) }).toEqual({ name, root: null });
      const outer = await tree([Buffer.from(`040000 tree ${bad}\tnested`)]);
      expect({ name, nested: await readerListing(gitDir, outer, oidLength) }).toEqual({ name, nested: null });
    }
    // The same entries in order list as Git lists them.
    const sorted = await raw([entry('100644', 'a-b', one), entry('40000', 'a', sub), entry('100644', 'runs', one), entry('100644', 'runs-x', one)]);
    expect((await readerListing(gitDir, sorted, oidLength)).map(listedRowText)).toEqual(await gitListing(gitDir, sorted));
  }, 60_000);

  test(`listTreeRows lists every tree a ledger history commits, direct and through Git's index (${format})`, async () => {
    const steps = history(), oidLength = format === 'sha1' ? 40 : 64;
    for (const directTrees of ['0', '1']) {
      process.env.DEVRYAN_LEDGER_DIRECT_TREES = directTrees;
      const repo = await repository(format);
      for (const tree of await replay(repo, steps)) {
        expect((await readerListing(repo.gitDir, tree, oidLength)).map(listedRowText)).toEqual(await gitListing(repo.gitDir, tree));
      }
    }
  }, 60_000);
}
