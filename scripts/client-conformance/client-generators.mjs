// Seeded generators of inputs for the client-engine families ported to Rust
// (package C0i, from its review's differential): realistic shapes first, then
// wrong types, nulls, holes, shared objects, prototype-less objects, Maps,
// Sets, Dates, Unicode edge strings (every ECMAScript white space, U+0085,
// U+180E, ZWSP, dotted and dotless i, sigmas, astral letters, lone
// surrogates) and edge numbers, `wild` values at a low rate. Deterministic:
// the same seed gives the same calls on every runtime (no clock, no
// Math.random). Used by the client-engine differential and its tracked
// vectors.

export function rngOf(seed) {
  let a = seed >>> 0 || 1;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = { next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p, pick: (list) => list[Math.floor(next() * list.length)] };
  return r;
}

// Code units and code points that a Rust port gets wrong.
export const SPACES = [' ', '\t', '\n', '\r', '\v', '\f', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿'];
export const NOT_SPACES = ['\u0085', '᠎', '​', '‌', '⁠', '­', '\u0000', '\u001f', '\u007f'];
export const CASED = ['A', 'Z', 'a', 'z', 'İ', 'ı', 'I', 'i', 'Σ', 'σ', 'ς', 'ß', 'ẞ', 'ﬃ', 'ǅ', 'ǆ', 'Ⅻ', 'Ａ', 'Ꭰ', 'ꭰ', 'Ა', 'K', 'Å', 'Ω', 'Ɤ', 'Ꟍ', 'Ꟛ', '\u{10D50}', '\u{10400}', '\u{1E900}', 'Ω', 'É', 'é', 'ͅ', 'ΐ', 'Ǉ', 'ŉ'];
export const ASTRAL = ['😀', '\u{1F600}', '\u{10FFFF}', '\u{20000}'];
export const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud83d'];
const PUNCT = ['_', '-', '__', '--', '_-', '.', '/', '\\', '\\\\', './', '.\\\\', '|', ',', ':', '"', "'", '0', '1', '9', 'x', '\uE000', '\uFFFF'];
export const UNITS = [...SPACES, ...NOT_SPACES, ...CASED, ...ASTRAL, ...LONE, ...PUNCT, 'a', 'b', 'c', 'Q', 'ab', 'tool', 'calls'];

export const NUMS = [1000000000000042.25, 83176082636972.125, 999999973283321.25, 0, -0, 1, -1, 0.5, -0.5, 1.5, 2, 3, 10, 100, 1e21, 1e20, 123e-20, 1.5e-7, 1e-6, 1e-7, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 2 ** 31, 2 ** 32, 4294967295, 4294967296, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, 0.1 + 0.2, 1 / 3, NaN, Infinity, -Infinity, 1700000000000, 1700000000001, 1700000000000.5, 5e-324, 1e308];

export function randomNumber(r) {
  const k = r.int(8);
  if (k < 3) return r.pick(NUMS);
  if (k === 3) return r.int(10);
  if (k === 4) return r.int(2000) - 1000;
  if (k === 5) { const b = new DataView(new ArrayBuffer(8)); b.setUint32(0, r.int(2 ** 32)); b.setUint32(4, r.int(2 ** 32)); return b.getFloat64(0); }
  if (k === 6) return (r.next() - 0.5) * 10 ** (r.int(40) - 20);
  return Number((r.next() * 1000).toFixed(r.int(6)));
}

export function randomString(r, max = 8) {
  const n = r.int(max + 1);
  let out = '';
  for (let i = 0; i < n; i += 1) out += r.pick(UNITS);
  return out;
}

export function caseVariant(r, word) {
  let out = '';
  for (const ch of word) out += r.chance(0.5) ? ch.toUpperCase() : ch;
  return out;
}

/** A numeric-looking string, for StringToNumber. */
export function numericString(r) {
  const k = r.int(12);
  const sp = () => (r.chance(0.3) ? r.pick([...SPACES, ...NOT_SPACES.slice(0, 2)]) : '');
  if (k === 0) return sp() + String(randomNumber(r)) + sp();
  if (k === 1) return sp() + r.pick(['0x', '0X', '0o', '0O', '0b', '0B', '-0x', '+0x', '0x_', '0']) + Array.from({ length: r.int(30) }, () => r.pick('0123456789abcdefABCDEFgG_'.split(''))).join('') + sp();
  if (k === 2) return r.pick(['Infinity', '-Infinity', '+Infinity', 'infinity', 'INFINITY', 'NaN', '-NaN', 'Inf', '1e', 'e5', '.', '..1', '1..', '+', '-', '+-1', '--1', '', ' ', '　', '1 2', '1_000', '١٢', '１２', '0.0', '-0', '+0', '-0.0', '00', '007', '08', '1e+', '1e-', '1E5', '1e+5', '1e-5', '.e1', '1.e1', '.1e1', '0x1p3', '1n', '0b2', '0o8']);
  if (k === 3) return '9'.repeat(r.int(400) + 1) + (r.chance(0.5) ? '.' + '9'.repeat(r.int(400)) : '');
  if (k === 4) return '0.' + '0'.repeat(r.int(400)) + String(r.int(1000)) + (r.chance(0.3) ? 'e' + (r.int(700) - 350) : '');
  if (k === 5) return String(r.int(10)) + 'e' + (r.chance(0.5) ? '-' : '+') + String(r.int(1000));
  if (k === 6) return '0x' + Array.from({ length: r.int(300) + 1 }, () => r.pick('0123456789abcdef'.split(''))).join('');
  if (k === 7) return '0b' + Array.from({ length: r.int(1100) + 1 }, () => r.pick(['0', '1'])).join('');
  if (k === 8) return (r.chance(0.5) ? '-' : '') + String(r.int(10 ** 6)) + '.' + String(r.int(10 ** 6)).padStart(6, '0') + (r.chance(0.3) ? 'e' + (r.int(60) - 30) : '');
  if (k === 9) { const digits = '2.2250738585072011e-308|2.2250738585072012e-308|4.9406564584124654e-324|2.4703282292062327e-324|2.4703282292062328e-324|1.7976931348623157e308|1.7976931348623158e308|1.7976931348623159e308|9007199254740993|9007199254740992.5|0.30000000000000004|1e23|8.98846567431158e307|0x20000000000001|0x1fffffffffffff8|0x1fffffffffffffc|0x1fffffffffffff4|0o777777777777777777777|0b11111111111111111111111111111111111111111111111111111'.split('|'); return r.pick(digits); }
  if (k === 10) return sp() + randomString(r, 4) + String(r.int(100)) + sp();
  return Array.from({ length: r.int(12) }, () => r.pick('0123456789.eE+-xob '.split(''))).join('');
}

const KEYS = ['a', 'b', 'id', 'type', 'state', 'status', 'time', '0', '1', '2', '10', '01', '-1', '4294967294', '4294967295', 'length', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'x y', 'İ', '\ud800', '😀', ''];

/** Any value, a few levels deep. `pool` gives objects to share (identity). */
/** The typed profile: realistic shapes only (no holes, no wrong-typed ids, almost no wild values). */
export const PROFILE = { typed: false };
export function wild(r, depth = 2, pool = []) {
  if (PROFILE.typed) return r.pick([undefined, undefined, 'x', 1, true]);
  const k = r.int(depth > 0 ? 20 : 12);
  switch (k) {
    case 0: return undefined;
    case 1: return null;
    case 2: return r.chance(0.5);
    case 3: case 4: return randomNumber(r);
    case 5: case 6: case 7: return randomString(r);
    case 8: return r.pick(['', 'text', 'tool', 'reasoning', 'assistant', 'user', 'completed', 'running', 'failed', 'idle', 'busy', 'retry', 'm1', 'm2', 's1', 'prepend', 'merge', 'tool-calls', 'stop']);
    case 9: return r.int(5);
    case 10: return pool.length ? r.pick(pool) : {};
    case 11: return [];
    case 12: case 13: { const a = []; const n = r.int(4); for (let i = 0; i < n; i += 1) { if (r.chance(0.15)) { a.length += 1; continue; } a.push(wild(r, depth - 1, pool)); } return a; }
    case 14: case 15: case 16: { const o = r.chance(0.1) ? Object.create(null) : {}; const n = r.int(4); for (let i = 0; i < n; i += 1) { const key = r.pick(KEYS); Object.defineProperty(o, key, { value: wild(r, depth - 1, pool), enumerable: true, writable: true, configurable: true }); } if (r.chance(0.3)) pool.push(o); return o; }
    case 17: return new Set(Array.from({ length: r.int(4) }, () => wild(r, 0, pool)));
    case 18: return new Map(Array.from({ length: r.int(3) }, () => [wild(r, 0, pool), wild(r, 0, pool)]));
    default: return r.pick([new Date(1700000000000), new Date(NaN), new Error('boom'), new TypeError('t'), Object.assign(new (class Point {})(), { x: 1 })]);
  }
}

/** A value from `typical` mostly, a wild one sometimes. */
export const pickish = (r, typical, p = 0.12, pool) => (!PROFILE.typed && r.chance(p) ? wild(r, 1, pool) : r.pick(typical));
/** Sets `key` on `o` unless the dice say leave it out. */
export const maybe = (r, o, key, value, pOmit = 0.15) => { if (!r.chance(pOmit)) Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true }); return o; };

const IDS = ['m1', 'm2', 'm3', 'm10', 'm2 ', 'M1', 'a', 'b', ''];
export const id = (r, p = 0.08) => (!PROFILE.typed && r.chance(p) ? r.pick([undefined, null, 1, 0, -0, 2, NaN, true, {}, ['m1'], 'constructor', '__proto__', 'toString', '\ud800', 'm\u0000', '\u{10000}', '\uE000', 1000000000000042.25]) : r.pick(IDS));
const SIDS = ['s1', 's2', 's3', ''];
export const sid = (r, p = 0.06) => (!PROFILE.typed && r.chance(p) ? r.pick([undefined, null, 1, 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'length']) : r.pick(SIDS));

/** An array of `make()` with holes, nulls and repeats at low rates. */
export function list(r, make, max = 4, { holes = 0.05, nulls = 0.04, repeat = 0.1 } = {}) {
  if (PROFILE.typed) { holes = 0; nulls = 0; }
  const out = [];
  const n = r.int(max + 1);
  for (let i = 0; i < n; i += 1) {
    if (r.chance(holes)) { out.length += 1; continue; }
    if (r.chance(nulls)) { out.push(r.pick([null, undefined])); continue; }
    if (out.length && r.chance(repeat)) { out.push(out[r.int(out.length)]); continue; }
    out.push(make());
  }
  return out;
}

export const statusWord = (r) => {
  const words = ['pending', 'running', 'started', 'in progress', 'in_progress', 'in-progress', 'processing', 'executing', 'completed', 'complete', 'error', 'failed', 'aborted', 'timeout', 'timed out', 'timed_out', 'done', 'cancelled', 'canceled', 'tool-calls', 'tool_calls', 'stop', 'streaming', 'idle', 'unknown', 'fail', 'İ', 'FAİLED', 'faıled'];
  let w = caseVariant(r, r.pick(words));
  if (r.chance(0.4)) w = Array.from(w).map((ch) => (r.chance(0.15) ? ch + r.pick([...SPACES, '_', '-', ...NOT_SPACES.slice(0, 3)]) : ch)).join('');
  if (r.chance(0.4)) w = r.pick(SPACES) + w + r.pick([...SPACES, '']);
  if (r.chance(0.1)) w += r.pick([...LONE, ...ASTRAL, ...CASED]);
  return w;
};

export const timeVal = (r) => (PROFILE.typed ? r.pick([undefined, 0, 1, 5, 10, 10.5, 1700000000000, 1700000000001, 1700000000002]) : r.chance(0.7) ? r.pick([0, -0, 1, 5, 10, 10.5, 1700000000000, 1700000000001, -1, NaN, Infinity, -Infinity, 1e308, Number.MAX_VALUE]) : wild(r, 0));
