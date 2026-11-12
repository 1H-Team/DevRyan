#!/usr/bin/env node
// Writes json.tsv: seeded JSON texts and what Node does with them, so
// `cargo test` (tests/json.rs) checks ledger_core::js::{parse, stringify}
// against V8 without JavaScript. Command line: vector-tools.mjs.
//
// One case per line: name, the input text (base64 of its WTF-8 bytes, so raw
// lone surrogates survive), and base64 of the UTF-8 of
// JSON.stringify(JSON.parse(input)), or `!` where JSON.parse throws (the Rust
// must refuse those), or `deep` where Node accepts a value nested deeper than
// the Rust's fixed bound JSON_MAX_DEPTH (src/js/json.rs MAX_DEPTH, a
// deliberate difference; the Rust must refuse those as too deep). A first
// `bound` row states the bound the file was written for. Inputs stress every rule of research file 28 §4.3:
// index-like keys in every position, `__proto__`, duplicate keys, raw and
// escaped lone surrogates and pairs, every control character, U+2028 and
// U+2029, random doubles and subnormals, integers around 2^53, the 1e21 and
// 1e-7 layout boundaries, -0, deep nesting, empty containers, long strings,
// whitespace, and mutated (mostly malformed) texts.
import { KNOWN_ENGINE_DISCREPANCIES } from './known-engine-discrepancies.mjs';
import { b64, drawer, isMain, random, runGenerator, wtf8, vectorDocument } from './vector-tools.mjs';

export const JSON_FILE = 'json.tsv';
export const JSON_SEED = 20261112;
export const JSON_TRACKED = 3000;

/** The Rust's nesting bound (`ledger_core::js::MAX_DEPTH`); tests/json.rs checks they agree. */
export const JSON_MAX_DEPTH = 512;

/** Containers nested in a parsed value (`[]` is 1, a scalar 0), without recursion. */
export function nestingDepth(root) {
  let deepest = 0;
  const pending = [[root, 1]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (value === null || typeof value !== 'object') continue;
    deepest = Math.max(deepest, depth);
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  return deepest;
}

/** Node's answer for one input: the stringify text, null when parse throws, and the depth. */
export function nodeRoundTrip(text) {
  let value;
  try { value = JSON.parse(text); } catch { return { output: null, depth: 0 }; }
  return { output: JSON.stringify(value), depth: nestingDepth(value) };
}

export function renderRow(name, input) {
  const { output, depth } = nodeRoundTrip(input);
  const expected = output === null ? '!' : depth > JSON_MAX_DEPTH ? 'deep' : b64(Buffer.from(output, 'utf8'));
  return `${name}\t${b64(wtf8(input))}\t${expected}`;
}

const NUMBER_EDGES = ['0', '-0', '0.0', '-0.0', '0e0', '-0E-0', '1e21', '1e+21', '1E21', '9.999999999999999e20', '999999999999999999999',
  '100000000000000000000', '123456789012345680000', '1e-7', '1e-6', '0.000001', '0.0000001', '1.5e-7', '-1e-7', '123e-20', '5e-324',
  '4.9e-324', '2.4703282292062328e-324', '2.4703282292062327e-324', '2.2250738585072014e-308', '2.225073858507201e-308',
  '1.7976931348623157e308', '1.7976931348623158e308', '1.7976931348623159e308', '1e308', '1e309', '-1e400', '1e-400', '1e99999999999999999999',
  '9007199254740991', '9007199254740992', '9007199254740993', '9007199254740994', '-9007199254740993', '18014398509481985', '0.1', '0.30000000000000004',
  '1E5', '1e-0', '1E+0', '12345678901234567890123456789', '0.000000000000000000000000000000000001', '4294967295', '4294967296', '1.0', '100', '1e2', '-5e-7'];

/** A number written in one of JSON's spellings. */
function numberText(d) {
  const { int, pick, chance, next } = d;
  const roll = next();
  if (roll < 0.15) return pick(NUMBER_EDGES);
  if (roll < 0.45) {
    // A random double from random bits, written as String(x) or another exact spelling.
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, Math.floor(next() * 2 ** 32)); view.setUint32(4, Math.floor(next() * 2 ** 32));
    if (chance(0.15)) view.setUint16(0, view.getUint16(0) & 0x800f); // a subnormal (or zero)
    const x = view.getFloat64(0);
    if (!Number.isFinite(x)) return '1e400';
    const forms = [String(x), x.toExponential(), x.toExponential(int(21)), x.toPrecision(1 + int(21)).replace(/^(-?)\./, '$10.')];
    const text = pick(forms);
    return chance(0.2) ? text.replace('e', 'E') : text;
  }
  if (roll < 0.55) return String(2 ** 53 + int(41) - 20).replace(/^/, chance(0.3) ? '-' : '');
  if (roll < 0.7) {
    // Near a power of ten, around both layout boundaries.
    const exponent = pick([-8, -7, -6, -5, 0, 1, 15, 16, 17, 20, 21, 22, int(600) - 300]);
    const x = (1 + (next() - 0.5) * 10 ** -int(17)) * 10 ** exponent;
    return Number.isFinite(x) ? String(x) : '1';
  }
  // Random decimal digits with an optional fraction and exponent.
  const digits = (n) => Array.from({ length: n }, () => int(10)).join('');
  let text = chance(0.3) ? '-' : '';
  text += chance(0.2) ? '0' : `${1 + int(9)}${digits(int(25))}`;
  if (chance(0.5)) text += `.${digits(1 + int(25))}`;
  if (chance(0.5)) text += `${pick(['e', 'E'])}${pick(['', '+', '-'])}${int(chance(0.8) ? 30 : 450)}`;
  return text;
}

const CONTROL = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code));
const RAW_UNITS = ['a', 'b', 'z', 'A', 'Z', '0', '9', ' ', '/', '\x7f', '\u0080', '\u00e9', '\u00ff', '\u0100', '\u2028', '\u2029', '\u4e2d', '\ufeff', '\ufffd',
  '\uffff', '\u{1f600}', '\u{10000}', '\u{10ffff}', '\ud800', '\udbff', '\udc00', '\udfff', '\ud83d', '\ude00', '\uff5e', "'", '`', '<', '>', '&', '{', '}', '[', ']', ':', ','];
const hex4 = (code, upper) => { const text = code.toString(16).padStart(4, '0'); return upper ? text.toUpperCase() : text; };

/** A JSON string literal with `units` drawn from every class, raw or escaped. */
function stringText(d, length = d.int(12)) {
  const { int, pick, chance, next } = d;
  let out = '"';
  for (let index = 0; index < length; index += 1) {
    const roll = next();
    if (roll < 0.45) out += pick(RAW_UNITS);
    else if (roll < 0.6) out += pick(['\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t']);
    else if (roll < 0.75) out += `\\u${hex4(int(32), chance(0.5))}`; // every control character, escaped
    else if (roll < 0.85) out += `\\u${hex4(pick([0xd800, 0xdbff, 0xdc00, 0xdfff, 0xd83d, 0xde00, 0x2028, 0x2029, 0x7f, 0x22, 0x5c, 0x2f, 0xfeff]) + (chance(0.3) ? int(16) : 0), chance(0.5))}`;
    else if (roll < 0.9) out += `\\u${hex4(0xd800 + int(1024), chance(0.5))}\\u${hex4(0xdc00 + int(1024), chance(0.5))}`; // an escaped pair
    else out += String.fromCharCode(0x20 + int(0x7f - 0x20)).replace(/["\\]/, 'q');
  }
  return `${out}"`;
}

const KEYS = ['0', '1', '2', '9', '10', '42', '99', '100', '4294967294', '4294967295', '4294967296', '01', '00', '-1', '-0', '1.5', '1e3', ' 1', '1 ',
  '9007199254740993', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'length', 'prototype', '', 'a', 'b', 'id', 'key', 'value', 'Z', 'é', '\u{1f600}'];

function keyText(d, used) {
  const { int, pick, chance } = d;
  if (used.length && chance(0.2)) return pick(used); // a duplicate key
  const roll = d.next();
  let key;
  if (roll < 0.45) key = JSON.stringify(pick(KEYS));
  else if (roll < 0.6) key = JSON.stringify(String(int(chance(0.5) ? 20 : 2 ** 32 + 5)));
  else if (roll < 0.68) key = `"\\u00${pick(['30', '31', '39'])}${pick(['', '0', '1'])}"`; // an index spelled with an escape
  else if (roll < 0.72) key = '"__\\u0070roto__"';
  else key = stringText(d, int(6));
  used.push(key);
  return key;
}

const ws = (d) => (d.chance(0.75) ? '' : d.pick([' ', '\t', '\n', '\r', '  ', ' \n\t ', '\r\n']));

function valueText(d, depth) {
  const { int, chance, next } = d;
  const roll = next();
  if (depth > 0 && roll < 0.22) {
    const used = [], entries = [];
    const count = depth > 1 ? int(4) : chance(0.03) ? int(24) : int(6);
    for (let index = 0; index < count; index += 1) entries.push(`${ws(d)}${keyText(d, used)}${ws(d)}:${ws(d)}${valueText(d, depth - 1)}${ws(d)}`);
    return `{${entries.join(',')}${entries.length ? '' : ws(d)}}`;
  }
  if (depth > 0 && roll < 0.42) {
    const items = Array.from({ length: depth > 1 ? int(4) : chance(0.03) ? int(24) : int(6) }, () => `${ws(d)}${valueText(d, depth - 1)}${ws(d)}`);
    return `[${items.join(',')}${items.length ? '' : ws(d)}]`;
  }
  if (roll < 0.62) return numberText(d);
  if (roll < 0.9) return stringText(d, chance(0.001) ? 1000 + int(3000) : int(14)); // now and then a long string
  return d.pick(['true', 'false', 'null']);
}

/** Deep nesting: arrays, objects or both, around a scalar. */
function deepText(d) {
  // Both sides of the Rust's bound, and beyond it up to 1,500 levels: V8's
  // JSON.stringify recurses and throws a RangeError from about 2,700 levels
  // of index-keyed objects (Node 26, main thread), so deeper cases would not
  // describe what Node writes.
  const depth = d.pick([64, JSON_MAX_DEPTH - 1, JSON_MAX_DEPTH, JSON_MAX_DEPTH + 1, 1000, 1500, d.int(1500)]);
  let open = '', close = '';
  for (let index = 0; index < depth; index += 1) {
    if (d.chance(0.5)) { open += '['; close = `]${close}`; } else { open += `{"${d.pick(['a', '0', '__proto__'])}":`; close = `}${close}`; }
  }
  return `${open}${valueText(d, 0)}${close}`;
}

const MUTATION_UNITS = ['{', '}', '[', ']', ',', ':', '"', '\\', ' ', '\n', '0', '-', '+', '.', 'e', 'E', 'x', 'n', 't', 'u', '\u00a0', '\ufeff', '\u2028', '\x00', '\x1f', '\ud800', '/'];

/** One edit to a text (most results are malformed; Node decides). */
function mutate(d, text) {
  const { int, pick, next } = d;
  const at = int(text.length + 1);
  const roll = next();
  if (roll < 0.3 && text.length) return text.slice(0, at) + text.slice(at + 1);
  if (roll < 0.6) return text.slice(0, at) + pick(MUTATION_UNITS) + text.slice(at);
  if (roll < 0.75) return text.slice(0, at);
  if (roll < 0.9 && text.length) return text.slice(0, at) + pick(MUTATION_UNITS) + text.slice(at + 1);
  return `${text}${pick(MUTATION_UNITS)}`;
}

/** Known engine discrepancies met by the last renderJson call (run-extended.mjs reports them). */
export const knownDiscrepanciesSeen = [];

/**
 * A rendered row, after the known-engine-discrepancy list
 * (known-engine-discrepancies.mjs): a listed row rendered under its engine
 * must show exactly the listed answer, and is written with the
 * specification's answer under the name `known-engine-discrepancy:<id>:<row>`.
 */
export function applyKnownDiscrepancies(row) {
  const [name, input, output] = row.split('\t');
  const entry = KNOWN_ENGINE_DISCREPANCIES.find((known) => known.seed === JSON_SEED && known.row === name);
  if (!entry) return row;
  const update = 'update tests/known-engine-discrepancies.mjs';
  if (input !== entry.input) throw new Error(`Known engine discrepancy ${entry.id}: ${name} no longer has the listed input (the generator changed): ${update}`);
  if (!process.versions[entry.engine]) return row;
  const engine = `${entry.engine} ${process.versions[entry.engine]}, Node ${process.version}, V8 ${process.versions.v8}`;
  if (output === entry.specification) throw new Error(`Known engine discrepancy ${entry.id}: ${engine} now agrees with the specification on ${name}: ${update}`);
  if (output !== entry.observed) throw new Error(`Known engine discrepancy ${entry.id}: ${engine} disagrees on ${name} differently from the listed answer (${output}): ${update}`);
  knownDiscrepanciesSeen.push({ id: entry.id, row: name, engine });
  return [`known-engine-discrepancy:${entry.id}:${name}`, input, entry.specification].join('\t');
}

/** Hand-picked cases first: each rule of §4.3 once, plainly. */
export const FIXED_CASES = [
  '{"b":1,"4294967295":2,"4294967294":3,"1":4,"01":5,"-0":6,"0":7,"__proto__":8,"b":9,"10":10,"9":11}',
  '{"__proto__":{"a":1},"a":2}', '{"a":1,"a":2,"a":{"b":3}}', '{"\\u0030":1,"0":2}', '{"x":1,"5":2,"x":3}',
  '"\\ud800"', '"\ud800"', '"\\udc00\\ud800"', '"\\ud83d\\ude00"', '"\ud83d\ude00"', '"\u2028\u2029"', '"\\u2028"', '"\\/"', '"\x7f"',
  `"${Array.from({ length: 32 }, (_, code) => `\\u${hex4(code, false)}`).join('')}"`, '[1e21,1e-7,-0,5e-324,1e400,-1e400,1e-400]',
  '[]', '{}', '[[]]', '[{}]', '{"a":[]}', ' \t\n\r[ ] ', '""', '"\\u0000"', 'true', 'false', 'null', '0', '-0', '1E5', '[1,2,]', '{"a":1,}',
  '01', '1.', '.5', '+1', '-', '1e', '1e+', '0x1', '"\\x"', '"\\u12"', ' \u00a0 1', '\ufeff1', '"\t"', '1 2', 'nul', '[]x', '', ' ',
  '\ud800', '{"a" 1}', '{1:2}', "{'a':1}", '[1 2]', '"\\U0041"', '"\\u00e9"', '["a",]', '{"a":1}}', '[[[]]', ...CONTROL.map((unit) => `"${unit}"`),
  '['.repeat(JSON_MAX_DEPTH) + ']'.repeat(JSON_MAX_DEPTH), '['.repeat(JSON_MAX_DEPTH + 1) + ']'.repeat(JSON_MAX_DEPTH + 1),
  `${'{"0":'.repeat(JSON_MAX_DEPTH)}[]${'}'.repeat(JSON_MAX_DEPTH)}`, `${'{"0":'.repeat(JSON_MAX_DEPTH - 1)}[]${'}'.repeat(JSON_MAX_DEPTH - 1)}`,
];

export function renderJson(count) {
  knownDiscrepanciesSeen.length = 0;
  const d = drawer(random(JSON_SEED));
  const rows = [`bound\t${JSON_MAX_DEPTH}\t-`, ...FIXED_CASES.map((input, index) => renderRow(`fixed-${index}`, input))];
  for (let index = 0; index < count; index += 1) {
    const roll = d.next();
    let input;
    if (roll < 0.004) input = deepText(d);
    else input = `${ws(d)}${valueText(d, 1 + d.int(4))}${ws(d)}`;
    let name = `random-${index}`;
    if (roll > 0.85) { input = mutate(d, input); name = `mutated-${index}`; }
    rows.push(applyKnownDiscrepancies(renderRow(name, input)));
  }
  return vectorDocument(['# Generated by generate-json.mjs; do not edit. name, input (base64 of WTF-8), Node JSON.stringify(JSON.parse(input)) (base64 of UTF-8) or ! when it throws.'], rows);
}

if (isMain(import.meta.url)) runGenerator({ file: JSON_FILE, render: renderJson, trackedCount: JSON_TRACKED });
