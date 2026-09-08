import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitTokens, changeError } from './session-changes-git.js';
import { writeFileAtomic } from './atomic-file.js';
import { changeKey } from './session-changes-store.js';

export const safeChangePath = (value) => typeof value === 'string' && value && !path.isAbsolute(value)
  && !value.split(/[\\/]/).some((part) => part === '..' || part === '.git');
export const equalEntry = (a, b) => a?.oid === b?.oid && a?.mode === b?.mode;
const signature = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

export async function verifyAncestors(directory, file) {
  if (!safeChangePath(file)) throw changeError('unsupported_path');
  let parent = path.dirname(path.join(directory, file));
  while (parent !== directory) {
    const stat = await fs.lstat(parent).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw changeError('unsupported_path');
    parent = path.dirname(parent);
  }
}

export async function withChangeIndex(repo, fn) {
  const index = path.join(path.dirname(repo.gitDir), `${crypto.randomUUID()}.index`);
  try { return await fn({ GIT_INDEX_FILE: index, GIT_WORK_TREE: repo.directory }); }
  finally { await fs.rm(index, { force: true }); await fs.rm(`${index}.lock`, { force: true }); }
}

export const retainTree = async (repo, tree) => {
  await repo.run(['update-ref', `refs/devryan/trees/${tree}`, tree]);
  return tree;
};

export const makeChangeTree = (repo, files, { deadline } = {}) => withChangeIndex(repo, async (env) => {
  await repo.run(['read-tree', '--empty'], { env });
  const input = async function* () {
    for await (const [file, entry] of files) {
      if (!safeChangePath(file)) throw changeError('unsupported_path');
      if (entry) yield `${entry.mode} ${entry.oid}\t${file}\0`;
    }
  };
  await repo.run(['update-index', '-z', '--index-info'], { env, input: input(), timeoutMs: deadline === undefined ? 120_000 : Math.max(1, deadline - Date.now()) });
  return retainTree(repo, (await repo.run(['write-tree'], { env })).toString().trim());
});

export async function* changeTreeEntries(repo, tree) {
  for await (const row of gitTokens(repo.storage, ['--git-dir', repo.gitDir, 'ls-tree', '-r', '-z', tree])) {
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    if (type !== 'blob') throw changeError('unsupported_file_type');
    yield [row.slice(tab + 1), { mode, oid }];
  }
}

export async function* changedEntries(repo, before, after, paths = null) {
  if (before === after) return;
  const allowed = paths ? new Set(paths) : null;
  const tokens = gitTokens(repo.storage, ['--git-dir', repo.gitDir, 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', before, after]);
  const iterator = tokens[Symbol.asyncIterator]();
  try {
    for (;;) {
      const header = await iterator.next();
      if (header.done) break;
      const name = await iterator.next();
      if (name.done) throw changeError('invalid_change_record');
      const [beforeMode, afterMode, beforeOID, afterOID] = header.value.slice(1).split(' ');
      if (allowed && !allowed.has(name.value)) continue;
      yield { file: name.value,
        before: beforeMode === '000000' ? null : { mode: beforeMode, oid: beforeOID },
        after: afterMode === '000000' ? null : { mode: afterMode, oid: afterOID } };
    }
  } finally { await iterator.return?.(); }
}

// Cache is optional and independently bounded. Git objects remain authoritative;
// GC removes the cache before pruning, so it cannot hand out collected OIDs.
const statCache = (repo) => {
  const directory = path.join(path.dirname(repo.gitDir), 'stat-cache');
  const pages = new Map();
  const flushPage = async (key, page) => {
    if (page.dirty) {
      const data = JSON.stringify(page.files);
      if (Buffer.byteLength(data) <= 64 * 1024) await writeFileAtomic(path.join(directory, `${key}.json`), data);
      else await fs.rm(path.join(directory, `${key}.json`), { force: true });
    }
  };
  const pageFor = async (file) => {
    const key = changeKey(file).slice(0, 2);
    let page = pages.get(key);
    if (!page) {
      if (pages.size >= 256) {
        const [oldKey, oldPage] = pages.entries().next().value;
        await flushPage(oldKey, oldPage); pages.delete(oldKey);
      }
      let files = Object.create(null), bytes = 0;
      try {
        const filePath = path.join(directory, `${key}.json`);
        if ((await fs.stat(filePath)).size <= 64 * 1024) {
          const data = await fs.readFile(filePath, 'utf8'), parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            files = Object.assign(Object.create(null), parsed); bytes = Buffer.byteLength(data);
          }
        }
      } catch { /* A missing/damaged cache only causes rehashing. */ }
      page = { files, bytes, dirty: false };
    }
    pages.delete(key); pages.set(key, page);
    return page;
  };
  return {
    async get(file, stat) {
      const entry = (await pageFor(file)).files[file];
      return entry?.signature === signature(stat) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid) ? entry.oid : null;
    },
    async put(file, stat, oid) {
      const page = await pageFor(file);
      const entry = { signature: signature(stat), oid };
      if (page.files[file]?.signature === entry.signature && page.files[file]?.oid === oid) return;
      const size = Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(file) + 8;
      if (page.bytes + size > 64 * 1024) { page.files = Object.create(null); page.bytes = 0; }
      page.files[file] = entry; page.bytes += size; page.dirty = true;
    },
    async flush() { for (const [key, page] of pages) await flushPage(key, page); },
  };
};

export async function captureSnapshot(repo, { paths = null, maxCaptureBytes = Infinity, deadline = Date.now() + 30_000 } = {}) {
  if (Date.now() >= deadline) throw changeError('capture_timeout');
  const cache = statCache(repo);
  const candidates = gitTokens(repo.directory, ['--literal-pathspecs', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate',
    ...(paths ? ['--', ...paths] : [])],
    { timeoutMs: Math.max(1, deadline - Date.now()) });
  let bytes = 0;
  const entries = async function* () {
    let batch = [];
    const capture = async (files) => {
      if (Date.now() >= deadline) throw changeError('capture_timeout');
      const states = await Promise.all(files.map(async (file) => {
        await verifyAncestors(repo.directory, file);
        const stat = await fs.lstat(path.join(repo.directory, file), { bigint: true }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return null;
        if (!stat.isFile() && !stat.isSymbolicLink()) throw changeError('unsupported_file_type');
        return { file, stat };
      }));
      const observed = [];
      for (const entry of states) {
        if (!entry) continue;
        bytes += Number(entry.stat.size);
        if (bytes > maxCaptureBytes) throw changeError('capture_limit'); // Explicit operator/test policy only.
        entry.oid = await cache.get(entry.file, entry.stat);
        observed.push(entry);
      }
      const regular = observed.filter((entry) => entry.stat.isFile() && !entry.oid);
      const hashes = regular.length ? (await repo.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
        input: regular.map((entry) => JSON.stringify(path.join(repo.directory, entry.file))).join('\n') + '\n',
        timeoutMs: Math.max(1, deadline - Date.now()),
      })).toString().trim().split('\n') : [];
      regular.forEach((entry, index) => { entry.oid = hashes[index]; });
      const result = [];
      for (const entry of observed) {
        if (!entry.oid) entry.oid = (await repo.run(['hash-object', '-w', '--no-filters', '--stdin'], { input: await fs.readlink(path.join(repo.directory, entry.file)) })).toString().trim();
        const current = await fs.lstat(path.join(repo.directory, entry.file), { bigint: true });
        if (signature(current) !== signature(entry.stat)) throw changeError('capture_changed_during_read');
        await cache.put(entry.file, entry.stat, entry.oid);
        result.push([entry.file, { oid: entry.oid, mode: entry.stat.isSymbolicLink() ? '120000' : entry.stat.mode & 0o111n ? '100755' : '100644' }]);
      }
      return result;
    };
    for await (const file of candidates) {
      batch.push(file);
      if (batch.length === 128) { yield* await capture(batch); batch = []; }
    }
    if (batch.length) yield* await capture(batch);
  };
  const tree = await makeChangeTree(repo, entries(), { deadline });
  await cache.flush();
  if (Date.now() >= deadline) throw changeError('capture_timeout');
  return tree;
}
