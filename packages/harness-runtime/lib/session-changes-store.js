import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitRecords, gitTokens, changeError, persistentGitReaders, readGitObject } from './session-changes-git.js';
import { syncPendingObjectDirectory } from './object-durability.js';
import { commitTreeChanges, writeLooseObject } from './session-changes-trees.js';

export const changeKey = (value) => crypto.createHash('sha256').update(value).digest('hex');
const STATE_REF = 'refs/devryan/state';
const blobs = new Map();
let blobBytes = 0;
const listings = new Map();
const oversizedStores = new Set();
const LISTING_LIMIT_BYTES = 1024 * 1024;
const lowerBound = (rows, key) => {
  let low = 0, high = rows.length;
  while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].key < key) low = middle + 1; else high = middle; }
  return low;
};
const remember = (key, data) => {
  if (blobs.has(key)) return;
  blobs.set(key, data); blobBytes += Buffer.byteLength(data);
  while (blobBytes > 8 * 1024 * 1024 || blobs.size > 4096) {
    const oldest = blobs.keys().next().value;
    blobBytes -= Buffer.byteLength(blobs.get(oldest)); blobs.delete(oldest);
  }
};
const validKey = (key) => typeof key === 'string' && /^[a-zA-Z0-9/_-]+\.json$/.test(key)
  && !key.split('/').some((part) => !part || part === '..');

// Git's tree is the on-disk index: one small blob per entity, fixed-size pages
// for lists, and one atomic ref update for the entire transaction. Old readers
// retain their tree identity. No lifetime-sized JSON document is rewritten.
// `persistentIndex` (owner-locked state commits only): keep this ledger's Git
// index between commits instead of rebuilding it from the whole tree each time.
// `at`: a read-only store of that earlier committed tree; it never commits.
export async function openChangeStore(cwd, gitDir, { ref = STATE_REF,gitRunner,syncObjects=syncPendingObjectDirectory,listingLimitBytes=LISTING_LIMIT_BYTES,persistentIndex=false,at } = {}) {
  if (!Number.isSafeInteger(listingLimitBytes) || listingLimitBytes <= 0) throw changeError('invalid_change_record');
  if (at !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(at)) throw changeError('invalid_change_record');
  if (ref !== STATE_REF && !/^refs\/devryan\/leases\/[a-f0-9-]{36}$/.test(ref)) throw changeError('invalid_change_record');
  const args = ['--git-dir', gitDir];
  const runGit=gitRunner?.git??git,runTokens=gitRunner?.gitTokens??gitTokens,runRecords=gitRunner?.gitRecords??gitRecords;
  const run = (command, extra) => runGit(cwd, [...args, ...command], extra);
  // Default runner only: one long-lived reader instead of a process per read.
  const reader = gitRunner ? gitRunner.readObject ?? null : persistentGitReaders() ? readGitObject : null;
  const readObject = (name, options) => reader(cwd, args, name, options);
  // `update-ref` replaces a loose ref atomically; read it without a process.
  // Absent (packed or not yet created) or unexpected content asks Git.
  const looseRef = at ?? (reader ? await fs.readFile(path.resolve(cwd, gitDir, ...ref.split('/')), 'utf8').then((value) => value.trim(), (cause) => {
    if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return null; throw cause;
  }) : null);
  const refs = looseRef && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(looseRef) ? looseRef
    : (await run(['for-each-ref', '--format=%(objectname)', ref])).toString().trim();
  let tree = refs || null;
  const oidLength = tree?.length ?? ((await run(['rev-parse', '--show-object-format'])).toString().trim() === 'sha256' ? 64 : 40);
  const pending = new Map();
  let staging = false;
  // One failed direct receipt must not leave staged rows in its shared commit.
  const stage = async (action) => {
    if (staging) throw changeError('invalid_change_record');
    const saved = new Map(pending); staging = true;
    try { return await action(); }
    catch (error) { pending.clear(); for (const [key, value] of saved) pending.set(key, value); throw error; }
    finally { staging = false; }
  };
  // Serialized values read from the current tree in this store. Rewriting one
  // unchanged (or removing a key read as absent) stages nothing, so a
  // read-mostly transaction does not create a Git commit.
  const baseline = new Map();
  const parseRow = (row) => {
    const tab = row.indexOf('\t'), fields = row.slice(0, tab).trim().split(/\s+/);
    return { key: row.slice(tab + 1), oid: fields[2], size: Number(fields[3]) };
  };
  const indexed = async (snapshot) => {
    // Once this store's full listing exceeded the bound, listing each new tree
    // only to discard it costs O(ledger) per transaction. Stay on the paged
    // path (always correct) for the rest of this process.
    if (oversizedStores.has(gitDir)) return null;
    const identity = `${gitDir}:${snapshot}`;
    if (!listings.has(identity)) {
      const work = (async () => {
        const rows = []; let bytes = 0;
        for await (const row of runTokens(cwd, [...args, 'ls-tree', '-r', '-l', '-z', snapshot])) {
          bytes += Buffer.byteLength(row);
          if (bytes > listingLimitBytes) { oversizedStores.add(gitDir); return null; } // Larger ledgers stay paged from Git.
          rows.push(parseRow(row));
        }
        return rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      })();
      listings.set(identity, work);
      while (listings.size > 2) listings.delete(listings.keys().next().value);
      void work.catch(() => { if (listings.get(identity) === work) listings.delete(identity); });
    }
    return listings.get(identity);
  };
  // Row values by object id: the persistent reader when available, else
  // bounded `cat-file --batch` processes.
  const values = async function* (rows) {
    if (!reader) { yield* runRecords(cwd, args, rows); return; }
    let batch = [];
    const flush = async () => {
      const found = await Promise.all(batch.map((row) => readObject(row.oid)));
      const result = batch.map((row, index) => {
        if (found[index]?.type !== 'blob') throw changeError('invalid_change_record', 503);
        return { key: row.key, oid: row.oid, value: JSON.parse(found[index].data.toString()) };
      });
      batch = [];
      return result;
    };
    for await (const row of rows) {
      if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > 512 * 1024) throw changeError('invalid_change_record', 503);
      batch.push(row);
      if (batch.length >= 256) yield* await flush();
    }
    if (batch.length) yield* await flush();
  };
  const treeRows = async function* (snapshot, prefix) {
    const rows = await indexed(snapshot), start = `${prefix}/`;
    if (rows) {
      for (let at = lowerBound(rows, start); at < rows.length && rows[at].key.startsWith(start); at++) yield rows[at];
      return;
    }
    for await (const row of runTokens(cwd, [...args, '--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', snapshot, '--', start])) {
      yield parseRow(row);
    }
  };
  const get = async (key) => {
    if (!validKey(key)) throw changeError('invalid_change_record');
    if (pending.has(key) && typeof pending.get(key) !== 'object') return JSON.parse(pending.get(key));
    if (pending.has(key) && pending.get(key) === null) return null;
    const fromTree = !pending.has(key);
    const observed = (value) => { if (fromTree) baseline.set(key, value); return value === null ? null : JSON.parse(value); };
    if (!tree) return observed(null);
    if (reader) {
      const object = pending.get(key)?.oid ?? `${tree}:${key}`, named = `${gitDir}:${object}`;
      if (blobs.has(named)) return observed(blobs.get(named));
      const found = await readObject(object);
      if (!found) return observed(null);
      if (found.type !== 'blob') throw changeError('invalid_change_record');
      const value = found.data.toString();
      remember(named, value); remember(`${gitDir}:${found.oid}`, value); return observed(value);
    }
    const rows = pending.has(key) ? null : await indexed(tree);
    const row = rows?.[lowerBound(rows, key)];
    if (rows && row?.key !== key) return observed(null);
    const object = pending.get(key)?.oid ?? row?.oid ?? `${tree}:${key}`;
    const cacheKey = `${gitDir}:${object}`;
    if (blobs.has(cacheKey)) return observed(blobs.get(cacheKey));
    const data = await run(['cat-file', '--batch'], { input: `${object}\n` });
    const end = data.indexOf(10), header = data.subarray(0, end).toString().split(' ');
    if (header.at(-1) === 'missing') return observed(null);
    if (header[1] !== 'blob' || Number(header[2]) !== data.length - end - 2) throw changeError('invalid_change_record');
    const value = data.subarray(end + 1, data.length - 1).toString();
    remember(cacheKey, value); return observed(value);
  };
  const set = (key, value) => {
    if (!validKey(key)) throw changeError('invalid_change_record');
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 512 * 1024) throw changeError('change_record_too_large', 503);
    if (!pending.has(key) && baseline.has(key) && baseline.get(key) === data) return;
    pending.set(key, data);
  };
  const remove = (key) => {
    if (!validKey(key)) throw changeError('invalid_change_record');
    if (!pending.has(key) && baseline.has(key) && baseline.get(key) === null) return;
    pending.set(key, null);
  };
  const entries = async function* (prefix) {
    if (tree) {
      const rows = async function* () {
        for await (const row of treeRows(tree, prefix)) {
          if (pending.has(row.key)) continue;
          yield row;
        }
      };
      for await (const row of values(rows())) {
        remember(`${gitDir}:${row.oid}`, JSON.stringify(row.value));
        yield row;
      }
    }
    // Pending entries are normally a handful of mutated entities. Disk entries
    // stay streamed; do not collect all historical keys just to merge writes.
    for (const [key, data] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(`${prefix}/`) && data !== null) yield { key, value: typeof data === 'object' ? await get(key) : JSON.parse(data) };
    }
  };
  // Whole snapshot without a capped stdout buffer: the listing is drained first
  // (rows only, so `ls-tree` never outlives its timeout behind a slow consumer)
  // and values arrive in bounded cat-file batches. Ignores `pending` so a caller
  // may set() while iterating. Rows read from the current tree seed the baseline.
  // `include(key)`: rows to read; the rest are listed but neither read nor parsed.
  const records = async function* (snapshot = tree, { include } = {}) {
    if (!snapshot) return;
    const rows = [];
    for await (const row of runTokens(cwd, [...args, 'ls-tree', '-r', '-l', '-z', snapshot])) {
      const parsed = parseRow(row);
      if (!include || include(parsed.key)) rows.push(parsed);
    }
    for await (const row of values(rows)) {
      const data = JSON.stringify(row.value);
      remember(`${gitDir}:${row.oid}`, data);
      if (snapshot === tree && !pending.has(row.key)) baseline.set(row.key, data);
      yield row;
    }
  };
  const list = async function* (prefix) {
    for await (const { value } of entries(prefix)) {
      if (!Array.isArray(value)) throw changeError('invalid_change_record');
      yield* value;
    }
  };
  // List pages: at most 128 values and 256 KiB of JSON each.
  const pagesOf = async function* (values) {
    let page = [], bytes = 0;
    for await (const value of values) {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (page.length && (page.length >= 128 || bytes + size > 256 * 1024)) { yield page; page = []; bytes = 0; }
      page.push(value); bytes += size;
    }
    if (page.length) yield page;
  };
  // `absent`: the caller knows the prefix is new (a just-generated id), so
  // there is nothing to replace and no listing to read. `firstPage` leaves the
  // lower page names to the caller (a format page that must list first).
  const setList = async (prefix, values, { absent = false, firstPage = 0 } = {}) => {
    if (!absent) for await (const { key } of entries(prefix)) remove(key);
    let index = firstPage;
    for await (const page of pagesOf(values)) set(`${prefix}/${String(index++).padStart(10, '0')}.json`, page);
  };
  // setList in two steps: `writeList` writes the pages as objects ahead of a
  // transaction (outside any ledger lock) and returns their ids, and
  // `setListObjects` stages them under `prefix`, so the commit only records
  // them. Objects never staged are pruned after the grace like any other.
  const writeList = async (values) => {
    const objectsDir = path.resolve(cwd, gitDir), oids = [];
    for await (const page of pagesOf(values)) {
      const data = JSON.stringify(page);
      if (Buffer.byteLength(data) > 512 * 1024) throw changeError('change_record_too_large', 503);
      oids.push(await writeLooseObject(objectsDir, 'blob', Buffer.from(data), oidLength));
    }
    return oids;
  };
  const setListObjects = (prefix, oids, { firstPage = 0 } = {}) => {
    if (!validKey(`${prefix}/page.json`) || !oids.every((oid) => typeof oid === 'string' && oid.length === oidLength && /^[a-f0-9]+$/.test(oid))) {
      throw changeError('invalid_change_record');
    }
    for (const [index, oid] of oids.entries()) pending.set(`${prefix}/${String(firstPage + index).padStart(10, '0')}.json`, { oid });
  };
  // Moves the ref from `tree` to `next` (compare-and-swap) and records the
  // transaction; a guard revoked meanwhile undoes the move.
  const publish = async (next, assertCurrent) => {
    await assertCurrent?.();
    await run(['update-ref', ref, next, tree ?? '0'.repeat(oidLength)]);
    try { await assertCurrent?.(); }
    catch (cause) {
      // The caller still holds the ledger lock. Undo this CAS before a
      // revoked scope can expose its staged negative admission proof.
      try { await run(tree ? ['update-ref', ref, tree, next] : ['update-ref', '-d', ref, next]); }
      catch (rollback) { throw Object.assign(new AggregateError([cause, rollback], 'Guarded ledger commit rollback failed'),
        { code: 'ledger_guard_rollback_failed', committed: true, rollbackFailed: true }); }
      throw cause;
    }
    settle(next);
  };
  // The new tree differs from the old only by these values: rewriting one
  // unchanged after this commit stages nothing.
  const settle = (next) => {
    tree = next;
    for (const [key, data] of pending) {
      if (typeof data !== 'object' || data === null) baseline.set(key, data); else baseline.delete(key);
    }
    pending.clear();
  };
  // Direct tree commits (session-changes-trees.js) need the persistent object
  // reader. Kill switch, read per use: DEVRYAN_LEDGER_DIRECT_TREES=0 commits
  // through Git's index as before.
  const directTrees = () => reader !== null && process.env.DEVRYAN_LEDGER_DIRECT_TREES !== '0';
  const commitDirect = async (assertCurrent) => {
    // The kept index no longer describes the ref once it moves without it:
    // drop its record first, so an index commit later rebuilds it.
    if (persistentIndex && ref === STATE_REF) await fs.rm(path.join(path.dirname(gitDir), 'state.metadata-index.tree'), { force: true });
    const objectsDir = path.resolve(cwd, gitDir);
    const next = await commitTreeChanges({ tree, changes: pending, oidLength,
      readTree: async (oid) => {
        const found = await readObject(oid);
        if (found?.type !== 'tree') throw changeError('invalid_change_record', 503);
        return found.data;
      },
      writeObject: (type, content) => writeLooseObject(objectsDir, type, content, oidLength) });
    if (next === tree) { settle(next); return; }
    await publish(next, assertCurrent);
  };
  // `assertCurrent` may be asynchronous: a guard owned by the host thread.
  const commit = async ({ assertCurrent } = {}) => {
    await assertCurrent?.();
    if (staging || at) throw changeError('invalid_change_record');
    if (!pending.size) return;
    // Objects this transaction references are durable before it is.
    await syncObjects(cwd);
    if (directTrees()) return commitDirect(assertCurrent);
    // A kept index is valid only for the tree recorded beside it. The record
    // is removed before the index changes and rewritten after the ref moves,
    // so a crash or a refused commit leaves it absent and the next commit
    // rebuilds the index from the published tree.
    const kept = persistentIndex && ref === STATE_REF && process.env.DEVRYAN_LEDGER_PERSISTENT_INDEX !== '0';
    const index = kept ? path.join(path.dirname(gitDir), 'state.metadata-index') : path.join(path.dirname(gitDir), `${crypto.randomUUID()}.metadata-index`);
    const env = { GIT_INDEX_FILE: index }, record = `${index}.tree`;
    try {
      const indexed = kept ? await fs.readFile(record, 'utf8').then((value) => value.trim(), (cause) => {
        if (cause.code === 'ENOENT') return null; throw cause;
      }) : null;
      if (kept) { await fs.rm(record, { force: true }); await fs.rm(`${index}.lock`, { force: true }); }
      if (!kept || indexed !== (tree ?? 'empty')) await run(['read-tree', ...(tree ? [tree] : ['--empty'])], { env });
      const staged = `${index}.blobs`;
      const updates = async function* () {
        let batch = [];
        const flush = async (entries) => {
          await fs.mkdir(staged, { recursive: true, mode: 0o700 });
          const files = entries.map((_, i) => path.join(staged, String(i)));
          for (let start = 0; start < entries.length; start += 16) await Promise.all(entries.slice(start, start + 16)
            .map(([, data], offset) => fs.writeFile(files[start + offset], data, { mode: 0o600 })));
          const oids = (await run(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
            input: files.map((file) => JSON.stringify(file)).join('\n') + '\n',
          })).toString().trim().split('\n');
          return entries.map(([key], i) => `100644 ${oids[i]}\t${key}\0`);
        };
        try {
          for (const [key, data] of pending) {
            if (data === null) yield `0 ${'0'.repeat(oidLength)}\t${key}\0`;
            else if (typeof data === 'object') yield `100644 ${data.oid}\t${key}\0`;
            else { batch.push([key, data]); if (batch.length === 128) { yield* await flush(batch); batch = []; } }
          }
          if (batch.length) yield* await flush(batch);
        } finally { await fs.rm(staged, { recursive: true, force: true }); }
      };
      await run(['update-index', '-z', '--index-info'], { env, input: updates(), timeoutMs: 120_000 });
      const next = (await run(['write-tree'], { env })).toString().trim();
      await publish(next, assertCurrent);
      if (kept) await fs.writeFile(record, next, { mode: 0o600 }).catch(() => {}); // Advisory: absent means rebuild.
    } finally {
      if (!kept) await fs.rm(index, { force: true });
      await fs.rm(`${index}.lock`, { force: true });
    }
  };
  const leaseRef = (token) => {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw changeError('invalid_change_record');
    return `refs/devryan/leases/${token}`;
  };
  const pin = async (token) => {
    await commit();
    await run(['update-ref', leaseRef(token), tree, '0'.repeat(oidLength)]);
    return leaseRef(token);
  };
  const release = (token) => run(['update-ref', '-d', leaseRef(token)]);
  const importPrefix = async (source, prefix, destination = prefix) => {
    if (!/^[a-f0-9]{40,64}$/.test(source ?? '') || !validKey(`${prefix}/page.json`) || !validKey(`${destination}/page.json`)) {
      throw changeError('invalid_change_record');
    }
    for await (const row of treeRows(source, prefix)) {
      pending.set(destination + row.key.slice(prefix.length), { oid: row.oid });
    }
  };
  // Identity of `prefix` in the committed tree, whatever is staged.
  const committedIdentity = async (prefix) => {
    if (!validKey(`${prefix}/page.json`)) throw changeError('invalid_change_record');
    if (!tree) return null;
    if (reader) { const found = await readObject(`${tree}:${prefix}`, { check: true }); return found?.type === 'tree' ? found.oid : null; }
    return run(['rev-parse', '--verify', `${tree}:${prefix}`]).then((value) => value.toString().trim(), () => null);
  };
  const prefixIdentity = async (prefix) => {
    if (pending.size) throw changeError('invalid_change_record');
    return committedIdentity(prefix);
  };
  // Staged writes under `prefix` by key, in `entries` order; null is a removal.
  const staged = async (prefix) => {
    if (!validKey(`${prefix}/page.json`)) throw changeError('invalid_change_record');
    const result = new Map();
    for (const [key, data] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(`${prefix}/`)) result.set(key, data === null ? null : typeof data === 'object' ? await get(key) : JSON.parse(data));
    }
    return result;
  };
  // prefixIdentity for many prefixes: one listing per 128 (command lines stay
  // short on Windows). Absent prefixes map to null.
  const prefixIdentities = async (prefixes) => {
    if (pending.size || prefixes.some((prefix) => !validKey(`${prefix}/page.json`))) throw changeError('invalid_change_record');
    const result = new Map(prefixes.map((prefix) => [prefix, null]));
    if (!tree) return result;
    if (reader) {
      for (let start = 0; start < prefixes.length; start += 256) {
        const slice = prefixes.slice(start, start + 256);
        const found = await Promise.all(slice.map((prefix) => readObject(`${tree}:${prefix}`, { check: true })));
        slice.forEach((prefix, index) => { if (found[index]?.type === 'tree') result.set(prefix, found[index].oid); });
      }
      return result;
    }
    for (let start = 0; start < prefixes.length; start += 128) {
      for await (const row of runTokens(cwd, [...args, '--literal-pathspecs', 'ls-tree', '-z', tree, '--', ...prefixes.slice(start, start + 128)])) {
        const tab = row.indexOf('\t'), fields = row.slice(0, tab).trim().split(/\s+/), prefix = row.slice(tab + 1);
        if (fields[1] === 'tree' && result.has(prefix)) result.set(prefix, fields[2]);
      }
    }
    return result;
  };
  // Committed rows under `prefix` without their values (key, object id and
  // size, in listing order), and the values of chosen rows. A reader that
  // kept values by object id reads only rows whose object changed.
  const committedRows = async function* (prefix) { if (tree) yield* treeRows(tree, prefix); };
  const readRows = (rows) => values(rows);
  return { get, set, remove, entries, records, list, setList, writeList, setListObjects, commit, committedRows, readRows, stage, leaseRef, pin, release, importPrefix, prefixIdentity, prefixIdentities, committedIdentity, staged,
    get tree() { return tree; }, get exists() { return tree !== null; }, get pendingCount() { return pending.size; } };
}
