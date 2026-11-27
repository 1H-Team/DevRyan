#!/usr/bin/env node
// The client-engine differential (package C0i's fix round): the families
// ported to Rust (packages/native/crates/client-engine), called on generated
// inputs (client-generators.mjs, client-family-generators.mjs; seeded, the
// same calls on every runtime) by three arms, and every call's record (the
// arguments as the engine saw them, what it returned or threw, the
// arguments after the call, a draft's change set) compared:
//
// - `v8`: the family's TypeScript, bundled to JavaScript (`bun build`, into
//   scratch) and run under Electron's Node (ELECTRON_RUN_AS_NODE, the
//   ledger's reference runtime: the product's renderer engine), or this
//   Node where Electron's binary is absent (also V8; the run says which);
// - `jsc`: the same bundle under Bun (JavaScriptCore, the engine the
//   recordings are made with);
// - `rust`: the Rust runner, over engine protocol 5, one case per call;
// - `engine-ts` (a check of this driver, not an engine): the harness's own
//   TypeScript engine under Bun, over the same protocol, whose records must
//   equal the `jsc` arm's exactly, so the arms record a call as the replayer
//   does.
//
// V8 is the reference (the Rust engine replaces the renderer's). A
// disagreement of the Rust with V8 is a defect unless it is an
// engine-written message (compared by class only, candidate-compare.mjs
// ENGINE_ERRORS). A disagreement of V8 with JavaScriptCore is measured and
// listed by kind: those are the engine differences (docs/TESTING.md,
// "Engine differences").
//
//   node client-differential.mjs [--families=a,b] [--calls=N] [--seed=S] [--profile=full|typed|both]
//                                [--arms=v8,jsc,rust] [--runner=<binary>] [--batch=N] [--json=<file>]
//                                [--show=N] [--plant=<id>] [--keep-artifacts]
//
// It runs in batches (`--batch`, 400 calls by default): each batch's calls
// are written to a scratch file, each arm runs once on it as a child process
// of its own, one at a time (the Rust runner is the one long-lived child),
// and the batch is compared and dropped, so memory stays bounded whatever
// `--calls` is. Every child has a deadline and is named when it is killed;
// the scratch is removed on pass, failure and interruption. Exit 0 when no
// Rust call disagrees with V8 beyond engine-written messages, 1 otherwise,
// 3 when an arm failed, 64 usage. The tracked client-engine vectors use the
// same arms. `--plant=<id>` runs the Rust arm with one planted
// difference of the crate turned on (`client-engine-runner --plant=<id>`): a
// plant the differential catches makes the run exit 1. Run on demand; no
// gate runs it.
//
// The arm itself (internal): `<runtime> client-differential.mjs --arm --bundle=<file> --family=<name>
// --input=<file> --output=<file>`.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const UI_DIR = path.join(ROOT, 'packages', 'ui');
const PORT_MAP = path.join(HERE, 'product', 'product-port-map.json');
export const DEFAULT_RUNNER = path.join(ROOT, 'packages', 'native', 'target', 'release', 'client-engine-runner');
/** Every child's deadline. */
const CHILD_DEADLINE_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------- records
/**
 * The change set of a draft, by the recorder's rule (every object reached,
 * each once below; Map entries by key; functions not walked; array indices as
 * numbers): the paths whose object is not the one there before.
 */
export function identityPaths(root) {
  const paths = [];
  const visited = new Set();
  const walk = (value, where) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    paths.push([where, value]);
    if (visited.has(value) || typeof value === 'function') return;
    visited.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value.entries()) walk(entry, [...where, { map: key }]);
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) continue;
      walk(descriptor.value, [...where, Array.isArray(value) && /^\d+$/.test(key) ? Number(key) : key]);
    }
  };
  walk(root, []);
  return paths;
}
function pathKey(where, keys) {
  return where.map((part) => {
    if (part === null || typeof part !== 'object') return JSON.stringify(part);
    let id = keys.get(part.map);
    if (id === undefined) { id = keys.size; keys.set(part.map, id); }
    return `{map:${id}}`;
  }).join('/');
}
export function changedPaths(before, root) {
  const keys = new Map();
  const known = new Map();
  for (const [where, value] of before) known.set(pathKey(where, keys), value);
  return identityPaths(root).filter(([where, value]) => known.get(pathKey(where, keys)) !== value).map(([where]) => where);
}

/** The exports of each family that take a draft (the port map's `entries`), `{ family: { export: index } }`. */
export function draftsOf(portMapFile = PORT_MAP) {
  const map = JSON.parse(readFileSync(portMapFile, 'utf8'));
  return Object.fromEntries(map.families.map((family) => [family.name, Object.fromEntries((family.entries ?? []).filter((entry) => entry.draft !== undefined).map((entry) => [entry.export, entry.draft]))]));
}

/** Identity numbers renumbered by first appearance in the record (each arm numbers its own). */
export function renumbered(record) {
  const numbers = new Map();
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(visit);
    const out = {};
    for (const key of Object.keys(node)) {
      const value = visit(node[key]);
      if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      else out[key] = value;
    }
    if ((node.$dr === 'id' || node.$dr === 'ref') && typeof node.n === 'number') {
      if (!numbers.has(node.n)) numbers.set(node.n, numbers.size + 1);
      out.n = numbers.get(node.n);
    }
    return out;
  };
  return visit(record);
}

/** The compared parts of a record, in a fixed order. */
export const recordOf = (step) => {
  const out = { args: step.args ?? step.input?.args };
  for (const key of ['returns', 'throws', 'after', 'changes']) if (step[key] !== undefined) out[key] = step[key];
  return out;
};

/** The paths of a record's engine-written errors under `engine`'s shapes (candidate-compare.mjs ENGINE_ERRORS). */
export function engineErrorPaths(record, isEngineError, engine) {
  const out = [];
  const visit = (node, at) => {
    if (node === null || typeof node !== 'object') return;
    if (isEngineError(node, engine)) { out.push(at); return; }
    if (Array.isArray(node)) node.forEach((item, index) => visit(item, [...at, index]));
    else for (const key of Object.keys(node)) visit(node[key], [...at, key]);
  };
  visit(record, []);
  return out;
}

/** `record` with the message of each error at `paths` put as a marker (both sides of a comparison alike). */
export function withoutMessages(record, paths) {
  if (!paths.length) return record;
  const copy = structuredClone(record);
  for (const at of paths) {
    let node = copy;
    for (const part of at) node = node !== null && typeof node === 'object' ? node[part] : undefined;
    const error = node !== null && typeof node === 'object' && node.$dr === 'id' ? node.value : node;
    if (error !== null && typeof error === 'object' && error.$dr === 'class' && error.error) error.error = { ...error.error, message: '<engine-written>' };
  }
  return copy;
}

// ----------------------------------------------------------------------- arm
/** Runs one batch in this runtime: each input line `{ entry, args }` called on the bundle, one record per line out. */
async function arm({ bundle, family, input, output }) {
  const codec = await import(pathToFileURL(path.join(HERE, 'codec.mjs')).href);
  const module = await import(pathToFileURL(bundle).href);
  const drafts = draftsOf()[family] ?? {};
  const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const { entry, args: tree } = JSON.parse(line);
    const context = codec.createCodecContext();
    const [args] = codec.decodeSlots([tree], context);
    const slots = [codec.snapshot(args, context)];
    const draft = drafts[entry];
    const before = draft !== undefined ? identityPaths(args[draft]) : null;
    let result;
    let threw = false;
    try { result = module[entry](...args); } catch (error) { threw = true; result = error; }
    slots.push(codec.snapshot(result, context));
    const list = [];
    for (let index = 0; index < args.length; index += 1) list[index] = args[index];
    slots.push(codec.snapshot(list, context));
    if (before) slots.push(codec.snapshot(changedPaths(before, args[draft]), context));
    const trees = codec.emitSlots(slots);
    const record = { args: trees[0], [threw ? 'throws' : 'returns']: trees[1], after: trees[2], ...(before ? { changes: trees[3] } : {}) };
    out.push(JSON.stringify(record));
  }
  writeFileSync(output, `${out.join('\n')}\n`);
}

// ------------------------------------------------------------------- drivers
/** A child process with a deadline; resolves `{ code, stderr }` at `close` (stderr bounded). */
export function runChild(name, command, args, { cwd = ROOT, env = {}, deadlineMs = CHILD_DEADLINE_MS } = {}) {
  return new Promise((resolve) => {
    const { GITHUB_ACTIONS: _hosted, ...inherited } = process.env;
    const child = spawn(command, args, { cwd, env: { ...inherited, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    const timer = setTimeout(() => { stderr += `\n${name} passed its deadline of ${deadlineMs} ms and was killed`; child.kill('SIGKILL'); }, deadlineMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 128 : 1), stderr }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 127, stderr: `${name}: ${error.message}` }); });
  });
}

/** Bundles each family's TypeScript module into `dir` with `bun build` (the repository's bundler for the TypeScript engine). */
export async function bundleFamilies(families, dir) {
  const map = JSON.parse(readFileSync(PORT_MAP, 'utf8'));
  const bundles = {};
  for (const family of families) {
    const entry = map.families.find((item) => item.name === family);
    if (!entry) throw new Error(`family ${family} is not in the product port map`);
    const source = path.resolve(path.dirname(PORT_MAP), entry.module);
    const outfile = path.join(dir, `${family}.mjs`);
    const built = await runChild(`bun build of ${family}`, 'bun', ['build', source, '--target=node', '--format=esm', `--outfile=${outfile}`], { cwd: UI_DIR, deadlineMs: 120000 });
    if (built.code !== 0) throw new Error(`bun build of ${family} failed: ${built.stderr.trim().slice(-2000)}`);
    bundles[family] = outfile;
  }
  return bundles;
}

/** The arms' commands: V8 (Electron's Node, or this Node) and JavaScriptCore (Bun). */
export async function armRuntimes() {
  const { referenceRuntime } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'ledger-native', 'reference-runtime.mjs')).href);
  const v8 = referenceRuntime();
  return {
    v8: { command: v8.command, env: { ...v8.env }, description: v8.description },
    jsc: { command: 'bun', env: {}, description: 'Bun (JavaScriptCore)' },
  };
}

/** Runs one arm on a batch file; resolves the records, one per call. */
export async function runArm(name, runtime, { bundle, family, input, output }) {
  const ran = await runChild(`the ${name} arm (${family})`, runtime.command, [fileURLToPath(import.meta.url), '--arm', `--bundle=${bundle}`, `--family=${family}`, `--input=${input}`, `--output=${output}`], { env: runtime.env });
  if (ran.code !== 0) throw new Error(`the ${name} arm of ${family} exited ${ran.code}: ${ran.stderr.trim().slice(-2000)}`);
  return readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** The Rust runner over protocol 5: one case per call; resolves each call's record. */
export async function rustRecords(engine, unit, calls) {
  const { expandStrings } = await import(pathToFileURL(path.join(HERE, 'engine.mjs')).href);
  const out = [];
  for (const call of calls) {
    const opened = await engine.request({ op: 'case', unit }, { what: 'case' });
    if (!opened.ok) throw new Error(`case: ${opened.error}`);
    const stepped = await engine.request({ op: 'step', unit, step: { input: { kind: 'call', entry: call.entry, args: call.args, now: 1 }, env: [], bind: [], entryBind: [] } }, { what: `step ${call.entry}` });
    if (!stepped.ok) throw new Error(`step: ${stepped.error}`);
    const ended = await engine.request({ op: 'end', unit }, { what: 'end' });
    if (!ended.ok) throw new Error(`end: ${ended.error}`);
    const steps = expandStrings(ended.replayed.steps, ended.replayed.strings ?? []);
    out.push(ended.replayed.halt ? { halt: ended.replayed.halt } : recordOf(steps[0]));
  }
  return out;
}

/** The generated calls of a family, encoded as codec trees (one slot each, as a step's arguments travel). */
export async function generatedCalls(family, { seed, count, typed }) {
  const generators = await import(pathToFileURL(path.join(HERE, 'client-generators.mjs')).href);
  const { FAMILY_GENERATORS } = await import(pathToFileURL(path.join(HERE, 'client-family-generators.mjs')).href);
  const codec = await import(pathToFileURL(path.join(HERE, 'codec.mjs')).href);
  generators.PROFILE.typed = typed;
  const seedOf = seed * 1000003 + [...family].reduce((sum, character) => sum * 31 + character.charCodeAt(0), 7) % 1000003;
  const random = generators.rngOf(seedOf);
  const calls = [];
  while (calls.length < count) {
    const { entry, args } = FAMILY_GENERATORS[family](random);
    const context = codec.createCodecContext();
    let tree;
    try { [tree] = codec.emitSlots([codec.snapshot(args, context)]); } catch { continue; }
    if (context.flags.size) continue;
    calls.push({ entry, args: tree });
  }
  generators.PROFILE.typed = false;
  return calls;
}

/** How two records differ: `null` when equal; else the first differing part and whether only engine-written messages differ. */
export function difference(left, right, { isEngineError, leftEngine, rightEngine }) {
  const a = JSON.stringify(renumbered(left));
  const b = JSON.stringify(renumbered(right));
  if (a === b) return null;
  const paths = engineErrorPaths(left, isEngineError, leftEngine);
  const otherPaths = rightEngine ? engineErrorPaths(right, isEngineError, rightEngine) : paths;
  const same = paths.length && JSON.stringify(paths) === JSON.stringify(otherPaths);
  if (same && JSON.stringify(renumbered(withoutMessages(left, paths))) === JSON.stringify(renumbered(withoutMessages(right, paths)))) return { kind: 'engine-message' };
  const part = ['args', 'returns', 'throws', 'after', 'changes', 'halt'].find((key) => JSON.stringify(renumbered(left)[key]) !== JSON.stringify(renumbered(right)[key]));
  const outcome = (record) => (record.halt ? 'halt' : record.throws !== undefined ? 'throws' : 'returns');
  return { kind: outcome(left) !== outcome(right) ? `${outcome(left)}-vs-${outcome(right)}` : `value-${part}` };
}

const FAMILIES = Object.freeze(['native-cursor-text', 'tool-status', 'sanitize', 'tool-output', 'message-order', 'session-diff-stats', 'session-working', 'live-aggregate', 'optimistic', 'revert-transactions', 'materialization']);
export { FAMILIES as PORTED_FAMILIES };

async function main(argv) {
  const options = Object.fromEntries(argv.map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.length ? rest.join('=') : true]; }));
  if (options.arm) { await arm(options); return 0; }
  const known = new Set(['families', 'calls', 'seed', 'profile', 'arms', 'runner', 'batch', 'json', 'show', 'plant', 'keep-artifacts']);
  const unknown = Object.keys(options).filter((key) => !known.has(key));
  if (unknown.length) { console.error(`client-differential: unknown option --${unknown[0]}`); return 64; }
  const families = options.families ? String(options.families).split(',') : FAMILIES;
  const calls = Number(options.calls ?? 2000);
  const seed = Number(options.seed ?? 1);
  const batch = Number(options.batch ?? 400);
  const show = Number(options.show ?? 3);
  const profiles = options.profile === 'typed' ? [true] : options.profile === 'both' ? [false, true] : [false];
  const arms = String(options.arms ?? 'v8,jsc,rust').split(',');
  if (arms.includes('engine-ts') && !arms.includes('jsc')) arms.push('jsc');
  if (!families.every((family) => FAMILIES.includes(family)) || ![calls, seed, batch].every(Number.isInteger) || batch < 1 || !arms.includes('v8')) { console.error('client-differential: --families names ported families, --calls, --seed and --batch are integers, --arms includes v8'); return 64; }
  const { createScratch } = await import(pathToFileURL(path.join(HERE, 'record.mjs')).href);
  const { openEngine } = await import(pathToFileURL(path.join(HERE, 'engine.mjs')).href);
  const { isEngineError } = await import(pathToFileURL(path.join(HERE, 'candidate-compare.mjs')).href);
  const { familyDescriptor } = await import(pathToFileURL(path.join(HERE, 'replay.mjs')).href);
  const { typescriptEngine } = await import(pathToFileURL(path.join(HERE, 'engine.mjs')).href);
  let tsEngine = null;
  const { loadPortMap } = await import(pathToFileURL(path.join(HERE, 'port-map.mjs')).href);
  const scratch = createScratch('client-differential', { keepArtifacts: options['keep-artifacts'] === true });
  let status = 'failed';
  let engine = null;
  try {
    const runtimes = await armRuntimes();
    console.log(`v8 arm: ${runtimes.v8.description}; jsc arm: ${runtimes.jsc.description}${arms.includes('rust') ? `; rust arm: ${options.runner ?? DEFAULT_RUNNER}` : ''}`);
    const bundles = await bundleFamilies(families, scratch.dir);
    const portMap = loadPortMap(PORT_MAP, { root: ROOT });
    if (arms.includes('rust')) engine = openEngine({ name: 'client-engine-runner', command: options.runner ?? DEFAULT_RUNNER, args: options.plant ? [`--plant=${options.plant}`] : [], cwd: ROOT, deadlineMs: CHILD_DEADLINE_MS });
    if (engine) { const hello = await engine.request({ op: 'hello', protocol: 5 }, { what: 'hello' }); if (!hello.ok) throw new Error(hello.error); }
    if (arms.includes('engine-ts')) {
      tsEngine = openEngine({ ...typescriptEngine({ cwd: UI_DIR }), deadlineMs: CHILD_DEADLINE_MS });
      const hello = await tsEngine.request({ op: 'hello', protocol: 5 }, { what: 'hello' });
      if (!hello.ok) throw new Error(hello.error);
    }
    const report = { seed, calls, profiles: profiles.map((typed) => (typed ? 'typed' : 'full')), runtimes: { v8: runtimes.v8.description, jsc: runtimes.jsc.description }, families: {} };
    let unit = 0;
    for (const family of families) {
      const row = (report.families[family] = { calls: 0, rustVsV8: {}, v8VsJsc: {}, jscVsEngine: {}, examples: { rustVsV8: [], v8VsJsc: [], jscVsEngine: [] } });
      unit += 1;
      for (const process of [engine, tsEngine].filter(Boolean)) { const opened = await process.request({ op: 'open', unit, family: familyDescriptor(portMap, family), plants: [] }, { what: `open ${family}` }); if (!opened.ok) throw new Error(`open ${family}: ${opened.error}`); }
      for (const typed of profiles) {
        const all = await generatedCalls(family, { seed: typed ? seed + 7919 : seed, count: calls, typed });
        for (let start = 0; start < all.length; start += batch) {
          const slice = all.slice(start, start + batch);
          const input = path.join(scratch.dir, `${family}.input.ndjson`);
          writeFileSync(input, `${slice.map((call) => JSON.stringify(call)).join('\n')}\n`);
          const v8 = await runArm('v8', runtimes.v8, { bundle: bundles[family], family, input, output: path.join(scratch.dir, `${family}.v8.ndjson`) });
          const jsc = arms.includes('jsc') ? await runArm('jsc', runtimes.jsc, { bundle: bundles[family], family, input, output: path.join(scratch.dir, `${family}.jsc.ndjson`) }) : null;
          const rust = engine ? await rustRecords(engine, unit, slice) : null;
          const typescript = tsEngine ? await rustRecords(tsEngine, unit, slice) : null;
          slice.forEach((call, at) => {
            row.calls += 1;
            // `profile` and `index` name the call in its generator's sequence (the vectors take witnesses by them).
            const tally = (bucket, examples, found, other) => { if (!found) return; bucket[found.kind] = (bucket[found.kind] ?? 0) + 1; if (examples.filter((item) => item.kind === found.kind).length < show) examples.push({ kind: found.kind, profile: typed ? 'typed' : 'full', index: start + at, entry: call.entry, args: call.args, v8: v8[at], other }); };
            if (rust) tally(row.rustVsV8, row.examples.rustVsV8, difference(v8[at], rust[at], { isEngineError, leftEngine: 'v8', rightEngine: null }), rust[at]);
            if (jsc) tally(row.v8VsJsc, row.examples.v8VsJsc, difference(v8[at], jsc[at], { isEngineError, leftEngine: 'v8', rightEngine: 'javascriptcore' }), jsc[at]);
            // The driver's own check: its JavaScriptCore arm records a call exactly as the TypeScript engine does.
            if (jsc && typescript && JSON.stringify(renumbered(jsc[at])) !== JSON.stringify(renumbered(typescript[at]))) tally(row.jscVsEngine, row.examples.jscVsEngine, { kind: 'differs' }, typescript[at]);
          });
        }
      }
      for (const process of [engine, tsEngine].filter(Boolean)) await process.request({ op: 'close', unit, force: true }, { what: `close ${family}` });
      const summary = (bucket) => Object.entries(bucket).map(([kind, count]) => `${kind} ${count}`).join(', ') || 'none';
      const defects = Object.entries(row.rustVsV8).filter(([kind]) => kind !== 'engine-message').reduce((sum, [, count]) => sum + count, 0);
      row.defects = defects + Object.values(row.jscVsEngine).reduce((sum, count) => sum + count, 0);
      console.log(`${family}: ${row.calls} calls; rust against v8: ${engine ? summary(row.rustVsV8) : 'not run'}; v8 against jsc: ${arms.includes('jsc') ? summary(row.v8VsJsc) : 'not run'}${tsEngine ? `; jsc arm against the TypeScript engine: ${summary(row.jscVsEngine)}` : ''}`);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    const defects = Object.values(report.families).reduce((sum, row) => sum + row.defects, 0);
    const total = Object.values(report.families).reduce((sum, row) => sum + row.calls, 0);
    console.log(`client differential: ${total} calls over ${families.length} families; ${defects} Rust disagreements with V8 beyond engine-written messages; exit ${defects ? 1 : 0}`);
    status = defects ? 'failed' : 'passed';
    return defects ? 1 : 0;
  } catch (error) {
    console.error(`client differential: ${error.stack ?? error}`);
    return 3;
  } finally {
    if (engine) await engine.stop();
    if (tsEngine) await tsEngine.stop();
    scratch.finish(status);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
