#!/usr/bin/env node
// The client-engine vectors (package C0i's fix round): per family ported to
// Rust, a tracked file of generated calls and the answers the family's
// TypeScript gives under V8 (Electron's Node, the product's renderer engine:
// client-differential.mjs's `v8` arm), which the Rust crate's cargo test
// (packages/native/crates/client-engine-runner/tests/client_vectors.rs)
// replays through the runner with no recording, no Bun and no Node, so the
// differential is a gate wherever packages/native is checked.
//
//   node client-vectors.mjs            write the vector files (scratch for the bundles, removed after)
//   node client-vectors.mjs --check    regenerate and compare: exit 1 naming each family whose file is stale
//   node client-vectors.mjs --inputs   compare only the inputs (the generators; no TypeScript runs): exit 1 if stale
//   node client-vectors.mjs --witnesses-from=<dir>   take witnesses from a directory of differential reports, then write
//
// A family's calls are the first of its generators' sequences (`countsOf`)
// and its witnesses (`client-vectors/witnesses.json`): later calls of the same
// sequences, named by profile and index, each the first call on which the
// differential (`client-differential.mjs --plant=<id> --seed=<SEED>`) told a
// planted difference of the Rust from V8, so the tracked set catches what the
// differential catches at a size a repository keeps.
//
// Each file: a header line (`format`, the family, its port-map descriptor,
// the seed, the counts, the engine that answered, a SHA-256 of the input
// lines), then one line per call: `{ entry, args, record, engineMessages }`,
// `record` the step as the replayer compares it (the arguments the engine saw,
// what it returned or threw, the arguments after, a draft's change set) and
// `engineMessages` the paths in it of errors V8 wrote itself (compared by
// class only). The inputs depend only on the generators (client-generators.mjs,
// client-family-generators.mjs) and the seed; the answers on the family's
// TypeScript under packages/ui, which is why only the input comparison is part
// of the per-push gate (docs/TESTING.md, "Client-engine differential and vectors").
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { armRuntimes, bundleFamilies, engineErrorPaths, generatedCalls, PORTED_FAMILIES, runArm } from './client-differential.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const VECTOR_DIR = path.join(ROOT, 'packages', 'native', 'crates', 'client-engine-runner', 'tests', 'client-vectors');
export const FORMAT = 'devryan-client-vectors@1';
/**
 * Calls per family: realistic shapes with wrong types, holes and edge values (`full`), then realistic shapes only
 * (`typed`); fewer for the families whose calls carry whole session states, so each file stays under about 700 KB.
 */
const BASE = Object.freeze({ full: 160, typed: 40 });
const SCALE = Object.freeze({ materialization: 0.35, 'revert-transactions': 0.6, 'live-aggregate': 0.6, optimistic: 0.7, 'tool-output': 0.75 });
export const countsOf = (family) => ({ full: Math.round(BASE.full * (SCALE[family] ?? 1)), typed: Math.round(BASE.typed * (SCALE[family] ?? 1)) });
export const SEED = 20261126;

export const vectorFile = (family) => path.join(VECTOR_DIR, `${family}.ndjson`);
export const WITNESS_FILE = path.join(VECTOR_DIR, 'witnesses.json');

/** The tracked witnesses: `{ family: [{ profile, index, plant }] }` (none when the file is absent). */
export function readWitnesses() {
  if (!existsSync(WITNESS_FILE)) return {};
  const parsed = JSON.parse(readFileSync(WITNESS_FILE, 'utf8'));
  if (parsed.format !== 'devryan-client-vector-witnesses@1' || parsed.seed !== SEED) throw new Error(`${path.basename(WITNESS_FILE)}: format ${parsed.format}, seed ${parsed.seed}; expected devryan-client-vector-witnesses@1 for seed ${SEED}`);
  return parsed.families;
}
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The generated calls of a family, full then typed, each `{ entry, args }`. */
export async function vectorInputs(family, witnesses = readWitnesses()) {
  const counts = countsOf(family);
  const own = (witnesses[family] ?? []).filter((item) => item.index >= counts[item.profile]);
  const reach = (profile) => Math.max(counts[profile], ...own.filter((item) => item.profile === profile).map((item) => item.index + 1));
  const full = await generatedCalls(family, { seed: SEED, count: reach('full'), typed: false });
  const typed = await generatedCalls(family, { seed: SEED + 7919, count: reach('typed'), typed: true });
  const picked = own.map((item) => ({ ...(item.profile === 'full' ? full : typed)[item.index], witness: item.plant }));
  return [...full.slice(0, counts.full), ...typed.slice(0, counts.typed), ...picked];
}

/** The witnesses of a directory of differential reports (`--json` of runs with `--plant`), one per plant and family. */
export function witnessesFrom(directory, files) {
  const families = {};
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const plant = path.basename(file, '.json');
    const report = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
    for (const [family, row] of Object.entries(report.families ?? {})) {
      const found = (row.examples?.rustVsV8 ?? []).find((item) => item.kind !== 'engine-message');
      if (!found) continue;
      const list = (families[family] ??= []);
      if (!list.some((item) => item.profile === found.profile && item.index === found.index)) list.push({ profile: found.profile, index: found.index, plant });
    }
  }
  for (const list of Object.values(families)) list.sort((a, b) => (a.profile === b.profile ? a.index - b.index : a.profile < b.profile ? -1 : 1));
  return families;
}

/** The input lines' digest (what `--inputs` compares). */
export const inputsDigest = (inputs) => sha256(inputs.map(({ entry, args }) => JSON.stringify({ entry, args })).join('\n'));

/** A vector file's lines from its inputs and the V8 arm's records. */
export async function vectorText(family, inputs, records, { descriptor, engine }) {
  const { isEngineError } = await import(pathToFileURL(path.join(HERE, 'candidate-compare.mjs')).href);
  // The descriptor's module path from the repository's root (the file is compared as bytes on every machine).
  const portable = { ...descriptor, module: path.relative(ROOT, descriptor.module).split(path.sep).join('/') };
  const header = { format: FORMAT, family, descriptor: portable, seed: SEED, counts: { ...countsOf(family), witnesses: inputs.filter((call) => call.witness).length }, engine, inputs: inputsDigest(inputs) };
  const lines = inputs.map((call, at) => JSON.stringify({ entry: call.entry, args: call.args, ...(call.witness ? { witness: call.witness } : {}), record: records[at], engineMessages: engineErrorPaths(records[at], isEngineError, 'v8') }));
  return `${[JSON.stringify(header), ...lines].join('\n')}\n`;
}

/** Reads a tracked vector file: `{ header, lines }`; throws naming what is wrong. */
export function readVectorFile(file) {
  const text = readFileSync(file, 'utf8');
  const [first, ...rest] = text.split('\n').filter(Boolean);
  const header = JSON.parse(first);
  if (header.format !== FORMAT) throw new Error(`${path.basename(file)}: format ${header.format}, expected ${FORMAT}`);
  const lines = rest.map((line) => JSON.parse(line));
  const counted = header.counts.full + header.counts.typed + (header.counts.witnesses ?? 0);
  if (lines.length !== counted) throw new Error(`${path.basename(file)}: ${lines.length} calls, its header counts ${counted}`);
  return { header, lines, text };
}

async function main(argv) {
  const mode = argv.includes('--check') ? 'check' : argv.includes('--inputs') ? 'inputs' : 'write';
  const from = argv.find((arg) => arg.startsWith('--witnesses-from='))?.slice('--witnesses-from='.length);
  if (argv.some((arg) => !['--check', '--inputs', '--keep-artifacts'].includes(arg) && !arg.startsWith('--witnesses-from='))) { console.error('usage: client-vectors.mjs [--check | --inputs | --witnesses-from=<dir>] [--keep-artifacts]'); return 64; }
  if (from) {
    const { readdirSync } = await import('node:fs');
    const families = witnessesFrom(from, readdirSync(from));
    mkdirSync(VECTOR_DIR, { recursive: true });
    writeFileSync(WITNESS_FILE, `${JSON.stringify({ format: 'devryan-client-vector-witnesses@1', seed: SEED, families }, null, 1)}\n`);
    console.log(`witnesses: ${Object.values(families).reduce((sum, list) => sum + list.length, 0)} calls over ${Object.keys(families).length} families`);
  }
  const stale = [];
  if (mode === 'inputs') {
    for (const family of PORTED_FAMILIES) {
      const file = vectorFile(family);
      if (!existsSync(file)) { stale.push(`${family}: no vector file`); continue; }
      const { header, lines } = readVectorFile(file);
      const inputs = await vectorInputs(family);
      if (header.inputs !== inputsDigest(inputs) || inputsDigest(lines) !== header.inputs) stale.push(`${family}: the generated inputs are not the tracked ones`);
    }
    console.log(stale.length ? `client vectors: inputs stale: ${stale.join('; ')}` : `client vectors: the inputs of ${PORTED_FAMILIES.length} families are the generators' (no TypeScript run)`);
    return stale.length ? 1 : 0;
  }
  const { createScratch } = await import(pathToFileURL(path.join(HERE, 'record.mjs')).href);
  const { familyDescriptor } = await import(pathToFileURL(path.join(HERE, 'replay.mjs')).href);
  const { loadPortMap } = await import(pathToFileURL(path.join(HERE, 'port-map.mjs')).href);
  const scratch = createScratch('client-vectors', { keepArtifacts: argv.includes('--keep-artifacts') });
  let status = 'failed';
  try {
    const runtimes = await armRuntimes();
    // What answered, without the binary's place on this machine (the file is compared as bytes).
    const engine = runtimes.v8.description.replace(/,\s*\/.*$/, '').replace(/,\s*[A-Za-z]:\\.*$/, '');
    const portMap = loadPortMap(path.join(HERE, 'product', 'product-port-map.json'), { root: ROOT });
    const bundles = await bundleFamilies(PORTED_FAMILIES, scratch.dir);
    if (mode === 'write') mkdirSync(VECTOR_DIR, { recursive: true });
    for (const family of PORTED_FAMILIES) {
      const inputs = await vectorInputs(family);
      const input = path.join(scratch.dir, `${family}.input.ndjson`);
      writeFileSync(input, `${inputs.map((call) => JSON.stringify(call)).join('\n')}\n`);
      const records = await runArm('v8', runtimes.v8, { bundle: bundles[family], family, input, output: path.join(scratch.dir, `${family}.v8.ndjson`) });
      const text = await vectorText(family, inputs, records, { descriptor: familyDescriptor(portMap, family), engine });
      if (mode === 'write') { writeFileSync(vectorFile(family), text); console.log(`${family}: ${inputs.length} calls, ${text.length} bytes`); continue; }
      if (!existsSync(vectorFile(family))) { stale.push(`${family}: no vector file`); continue; }
      const tracked = readFileSync(vectorFile(family), 'utf8');
      // The engine's description is not compared: a check under another V8 (this Node) still judges the answers.
      const body = (whole) => whole.split('\n').slice(1).join('\n');
      if (body(tracked) !== body(text)) {
        const old = body(tracked).split('\n');
        const fresh = body(text).split('\n');
        const at = fresh.findIndex((line, index) => line !== old[index]);
        stale.push(`${family}: call ${at + 1} (${JSON.parse(fresh[at] || '{}').entry ?? '?'}) is answered otherwise`);
      }
    }
    if (mode === 'check') console.log(stale.length ? `client vectors stale (regenerate with node scripts/client-conformance/client-vectors.mjs, ${engine}): ${stale.join('; ')}` : `client vectors: ${PORTED_FAMILIES.length} families as tracked (${engine})`);
    status = stale.length ? 'failed' : 'passed';
    return stale.length ? 1 : 0;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
