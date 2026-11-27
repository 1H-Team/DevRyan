#!/usr/bin/env node
// Writes trees.tsv and commits.tsv: Git trees and direct tree commits as
// packages/harness-runtime/lib/session-changes-trees.js builds them, so
// `cargo test` (tests/trees.rs) checks ledger_core::tree. Command line:
// vector-tools.mjs; `--no-git` skips the oracle (the contract test uses it).
//
// trees.tsv
//   tree    <width> <seed> <entries> <fnv64 of the entries> <Git's order> <id>
//           A seeded tree (tests/support/mod.rs `tree_entries` draws the same
//           entries, in the shuffled order the JavaScript is given): names
//           that are prefixes of each other, a subtree beside files that
//           differ from it only where its implied `/` sorts (`-` `.` `0`),
//           the bytes around `/`, long names, non-ASCII bytes, the five
//           modes. When writing, `git mktree --missing` (git is the oracle)
//           builds every tree and `git cat-file` reads it back; the
//           generator refuses unless serializeTree gives Git's bytes and
//           objectID gives Git's id. <Git's order> lists the input indices in
//           the order Git stored them.
//   parse   <width> <bytes hex> <entries JSON | throws:<status>>   parseTree on damaged trees,
//           then on trees cut short by 0, 1 and about one id's bytes
//   serialize <entries JSON> <bytes hex>   serializeTree on JavaScript strings no Git
//           tree holds (code units above 0xFF, odd or bad hex ids, `040000`)
//
// commits.tsv
//   commit  <base64 of a JSON case>   commitTreeChanges twice over an
//           in-memory store whose ids are testObjectId (codec-tools.mjs):
//           an initial change set from the empty tree, then a second change
//           set (additions, replacements, removals that empty directories,
//           existing blobs by id, a file replaced by a directory and the
//           reverse, a directory removed as a file). The case records each
//           root (or the error code and status) and the objects written.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitTreeChanges, objectID, parseTree, serializeTree } from '../../../lib/session-changes-trees.js';
import { changeError } from '../../../lib/session-changes-git.js';
import { fnv64, testObjectId } from './codec-tools.mjs';
import { drawer, isMain, random, runGenerator, unitsHex, vectorDocument } from './vector-tools.mjs';

export const TREES_FILE = 'trees.tsv';
export const COMMITS_FILE = 'commits.tsv';
export const TREES_SEED = 20261201;
export const COMMITS_SEED = 20261202;
/** Seeded trees per id width (tracked); damaged and odd-input cases are a fifth of it each. */
export const TREES_TRACKED = 1000;
export const COMMITS_TRACKED = 500;

const STEMS = ['a', 'ab', 'foo', 'foo.c', 'x-y', 'a.b', 'A', '_', 'z'];
const AROUND = [0x2d, 0x2e, 0x30, 0x01, 0x20, 0x2b, 0x5f, 0x7e, 0x7f, 0x80, 0xff];
const SMALL = [0x61, 0x62, 0x2d, 0x2e, 0x30, 0x41, 0x5f];
const MODES = ['40000', '100644', '100755', '120000', '160000'];
const TYPES = { '40000': 'tree', '160000': 'commit' };

/** The seeded entries of one tree, shuffled; tests/support/mod.rs `tree_entries` is the same. */
export function treeEntries(seed, width) {
  const d = drawer(random(seed));
  const count = d.chance(0.05) ? 20 + d.int(40) : 1 + d.int(12);
  const entries = [], seen = new Set();
  for (let attempt = 0; entries.length < count && attempt < count * 4; attempt += 1) {
    const style = d.int(6), name = [];
    if (style === 0) for (let n = 1 + d.int(4); n > 0; n -= 1) name.push(d.pick(SMALL));
    else if (style === 1 || style === 4) {
      name.push(...Buffer.from(d.pick(STEMS)));
      if (style === 4 || d.chance(0.5)) name.push(d.pick(AROUND));
      if (style === 4 && d.chance(0.5)) name.push(...Buffer.from(d.pick(STEMS)));
    } else if (style === 2) for (let n = 1 + d.int(8); n > 0; n -= 1) { const byte = 1 + d.int(254); name.push(byte >= 0x2f ? byte + 1 : byte); }
    else if (style === 3) for (let n = 100 + d.int(156); n > 0; n -= 1) name.push(0x61 + d.int(26));
    else for (let n = 1 + d.int(6); n > 0; n -= 1) name.push(0x80 + d.int(128));
    const roll = d.int(20);
    const mode = MODES[roll < 7 ? 0 : roll < 15 ? 1 : roll < 17 ? 2 : roll < 19 ? 3 : 4];
    const oid = Buffer.from(Array.from({ length: width / 2 }, () => d.int(256))).toString('hex');
    const key = Buffer.from(name).toString('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ mode, name: Buffer.from(name).toString('latin1'), oid });
  }
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const other = d.int(index + 1);
    [entries[index], entries[other]] = [entries[other], entries[index]];
  }
  return entries;
}

/** FNV-1a over `<mode> <name>\0<raw id>` of each entry in order, so the Rust knows it drew the same entries. */
export const entriesFingerprint = (entries) => fnv64(...entries.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, 'latin1'), Buffer.from(entry.oid, 'hex')])));

function git(args, input) {
  const result = spawnSync('git', args, { input, maxBuffer: 1 << 30 });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

/** Git's id and bytes for each tree, through one `mktree --batch` and one `cat-file --batch`. */
function gitTrees(trees, width) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ledger-core-trees-'));
  try {
    const gitDir = path.join(directory, 'repo.git');
    git(['init', '--quiet', '--bare', `--object-format=${width === 64 ? 'sha256' : 'sha1'}`, gitDir]);
    const input = Buffer.concat(trees.flatMap((entries) => [...entries.map((entry) => Buffer.concat([
      Buffer.from(`${entry.mode} ${TYPES[entry.mode] ?? 'blob'} ${entry.oid}\t`), Buffer.from(entry.name, 'latin1'), Buffer.from([0])])), Buffer.from([0])]));
    const ids = git([`--git-dir=${gitDir}`, 'mktree', '-z', '--missing', '--batch'], input).toString().trim().split('\n');
    if (ids.length !== trees.length) throw new Error(`git mktree wrote ${ids.length} trees for ${trees.length}`);
    const out = git([`--git-dir=${gitDir}`, 'cat-file', '--batch'], `${ids.join('\n')}\n`);
    const bytes = [];
    for (let at = 0; at < out.length;) {
      const end = out.indexOf(10, at), header = out.subarray(at, end).toString().split(' ');
      const size = Number(header[2]);
      bytes.push(out.subarray(end + 1, end + 1 + size));
      at = end + 2 + size;
    }
    return ids.map((id, index) => ({ id, bytes: bytes[index] }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export const gitVersion = () => git(['--version']).toString().trim();

const entriesJson = (entries) => JSON.stringify(entries.map((entry) => ({ mode: unitsHex(entry.mode), name: unitsHex(entry.name), oid: unitsHex(entry.oid) })));

const tryStatus = (fn) => { try { return fn(); } catch (error) { if (error.code !== 'invalid_change_record') throw error; return { status: error.status }; } };

function damagedTrees(d, count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const width = d.chance(0.5) ? 40 : 64;
    const entries = treeEntries(TREES_SEED ^ 0x5a5a5a5a ^ index, width).slice(0, 1 + d.int(3));
    const bytes = [...serializeTree(entries)];
    const damage = d.int(6);
    if (damage === 0) bytes.length = d.int(bytes.length + 1);
    else if (damage === 1) bytes[d.int(bytes.length)] = d.pick([0x20, 0x00]);
    else if (damage === 2) bytes.splice(bytes.indexOf(0x20), 1);
    else if (damage === 3) bytes.push(...Array.from({ length: d.int(8) }, () => d.pick([0x20, 0x00, 0x61, 0x31])));
    else if (damage === 4) bytes.splice(bytes.indexOf(0), 1);
    const data = Buffer.from(bytes);
    const parsed = tryStatus(() => parseTree(data, width));
    const result = Array.isArray(parsed) ? entriesJson(parsed) : `throws:${parsed.status}`;
    rows.push(`parse\t${width}\t${data.toString('hex')}\t${result}`);
  }
  return rows;
}

/** A tree whose last id is one byte short, or missing: parseTree's bound, exactly. */
function shortTrees() {
  const rows = [];
  for (const width of [40, 64]) {
    const bytes = serializeTree(treeEntries(TREES_SEED, width).slice(0, 2));
    for (const cut of [0, 1, width / 2 - 1, width / 2, width / 2 + 1]) {
      const data = bytes.subarray(0, bytes.length - cut), parsed = tryStatus(() => parseTree(data, width));
      rows.push(`parse\t${width}\t${data.toString('hex')}\t${Array.isArray(parsed) ? entriesJson(parsed) : `throws:${parsed.status}`}`);
    }
  }
  return rows;
}

function oddInputs(d, count) {
  const units = ['a', 'b', '-', '.', '0', 'Ā', 'Ł', 'Į', '￿', '\ud800', 'é', '\x00', ' ', '/'];
  const hex = ['0', '1', 'a', 'f', 'A', 'F', 'g', 'z', 'İ', 'š', ' '];
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const entries = Array.from({ length: 1 + d.int(5) }, () => ({
      mode: d.pick(['40000', '040000', '100644', '160000', '4000', '']),
      name: Array.from({ length: d.int(4) }, () => d.pick(units)).join(''),
      oid: Array.from({ length: d.int(10) }, () => d.pick(hex)).join(''),
    }));
    if (d.chance(0.3)) entries.push({ ...entries[0] });
    rows.push(`serialize\t${entriesJson(entries)}\t${serializeTree(entries).toString('hex')}`);
  }
  return rows;
}

export function renderTrees(count, { oracle = true } = {}) {
  const rows = [];
  for (const width of [40, 64]) {
    const seeds = Array.from({ length: count }, (_, index) => (TREES_SEED + index * 7919 + width) >>> 0);
    const trees = seeds.map((seed) => treeEntries(seed, width));
    const checked = oracle ? gitTrees(trees, width) : null;
    trees.forEach((entries, index) => {
      const bytes = serializeTree(entries), id = objectID('tree', bytes, width);
      if (checked) {
        if (!bytes.equals(checked[index].bytes)) throw new Error(`serializeTree differs from git mktree for seed ${seeds[index]} (width ${width})`);
        if (id !== checked[index].id) throw new Error(`objectID ${id} differs from git's ${checked[index].id} for seed ${seeds[index]}`);
      }
      const order = parseTree(bytes, width).map((entry) => entries.findIndex((candidate) => candidate.name === entry.name).toString(36)).join(',');
      rows.push(`tree\t${width}\t${seeds[index]}\t${entries.length}\t${entriesFingerprint(entries)}\t${order}\t${id}`);
    });
  }
  const d = drawer(random(TREES_SEED));
  rows.push(...damagedTrees(d, Math.ceil(count / 5)), ...oddInputs(d, Math.ceil(count / 5)), ...shortTrees());
  return vectorDocument([
    '# Generated by generate-trees.mjs; do not edit. Rows: tree (seeded trees, checked against git mktree and git\'s ids when written), parse, serialize.',
  ], rows);
}

/** An in-memory store over testObjectId: readTree as the change store reads it (`found?.type !== 'tree'` refuses with 503). */
// `unreadable`: ids readTree refuses whatever the store holds (a tree it
// cannot read). `pause`: awaited before each read and write completes, to
// reorder the JavaScript's concurrent branches.
function memoryStore(width, { objects = new Map(), unreadable = new Set(), pause = null } = {}) {
  const writes = [];
  return {
    objects, writes,
    readTree: async (oid) => {
      if (pause) await pause();
      const found = unreadable.has(oid) ? null : objects.get(oid);
      if (found?.type !== 'tree') throw changeError('invalid_change_record', 503);
      return found.data;
    },
    writeObject: async (type, content) => {
      if (pause) await pause();
      const oid = testObjectId(type, content, width);
      objects.set(oid, { type, data: Buffer.from(content) });
      writes.push(oid);
      return oid;
    },
  };
}

const PARTS = ['a', 'b', 'c', 'd.json', 'ab', 'a-b', 'a.b'];

function draftKey(d) {
  const parts = [];
  for (let depth = d.int(4); depth > 0; depth -= 1) parts.push(d.pick(PARTS));
  parts.push(`${d.pick(['x', 'y', 'a', 'd'])}.json`);
  if (d.chance(0.02)) parts.splice(d.int(parts.length), 0, d.pick(['', '\u0100', '\u00e9', '\ud800']));
  return parts.join('/');
}

function draftValue(d) {
  if (d.chance(0.1)) return d.pick(['', '\ud800', '{"\u00e9":1}', '[]']);
  return String(d.int(40));
}

/** sorted ids, as a count and a fingerprint (fnv64 of the ids joined by newlines). */
const writesOf = (writes) => ({ n: writes.length, f: fnv64(Buffer.from([...writes].sort().join('\n'))) });

async function commitCase(d, index) {
  const width = d.chance(0.5) ? 40 : 64;
  const store = memoryStore(width);
  const initial = new Map();
  for (let n = d.int(13); n > 0; n -= 1) initial.set(draftKey(d), draftValue(d));
  const keys = [...initial.keys()];
  const second = new Map();
  for (let n = 1 + d.int(7); n > 0; n -= 1) {
    const roll = d.int(12), existing = keys.length ? d.pick(keys) : draftKey(d);
    if (roll < 3) second.set(existing, draftValue(d));
    else if (roll < 5) second.set(draftKey(d), draftValue(d));
    else if (roll < 7) second.set(existing, null);
    // Every key under one top-level directory: removals that empty it.
    else if (roll === 7) for (const key of keys.filter((key) => key.split('/')[0] === existing.split('/')[0])) second.set(key, null);
    else if (roll === 8) second.set(d.chance(0.5) ? existing : draftKey(d), { oid: testObjectId('blob', Buffer.from(String(d.int(1000))), width) });
    // A file replaced by a directory, or a directory by a file (or removed as one).
    else if (roll === 9 && d.chance(0.3)) second.set(`${existing}/${d.pick(['x', 'y'])}.json`, draftValue(d));
    else if (roll === 10 && d.chance(0.4) && existing.includes('/')) second.set(existing.slice(0, existing.lastIndexOf('/')), d.chance(0.5) ? draftValue(d) : null);
    else second.set(draftKey(d), null);
  }
  // A file and a directory of the same name in one change set.
  if (d.chance(0.03)) { const key = draftKey(d); second.set(key, draftValue(d)); second.set(`${key}/q.json`, draftValue(d)); }
  const run = async (tree, changes, using = store) => {
    try {
      const root = await commitTreeChanges({ tree, changes, oidLength: width, readTree: using.readTree, writeObject: using.writeObject });
      return { r: root, ...writesOf(using.writes) };
    } catch (error) {
      if (error.code !== 'invalid_change_record') throw error;
      return { e: error.status };
    }
  };
  const tree = index % 50 === 0 ? '' : null;
  const result = { w: width, t: tree, i: [...initial] };
  result.a = await run(tree, initial);
  if (result.a.r) {
    // Rarely, a tree the store cannot read: readTree refuses it with 503.
    const unreadable = new Set();
    if (d.chance(0.03)) {
      const subtrees = [...store.objects].filter(([oid, object]) => object.type === 'tree' && oid !== result.a.r);
      if (subtrees.length) { const [oid] = d.pick(subtrees); unreadable.add(oid); result.x = oid; }
    }
    result.c = [...second];
    // The branches run concurrently, so when two of them fail differently
    // (a conflict, 409, and an unreadable tree, 503) the error depends on
    // timing. Run the commit under several schedules: one outcome is
    // recorded as it is; several are recorded as { any: [...] }, any of
    // which the Rust may give.
    const outcomes = new Map();
    for (let schedule = 0; schedule < 8; schedule += 1) {
      const delays = random((COMMITS_SEED + index * 4 + schedule) >>> 0);
      const pause = schedule === 0 ? null : async () => { for (let n = Math.floor(delays() * 4); n > 0; n -= 1) await new Promise((resolve) => setImmediate(resolve)); };
      const outcome = await run(result.a.r, second, memoryStore(width, { objects: new Map(store.objects), unreadable, pause }));
      outcomes.set(JSON.stringify(outcome), outcome);
    }
    result.b = outcomes.size === 1 ? [...outcomes.values()][0] : { any: [...outcomes.values()] };
  }
  return JSON.stringify(result);
}

// Fixed cases, after the seeded ones: { i: initial changes, x: the path of
// the subtree readTree refuses, c: second changes, timing: whether the
// JavaScript's second result depends on timing }. Each runs under
// FIXED_SCHEDULES schedules; the generator refuses unless the number of
// outcomes is what `timing` says, so every outcome is listed.
const FIXED_SCHEDULES = 64;
const FIXED_COMMITS = [
  // A conflict among one directory's children (409) wins over an unreadable
  // subtree beside it (503), which comes first in the change order: the
  // JavaScript finds the conflict synchronously.
  { i: [['a/x.json', '1'], ['c.json', '2']], x: 'a', c: [['a/z.json', '3'], ['c.json/q.json', '4']], timing: false },
  { i: [['a/x.json', '1'], ['b/y.json', '2']], x: 'a', c: [['a/z.json', '3'], ['b', '5']], timing: false },
  { i: [['d/a/x.json', '1'], ['d/c.json', '2']], x: 'd/a', c: [['d/a/z.json', '3'], ['d/c.json/q.json', '4']], timing: false },
  // The conflict inside another subtree: either error, depending on timing.
  { i: [['a/x.json', '1'], ['d/c.json', '2']], x: 'a', c: [['a/z.json', '3'], ['d/c.json/q.json', '4']], timing: true },
  // New names of one directory with the same latin1 bytes (code units above
  // U+00FF): the JavaScript keeps them in the order their branches finish.
  { i: [['base.json', '0']], c: [['\ud800', '1'], ['Ā', '2']], timing: true },
  { i: [['base.json', '0']], c: [['\ud800/a/x.json/é', '1'], ['Ā/Ā', '{}']], timing: true },
  { i: [['d/base.json', '0']], c: [['d/Ā', '1'], ['d/Ȁ', '2']], timing: true },
  // A subtree and a file of the same bytes do not compare equal.
  { i: [['base.json', '0']], c: [['Ā/x', '1'], ['\ud800', '2']], timing: false },
];

/** The id of the subtree at `path` below `root` in a memory store. */
function subtreeAt(store, root, path, width) {
  let oid = root;
  for (const part of path.split('/')) oid = parseTree(store.objects.get(oid).data, width).find((entry) => entry.name === part).oid;
  return oid;
}

async function fixedCommitCase(spec, index) {
  const cases = [];
  for (const width of [40, 64]) {
    const store = memoryStore(width);
    const run = async (tree, changes, using) => {
      try {
        const root = await commitTreeChanges({ tree, changes, oidLength: width, readTree: using.readTree, writeObject: using.writeObject });
        return { r: root, ...writesOf(using.writes) };
      } catch (error) {
        if (error.code !== 'invalid_change_record') throw error;
        return { e: error.status };
      }
    };
    const result = { w: width, t: null, i: spec.i };
    result.a = await run(null, new Map(spec.i), store);
    if (!result.a.r) throw new Error(`fixed commit ${index}: the first commit failed`);
    const unreadable = new Set();
    if (spec.x) { result.x = subtreeAt(store, result.a.r, spec.x, width); unreadable.add(result.x); }
    result.c = spec.c;
    const outcomes = new Map();
    for (let schedule = 0; schedule < FIXED_SCHEDULES; schedule += 1) {
      const delays = random((COMMITS_SEED ^ 0x3c3c3c3c) + index * FIXED_SCHEDULES * 2 + width + schedule >>> 0);
      const pause = schedule === 0 ? null : async () => { for (let n = Math.floor(delays() * 4); n > 0; n -= 1) await new Promise((resolve) => setImmediate(resolve)); };
      const outcome = await run(result.a.r, new Map(spec.c), memoryStore(width, { objects: new Map(store.objects), unreadable, pause }));
      outcomes.set(JSON.stringify(outcome), outcome);
    }
    if ((outcomes.size > 1) !== spec.timing) throw new Error(`fixed commit ${index} (width ${width}): ${outcomes.size} outcomes under ${FIXED_SCHEDULES} schedules`);
    result.b = outcomes.size === 1 ? [...outcomes.values()][0] : { any: [...outcomes.values()] };
    cases.push(JSON.stringify(result));
  }
  return cases;
}

export async function renderCommits(count) {
  const d = drawer(random(COMMITS_SEED));
  const rows = [];
  for (let index = 0; index < count; index += 1) rows.push(`commit\t${await commitCase(d, index)}`);
  for (const [index, spec] of FIXED_COMMITS.entries()) for (const row of await fixedCommitCase(spec, index)) rows.push(`commit\t${row}`);
  return vectorDocument(['# Generated by generate-trees.mjs; do not edit. commit: JSON { w: width, t: first tree, i: initial changes, a: first result, x: id of a tree readTree refuses, c: second changes, b: second result }; a result is { r: root, n: objects written, f: their fingerprint } or { e: status }, and b is { any: [results] } when the JavaScript gives several under different schedules. The seeded cases come first, then fixed ones (FIXED_COMMITS).'], rows);
}

if (isMain(import.meta.url)) {
  const oracle = !process.argv.includes('--no-git');
  if (oracle) console.log(`Oracle: ${gitVersion()}`);
  runGenerator({ file: TREES_FILE, render: (count) => renderTrees(count, { oracle }), trackedCount: TREES_TRACKED });
  // commitTreeChanges is asynchronous: render every size runGenerator may ask for first.
  const at = process.argv.indexOf('--count');
  const sizes = [COMMITS_TRACKED, ...(at < 0 ? [] : [Number(process.argv[at + 1])])];
  const rendered = new Map();
  for (const size of sizes) if (Number.isInteger(size) && size >= 0) rendered.set(size, await renderCommits(size));
  runGenerator({ file: COMMITS_FILE, render: (count) => rendered.get(count), trackedCount: COMMITS_TRACKED });
}

