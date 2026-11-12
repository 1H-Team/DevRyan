#!/usr/bin/env node
// Writes config-jsonc-edits.tsv: what jsonc-parser's modify (with the
// formatting the server passes) and applyEdits give, alone and in the
// server's sequences: the key-path removals of the opencode JSONC module
// (several on one text), the `plugin` replacement of the legacy Cursor
// cleanup, and the provisioning's replacement followed by removals. Inputs
// are the repository's configuration files and seeded documents, including
// paths whose parent is missing, non-object parents, duplicate keys,
// `__proto__`, CRLF and comments around the edited members, and
// indentation where the formatter's cache runs out (200 spaces).
// Command line: config-text-tools.mjs.
import { describe, jsonc } from './config-text-format.mjs';
import { drawer, isMain, runGenerator } from './config-text-tools.mjs';
import { KEY_POOL, repoFixtures } from './config-text-inputs.mjs';
import { jsoncValue } from './generate-config-jsonc.mjs';

export const FILE = 'config-jsonc-edits.tsv';
export const SEED = 20261113;
export const TRACKED = 733;

const PLUGIN_VALUES = [[], ['a'], ['opencode-a@1.0.0', 'file:///x/y.js'], ['é', 'q"q'], [['tuple', { option: true }]], [1, null, true], ['x'.repeat(120)]];

function objectDocument(d) {
  const t = () => d.pick(['', ' ', '\n  ', '\r\n  ', '\t', ' // c\n  ', ' /* c */ ']);
  const members = d.repeat(1 + d.int(5), () => {
    const key = d.pick(['plugin', 'provider', 'agent', '$schema', 'model', 'a', 'b', '__proto__', 'mcp']);
    const value = d.chance(0.5) ? JSON.stringify(d.pick(PLUGIN_VALUES)) : d.chance(0.5) ? jsoncValue(d, 3) : JSON.stringify({ google: { models: { m1: {}, m2: { x: 1 } } }, other: 1 });
    return `${t()}${JSON.stringify(key)}:${t()}${value}`;
  });
  const eol = d.pick(['\n', '\n', '\r\n']);
  const indent = d.pick(['  ', '    ', '\t', '']);
  const body = members.join(`,${eol}${indent}`);
  return d.chance(0.3) ? `{${body}${d.chance(0.3) ? ',' : ''}}` : `{${eol}${indent}${body}${d.chance(0.2) ? ',' : ''}${eol}}${d.chance(0.5) ? eol : ''}`;
}

/** Key paths that exist in the text's value, as the server derives them. */
function existingPaths(text) {
  const out = [];
  let value;
  try { value = jsonc.parse(text, [], { allowTrailingComma: true }); } catch { return out; }
  const pending = [[value, []]];
  while (pending.length) {
    const [node, at] = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node) || at.length > 4) continue;
    for (const key of Object.keys(node)) { out.push([...at, key]); pending.push([node[key], [...at, key]]); }
  }
  return out;
}

function keyPath(d) {
  const length = 1 + d.int(4);
  return d.repeat(length, (index) => (index === 0 ? d.pick(['plugin', 'provider', 'agent', '$schema', 'model', 'a', 'b', 'mcp', 'missing', '__proto__']) : d.pick(['google', 'models', 'm1', 'm2', 'x', 'other', ...KEY_POOL.slice(0, 8)])));
}

/** Objects nested `depth` levels deep on one line (the formatter then indents every level). */
const nested = (depth) => `${Array.from({ length: depth }, (_, level) => `{"k${level}":`).join('')}{}${'}'.repeat(depth)}`;

export function cases({ count, seed }) {
  const d = drawer(seed);
  const out = [];
  const paths = (list) => describe(list);
  for (const [file, text] of repoFixtures()) if (/\.jsonc?$/.test(file)) {
    out.push([`repo-remove-schema-${file}`, 'jsonc-remove', [text, paths([['$schema']])]]);
    out.push([`repo-remove-many-${file}`, 'jsonc-remove', [text, paths([['$schema'], ['plugin'], ['agent', 'build'], ['missing']])]]);
    out.push([`repo-set-plugin-${file}`, 'jsonc-set', [text, paths(['plugin']), describe(['devryan-a', 'devryan-b'])]]);
    out.push([`repo-provision-${file}`, 'jsonc-provision', [text.replace(/\n/g, '\r\n'), describe([]), paths([['provider', 'google', 'models', 'x'], ['$schema']])]]);
  }
  const fixed = [
    ['empty-remove', 'jsonc-remove', ['', paths([['a']])]],
    ['empty-set', 'jsonc-set', ['', paths(['plugin']), describe(['a'])]],
    ['ws-set', 'jsonc-set', ['  \n', paths(['plugin']), describe(['a'])]],
    ['array-root-set', 'jsonc-set', ['[1,2]', paths(['plugin']), describe(['a'])]],
    ['string-parent', 'jsonc-set', ['{"a":"x"}', paths(['a', 'b']), describe(1)]],
    ['number-parent-remove', 'jsonc-remove', ['{"a":1}', paths([['a', 'b']])]],
    ['missing-parent-remove', 'jsonc-remove', ['{"a":{}}', paths([['b', 'c']])]],
    ['missing-parent-set', 'jsonc-set', ['{"a":{}}', paths(['b', 'c', 'd']), describe(['x'])]],
    ['duplicate-first', 'jsonc-remove', ['{"plugin":[1],"plugin":[2]}', paths([['plugin'], ['plugin']])]],
    ['duplicate-set', 'jsonc-set', ['{"plugin":[1],\n"plugin":[2]}', paths(['plugin']), describe([3])]],
    ['proto-remove', 'jsonc-remove', ['{"__proto__":{"plugin":["x"]}}', paths([['__proto__', 'plugin']])]],
    ['proto-set', 'jsonc-set', ['{"__proto__":{"plugin":["x"]}}', paths(['plugin']), describe(['y'])]],
    ['trailing-comma-remove', 'jsonc-remove', ['{"a":1,"b":2,}', paths([['b']])]],
    ['comment-remove', 'jsonc-remove', ['{\n  // keep\n  "a": 1, // a\n  /* b */ "b": 2\n}\n', paths([['a']])]],
    ['comment-remove-last', 'jsonc-remove', ['{\n  "a": 1, // a\n  "b": 2 // b\n}\n', paths([['b']])]],
    ['crlf-remove', 'jsonc-remove', ['{\r\n  "a": 1,\r\n  "b": {\r\n    "c": 2\r\n  }\r\n}\r\n', paths([['b', 'c'], ['b']])]],
    ['cr-only', 'jsonc-set', ['{\r  "plugin": []\r}\r', paths(['plugin']), describe(['a', 'b'])]],
    ['no-newline-eol', 'jsonc-modify', ['{"a":1}', paths(['b']), describe([1, 2]), '\r\n']],
    ['modify-remove-only', 'jsonc-modify', ['{"a":1}', paths(['a']), '', '\n']],
    ['modify-empty-path', 'jsonc-modify', ['{"a":1}', paths([]), describe({ b: 2 }), '\n']],
    ['modify-empty-path-remove', 'jsonc-modify', ['{"a":1}', paths([]), '', '\n']],
    ['modify-root-string', 'jsonc-modify', ['"x"', paths([]), describe('y'), '\n']],
    ['set-undefined-inside', 'jsonc-set', ['{"plugin":[]}', paths(['plugin']), describe(['a', undefined, null])]],
    ['set-object-value', 'jsonc-set', ['{"plugin":[]}', paths(['plugin']), describe([{ a: undefined, b: -0, c: NaN, d: 'é ' }])]],
    ['set-lone-surrogate', 'jsonc-set', ['{"plugin":["\\ud800"]}', paths(['plugin']), describe(['\ud800x'])]],
    ['malformed-set', 'jsonc-set', ['{"plugin": [1,, 2}', paths(['plugin']), describe(['a'])]],
    ['unclosed-set', 'jsonc-set', ['{"a": 1', paths(['plugin']), describe(['a'])]],
    ['unclosed-comment-set', 'jsonc-set', ['{"a": 1} /* x', paths(['plugin']), describe(['a'])]],
  ];
  for (const depth of [99, 100, 101]) {
    fixed.push([`indent-cache-${depth}-insert`, 'jsonc-set', [nested(depth), paths(Array.from({ length: depth }, (_, level) => `k${level}`).concat('new')), describe(['x'])]]);
  }
  // A removal on a line already indented by `spaces`: the formatter indents
  // that line's members two more and its closing brace back. 196 and 202 stay
  // clear of the cache's missing 200-space entry, 198 and 200 meet it.
  for (const spaces of [196, 198, 200, 202]) {
    fixed.push([`indent-cache-line-${spaces}-remove`, 'jsonc-remove', [`{"p": 0,\n${' '.repeat(spaces)}"x": {"a": 1, "b": 2}\n}\n`, paths([['x', 'b']])]]);
  }
  // Comments, literals and the end of the text inside the formatted range,
  // each of the formatter's choices on both sides (line or block comment,
  // with or without a line break before it, after each kind of token).
  const FORMATTER_TEXTS = ['{"plugin": [] // c\n}', '{"plugin": /* c */ []}', '{"a": 1, /* c */ "plugin": []}', '{"plugin": [] /* c */, "b": 1}', '{"plugin":\n// c\n[], "b": 1}',
    '{"plugin" /* c */ : []}', '{"plugin" // c\n: [], "b": 2}', '{"plugin": [1] // c\n, "b": 2}', '{"plugin": []} // tail', '{"plugin": []} /* tail */', '{"plugin": [ /* c */ ], "b": 1}',
    '{"plugin": [ // c\n ], "b": 1}', '{"plugin": true // c\n, "b": 1}', '{"plugin": null /* c */, "b": 1}', '{"plugin": 1 /* c */ , "b": 2}', '{"b": 1 // c\n}', '{"b": "x" /* c */}',
    '{"plugin": [],\n  /* c */\n  "b": 1}', '{"plugin": [], /* c */\n"b": 1}', '{"plugin": [] /* a */ /* b */, "b": 1}', '{"plugin": []}   ', '{"plugin": [], "b": 2}', '{"plugin": [1 2], "b": 1}',
    '{"a": 1 "plugin": [], "b": 1}', '{"plugin": [], "b": {"c": 1} // c\n}', '{"plugin": [], "b": [1] /* c */}', '{"plugin": []/*c*/,"b":1}', '{"plugin": [], "b": 1,\n// end\n}',
    // Removals whose range spans lines, so comments and breaks inside it are formatted.
    '{"plugin": [], // c\n  "b": 1}', '{"plugin": [] // c\n  , "b": 1}', '{"a": 1, "plugin": // c\n [1], "b": 2}', '{"a": 1, "plugin": /* c */\n [1], "b": 2}', '{"a": 1, "plugin" // c\n : [1], "b": 2}',
    '{"a": 1, "plugin" /* c */\n : [1], "b": 2}', '{"a": 1, "plugin": [1, // c\n 2], "b": 2}', '{"a": 1, "plugin": [1 /* c */, 2] /* d */ , "b": 2}', '{"a": 1, "plugin": true /* c */\n, "b": 2}',
    '{"a": 1, "plugin": {"x": 1 // c\n}, "b": 2}', '{"a": 1,\n// c\n"plugin": [], "b": 2}', '{"a": 1, "plugin": [] /* c */ /* d */\n, "b": 2}', '{"a": 1, "plugin":\n/* c */ [1] // d\n, "b": 2}',
    '{"a": 1, "plugin": null // c\n /* d */\n, "b": 2}', '{"a": 1, "plugin": [\n/* c */\n], "b": 2}',
    // The edited line is formatted as one: blanks before a comment after each kind of token, a line
    // ending in a comma or an open brace, and a last line with no line break after it.
    '{"plugin": [], "b": 1   // c\n}', '{"plugin": [], "b": true   /* c */}', '{"plugin": [], "b": "s"   // c\n}', '{"plugin": [], "b": {}   // c\n}', '{"plugin": [], "b": []   /* c */ }',
    '{"plugin": [] , "b" : 1}', '{"x": 0, "a": 1, "plugin": [],   \n"b": 2}', '{   \n"plugin": [], "b": 1}', '{"plugin": [], "b": 1 }', '{"plugin": [], "b": [1 ] }'];
  FORMATTER_TEXTS.forEach((text, index) => {
    fixed.push([`formatter-${index}-set`, 'jsonc-set', [text, paths(['plugin']), describe(['x', 'y'])]]);
    fixed.push([`formatter-${index}-remove-plugin`, 'jsonc-remove', [text, paths([['plugin']])]]);
    fixed.push([`formatter-${index}-remove-b`, 'jsonc-remove', [text, paths([['b']])]]);
    fixed.push([`formatter-${index}-modify-new`, 'jsonc-modify', [text, paths(['new']), describe([1, { k: 'v' }]), '\r\n']]);
  });
  fixed.push(['deep-513', 'jsonc-remove', [`${'['.repeat(513)}${']'.repeat(513)}`, paths([['a']])]]);
  out.push(...fixed);
  while (out.length < count) {
    const index = out.length;
    const text = d.chance(0.85) ? objectDocument(d) : jsoncValue(d);
    const roll = d.int(10);
    const known = existingPaths(text);
    const choose = () => (known.length && d.chance(0.92) ? d.pick(known) : keyPath(d));
    if (roll < 4) out.push([`seeded-${index}-remove`, 'jsonc-remove', [text, paths(d.repeat(1 + d.int(4), choose))]]);
    else if (roll < 7) out.push([`seeded-${index}-set`, 'jsonc-set', [text, paths(d.chance(0.8) ? ['plugin'] : keyPath(d)), describe(d.pick(PLUGIN_VALUES))]]);
    else if (roll < 9) out.push([`seeded-${index}-provision`, 'jsonc-provision', [text, describe(d.pick(PLUGIN_VALUES)), paths(d.repeat(d.int(3), choose))]]);
    else out.push([`seeded-${index}-modify`, 'jsonc-modify', [text, paths(choose()), d.chance(0.5) ? '' : describe(d.pick(PLUGIN_VALUES)), d.pick(['\n', '\r\n'])]]);
  }
  return out;
}

export const HEADER = ['# Generated by generate-config-jsonc-edits.mjs; do not edit. name, operation, arguments (base64 of WTF-8; paths and values as descriptions), result (base64 of WTF-8): `=text`, `!error` (what JavaScript throws), `refused` (the crate hands the edit back to JavaScript), or for jsonc-modify one `offset:length:"content"` line per edit.'];

/** What the tracked file holds: `TRACKED` cases from the seed. */
export const GENERATOR = Object.freeze({ script: 'generate-config-jsonc-edits.mjs', file: FILE, header: HEADER, cases, trackedCount: TRACKED, seed: SEED });

if (isMain(import.meta.url)) runGenerator(GENERATOR);
