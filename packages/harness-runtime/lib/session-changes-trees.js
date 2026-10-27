import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { changeError } from './session-changes-git.js';

// Direct tree commits for the private ledger repositories. A ledger ref names
// a tree, and a transaction changes a handful of keys, but committing through
// Git's index costs four processes and reads and rewrites the whole index
// (8 MB, 49k entries on a 13k-file project): about 115 ms per commit, seven
// commits per confined edit, all under the owner lock. Rebuilding only the
// trees on the changed paths gives the identical tree Git would write.
//
// Objects are written loose, exactly as `hash-object -w` and `write-tree`
// do with Git's default fsync policy (loose objects are not synced): the
// write is complete before the ref names it, and a crash leaves at most an
// unreferenced object. As Git's writer does, an existing object is freshened
// so a concurrent prune keeps it, and a fan-out directory that packing removed
// meanwhile is created again. The caller still moves the ref with `update-ref`.
const deflate = promisify(zlib.deflate);
const BLOB_MODE = '100644', TREE_MODE = '40000';

export function parseTree(data, oidLength) {
  const width = oidLength / 2, entries = [];
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at), nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + width > data.length) throw changeError('invalid_change_record', 503);
    entries.push({ mode: data.toString('latin1', at, space), name: data.toString('latin1', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 1 + width) });
    at = nul + 1 + width;
  }
  return entries;
}

// Git orders tree entries bytewise, comparing a subtree's name as if it ended in '/'.
const sortName = (entry) => entry.mode === TREE_MODE ? `${entry.name}/` : entry.name;
export function serializeTree(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(sortName(a), 'latin1'), Buffer.from(sortName(b), 'latin1')));
  return Buffer.concat(sorted.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`, 'latin1'), Buffer.from(entry.oid, 'hex')]));
}

export function objectID(type, content, oidLength) {
  return crypto.createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`${type} ${content.length}\0`).update(content).digest('hex');
}

// Writes one loose object unless it already exists; returns its id.
export async function writeLooseObject(gitDir, type, content, oidLength) {
  const oid = objectID(type, content, oidLength);
  const directory = path.join(gitDir, 'objects', oid.slice(0, 2)), target = path.join(directory, oid.slice(2));
  // An existing loose object may be unreachable and old: freshen it, as Git
  // does, so a concurrent prune (which spares recent objects) keeps it until
  // the ref names it. A failure means it is gone and is written again.
  const now = new Date();
  if (await fs.utimes(target, now, now).then(() => true, () => false)) return oid;
  const bytes = await deflate(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]));
  // Ledger packing removes empty fan-out directories, possibly between this
  // mkdir and the write: create it again and retry, as Git's own writer does.
  // macOS reports a create inside a directory removed mid-call as EINVAL, so
  // that code is retried only when the directory was removed or replaced.
  for (let attempt = 1; ; attempt += 1) {
    await fs.mkdir(directory, { recursive: true });
    const created = await fs.stat(directory).catch(() => null);
    const temporary = path.join(directory, `tmp_obj_${crypto.randomUUID()}`);
    try {
      await fs.writeFile(temporary, bytes, { mode: 0o444, flag: 'wx' });
      // A link never replaces an object another writer installed first.
      await fs.link(temporary, target).catch((cause) => { if (cause.code !== 'EEXIST') throw cause; });
      return oid;
    } catch (cause) {
      const current = cause.code === 'EINVAL' ? await fs.stat(directory).catch(() => null) : null;
      const removed = cause.code === 'ENOENT' || cause.code === 'EINVAL' && (!created || !current || current.ino !== created.ino || current.dev !== created.dev);
      if (!removed || attempt >= 5) throw cause;
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

// `changes`: key → serialized JSON (a new blob), `{ oid }` (an existing blob)
// or null (removal), for keys of the form `a/b/c.json`. Returns the new root
// tree's id; an empty result is Git's empty tree.
export async function commitTreeChanges({ tree, changes, oidLength, readTree, writeObject }) {
  const root = new Map();
  for (const [key, value] of changes) {
    const parts = key.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.get(part);
      if (child === undefined) { child = new Map(); node.set(part, child); }
      if (!(child instanceof Map)) throw changeError('invalid_change_record');
      node = child;
    }
    const name = parts.at(-1);
    if (node.get(name) instanceof Map) throw changeError('invalid_change_record');
    node.set(name, { value });
  }
  const blobs = new Map();
  for (const value of changes.values()) {
    if (typeof value === 'string' && !blobs.has(value)) {
      const writing = writeObject('blob', Buffer.from(value));
      // Tree reads may finish later; observe early rejection but await the
      // original promise below so a failed write still refuses the commit.
      void writing.catch(() => {});
      blobs.set(value, writing);
    }
  }
  const rewrite = async (oid, node, isRoot = false) => {
    const entries = new Map();
    if (oid) for (const entry of parseTree(await readTree(oid), oidLength)) entries.set(entry.name, entry);
    await Promise.all([...node].map(async ([name, change]) => {
      const existing = entries.get(name);
      if (change instanceof Map) {
        if (existing && existing.mode !== TREE_MODE) throw changeError('invalid_change_record');
        const child = await rewrite(existing?.oid ?? null, change);
        if (child) entries.set(name, { mode: TREE_MODE, name, oid: child }); else entries.delete(name);
        return;
      }
      if (existing?.mode === TREE_MODE) throw changeError('invalid_change_record');
      const { value } = change;
      if (value === null) entries.delete(name);
      else entries.set(name, { mode: BLOB_MODE, name, oid: typeof value === 'string' ? await blobs.get(value) : value.oid });
    }));
    // Git stores no empty trees below the root.
    if (!entries.size && !isRoot) return null;
    return writeObject('tree', serializeTree([...entries.values()]));
  };
  return rewrite(tree, root, true);
}
