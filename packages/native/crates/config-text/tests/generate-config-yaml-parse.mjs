#!/usr/bin/env node
// Writes config-yaml-parse.tsv: what yaml.parse(source) returns, emits as
// warnings and throws, for the front matter of the repository's agent and
// skill files, a workflow and cloudflared-style configurations, and seeded
// documents: every scalar style and escape, block scalar headers, flow and
// block collections, anchors, aliases and their limits, tags and directives,
// comments everywhere, every line ending, tabs, a byte-order mark, document
// markers, several documents, duplicate and long keys, deep nesting, and
// mutated, mostly malformed, documents. The cases the crate leaves to
// JavaScript are rows whose result is `unsupported`.
// Command line: config-text-tools.mjs.
import { drawer, isMain, mutate, runGenerator } from './config-text-tools.mjs';
import { YAML_STRINGS, longString, randomString, repoFixtures } from './config-text-inputs.mjs';

export const FILE = 'config-yaml-parse.tsv';
export const SEED = 20261114;
export const TRACKED = 1200;

const PLAIN = ['a', 'two words', 'x:y', 'a-b', '1', '-1', '+12', '007', '0o17', '0o8', '0x1F', '0xg', '1.5', '1.', '.5', '-.5', '1e3', '1E-3', '.5e1', '5.e2', '1_000', '.inf', '-.Inf',
  '+.INF', '.nan', '.NaN', '.NAN', '.Nan', 'true', 'True', 'TRUE', 'tRUE', 'false', 'yes', 'no', 'on', 'null', 'Null', 'NULL', '~', '12:30', '2001-12-14', '123456789012345678901234567890',
  '0x1234567890abcdef1', '0o7777777777777777777777', '9007199254740993', '1e400', '-0', '-0.0', 'é', '中文', '\ud83d\ude00', 'a b c', 'a  b', 'trailing ', 'http://x:80/y', 'a#b', '@x', '`x',
  '%x', '|x', ',x', '\tx'];

const DQ = ['"plain"', '"esc \\n \\t \\\\ \\" \\/ \\0 \\a \\b \\e \\f \\r \\v \\N \\_ \\L \\P \\ "', '"\\x41\\u00e9\\U0001F600"', '"\\uD800"', '"\\uDE00x"', '"\\U00110000"', '"\\x4"',
  '"\\q"', '"a\n  b"', '"a\n\n  b"', '"a \\\n  b"', '"a\\\r\n  b"', '"tab\\\tx"', '"unterminated', '""', '"a"b"', '"x\\"', '"\t lead"', '"trail \t"', '"\\u00"', '"\\U0000004"'];
const SQ = ["'plain'", "'it''s'", "''", "'a\n  b'", "'a\n\n  b'", "'unterminated", "'''", "'x'y'", "'  spaced  '", "'#not comment'", "'a\r\n  b'"];
const BLOCK_HEADERS = ['|', '|-', '|+', '>', '>-', '>+', '|2', '>1', '|1-', '>+2', '|0', '|10', '|-+', '|x', '| # c', '>#c', '|\t'];
/** Constructs the crate leaves to JavaScript, drawn rarely. */
const EXOTIC = ['!!binary aGk=', '!!timestamp 2001-12-14', '!!merge x', '!<constructor> x', '!<toString> y', '!!set {a, b}', '!!omap [a: 1]', '!!pairs [a: 1]', '? [a, b]'];

const KEYS = ['name', 'description', 'mode', 'model', 'temperature', 'tools', 'permission', '"*"', 'question_*', "'quoted key'", '"dq key"', 'a', 'b', '1', '"1"', '01', '__proto__', 'toString',
  'constructor', '~', 'null', 'true', '1.0', '.inf', '"" ', 'key with spaces', 'é', '-x', '? x'];

function indentLines(text, pad) {
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

function blockScalar(d, pad) {
  const header = d.pick(BLOCK_HEADERS);
  const lines = d.repeat(1 + d.int(4), () => d.pick(['text', 'more text', '  indented', '\tTab', '', '', 'a: b', '# no comment', 'long '.repeat(1 + d.int(30)), '-x', '...']));
  const trailing = d.pick(['', '\n', '\n\n', '\n  \n']);
  const inner = pad + d.pick(['  ', '  ', ' ', '    ', '']);
  return `${header}\n${lines.map((line) => (line ? inner + line : d.chance(0.3) ? inner : '')).join('\n')}${trailing}`;
}

function scalar(d, pad) {
  const roll = d.int(12);
  if (roll < 4) return d.pick(PLAIN);
  if (roll < 6) return d.pick(DQ).replace(/\n/g, `\n${pad}`);
  if (roll < 7) return d.pick(SQ).replace(/\n/g, `\n${pad}`);
  if (roll < 8) return blockScalar(d, pad);
  if (roll < 9) return JSON.stringify(d.chance(0.5) ? randomString(d) : longString(d));
  if (roll < 10) {
    if (d.chance(0.04)) return d.pick(EXOTIC);
    return d.pick(['*a', '*b', '*missing', '*', '*a:', '&a x', '&a', '&b 1', '& x', '&a &b x', '!!str 1', '!!int 1', '!!int x', '!!float 1', '!!float 1.5', '!!bool yes',
      '!!null ""', '!!null ~', '!local x', '!<tag:yaml.org,2002:str> 1', '!<!> x', '!<x', '!e!x x', '!! x', '!!str%20x y', '!!str%zz x', '!!str &a x', '&a !!str x', '!!map [a]', '!!seq {a: 1}',
      '!!set x', '!<toString> [y]', '!<__proto__> {a: 1}']);
  }
  if (roll < 11) return d.pick(['', ' # comment', '#nospace', '[]', '{}', '[a, b]', '[a, b,]', '{a: 1, b: [x, y]}', '{a: 1,, b}', '[a: 1, b]', '[? a : b]', '{a, b: }', '[a\n,b]', '{ "a" :1}',
    '[*a, *a]', '[a, [b, [c]]]', '{a: {b: {c: d}}}', '[,]', '[a b]', '{a: 1 b: 2}']);
  return d.pick(YAML_STRINGS.filter((s) => !s.includes('\n')));
}

function mapping(d, depth, pad) {
  const lines = [];
  for (let index = 1 + d.int(5); index > 0; index -= 1) {
    const key = d.chance(0.95) ? d.pick(KEYS) : d.pick(['? complex', '? {a: 1}', '- x', '[a]', '&k a', '*k']);
    const roll = d.int(depth > 3 ? 6 : 10);
    const comment = d.chance(0.1) ? d.pick([' # c', '#bad', ' #']) : '';
    if (roll < 6) lines.push(`${pad}${key}: ${scalar(d, `${pad}  `)}${comment}`);
    else if (roll < 8) lines.push(`${pad}${key}:${comment}\n${mapping(d, depth + 1, `${pad}${d.pick(['  ', '  ', '    ', ' ', '\t'])}`)}`);
    else lines.push(`${pad}${key}:${comment}\n${sequence(d, depth + 1, d.chance(0.5) ? pad : `${pad}  `)}`);
    if (d.chance(0.1)) lines.push(d.pick(['', `${pad}# comment`, '#', `${pad}  # indented`, '  ']));
  }
  return lines.join('\n');
}

function sequence(d, depth, pad) {
  return d.repeat(1 + d.int(4), () => {
    const roll = d.int(depth > 3 ? 6 : 9);
    if (roll < 6) return `${pad}- ${scalar(d, `${pad}  `)}`;
    if (roll < 8) { const inner = mapping(d, depth + 1, `${pad}  `); return `${pad}- ${inner.slice(pad.length + 2)}`; }
    return `${pad}- ${d.pick(['- nested', '[x]', '{}', '|\n' + pad + '  block'])}`;
  }).join('\n');
}

function document(d) {
  const roll = d.int(10);
  let body = roll < 6 ? mapping(d, 0, '') : roll < 8 ? sequence(d, 0, '') : scalar(d, '');
  if (d.chance(0.15)) body = `${d.pick(['---\n', '--- ', '--- # c\n', '%YAML 1.2\n---\n', d.chance(0.2) ? '%YAML 1.1\n---\n' : '%YAML 1.2\n---\n', '%YAML 2.0\n---\n', '%TAG !e! tag:example.com,2000:\n---\n', '%FOO bar\n---\n', '%YAML 1.2\n'])}${body}`;
  if (d.chance(0.08)) body += d.pick(['\n...\n', '\n---\nsecond: doc\n', '\n...', '\n--- \n', '\n... # end\n', '\n---\n---\n']);
  if (d.chance(0.05)) body = `\ufeff${body}`;
  if (d.chance(0.1)) body = body.replace(/\n/g, d.pick(['\r\n', '\r\n', '\r']));
  if (d.chance(0.04)) body = body.replace(/  /g, '\t');
  return body + d.pick(['', '\n', '\n', '\n\n', ' ']);
}

const CLEAN_KEYS = ['name', 'description', 'mode', 'model', 'temperature', 'tools', 'permission', '"*"', 'question_*', 'read', 'bash', 'a', 'b', '1', '"x y"', 'é', 'variant', 'hidden'];
const CLEAN_VALUES = ['allow', 'deny', 'ask', 'primary', 'subagent', 'openai/gpt-5', '0.2', '1', 'true', 'false', 'null', '~', '"quoted"', "'single'", '"esc\\tx"', '0x1F', '1e3', '.inf', 'two words',
  '"a: b"', "'it''s'", 'é', '[a, b]', '{a: 1}', '[]', '{}', '""', '&anchor shared'];

/** A front-matter-like document that mostly parses. */
function cleanDocument(d, depth = 0, pad = '') {
  const used = new Set();
  return d.repeat(1 + d.int(6), () => {
    let key = d.pick(CLEAN_KEYS);
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    const roll = d.int(depth > 2 ? 7 : 10);
    if (roll < 6) return `${pad}${key}: ${d.pick(CLEAN_VALUES)}`;
    if (roll < 7) return `${pad}${key}: ${d.pick(['|', '>', '|-', '>-', '|+'])}\n${pad}  ${longString(d).replace(/\n/g, `\n${pad}  `)}`;
    if (roll < 9) return `${pad}${key}:\n${cleanDocument(d, depth + 1, `${pad}  `)}`;
    return `${pad}${key}:\n${d.repeat(1 + d.int(3), () => `${pad}  - ${d.pick(CLEAN_VALUES)}`).join('\n')}`;
  }).join('\n');
}

const nestFlow = (depth) => `${'['.repeat(depth)}x${']'.repeat(depth)}`;
const nestBlock = (depth) => Array.from({ length: depth }, (_, level) => `${' '.repeat(level)}k${level}:`).join('\n') + ' v';

export function cases({ count, seed }) {
  const d = drawer(seed);
  const out = [];
  const add = (name, source) => out.push([name, 'yaml-parse', [source]]);
  for (const [file, text] of repoFixtures()) {
    if (file.endsWith('.md')) {
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      if (match) { add(`repo-${file}`, match[1]); add(`repo-crlf-${file}`, match[1].replace(/\n/g, '\r\n')); }
    } else if (/\.ya?ml$/.test(file)) add(`repo-${file}`, text);
    else add(`repo-json-${file}`, text);
  }
  const fixed = [
    '', ' ', '\n', '#', '# only comment\n', '---', '---\n', '...', '...\n', '--- |\n  x\n', '\ufeff', '\ufeffa: 1', 'a: 1\ufeff', '%YAML 1.2\n', '%YAML 1.1\n', '%YAML 1.1\n---\na: yes\n',
    '%YAML 1.2\n---\na: 1\n...\n%YAML 1.1\n---\nb: no\n', '%TAG !e! tag:e,2000:\n--- !e!x 1\n', '%TAG ! !local-\n--- !x 1\n', '%TAG\n---\n1', '%YAML\n---\n1', 'a: 1\n---\nb: 2\n', 'a: 1\n---\nb: 2\n---\nc: 3\n',
    'tunnel: abc\ncredentials-file: /x/y.json\ningress:\n  - hostname: app.example.com\n    service: http://localhost:3000\n  - service: http_status:404\n',
    '{"tunnel": "x", "ingress": [{"hostname": "h.example.com", "service": "http://localhost:1"}]}', 'ingress: [}', 'ingress:\n  - hostname: [\n',
    'a: &x 1\nb: *x\n', 'a: *x\nb: &x 1\n', 'a: &x [1, 2]\nb: *x\nc: *x\n', 'a: &a\n  b: *a\n', '&a [*a]', '&a {k: *a}', 'a: &a 1\nb: &a 2\nc: *a\n', 'a: &a: 1\n', 'a: *a:\n',
    `a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n`,
    `a: &a [x]\nb: [${Array(99).fill('*a').join(', ')}]\n`, `a: &a [x]\nb: [${Array(100).fill('*a').join(', ')}]\n`, `a: &a x\nb: [${Array(150).fill('*a').join(', ')}]\n`,
    'a: 1\na: 2\n', '1: a\n"1": b\n', '1: a\n1.0: b\n', '~: a\nnull: b\n', ': a\n: b\n', '.nan: a\n.nan: b\n', '-0: a\n0: b\n', '{a: 1, a: 2}', '[a: 1, a: 2]',
    'b: 1\na: 2\n2: x\n1: y\n__proto__: p\ntoString: t\n', '__proto__:\n  polluted: true\n', '? [a, b]\n: c\n', '? {a: 1}\n: c\n', '[a, b]: c\n', '? a\n? b\n', '? a\n: 1\n? b\n',
    `${'k'.repeat(1030)}: v\n`, `"${'k'.repeat(1030)}": v\n`, `[${'k'.repeat(1030)}: v]`, 'a:\tb\n', 'a:\n\t- b\n', '\ta: b\n', 'a: b\t\n', '- a\n-\tb\n', 'a: b: c\n', 'a: - b\n',
    'a:\n- b\n- c\n', 'a:\n  - b\n - c\n', '- a\n  - b\n', 'a: 1\n b: 2\n', ' a: 1\nb: 2\n', 'a: |\n  x\n b\n', 'a: >\n\n  x\n', 'a: |\n   \n  x\n', 'a: |2\n   x\n', '- |\nx\n',
    '|\nx\n', 'a: [1,\n2]\n', 'a: [1,\n  2]\n', 'a: {b: 1\n  }\n', 'a: [b\n]\n', '[\n]\n', '{\n}', 'a: "x\n  y"\n', "a: 'x\n\n  y'\n", 'a: x\n  y\n   z\n', 'a: x\n\n  y\n', 'a: x # c\n  y\n',
    'a: !!str\n  - x\n', 'a: &x\n  - y\n', 'a: !!str &x\n  - y\n', '- &x\n  a: 1\n- *x\n', 'a:\n  # c\n  b: 1\n', 'a: 1 #c\n#d\nb: 2\n', 'a: 1\n  # indented\nb: 2\n', 'x: #c\n  y\n',
    '- # c\n  a\n', 'a: b\n...\nc: d\n', '--- a\n--- b\n', '- a\n... x\n', '[a, b] # c\n', '"a" : b\n', "'a': b\n", '"a":b\n', '{a:b}', '{"a":b}', '[a:b]', '{a: b}: c\n', '[a]: b\n',
    '*a', '&a', '!x', '!!str', '!', '! a', '!!int', '- !!int\n', 'a: !<tag:yaml.org,2002:int> 0x1F\n', 'a: !<tag:yaml.org,2002:float> 1\n', 'a: !!float .5\n', 'a: !!int -0\n', 'a: !!bool True\n',
    '@a', '`a', '%a', 'a: @b', ',a', 'a: ,b', '- ,a', '|a', '>a', 'a: |a\n', 'a: >1-\n  x\n', 'a: |+\n  x\n\n\n', 'a: |-\n  x\n\n', 'a: >+\n\n', 'a: |\n', 'a: >\n  x\n   y\n  z\n\n  w\n',
    'a: >\n  x\n\n   y\n\n  z\n', 'a: >\n\tx\n', 'a: |\n  x\r\n  y\r\n', 'a: "\\\n"', 'a: "x\\\n  y"', 'a: "\\u263A\\x41"', 'a: "\\U0010FFFF"', 'a: "\\uDBFF\\uDFFF"', '"\u2028"', "'\u2028'",
    nestFlow(63), nestFlow(64), nestFlow(65), nestFlow(300), nestBlock(30), nestBlock(65), `${'- '.repeat(63)}x`, `${'- '.repeat(64)}x`, `${'- '.repeat(65)}x`, `${'{a: '.repeat(64)}x${'}'.repeat(64)}`, `${'? '.repeat(100)}x`, nestFlow(3000),
    `a: ${'x'.repeat(200)}: y\n`, `${'x '.repeat(70)}a: b: c\n`, `${' '.repeat(100)}\ta: b\n`, `a: 1\n${'b'.repeat(90)}\n`, '\r', 'a: 1\rb: 2\r', 'a\r\n: 1', 'a: "\r\n"',
  ];
  fixed.forEach((source, index) => add(`fixed-${index}`, source));
  // Block scalars whose trailing blank lines are more indented than the content.
  ['>-\nmore text\n  \n ', '|\n  a\n   \n  ', '>\n x\n  \n   \n', 'a: |-\n  x\n    \n   \n', '|+\n a\n  \n \n'].forEach((source, index) => add(`block-trailing-${index}`, source));
  // Plain scalars ending at `:` before a flow indicator, and every number grammar.
  ['[a:]', '{a:, b}', '[a:[b]]', '{a:}', '[x:,y]', '{a:{b}}', '[a::]', '{"a"::b}'].forEach((source, index) => add(`flow-colon-${index}`, source));
  ['1e20', '1e21', '100000000000000000000', '123456789012345680000', '1e-6', '1e-7', '0.000001', '0x10000000000000', '0o1000000000000000000'].forEach((source, index) => add(`number-${index}`, `n: ${source}\n`));
  // Error context around the 80-unit cut, at the start of a line and past column 60.
  for (const length of [79, 80, 81, 82, 120]) add(`context-${length}`, `k: @${'a'.repeat(length - 4)}\nnext: 1\n`);
  for (const column of [59, 60, 61, 100]) add(`context-column-${column}`, `${'a'.repeat(column)}: @x ${'b'.repeat(70)}\n`);
  add('context-previous-line', `${'p'.repeat(90)}\n  @x\n`);
  // %TAG directives with too few and too many parts (the handle still applies).
  ['%TAG !e! tag:e,2000: extra\n--- !e!x 1\n', '%TAG !e!\n--- !e!x 1\n', '%TAG !e! tag:e,2000:\n%TAG !e! tag:f,2000:\n--- !e!x 1\n'].forEach((source, index) => add(`tag-directive-${index}`, source));
  while (out.length < count) {
    const index = out.length;
    let source = d.chance(0.35) ? `${cleanDocument(d)}\n` : document(d);
    if (source.includes('&anchor') && d.chance(0.6)) source += `alias_${index}: *anchor\n`;
    if (d.chance(0.12)) source = mutate(d, source, ':-?#&*!|>"\'[]{},%@`\n\r\t \\'.split(''));
    add(`seeded-${index}`, source);
  }
  return out;
}

export const HEADER = ['# Generated by generate-config-yaml-parse.mjs; do not edit. name, operation, source (base64 of WTF-8), result (base64 of WTF-8): `warn<TAB>code<TAB>message` lines, then `value<TAB>description` or `throw<TAB>name<TAB>code<TAB>message`; or `unsupported`.'];

/** What the tracked file holds: `TRACKED` cases from the seed. */
export const GENERATOR = Object.freeze({ script: 'generate-config-yaml-parse.mjs', file: FILE, header: HEADER, cases, trackedCount: TRACKED, seed: SEED });

if (isMain(import.meta.url)) runGenerator(GENERATOR);

