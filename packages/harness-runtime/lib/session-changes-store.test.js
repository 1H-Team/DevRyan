import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, gitRecords, gitTokens, readGitObject } from './session-changes-git.js';
import { openChangeStore } from './session-changes-store.js';
import { serializeTree, writeLooseObject } from './session-changes-trees.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-change-store-')); roots.push(root);
  const gitDir = path.join(root, 'git');
  await git(root, ['init', '--bare', '--quiet', gitDir]);
  return { root, gitDir, open: () => openChangeStore(root, gitDir) };
}

for(const baseline of [false,true])test(`guarded commit rolls back post-CAS revocation with ${baseline?'existing':'absent'} state ref`,async()=>{
  const s=await store();
  if(baseline){const initial=await s.open();initial.set('sessions/keep.json',{value:'keep'});await initial.commit();}
  let revoked=false;
  const cause=Object.assign(Error('owner revoked'),{code:'native_permit_revoked'});
  const db=await openChangeStore(s.root,s.gitDir,{gitRunner:{git:async(root,command,options)=>{
    const result=await git(root,command,options);
    if(command.includes('update-ref')&&!revoked)revoked=true;
    return result;
  }}});
  db.set('cancelled-calls/proof.json',{sessionID:'a',messageID:'denied'});
  await expect(db.commit({assertCurrent:()=>{if(revoked)throw cause;}})).rejects.toBe(cause);
  const reopened=await s.open();expect(await reopened.get('cancelled-calls/proof.json')).toBeNull();
  expect(await reopened.get('sessions/keep.json')).toEqual(baseline?{value:'keep'}:null);
});

test('guarded commit checks owner after staged IO and before the actual ref update',async()=>{
  const s=await store();let revoked=false,refWrites=0;
  const cause=Object.assign(Error('owner revoked'),{code:'native_permit_revoked'});
  const db=await openChangeStore(s.root,s.gitDir,{gitRunner:{git:async(root,command,options)=>{
    if(command.includes('update-ref'))refWrites++;
    const result=await git(root,command,options);if(command.includes('write-tree'))revoked=true;return result;
  }}});
  db.set('cancelled-calls/proof.json',{sessionID:'a',messageID:'denied'});
  await expect(db.commit({assertCurrent:()=>{if(revoked)throw cause;}})).rejects.toBe(cause);
  expect(refWrites).toBe(0);expect(await (await s.open()).get('cancelled-calls/proof.json')).toBeNull();
});

test('guarded commit rollback failure truthfully reports the committed CAS and never claims revocation rolled back',async()=>{
  const s=await store();let revoked=false;
  const db=await openChangeStore(s.root,s.gitDir,{gitRunner:{git:async(root,command,options)=>{
    if(command.includes('update-ref')&&revoked)throw Error('rollback unavailable');
    const result=await git(root,command,options);if(command.includes('update-ref'))revoked=true;return result;
  }}});
  db.set('cancelled-calls/proof.json',{sessionID:'a',messageID:'denied'});
  await expect(db.commit({assertCurrent:()=>{if(revoked)throw Error('owner revoked');}})).rejects.toMatchObject({code:'ledger_guard_rollback_failed',committed:true,rollbackFailed:true});
  expect(await (await s.open()).get('cancelled-calls/proof.json')).toEqual({sessionID:'a',messageID:'denied'});
});

test('staged call failure restores earlier pending rows and cannot commit inside its savepoint', async () => {
  const s = await store(), db = await s.open();
  db.set('sessions/first.json', { value: 'keep' });
  await expect(db.stage(async () => {
    db.set('sessions/first.json', { value: 'replace' });
    db.set('sessions/failed.json', { value: 'discard' });
    throw new Error('fixture refused');
  })).rejects.toThrow('fixture refused');
  expect(await db.get('sessions/first.json')).toEqual({ value: 'keep' });
  expect(await db.get('sessions/failed.json')).toBeNull();
  await expect(db.stage(() => db.commit())).rejects.toMatchObject({ code: 'invalid_change_record' });
  await db.stage(async () => db.set('sessions/last.json', { value: 'accepted' }));
  await db.commit();
  const reopened = await s.open();
  expect(await reopened.get('sessions/first.json')).toEqual({ value: 'keep' });
  expect(await reopened.get('sessions/last.json')).toEqual({ value: 'accepted' });
  expect(await reopened.get('sessions/failed.json')).toBeNull();
});

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

test('records() streams every key including top-level meta.json, skips pending, and seeds the baseline', async () => {
  const s = await store();
  const first = await s.open();
  expect(await (async () => { const out = []; for await (const r of first.records()) out.push(r); return out; })()).toEqual([]);
  first.set('meta.json', { version: 1 });
  first.set('sessions/a.json', { id: 'a' });
  first.set('files/0/b.json', { id: 'b' });
  await first.commit();

  const second = await s.open();
  second.set('sessions/c.json', { id: 'c' });
  const seen = [];
  for await (const { key, value } of second.records()) { seen.push(key); second.set(key, { ...value }); }
  expect(seen.sort()).toEqual(['files/0/b.json', 'meta.json', 'sessions/a.json']);
  expect(second.pendingCount).toBe(1);
  const tree = second.tree;
  await second.commit();
  expect(second.tree).not.toBe(tree);

  const third = await s.open();
  for await (const { key, value } of third.records()) third.set(key, { ...value });
  expect(third.pendingCount).toBe(0);
});

test('records() streams a ledger whose key listing exceeds the 1 MiB buffered-command cap', async () => {
  const s = await store();
  const writer = await s.open();
  const keys = [];
  for (let i = 0; i < 4200; i++) {
    const key = `files/${String(i).padStart(6, '0')}${'a'.repeat(250)}/x.json`;
    keys.push(key); writer.set(key, { i });
  }
  await writer.commit();
  const listing = (await git(s.root, ['--git-dir', s.gitDir, 'ls-tree', '-r', '--name-only', writer.tree]).catch((e) => e));
  // The regression condition: the buffered listing is over the 1 MiB stdout cap.
  expect(keys.reduce((total, key) => total + key.length + 1, 0)).toBeGreaterThan(1024 * 1024);
  expect(listing).toBeInstanceOf(Error);
  expect(listing.code).toBe('change_record_too_large');

  const reader = await s.open();
  let count = 0;
  for await (const { key, value } of reader.records()) { expect(value.i).toBe(Number(key.slice(6, 12))); count++; }
  expect(count).toBe(keys.length);
}, 60_000);

test('persistent object reader: reads settling together never leave a timer that closes a busy reader', async () => {
  const { root, gitDir } = await store();
  const oid = (await git(root, ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: '{"a":1}' })).toString().trim();
  const args = ['--git-dir', gitDir], read = (name) => readGitObject(root, args, name, { idleMs: 40 });
  // A batch settling in one tick arms the idle timer once per read.
  expect((await Promise.all(Array.from({ length: 8 }, () => read(oid)))).every((row) => row?.data.toString() === '{"a":1}')).toBe(true);
  // Keep the reader busy across every timer the batch armed.
  const started = Date.now(), failures = [];
  while (Date.now() - started < 150) await read(oid).catch((cause) => failures.push(cause.code));
  expect(failures).toEqual([]);
  expect(await read('0'.repeat(oid.length))).toBeNull();
  expect(await readGitObject(root, args, oid, { check: true, idleMs: 40 })).toEqual({ oid, type: 'blob', size: 7 });
});

for (const directTrees of ['1', '0']) test(`list pages written before a transaction commit like setList's (direct trees ${directTrees})`, async () => {
  const previous = process.env.DEVRYAN_LEDGER_DIRECT_TREES;
  process.env.DEVRYAN_LEDGER_DIRECT_TREES = directTrees;
  try {
    const s = await store();
    // 128-value and 256 KiB page breaks, and one value larger than a page alone.
    const values = [...Array.from({ length: 300 }, (_, index) => ({ index })), ...Array.from({ length: 6 }, (_, index) => ({ wide: 'x'.repeat(60_000 + index) })),
      { alone: 'y'.repeat(300_000) }, { after: true }];
    const reference = await s.open();
    reference.set('meta.json', { version: 1 });
    expect(await reference.setList('lists/reference', values, { firstPage: 1 }))
      .toBe(values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0));
    await reference.commit();
    const written = await s.open();
    const { objects: oids, bytes } = await written.writeList(values);
    expect(bytes).toBe(values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0));
    // Nothing is staged until the ids are, so the objects alone change no state.
    expect(written.pendingCount).toBe(0);
    written.setListObjects('lists/staged', oids, { firstPage: 1 });
    await written.commit();
    const reopened = await s.open(), pages = async (prefix) => {
      const result = [];
      for await (const { key, value } of reopened.entries(prefix)) result.push([key.slice(prefix.length), value]);
      return result;
    };
    const expected = await pages('lists/reference');
    expect(expected.map(([key]) => key)).toEqual(['/0000000001.json', '/0000000002.json', '/0000000003.json', '/0000000004.json', '/0000000005.json', '/0000000006.json']);
    expect(await pages('lists/staged')).toEqual(expected);
    expect(() => written.setListObjects('lists/bad', ['not-an-oid'])).toThrow();
    expect(() => written.setListObjects('../escape', oids)).toThrow();
  } finally {
    if (previous === undefined) delete process.env.DEVRYAN_LEDGER_DIRECT_TREES; else process.env.DEVRYAN_LEDGER_DIRECT_TREES = previous;
  }
});

test('setList hands collect the exact staged page JSON, which lists back as the committed rows',async()=>{
  const s=await store();
  // Undefined fields are dropped by the stored JSON; a kept reference would still carry them.
  const values=Array.from({length:300},(_,index)=>({path:`f${index}`,entry:{hash:String(index),whole:undefined},stamp:index%2?undefined:`s${index}`}));
  const pages=[],counts=[];
  const db=await s.open();
  const bytes=await db.setList('bases/t/files',values,{collect:(data,rows)=>{pages.push(data);counts.push(rows);}});
  const plain=await s.open();
  expect(await plain.setList('bases/t/files',values)).toBe(bytes);
  expect(pages.length).toBe(3);
  expect(counts).toEqual([128,128,44]);
  expect(bytes).toBe(values.reduce((sum,value)=>sum+Buffer.byteLength(JSON.stringify(value)),0));
  await db.commit();
  const listed=[];for await(const row of (await s.open()).list('bases/t/files'))listed.push(row);
  const collected=pages.flatMap((page)=>JSON.parse(page));
  expect(collected).toStrictEqual(listed);
  expect(collected[1]).toStrictEqual({path:'f1',entry:{hash:'1'}});
  expect(Object.hasOwn(values[1],'stamp')).toBe(true);
  // The staged blob is the collected string byte for byte.
  const committed=await s.open();
  expect(JSON.stringify(await committed.get('bases/t/files/0000000000.json'))).toBe(pages[0]);
});

// entries() and staged() sort only the staged writes under the prefix. The
// reference is the earlier form: every staged key sorted with the same
// comparison, then filtered. Seeded keys share string prefixes across
// prefixes (`bases/t`, `bases/t-x`, `bases/t2`), mix case, digits, '-' and '_',
// and include removals and staged object ids.
test('entries and staged list staged writes in the order a sort of every staged key gave', async () => {
  let seed = 11;
  const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 12) % limit; }; // high bits: the low ones cycle
  const alphabet = 'aAbB09_-zZ', prefixes = ['bases/t', 'bases/t-x', 'bases/t2', 'bases/t/files', 'runs', 'a'];
  const name = () => Array.from({ length: 1 + random(6) }, () => alphabet[random(alphabet.length)]).join('');
  const s = await store();
  const base = await s.open();
  for (let index = 0; index < 40; index += 1) base.set(`${prefixes[random(prefixes.length)]}/${name()}.json`, { committed: index });
  await base.commit();
  for (let round = 0; round < 6; round += 1) {
    const db = await s.open(), mirror = new Map();
    const { objects } = await db.writeList([{ staged: round }]);
    for (let index = 0; index < 60; index += 1) {
      const key = `${prefixes[random(prefixes.length)]}/${name()}.json`, kind = random(5);
      if (kind === 0) { db.remove(key); mirror.set(key, null); }
      else if (kind === 1) {
        const prefix = key.slice(0, -'.json'.length);
        db.setListObjects(prefix, objects);
        mirror.set(`${prefix}/0000000000.json`, { oid: objects[0] });
      } else { db.set(key, { round, index }); mirror.set(key, JSON.stringify({ round, index })); }
    }
    const reference = [...mirror].sort(([a], [b]) => a.localeCompare(b));
    const valueOf = (data) => data === null ? null : typeof data === 'object' ? [{ staged: round }] : JSON.parse(data);
    for (const prefix of [...prefixes, 'bases', 'none']) {
      const under = reference.filter(([key]) => key.startsWith(`${prefix}/`));
      const listed = []; for await (const row of db.entries(prefix)) listed.push([row.key, row.value]);
      const fromTree = listed.slice(0, listed.length - under.filter(([, data]) => data !== null).length);
      expect(fromTree.every(([key]) => !mirror.has(key))).toBe(true);
      expect(listed.slice(fromTree.length)).toEqual(under.filter(([, data]) => data !== null).map(([key, data]) => [key, valueOf(data)]));
      expect([...(await db.staged(prefix))]).toEqual(under.map(([key, data]) => [key, valueOf(data)]));
    }
  }
});

// Direct listings (the persistent reader and the tree parser instead of
// `git ls-tree`) give every reader the rows Git's listing gave. Two ledgers
// replay one seeded history, one per switch value (the listing cache is keyed
// by repository, so neither serves the other), and every prefix lists alike.
// A listing bound of one byte keeps both ledgers on the paged per-prefix path.
for (const listingLimitBytes of [undefined, 1]) test(`direct listings and DEVRYAN_LEDGER_DIRECT_LISTINGS=0 list every committed tree alike (${listingLimitBytes ? 'paged' : 'whole tree'})`, async () => {
  const previous = process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS;
  let seed = 23;
  const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 12) % limit; }; // high bits: the low ones cycle
  const prefixes = ['files', 'runs/a', 'runs/a-b', 'runs/a_b', 'bases/t/files', 'bases/t2', 'operations', 'materializations/m'];
  const steps = Array.from({ length: 16 }, (_, step) => Array.from({ length: 1 + random(10) }, (_, index) =>
    [`${prefixes[random(prefixes.length)]}/${String(random(30)).padStart(4, '0')}.json`, random(4) === 0 ? null : { step, index, text: 'x'.repeat(random(90)) }]));
  const arms = { direct: await store(), git: await store() };
  const open = (s) => openChangeStore(s.root, s.gitDir, listingLimitBytes ? { listingLimitBytes } : {});
  let totalRows = 0;
  try {
    for (const writes of steps) {
      const listed = {};
      for (const [arm, s] of Object.entries(arms)) {
        process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS = arm === 'git' ? '0' : '1';
        const db = await open(s);
        for (const [key, value] of writes) value === null ? db.remove(key) : db.set(key, value);
        await db.commit();
        const reread = await open(s), rows = [];
        for (const prefix of [...prefixes, 'runs', 'bases', 'none']) {
          for await (const row of reread.committedRows(prefix)) rows.push(row);
          for await (const { key, value } of reread.entries(prefix)) rows.push([key, value]);
        }
        listed[arm] = { tree: reread.tree, rows };
      }
      expect(listed.direct.tree).toBe(listed.git.tree);
      expect(listed.direct.rows).toEqual(listed.git.rows);
      totalRows += listed.direct.rows.length;
    }
    expect(totalRows).toBeGreaterThan(500);
  } finally { if (previous === undefined) delete process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS; else process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS = previous; }
}, 60_000);

// Whole listings stay with Git (they mark a ledger paged past the bound);
// a paged prefix listing starts no process unless the switch is 0.
test('a paged direct listing starts no ls-tree process; the switch at 0 starts one per prefix', async () => {
  const previous = process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS;
  try {
    for (const value of ['1', '0']) {
      process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS = value;
      const s = await store(), listings = [];
      const gitRunner = { git, gitRecords, readObject: readGitObject,
        gitTokens: (cwd, args, options) => { if (args.includes('ls-tree')) listings.push(args.includes('--') ? `paged ${args.at(-1)}` : 'whole'); return gitTokens(cwd, args, options); } };
      const db = await openChangeStore(s.root, s.gitDir, { gitRunner, listingLimitBytes: 1 });
      db.set('operations/a.json', { value }); db.set('runs/x/0.json', { value }); await db.commit();
      const seen = []; for await (const { key } of db.entries('operations')) seen.push(key);
      for await (const { key } of db.entries('runs/x')) seen.push(key);
      expect(seen).toEqual(['operations/a.json', 'runs/x/0.json']);
      expect(listings).toEqual(value === '1' ? ['whole'] : ['whole', 'paged operations/', 'paged runs/x/']);
    }
  } finally { if (previous === undefined) delete process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS; else process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS = previous; }
});

// Review B1, S1, S2: on every damaged or unusual tree, direct listings and
// DEVRYAN_LEDGER_DIRECT_LISTINGS=0 must give the same rows or the same error
// (code, status and Git's failure class), on the whole-tree and paged paths.
const withListings = async (value, action) => {
  const previous = process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS;
  process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS = value;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS; else process.env.DEVRYAN_LEDGER_DIRECT_LISTINGS = previous; }
};
const outcome = async (action) => {
  try { return { value: await action() }; }
  catch (error) { return { error: `${error.code}:${error.status}:${error.failure ?? ''}` }; }
};
const repositoryOf = async (format) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-listing-')); roots.push(root);
  const gitDir = path.join(root, 'git');
  await git(root, ['init', '--bare', '--quiet', `--object-format=${format}`, gitDir]);
  const oidLength = format === 'sha1' ? 40 : 64, objects = path.join(root, 'git');
  const blob = (text) => writeLooseObject(objects, 'blob', Buffer.from(text), oidLength);
  const tree = (entries) => writeLooseObject(objects, 'tree', serializeTree(entries), oidLength);
  const objectFile = (oid) => path.join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
  // The loose ref is read without a process; a ref may name a tree that is gone.
  const point = async (oid) => { await fs.mkdir(path.join(gitDir, 'refs', 'devryan'), { recursive: true }); await fs.writeFile(path.join(gitDir, 'refs', 'devryan', 'state'), `${oid}\n`); };
  return { root, gitDir, oidLength, blob, tree, objectFile, point };
};
// runs/a/b/x.json, runs/a/y.json, runs/z.json, top.json and a file `runs/f`.
const ledgerTree = async (repo) => {
  const x = await repo.blob('[1]'), y = await repo.blob('[2]');
  const b = await repo.tree([{ mode: '100644', name: 'x.json', oid: x }]);
  const a = await repo.tree([{ mode: '40000', name: 'b', oid: b }, { mode: '100644', name: 'y.json', oid: y }]);
  const runs = await repo.tree([{ mode: '40000', name: 'a', oid: a }, { mode: '100644', name: 'z.json', oid: y }, { mode: '100644', name: 'f', oid: x }]);
  const root = await repo.tree([{ mode: '40000', name: 'runs', oid: runs }, { mode: '100644', name: 'top.json', oid: x }]);
  return { root, runs, a, b, x };
};
const damage = {
  healthy: async () => {},
  'missing root': async (repo, t) => fs.rm(repo.objectFile(t.root)),
  'missing subtree at depth 1': async (repo, t) => fs.rm(repo.objectFile(t.runs)),
  'missing subtree at depth 2': async (repo, t) => fs.rm(repo.objectFile(t.a)),
  'missing subtree at depth 3': async (repo, t) => fs.rm(repo.objectFile(t.b)),
  'missing blob': async (repo, t) => fs.rm(repo.objectFile(t.x)),
  'corrupt subtree object': async (repo, t) => { const file = repo.objectFile(t.a); await fs.rm(file); await fs.writeFile(file, 'not a zlib stream'); },
};
const listOnce = async (repo, root, prefix, paged, healthy) => {
  const options = paged ? { listingLimitBytes: 1 } : {};
  if (paged) { // Mark this ledger oversized first, by listing a healthy tree over the bound.
    await repo.point(healthy);
    const warm = await openChangeStore(repo.root, repo.gitDir, options);
    for await (const _ of warm.committedRows('healthy')) { /* listed */ }
  }
  await repo.point(root);
  const db = await openChangeStore(repo.root, repo.gitDir, options);
  const rows = await outcome(async () => { const listed = []; for await (const row of db.committedRows(prefix)) listed.push(`${row.key}:${row.oid}:${row.size}`); return listed; });
  const imported = await outcome(async () => { const into = await openChangeStore(repo.root, repo.gitDir, options); await into.importPrefix(root, prefix, 'copy'); return into.pendingCount; });
  return { rows, imported };
};
for (const format of ['sha1', 'sha256']) {
  test(`damaged, absent and file prefixes list and fail alike on both switch values (${format})`, async () => {
    let compared = 0, failed = 0;
    for (const [name, apply] of Object.entries(damage)) for (const prefix of ['runs', 'runs/a', 'runs/a/b', 'runs/f', 'runs/none', 'none/x', 'top']) for (const paged of [true, false]) {
      const results = {};
      for (const value of ['1', '0']) {
        const repo = await repositoryOf(format), shape = await ledgerTree(repo);
        const healthy = await repo.tree([{ mode: '40000', name: 'healthy', oid: await repo.tree([{ mode: '100644', name: 'h.json', oid: await repo.blob('[0]') }]) }]);
        await apply(repo, shape);
        results[value] = await withListings(value, () => listOnce(repo, shape.root, prefix, paged, healthy));
      }
      expect({ name, prefix, paged, ...results['1'] }).toEqual({ name, prefix, paged, ...results['0'] });
      compared += 1; if (results['0'].rows.error) failed += 1;
    }
    expect(compared).toBe(98);
    expect(failed).toBeGreaterThan(20);
  }, 120_000);

  test(`an object lost after a listing fails the next listing on both switch values (${format})`, async () => {
    const results = {};
    for (const value of ['1', '0']) {
      const repo = await repositoryOf(format), shape = await ledgerTree(repo);
      await repo.point(shape.root);
      results[value] = await withListings(value, async () => {
        const list = async (paged) => { const db = await openChangeStore(repo.root, repo.gitDir, paged ? { listingLimitBytes: 1 } : {});
          return outcome(async () => { const keys = []; for await (const row of db.committedRows('runs')) keys.push(row.key); return keys; }); };
        const before = [await list(false), await list(true)];
        await fs.rm(repo.objectFile(shape.a));
        // A new tree identity, so the whole-tree listing is not answered from the listing cache.
        const top = await repo.blob('[9]');
        await repo.point(await repo.tree([{ mode: '40000', name: 'runs', oid: shape.runs }, { mode: '100644', name: 'top.json', oid: top }]));
        return { before, after: [await list(false), await list(true)] };
      });
    }
    expect(results['1']).toEqual(results['0']);
    for (const listed of results['0'].before) expect(listed.value).toEqual(['runs/a/b/x.json', 'runs/a/y.json', 'runs/f', 'runs/z.json']);
    expect(results['0'].after.every((result) => result.error?.startsWith('capture_git_failed:503:'))).toBe(true);
  }, 60_000);
}

// Review S5: trees the ledger never writes, out of Git's order or repeating a
// name, at the root, on the path to the prefix and inside the listed subtree.
// Git's walk stops early or matches twice there; both switch values must give
// Git's rows or Git's error, on the paged and the whole-tree path.
const rawTree = (repo, entries) => writeLooseObject(path.join(repo.root, 'git'), 'tree', Buffer.concat(entries.map(({ mode, name, oid }) =>
  Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'latin1'), Buffer.from(oid, 'hex')]))), repo.oidLength);
const file = (name, oid) => ({ mode: '100644', name, oid }), dir = (name, oid) => ({ mode: '40000', name, oid });
const malformed = {
  'root: two subtrees named runs': async (repo, t) => rawTree(repo, [dir('runs', t.runs), dir('runs', t.other), file('top.json', t.x)]),
  'root: a file and a subtree named runs': async (repo, t) => rawTree(repo, [file('runs', t.x), dir('runs', t.runs), file('top.json', t.x)]),
  'root: a file and a subtree named runs apart': async (repo, t) => rawTree(repo, [file('runs', t.x), file('runs-x', t.x), dir('runs', t.runs)]),
  'root: two files named top.json': async (repo, t) => rawTree(repo, [dir('runs', t.runs), file('top.json', t.x), file('top.json', t.y)]),
  'root: out of order': async (repo, t) => rawTree(repo, [file('zz.json', t.x), dir('runs', t.runs)]),
  'root: out of order after the prefix': async (repo, t) => rawTree(repo, [dir('runs', t.runs), file('aa.json', t.x)]),
  'path: two subtrees named a': async (repo, t) => repo.tree([dir('runs', await rawTree(repo, [dir('a', t.a), dir('a', t.b), file('z.json', t.y)]))]),
  'path: a file and a subtree named a': async (repo, t) => repo.tree([dir('runs', await rawTree(repo, [file('a', t.x), dir('a', t.a)]))]),
  'path: out of order': async (repo, t) => repo.tree([dir('runs', await rawTree(repo, [file('z.json', t.y), dir('a', t.a)]))]),
  'listed: two subtrees named b': async (repo, t) => repo.tree([dir('runs', await repo.tree([dir('a', await rawTree(repo, [dir('b', t.b), dir('b', t.b), file('y.json', t.y)]))]))]),
  'listed: two files named y.json': async (repo, t) => repo.tree([dir('runs', await repo.tree([dir('a', await rawTree(repo, [dir('b', t.b), file('y.json', t.y), file('y.json', t.x)]))]))]),
  'listed: out of order': async (repo, t) => repo.tree([dir('runs', await repo.tree([dir('a', await rawTree(repo, [file('y.json', t.y), dir('b', t.b)]))]))]),
};
for (const format of ['sha1', 'sha256']) {
  test(`trees out of Git's order or repeating a name list and fail alike on both switch values (${format})`, async () => {
    let compared = 0, listed = 0;
    for (const [name, build] of Object.entries(malformed)) for (const prefix of ['runs', 'runs/a', 'runs/a/b', 'top']) for (const paged of [true, false]) {
      const results = {};
      for (const value of ['1', '0']) {
        const repo = await repositoryOf(format), shape = await ledgerTree(repo);
        const y = await repo.blob('[2]'), other = await repo.tree([file('two.json', y)]);
        const root = await build(repo, { ...shape, y, other });
        const healthy = await repo.tree([{ mode: '40000', name: 'healthy', oid: await repo.tree([{ mode: '100644', name: 'h.json', oid: await repo.blob('[0]') }]) }]);
        results[value] = await withListings(value, () => listOnce(repo, root, prefix, paged, healthy));
      }
      expect({ name, prefix, paged, ...results['1'] }).toEqual({ name, prefix, paged, ...results['0'] });
      compared += 1; if (results['0'].rows.value?.length) listed += 1;
    }
    expect(compared).toBe(96);
    expect(listed).toBeGreaterThan(20);
  }, 120_000);
}

test('a whole listing over the bound goes paged on both switch values', async () => {
  const results = {}, reads = {};
  for (const value of ['1', '0']) {
    const repo = await repositoryOf('sha1');
    const leaves = [];
    for (let index = 0; index < 40; index += 1) {
      const files = [];
      for (let file = 0; file < 20; file += 1) files.push({ mode: '100644', name: `${String(file).padStart(4, '0')}.json`, oid: await repo.blob(`[${index},${file}]`) });
      leaves.push({ mode: '40000', name: `r${String(index).padStart(3, '0')}`, oid: await repo.tree(files) });
    }
    const runs = await repo.tree(leaves);
    await repo.point(await repo.tree([{ mode: '40000', name: 'runs', oid: runs }]));
    const counted = { reads: 0, listings: [] };
    const gitRunner = { git, gitRecords, readObject: (...input) => { counted.reads += 1; return readGitObject(...input); },
      gitTokens: (cwd, args, options) => { if (args.includes('ls-tree')) counted.listings.push(args.includes('--') ? 'paged' : 'whole'); return gitTokens(cwd, args, options); } };
    results[value] = await withListings(value, async () => {
      const db = await openChangeStore(repo.root, repo.gitDir, { gitRunner, listingLimitBytes: 4_000 });
      const keys = []; for await (const row of db.committedRows('runs/r001')) keys.push(`${row.key}:${row.size}`);
      return keys;
    });
    reads[value] = counted;
  }
  expect(results['1']).toEqual(results['0']);
  expect(results['0']).toHaveLength(20);
  // Git lists the whole tree until the bound in both, then the prefix is paged:
  // by Git at 0, otherwise from the reader (two trees on the path, one leaf, 20 sizes).
  expect(reads['0'].listings).toEqual(['whole', 'paged']);
  expect(reads['1'].listings).toEqual(['whole']);
  expect(reads['1'].reads).toBe(23);
});

test('a large direct listing keeps at most 256 reads queued and does not hold up a concurrent read', async () => {
  const repo = await repositoryOf('sha1');
  const leaves = [];
  for (let index = 0; index < 30; index += 1) {
    const files = [];
    for (let file = 0; file < 100; file += 1) files.push({ mode: '100644', name: `${String(file).padStart(4, '0')}.json`, oid: await repo.blob(`[${index},${file}]`) });
    leaves.push({ mode: '40000', name: `r${String(index).padStart(3, '0')}`, oid: await repo.tree(files) });
  }
  await repo.point(await repo.tree([{ mode: '40000', name: 'runs', oid: await repo.tree(leaves) }]));
  let inFlight = 0, most = 0;
  const gitRunner = { git, gitRecords, gitTokens, readObject: async (...input) => {
    inFlight += 1; most = Math.max(most, inFlight);
    try { return await readGitObject(...input); } finally { inFlight -= 1; } } };
  await withListings('1', async () => {
    const db = await openChangeStore(repo.root, repo.gitDir, { gitRunner, listingLimitBytes: 1 });
    for await (const _ of db.committedRows('none')) { /* the whole listing passes the bound: paged from here */ }
    const listing = (async () => { let count = 0; for await (const _ of db.committedRows('runs')) count += 1; return count; })();
    await new Promise((resolve) => setImmediate(resolve));
    const started = performance.now();
    const single = await readGitObject(repo.root, ['--git-dir', repo.gitDir], `${db.tree}:runs`, { check: true });
    const waited = performance.now() - started;
    expect(single?.type).toBe('tree');
    expect(await listing).toBe(3_000);
    expect(waited).toBeLessThan(10_000);
  });
  expect(most).toBeLessThanOrEqual(256);
  expect(most).toBeGreaterThan(100);
}, 60_000);
