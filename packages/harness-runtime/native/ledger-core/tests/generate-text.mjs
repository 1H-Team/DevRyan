#!/usr/bin/env node
// Writes text.tsv: the ledger's text engine as
// packages/harness-runtime/lib/session-mutation-text.js and the run-row code
// of session-mutations.js (formatOneRows, runsFor, saveRuns, the marker and
// fence predicates, evaluated from their own source) behave, so `cargo test`
// (tests/text.rs) checks ledger_core::text. Command line: vector-tools.mjs.
//
// Texts are latin1 byte strings, written as base64. `fnv` is fnv64 of a JSON
// text (codec-tools.mjs); a run list's JSON is runsJson (each run's text as
// base64, in place). Rows:
//   history <JSON>  a seeded edit history: { id, text, steps: [{ op, off
//           (inactive operations), after, budget, f (fnv of the runs after
//           applyMutationText), v (fnv of mutationText under `off`) }],
//           views: [{ off, v }] (mutationText of the final runs under sets of
//           inactive operations), m (minimizeMutationAncestry of the final
//           runs with `clock` and `slice`, as for ancestry rows), rows (fnv of encodeMutationRunRows and of
//           formatOneRows, and of decodeMutationRunRows of the former),
//           save: { refs, hash, pages: [[name, fnv]], entries, bytes, load }
//           (saveRuns into a real store, then runsFor over the staged pages) }.
//           Operations are undone and redone (`off`), hunks overlap, small
//           hunk budgets force coalescing, texts hold multi-byte UTF-8,
//           invalid UTF-8 and NUL, and some histories reuse an operation id.
//   long <JSON>     a seeded text of 32 KiB and more (seededBytes), one edit,
//           then the rows and the save as for a history.
//   ancestry <JSON> { seed, clock, slice, m }: minimizeMutationAncestry over
//           the seeded runs of tests/support/mod.rs `ancestry_runs`, with a
//           fake performance.now() (mulberry32 from `clock`) and sliceMs
//           `slice`. m is { f, before, after, changed } or { error }, and
//           `trace`, every pause in order: the site's letter (R read, H
//           height, O order, E reach, C check, V verify; the six
//           `await pause()` lines of the source, in order), uppercase when
//           the pause yielded, run-length encoded.
//   decode <rows JSON> <result>   decodeMutationRunRows on hand-made rows:
//           invalid (it throws), unsupported (it accepts rows outside the
//           Rust's model), or the fnv of the runs
//   document <pages JSON> <baselines JSON> <result>   runsFor over hand-made
//           pages: invalid_change_record, type (a TypeError), unsupported, or
//           the fnv of the runs, of their format 2 rows and of their format 1 rows
//   large <JSON>    { id, input, fill, decoded, steps, clock, slice, m, rows,
//           save }: format 2 rows (`input`) whose starts and range ends pass 2^53,
//           decoded (fnv `decoded`), edited (`steps` as for a history),
//           minimized, encoded and saved as for a history (`back` is
//           `invalid` where the rows written cannot be decoded again)
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openChangeStore } from '../../../lib/session-changes-store.js';
import { changeError } from '../../../lib/session-changes-git.js';
import { MUTATION_HUNK_WORK_BUDGET, applyMutationText, decodeMutationRunRows, encodeMutationRunRows, initialMutationRuns, minimizeMutationAncestry,
  mutationText, visibleMutationRuns } from '../../../lib/session-mutation-text.js';
import { evaluateDeclarations, fnv64, runsJson, seededBytes } from './codec-tools.mjs';
import { drawer, isMain, random, runGenerator, vectorDocument } from './vector-tools.mjs';

export const TEXT_FILE = 'text.tsv';
export const TEXT_SEED = 20261204;
export const TEXT_TRACKED = 300;

const fnv = (text) => fnv64(Buffer.from(text));
const b64 = (text) => Buffer.from(text, 'latin1').toString('base64');

// The closures of session-mutations.js this needs, from its own source.
const product = evaluateDeclarations('session-mutations.js',
  ['BASELINE_PAGE', 'baselineMarker', 'ANCESTRY_FORMAT', 'ancestryFormatPage', 'baselineText', 'runsFor', 'formatOneRows', 'saveRuns'],
  {
    changeError, initialMutationRuns, decodeMutationRunRows, encodeMutationRunRows,
    // bytesFor reads `objects/<hash>` after checking the hash; here, a map.
    bytesFor: async (repo, hash) => {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw changeError('invalid_change_record');
      const bytes = repo.objects.get(hash);
      if (!bytes) throw changeError('invalid_change_record');
      return bytes;
    },
    putBytes: async (repo, bytes) => { const hash = createHash('sha256').update(bytes).digest('hex'); repo.objects.set(hash, bytes); return hash; },
    baselineRefs: () => baselineRefsSwitch,
  });
let baselineRefsSwitch = true;

/** A store over a stub Git with no tree: what saveRuns stages, read back. */
async function stubStore() {
  const gitRunner = { git: async (_cwd, args) => Buffer.from(args.includes('rev-parse') ? 'sha1\n' : ''), gitTokens: async function* () {}, gitRecords: async function* () {} };
  return openChangeStore('/nonexistent', '/nonexistent/git', { gitRunner });
}

/** runsFor over page values in order, with `objects` for markers. */
async function load(pages, id, objects) {
  const repo = { objects, db: { entries: async function* () { for (const value of pages) yield { value }; } } };
  try { return { runs: await product.runsFor(repo, id) }; } catch (error) {
    if (error.code === 'invalid_change_record') return { error: 'invalid' };
    if (error instanceof TypeError) return { error: 'type' };
    throw error;
  }
}

// The Rust's run model (src/text/mod.rs): a run JavaScript accepts but the
// Rust refuses as Unsupported. Used to label hand-made rows. Its numbers are
// integers of magnitude at most 2^62 (written out: no exponent operator).
const MODEL_LIMIT = 4611686018427387904;
const integral = (value) => Number.isInteger(value) && Math.abs(value) <= MODEL_LIMIT;
const inModelRange = (range) => range !== null && typeof range === 'object' && !Array.isArray(range)
  && JSON.stringify(Object.keys(range)) === '["id","start","length"]' && typeof range.id === 'string' && integral(range.start) && integral(range.length);
export const inModel = (run) => typeof run.id === 'string' && integral(run.start) && (run.owner === null || typeof run.owner === 'string')
  && Array.isArray(run.deletedBy) && run.deletedBy.every((id) => typeof id === 'string') && Array.isArray(run.replaces) && run.replaces.every(inModelRange);

// ---- Texts and edits.
const WORDS = ['const', 'x', '=', '1;', '\n', ' ', 'é', '€', '😀', 'ab', 'return', '{', '}', 'ledger', '\t', '\r\n'];
const latin1 = (text) => Buffer.from(text, 'utf8').toString('latin1');
const words = (d, count) => Array.from({ length: count }, () => latin1(d.pick(WORDS)));
const chars = (text) => (isUtf8(Buffer.from(text, 'latin1')) ? Array.from(Buffer.from(text, 'latin1').toString('utf8'), latin1) : text.split(''));

function edit(d, text) {
  let units = chars(text);
  for (let count = 1 + d.int(4); count > 0; count -= 1) {
    const roll = d.int(10), at = d.int(units.length + 1);
    if (roll < 3) units.splice(at, 0, ...words(d, 1 + d.int(4)));
    else if (roll < 6 && units.length) units.splice(Math.min(at, units.length - 1), 1 + d.int(Math.min(8, units.length)));
    else if (roll < 8 && units.length) units.splice(Math.min(at, units.length - 1), 1 + d.int(4), ...words(d, d.int(3)));
    else if (roll === 8) units.splice(at, 0, String.fromCharCode(d.pick([0x00, 0xff, 0x80, 0xc3])));
    else if (d.chance(0.3)) units = d.chance(0.2) ? [] : words(d, d.int(12));
  }
  return units.join('');
}

// ---- The pause trace of minimizeMutationAncestry.
const TEXT_SOURCE = readFileSync(fileURLToPath(new URL('../../../lib/session-mutation-text.js', import.meta.url)), 'utf8').split('\n');
const minimizeStart = TEXT_SOURCE.findIndex((line) => line.includes('export async function minimizeMutationAncestry('));
const PAUSE_LINES = TEXT_SOURCE.map((line, index) => (index > minimizeStart && line.includes('await pause()') ? index + 1 : null)).filter((line) => line !== null);
const CHECK_LINE = TEXT_SOURCE.findIndex((line, index) => index > minimizeStart && line.includes('performance.now() - sliceStarted < sliceMs')) + 1;
const SITES = 'RHOECV';
if (PAUSE_LINES.length !== SITES.length || CHECK_LINE <= minimizeStart) throw new Error(`minimizeMutationAncestry has ${PAUSE_LINES.length} pause sites, not ${SITES.length}: update generate-text.mjs and PauseSite`);

/** minimizeMutationAncestry with a fake clock, and the sites of its pauses. */
async function traced(runs, clockSeed, sliceMs) {
  const clock = random(clockSeed);
  let now = 1000;
  const trace = [];
  const real = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const fake = {
    now() {
      const stack = new Error().stack.split('\n');
      const frame = (index) => Number(/session-mutation-text\.js:(\d+):/.exec(stack[index] ?? '')?.[1]);
      if (frame(2) === CHECK_LINE) {
        const site = PAUSE_LINES.indexOf(frame(3));
        if (site < 0) throw new Error(`a pause from line ${frame(3)}`);
        trace.push(SITES[site].toLowerCase());
      }
      now += Math.floor(clock() * 3);
      return now;
    },
  };
  Object.defineProperty(globalThis, 'performance', { value: fake, configurable: true, writable: true });
  let result;
  try {
    result = await minimizeMutationAncestry(runs, { sliceMs, yieldNow: async () => { trace[trace.length - 1] = trace.at(-1).toUpperCase(); } });
    result = { f: fnv(runsJson(result.runs)), before: result.before, after: result.after, changed: result.changed };
  } catch (error) {
    if (!/^mutation_ancestry_/.test(error.message)) throw error;
    result = { error: error.message };
  } finally { Object.defineProperty(globalThis, 'performance', real); }
  let encoded = '';
  for (let at = 0; at < trace.length;) {
    let end = at;
    while (end < trace.length && trace[end] === trace[at]) end += 1;
    encoded += `${trace[at]}${end - at}`;
    at = end;
  }
  return { ...result, trace: encoded };
}

/** Seeded runs with ancestry; tests/support/mod.rs `ancestry_runs` draws the same. */
export function ancestryRuns(seed) {
  const d = drawer(random(seed));
  const runs = [];
  const ids = 2 + d.int(12);
  for (let index = 0; index < ids; index += 1) {
    let start = 0, previous = null;
    for (let pieces = 1 + d.int(4); pieces > 0; pieces -= 1) {
      const length = 1 + d.int(20);
      let replaces = [];
      if (previous && d.chance(0.3)) replaces = previous;
      else {
        for (let count = index === 0 ? 0 : d.int(d.chance(0.2) ? 60 : 8); count > 0; count -= 1) {
          replaces.push({ id: `o${d.int(index)}`, start: d.int(30), length: d.int(15) });
        }
        if (d.chance(0.004)) replaces.push({ id: `o${index + d.int(2)}`, start: 0, length: 1 + d.int(5) });
        if (d.chance(0.002)) replaces.push({ id: 'o0', start: -1, length: 1 });
      }
      runs.push({ id: `o${index}`, start, text: 'a'.repeat(length), owner: index ? `op${index}` : null, deletedBy: [], replaces });
      previous = replaces;
      start += length;
    }
  }
  for (let index = runs.length - 1; index > 0; index -= 1) {
    if (!d.chance(0.3)) continue;
    const other = d.int(index + 1);
    [runs[index], runs[other]] = [runs[other], runs[index]];
  }
  return runs;
}

// ---- What a run list turns into.
async function rowsAndSave(d, runs, id) {
  const two = encodeMutationRunRows(runs);
  let back;
  try { back = fnv(runsJson(decodeMutationRunRows(two))); } catch (error) { if (!(error instanceof TypeError)) throw error; back = 'invalid'; }
  const rows = { two: fnv(JSON.stringify(two)), one: fnv(JSON.stringify([...product.formatOneRows(runs)])), back };
  baselineRefsSwitch = d.chance(0.8);
  const store = await stubStore(), objects = new Map();
  const result = await product.saveRuns({ db: store, objects }, id, runs, 'runs', { absent: true });
  const staged = [...(await store.staged(`runs/${id}`))];
  const loaded = await load(staged.map(([, value]) => value), id, objects);
  const save = { refs: baselineRefsSwitch, hash: [...objects.keys()][0] ?? null, pages: staged.map(([name, value]) => [name, fnv(JSON.stringify(value))]),
    entries: result.entries, bytes: result.bytes, load: loaded.runs ? fnv(runsJson(loaded.runs)) : loaded.error };
  baselineRefsSwitch = true;
  return { rows, save };
}

async function history(d, index) {
  const id = `d${index}`;
  let text = d.chance(0.05) ? '' : words(d, 2 + d.int(14)).join('');
  if (d.chance(0.05)) text += '\0\xff';
  let runs = initialMutationRuns(text, `${id}:baseline`);
  const ops = [], inactive = new Set(), steps = [];
  for (let count = d.chance(0.05) ? 0 : 1 + d.int(8); count > 0; count -= 1) {
    if (ops.length && d.chance(0.35)) { const op = d.pick(ops); if (inactive.has(op)) inactive.delete(op); else inactive.add(op); }
    const op = ops.length && d.chance(0.04) ? d.pick(ops) : `op${ops.length}`;
    const base = visibleMutationRuns(runs, inactive);
    const after = edit(d, mutationText(runs, inactive));
    const budget = d.chance(0.25) ? d.pick([1, 10, 50, 200, 1000]) : MUTATION_HUNK_WORK_BUDGET;
    runs = applyMutationText(runs, base, after, op, { hunkBudget: budget });
    steps.push({ op, off: [...inactive], after: b64(after), budget, f: fnv(runsJson(runs)), v: fnv(b64(mutationText(runs, inactive))) });
    if (!ops.includes(op)) ops.push(op);
  }
  const views = Array.from({ length: 3 }, () => {
    const off = ops.filter(() => d.chance(0.4));
    return { off, v: fnv(b64(mutationText(runs, new Set(off)))) };
  });
  const clock = (TEXT_SEED + index) >>> 0, slice = d.pick([0, 1, 25]);
  const m = await traced(runs, clock, slice);
  return JSON.stringify({ id, text: b64(text), steps, views, clock, slice, m, ...await rowsAndSave(d, runs, id) });
}

async function long(d, index) {
  const id = `long${index}`, seed = (TEXT_SEED * 31 + index) >>> 0;
  const length = d.pick([32767, 32768, 32769, 65536, 65537, 70000]);
  const text = seededBytes(random(seed), length).toString('latin1');
  const at = d.int(length), cut = d.int(40), insert = 'X'.repeat(d.int(3));
  const after = text.slice(0, at) + insert + text.slice(at + cut);
  let runs = initialMutationRuns(text, `${id}:baseline`);
  if (index % 2) runs = applyMutationText(runs, runs, after, 'op0');
  return JSON.stringify({ id, seed, length, edit: index % 2 ? [at, cut, insert.length] : null, f: fnv(runsJson(runs)), ...await rowsAndSave(d, runs, id) });
}

// ---- Hand-made rows and pages.
const SAMPLE_RUN = () => ({ id: 'r', start: 0, owner: null, deletedBy: [], replaces: [], bytes: 'YWJj' });
function damagedRow(d) {
  const row = SAMPLE_RUN();
  const roll = d.int(24);
  if (roll === 0) return null;
  if (roll === 1) return d.pick([1, 'x', true, [], [SAMPLE_RUN()]]);
  if (roll === 2) delete row.bytes;
  else if (roll === 3) row.bytes = d.pick([1, null, ['YQ=='], { length: 1 }, true, { valueOf: '' }, { valueOf: null, length: 2 }, { valueOf: 1 }, { type: 'Buffer', data: [1] }, {}, { length: null }]);
  else if (roll === 4) delete row.id;
  else if (roll === 5) row.id = d.pick([1, null, ['r']]);
  else if (roll === 6) row.start = d.pick([-1, 1.5, '0', 9007199254740992, -0, null]);
  else if (roll === 7) row.deletedBy = d.pick([null, 'op', {}, ['op', 1], ['op']]);
  else if (roll === 8) row.replaces = d.pick([null, 'x', {}, [{ id: 'q', start: 0, length: 1 }], [{ start: 0, id: 'q', length: 1 }], [{ id: 'q', start: 0, length: 1, more: 1 }], [{ id: 'q', start: -1, length: 1 }], [1]]);
  else if (roll === 9) row.owner = d.pick([1, 'op', undefined, ['op']]);
  else if (roll === 10) return { continues: true, bytes: d.pick(['YQ==', '', 'Zm9v!', 'ŁQ==']) };
  else if (roll === 11) return { continues: true, bytes: 'YQ==', id: 'r' };
  else if (roll === 12) return { continues: d.pick([false, 'true', 1]), ...row };
  else if (roll === 13) return { '0': 'index', ...row, extra: { nested: [1] } };
  else if (roll === 14) return { ...row, text: 'stale', __proto__x: 1 };
  else if (roll === 15) return JSON.parse('{"__proto__":1,"id":"p","start":2,"owner":"o","deletedBy":["o"],"replaces":[],"bytes":"eHl6"}');
  else if (roll === 16) row.bytes = d.pick(['', 'YW Jj', 'YWJ', '=YWJj', 'YWJjé', '-_-_']);
  else if (roll === 17) { const { id, ...rest } = row; return { ...rest, id }; }
  else if (roll === 18) { const { bytes, ...rest } = row; return { bytes, ...rest }; }
  return row;
}

function decodeCase(d) {
  const rows = Array.from({ length: d.int(5) }, () => damagedRow(d));
  let result;
  try {
    const runs = decodeMutationRunRows(rows);
    result = runs.every(inModel) ? fnv(runsJson(runs)) : 'unsupported';
  } catch (error) { if (!(error instanceof TypeError)) throw error; result = 'invalid'; }
  return `decode\t${JSON.stringify(rows)}\t${result}`;
}

// Every `bytes` Buffer.from treats differently, in a format 1 row of its own.
const BYTES_VALUES = [1, true, null, 'YWJj', ['YQ=='], [], {}, { length: 1 }, { length: null }, { length: 'x' }, { type: 'Buffer', data: [1] }, { type: 'Buffer', data: 1 },
  { valueOf: '' }, { valueOf: null }, { valueOf: null, length: 2 }, { valueOf: 0 }, { valueOf: false }, { valueOf: 'x' }, { valueOf: {} },
  // A falsy valueOf is not called: Buffer.from goes on to fromObject.
  { valueOf: 0, length: 1 }, { valueOf: false, length: 2 }, { valueOf: 0, type: 'Buffer', data: [1] }, { valueOf: false, type: 'Buffer', data: 1 }];

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');

async function documentCase(d, pagesGiven, texts = ['abc']) {
  const text = texts[0], hash = sha256(text);
  const objects = new Map(texts.map((each) => [sha256(each), Buffer.from(each, 'latin1')]));
  const marker = () => d.pick([{ baseline: hash, size: 3 }, { size: 3, baseline: hash }, { baseline: hash, size: 4 }, { baseline: [hash], size: 3 },
    { baseline: hash, size: 3, x: 1 }, { baseline: hash.toUpperCase(), size: 3 }, { baseline: hash, size: 0 }, { baseline: 'f'.repeat(64), size: 3 }]);
  const fence = () => d.pick([{ format: 'ancestry', version: 2 }, { version: 2, format: 'ancestry' }, { format: 'ancestry', version: 2.0 }, { format: 'ancestry', version: '2' }, { format: 'ancestry', version: 2, x: 0 }]);
  const page = () => {
    const roll = d.int(10);
    if (roll < 4) return Array.from({ length: d.int(3) }, () => damagedRow(d));
    if (roll < 6) return marker();
    if (roll < 8) return fence();
    return d.pick([null, 'x', 1, {}, [[]]]);
  };
  // Markers and fences after runs, between and before empty pages.
  const fixed = [[[SAMPLE_RUN()], marker()], [[], marker()], [marker(), []], [fence(), marker()], [[SAMPLE_RUN()], fence()], [fence(), [SAMPLE_RUN()], fence()]];
  const pages = pagesGiven ?? (d.chance(0.15) ? d.pick(fixed) : Array.from({ length: d.int(4) }, page));
  const loaded = await load(pages, 'doc', objects);
  // A format 1 run keeps its `bytes`; the model holds only a string there.
  const modelled = (run) => inModel(run) && (!Object.hasOwn(run, 'bytes') || typeof run.bytes === 'string');
  // The runs, and the rows both formats encode them to (a stale `bytes` keeps its place in format 2).
  const result = loaded.runs ? (loaded.runs.every(modelled) ? [runsJson(loaded.runs), JSON.stringify(encodeMutationRunRows(loaded.runs)),
    JSON.stringify([...product.formatOneRows(loaded.runs)])].map(fnv).join(',') : 'unsupported') : loaded.error;
  return `document\t${JSON.stringify(pages)}\t${JSON.stringify(Object.fromEntries(texts.map((each) => [sha256(each), b64(each)])))}\t${result}`;
}

// Fixed pages: markers whose `baseline` has no string form (RegExp.test
// throws a TypeError), a marker of the empty text (size 0 is no marker),
// and stored numbers past 2^53.
const BIG = 9007199254740991;
const FIXED_DOCUMENTS = [
  { pages: [{ baseline: { toString: 1 }, size: 3 }] }, { pages: [{ baseline: [sha256('abc'), { toString: 'x' }], size: 3 }] },
  { pages: [{ size: 3, baseline: { toString: null } }] }, { pages: [{ baseline: { valueOf: 1 }, size: 3 }] },
  { pages: [{ baseline: { toString: 1 }, size: 3, x: 1 }] }, { pages: [[], { baseline: { toString: 1 }, size: 3 }] },
  { pages: [[SAMPLE_RUN()], { baseline: { toString: 1 }, size: 3 }] },
  { pages: [{ baseline: sha256(''), size: 0 }], texts: [''] }, { pages: [{ baseline: sha256(''), size: 1 }], texts: [''] },
  { pages: [[{ ...SAMPLE_RUN(), start: BIG + 3 }, { ...SAMPLE_RUN(), id: 's', start: BIG, replaces: [{ id: 'r', start: BIG + 1, length: BIG }] }]] },
  { pages: [{ format: 'ancestry', version: 2 }, [{ ...SAMPLE_RUN(), start: BIG }, { continues: true, bytes: 'YWJj' }, { continues: true, bytes: 'YQ==' }, { continues: true, bytes: 'YWI=' }]] },
];

// Runs whose numbers pass 2^53, where the JavaScript's sums round, decoded
// from format 2 rows (`fill`: the first row's text is that many `a`s), then
// edited, minimized, encoded and saved as a history is.
const runRow = (id, start, text, extra = {}) => ({ id, start, owner: null, deletedBy: [], replaces: [], ...extra, bytes: b64(text) });
const more = (text) => ({ continues: true, bytes: b64(text) });
const LARGE = [
  { rows: [runRow('big', BIG, 'ab'), more('cd'), more('efg'), more('hi'), runRow('op1:0', 0, 'XY', { owner: 'op1', replaces: [{ id: 'big', start: BIG, length: 4 }] })] },
  { rows: [runRow('big', BIG - 2, 'abc'), more('d'), more('efghij'), more('k'), runRow('tail', 5, 'zz')] },
  { rows: [runRow('big', BIG - 1, 'abcd'), more('ef'), runRow('op2:0', 0, 'Q', { owner: 'op2', replaces: [{ id: 'big', start: BIG + 3, length: 2 }] })] },
  { rows: [runRow('big', BIG - 6, 'abcdef'), more('ghi'), more('jkl'), runRow('op3:0', 0, 'R', { owner: 'op3', deletedBy: ['op4'], replaces: [{ id: 'big', start: BIG - 4, length: 9 }] }),
    runRow('op4:0', 0, 'S', { owner: 'op4', replaces: [{ id: 'op3:0', start: 0, length: 1 }, { id: 'big', start: BIG + 1, length: 4 }] })] },
  { fill: 32775, rows: [runRow('long', BIG - 4, '')] },
];

async function largeCase(d, index) {
  const { rows, fill } = LARGE[index], id = `large${index}`;
  const stored = fill ? [{ ...rows[0], bytes: b64('a'.repeat(fill)) }, ...rows.slice(1)] : rows;
  let runs = decodeMutationRunRows(stored);
  const decoded = fnv(runsJson(runs));
  const ops = [], inactive = new Set(), steps = [];
  for (let count = fill ? 0 : 6; count > 0; count -= 1) {
    if (ops.length && d.chance(0.35)) { const op = d.pick(ops); if (inactive.has(op)) inactive.delete(op); else inactive.add(op); }
    const op = `e${ops.length}`, base = visibleMutationRuns(runs, inactive), after = edit(d, mutationText(runs, inactive));
    runs = applyMutationText(runs, base, after, op);
    steps.push({ op, off: [...inactive], after: b64(after), budget: MUTATION_HUNK_WORK_BUDGET, f: fnv(runsJson(runs)), v: fnv(b64(mutationText(runs, inactive))) });
    ops.push(op);
  }
  const clock = (TEXT_SEED ^ index) >>> 0, slice = 0;
  return JSON.stringify({ id, input: rows, fill: fill ?? 0, decoded, steps, clock, slice, m: await traced(runs, clock, slice), ...await rowsAndSave(d, runs, id) });
}

export async function renderText(count) {
  const d = drawer(random(TEXT_SEED));
  const rows = [];
  for (let index = 0; index < count; index += 1) rows.push(`history\t${await history(d, index)}`);
  for (let index = 0; index < 12; index += 1) rows.push(`long\t${await long(d, index)}`);
  for (let index = 0; index < count / 2; index += 1) {
    const seed = (TEXT_SEED + 7 * index) >>> 0, clock = (seed ^ 0x9e3779b9) >>> 0, slice = d.pick([0, 1, 2, 5, 25]);
    rows.push(`ancestry\t${JSON.stringify({ seed, clock, slice, m: await traced(ancestryRuns(seed), clock, slice) })}`);
  }
  for (let index = 0; index < count; index += 1) rows.push(decodeCase(d));
  for (let index = 0; index < count; index += 1) rows.push(await documentCase(d));
  for (const bytes of BYTES_VALUES) rows.push(await documentCase(d, [[{ ...SAMPLE_RUN(), bytes }]]));
  for (const { pages, texts } of FIXED_DOCUMENTS) rows.push(await documentCase(d, pages, texts));
  for (let index = 0; index < LARGE.length; index += 1) rows.push(`large\t${await largeCase(d, index)}`);
  return vectorDocument(['# Generated by generate-text.mjs; do not edit. Rows: history, long, ancestry, decode, document, large (see the generator).'], rows);
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--count');
  const rendered = new Map([[TEXT_TRACKED, await renderText(TEXT_TRACKED)]]);
  if (at >= 0) rendered.set(Number(process.argv[at + 1]), await renderText(Number(process.argv[at + 1])));
  runGenerator({ file: TEXT_FILE, render: (count) => rendered.get(count), trackedCount: TEXT_TRACKED });
}
