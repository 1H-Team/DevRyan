import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitRecords, gitTokens, changeError } from './session-changes-git.js';

export const changeKey = (value) => crypto.createHash('sha256').update(value).digest('hex');
const STATE_REF = 'refs/devryan/state';
const validKey = (key) => typeof key === 'string' && /^[a-zA-Z0-9/_-]+\.json$/.test(key)
  && !key.split('/').some((part) => !part || part === '..');

// Git's tree is the on-disk index: one small blob per entity, fixed-size pages
// for lists, and one atomic ref update for the entire transaction. Old readers
// retain their tree identity. No lifetime-sized JSON document is rewritten.
export async function openChangeStore(cwd, gitDir) {
  const args = ['--git-dir', gitDir];
  const run = (command, extra) => git(cwd, [...args, ...command], extra);
  const refs = (await run(['for-each-ref', '--format=%(objectname)', STATE_REF])).toString().trim();
  let tree = refs || null;
  const oidLength = tree?.length ?? ((await run(['rev-parse', '--show-object-format'])).toString().trim() === 'sha256' ? 64 : 40);
  const pending = new Map();
  const get = async (key) => {
    if (!validKey(key)) throw changeError('invalid_change_record');
    if (pending.has(key)) return pending.get(key) === null ? null : JSON.parse(pending.get(key));
    if (!tree) return null;
    const data = await run(['cat-file', '--batch'], { input: `${tree}:${key}\n` });
    const end = data.indexOf(10), header = data.subarray(0, end).toString().split(' ');
    if (header.at(-1) === 'missing') return null;
    if (header[1] !== 'blob' || Number(header[2]) !== data.length - end - 2) throw changeError('invalid_change_record');
    return JSON.parse(data.subarray(end + 1, data.length - 1).toString());
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
        for await (const row of gitTokens(cwd, [...args, '--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', tree, '--', `${prefix}/`])) {
          const tab = row.indexOf('\t');
          const key = row.slice(tab + 1);
          if (pending.has(key)) continue;
          const fields = row.slice(0, tab).trim().split(/\s+/);
          yield { key, oid: fields[2], size: Number(fields[3]) };
        }
      };
      yield* gitRecords(cwd, args, rows());
    }
    // Pending entries are normally a handful of mutated entities. Disk entries
    // stay streamed; do not collect all historical keys just to merge writes.
    for (const [key, data] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(`${prefix}/`) && data !== null) yield { key, value: JSON.parse(data) };
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
            else { batch.push([key, data]); if (batch.length === 128) { yield* await flush(batch); batch = []; } }
          }
          if (batch.length) yield* await flush(batch);
        } finally { await fs.rm(staged, { recursive: true, force: true }); }
      };
      await run(['update-index', '-z', '--index-info'], { env, input: updates(), timeoutMs: 120_000 });
      const next = (await run(['write-tree'], { env })).toString().trim();
      await run(['update-ref', STATE_REF, next, tree ?? '0'.repeat(oidLength)]);
      tree = next;
      pending.clear();
    } finally {
      await fs.rm(index, { force: true });
      await fs.rm(`${index}.lock`, { force: true });
    }
  };
  return { get, set, remove, entries, list, setList, commit, get exists() { return tree !== null; } };
}
