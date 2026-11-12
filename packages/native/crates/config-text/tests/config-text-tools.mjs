// Helpers shared by the config-text vector generators. Every generator
// renders its file from a seed, so the tracked file is reproducible, and has
// the same command line:
//   node <generator>                    write the tracked file beside it
//   node <generator> --check            fail unless the tracked file is what the installed packages give
//   node <generator> --extended <dir> [--count N] [--seed S]
//                                       write a larger set (same file name) into <dir>,
//                                       which `CONFIG_TEXT_EXTENDED_DIR=<dir> cargo test` reads
// Determinism: no `**` or Math.pow with a base that is not a power of two, no
// locale-dependent ordering, no absolute paths in the output.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTS_DIR, renderRow, versionLine } from './config-text-format.mjs';

/** mulberry32. */
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
export function drawer(seed) {
  const next = random(seed);
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  return { next, int, pick, chance: (p) => next() < p, repeat: (n, make) => Array.from({ length: n }, (_, index) => make(index)) };
}

/** Random edits of a text: deletions, insertions and replacements, for malformed inputs. */
export function mutate(d, text, alphabet) {
  let out = text;
  const edits = 1 + d.int(3);
  for (let index = 0; index < edits; index += 1) {
    const at = d.int(out.length + 1);
    const kind = d.int(3);
    if (kind === 0 && out.length) out = out.slice(0, at) + out.slice(at + 1 + d.int(3));
    else if (kind === 1) out = out.slice(0, at) + d.pick(alphabet) + out.slice(at);
    else out = out.slice(0, at) + d.pick(alphabet) + out.slice(at + 1);
  }
  return out;
}

/** A vectors file: header comment lines, the version line, the rows, and `end<TAB><rows>`. */
export const vectorDocument = (header, rows) => `${[...header, versionLine(), ...rows, `end\t${rows.length}`].join('\n')}\n`;

/** The file without its version line, which names who generated it. */
export const stripVersion = (text) => text.split('\n').filter((line) => !line.startsWith('# jsonc-parser ')).join('\n');

/** Rows from cases `[name, op, args]`. */
export const renderRows = (cases) => cases.map(([name, op, args]) => renderRow(name, op, args));

/** A generator's file text for `count` cases from `seed` (the tracked file by default). */
export const renderVectors = ({ header, cases, trackedCount, seed }, count = trackedCount, useSeed = seed) => vectorDocument(header, renderRows(cases({ count, seed: useSeed })));

/**
 * The command line every generator shares, for `{ file, header, cases,
 * trackedCount, seed }`; the tracked file uses `trackedCount` and `seed`.
 */
export function runGenerator(generator, argv = process.argv.slice(2)) {
  const { file, trackedCount, seed } = generator;
  const tracked = path.join(TESTS_DIR, file);
  const option = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const render = (count, useSeed) => renderVectors(generator, count, useSeed);
  if (argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(tracked, 'utf8'); } catch { /* reported below */ }
    if (stripVersion(current) !== stripVersion(render(trackedCount, seed))) {
      console.error(`${file} differs from what the installed packages give: run node ${path.relative(process.cwd(), path.join(TESTS_DIR, path.basename(process.argv[1])))}`);
      process.exitCode = 1;
    } else console.log(`${file} is current.`);
    return;
  }
  const extended = option('--extended');
  const count = option('--count') === undefined ? trackedCount : Number(option('--count'));
  const useSeed = option('--seed') === undefined ? seed : Number(option('--seed'));
  if (!Number.isInteger(count) || count < 0) throw new Error(`--count must be a whole number, not ${option('--count')}`);
  const target = extended ? path.join(extended, file) : tracked;
  if (extended) mkdirSync(extended, { recursive: true });
  const text = render(count, useSeed);
  writeFileSync(target, text);
  console.log(`Wrote ${target} (${Buffer.byteLength(text)} bytes).`);
}

/** True when the module at `url` is the script node was started with. */
export const isMain = (url) => Boolean(process.argv[1]) && fileURLToPath(url) === path.resolve(process.argv[1]);
