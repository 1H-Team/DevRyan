#!/usr/bin/env node
// Reruns the measurement that justified the Rust ledger core (R0, research
// file 24), against the product code: the JavaScript diff
// (`javascriptMutationDiff`) against `mutationDiff` with DEVRYAN_LEDGER_RUST=1
// (the WebAssembly core, its copies in and the rebuild of the result
// included), arms interleaved and rotated, then, with --publication, one
// confined edit's `finish` with the switch off against on (and a second off
// arm, so the report shows the noise of an A/A comparison). The machine's load
// average is recorded with every shape. Nothing is written except --out and
// the publication fixtures, which live in a private run root under the OS temp
// dir and are removed afterwards.
//
//   <runtime> scripts/perf/mutation-diff-benchmark.mjs [--runs 11] [--shapes <regexp>] [--sizes 32k,256k,1m[,8m]]
//     [--publication] [--publication-only] [--publication-calls 11] [--publication-shapes <regexp>] [--out <report.json>]
//   <runtime> is Electron's Node (the ledger worker's runtime; the bar is judged there):
//     ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc
//   or `node --expose-gc`, or `bun`. Run the publication part under the isolation guard so the
//   runtime's Git and HOME are private: `node scripts/test-isolation-guard.mjs <runtime> <this script> --publication`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const SWITCH = 'DEVRYAN_LEDGER_RUST';

export function parseMutationDiffBenchmarkArgs(argv) {
  const options = { runs: 11, shapes: /./, sizes: ['32k', '256k', '1m'], publication: false, diff: true, publicationCalls: 11,
    publicationShapes: /./, out: null, runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib') };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    const count = () => { const parsed = Number(value()); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`); return parsed; };
    if (flag === '--runs') options.runs = count();
    else if (flag === '--shapes') options.shapes = new RegExp(value());
    else if (flag === '--sizes') options.sizes = value().split(',');
    else if (flag === '--publication') options.publication = true;
    else if (flag === '--publication-only') { options.publication = true; options.diff = false; }
    else if (flag === '--publication-calls') options.publicationCalls = count();
    else if (flag === '--publication-shapes') options.publicationShapes = new RegExp(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--runtime') options.runtime = path.resolve(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const size of options.sizes) if (!SIZES.has(size)) throw new Error(`Unknown size ${size} (one of ${[...SIZES.keys()].join(', ')})`);
  return options;
}

// R0's input shapes (research file 24, part B), from the same seeded source text.
const latin1 = (utf8) => Buffer.from(utf8, 'utf8').toString('latin1');
export function shapeGenerator(initial = 12345) {
  let seed = initial;
  const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  const words = ['const', 'value', 'return', 'function', 'export', 'import', 'await', 'async', 'if', 'else', 'for', 'while', 'index', 'result', 'error', 'path'];
  const line = () => { let out = '  '; for (let i = 0, n = 3 + random(9); i < n; i += 1) out += `${words[random(words.length)]}${random(100)} `; return `${out}\n`; };
  const source = (bytes) => { let out = ''; while (out.length < bytes) out += line(); return out; };
  const editAt = (base, fraction, insert) => { const at = base.indexOf('\n', Math.floor(base.length * fraction)) + 1; return base.slice(0, at) + insert + base.slice(at); };
  const twoEdits = (base, tag = '') => editAt(editAt(base, 0.9, `  inserted line two${tag}\n`), 0.1, `  inserted line one${tag}\n`);
  const tenHunks = (base, tag = '') => { let next = base; for (let k = 0; k < 10; k += 1) next = editAt(next, (random(1000) + 0.5) / 1001, `  edit ${k}${tag}\n`); return next; };
  return { source, editAt, twoEdits, tenHunks };
}
const SIZES = new Map([['32k', 32 * 1024], ['256k', 256 * 1024], ['1m', 1024 * 1024], ['8m', 8 * 1024 * 1024 - 4096]]);

export function diffShapes(sizes, filter = () => true) {
  const g = shapeGenerator();
  const out = [];
  for (const [label, size] of SIZES) {
    // Generate every size in order so each shape's text is R0's, whatever is selected.
    const ascii = g.source(size);
    const accented = latin1('// café — \u{1F600}\n') + ascii;
    const candidates = [
      [`${label} one edit`, () => [ascii, g.editAt(ascii, 0.5, '  inserted line one\n')]],
      [`${label} two edits`, () => [ascii, g.twoEdits(ascii)]],
      [`${label} ten hunks`, () => [ascii, g.tenHunks(ascii)]],
      [`${label} non-ascii two edits`, () => [accented, g.twoEdits(accented, latin1(' é'))]],
    ];
    for (const [name, make] of candidates) { const [before, after] = make(); if (sizes.includes(label) && filter(name)) out.push({ name, before, after }); }
  }
  for (const [label, size] of [['16k', 16 * 1024], ['256k', 256 * 1024]]) {
    const a = g.source(size), b = g.source(size);
    if (filter(`unrelated ${label}`)) out.push({ name: `unrelated ${label}`, before: a, after: b });
    if (filter(`unrelated non-ascii ${label}`)) out.push({ name: `unrelated non-ascii ${label}`, before: latin1('é') + a, after: latin1('éè') + b });
  }
  return out;
}

export const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quartiles = (values) => { const sorted = [...values].sort((x, y) => x - y); const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]; return [at(0.25), at(0.75)]; };
const load = () => os.loadavg().map((value) => Math.round(value * 100) / 100);
const runtimeName = () => process.versions.bun ? `bun ${process.versions.bun}` : process.versions.electron ? `electron-node ${process.version} (electron ${process.versions.electron})` : `node ${process.version}`;
const collect = globalThis.gc ?? (globalThis.Bun ? () => globalThis.Bun.gc(true) : null);
const gc = () => collect?.();
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const sameResult = (x, y) => x.length === y.length && x.every((change, index) => change.kind === y[index].kind && change.text === y[index].text);
// Sets the switch for `action` (sync or async) and restores the caller's value afterwards.
const withSwitch = (on, action) => {
  const previous = process.env[SWITCH];
  const restore = () => { if (previous === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = previous; };
  if (on) process.env[SWITCH] = '1'; else delete process.env[SWITCH];
  let result;
  try { result = action(); } catch (cause) { restore(); throw cause; }
  if (typeof result?.then === 'function') return result.finally(restore);
  restore();
  return result;
};

async function benchmarkDiff(options, text, core) {
  const arms = {
    js: (before, after) => text.javascriptMutationDiff(before, after),
    rust: (before, after) => withSwitch(true, () => text.mutationDiff(before, after)),
  };
  const rows = [];
  for (const { name, before, after } of diffShapes(options.sizes, (shape) => options.shapes.test(shape))) {
    const loadStart = load();
    // Warm both paths and check they agree, and that the Rust arm was answered by the core.
    const expected = arms.js(before, after); arms.js(before, after);
    const start = text.mutationDiffPaths();
    if (!sameResult(expected, arms.rust(before, after))) throw new Error(`The two paths differ on ${name}`);
    if (text.mutationDiffPaths().rust !== start.rust + 1) throw new Error(`The Rust arm fell back on ${name}`);
    arms.rust(before, after);
    const times = { js: [], rust: [] };
    let retained = 0;
    const paths = text.mutationDiffPaths();
    for (let run = 0; run < options.runs; run += 1) {
      for (const arm of run % 2 ? ['rust', 'js'] : ['js', 'rust']) {
        gc();
        const started = performance.now();
        arms[arm](before, after);
        times[arm].push(performance.now() - started);
        if (arm === 'rust') retained = Math.max(retained, core.inspect().memoryBytes);
      }
    }
    const used = text.mutationDiffPaths();
    if (used.rust - paths.rust !== options.runs || used.javascript !== paths.javascript) throw new Error(`The Rust arm fell back on ${name}`);
    const row = { name, bytes: before.length + after.length, changes: expected.length, loadStart, loadEnd: load(), retainedBytes: retained,
      js: { p50: round(median(times.js)), iqr: quartiles(times.js).map((v) => round(v)) },
      rust: { p50: round(median(times.rust)), iqr: quartiles(times.rust).map((v) => round(v)) } };
    row.factor = round(row.js.p50 / row.rust.p50, 2);
    rows.push(row);
    console.error(`${name.padEnd(28)} js ${row.js.p50.toFixed(2).padStart(9)} ms  rust ${row.rust.p50.toFixed(2).padStart(8)} ms  x${row.factor.toFixed(1).padStart(5)}  retained ${(retained / 1048576).toFixed(1)} MiB  load ${row.loadStart[0]}`);
  }
  return rows;
}

// R0's publication driver (research file 24, part D) on the product runtime:
// one tracked file of the given size plus 40 small files, a warm, two untimed
// calls, then calls that rotate the arms off, on and off again (A/A noise).
const PUBLICATION_SHAPES = [['32k two', 32 * 1024, 'two'], ['32k ten', 32 * 1024, 'ten'], ['256k two', 256 * 1024, 'two'],
  ['256k ten', 256 * 1024, 'ten'], ['1m two', 1024 * 1024, 'two'], ['1m ten', 1024 * 1024, 'ten']];
const PUBLICATION_ARMS = ['off', 'on', 'off-again'];

async function benchmarkPublication(options, text) {
  if (!process.env.DEVRYAN_TEST_ISOLATION_ROOT) throw new Error('Run the publication benchmark under node scripts/test-isolation-guard.mjs, so the runtime\'s HOME and Git configuration are private');
  const { createSessionMutationRuntime } = await import(pathToFileURL(path.join(options.runtime, 'session-mutations.js')).href);
  const rows = [];
  for (const [name, size, shape] of PUBLICATION_SHAPES) {
    if (!options.publicationShapes.test(name)) continue;
    const run = createRunRoot({ parent: scratchParent('perf'), prefix: 'mutation-diff-', owner: 'scripts/perf/mutation-diff-benchmark.mjs', extraPayloads: ['project', 'ledger'] });
    let runtime = null, completed = false;
    try {
      const g = shapeGenerator();
      const project = path.join(run.dir, 'project'), storage = path.join(run.dir, 'ledger');
      await fs.mkdir(path.join(project, 'src'), { recursive: true });
      const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
      git('init', '-q', '-b', 'main');
      const target = 'src/target.js';
      await fs.writeFile(path.join(project, target), g.source(size), 'latin1');
      for (let index = 0; index < 40; index += 1) await fs.writeFile(path.join(project, 'src', `small-${index}.js`), g.source(2048));
      git('add', '-A'); git('commit', '-q', '-m', 'fixture');
      runtime = createSessionMutationRuntime({ directory: storage });
      await runtime.warm?.({ directory: project });
      const edit = (before, call) => shape === 'ten' ? g.tenHunks(before, ` c${call}`) : g.twoEdits(before, ` c${call}`);
      const loadStart = load();
      const samples = Object.fromEntries(PUBLICATION_ARMS.map((arm) => [arm, []]));
      const total = 2 + options.publicationCalls * PUBLICATION_ARMS.length;
      for (let call = 0; call < total; call += 1) {
        const arm = PUBLICATION_ARMS[call % PUBLICATION_ARMS.length];
        const input = { directory: project, sessionID: 's1', userMessageID: `u${call}`, messageID: `u${call}-assistant`, callID: `c${call}` };
        const lease = await runtime.begin(input);
        await runtime.claimLease({ directory: project, token: lease.token, kind: 'process' });
        const file = path.join(lease.workingDirectory, target);
        await fs.writeFile(file, edit(await fs.readFile(file, 'latin1'), call), 'latin1');
        await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
          JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
        gc();
        const before = text.mutationDiffPaths();
        const started = performance.now();
        await withSwitch(arm === 'on', () => runtime.finish({ directory: project, token: lease.token }));
        const finishMs = performance.now() - started;
        const after = text.mutationDiffPaths();
        const diffs = { rust: after.rust - before.rust, javascript: after.javascript - before.javascript };
        // Each finish diffs the edited file once, on the arm's path.
        if (call >= 2 && (arm === 'on' ? diffs.rust !== 1 || diffs.javascript !== 0 : diffs.rust !== 0 || diffs.javascript !== 1)) {
          throw new Error(`${name} call ${call} (${arm}) took the wrong path: ${JSON.stringify(diffs)}`);
        }
        await runtime.cleanupLease({ directory: project, token: lease.token });
        if (call >= 2) samples[arm].push(finishMs);
      }
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.drain?.();
      const row = { name, bytes: size, shape, calls: options.publicationCalls, loadStart, loadEnd: load(),
        ...Object.fromEntries(PUBLICATION_ARMS.map((arm) => [arm, { p50: round(median(samples[arm]), 1), iqr: quartiles(samples[arm]).map((v) => round(v, 1)) }])) };
      row.gain = round(1 - row.on.p50 / row.off.p50, 3);
      row.noise = round(Math.abs(1 - row['off-again'].p50 / row.off.p50), 3);
      rows.push(row);
      console.error(`publication ${name.padEnd(9)} off ${row.off.p50.toFixed(1).padStart(7)} ms  on ${row.on.p50.toFixed(1).padStart(7)} ms  gain ${(row.gain * 100).toFixed(1).padStart(5)}%  A/A ${(row.noise * 100).toFixed(1)}%  load ${loadStart[0]}`);
      completed = true;
    } finally {
      await runtime?.drain?.().catch(() => {});
      run.finish(completed ? 'passed' : 'failed');
    }
  }
  return rows;
}

export async function runMutationDiffBenchmark(options) {
  const text = await import(pathToFileURL(path.join(options.runtime, 'session-mutation-text.js')).href);
  const { ledgerCore } = await import(pathToFileURL(path.join(options.runtime, 'ledger-core.js')).href);
  if (typeof text.javascriptMutationDiff !== 'function' || typeof text.mutationDiffPaths !== 'function') throw new Error(`${options.runtime} has no Rust diff path`);
  const report = { runtime: runtimeName(), gc: Boolean(collect), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null,
    runs: options.runs, loadStart: load(), uptimeStart: execFileSync('uptime').toString().trim(), diff: [], publication: [] };
  if (!collect) console.error('No gc(): run with --expose-gc (Node, Electron) for steadier numbers.');
  console.error(`${report.runtime}; ${report.uptimeStart}`);
  if (options.diff) report.diff = await benchmarkDiff(options, text, ledgerCore);
  if (options.publication) report.publication = await benchmarkPublication(options, text);
  report.loadEnd = load();
  report.uptimeEnd = execFileSync('uptime').toString().trim();
  console.error(report.uptimeEnd);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseMutationDiffBenchmarkArgs(process.argv.slice(2));
  const report = await runMutationDiffBenchmark(options);
  if (options.out) await fs.writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
  else console.log(JSON.stringify(report));
}
