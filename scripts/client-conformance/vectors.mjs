#!/usr/bin/env node
// Cross-language codec vectors: JavaScript values whose encoded bytes a reader
// in another language must read and write back unchanged (lone surrogates,
// -0, Map and Set order, aliasing, holes, integer-like key order, deep
// nesting, long strings, every tag). The tracked file vectors.ndjson is
// generated from VECTORS by this script; nobody edits it by hand.
//   line 1   {"format":"devryan-client-conformance-vectors","version":1,"codec":2}
//   line 2+  {"name":"<vector>","hash":"<16 hex>","tree":<encoded tree>}
//   line 2+  {"name":"<vector>","hash":"<16 hex>","slots":[<tree>, ...]}   one identity scope of several slots
// A reader passes when, for every line, it parses the tree (or the slots, as
// one scope) and writes the whole line back byte-equal, and the hash is the
// SHA-256 prefix of the tree text (or of the slots array text).
//
//   node scripts/client-conformance/vectors.mjs --write   rewrite vectors.ndjson
//   node scripts/client-conformance/vectors.mjs --check   fail on any byte that differs, and on a failed round trip
// Any other argument is a usage error (64) and writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as defaultCodec from './codec.mjs';

export const VECTORS_FILE = fileURLToPath(new URL('./vectors.ndjson', import.meta.url));

class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Tagged extends Map {}
class Stack extends Array {}
class Bytes extends Uint8Array {}
class Counted extends Number {}
class MessageOnPrototype extends Error {}
MessageOnPrototype.prototype.message = 'from the prototype';

const nested = (depth, leaf, wrap) => { let value = leaf; for (let level = 0; level < depth; level += 1) value = wrap(value, level); return value; };

/** [name, () => value]: every value is rebuilt on each call, so vectors never share state. */
export const VECTORS = Object.freeze([
  ['undefined-vs-null', () => ({ absent: undefined, empty: null, list: [undefined, null] })],
  ['undefined-root', () => undefined],
  ['negative-zero', () => ({ zero: 0, negative: -0, list: [-0, 0] })],
  ['non-finite', () => [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
  ['number-layout', () => [1, 1.5, 0.1 + 0.2, 1e21, 1e-7, 123456789012345680000, 5e-324, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, -1.25e-10]],
  ['bigint', () => [0n, -12n, 123456789012345678901234567890n]],
  ['date', () => [new Date(1700000000000), new Date(Number.NaN), new Date(-1)]],
  ['map-insertion-order', () => new Map([['zeta', 1], ['alpha', 2], [3, 'three'], [{ key: true }, 'object key']])],
  ['set-insertion-order', () => new Set(['zeta', 'alpha', 10, 2, 'beta'])],
  ['set-of-maps', () => new Set([new Map([['b', 1]]), new Map([['a', 2]])])],
  ['aliasing-shared', () => { const shared = { id: 's' }; return { left: shared, right: shared, list: [shared] }; }],
  ['aliasing-cycle', () => { const node = { name: 'n' }; node.self = node; node.children = [node]; return node; }],
  ['aliasing-map-value', () => { const shared = ['x']; return new Map([['a', shared], ['b', shared]]); }],
  ['holes', () => { const list = [1, , 3, , , 6]; list.length = 8; return list; }],
  ['hole-only', () => new Array(4)],
  ['array-with-members', () => { const list = ['a', 'b']; list.index = 3; list.input = 'ab'; return list; }],
  ['array-subclass', () => Stack.from([1, 2])],
  ['integer-like-key-order', () => {
    const object = {};
    for (const key of ['b', '10', 'a', '2', '01', '-1', '1.5', '4294967294', '4294967295', '0']) object[key] = key;
    return object;
  }],
  ['dollar-tag-escape', () => ({ $dr: 'map', entries: [] })],
  ['proto-key', () => JSON.parse('{"__proto__":{"polluted":true},"ok":1}')],
  ['null-prototype', () => Object.assign(Object.create(null), { a: 1 })],
  ['lone-surrogates', () => ['\ud800', '\udfff', 'a\ud83db', '\udc00\ud800', '😀']],
  ['split-emoji', () => { const emoji = '😀'; return [emoji.slice(0, 1), emoji.slice(1)]; }],
  ['string-escapes', () => '\u0000\u0001\b\t\n\f\r"\\/\u007f  ﻿'],
  ['long-string', () => `${'ab'.repeat(40000)}😀${'c'.repeat(1000)}`],
  ['deep-object', () => nested(600, 'leaf', (value) => ({ next: value }))],
  ['deep-array', () => nested(600, 0, (value) => [value])],
  ['accessor', () => { const object = { before: 1 }; Object.defineProperty(object, 'lazy', { get() { throw new Error('never called'); }, enumerable: true, configurable: true }); object.after = 2; return object; }],
  ['function', () => ({ named: function onEvent() {}, arrow: () => {}, method() {} })],
  ['class-instance', () => new Point(1, -0)],
  ['map-subclass', () => new Tagged([['k', 'v']])],
  ['errors', () => [new TypeError('bad input'), new Error('wrapped', { cause: new RangeError('inner') }), Object.assign(new Error('with code'), { code: 'E_CODE' })]],
  ['symbols', () => { const one = Symbol('one'); const blank = Symbol(); return [one, Symbol.for('registered'), Symbol.iterator, one, blank]; }],
  ['symbol-keys', () => ({ plain: 1, [Symbol('key')]: 'value' })],
  ['abort-signals', () => [AbortSignal.abort('reason'), new AbortController().signal, AbortSignal.abort(new Error('stopped'))]],
  ['abort-signal-domexception-reason', () => [AbortSignal.abort(new DOMException('stopped', 'AbortError')), AbortSignal.abort(new DOMException('late', 'TimeoutError'))]],
  ['domexceptions', () => [new DOMException('stopped by user', 'AbortError'), new DOMException('late', 'TimeoutError'), new DOMException('plain'), new DOMException('', 'NotFoundError'), new DOMException('custom', 'NoSuchName')]],
  ['error-kinds', () => [new AggregateError([new Error('one'), 'two'], 'many'), new MessageOnPrototype(), Object.assign(new RangeError('named'), { name: 'Renamed' })]],
  ['boxed-primitives', () => [new Number(3), new Number(4), new String('ab'), new Boolean(false), Object(5n), Object.assign(new Number(-0), { extra: 1 }), new Counted(7)]],
  ['platform-values', () => [new URLSearchParams('b=2&a=1&a=3'), new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2), Bytes.from([1, 2]), Object.assign(new Int16Array([1]), { tag: 'x' })]],
  ['response-request', () => [new Response(null, { status: 503, statusText: 'Service Unavailable', headers: { 'X-B': '2', 'x-a': '1' } }), new Request('https://example.invalid/a', { method: 'POST', headers: { accept: 'application/json' } })]],
  ['prototype-chains', () => [Object.create(Object.create(null)), Object.create({}), Object.create(Object.create({ inherited: 1 }))]],
  ['sparse-long-array', () => { const list = []; list[4000000000] = 'far'; list[2] = 'near'; return list; }],
  ['foreign-proxy', () => ({ wrapped: new Proxy({ secret: 1 }, {}) })],
  ['bytes', () => [new Uint8Array([0, 1, 254, 255]), Buffer.from('hi')]],
  ['typed-arrays', () => [new Float64Array([-0, Number.NaN, 1.5]), new Int16Array([-2, 3]), new BigInt64Array([-1n, 2n])]],
  ['array-buffer', () => new Uint8Array([9, 8, 7]).buffer],
  ['regexp', () => { const pattern = /a+b/giu; pattern.lastIndex = 2; return pattern; }],
  ['url-and-headers', () => [new URL('https://example.invalid/a?b=1#c'), new Headers([['X-B', '2'], ['x-a', '1']])]],
  ['weak-and-promise', () => [new WeakMap(), new WeakSet(), Promise.resolve(1)]],
  ['mixed-state', () => {
    const part = { id: 'p1', text: 'hi', time: { start: -0 } };
    return { message: { m1: { id: 'm1', parts: [part] } }, part: { p1: part }, hidden: new Set(['m2', 'm1']), status: new Map([['s1', { type: 'busy' }]]), revert: undefined };
  }],
]);

/**
 * [name, () => [value, ...]]: the slots of one identity scope, each taken
 * (snapshot) in order with mutations between them where the vector says so.
 * They pin how identity crosses slots: "returns its argument" against
 * "returns a copy", aliasing between arguments, result and state.
 */
export const SLOT_VECTORS = Object.freeze([
  ['identity-returns-argument', (take) => { const argument = { k: 1 }; take([argument]); take(argument); take([argument]); }],
  ['identity-returns-copy', (take) => { const argument = { k: 1 }; take([argument]); take({ ...argument }); take([argument]); }],
  ['identity-mutated-between-slots', (take) => { const draft = { list: [] }; take([draft]); draft.list.push('x'); take(true); take([draft]); }],
  ['identity-arguments-alias', (take) => { const shared = { id: 's' }; take([shared, shared]); take({ shared }); }],
  ['identity-state-before-and-after', (take) => { const state = { a: { v: 1 }, b: { v: 2 } }; take(state); const next = { ...state, b: { v: 3 } }; take(next); }],
  ['identity-symbols-across-slots', (take) => { const token = Symbol('token'); take([token]); take({ [token]: 1, other: Symbol('other') }); take(token); }],
]);

/** The trees of one slot vector, emitted as one scope. */
export function slotTrees(make, codec = defaultCodec) {
  const context = codec.createCodecContext();
  const snapshots = [];
  make((value) => { snapshots.push(codec.snapshot(value, context)); });
  return codec.emitSlots(snapshots);
}

/** The file text for `codec` (a module with encode and stringifyTree). */
export function vectorsText(codec = defaultCodec) {
  const lines = [JSON.stringify({ format: 'devryan-client-conformance-vectors', version: 1, codec: codec.CODEC_VERSION })];
  for (const [name, make] of VECTORS) {
    const text = codec.stringifyTree(codec.encode(make(), codec.createCodecContext()));
    lines.push(`{"name":${JSON.stringify(name)},"hash":${JSON.stringify(codec.hashText(text))},"tree":${text}}`);
  }
  for (const [name, make] of SLOT_VECTORS) {
    const text = codec.stringifyTree(slotTrees(make, codec));
    lines.push(`{"name":${JSON.stringify(name)},"hash":${JSON.stringify(codec.hashText(text))},"slots":${text}}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Checks `codec` against the tracked vectors: the bytes of every vector, and
 * that each tracked tree decodes and re-encodes to the same bytes. Returns the
 * failures as `{ name, check, detail }`.
 */
export function checkVectors({ codec = defaultCodec, file = VECTORS_FILE } = {}) {
  const failures = [];
  let tracked;
  try { tracked = readFileSync(file, 'utf8'); } catch (error) { return [{ name: '(file)', check: 'vectors', detail: `cannot read ${path.basename(file)}: ${error.message}` }]; }
  const expected = new Map();
  const lines = tracked.split('\n').filter(Boolean);
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line);
    expected.set(parsed.name, { line, parsed });
  }
  const generated = vectorsText(codec).split('\n').filter(Boolean);
  if (generated[0] !== lines[0]) failures.push({ name: '(header)', check: 'vectors', detail: `${generated[0]} != ${lines[0]}` });
  const names = new Set();
  for (const line of generated.slice(1)) {
    const { name } = JSON.parse(line);
    names.add(name);
    const entry = expected.get(name);
    if (!entry) { failures.push({ name, check: 'vectors', detail: 'not in the tracked file (regenerate it)' }); continue; }
    if (entry.line !== line) failures.push({ name, check: 'vectors', detail: firstDifference(treeText(entry.line), treeText(line)) });
  }
  for (const name of expected.keys()) if (!names.has(name)) failures.push({ name, check: 'vectors', detail: 'tracked but no longer generated' });
  for (const [name, { line, parsed }] of expected) {
    try {
      const context = codec.createCodecContext();
      let written;
      if (parsed.slots) {
        const values = codec.decodeSlots(parsed.slots, context);
        const text = codec.stringifyTree(codec.emitSlots(values.map((value) => codec.snapshot(value, context))));
        written = `{"name":${JSON.stringify(name)},"hash":${JSON.stringify(codec.hashText(text))},"slots":${text}}`;
      } else {
        const text = codec.stringifyTree(codec.encode(codec.decode(parsed.tree, context), context));
        written = `{"name":${JSON.stringify(name)},"hash":${JSON.stringify(codec.hashText(text))},"tree":${text}}`;
      }
      if (written !== line) failures.push({ name, check: 'round-trip', detail: firstDifference(line, written) });
    } catch (error) {
      failures.push({ name, check: 'round-trip', detail: error.message });
    }
  }
  return failures;
}

const treeText = (line) => { const at = line.indexOf('"tree":'); return at >= 0 ? line.slice(at + 7, -1) : line.slice(line.indexOf('"slots":') + 8, -1); };

function firstDifference(expected, actual) {
  let index = 0;
  while (index < expected.length && expected[index] === actual[index]) index += 1;
  return `first difference at byte ${index}: expected ${JSON.stringify(expected.slice(index, index + 40))}, got ${JSON.stringify(actual.slice(index, index + 40))}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Exactly one mode: --check compares, --write regenerates the tracked file; anything else writes nothing (64).
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--check') {
    const failures = checkVectors();
    for (const failure of failures) console.error(`${failure.check}: ${failure.name}: ${failure.detail}`);
    console.log(failures.length ? `${failures.length} vector failures` : `${VECTORS.length + SLOT_VECTORS.length} vectors match (${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`})`);
    process.exitCode = failures.length ? 1 : 0;
  } else if (argv.length === 1 && argv[0] === '--write') {
    writeFileSync(VECTORS_FILE, vectorsText());
    console.log(`wrote ${VECTORS.length + SLOT_VECTORS.length} vectors`);
  } else {
    console.error('usage: vectors.mjs --check | --write');
    process.exitCode = 64;
  }
}
