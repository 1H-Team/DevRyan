import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitRecords, gitTokens, changeError } from './session-changes-git.js';

export const changeKey = (value) => crypto.createHash('sha256').update(value).digest('hex');
const STATE_REF = 'refs/devryan/state';
const blobs = new Map();
let blobBytes = 0;
const listings = new Map();
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
export async function openChangeStore(cwd, gitDir, { ref = STATE_REF } = {}) {
  if (ref !== STATE_REF && !/^refs\/devryan\/leases\/[a-f0-9-]{36}$/.test(ref)) throw changeError('invalid_change_record');
  const args = ['--git-dir', gitDir];
  const run = (command, extra) => git(cwd, [...args, ...command], extra);
  const refs = (await run(['for-each-ref', '--format=%(objectname)', ref])).toString().trim();
  let tree = refs || null;
  const oidLength = tree?.length ?? ((await run(['rev-parse', '--show-object-format'])).toString().trim() === 'sha256' ? 64 : 40);
  const pending = new Map();
  const indexed = async (snapshot) => {
    const identity = `${gitDir}:${snapshot}`;
    if (!listings.has(identity)) {
      const work = (async () => {
        const rows = []; let bytes = 0;
        for await (const row of gitTokens(cwd, [...args, 'ls-tree', '-r', '-l', '-z', snapshot])) {
          bytes += Buffer.byteLength(row);
          if (bytes > 8 * 1024 * 1024) return null; // Larger ledgers stay paged from Git.
          const tab = row.indexOf('\t'), fields = row.slice(0, tab).trim().split(/\s+/);
          rows.push({ key: row.slice(tab + 1), oid: fields[2], size: Number(fields[3]) });
        }
        return rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      })();
      listings.set(identity, work);
      while (listings.size > 2) listings.delete(listings.keys().next().value);
      void work.catch(() => { if (listings.get(identity) === work) listings.delete(identity); });
    }
    return listings.get(identity);
  };
  const treeRows = async function* (snapshot, prefix) {
    const rows = await indexed(snapshot), start = `${prefix}/`;
    if (rows) {
      for (let at = lowerBound(rows, start); at < rows.length && rows[at].key.startsWith(start); at++) yield rows[at];
      return;
    }
    for await (const row of gitTokens(cwd, [...args, '--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', snapshot, '--', start])) {
      const tab = row.indexOf('\t'), fields = row.slice(0, tab).trim().split(/\s+/);
      yield { key: row.slice(tab + 1), oid: fields[2], size: Number(fields[3]) };
    }
  };
  const get = async (key) => {
    if (!validKey(key)) throw changeError('invalid_change_record');
    if (pending.has(key) && typeof pending.get(key) !== 'object') return JSON.parse(pending.get(key));
    if (pending.has(key) && pending.get(key) === null) return null;
    if (!tree) return null;
    const rows = pending.has(key) ? null : await indexed(tree);
    const row = rows?.[lowerBound(rows, key)];
    if (rows && row?.key !== key) return null;
    const object = pending.get(key)?.oid ?? row?.oid ?? `${tree}:${key}`;
    const cacheKey = `${gitDir}:${object}`;
    if (blobs.has(cacheKey)) return JSON.parse(blobs.get(cacheKey));
    const data = await run(['cat-file', '--batch'], { input: `${object}\n` });
    const end = data.indexOf(10), header = data.subarray(0, end).toString().split(' ');
    if (header.at(-1) === 'missing') return null;
    if (header[1] !== 'blob' || Number(header[2]) !== data.length - end - 2) throw changeError('invalid_change_record');
    const value = data.subarray(end + 1, data.length - 1).toString();
    remember(cacheKey, value); return JSON.parse(value);
  };
  const set = (key, value) => {
    if (!validKey(key)) throw changeError('invalid_change_record');
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 512 * 1024) throw changeError('change_record_too_large', 503);
    pending.set(key, data);
  };
  const remove = (key) => { if (!validKey(key)) throw changeError('invalid_change_record'); pending.set(key, null); };
  const entries = async function* (prefix) {
    if (tree) {
      const rows = async function* () {
        for await (const row of treeRows(tree, prefix)) {
          if (pending.has(row.key)) continue;
          yield row;
        }
      };
      for await (const row of gitRecords(cwd, args, rows())) {
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
  const list = async function* (prefix) {
    for await (const { value } of entries(prefix)) {
      if (!Array.isArray(value)) throw changeError('invalid_change_record');
      yield* value;
    }
  };
  const setList = async (prefix, values) => {
    for await (const { key } of entries(prefix)) remove(key);
    let page = [], bytes = 0, index = 0;
    const flush = () => { if (page.length) set(`${prefix}/${String(index++).padStart(10, '0')}.json`, page); page = []; bytes = 0; };
    for await (const value of values) {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (page.length >= 128 || bytes + size > 256 * 1024) flush();
      page.push(value); bytes += size;
    }
    flush();
  };
  const commit = async () => {
    if (!pending.size) return;
    const index = path.join(path.dirname(gitDir), `${crypto.randomUUID()}.metadata-index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await run(['read-tree', ...(tree ? [tree] : ['--empty'])], { env });
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
      await run(['update-ref', ref, next, tree ?? '0'.repeat(oidLength)]);
      tree = next;
      pending.clear();
    } finally {
      await fs.rm(index, { force: true });
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
  const prefixIdentity = async (prefix) => {
    if (pending.size || !validKey(`${prefix}/page.json`)) throw changeError('invalid_change_record');
    if (!tree) return null;
    return run(['rev-parse', '--verify', `${tree}:${prefix}`]).then((value) => value.toString().trim(), () => null);
  };
  return { get, set, remove, entries, list, setList, commit, leaseRef, pin, release, importPrefix, prefixIdentity,
    get tree() { return tree; }, get exists() { return tree !== null; } };
}
