// Helpers shared by the generators of the JavaScript-semantics vectors
// (generate-json.mjs, generate-numbers.mjs, generate-strings.mjs,
// generate-sort.mjs, generate-base64.mjs, generate-collate.mjs).
//
// Every generator renders its file from a seed, so the tracked file is
// reproducible, and has the same command line:
//   node <generator>                          write the tracked file beside it
//   node <generator> --check                  fail unless the tracked file is current
//   node <generator> --extended <dir> [--count N]
//                                             write a larger set (same file name) into <dir>,
//                                             which `LEDGER_CORE_EXTENDED_DIR=<dir> cargo test` reads
// The extended runner beside these files does the extended run end to end.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 10 to the power `n` as the decimal literal reads, which the language
 * specifies exactly. The `**` operator is the C library's `pow`, which may
 * round the last bit differently from one platform to the next, so a
 * generator that used it would write different vectors on Linux and macOS.
 */
export const powerOfTen = (n) => Number(`1e${n}`);

/** mulberry32, as generate-vectors.mjs; tests/support/mod.rs reproduces it. */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drawing helpers over one generator. */
export function drawer(next) {
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (list) => list[int(list.length)], chance: (p) => next() < p };
}

/**
 * WTF-8: UTF-8 that also encodes lone surrogates (as three bytes, ED A0 80
 * to ED BF BF), so any JavaScript string survives as bytes.
 */
export function wtf8(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Buffer.from(bytes);
}

export const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Code units as hex, four digits each. */
export const unitsHex = (text) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index).toString(16).padStart(4, '0')).join('');

/** The runtime a file was generated with, for a header line (`--check` ignores it). */
export const runtimeLine = () => `# Node ${process.version}, V8 ${process.versions.v8}, ICU ${process.versions.icu}, default locale ${new Intl.Collator().resolvedOptions().locale} (the content must not depend on them).`;

/**
 * A vectors file: header comment lines, the runtime line, the data rows, and
 * a closing `end <rows>` row, so a truncated file fails tests/support/mod.rs.
 */
export const vectorDocument = (header, rows) => `${[...header, runtimeLine(), ...rows, `end\t${rows.length}`].join('\n')}\n`;

/**
 * The command line every generator shares. `render(count)` returns the file
 * text; `count` is the tracked size unless `--count` is given.
 */
export function runGenerator({ file, render, trackedCount, argv = process.argv.slice(2) }) {
  const tracked = path.join(TESTS_DIR, file);
  const option = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const extended = option('--extended');
  const count = option('--count') === undefined ? trackedCount : Number(option('--count'));
  if (!Number.isInteger(count) || count < 0) throw new Error(`--count must be a whole number, not ${option('--count')}`);
  if (argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(tracked, 'utf8'); } catch { /* reported below */ }
    if (stripRuntime(current) !== stripRuntime(render(trackedCount))) {
      console.error(`${tracked} is stale or differs under ${process.version}: run node ${path.relative(process.cwd(), path.join(TESTS_DIR, path.basename(process.argv[1])))}`);
      process.exitCode = 1;
    } else console.log(`${file} is current (${process.version}, ICU ${process.versions.icu}).`);
    return;
  }
  const target = extended ? path.join(extended, file) : tracked;
  if (extended) mkdirSync(extended, { recursive: true });
  const text = render(count);
  writeFileSync(target, text);
  console.log(`Wrote ${target} (${Buffer.byteLength(text)} bytes).`);
}

/** The file without its runtime header line, which records who generated it. */
export const stripRuntime = (text) => text.split('\n').filter((line) => !line.startsWith('# Node ') && !line.startsWith('// Node ')).join('\n');

/** True when the module at `url` is the script node was started with. */
export const isMain = (url) => Boolean(process.argv[1]) && fileURLToPath(url) === path.resolve(process.argv[1]);
