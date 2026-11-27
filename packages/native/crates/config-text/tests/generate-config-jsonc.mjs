#!/usr/bin/env node
// Writes config-jsonc.tsv: what jsonc-parser's parse (allowTrailingComma)
// and stripComments give for the repository's configuration files, seeded
// documents (comments of both kinds everywhere, trailing commas, every line
// ending and whitespace, a byte-order mark, deep nesting, empty containers,
// duplicate and prototype keys, edge numbers, every escape, non-ASCII and
// lone surrogates, very long lines) and mutated, mostly malformed, ones.
// Command line: config-text-tools.mjs.
import { drawer, isMain, mutate, runGenerator } from './config-text-tools.mjs';
import { KEY_POOL, NUMBER_TEXTS, STRING_CHARS, repoFixtures } from './config-text-inputs.mjs';

export const FILE = 'config-jsonc.tsv';
export const SEED = 20261112;
export const TRACKED = 1012;

const TRIVIA = ['', '', ' ', '  ', '\t', '\n', '\r\n', '\r', '\n\n', ' \t ', '// line\n', '//\r\n', '// end', '/* block */', '/**/', '/* multi\nline */', '/* a */ /* b */', '\n  // c\n  ', '/* unclosed'];

/** JSON text of a string with random escaping. */
export function jsonString(d, text) {
  let out = '"';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (code < 0x20 && !d.chance(0.05)) out += d.pick([`\\u${code.toString(16).padStart(4, '0')}`, ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`]);
    else if (d.chance(0.08)) out += Array.from(ch, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    else if (d.chance(0.02)) out += d.pick(['\\/', '\\b', '\\f', '\\r', '\\x', '\\u12', '\\uZZZZ', '\\']);
    else out += ch;
  }
  return out + (d.chance(0.02) ? '' : '"');
}

function scalarText(d) {
  const roll = d.int(10);
  if (roll < 3) return d.pick(NUMBER_TEXTS);
  if (roll < 5) return d.pick(['true', 'false', 'null', 'True', 'nul', 'undefined', 'NaN']);
  let text = '';
  for (let index = d.int(d.chance(0.005) ? 1200 : 10); index > 0; index -= 1) text += d.pick(STRING_CHARS);
  return jsonString(d, text);
}

/** A seeded JSONC value. */
export function jsoncValue(d, depth = 0) {
  const t = () => d.pick(TRIVIA);
  const roll = d.int(depth > 4 ? 3 : 6);
  if (roll < 3) return scalarText(d);
  const trailing = d.chance(0.3) ? `,${t()}` : '';
  if (roll === 3) {
    const items = d.repeat(d.int(5), () => `${t()}${jsoncValue(d, depth + 1)}${t()}`);
    return `[${items.join(',')}${items.length ? trailing : ''}${t()}]`;
  }
  const members = d.repeat(d.int(6), () => {
    const key = d.chance(0.8) ? JSON.stringify(d.pick(KEY_POOL)) : jsonString(d, d.pick(KEY_POOL));
    return `${t()}${key}${t()}:${t()}${jsoncValue(d, depth + 1)}${t()}`;
  });
  return `{${members.join(',')}${members.length ? trailing : ''}${t()}}`;
}

const nest = (depth, open, close, inner = '1') => `${open.repeat(depth)}${inner}${close.repeat(depth)}`;

export function cases({ count, seed }) {
  const d = drawer(seed);
  const out = [];
  const add = (name, text) => {
    out.push([`${name}-parse`, 'jsonc-parse', [text]]);
    out.push([`${name}-strip`, 'jsonc-strip', [text]]);
  };
  for (const [file, text] of repoFixtures()) if (/\.jsonc?$/.test(file)) {
    add(`repo-${file}`, text);
    add(`repo-crlf-${file}`, text.replace(/\n/g, '\r\n'));
    add(`repo-bom-${file}`, `﻿${text}`);
  }
  const fixed = [
    '', ' ', '﻿', '﻿{}', '{}', '[]', '{,}', '[,]', '{"a":1,}', '[1,]', '{"a":1,,}', '[1,,2]', '{"a"}', '{"a":}', '{"a" 1}', '{1:2}', '{"a":1 "b":2}', '[1 2]', '{', '[', '}', ']',
    '{"__proto__":{"a":1},"b":2}', '{"__proto__":null}', '{"__proto__":1,"x":2}', '{"__proto__":[1]}', '{"a":{"__proto__":{"plugin":["x"]}}}', '{"__proto__":{},"__proto__":{"z":1}}',
    '{"a":1,"a":2}', '{"b":1,"a":2,"b":3}', '{"2":1,"1":2,"b":3,"01":4,"4294967295":5,"4294967294":6}', '"just a string"', '42', 'true', 'null', '1 2', '{} {}', '// only a comment',
    '/* only */', '/* unclosed', '/*', '/', '//', '{"a":1} // trailing', '{"a":/* c */1}', '{"a":1}\r\n', '\r\n{\r\n  "a": 1\r\n}\r\n', '{\r"a":1\r}', '"\\u00"', '"\\uD800"', '"\\uDE00\\uD83D"',
    '"\\q"', '"a\nb"', '"a\tb"', '"\u0001"', '-', '-1', '--1', '1.', '1.e3', '.5', '1e', '1e+', '0123', '-0', '1e400', '-1e400', 'tru', 'nulll', 'True', '{"a":true false}', '[{]}', '{[}]',
    nest(511, '[', ']'), nest(512, '[', ']'), nest(513, '[', ']'), nest(512, '{"a":', '}'), nest(600, '[', ']', ''), `[${'1,'.repeat(300)}1]`, `"${'x'.repeat(2000)}"`,
  ];
  fixed.forEach((text, index) => add(`fixed-${index}`, text));
  NUMBER_TEXTS.forEach((text, index) => add(`number-${index}`, `[${text}]`));
  // `"__proto__"` is the prototype setter only while the lookup reaches Object.prototype: a null
  // prototype, or a prototype with its own "__proto__", makes it an own property (found by the differential run).
  ['{"__proto__":null,"__proto__":1}', '{"__proto__":null,"__proto__":{"x":1}}', '{"__proto__":{"__proto__":2},"__proto__":3}', '{"__proto__":[],"__proto__":null}',
    '{"__proto__":{"__proto__":null},"__proto__":4}', '{"a":{"__proto__":null,"__proto__":null}}'].forEach((text, index) => add(`proto-chain-${index}`, text));
  while (out.length < count * 2) {
    const index = out.length;
    let text = `${d.pick(['', '', '﻿', ' ', '\n'])}${d.pick(TRIVIA)}${jsoncValue(d)}${d.pick(TRIVIA)}`;
    if (d.chance(0.25)) text = mutate(d, text, '{}[],:"/*\n\r \t\\ab1-.e'.split(''));
    if (d.chance(0.1)) text = text.replace(/\n/g, d.pick(['\r\n', '\r']));
    add(`seeded-${index}`, text);
  }
  return out.slice(0, Math.max(count * 2, out.length));
}

export const HEADER = ['# Generated by generate-config-jsonc.mjs; do not edit. name, operation, input (base64 of WTF-8), result (base64 of WTF-8): jsonc-parse gives describe(value) and the errors, jsonc-strip the text.'];

/** What the tracked file holds: `TRACKED / 2` cases from the seed. */
export const GENERATOR = Object.freeze({ script: 'generate-config-jsonc.mjs', file: FILE, header: HEADER, cases, trackedCount: TRACKED / 2, seed: SEED });

if (isMain(import.meta.url)) runGenerator(GENERATOR);
