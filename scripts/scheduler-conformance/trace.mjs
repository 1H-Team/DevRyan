// Trace format of the scheduler conformance harness (design file 30 §4.2) and
// the judgements every tool shares. Runtime-neutral: the recorder loads it
// under Bun, the tools and the self-test under Node.
//
// A container is one NDJSON file per recorded test file:
//   line 1  {"format":"devryan-scheduler-conformance","version":1,...provenance}
//   line 2  {"values":{"<hash>":<codec tree>,...}}   values in order of first reference
//   line 3+ {"case":{...}}                            one line per test (and per hooks block that built a scheduler), in file order
// Provenance, in every container: the recorder's digest (its own files and
// the shared codec), the digest of every product module the scheduler is
// built from (its static import closure), and the Bun version.
//
// A case holds its constructions; a construction is one call of
// `createManagedTaskScheduler`, and its `events` are one total order (`seq`,
// from 1). `at` orders the events of all constructions of one case. Every
// value is a slot `"=<16 hex>"` into the value table, encoded with the codec of
// scripts/client-conformance (one identity scope per case line, so an object
// seen twice in a case is numbered, in any construction).
//
// Events (`dir` in: what reaches the scheduler; out: what it does). Inputs
// the scheduler asked for (answer, clock, draw, env, read) and inputs that
// arrived on their own (call, control, callback, fire, abort) are told apart
// by kind:
//   in  call     {call, member, args}            a public member called (call 0: the construction, member createManagedTaskScheduler;
//                                                its args hold the options as they were at construction, its return the members as a port)
//   in  control  {call, of, method, args}        a method of the task control object the scheduler handed executor call `of`
//   in  callback {call, of, path, args}          another function the scheduler handed port call `of` (onProgress, ...)
//   in  fire     {call, timer}                   a timer the scheduler set fired
//   in  answer   {port, outcome, value?}         a port call's answer: return | throw | promise, then resolve | reject
//   in  abort    {signal, reason}                an AbortSignal that reached the scheduler aborted
//   in  read     {object, key?, op?, found?, value, supplied?}  the scheduler read a member of the options (`object: "options"`) or
//                                                of an object holding functions (a port): no op, a member read; op has, `key in`;
//                                                op keys, the list of own keys; op own, an own-member check (hasOwnProperty, a
//                                                descriptor, a spread): found, and the member's value when it is a data member.
//                                                supplied: the test left it out (undefined or null, which the scheduler's `??`
//                                                treats alike) and the recorder gave the scheduler its default (the construction's
//                                                `defaulted` lists them)
//   in  clock    {source, site?, value}          a clock read: source option (the test's `now`), nominal | real (the
//                                                recorder's default `now`), performance (a hidden read, named by site)
//   in  draw     {site, source, value}           an identifier: source option | default (the three factories) | hidden (randomUUID, named by site)
//   in  env      {site, name, value}             an environment variable the scheduler read (hidden, named by site)
//   out port     {port, name, args, ledger?}     a call to an option (executor.start, persistence.save, publishEvent, a hook,
//                                                logger.warn) or to a function the caller passed a member (submit#3.arg1.authorize);
//                                                ledger: for the target's save port, "sha256:<hex>" of the saved state's bytes as the
//                                                reference ledger encoder writes them (or {error} when it refused the state)
//   out abort    {signal, reason}                an AbortSignal the scheduler handed out (to a port or the test) aborted
// An abort through AbortController.prototype.abort is written before the
// signal dispatches, so what any listener does follows the abort that caused
// it; one without a controller (AbortSignal.timeout, any) when it dispatches.
//   out timer.set {timer, delay}, timer.clear {timer, ambiguous?}   timer ids numbered per construction; null: a handle it never set;
//                                                ambiguous: the live timers a primitive handle stood for (the clear is the last's)
//   out return   {call, value | promise: true}, throw {call, error}, settle {call, outcome, value}
// An event lists under `unwrapped` its fields whose value held a function the
// recorder did not wrap, and under `mutated` those whose objects had other
// content when the case ended (each also flags the case), except a value that
// went out (the scheduler handed it over) whose objects never crossed the
// boundary again in the case: what it recorded is what the scheduler handed
// over then, so the event lists the field under `mutatedByReceiver` and the
// case keeps its outcome with the note `mutated-by-receiver`.
// AbortSignals are numbered per construction in order of first sight; an
// event whose value holds one lists `signals: [{signal, at, in}]` (`in` the
// field, `at` the member path inside its value, null if not reachable by
// plain members). Inputs that arrive while one of the construction's port
// calls is still on the stack carry `during: <port>`; events after the owning
// test ended carry `late: true` (they stay with the case that built the
// scheduler).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hashText, stringifyTree } from '../client-conformance/codec.mjs';
import { pathStem, VALUE_REF } from '../client-conformance/container.mjs';
import { testKeys } from '../client-conformance/junit.mjs';

export const FORMAT = 'devryan-scheduler-conformance';
export const FORMAT_VERSION = 1;
export const RAW_VERSION = 1;
// What a recording says: bumped by hand whenever the events, their attribution or the flags change.
export const RECORDING_VERSION = 3;
// Date.now() returning one nominal time this many times in a row, with no event between, throws (recorder.mjs).
export const SPIN_LIMIT = 1_000_000;
export const EPOCH = 1700000000000;
export const PERFORMANCE_ORIGIN = 1000;
export const HEADER_KEYS = Object.freeze(['format', 'version', 'codec', 'recording', 'recorder', 'modules', 'target', 'clock', 'bun', 'testFile', 'testFileDigest']);
export const EXIT = Object.freeze({ pass: 0, fail: 1, inconclusive: 2, usage: 64 });
export const OUTCOMES = Object.freeze(['recorded', 'unrecordable', 'inconclusive', 'empty']);
export const FLAG_REASONS = Object.freeze({
  accessor: 'a value has an own accessor; it is never called, so its value is not recorded',
  proxy: 'a value is a Proxy the recorder did not make; its traps would run',
  unencodable: 'a value could not be encoded',
  concurrent: 'the test overlapped another test: effects cannot be told apart',
  'late-after-write': 'a scheduler this case built received or did something after the file\'s recording was written',
  'handed-code': 'a public member handed the test a function or an object holding one: the test could run scheduler code with no input recorded',
  'unwrapped-function': 'a function the recorder did not wrap crossed the boundary (in a port\'s answer, nested in an argument, in a value read): calls of it would not be recorded',
  'mutated-after-crossing': 'an object that crossed the boundary had other content when its case ended: the recorded value is not what the other side saw later',
});
export const flagReason = (flag) => `${flag}: ${FLAG_REASONS[flag] ?? 'unrecordable'}`;
// Notes on a case that keep its outcome (information for the replayer).
export const NOTE_REASONS = Object.freeze({
  'mutated-by-receiver': 'a value the scheduler handed out, never seen crossing again, had other content when its case ended: the recorded value is what the scheduler handed over then',
});

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * A served identifier: a version 4 UUID laid out from SHA-256 of `key` (the
 * case, the construction, the site and the draw's number at that site), so
 * two recordings of a test serve the same values and a reader in another
 * language can recompute them.
 */
export function servedUuid(key) {
  const hex = createHash('sha256').update(`scheduler-conformance:${key}`).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Reads a target spec: the module that exports the scheduler factory, the
 * named sites of its hidden inputs (each found by a one-line text anchor that
 * must occur exactly once), and the hidden-input reads the recorder never
 * reaches, each with its reason, and the product helpers tests may call
 * directly (`direct`: a hidden read on that line, called by code that is no
 * product module, is not a scheduler input). Paths in the spec are relative to it.
 */
export function loadTarget(file) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  const module = path.resolve(base, spec.module);
  const sources = new Map();
  const source = (relative) => {
    const absolute = realpathSync(path.resolve(path.dirname(module), relative));
    if (!sources.has(absolute)) sources.set(absolute, readFileSync(absolute, 'utf8'));
    return { absolute, text: sources.get(absolute) };
  };
  const lineOf = (entry) => {
    const { absolute, text } = source(entry.file ?? path.basename(module));
    const lines = text.split('\n');
    const hits = [];
    lines.forEach((line, index) => { if (line.includes(entry.anchor)) hits.push(index + 1); });
    if (hits.length !== 1) throw new Error(`scheduler-conformance target: anchor ${JSON.stringify(entry.anchor)} occurs ${hits.length} times in ${path.basename(absolute)}`);
    return { file: absolute, line: hits[0] };
  };
  const sites = (spec.sites ?? []).map((entry) => ({ ...entry, ...lineOf(entry) }));
  const unreached = (spec.unreached ?? []).map((entry) => ({ ...entry, ...lineOf(entry) }));
  const accepted = (spec.accepted ?? []).map((entry) => ({ ...entry, ...lineOf(entry) }));
  const direct = (spec.direct ?? []).map((entry) => ({ ...entry, ...lineOf(entry) }));
  // The scheduler's default persistence, which the recorder supplies member for member: each text (several lines
  // allowed) must occur exactly once in the module, so a change to that default fails here, loudly.
  const defaultPersistence = spec.defaultPersistence ?? null;
  for (const text of defaultPersistence ?? []) {
    const { absolute, text: body } = source(path.basename(module));
    const hits = body.split(text).length - 1;
    if (hits !== 1) throw new Error(`scheduler-conformance target: default persistence text ${JSON.stringify(text)} occurs ${hits} times in ${path.basename(absolute)}`);
  }
  const savedState = spec.savedState ? { ...spec.savedState, file: realpathSync(path.resolve(path.dirname(module), spec.savedState.file)) } : null;
  return { file, module: realpathSync(module), export: spec.export ?? 'createManagedTaskScheduler', sites, unreached, accepted, direct, defaults: spec.defaults ?? {}, env: spec.env ?? [], defaultPersistence, savedState };
}

// Static relative imports and re-exports: the product modules are plain ESM with no dynamic import.
const RELATIVE_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.\.?\/[^'"]+)['"]/g;
/** The module and its static relative import closure, as canonical paths in code-unit order: the product code a recording is of. */
export function importClosure(entry) {
  const seen = new Set();
  const visit = (file) => {
    const real = realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);
    for (const match of readFileSync(real, 'utf8').matchAll(RELATIVE_IMPORT)) visit(path.resolve(path.dirname(real), match[1]));
  };
  visit(entry);
  return [...seen].sort(compare);
}

// What a hidden input looks like in source: a clock, a random source, the environment or the locale. A text
// scan, so it over-approximates on purpose (a string that names one counts); what it cannot see is listed in
// docs/TESTING.md (a computed member such as globalThis[name], a name bound by an import it does not list).
export const HIDDEN_INPUT = new RegExp([
  'randomUUID', 'getRandomValues', 'randomBytes', 'randomInt', 'Math\\.random', 'performance\\.now', 'hrtime', 'Date\\.now', 'new Date\\(\\)', 'Date\\(\\)',
  'process\\??\\.env', 'Bun\\.env', '\\{[^}]*\\benv\\b[^}]*\\}\\s*=\\s*(?:globalThis\\??\\.)?process', "globalThis\\[", 'Intl\\b', 'toLocale[A-Za-z]*String', 'localeCompare',
  "from\\s+['\"](?:node:)?(?:crypto|os|process|perf_hooks)['\"]",
].join('|'));

/**
 * Every line of the given sources that reads a hidden input, with what names
 * it: a site, an unreached entry, or nothing (a gap). Comment lines are skipped.
 */
export function hiddenInputLines(target, files) {
  const named = new Map();
  for (const entry of [...target.sites, ...target.unreached, ...target.accepted, ...target.direct]) named.set(`${entry.file}:${entry.line}`, entry);
  const out = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (!HIDDEN_INPUT.test(line)) return;
      const entry = named.get(`${file}:${index + 1}`) ?? null;
      out.push({ file, line: index + 1, text: trimmed, site: entry?.site ?? null, reason: entry?.reason ?? null });
    });
  }
  return out;
}

/**
 * The recorder's files of one run, with each file's late-after-write record
 * merged in. A file that cannot be read, or that another raw version wrote,
 * comes back as `{ name, unreadable }` (buildContainers reports it).
 */
export function readRaws(directory) {
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).sort(compare);
  return names.filter((name) => name.endsWith('.raw.json')).map((name) => {
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
    } catch (error) {
      return { name, unreadable: `not JSON (${error.message})` };
    }
    if (raw === null || typeof raw !== 'object' || raw.version !== RAW_VERSION) return { name, unreadable: `raw version ${JSON.stringify(raw?.version)}, this reader reads ${RAW_VERSION}` };
    if (typeof raw.file !== 'string' || !Array.isArray(raw.cases) || !Array.isArray(raw.errors) || raw.values === null || typeof raw.values !== 'object') return { name, unreadable: 'not a recorder raw (file, cases, errors, values)' };
    // The recorder writes each value as the canonical JSON it is: back to its text.
    raw.values = Object.fromEntries(Object.entries(raw.values).map(([hash, tree]) => [hash, stringifyTree(tree)]));
    const late = name.replace(/\.raw\.json$/, '.unplaced.json');
    raw.lateCases = [];
    if (names.includes(late)) {
      try {
        const record = JSON.parse(readFileSync(path.join(directory, late), 'utf8'));
        raw.unplaced = record.unplaced ?? 0;
        raw.lateCases = record.cases ?? [];
        // Recorder errors noted after the recording was written (a listener that fires in the last hooks).
        if (Array.isArray(record.errors)) raw.errors = [...raw.errors, ...record.errors];
      } catch (error) {
        return { name: late, unreadable: `not JSON (${error.message})` };
      }
    }
    return raw;
  });
}

/** The digest of a recorder (its own files and the shared codec and container), computed as recorder.mjs does. */
export function recorderDigest(harnessDir) {
  return sha256([path.join(harnessDir, 'recorder.mjs'), path.join(harnessDir, 'trace.mjs'), path.join(harnessDir, '../client-conformance/codec.mjs'), path.join(harnessDir, '../client-conformance/container.mjs')]
    .map((file) => `${path.basename(path.dirname(file))}/${path.basename(file)} ${sha256(readFileSync(file))}`).join('\n'));
}

/**
 * Provenance of a recording (design §4.1): its recorder digest and the digest
 * of every product module of the target's import closure, recomputed from the
 * files on disk, must equal what the header says. `root` is the base its
 * paths are relative to, `harnessDir` the recorder's folder. Returns null
 * when it holds, or what differs.
 */
export function checkProvenance(header, { root, harnessDir }) {
  const found = [];
  try {
    const want = recorderDigest(harnessDir);
    if (header.recorder !== want) found.push(`recorder ${header.recorder} is not ${want}`);
    const closure = importClosure(path.join(root, header.target));
    const rel = (file) => path.relative(realpathSync(root), file).split(path.sep).join('/');
    const modules = Object.fromEntries(closure.map((file) => [rel(file), sha256(readFileSync(file))]));
    const keys = (object) => Object.keys(object ?? {}).sort(compare).join(',');
    if (keys(header.modules) !== keys(modules)) found.push(`modules ${keys(header.modules)} are not the closure ${keys(modules)}`);
    for (const [file, digest] of Object.entries(modules)) if (header.modules?.[file] !== undefined && header.modules[file] !== digest) found.push(`module ${file} ${header.modules[file]} is not ${digest}`);
  } catch (error) {
    found.push(`cannot recompute: ${error.message}`);
  }
  return found.length ? found.join('; ') : null;
}

const caseKey = (entry) => (entry.kind === 'test' ? `test:${entry.ordinal}` : `hooks:${entry.hooks}`);

/** Visits every value slot inside `item`. */
function forEachSlot(item, visit) {
  if (typeof item === 'string') { if (VALUE_REF.test(item)) visit(item.slice(1)); return; }
  if (item === null || typeof item !== 'object') return;
  if (Array.isArray(item)) { for (const entry of item) forEachSlot(entry, visit); return; }
  for (const key of Object.keys(item)) forEachSlot(item[key], visit);
}

/** The container text of one file: header, the value table in order of first reference, the cases. */
export function containerText(header, cases, table) {
  for (const key of Object.keys(header)) if (!HEADER_KEYS.includes(key)) throw new TypeError(`scheduler-conformance container: unknown header member ${key}`);
  const ordered = [];
  const seen = new Set();
  for (const record of cases) forEachSlot(record.constructions, (hash) => {
    if (seen.has(hash)) return;
    if (!(hash in table)) throw new Error(`scheduler-conformance container: a case refers to unknown value ${hash}`);
    seen.add(hash);
    ordered.push(hash);
  });
  const head = { format: FORMAT, version: FORMAT_VERSION };
  for (const key of HEADER_KEYS) if (key in header) head[key] = header[key];
  const lines = [JSON.stringify(head), `{"values":{${ordered.map((hash) => `${JSON.stringify(hash)}:${table[hash]}`).join(',')}}}`];
  for (const record of cases) lines.push(JSON.stringify({ case: record }));
  return `${lines.join('\n')}\n`;
}

/** Reads a container strictly (canonical lines, hashes that match, the exact table); `resolve(slot)` gives a value's tree. */
export function readContainer(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || text.includes('\r')) throw new Error('scheduler-conformance container: not LF-terminated NDJSON');
  const lines = text.slice(0, -1).split('\n');
  const parse = (line, index) => {
    const parsed = JSON.parse(line);
    if (JSON.stringify(parsed) !== line) throw new Error(`scheduler-conformance container: line ${index + 1} is not canonical JSON`);
    return parsed;
  };
  const header = parse(lines[0], 0);
  if (header.format !== FORMAT || header.version !== FORMAT_VERSION) throw new Error(`scheduler-conformance container: unsupported format ${header.format}@${header.version}`);
  if (header.recording !== RECORDING_VERSION) throw new Error(`scheduler-conformance container: recording version ${header.recording}, this reader reads ${RECORDING_VERSION}`);
  const values = new Map(Object.entries(parse(lines[1], 1).values ?? {}));
  for (const [hash, tree] of values) if (hashText(stringifyTree(tree)) !== hash) throw new Error(`scheduler-conformance container: value ${hash} does not match its content`);
  const order = [];
  const seen = new Set();
  const cases = lines.slice(2).map((line, index) => {
    const record = parse(line, index + 2).case;
    forEachSlot(record.constructions, (hash) => {
      if (!values.has(hash)) throw new Error(`scheduler-conformance container: line ${index + 3} refers to missing value ${hash}`);
      if (!seen.has(hash)) { seen.add(hash); order.push(hash); }
    });
    return record;
  });
  const tableOrder = [...values.keys()];
  if (tableOrder.length !== order.length || tableOrder.some((hash, index) => hash !== order[index])) throw new Error('scheduler-conformance container: the value table is not exactly the referenced values in order of first reference');
  return { header, values, cases, lines, resolve: (slot) => values.get(String(slot).slice(1)) };
}

const outcomeOf = (flags, status, constructions) => (flags.length ? 'unrecordable' : status === 'failed' ? 'inconclusive' : constructions === 0 ? 'empty' : 'recorded');

/**
 * Builds the containers of one recording: the recorder's raws joined with
 * the junit tests of each file (cases are paired with junit by order).
 * Returns `{ containers, incomplete, info, outcomes, cases }`; `incomplete`
 * lists `{ check, file?, case?, detail }` for everything that keeps the
 * recording from being complete, `info` the notes on cases that keep their
 * outcome (`{ note, file, case, detail }`). `expectedFiles` are the test files the run named.
 */
export function buildContainers({ raws: all, junit, root, expectedFiles = [], harnessDir = null }) {
  const incomplete = [];
  for (const raw of all) if (raw.unreadable) incomplete.push({ check: 'unreadable-raw', file: raw.name, detail: `the recording ${raw.name} cannot be read: ${raw.unreadable}` });
  const raws = all.filter((raw) => !raw.unreadable);
  const containers = [];
  const info = [];
  const outcomes = Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
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
    if (!byFile.has(file)) incomplete.push({ check: 'no-tests', file, detail: 'Bun reported no test of this file' });
  }
  for (const raw of raws) {
    for (const error of raw.errors) incomplete.push({ check: 'recorder-error', file: raw.file, detail: `recorder error: ${error}` });
    if (harnessDir) {
      const provenance = checkProvenance(raw, { root, harnessDir });
      if (provenance) incomplete.push({ check: 'provenance', file: raw.file, detail: `provenance: ${provenance}` });
    }
    const late = new Set(raw.lateCases ?? []);
    if (raw.unplaced && late.size === 0) incomplete.push({ check: 'unplaced', file: raw.file, detail: `${raw.unplaced} scheduler events arrived after the recording was written and belong to no case` });
    const ran = (byFile.get(raw.file) ?? []).filter((test) => test.status !== 'skipped');
    const tests = raw.cases.filter((entry) => entry.kind === 'test');
    if (ran.length !== tests.length) { incomplete.push({ check: 'count', file: raw.file, detail: `junit lists ${ran.length} tests that ran, the recorder saw ${tests.length}` }); continue; }
    const built = raw.cases.reduce((sum, entry) => sum + entry.constructions.length, 0);
    if (built === 0) incomplete.push({ check: 'no-construction', file: raw.file, detail: 'the file built no scheduler under the recorder (was the factory intercepted?)' });
    const cases = [];
    let index = 0;
    for (const entry of raw.cases) {
      const test = entry.kind === 'test' ? ran[index++] : null;
      const flags = [...entry.flags, ...(late.has(caseKey(entry)) ? ['late-after-write'] : [])].filter((flag, at, list) => list.indexOf(flag) === at).sort(compare);
      const status = test ? test.status : 'ran';
      const outcome = outcomeOf(flags, status, entry.constructions.length);
      outcomes[outcome] += 1;
      const id = test ? test.key : `${raw.file} #hooks:${entry.hooks}`;
      if (outcome === 'unrecordable') incomplete.push({ check: 'unrecordable', file: raw.file, case: id, flags, detail: `${id} is unrecordable: ${flags.map(flagReason).join('; ')}` });
      if (outcome === 'inconclusive') incomplete.push({ check: 'failed', file: raw.file, case: id, detail: `${id} failed: its case is no reference` });
      const notes = [...(entry.notes ?? [])].sort(compare);
      for (const note of notes) info.push({ note, file: raw.file, case: id, detail: `${id}: ${note}: ${NOTE_REASONS[note] ?? 'a note'}` });
      cases.push({
        id, kind: entry.kind, file: raw.file, line: test ? test.line : null, describe: test ? test.describe : [], name: test ? test.name : `hooks after ${entry.hooks} tests`,
        status, outcome, flags, notes, constructions: entry.constructions,
      });
    }
    const testFilePath = path.join(root, raw.file);
    const header = {
      codec: raw.codec, recording: raw.recording, recorder: raw.recorder, modules: raw.modules, target: raw.target, clock: raw.clock, bun: raw.bun,
      testFile: raw.file, testFileDigest: existsSync(testFilePath) ? sha256(readFileSync(testFilePath)) : null,
    };
    containers.push({ testFile: raw.file, name: `${pathStem(raw.file)}.ndjson`, cases: cases.length, text: containerText(header, cases, raw.values) });
  }
  if (raws.length === 0) incomplete.push({ check: 'empty', detail: 'no recording at all: did the preload run?' });
  else if (outcomes.recorded === 0) incomplete.push({ check: 'empty', detail: 'no case recorded a scheduler' });
  return { containers, incomplete, info, outcomes, cases: containers.reduce((sum, container) => sum + container.cases, 0) };
}

/**
 * Compares two recordings of the same files case by case, byte for byte:
 * a case whose line differs, or that only one recording has, is unstable.
 * The case line holds content hashes, so equal lines mean equal values.
 */
export function compareRecordings(first, second) {
  const unstable = [];
  const lines = (containers) => {
    const out = new Map();
    for (const container of containers) {
      const { lines: all, cases } = readContainer(container.text);
      cases.forEach((record, index) => out.set(record.id, { line: all[index + 2], record }));
    }
    return out;
  };
  const a = lines(first);
  const b = lines(second);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(id);
    const right = b.get(id);
    if (!left || !right) { unstable.push({ case: id, detail: `recorded ${left ? 'only the first' : 'only the second'} time` }); continue; }
    if (left.line !== right.line) unstable.push({ case: id, detail: firstDifference(left.record, right.record) });
  }
  const order = (containers) => containers.map((container) => readContainer(container.text).cases.map((record) => record.id).join('\n')).join('\n');
  if (unstable.length === 0 && order(first) !== order(second)) unstable.push({ case: '(order)', detail: 'the cases were recorded in a different order' });
  return unstable;
}

function firstDifference(left, right) {
  const walk = (a, b, where) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const found = walk(a[key], b[key], `${where}.${key}`);
        if (found) return found;
      }
    }
    return `${where}: ${JSON.stringify(a)?.slice(0, 120)} then ${JSON.stringify(b)?.slice(0, 120)}`;
  };
  return walk(left, right, 'case') ?? 'the bytes differ';
}

/** Every case of a set of containers, with its container's resolver. */
export function allCases(containers) {
  const out = [];
  for (const container of containers) {
    const read = readContainer(container.text);
    for (const record of read.cases) out.push({ ...record, resolve: read.resolve, header: read.header });
  }
  return out;
}

/**
 * Identifier order (design §8.2 Q7): every task, lease and wave identifier a
 * recording drew, and the pairs whose order by code unit differs from their
 * order by `localeCompare` with the `en` locale (the scheduler sorts task IDs
 * with `localeCompare` at the default locale).
 */
export function identifierOrder(containers) {
  const bySite = new Map();
  for (const record of allCases(containers)) for (const construction of record.constructions) for (const event of construction.events) {
    if (event.kind !== 'draw' || !['createTaskId', 'createLeaseToken', 'createWaveId'].includes(event.site)) continue;
    const value = record.resolve(event.value);
    if (typeof value !== 'string') continue;
    if (!bySite.has(event.site)) bySite.set(event.site, new Set());
    bySite.get(event.site).add(value);
  }
  const result = {};
  for (const [site, set] of [...bySite].sort(([a], [b]) => compare(a, b))) {
    const ids = [...set];
    let pairs = 0;
    const differing = [];
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      pairs += 1;
      const byUnit = Math.sign(compare(ids[i], ids[j]));
      const byLocale = Math.sign(ids[i].localeCompare(ids[j], 'en'));
      if (byUnit !== byLocale) differing.push([ids[i], ids[j]]);
    }
    result[site] = { identifiers: ids.length, pairs, differing: differing.length, examples: differing.slice(0, 3) };
  }
  return result;
}

/** One line per outcome count, in a fixed order. */
export const outcomeLine = (outcomes) => OUTCOMES.map((name) => `${outcomes[name] ?? 0} ${name}`).join(', ');
export const formatIncomplete = (entry) => `inconclusive (${entry.check})${entry.file ? ` ${entry.file}` : ''}: ${entry.detail}`;
