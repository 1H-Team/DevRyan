#!/usr/bin/env node
// Writes, from Node's ICU root collation as English uses it (the pinned
// locale `en`; CLDR's English has no tailoring of its own):
//   ../src/collate_table.rs   collation weights for the 128 ASCII code units
//   ../src/key_sample.rs      the ledger key sample (KEY_SAMPLE below), in code-unit order
//   ledger-key-sample.txt     the same sample, one key per line (the copy a host check reads)
//   collate.tsv               Node's localeCompare signs
// so tests/collate.rs checks ledger_core::collate without JavaScript.
// Command line: vector-tools.mjs; --check covers all four files, --extended
// writes only collate.tsv.
//
// collate.tsv:
//   pairs     95*95 signs (`<`, `=`, `>`) of a.localeCompare(b, 'en') for the printable
//             ASCII characters a, b (0x20..0x7e), row-major.
//   random    count, FNV-1a checksum of the strings, then the signs of
//             (s[i] vs s[i+1]) and (s[i] vs mutate(s[i])) for seeded ASCII
//             strings of up to 64 units; tests/collate.rs regenerates the
//             strings with the same mulberry32 sequence (randomStrings below).
//   key       one key of a shape the ledger builds (session-changes-store.js,
//             session-mutations.js), in root collation order.
//   counter   two characters of the full key alphabet [a-zA-Z0-9/_.-] that
//             root collation and code-unit order put in opposite orders.
//
// Locale. Every comparison names the pinned locale `en`; nothing here reads
// the process's default locale, so LANG does not change the output. (`und`
// cannot be the pin: Intl.Collator('und') falls back to the default locale,
// so under LANG=nb_NO.UTF-8 it is Norwegian.) The generator refuses a Node
// whose ICU does not resolve `en` to itself with the default collation, and
// one where `en` orders the printable ASCII pairs differently from other
// locales that inherit root unchanged (ROOT_LIKE). The
// ledger itself calls localeCompare with no locale, so its order is the
// default locale's; survey-locales.mjs records which locales differ, and the
// default locale of this run is printed (and named in the header line) only
// as information.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TESTS_DIR, drawer, isMain, random, runGenerator, stripRuntime, vectorDocument } from './vector-tools.mjs';

export const COLLATE_FILE = 'collate.tsv';
export const TABLE_FILE = path.join(TESTS_DIR, '..', 'src', 'collate_table.rs');
export const COLLATE_SEED = 20261113;
export const COLLATE_TRACKED = 20000;
export const KEY_SAMPLE_RS = path.join(TESTS_DIR, '..', 'src', 'key_sample.rs');
export const KEY_SAMPLE_FILE = path.join(TESTS_DIR, 'ledger-key-sample.txt');
/** The locale these tables are generated under: English, whose collation is ICU root's. */
export const PINNED_LOCALE = 'en';
/** Locales whose CLDR collation is root's unchanged, as a cross-check of the pin. */
export const ROOT_LIKE = ['de', 'it', 'nl', 'pt', 'id', 'ms'];

/** The pinned collator, after checking that this ICU resolves the pin to itself with the default collation. */
export function pinnedCollator(options = {}) {
  const collator = new Intl.Collator(PINNED_LOCALE, options);
  const resolved = collator.resolvedOptions();
  if (resolved.locale !== PINNED_LOCALE || resolved.collation !== 'default') {
    throw new Error(`Node ${process.version} (ICU ${process.versions.icu}) resolves Intl.Collator('${PINNED_LOCALE}') to ${resolved.locale} with collation ${resolved.collation}: the collation tables describe English (root) collation only, so they cannot be generated here`);
  }
  return collator;
}
const root = pinnedCollator();
const compare = (a, b) => Math.sign(root.compare(a, b));
const sign = (value) => (value < 0 ? '<' : value > 0 ? '>' : '=');
const ascii = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));

/** Per code unit: [primary, secondary, tertiary], 0s for completely ignorable. */
export function collationWeights() {
  const level = (sensitivity) => pinnedCollator({ sensitivity });
  const ignorable = (c) => root.compare(`x${c}`, 'x') === 0 && root.compare(`${c}x`, 'x') === 0 && root.compare(c, '') === 0;
  const live = ascii.filter((c) => !ignorable(c));
  // Ranks within groups: equal under `collator` gets the same rank.
  const ranks = (collator, groupOf) => {
    const out = new Map(), groups = new Map();
    for (const c of live) { const key = groupOf(c); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); }
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => collator.compare(a, b));
      let rank = 0;
      sorted.forEach((c, index) => { if (index === 0 || collator.compare(sorted[index - 1], c) !== 0) rank += 1; out.set(c, rank); });
    }
    return out;
  };
  const primary = ranks(level('base'), () => 0);
  const secondary = ranks(level('accent'), (c) => primary.get(c));
  const tertiary = ranks(level('variant'), (c) => `${primary.get(c)}/${secondary.get(c)}`);
  return ascii.map((c) => (ignorable(c) ? [0, 0, 0] : [primary.get(c), secondary.get(c), tertiary.get(c)]));
}

/** The comparison collate.rs performs, here in JavaScript, to prove the table before writing it. */
function modelCompare(weights, a, b) {
  const seq = (text) => [...text].map((c) => weights[c.charCodeAt(0)]).filter((w) => w[0] !== 0);
  const [left, right] = [seq(a), seq(b)];
  for (let level = 0; level < 3; level += 1) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (left[index][level] !== right[index][level]) return Math.sign(left[index][level] - right[index][level]);
    }
    if (left.length !== right.length) return Math.sign(left.length - right.length);
  }
  return 0;
}

/** A Rust header line naming the runtime and the pinned locale (`--check` and the contract test ignore it). */
const rustRuntimeLine = () => `// Node ${process.version}, ICU ${process.versions.icu}; collation locale ${PINNED_LOCALE} (ICU root as English uses it).`;

export function renderTable(weights = collationWeights()) {
  const rows = weights.map((w, code) => `    [${w.join(', ')}], // ${code.toString(16).padStart(2, '0')} ${code >= 0x20 && code < 0x7f ? JSON.stringify(String.fromCharCode(code)) : 'control'}`);
  return `// Generated by tests/generate-collate.mjs from Node's Intl.Collator('${PINNED_LOCALE}'); do not edit.
${rustRuntimeLine()}
// [primary, secondary, tertiary] rank per ASCII code unit; [0, 0, 0] is completely ignorable.
// Ranks order collation elements within a level; only their order matters.
#[rustfmt::skip]
pub(super) const WEIGHTS: [[u8; 3]; 128] = [
${rows.join('\n')}
];
`;
}

/** The seeded strings and their mutants; tests/collate.rs repeats this exactly. */
export function randomStrings(count) {
  const { int, next } = drawer(random(COLLATE_SEED));
  const unit = () => String.fromCharCode(next() < 0.9 ? 0x20 + int(95) : int(128));
  const strings = [], mutants = [];
  for (let index = 0; index < count; index += 1) {
    const length = int(65);
    let text = '';
    for (let at = 0; at < length; at += 1) text += unit();
    strings.push(text);
    // One small edit, so that pairs often tie at the primary level.
    const at = int(text.length + 1), op = int(3);
    let mutant;
    if (op === 0) mutant = text.slice(0, at) + (next() < 0.5 ? String.fromCharCode(int(32)) : String.fromCharCode(0x20 + int(95))) + text.slice(at);
    else if (op === 1 && at < text.length && /[a-zA-Z]/.test(text[at])) {
      const c = text[at];
      mutant = text.slice(0, at) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + text.slice(at + 1);
    } else if (at < text.length) mutant = text.slice(0, at) + String.fromCharCode(0x20 + int(95)) + text.slice(at + 1);
    else mutant = text + String.fromCharCode(0x20 + int(95));
    mutants.push(mutant);
  }
  return { strings, mutants };
}

/** FNV-1a (32-bit) over the code units of every string then every mutant, each followed by 0xffff. */
export function checksum({ strings, mutants }) {
  let hash = 0x811c9dc5;
  for (const text of [...strings, ...mutants]) {
    for (const unit of [...Array.from(text, (c) => c.charCodeAt(0)), 0xffff]) {
      hash ^= unit & 0xff; hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= unit >> 8; hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

const uuid = (d) => {
  const h = (n) => Array.from({ length: n }, () => '0123456789abcdef'[d.int(16)]).join('');
  return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[d.int(4)]}${h(3)}-${h(12)}`;
};
/** Entity kinds the ledger keys with `${kind}/${changeKey(id)}.json` (session-mutations.js `key`). */
export const ENTITY_KINDS = ['calls', 'cancelled-calls', 'file-restores', 'files', 'last-redos', 'last-reverts', 'leases', 'native-removals',
  'native-shell-jobs', 'operations', 'prompts', 'sessions', 'transactions'];
const MUTATIONS_SOURCE = path.join(TESTS_DIR, '..', '..', '..', 'lib', 'session-mutations.js');

/** Fails when session-mutations.js keys an entity kind ENTITY_KINDS does not list (or no longer keys one it lists). */
export function assertEntityKinds(source = readFileSync(MUTATIONS_SOURCE, 'utf8')) {
  const found = [...new Set([...source.matchAll(/\bkey\('([a-z][a-z-]*)'/g)].map((match) => match[1]))].sort();
  if (JSON.stringify(found) !== JSON.stringify([...ENTITY_KINDS].sort())) {
    throw new Error(`session-mutations.js keys the entity kinds ${found.join(', ')}; ENTITY_KINDS in generate-collate.mjs lists ${ENTITY_KINDS.join(', ')}: update it and regenerate`);
  }
}

/**
 * Keys of every shape the ledger builds, from seeded IDs: entity keys,
 * `meta.json` and `materialization.json`, and list pages
 * (`<prefix>/%010d.json`, `<prefix>/page.json`) under `runs/<id>`,
 * `revisions/<id>`, `materializations/<id>`, `transactions/<id>/operations`,
 * `bases/<token>/files`, `bases/<token>/<id>` (importPrefix's destination,
 * session-mutations.js `bases/${lease.token}/${doc.id}`) and
 * `publications/<token>/files`.
 */
export function ledgerKeys({ perKind = 12, groups = 8, seed = COLLATE_SEED + 1 } = {}) {
  assertEntityKinds();
  const d = drawer(random(seed));
  const keys = new Set(['meta.json', 'materialization.json']);
  for (const kind of ENTITY_KINDS) for (let index = 0; index < perKind; index += 1) keys.add(`${kind}/${createHash('sha256').update(d.chance(0.5) ? uuid(d) : `ses_${d.int(1e9)}`).digest('hex')}.json`);
  const page = () => String(d.chance(0.5) ? d.int(3) : d.int(1e6)).padStart(10, '0');
  const tokens = Array.from({ length: 6 }, () => uuid(d));
  for (let index = 0; index < groups; index += 1) {
    const [a, b] = [d.pick(tokens), uuid(d)];
    for (const prefix of [`runs/${b}`, `revisions/${b}`, `materializations/${b}`, `transactions/${b}/operations`, `bases/${a}/files`, `bases/${a}/${b}`, `publications/${a}/files`]) {
      keys.add(`${prefix}/${page()}.json`); keys.add(`${prefix}/0000000000.json`); keys.add(`${prefix}/page.json`);
    }
  }
  return [...keys];
}

const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The characters every ledger key is made of (collate::CODE_UNIT_ORDER_SAFE). */
export const SAFE_ALPHABET = '-./0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * The ledger key sample, in code-unit order: the keys of every shape
 * (ledgerKeys()) plus every string of one and of two characters of
 * SAFE_ALPHABET. The short probes catch a locale that reorders two of those
 * characters, gives two of them the same primary weight, or contracts two of
 * them (Danish and Norwegian `aa`), wherever they would occur in a key. A host
 * sorts it with its own localeCompare and uses the native ledger only when
 * the result is this order (DOCUMENTATION.md, "The locale check").
 */
export function ledgerKeySample() {
  const sample = new Set(ledgerKeys());
  for (const a of SAFE_ALPHABET) { sample.add(a); for (const b of SAFE_ALPHABET) sample.add(a + b); }
  const sorted = [...sample].sort(codeUnitCompare);
  const rooted = [...sorted].sort((a, b) => root.compare(a, b));
  if (rooted.some((key, index) => key !== sorted[index])) throw new Error('Root collation does not order the ledger key sample by code unit: the key-order proof no longer holds');
  return sorted;
}

export const renderKeySampleText = (sample = ledgerKeySample()) => `${sample.join('\n')}\n`;

export function renderKeySampleRust(sample = ledgerKeySample()) {
  return `// Generated by tests/generate-collate.mjs; do not edit. The ledger key sample
// (tests/ledger-key-sample.txt holds the same keys), in code-unit order.
#[rustfmt::skip]
pub(super) static KEY_SAMPLE: [&str; ${sample.length}] = [
${sample.map((key) => `    ${JSON.stringify(key)},`).join('\n')}
];
`;
}

export function renderCollate(count) {
  const weights = collationWeights();
  const printable = ascii.slice(0x20, 0x7f);
  for (const locale of ROOT_LIKE) {
    const other = new Intl.Collator(locale);
    const differing = printable.flatMap((a) => printable.filter((b) => Math.sign(other.compare(a, b)) !== compare(a, b)).map((b) => a + b));
    if (differing.length) throw new Error(`'${PINNED_LOCALE}' and '${locale}' (both root collation in CLDR) order ${differing.length} printable pairs differently in ICU ${process.versions.icu}, first ${JSON.stringify(differing.slice(0, 3))}: the pin no longer means root`);
  }
  const failures = [];
  const checked = (a, b) => {
    const expected = compare(a, b);
    if (modelCompare(weights, a, b) !== expected) failures.push([a, b]);
    return sign(expected);
  };
  const pairs = printable.flatMap((a) => printable.map((b) => checked(a, b))).join('');
  const generated = randomStrings(count);
  const { strings, mutants } = generated;
  const signs = strings.map((text, index) => checked(text, strings[(index + 1) % strings.length]) + checked(text, mutants[index])).join('');
  const keys = ledgerKeys().sort((a, b) => root.compare(a, b));
  for (let i = 0; i < keys.length; i += 1) for (let j = 0; j < keys.length; j += 1) checked(keys[i], keys[j]);
  // Counterexamples over the full key alphabet: single characters suffice.
  const alphabet = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-.'];
  const counters = [];
  for (const a of alphabet) for (const b of alphabet) if (a < b && compare(a, b) !== codeUnitCompare(a, b)) counters.push(`counter\t${a}\t${b}`);
  if (failures.length) {
    throw new Error(`The three-level model over the generated weights disagrees with Node's root collation (Intl.Collator('${PINNED_LOCALE}'), ICU ${process.versions.icu}) on ${failures.length} comparisons, `
      + `first ${JSON.stringify(failures.slice(0, 5))}. This is not about the process locale (every comparison names '${PINNED_LOCALE}'): this ICU's root collation of ASCII needs a richer model.`);
  }
  return vectorDocument(['# Generated by generate-collate.mjs; do not edit. See the generator for the format.', `# Collation locale ${PINNED_LOCALE} (ICU root as English uses it); the ICU version is on the runtime line.`], [`pairs\t${pairs}`, `random\t${count}\t${checksum(generated)}\t${signs}`, ...keys.map((key) => `key\t${key}`), ...counters]);
}

/** Informational: whether this process's default locale orders the printable pairs as root does. */
export function defaultLocaleReport() {
  const locale = new Intl.Collator().resolvedOptions().locale;
  const printable = ascii.slice(0x20, 0x7f);
  const differing = printable.flatMap((a) => printable.filter((b) => Math.sign(a.localeCompare(b)) !== compare(a, b)).map((b) => a + b));
  return { locale, differing };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const sample = ledgerKeySample();
  const derived = [[TABLE_FILE, renderTable()], [KEY_SAMPLE_RS, renderKeySampleRust(sample)], [KEY_SAMPLE_FILE, renderKeySampleText(sample)]];
  if (argv.includes('--check')) {
    for (const [file, text] of derived) {
      let current = '';
      try { current = readFileSync(file, 'utf8'); } catch { /* reported below */ }
      if (stripRuntime(current) !== stripRuntime(text)) { console.error(`${file} differs from what Node ${process.version} (ICU ${process.versions.icu}, locale ${PINNED_LOCALE}) writes`); process.exitCode = 1; }
    }
  } else if (!argv.includes('--extended')) {
    for (const [file, text] of derived) { writeFileSync(file, text); console.log(`Wrote ${file}.`); }
  }
  const { locale, differing } = defaultLocaleReport();
  console.log(`Default locale (information only): ${locale}; it orders ${differing.length ? `${differing.length} printable pairs differently from root` : 'every printable pair as root does'}.`);
  runGenerator({ file: COLLATE_FILE, render: renderCollate, trackedCount: COLLATE_TRACKED, argv });
}
