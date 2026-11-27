#!/usr/bin/env node
// Writes config-yaml-stringify.tsv: what yaml.stringify(value) writes for
// seeded JavaScript values (every string the quoting rules distinguish,
// numbers at the layout edges, long lines that fold or overflow, multi-line
// strings in block style, keys over 1024 units, empty containers, undefined
// members, repeated and cyclic objects), for the front matter of the
// repository's agent and skill files after yaml.parse (the server's round
// trip), and for the values the parse vectors produce.
// Command line: config-text-tools.mjs.
import { YAML, describe } from './config-text-format.mjs';
import { drawer, isMain, runGenerator } from './config-text-tools.mjs';
import { KEY_POOL, YAML_STRINGS, longString, randomValue, repoFixtures } from './config-text-inputs.mjs';
import { cases as parseCases } from './generate-config-yaml-parse.mjs';

export const FILE = 'config-yaml-stringify.tsv';
export const SEED = 20261115;
export const TRACKED = 1783;

function quietParse(source) {
  const original = process.emitWarning;
  process.emitWarning = () => {};
  try { return { value: YAML.parse(source) }; } catch { return null; } finally { process.emitWarning = original; }
}

const nestArrays = (depth) => { let value = 'x'; for (let level = 0; level < depth; level += 1) value = [value]; return value; };
const deep = (depth) => { let value = 'x'; for (let level = 0; level < depth; level += 1) value = level % 2 ? [value] : { k: value }; return value; };
const nestMaps = (depth, value) => { let out = value; for (let level = 0; level < depth; level += 1) out = { k: out }; return out; };

/** `length` units of words (`abcd efgh …`), never ending in a space. */
const words = (length) => {
  let out = '';
  for (let index = 0; out.length < length; index += 1) out += index % 5 === 4 ? ' ' : String.fromCharCode(0x61 + (index % 26));
  return out.endsWith(' ') ? `${out.slice(0, -1)}z` : out;
};

/**
 * Where a value is written: [name, wrap, the column budget its first line
 * starts with (lineWidth minus indentAtStart or the indent), the indent of
 * its continuation lines]. `deep` puts the value 31 maps down (indent 62,
 * where minContentWidth decides the fold step); the long keys put it past
 * column 60, where the package starts a value on the next line.
 */
const CONTEXTS = [
  ['root', (s) => s, 80, 0],
  ['value', (s) => ({ k: s }), 77, 2],
  ['item', (s) => [s], 78, 2],
  ['nested', (s) => ({ a: { b: s } }), 77, 4],
  ['deep', (s) => nestMaps(31, s), 77, 62],
  ['anchored', (s) => { const shared = [s]; return [shared, shared]; }, 75, 4],
  // A long tail keeps the value past one fold step, so it is folded at all.
  ['key-57', (s) => ({ ['k'.repeat(57)]: `${s} ${'z'.repeat(70)}` }), 21, 2],
  ['key-58', (s) => ({ ['k'.repeat(58)]: `${s} ${'z'.repeat(70)}` }), 20, 2],
  ['key-59', (s) => ({ ['k'.repeat(59)]: `${s} ${'z'.repeat(70)}` }), 19, 2],
];

/**
 * Strings whose one decision sits at unit `p`, for each of the writer's
 * styles: a fold point (a single space between non-blank units) for plain,
 * double-quoted, single-quoted and folded block text; an escape or a run of
 * blanks where a double-quoted line has no fold point; a line exactly as long
 * as the budget for the literal-or-folded choice; more-indented block lines.
 */
const STYLES = [
  ['plain', (p) => `${'a'.repeat(p)} ${'b'.repeat(8)} c`],
  ['plain-tab-before', (p) => `${'a'.repeat(p - 1)}\t ${'b'.repeat(8)} c`],
  ['plain-tab-after', (p) => `${'a'.repeat(p)} \t${'b'.repeat(8)} c`],
  ['double', (p) => ` ${'a'.repeat(p - 1)} ${'b'.repeat(8)} c`],
  ['single', (p) => ` "${'a'.repeat(p - 2)} ${'b'.repeat(8)} c`],
  ['both', (p) => ` '"${'a'.repeat(p - 3)} ${'b'.repeat(8)} c`],
  ['escape-x', (p) => `\u0001${'a'.repeat(p)}\u0002${'b'.repeat(12)}`],
  ['escape-u', (p) => `\u0001${'a'.repeat(p)}\ud800${'b'.repeat(12)}`],
  ['escape-dense-x', (p) => `${'a'.repeat(p % 4)}${'\u0001'.repeat(30)}`],
  ['escape-dense-u', (p) => `${'a'.repeat(p % 6)}${'\ud800'.repeat(20)}`],
  ['blank-run', (p) => `\u0001${'a'.repeat(p)}   ${'b'.repeat(12)}`],
  ['tab-run', (p) => `\u0001${'a'.repeat(p)}\t\t${'b'.repeat(12)}`],
  ['folded', (p) => `${'a'.repeat(p)} ${'b'.repeat(8)} c\nend`],
  ['literal-first', (p) => `${words(p)}\nx`],
  ['literal-last', (p) => `x\n${words(p)}`],
  ['one-more-indented', (p) => `x\n ${words(p)} yy\nz\n`],
  ['more-indented', (p) => `x\n  ${words(p)} yy\nz ${words(p)} ww\n`],
  ['indented-first', (p) => `  ${words(p)} yy\nz\n`],
  ['marker-folded', (p) => `--- ${'a'.repeat(p - 4)} ${'b'.repeat(8)} c\nend`],
  // Folded once where the first line runs out, then again one fold step later.
  ['second-fold', (p, budget) => `${'a'.repeat(budget - 5)} ${'b'.repeat(p - 1)} ${'c'.repeat(10)} d`],
];

/** Both quote kinds, with each reason a string needs quotes. */
const BOTH_QUOTES = [`'a"b`, `"a'b`, `#'"`, `- '"`, `? '"`, `a: '"`, `a '" #b`, ` a'"`, `a'" `, `'"`, `"'`, `a'b"c: d`, `[x'"]`, `{'"}`, `*'"`, `&'"`, `!'"`, `|'"`, `>'"`,
  `%'"`, `@'"`, '`\'"', `,'"`, `'"\n`, `a'"\nb`, ` '"\nb`, `'" \nb`, `'"\u0001`, `'"\n\n`, `--- '"`, `'"\n--- x`];

/** Double-quoted text around each choice of its line breaks (40 units, a final break, runs, a space after). */
function doubleQuotedBreaks() {
  const out = [];
  for (let length = 35; length <= 43; length += 1) out.push(`\u0001${'x'.repeat(length - 7)}\nz`);
  out.push(`\u0001${'x'.repeat(40)}\n`, `\u0001${'x'.repeat(40)}\n\n\ny`, `\u0001${'x'.repeat(40)}\n\n`, `\u0001${'x'.repeat(40)}\n y`, `\u0001${'x'.repeat(40)}\n\n y`, `\u0001${'x'.repeat(40)}\n---y`);
  return out;
}

/** Rows for every decision of the writer, on each side of it. */
function edgeCases(add) {
  for (const [context, wrap, budget, indent] of CONTEXTS) {
    const step = Math.max(21, 81 - indent);
    for (const [style, make] of STYLES) {
      // Double-quoted text after `\u0001` starts five units in (`"\x01`).
      const escaped = style.startsWith('escape') || style.endsWith('-run');
      const centre = style === 'second-fold' ? step : style.startsWith('literal') || style.endsWith('indented') || style === 'indented-first' ? 80 - indent : escaped ? budget - 5 : budget;
      // The long keys only change where the first line starts, and the deep
      // value only the fold step; each needs the styles that fold.
      if (context.startsWith('key-') && !['plain', 'double'].includes(style)) continue;
      // An anchor moves where a sequence's items start.
      if (context === 'anchored' && !['plain', 'double'].includes(style)) continue;
      if (context === 'deep' && !['plain', 'double', 'folded', 'second-fold'].includes(style)) continue;
      // A document marker changes the block indent only at the root.
      if (style === 'marker-folded' && context !== 'root') continue;
      // An escape's fold point depends on where the escape ends, so its band is wider.
      const below = style.startsWith('escape-') ? 9 : 3;
      for (let p = centre - below; p <= centre + 3; p += 1) add(`edge-${context}-${style}-${p}`, wrap(make(p, budget)));
    }
  }
  for (const [context, wrap] of CONTEXTS.slice(0, 4)) {
    BOTH_QUOTES.forEach((text, index) => add(`both-quotes-${context}-${index}`, wrap(text)));
    doubleQuotedBreaks().forEach((text, index) => add(`double-breaks-${context}-${index}`, wrap(text)));
  }
  BOTH_QUOTES.forEach((text, index) => add(`both-quotes-key-${index}`, { [text]: 1 }));
  // Keys longer than a line are never folded; a key with a line break is double-quoted.
  [`${'a '.repeat(50)}z`, ` ${'a '.repeat(50)}z`, ` "${'a '.repeat(50)}z`, `\u0001${'a '.repeat(50)}z`, ` "a\nb`, `\u0001${'x'.repeat(40)}\nz`, '--- x', 'x\n--- y']
    .forEach((key, index) => add(`key-shape-${index}`, { [key]: 1, nested: { [key]: [key] } }));
  [' lead\nx', '  two\nx', '\n\n x', ' \u0085x\ny'].forEach((text, index) => add(`block-start-${index}`, text));
  // An explicit key (over 1024 units) leaves its value's first line where it is.
  [`${'a'.repeat(76)} b c`, ` ${'a'.repeat(76)} b c`].forEach((text, index) => add(`explicit-key-value-${index}`, { ['k'.repeat(1025)]: text }));
  // Leading indicators and a tab before `#`; a block line with no fold point (folding overflows, so it stays literal).
  [',x', ']x', '}x', 'a\t#b', 'a\t# b', '\u0008x', '\u001fx', '\u009fx', '\u00a0x', `x\n%${words(60)}\ny`, '"a\n ', '"a\n\t', `--- "x: ${words(100)}`, `x\r--- ${words(60)}`, `x\u2028--- ${words(60)}`, `x\n${'a'.repeat(100)}`, `${'a'.repeat(100)}\nx`].forEach((text, index) => { add(`quote-reason-${index}`, text); add(`quote-reason-value-${index}`, { k: text }); });
}

export function cases({ count, seed }) {
  const d = drawer(seed);
  const out = [];
  const add = (name, value) => out.push([name, 'yaml-stringify', [describe(value)]]);
  for (const [file, text] of repoFixtures()) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) continue;
    const parsed = quietParse(match[1]);
    if (parsed) add(`repo-${file}`, parsed.value);
  }
  YAML_STRINGS.forEach((text, index) => { add(`string-${index}`, text); add(`string-value-${index}`, { key: text }); add(`string-key-${index}`, { [text]: 1 }); add(`string-item-${index}`, [text, { nested: [text] }]); });
  KEY_POOL.forEach((key, index) => add(`key-${index}`, Object.defineProperty({}, key, { value: key, enumerable: true, writable: true, configurable: true })));
  const fixed = [
    undefined, null, true, false, 0, -0, 1, -1, 1.5, 0.1, 1e20, 1e21, 123456789012345680000, 1e-6, 1e-7, 123e-20, 5e-324, 1.7976931348623157e308, 9007199254740993, NaN, Infinity, -Infinity, '', [], {}, [[]], [{}], { a: [] }, { a: {} },
    { a: undefined, b: 1 }, [undefined, null], { a: null }, { a: { b: { c: { d: [1, [2, [3]]] } } } }, { long: 'word '.repeat(40) }, { long: 'x'.repeat(200) }, ['word '.repeat(40)],
    { [`${'k'.repeat(1025)}`]: 'v' }, { [`${'k'.repeat(1024)}`]: 'v' }, { [`${'k '.repeat(600)}`]: { a: 1 } }, { multi: 'line one\nline two\n' }, { multi: 'a\n\n\nb' }, { multi: '  lead\nx' },
    { multi: 'x\n  more indented\ny\n' }, { multi: `${'folded words '.repeat(12)}\n${'more words '.repeat(12)}` }, { multi: 'trailing\n\n\n' }, { multi: '\n\nleading' }, { multi: 'a\nb ' },
    { multi: '--- marker\nnext' }, '--- root marker\nline', '...\nx', { doc: '%x\ny' }, { q: 'a\'b"c' }, { esc: '\u0000\u0001\u0007\u000b\u001b\u0085   \ud800' }, { long_esc: `${'\u0001x '.repeat(40)}` },
    { dq_newlines: `x${'\u0001'}\n\ny${' word'.repeat(20)}` }, { ' ': ' ' }, { '': '' }, { 1: 'a', 0: 'b', a: 'c', 4294967295: 'd' }, deep(40), nestArrays(63), nestArrays(64), nestArrays(65), deep(64), deep(65), deep(300),
  ];
  fixed.forEach((value, index) => add(`fixed-${index}`, value));
  edgeCases(add);
  // Anchored empty collections keep their flow form after the anchor.
  const emptyArray = [];
  const emptyObject = {};
  add('anchored-empty', [emptyArray, emptyArray, { a: emptyObject, b: emptyObject }]);
  const shared = { s: 1 };
  add('shared', { a: shared, b: shared, c: [shared, shared] });
  const cyclic = { name: 'cycle' };
  cyclic.self = cyclic;
  add('cyclic', cyclic);
  const ring = [];
  ring.push({ ring });
  add('ring', ring);
  const sharedArray = [1, 2];
  add('shared-array', [sharedArray, { x: sharedArray }, sharedArray]);
  for (const [name, , [source]] of parseCases({ count: 250, seed: seed + 1 })) {
    const parsed = quietParse(source);
    if (!parsed || parsed.value === undefined) continue;
    const text = describe(parsed.value);
    if (!text.includes('!') && text.length < 4000) add(`parsed-${name}`, parsed.value);
  }
  while (out.length < count) {
    const index = out.length;
    const value = d.chance(0.1) ? { description: longString(d) } : randomValue(d);
    add(`seeded-${index}`, d.chance(0.8) && (value === null || typeof value !== 'object') ? { value } : value);
  }
  return out;
}

export const HEADER = ['# Generated by generate-config-yaml-stringify.mjs; do not edit. name, operation, value (description, base64 of WTF-8), result (base64 of WTF-8): JSON.stringify of the text, `undefined`, or `unsupported`.'];

/** What the tracked file holds: `TRACKED` cases from the seed. */
export const GENERATOR = Object.freeze({ script: 'generate-config-yaml-stringify.mjs', file: FILE, header: HEADER, cases, trackedCount: TRACKED, seed: SEED });

if (isMain(import.meta.url)) runGenerator(GENERATOR);
