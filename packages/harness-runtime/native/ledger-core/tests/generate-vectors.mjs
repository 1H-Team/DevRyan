#!/usr/bin/env node
// Writes vectors.tsv beside this file: edit scripts the JavaScript reference
// (`mutationDiff` in packages/harness-runtime/lib/session-mutation-text.js)
// produces for a fixed, seeded set of byte-string pairs, so `cargo test`
// checks the Rust port without JavaScript and lib/ledger-core.test.js checks
// the WebAssembly module and the reference against the same file.
//
//   node packages/harness-runtime/native/ledger-core/tests/generate-vectors.mjs           write
//   node packages/harness-runtime/native/ledger-core/tests/generate-vectors.mjs --check   fail unless the file is current
//
// One case per line, tab-separated: name, budget, before (hex), after (hex),
// and the pairs `kind,bytes,kind,bytes,...` (kind 0 equal, 1 delete, 2 insert).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATION_DIFF_WORK_BUDGET, mutationDiff } from '../../../lib/session-mutation-text.js';

export const VECTORS_FILE = fileURLToPath(new URL('./vectors.tsv', import.meta.url));
export const VECTOR_SEED = 20261111;
export const KIND_CODES = Object.freeze({ equal: 0, delete: 1, insert: 2 });

const utf8 = (text) => Buffer.from(text, 'utf8').toString('latin1');
const bytes = (...values) => Buffer.from(values).toString('latin1');

// mulberry32: a small deterministic generator, so the file is reproducible.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A text of `size` units drawn from `alphabet` (an array of strings). */
function draw(next, alphabet, size) {
  let text = '';
  for (let index = 0; index < size; index += 1) text += alphabet[Math.floor(next() * alphabet.length)];
  return text;
}

/** `text` (code points) with `count` random edits drawn from `alphabet`. */
function edit(next, text, alphabet, count) {
  const units = [...text];
  for (let index = 0; index < count; index += 1) {
    const at = Math.floor(next() * (units.length + 1));
    const choice = next();
    if (choice < 0.34 && units.length) units.splice(Math.min(at, units.length - 1), 1);
    else if (choice < 0.67) units.splice(at, 0, ...draw(next, alphabet, 1 + Math.floor(next() * 3)));
    else if (units.length) units[Math.min(at, units.length - 1)] = draw(next, alphabet, 1);
  }
  return units.join('');
}

/** A line-structured ASCII text of about `size` bytes. */
function lines(next, size) {
  const words = ['const', 'value', 'return', 'export', 'function', '=', '(', ')', '{', '}', ';', 'if', 'else', 'ledger', 'run', 'text'];
  let text = '';
  while (text.length < size) text += `${draw(next, words.map((word) => `${word} `), 2 + Math.floor(next() * 8)).trimEnd()}\n`;
  return text.slice(0, size);
}

/** `text` with `count` hunks of a few changed lines, spread through it. */
function hunks(next, text, count, insert = 'edited line\n') {
  const parts = text.split('\n');
  for (let index = 0; index < count; index += 1) {
    const at = Math.floor(((index + 0.5) / count) * parts.length);
    parts.splice(at, 1 + Math.floor(next() * 2), ...insert.trimEnd().split('\n'));
  }
  return parts.join('\n');
}

/** Every case as `{ name, budget, before, after }` with latin1 byte strings. */
export function vectorCases() {
  const next = random(VECTOR_SEED);
  const D = MUTATION_DIFF_WORK_BUDGET;
  const cases = [];
  const add = (name, before, after, budgets = [D]) => { for (const budget of budgets) cases.push({ name: `${name}@${budget}`, budget, before, after }); };

  // mutationDiff's early exits: equal texts, a NUL byte, invalid UTF-8.
  add('empty', '', '', [D, 0]);
  add('empty-to-text', '', 'a', [D, 0]);
  add('text-to-empty', 'abc', '', [D, 0]);
  add('equal', 'same text\n', 'same text\n', [D, 0, -1]);
  add('equal-non-ascii', utf8('café \u{1f600}'), utf8('café \u{1f600}'));
  add('nul-before', 'a\0b', 'ab');
  add('nul-after', '', '\0');
  add('nul-both', 'x\0', 'y\0');
  for (const [name, invalid] of [['overlong', bytes(0xc0, 0x80)], ['surrogate', bytes(0xed, 0xa0, 0x80)], ['truncated', bytes(0xe2, 0x82)],
    ['above-max', bytes(0xf4, 0x90, 0x80, 0x80)], ['f5', bytes(0xf5, 0x80, 0x80, 0x80)], ['ff', bytes(0xff)], ['lone-continuation', bytes(0x80)],
    ['overlong-3', bytes(0xe0, 0x80, 0x80)]]) {
    add(`invalid-${name}`, `ab${invalid}cd`, 'abcd');
    add(`invalid-${name}-after`, 'abcd', `abcd${invalid}`);
  }
  add('valid-max-code-point', utf8('a\u{10ffff}b'), utf8('a\u{10fffe}b'));
  add('valid-latin1-range', utf8('\u0080ÿ'), utf8('ÿ\u0080'));

  // Units per side: one ASCII side compares bytes with code points.
  add('mixed-ascii-left', 'abc', utf8('abé'), [D, 1, 0]);
  add('mixed-ascii-right', utf8('héllo'), 'hello', [D, 2]);
  add('mixed-shared-ascii', 'the quick brown fox', utf8('the quïck bröwn føx'), [D, 3, 10]);
  // Four-byte code points that share their leading bytes are distinct units.
  const astral = ['\u{1f600}', '\u{1f601}', '\u{1f602}', '\u{1f680}', '\u{1f681}', '\u{10000}', '\u{10001}'];
  add('astral-neighbours', utf8('a\u{1f600}b'), utf8('a\u{1f601}b'));
  add('astral-runs', utf8(draw(next, astral, 24)), utf8(draw(next, astral, 24)), [D, 5, 40]);
  add('astral-shift', utf8('\u{1f600}\u{1f601}\u{1f602}'), utf8('\u{1f601}\u{1f602}\u{1f600}'), [D, 1, 2, 3]);

  // Budgets: none, exhausted at once, exhausted mid-walk, negative.
  for (const budget of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, -1, -5, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    add('budget-sweep', 'abcabba-cbabacbab', 'cbabac-abcabbacbaab', [budget]);
  }
  add('disjoint-alphabets', 'aaaa bbbb', 'cccc dddd', [D, 1]);
  add('disjoint-middle', 'xx-aaaa-yy', 'xx-bbbb-yy', [D, 1]);

  // Larger shapes: line-structured text with two edits and with ten hunks.
  const base = lines(next, 8 * 1024);
  add('8k-two-edits', base, hunks(next, base, 2), [D, 200, 9000]);
  add('8k-ten-hunks', base, hunks(next, base, 10, 'first new line\nsecond new line\n'), [D, 2000]);
  const wide = `${base.slice(0, 2048)}${utf8('é€\u{1f600}')}${base.slice(2048, 4096)}`;
  add('4k-non-ascii', wide, hunks(next, wide, 3, utf8('café €\n')), [D, 300]);
  add('4k-to-ascii', wide, base.slice(0, 4096), [D]);
  // Unrelated texts: the budget runs out part-way.
  add('unrelated-2k', lines(next, 2048), lines(next, 2048), [D, 5000, 300_000]);

  // Seeded random pairs over small alphabets, edited or unrelated.
  const alphabets = [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', '\n'], ['x', 'y', 'z', ' ', '\n'],
    ['a', 'b', 'é', '€'], ['a', '\u{1f600}', '\u{1f601}', '\u{1f602}'], ['é', 'è', '中', '\u{10000}', '\u{10001}'],
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']];
  for (let index = 0; index < 1500; index += 1) {
    const alphabet = alphabets[index % alphabets.length];
    const before = draw(next, alphabet, Math.floor(next() * 40));
    const after = next() < 0.75 ? edit(next, before, alphabet, 1 + Math.floor(next() * 6)) : draw(next, alphabet, Math.floor(next() * 40));
    // Now and then one side is ASCII only, the other not.
    const left = index % 11 === 0 ? before.replace(/[^\x00-\x7f]/gu, 'q') : before;
    const roll = next();
    const budget = roll < 0.1 ? 0 : roll < 0.2 ? 1 : roll < 0.45 ? 2 + Math.floor(next() * 30)
      : roll < 0.7 ? Math.floor(next() * 400) : roll < 0.9 ? D : -Math.floor(next() * 10) - 1;
    cases.push({ name: `random-${index}@${budget}`, budget, before: utf8(left), after: utf8(after) });
  }
  return cases;
}

/** The JavaScript edit script as flat pairs. */
export function referencePairs({ before, after, budget }) {
  return mutationDiff(before, after, { budget }).flatMap(({ kind, text }) => [KIND_CODES[kind], text.length]);
}

export function renderVectors(cases = vectorCases()) {
  const header = ['# Generated by generate-vectors.mjs from mutationDiff; do not edit.',
    '# name\tbudget\tbefore (hex)\tafter (hex)\tkind,bytes,... (0 equal, 1 delete, 2 insert)'];
  const rows = cases.map((entry) => [entry.name, String(entry.budget), Buffer.from(entry.before, 'latin1').toString('hex'),
    Buffer.from(entry.after, 'latin1').toString('hex'), referencePairs(entry).join(',')].join('\t'));
  return `${[...header, ...rows].join('\n')}\n`;
}

/** Cases of a vectors file as `{ name, budget, before, after, pairs }`, texts as latin1 byte strings. */
export function parseVectors(text) {
  return text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const [name, budget, before, after, pairs] = line.split('\t');
    return { name, budget: Number(budget), before: Buffer.from(before, 'hex').toString('latin1'), after: Buffer.from(after, 'hex').toString('latin1'),
      pairs: pairs ? pairs.split(',').map(Number) : [] };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const rendered = renderVectors();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(VECTORS_FILE, 'utf8'); } catch { /* reported below */ }
    if (current !== rendered) {
      console.error(`${VECTORS_FILE} is stale: run node ${process.argv[1]}`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(VECTORS_FILE, rendered);
    console.log(`Wrote ${rendered.split('\n').length - 3} vectors to ${VECTORS_FILE}`);
  }
}
