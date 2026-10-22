import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, readGitObject } from './session-changes-git.js';
import { openChangeStore } from './session-changes-store.js';

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
