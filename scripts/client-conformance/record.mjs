#!/usr/bin/env node
// Records test files under the recorder and writes one container per test
// file and family (container.mjs), named from Bun's junit report.
//
//   node scripts/client-conformance/record.mjs --toys --check     record the toy corpus and compare it with toy/expected byte for byte
//   node scripts/client-conformance/record.mjs --toys --update    record it twice and, when both agree, rewrite toy/expected
//   node scripts/client-conformance/record.mjs --port-map=<file> [--families=a,b] [--cwd=<dir>] --out=<new or empty dir> <test file or directory>...
//
// Exit codes (every tool of the harness): 0 a complete run with no
// difference; 1 differences; 2 unstable cases; 3 inconclusive: the run is
// incomplete (nothing recorded, a family of the port map without a case, a
// test file without a recording or without tests, a naming mismatch, a
// recorder error, a test that failed, an unrecordable case, an effect that
// arrived after its file's recording was written, a test whose outcome
// without the recorder differs (product recordings run the files plainly
// first), bun crashing part-way), and the message names what is missing; 64 a
// usage error (an unknown option included), and then nothing is written.
// Scratch lives in <os tmpdir>/devryan-client-conformance and is removed on
// pass, failure and interruption (--keep-artifacts keeps it).
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEC_VERSION } from './codec.mjs';
import { compareContainers } from './compare.mjs';
import { createContainerWriter, pathStem } from './container.mjs';
import { parseJunit, testKeys } from './junit.mjs';
import { loadPortMap } from './port-map.mjs';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(HARNESS_DIR, '../..');
export const TOY_DIR = path.join(HARNESS_DIR, 'toy');
export const TOY_PORT_MAP = path.join(TOY_DIR, 'port-map.json');
export const TOY_EXPECTED = path.join(TOY_DIR, 'expected');
/** The toy corpus: every case of it must be recorded (none unrecordable). */
export const TOY_TESTS = Object.freeze(['toy-reducer.toy.mjs', 'toy-timers.toy.mjs', 'toy-transport.toy.mjs', 'toy-flow.toy.mjs', 'toy-gate.toy.mjs', 'toy-clock.toy.mjs', 'toy-hooks.toy.mjs']);
/**
 * Toy fixtures that prove the recorder refuses what it cannot record: each
 * listed case must come out unrecordable with exactly these flags (and no
 * other case of these files may), else the toy recording is inconclusive.
 * They are fixtures of the harness, not a waiver: a product recording has no
 * such list, and every unrecordable case in it makes it inconclusive.
 */
export const TOY_UNRECORDABLE = Object.freeze({
  'toy-unrecordable.toy.mjs': Object.freeze([
    ['reads an accessor exactly once', 'accessor'],
    ['a fetch the test defines as a data property is flagged', 'global-defined:fetch'],
    ['a fetch defined and restored inside one test is flagged', 'global-defined:fetch'],
    ['a navigator the test defines as an accessor is flagged', 'global-defined:navigator'],
    ['the accessor stands in the next test, which is flagged too', 'global-defined:navigator'],
    ['a promise the test resolves releases no input of the engine', 'released'],
    ['a waiter another family releases was released by no input of its own', 'released'],
    ['a promise a port resolves on its own releases no input of the engine', 'released'],
    ['a waiter that acts more than 64 silent generations after its release is flagged', 'release-expired'],
    ['a waiter the next test releases stays in its own case, marked late', 'released'],
    ['engine code deep inside returned data runs outside any chain', 'outside-chain'],
    ['a member of a frozen object cannot be wrapped', 'unwrappable'],
    ['a family\'s port that the test calls itself is flagged, since the stack cannot tell it from engine code', 'outside-chain'],
  ]),
  'toy-concurrent.toy.mjs': Object.freeze([
    ['concurrent test 1 of the file (cannot be named)', 'concurrent'],
    ['concurrent test 2 of the file (cannot be named)', 'concurrent'],
  ]),
});
/** Toy fixtures whose recording must count exactly this many engine effects or inputs as unplaced (and no other file any). */
export const TOY_UNPLACED = Object.freeze({ 'toy-unplaced.toy.mjs': 1 });
export const TOY_FILES = Object.freeze([...TOY_TESTS, ...Object.keys(TOY_UNRECORDABLE), ...Object.keys(TOY_UNPLACED)]);
export const EXIT = Object.freeze({ pass: 0, fail: 1, unstable: 2, inconclusive: 3, usage: 64 });
const ISOLATION_GUARD = path.join(REPOSITORY_ROOT, 'scripts/test-isolation-guard.mjs');
const ISOLATION_PRELOAD = path.join(REPOSITORY_ROOT, 'scripts/test-isolation-preload.mjs');
/** Why a flag makes a case unrecordable. */
export const FLAG_REASONS = Object.freeze({
  accessor: 'a value has an own accessor; it is never called, so its value is not recorded',
  proxy: 'a value is a Proxy the recorder did not make; its traps would run',
  unencodable: 'a value could not be encoded',
  concurrent: 'the test overlapped another test (test.concurrent): effects cannot be told apart',
  released: 'an engine continuation was made runnable by test code, by port code (a stub), or by an input of another family or case, which is no input of this family: no step caused it',
  'release-expired': 'an engine chain woke, still in an older step, after a release window of its family had expired: it may be a continuation more than 64 silent promise generations from its release, which would be misplaced',
  'outside-chain': 'engine code ran with no engine chain: the test reached it through a value the recorder did not wrap (a function inside returned data, one the engine passed to a test callback), it ran at module load, or engine code called a family\'s port outside a chain; what it did is no step of any input',
  unwrappable: 'the test read engine code the recorder cannot wrap (a non-configurable, non-writable member, as on a frozen object): running it would not be recorded as an input',
  'global-defined': 'the test defined this global itself (a data property the recorder did not wrap, or an accessor), so what the engine did through it is not recorded',
});
/** The reason of one flag; a flag may carry a detail after a colon (`global-defined:fetch`). */
export const flagReason = (flag) => {
  const at = flag.indexOf(':');
  const name = at < 0 ? flag : flag.slice(0, at);
  return `${flag}: ${FLAG_REASONS[name] ?? 'unrecordable'}`;
};

/**
 * Strict options: `--name` flags and `--name=value` options must be known,
 * else a usage error (`error`), and the tool writes nothing.
 */
export function parseOptions(argv, { flags = [], values = [] } = {}) {
  const options = {};
  const positionals = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const at = arg.indexOf('=');
    const name = at < 0 ? arg.slice(2) : arg.slice(2, at);
    if (at < 0 && flags.includes(name)) { options[name] = true; continue; }
    if (at >= 0 && values.includes(name)) { options[name] = arg.slice(at + 1); continue; }
    return { options, positionals, error: `unknown option ${arg}` };
  }
  return { options, positionals, error: null };
}

export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A scratch run root for one tool run (scripts/qa/run-root.mjs lifecycle). */
export function createScratch(owner, options = {}) {
  return createRunRoot({ parent: scratchParent('client-conformance'), prefix: 'run-', owner, ...options });
}

// Bun's default test-file pattern: name.test.ext, name_test.ext, name.spec.ext, name_spec.ext.
const TEST_FILE_PATTERN = /[._](?:test|spec)\.(?:[cm]?[jt]sx?)$/;
/** The test files `bun test` runs for `targets` (files or directories, relative to `cwd`), relative to `root`. */
export function discoverTestFiles(targets, { cwd, root = REPOSITORY_ROOT }) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) found.push(file);
    }
  };
  for (const target of targets) {
    const absolute = path.resolve(cwd, target);
    if (!existsSync(absolute)) { found.push(absolute); continue; }
    if (statSync(absolute).isDirectory()) walk(absolute); else found.push(absolute);
  }
  return [...new Set(found.map((file) => path.relative(root, file).split(path.sep).join('/')))];
}

/** Runs `bun test` inside the test isolation guard; resolves with { status, output, junit }. */
export function runBunTests({ files, cwd, preload = [], env = {}, junitFile, parallel, root = REPOSITORY_ROOT }) {
  mkdirSync(path.dirname(junitFile), { recursive: true });
  const args = [ISOLATION_GUARD, 'bun', 'test', `--parallel=${parallel ?? Math.max(1, Math.min(files.length, 4))}`, '--preload', ISOLATION_PRELOAD];
  for (const file of preload) args.push('--preload', file);
  args.push('--reporter=junit', `--reporter-outfile=${junitFile}`, ...files.map((file) => (file.startsWith('/') || file.startsWith('.') ? file : `./${file}`)));
  return new Promise((resolve, reject) => {
    // A hosted runner's variable makes the test runner print group markers and annotations: not part of what a test prints.
    const { GITHUB_ACTIONS: _hosted, ...inherited } = process.env;
    const child = spawn(process.execPath, args, { cwd, env: { ...inherited, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', DEVRYAN_CONFORMANCE_BASE: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      let junit = [];
      let junitError = null;
      try { junit = parseJunit(readFileSync(junitFile, 'utf8'), { cwd, root }); } catch (error) { junitError = error.message; output += `\n[client-conformance] no junit report: ${error.message}`; }
      // A bun killed by a signal exits 128 + the signal's number, as a shell reports it.
      resolve({ status: status ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1), output, junit, junitError });
    });
  });
}

export const containerName = (testFile, family) => `${pathStem(testFile)}.${family}.ndjson`;

const caseOutcome = (flags, status) => (flags.length ? 'unrecordable' : status === 'failed' ? 'inconclusive' : 'recorded');
const reasonOf = (flags, status) => (flags.length ? flags.map(flagReason).join('; ') : status === 'failed' ? 'the test failed: not a reference' : null);

/**
 * Builds the containers of one recording: `raws` (the recorder's files) joined
 * with the junit tests of each file. Returns `{ containers, incomplete }`;
 * `incomplete` lists `{ check, file?, detail }` for everything that makes the
 * recording inconclusive. `expectedFiles` (repository-relative) are the test
 * files the run had to record; `families` the families that need a case.
 */
export function buildContainers({ raws, junit, root = REPOSITORY_ROOT, expectedFiles = [], families = [] }) {
  const incomplete = [];
  const containers = [];
  const byFile = new Map();
  for (const test of testKeys(junit)) {
    if (!byFile.has(test.file)) byFile.set(test.file, []);
    byFile.get(test.file).push(test);
  }
  const rawFiles = new Map();
  for (const raw of raws) {
    if (rawFiles.has(raw.file)) incomplete.push({ check: 'duplicate', file: raw.file, detail: 'two recordings name the same test file' });
    rawFiles.set(raw.file, raw);
  }
  for (const file of new Set([...expectedFiles, ...byFile.keys()])) {
    if (!rawFiles.has(file)) incomplete.push({ check: 'no-recording', file, detail: 'no recording: the recorder never finished this file (it crashed, timed out or did not load)' });
    if (!byFile.has(file)) incomplete.push({ check: 'no-tests', file, detail: 'Bun reported no test of this file (lost or failed to load)' });
  }
  const names = new Map(); // lower-cased container name -> name
  const outcomes = { recorded: 0, unrecordable: 0, inconclusive: 0 };
  for (const raw of raws) {
    for (const error of raw.errors) incomplete.push({ check: 'recorder-error', file: raw.file, detail: `recorder error: ${error}` });
    if (raw.unplaced) incomplete.push({ check: 'unplaced', file: raw.file, count: raw.unplaced, detail: `${raw.unplaced} engine effects or inputs arrived after the file's recording was written: they could not be placed` });
    const ran = (byFile.get(raw.file) ?? []).filter((test) => test.status !== 'skipped');
    const tests = raw.cases.filter((recorded) => recorded.kind === 'test');
    if (ran.length !== tests.length) {
      incomplete.push({ check: 'count', file: raw.file, detail: `junit lists ${ran.length} tests that ran, the recorder saw ${tests.length}` });
      continue;
    }
    for (const test of ran) if (test.status === 'failed') incomplete.push({ check: 'failed', file: raw.file, detail: `${test.key} failed: its cases are inconclusive` });
    const testFilePath = path.join(root, raw.file);
    const testFileDigest = existsSync(testFilePath) ? sha256(readFileSync(testFilePath)) : null;
    const table = new Map(Object.entries(raw.values));
    const writers = new Map();
    let index = 0;
    for (const recorded of raw.cases) {
      let test = recorded.kind === 'test' ? ran[index++] : null;
      // Overlapping tests cannot be paired with junit by order: they are never named.
      if (test && recorded.flags.includes('concurrent')) {
        test = { key: `${raw.file} #concurrent:${index}`, line: null, describe: [], name: `concurrent test ${index} of the file (cannot be named)`, occurrence: 1, status: test.status };
      }
      for (const [family, data] of Object.entries(recorded.families)) {
        if (!data) { incomplete.push({ check: 'recorder-error', file: raw.file, detail: `a case of ${family} could not be written` }); continue; }
        if (!writers.has(family)) writers.set(family, createContainerWriter({ codec: CODEC_VERSION, recording: raw.recording ?? null, portMap: raw.portMap, modulesDigest: raw.modules?.[family] ?? null, testFile: raw.file, testFileDigest, family }, { table }));
        const base = test ? `${test.key}` : `${raw.file} #hooks:${recorded.hooks}`;
        const id = `${base}/${family}`;
        const status = test ? test.status : 'ran';
        const outcome = caseOutcome(recorded.flags, status);
        outcomes[outcome] += 1;
        const name = test ? test.name : `hooks after ${recorded.hooks} tests`;
        // No waiver exists yet: every unrecordable case makes the recording inconclusive.
        if (outcome === 'unrecordable') incomplete.push({ check: 'unrecordable', file: raw.file, case: id, name, flags: recorded.flags, detail: `${id} is unrecordable: ${reasonOf(recorded.flags, status)}` });
        writers.get(family).addCase({
          id, digest: createHash('sha256').update(id).digest('hex').slice(0, 8), kind: recorded.kind, file: raw.file,
          line: test ? test.line : null, describe: test ? test.describe : [], name,
          ordinal: test ? test.occurrence : 1, family, status, outcome, flags: recorded.flags, reason: reasonOf(recorded.flags, status),
          seed: recorded.seed, entry: { now: recorded.entryNow, state: data.entryState }, steps: data.steps, end: { now: recorded.endNow, state: data.endState }, context: data.context,
        });
      }
    }
    for (const [family, writer] of [...writers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const name = containerName(raw.file, family);
      const folded = name.toLowerCase();
      if (names.has(folded)) { incomplete.push({ check: 'duplicate', file: raw.file, detail: `container ${name} collides with ${names.get(folded)}` }); continue; }
      names.set(folded, name);
      containers.push({ testFile: raw.file, family, name, cases: writer.cases.length, text: writer.toText() });
    }
  }
  const cases = containers.reduce((sum, container) => sum + container.cases, 0);
  if (raws.length > 0 && cases === 0) incomplete.push({ check: 'empty', detail: families.length ? 'nothing was recorded for any family of the port map' : 'nothing was recorded: no port map, or no test reached a family' });
  if (raws.length === 0) incomplete.push({ check: 'empty', detail: 'no recording at all: did the preload run?' });
  for (const family of families) {
    if (!containers.some((container) => container.family === family)) incomplete.push({ check: 'family', detail: `family ${family} of the port map recorded no case` });
  }
  return { containers, incomplete, cases, outcomes };
}

/** The recorder's files of one run; an `.unplaced.json` beside a raw adds its count of effects that came too late to place. */
export function readRaws(directory) {
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory);
  return names.filter((name) => name.endsWith('.raw.json')).sort().map((name) => {
    const raw = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
    const late = name.replace(/\.raw\.json$/, '.unplaced.json');
    if (names.includes(late)) raw.unplaced = Math.max(raw.unplaced ?? 0, JSON.parse(readFileSync(path.join(directory, late), 'utf8')).unplaced ?? 1);
    return raw;
  });
}

/** The families a recording must reach: those named, or every family of the map. */
export function requiredFamilies(portMap, named, root = REPOSITORY_ROOT) {
  if (!portMap) return [];
  const all = loadPortMap(portMap, { root }).families.map((family) => family.name);
  if (!named) return all;
  for (const name of named) if (!all.includes(name)) throw new Error(`--families: ${name} is not a family of ${path.basename(portMap)}`);
  return named;
}

/**
 * The pass-set gate of a recording (design §2.7): each test must have the
 * same outcome without the recorder as with it, or the recording is no
 * reference (the recorder marks the promises it observes as handled, so a
 * test that fails plain on an unhandled rejection can pass recorded). Returns
 * `{ check: 'plain-differs', file, detail }` for each test that differs.
 */
export function plainDifferences(plain, recorded) {
  const plainStatus = new Map(testKeys(plain).map((test) => [test.key, test]));
  const differences = [];
  const seen = new Set();
  for (const test of testKeys(recorded)) {
    seen.add(test.key);
    const before = plainStatus.get(test.key);
    if (!before || before.status !== test.status) differences.push({ check: 'plain-differs', file: test.file, detail: `${test.key}: ${before ? before.status : 'not run'} without the recorder, ${test.status} with it; the recording is no reference` });
  }
  for (const [key, test] of plainStatus) if (!seen.has(key)) differences.push({ check: 'plain-differs', file: test.file, detail: `${key}: ${test.status} without the recorder, not run with it` });
  return differences;
}

/**
 * Records `files` (relative to `cwd`) once into `workDir`; returns
 * `{ status, output, junit, raws, containers, incomplete }`. A bun exit other
 * than 0 makes the recording incomplete (a test failed or bun stopped).
 * `plain` first runs the files without the recorder and makes every test whose
 * outcome differs a problem (plainDifferences); product recordings use it.
 */
export async function recordOnce({ files, cwd = REPOSITORY_ROOT, portMap, families, workDir, recorder = path.join(HARNESS_DIR, 'recorder.mjs'), root = REPOSITORY_ROOT, layers, parallel, env = {}, plain = false }) {
  const out = path.join(workDir, 'raw');
  mkdirSync(out, { recursive: true });
  const junitFile = path.join(workDir, 'junit.xml');
  const recorderEnv = { DEVRYAN_CONFORMANCE_OUT: out, ...(portMap ? { DEVRYAN_CONFORMANCE_PORT_MAP: portMap } : {}), ...(layers ? { DEVRYAN_CONFORMANCE_LAYERS: layers } : {}), ...env };
  const expectedFiles = discoverTestFiles(files, { cwd, root });
  const baseline = plain ? await runBunTests({ files, cwd, junitFile: path.join(workDir, 'plain-junit.xml'), parallel, root }) : null;
  const run = await runBunTests({ files, cwd, preload: [recorder], env: recorderEnv, junitFile, parallel, root });
  const raws = readRaws(out);
  const built = buildContainers({ raws, junit: run.junit, root, expectedFiles, families: families ?? requiredFamilies(portMap, null, root) });
  if (baseline) {
    built.incomplete.push(...plainDifferences(baseline.junit, run.junit));
    if (baseline.junitError) built.incomplete.push({ check: 'no-junit', detail: `the plain run: ${baseline.junitError}` });
  }
  if (run.status !== 0) built.incomplete.push({ check: 'bun-exit', detail: `bun exited ${run.status}: ${run.output.slice(-600)}` });
  if (run.junitError) built.incomplete.push({ check: 'no-junit', detail: run.junitError });
  return { ...run, raws, expectedFiles, ...built };
}

/**
 * Splits a toy recording's problems: an unrecordable case of a fixture file
 * that TOY_UNRECORDABLE lists, with exactly its flags, is expected, and so is
 * the unplaced count TOY_UNPLACED names; any other problem stays, and a listed
 * case that is not unrecordable so (`unrecordable-expected`) or a listed count
 * that is not met (`unplaced-expected`) is a problem. Returns `{ incomplete, expected }`.
 */
export function judgeToyProblems(incomplete, toys) {
  const remaining = [];
  const expected = [];
  const wanted = [];
  for (const toy of toys) for (const [name, flag] of TOY_UNRECORDABLE[toy] ?? []) wanted.push({ toy, name, flag, seen: false });
  const unplaced = toys.filter((toy) => TOY_UNPLACED[toy] !== undefined).map((toy) => ({ toy, count: TOY_UNPLACED[toy], seen: false }));
  for (const entry of incomplete) {
    const match = entry.check === 'unrecordable' && wanted.find((item) => entry.file.endsWith(`/${item.toy}`) && item.name === entry.name && entry.flags.length === 1 && entry.flags[0] === item.flag);
    const late = entry.check === 'unplaced' && unplaced.find((item) => entry.file.endsWith(`/${item.toy}`) && entry.count === item.count);
    if (match) { match.seen = true; expected.push(entry); } else if (late) { late.seen = true; expected.push(entry); } else remaining.push(entry);
  }
  for (const item of wanted) if (!item.seen) remaining.push({ check: 'unrecordable-expected', file: item.toy, detail: `${item.name} must be unrecordable, flagged ${item.flag} alone` });
  for (const item of unplaced) if (!item.seen) remaining.push({ check: 'unplaced-expected', file: item.toy, detail: `the recording of ${item.toy} must count exactly ${item.count} unplaced engine effects or inputs` });
  return { incomplete: remaining, expected };
}

/**
 * Records the toy corpus and the unrecordable fixtures (or the `toys` named).
 * `harnessDir` and `root` point at a copy for planted differences. Only the
 * full set must reach every family of the toy port map. The fixtures'
 * expected unrecordable cases are moved to `expectedUnrecordable`.
 */
export async function recordToys({ workDir, harnessDir = HARNESS_DIR, root = REPOSITORY_ROOT, toys = TOY_FILES }) {
  const toyDir = path.join(harnessDir, 'toy');
  const portMap = path.join(toyDir, 'port-map.json');
  const recording = await recordOnce({
    files: toys.map((name) => path.relative(root, path.join(toyDir, name))), cwd: root, portMap, workDir,
    families: toys.length === TOY_FILES.length ? undefined : [], recorder: path.join(harnessDir, 'recorder.mjs'), root, parallel: toys.length,
  });
  const judged = judgeToyProblems(recording.incomplete, toys);
  return { ...recording, incomplete: judged.incomplete, expectedUnrecordable: judged.expected };
}

/**
 * Compares recorded containers with an expected directory, byte for byte;
 * returns differences. `testFiles` limits the expected containers to those
 * test files (a partial recording).
 */
export function compareWithExpected(containers, expectedDir = TOY_EXPECTED, { testFiles } = {}) {
  const differences = [];
  const stems = testFiles ? testFiles.map((file) => `${pathStem(file)}.`) : null;
  const expectedNames = (existsSync(expectedDir) ? readdirSync(expectedDir).filter((name) => name.endsWith('.ndjson')).sort() : [])
    .filter((name) => !stems || stems.some((stem) => name.startsWith(stem)));
  const actualNames = new Set(containers.map((container) => container.name));
  for (const name of expectedNames) if (!actualNames.has(name)) differences.push({ check: 'container-set', container: name, detail: 'expected but not recorded' });
  for (const container of containers) {
    const file = path.join(expectedDir, container.name);
    if (!existsSync(file)) { differences.push({ check: 'container-set', container: container.name, detail: 'recorded but not expected' }); continue; }
    const expected = readFileSync(file, 'utf8');
    if (expected === container.text) continue;
    const found = compareContainers(expected, container.text);
    for (const difference of found) differences.push({ container: container.name, ...difference });
    if (found.length === 0) differences.push({ check: 'bytes', container: container.name, detail: 'the bytes differ and no check names why' });
  }
  return differences;
}

const formatDifference = (difference) => `${difference.check}: ${difference.container ?? difference.file ?? ''} ${difference.case ?? ''}${difference.step ? ` step ${difference.step}` : ''}${difference.path ? ` at ${difference.path}` : ''}: ${difference.detail ?? `expected ${difference.expected}, got ${difference.actual}`}`;
export { formatDifference };
export const formatIncomplete = (entry) => `inconclusive (${entry.check})${entry.file ? ` ${entry.file}` : ''}: ${entry.detail}`;

const USAGE = 'usage: record.mjs --toys --check|--update, or --out=<new or empty dir> [--port-map=<file>] [--families=a,b] [--cwd=<dir>] <test file>...';
const outcomeLine = (outcomes) => `${outcomes.recorded} recorded, ${outcomes.unrecordable} unrecordable, ${outcomes.inconclusive} inconclusive`;

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['toys', 'check', 'update', 'keep-artifacts'], values: ['port-map', 'families', 'cwd', 'out'] });
  if (parsed.error) { console.error(`${parsed.error}\n${USAGE}`); return EXIT.usage; }
  const { options, positionals: files } = parsed;
  if (options.toys && (options.check === options.update || files.length || options.out || options['port-map'] || options.families || options.cwd)) { console.error(USAGE); return EXIT.usage; }
  if (!options.toys && (!options.out || files.length === 0 || options.check || options.update)) { console.error(USAGE); return EXIT.usage; }
  const outDir = options.out && path.resolve(options.out);
  // A stale container must never sit beside fresh ones: the output directory is new or empty.
  if (outDir && existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) { console.error(`--out=${options.out} must be a new or empty directory`); return EXIT.usage; }
  const portMap = options['port-map'] && path.resolve(options['port-map']);
  let families;
  try { families = requiredFamilies(portMap, options.families?.split(',').filter(Boolean)); } catch (error) { console.error(error.message); return EXIT.usage; }
  const scratch = createScratch('client-conformance-record');
  let status = 'failed';
  try {
    if (options.toys) {
      const first = await recordToys({ workDir: path.join(scratch.dir, 'toys-1') });
      for (const entry of first.incomplete) console.error(formatIncomplete(entry));
      if (first.incomplete.length) { console.error(`inconclusive: the toy recording is incomplete (${first.incomplete.length})`); return EXIT.inconclusive; }
      if (options.update) {
        // A tracked recording must be reproducible: record again and require the same bytes.
        const second = await recordToys({ workDir: path.join(scratch.dir, 'toys-2') });
        for (const entry of second.incomplete) console.error(formatIncomplete(entry));
        if (second.incomplete.length) return EXIT.inconclusive;
        const unequal = first.containers.filter((container, index) => second.containers[index]?.name !== container.name || second.containers[index].text !== container.text);
        if (unequal.length || first.containers.length !== second.containers.length) { console.error(`unstable: two recordings differ in ${unequal.map((container) => container.name).join(', ') || 'their container set'}; nothing written`); return EXIT.unstable; }
        rmSync(TOY_EXPECTED, { recursive: true, force: true });
        mkdirSync(TOY_EXPECTED, { recursive: true });
        for (const container of first.containers) writeFileSync(path.join(TOY_EXPECTED, container.name), container.text);
        console.log(`wrote ${first.containers.length} toy containers (${first.cases} cases: ${outcomeLine(first.outcomes)}, ${first.expectedUnrecordable.length} of them the fixtures' expected), recorded twice byte-equal`);
        status = 'passed';
        return EXIT.pass;
      }
      const differences = compareWithExpected(first.containers);
      for (const difference of differences) console.error(formatDifference(difference));
      console.log(differences.length ? `${differences.length} differences from toy/expected` : `${first.containers.length} toy containers, ${first.cases} cases (${outcomeLine(first.outcomes)}; the unrecordable ones are the fixtures' expected), byte-equal to toy/expected`);
      status = differences.length ? 'failed' : 'passed';
      return differences.length ? EXIT.fail : EXIT.pass;
    }
    const cwd = path.resolve(options.cwd ?? REPOSITORY_ROOT);
    const recording = await recordOnce({ files, cwd, portMap, families, workDir: scratch.dir, plain: true });
    for (const entry of recording.incomplete) console.error(formatIncomplete(entry));
    mkdirSync(outDir, { recursive: true });
    for (const container of recording.containers) writeFileSync(path.join(outDir, container.name), container.text);
    console.log(`bun exited ${recording.status}; ${recording.containers.length} containers (${recording.cases} cases: ${outcomeLine(recording.outcomes)}) written to ${outDir}${recording.incomplete.length ? `; INCONCLUSIVE: ${recording.incomplete.length} problems` : ''}`);
    status = recording.incomplete.length === 0 ? 'passed' : 'failed';
    return recording.incomplete.length === 0 ? EXIT.pass : EXIT.inconclusive;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
