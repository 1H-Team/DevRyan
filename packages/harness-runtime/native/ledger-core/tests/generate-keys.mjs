#!/usr/bin/env node
// Writes keys.tsv: the change store's keys, ids and list pages, and change
// paths, as packages/harness-runtime/lib/session-changes-store.js,
// session-mutations.js and session-changes-snapshot.js decide them, so
// `cargo test` (tests/keys.rs) checks ledger_core::keys and ledger_core::paths.
// Command line: vector-tools.mjs.
//
// Strings are JSON string literals (lone surrogates and controls escaped). Rows:
//   key <check> <text> <0|1>   validKey (the store's own source, evaluated)
//          and, through a real store (openChangeStore over a stub Git), the
//          `at`, `ref`, lease token, importPrefix and setListObjects checks
//   entity <kind> <id> <bytes hashed, hex> <sha256> <key>   key(kind, id) of session-mutations.js
//   pages <values> <page lengths> <total bytes> <fnv64 of each page's JSON> | error:<index>
//          pagesOf (the store's source) over values given as specs: {"j":JSON}
//          or {"r":[unit, count]} (a string of one code unit repeated) or
//          {"u":1} (undefined); at and around 128 values and 256 KiB, with
//          multi-byte and escaped characters
//   names <prefix> <first page> <count> <names, a JSON array>   setList's page keys (real store)
//   record <spec> <0|1>   whether store.set refuses the value as change_record_too_large (512 KiB)
//   path <text> <0|1>   safeChangePath
import { createHash } from 'node:crypto';
import { openChangeStore } from '../../../lib/session-changes-store.js';
import { changeKey } from '../../../lib/session-changes-store.js';
import { safeChangePath } from '../../../lib/session-changes-snapshot.js';
import { evaluateDeclarations, fnv64 } from './codec-tools.mjs';
import { drawer, isMain, random, runGenerator, vectorDocument } from './vector-tools.mjs';

const str = (text) => JSON.stringify(text);

export const KEYS_FILE = 'keys.tsv';
export const KEYS_SEED = 20261203;
export const KEYS_TRACKED = 2000;

const { validKey, pagesOf } = evaluateDeclarations('session-changes-store.js', ['validKey', 'pagesOf'], {});
const { key: entityKey } = evaluateDeclarations('session-mutations.js', ['key'], { changeKey });

/** A store over a stub Git: no tree, sha1. */
async function stubStore(options = {}) {
  const gitRunner = {
    git: async (_cwd, args) => Buffer.from(args.includes('rev-parse') ? 'sha1\n' : ''),
    gitTokens: async function* () {},
    gitRecords: async function* () {},
  };
  return openChangeStore('/nonexistent', '/nonexistent/git', { gitRunner, ...options });
}

const refused = async (fn) => {
  try { await fn(); return false; } catch (error) { if (error.code !== 'invalid_change_record') throw error; return true; }
};

const KEY_UNITS = ['a', 'Z', '0', '9', '/', '_', '-', '.', 'json', '.json', '..', ' ', '\n', 'é', 'İ', '\ud800', '\0', '\\', 'A', 'z', '//'];
const HEX_UNITS = ['0', '9', 'a', 'f', 'A', 'g', '-', 'İ'];

function draftKey(d) {
  if (d.chance(0.4)) {
    const parts = Array.from({ length: 1 + d.int(4) }, () => Array.from({ length: d.int(4) }, () => d.pick(['a', 'B', '7', '_', '-'])).join(''));
    let key = `${parts.join('/')}.json`;
    if (d.chance(0.3)) key = key.slice(0, d.int(key.length)) + d.pick(KEY_UNITS) + key.slice(d.int(key.length));
    return key;
  }
  return Array.from({ length: d.int(8) }, () => d.pick(KEY_UNITS)).join('');
}

/** A seeded UUID-shaped token. */
const uuid = (d) => [8, 4, 4, 4, 12].map((length) => Array.from({ length }, () => '0123456789abcdef'[d.int(16)]).join('')).join('-');

const draftHex = (d, length) => Array.from({ length }, () => (d.chance(0.97) ? '0123456789abcdef'[d.int(16)] : d.pick(HEX_UNITS))).join('');

async function keyRows(d, count) {
  const rows = [];
  const store = await stubStore();
  for (let index = 0; index < count; index += 1) {
    const check = d.int(7);
    if (check === 0 || check === 1) {
      const key = draftKey(d);
      rows.push(`key\tkey\t${str(key)}\t${validKey(key) ? 1 : 0}`);
    } else if (check === 2) {
      const prefix = draftKey(d).replace(/\.json$/, '');
      rows.push(`key\tprefix\t${str(prefix)}\t${validKey(`${prefix}/page.json`) ? 1 : 0}`);
    } else if (check === 3) {
      const at = draftHex(d, d.pick([39, 40, 41, 63, 64, 65, 52]));
      rows.push(`key\tat\t${str(at)}\t${await refused(() => stubStore({ at })) ? 0 : 1}`);
    } else if (check === 4) {
      const token = d.chance(0.5) ? uuid(d).replace(/./g, (char) => (d.chance(0.05) ? d.pick(HEX_UNITS) : char)) : draftHex(d, d.pick([35, 36, 37]));
      const ref = d.chance(0.2) ? d.pick(['refs/devryan/state', 'refs/devryan/states', 'refs/devryan/leases/']) : `refs/devryan/leases/${token}`;
      rows.push(`key\tref\t${str(ref)}\t${await refused(() => stubStore({ ref })) ? 0 : 1}`);
      rows.push(`key\tlease\t${str(token)}\t${await refused(() => store.leaseRef(token)) ? 0 : 1}`);
    } else if (check === 5) {
      const source = draftHex(d, 38 + d.int(30));
      rows.push(`key\timport\t${str(source)}\t${await refused(() => store.importPrefix(source, 'runs/a')) ? 0 : 1}`);
    } else {
      const oid = draftHex(d, d.pick([0, 39, 40, 41, 64]));
      rows.push(`key\tlist40\t${str(oid)}\t${await refused(() => store.setListObjects('runs/a', [oid])) ? 0 : 1}`);
    }
  }
  return rows;
}

function entityRows(d, count) {
  const kinds = ['files', 'operations', 'leases', 'calls'];
  const units = ['a', '-', '0', 'é', '😀', '\ud800', '\udc00', '\0', ':'];
  return Array.from({ length: count }, () => {
    const kind = d.pick(kinds);
    const id = d.chance(0.5) ? uuid(d) : Array.from({ length: d.int(12) }, () => d.pick(units)).join('');
    const digest = createHash('sha256').update(id).digest('hex');
    return `entity\t${kind}\t${str(id)}\t${Buffer.from(id).toString('hex')}\t${digest}\t${entityKey(kind, id)}`;
  });
}

/** A value spec: what the Rust builds the same value from. */
const specValue = (spec) => (spec.u ? undefined : spec.r ? String.fromCharCode(spec.r[0]).repeat(spec.r[1]) : JSON.parse(spec.j));

const CHARS = [0x61, 0xe9, 0x20ac, 0xd83d, 0x22, 0x5c, 0x00, 0x1f, 0x2028, 0xd800];
/** The UTF-8 JSON size of a repeated-unit string, per unit (lone surrogates are escaped as \udxxx). */
const jsonUnitBytes = (unit) => Buffer.byteLength(JSON.stringify(String.fromCharCode(unit)).slice(1, -1));

function pageSpecs(d) {
  const shape = d.int(6), specs = [];
  const small = () => d.pick([{ j: String(d.int(1000)) }, { j: '"x"' }, { j: '{"a":[1,"é"]}' }, { j: 'null' }, { j: '[]' }, { r: [d.pick(CHARS), d.int(20)] }]);
  if (shape === 0) for (let n = d.pick([1, 127, 128, 129, 255, 256, 257, 300]); n > 0; n -= 1) specs.push(small());
  else if (shape <= 2) {
    // Fill a page to 256 KiB exactly, then one byte more or less.
    const unit = d.pick(CHARS), per = jsonUnitBytes(unit);
    for (let n = d.int(5); n > 0; n -= 1) specs.push({ j: String(d.int(10)) });
    const used = specs.reduce((sum, spec) => sum + Buffer.byteLength(spec.j), 0);
    const target = 256 * 1024 + d.pick([-per, 0, per, -1, 1]) - used - 2;
    specs.push({ r: [unit, Math.max(0, Math.floor(target / per))] });
    for (let n = d.int(4); n > 0; n -= 1) specs.push(d.chance(0.5) ? { j: String(d.int(10)) } : { r: [unit, d.int(4)] });
  } else if (shape === 3) {
    // Values larger than a page alone, around 256 KiB and 512 KiB.
    for (let n = 1 + d.int(3); n > 0; n -= 1) specs.push({ r: [d.pick(CHARS), d.pick([256 * 1024, 256 * 1024 - 2, 128 * 1024, 300 * 1024, 1])] });
  } else if (shape === 4) {
    for (let n = d.int(140); n > 0; n -= 1) specs.push(d.chance(0.05) ? { r: [d.pick(CHARS), 3000 + d.int(4000)] } : small());
    if (d.chance(0.2)) specs.splice(d.int(specs.length + 1), 0, { u: 1 });
  } else for (let n = d.int(3); n > 0; n -= 1) specs.push(small());
  return specs;
}

async function pageRows(d, count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const specs = pageSpecs(d), values = specs.map(specValue);
    const totals = { bytes: 0 }, pages = [];
    let failed = null;
    try {
      for await (const page of pagesOf(values, totals)) pages.push(page);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      failed = specs.findIndex((spec) => spec.u);
    }
    const result = failed !== null ? `error:${failed}` : `${pages.map((page) => page.length).join(',')}\t${totals.bytes}\t${pages.map((page) => fnv64(Buffer.from(JSON.stringify(page)))).join(',')}`;
    rows.push(`pages\t${JSON.stringify(specs)}\t${result}`);
  }
  return rows;
}

async function nameRows(d, count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const store = await stubStore();
    const prefix = d.pick(['runs/a', 'revisions/0f/x', 'b']);
    const firstPage = d.pick([0, 1, 2, 9, 99, 9_999_999_999, 10_000_000_000, 123_456_789_012, -1, -12]);
    const values = Array.from({ length: d.pick([0, 1, 128, 129, 300]) }, (_, n) => n);
    await store.setList(prefix, values, { absent: true, firstPage });
    const names = [...(await store.staged(prefix)).keys()];
    rows.push(`names\t${str(prefix)}\t${firstPage}\t${values.length}\t${JSON.stringify(names)}`);
  }
  return rows;
}

async function recordRows(d, count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const store = await stubStore();
    const unit = d.pick(CHARS), per = jsonUnitBytes(unit);
    const target = 512 * 1024 + d.pick([-per, 0, per, -1, 1, -2]);
    const spec = { r: [unit, Math.max(0, Math.floor((target - 2) / per))] };
    let tooLarge = false;
    try { store.set('a.json', specValue(spec)); } catch (error) { if (error.code !== 'change_record_too_large') throw error; tooLarge = true; }
    rows.push(`record\t${JSON.stringify(spec)}\t${tooLarge ? 1 : 0}`);
  }
  return rows;
}

function pathRows(d, count) {
  const units = ['a', '/', '\\', '.', '..', '.git', '.GIT', 'git', ' ', 'é', '\ud800', '\0', '~'];
  return Array.from({ length: count }, () => {
    const text = Array.from({ length: d.int(7) }, () => d.pick(units)).join('');
    return `path\t${str(text)}\t${safeChangePath(text) ? 1 : 0}`;
  });
}

export async function renderKeys(count) {
  const d = drawer(random(KEYS_SEED));
  const fifth = Math.ceil(count / 5);
  const rows = [...await keyRows(d, count), ...entityRows(d, Math.ceil(count / 10)), ...await pageRows(d, Math.ceil(count / 20)),
    ...await nameRows(d, Math.ceil(count / 50)), ...await recordRows(d, Math.ceil(count / 50)), ...pathRows(d, fifth)];
  return vectorDocument(['# Generated by generate-keys.mjs; do not edit. Rows: key, entity, pages, names, record, path (see the generator).'], rows);
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--count');
  const rendered = new Map([[KEYS_TRACKED, await renderKeys(KEYS_TRACKED)]]);
  if (at >= 0) rendered.set(Number(process.argv[at + 1]), await renderKeys(Number(process.argv[at + 1])));
  runGenerator({ file: KEYS_FILE, render: (count) => rendered.get(count), trackedCount: KEYS_TRACKED });
}
