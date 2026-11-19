// The family command of the client engine conformance harness (design file
// 29 §2, §4.4): records the families of a port map from tests and judges the
// recording. The product's recording command is this, set up with the
// product's map, census and targets; the self-test runs the same code on the
// toy map and census (it names no product file, so no product edit selects it).
//
// Without targets it records every test file under `setup.always` and every
// other test file under `setup.search` that loads a family module (found by
// one run of those files under the recorder's discover layer, which counts the
// calls test code makes, so a test that reaches a family through a re-export
// or a dynamic import is found too; one whose test code calls none is not,
// unless it reaches one through a caller that is test support code under
// another name, which makes the run inconclusive),
// less the census file's excluded files. Each run first runs the files
// plainly, then under the recorder (record.mjs recordOnce); the files are
// recorded `runs` times (at least two) and every container compared byte for
// byte. Then:
// - unrecordable cases are judged by the census file's `unrecordable`
//   waivers; an unwaived one makes the run inconclusive, a waiver that
//   matched nothing fails it;
// - every draft step's change set is checked against its drafts;
// - the census: every export of every family module, every event type the
//   configured entries handle and every listed port is exercised in a
//   recorded case, or waived with a reason;
// - every passed-through call is counted and shown (per family and export, per
//   caller file, the totals on the last line), and a caller under
//   `setup.scope` that is no test code by the naming rule and that the
//   product's entry points do not reach is test support code under another
//   name: the run is inconclusive and names it.
// With targets the census judges only what the recorded cases show (nothing
// fails for being unexercised, nothing is stale); with `--families` every
// judgement is scoped to those families. Exit codes (as every tool of the
// harness): 0 pass; 1 a failed check (census, change set, a stale waiver); 2
// unstable (two recordings differ); 3 inconclusive; 64 usage, and a port map
// or census file that cannot be read or is invalid. Precedence: inconclusive,
// then unstable, then fail. With `--out` the containers are written there with
// the recording's manifest (manifest.mjs), which every reader of the directory
// requires.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { applyExclusions, checkChangeSets, judgeUnrecordable, judgeUnstable, loadCensus, mergeExports, passedThrough, runCensus, staleNoFrame, unclassifiedCallers } from './census.mjs';
import { stringifyTree } from './codec.mjs';
import { createContainerWriter, readContainer } from './container.mjs';
import { writeManifest } from './manifest.mjs';
import { loadPortMap } from './port-map.mjs';
import { compareRecordings } from './stability.mjs';
import { createScratch, discoverLoading, discoverTestFiles, EXIT, formatDifference, formatIncomplete, parseOptions, recordOnce, REPOSITORY_ROOT } from './record.mjs';

const sizeOf = (directory) => (existsSync(directory) ? readdirSync(directory).reduce((sum, name) => sum + statSync(path.join(directory, name)).size, 0) : 0);
const familyOfCase = (id) => String(id).slice(String(id).lastIndexOf('/') + 1);
const familyOfContainer = (name) => String(name).split('.').slice(-2, -1)[0] ?? '?';

/** Unrecordable and unstable cases counted per family and reason. */
function countBy(entries, keyOf) {
  const out = {};
  for (const entry of entries) {
    const [family, reason] = keyOf(entry);
    out[family] ??= {};
    out[family][reason] = (out[family][reason] ?? 0) + 1;
  }
  return out;
}

/**
 * The containers with every unstable case marked: its outcome becomes
 * `unstable` and its reason says why (and the waiver's reason when one
 * covers it), so a reader of `--out` never takes it for a reference.
 */
export function markUnstable(containers, unstable, waivedReasons) {
  const byContainer = new Map();
  for (const entry of unstable) {
    if (!byContainer.has(entry.container)) byContainer.set(entry.container, new Set());
    byContainer.get(entry.container).add(entry.case ?? null);
  }
  return containers.map((container) => {
    const marked = byContainer.get(container.name);
    if (!marked) return container;
    const read = readContainer(container.text);
    const table = new Map([...read.values].map(([hash, tree]) => [hash, stringifyTree(tree)]));
    const writer = createContainerWriter(read.header, { table });
    for (const record of read.cases) {
      if (!marked.has(record.id) && !marked.has(null)) { writer.addCase(record); continue; }
      const waiver = waivedReasons.get(`${container.name} ${record.id}`) ?? waivedReasons.get(`${container.name} (container)`);
      writer.addCase({ ...record, outcome: 'unstable', reason: `unstable: two recordings of this case differ${waiver ? `; waived: ${waiver}` : ''}` });
    }
    return { ...container, text: writer.toText() };
  });
}

/**
 * The default targets of a setup: every test file under `setup.always`, and
 * every other test file under `setup.search` whose test code calls a family
 * module's export (the discover run), or reaches one through a caller the
 * unclassified-caller rule names. Returns `{ files, searched, loading,
 * missing, unclassified }` (repository-relative; `unclassified` holds a
 * `caller-unclassified` problem per such test file and caller).
 */
async function defaultTargets({ setup, portMap, workDir, parallel }) {
  const always = discoverTestFiles(setup.always, { cwd: setup.cwd, root: setup.root });
  const modules = new Set(portMap.families.map((family) => family.relModule));
  const others = discoverTestFiles(setup.search, { cwd: setup.cwd, root: setup.root }).filter((file) => !always.includes(file));
  if (others.length === 0) return { files: always, searched: 0, loading: 0, missing: [], unclassified: [] };
  const toCwd = (file) => path.relative(setup.cwd, path.join(setup.root, file)).split(path.sep).join('/');
  const found = await discoverLoading({ files: others.map(toCwd), cwd: setup.cwd, root: setup.root, portMap: setup.portMapFile, workDir: path.join(workDir, 'discover'), parallel, recorder: setup.recorder, timeoutMs: setup.timeoutMs });
  // A file whose test code calls no family export (and makes no call with no frame) would record no case: its
  // calls are all engine code's, passed through; it is left out (a mounted component test that renders them).
  // Unless one of those callers is test support code under another name (the unclassified-caller rule): the
  // file is kept, and the run is inconclusive and names the file and the caller.
  const unclassified = [];
  const reachable = setup.reachable();
  for (const item of found.files) {
    for (const problem of unclassifiedCallers({ callers: item.callers ?? {}, portCallers: {} }, { scope: setup.scope, reachable })) {
      unclassified.push({ ...problem, file: item.file, detail: `${item.file} reaches a family through ${problem.file}, which discovery could not count as its test code's: ${problem.detail}` });
    }
  }
  const named = new Set(unclassified.map((problem) => problem.file));
  const loading = found.files.filter((item) => item.loaded.some((file) => modules.has(file)) && (item.testCalls + item.noFrame > 0 || named.has(item.file))).map((item) => item.file);
  return { files: [...always, ...loading], searched: others.length, loading: loading.length, found: loading, missing: found.missing, unclassified };
}

/**
 * Records and judges. `setup`: `{ portMapFile, censusFile, cwd, root, always,
 * search, scope, reachable() }` (and `recorder`, a recorder copy, and
 * `timeoutMs`, the per-test time limit of every run, plain and recorded). `targets`
 * are test files or directories relative to `setup.cwd`; `families` limits
 * every judgement to those families. `recordRun({ files, workDir, run })` may
 * replace the recording (the self-test hands in fixed recordings). Returns `{
 * code, report, unstable }`; throws when the port map or the census cannot be
 * read (the command's usage error).
 */
export async function recordFamilies({ setup, targets = [], runs = 2, families = null, workDir, parallel, out, recordRun }) {
  const root = setup.root ?? REPOSITORY_ROOT;
  const portMap = loadPortMap(setup.portMapFile, { root });
  const census = loadCensus(setup.censusFile);
  const all = portMap.families.map((family) => family.name);
  for (const name of families ?? []) if (!all.includes(name)) throw new Error(`--families: ${name} is not a family of ${path.basename(setup.portMapFile)}`);
  const complete = targets.length === 0;
  const scope = families && families.length ? families : null;
  const inScope = (name) => scope === null || scope.includes(name);
  const incomplete = [];
  let discovery = null;
  let staleExclusions = [];
  let files = targets;
  const workers = (count) => parallel ?? Math.max(1, Math.min(count, Math.floor(availableParallelism() / 2)));
  if (complete) {
    const found = await defaultTargets({ setup: { ...setup, root }, portMap, workDir, parallel: workers(64) });
    discovery = { searched: found.searched, loading: found.loading, found: found.found ?? [], missing: found.missing.length };
    for (const file of found.missing) incomplete.push({ check: 'discovery-missing', file, detail: 'the discover run left no report for this test file: whether it loads a family module is unknown' });
    incomplete.push(...found.unclassified);
    const { files: kept, stale } = applyExclusions(found.files, census);
    staleExclusions = stale;
    files = kept.map((file) => path.relative(setup.cwd, path.join(root, file)).split(path.sep).join('/'));
  }
  const expected = discoverTestFiles(files, { cwd: setup.cwd, root });
  // A family the census waives as a whole (no test reaches it yet) need not record a case.
  const required = (scope ?? all).filter((name) => !census.families.some((item) => item.family === name));
  const noFrame = census.noFrame.map((item) => `${item.family}#${item.export}`);
  const recorder = recordRun ?? setup.recordRun;
  // bun test with no file would run every test under its directory: an empty target list records nothing.
  if (!recorder && expected.length === 0) throw new Error('no test file to record: the targets name none');
  const recordings = [];
  const timings = [];
  for (let run = 1; run <= runs; run += 1) {
    const dir = path.join(workDir, `recording-${run}`);
    const started = Date.now();
    const recording = recorder
      ? await recorder({ files, workDir: dir, run, required })
      : await recordOnce({ files, cwd: setup.cwd, portMap: setup.portMapFile, families: required, workDir: dir, plain: true, parallel: workers(expected.length), root, noFrame, timeoutMs: setup.timeoutMs, ...(setup.recorder ? { recorder: setup.recorder } : {}) });
    timings.push(Date.now() - started);
    recording.rawBytes ??= sizeOf(path.join(dir, 'raw'));
    recordings.push({ ...recording, containers: recording.containers.filter((container) => inScope(container.family)) });
  }
  const [first] = recordings;
  // A problem of another family than those asked for is not this run's.
  const asked = (entry) => entry.case === undefined || entry.check === 'flagged-without-line' || inScope(familyOfCase(entry.case));
  const unrecordableWaivers = scope ? { ...census, unrecordable: census.unrecordable.filter((waiver) => waiver.family && inScope(waiver.family)) } : census;
  let judged = null;
  recordings.forEach((recording, index) => {
    const verdict = judgeUnrecordable(recording.incomplete.filter(asked), unrecordableWaivers, { complete });
    if (index === 0) judged = verdict;
    for (const entry of verdict.remaining) incomplete.push({ ...entry, detail: `recording ${index + 1}: ${entry.detail}` });
  });
  const stability = compareRecordings(recordings.map((recording) => recording.containers));
  incomplete.push(...stability.incomplete);
  const unstableJudged = judgeUnstable(stability.unstable, census, { complete: complete && scope === null });
  const changeSets = checkChangeSets(first.containers, portMap);
  const merged = mergeExports(first.raws);
  const censusResult = runCensus({ portMap, census, containers: first.containers, moduleExports: merged.exports, readSource: (file) => readFileSync(file, 'utf8'), families: scope, complete });
  incomplete.push(...merged.problems, ...censusResult.problems);
  for (const item of changeSets.unverifiable) incomplete.push({ check: 'change-set-unverifiable', detail: `${item.container} ${item.case} step ${item.step}: ${item.detail}` });
  const passed = passedThrough(first.raws);
  incomplete.push(...unclassifiedCallers(passed, { scope: setup.scope, reachable: setup.reachable() }));
  const noFrameStale = staleNoFrame(passed, scope ? { ...census, noFrame: census.noFrame.filter((item) => inScope(item.family)) } : census, { complete });
  const failures = [...changeSets.failures, ...censusResult.failures, ...judged.stale, ...noFrameStale, ...(complete ? staleExclusions : []), ...unstableJudged.stale];
  const storedBytes = first.containers.reduce((sum, container) => sum + Buffer.byteLength(container.text), 0);
  const caseKey = (entry) => `${entry.container} ${entry.case ?? '(container)'}`;
  const unstableCases = [...new Map(stability.unstable.map((entry) => [caseKey(entry), entry])).values()];
  const waivedReasons = new Map(unstableJudged.waived.map((entry) => [caseKey(entry), entry.reason]));
  const report = {
    files: expected.length, complete, families: null, scope, discovery, excludedFiles: complete ? census.excludedFiles : [], runs, timingsMs: timings,
    cases: first.containers.reduce((sum, container) => sum + container.cases, 0), outcomes: { recorded: 0, unrecordable: 0, inconclusive: 0 },
    steps: Object.values(censusResult.families).reduce((sum, family) => sum + family.steps, 0),
    rawBytes: recordings.map((recording) => recording.rawBytes), storedBytes, containers: first.containers.length,
    values: first.containers.reduce((sum, container) => sum + Object.keys(JSON.parse(container.text.split('\n', 2)[1]).values).length, 0),
    unrecordable: { waived: countBy(judged.waived, (entry) => [entry.family, entry.flags.join('+')]), unwaived: countBy(judged.remaining.filter((entry) => entry.check === 'unrecordable'), (entry) => [familyOfCase(entry.case), entry.flags.join('+')]) },
    unstable: countBy(unstableCases, (entry) => [familyOfContainer(entry.container), entry.check]),
    unstableCases: unstableCases.map((entry) => ({ container: entry.container, case: entry.case ?? null, check: entry.check, path: entry.path ?? null, step: entry.step ?? null, waived: waivedReasons.has(caseKey(entry)) })),
    changeSetsChecked: changeSets.checked, passed,
    failures, incomplete,
  };
  report.families = censusResult.families;
  for (const family of Object.values(censusResult.families)) for (const [outcome, count] of Object.entries(family.outcomes)) report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + count;
  if (out) {
    mkdirSync(out, { recursive: true });
    const written = markUnstable(first.containers, stability.unstable, waivedReasons);
    for (const container of written) writeFileSync(path.join(out, container.name), container.text);
    // What the directory holds, so a reader sees a container that went missing or changed (manifest.mjs).
    writeManifest(out, written, { portMap: portMap.digest, families: scope ?? all, scope });
  }
  const code = incomplete.length ? EXIT.inconclusive : unstableJudged.remaining.length ? EXIT.unstable : failures.length ? EXIT.fail : EXIT.pass;
  return { code, report, unstable: stability.unstable };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const sumOf = (row) => Object.values(row).reduce((sum, count) => sum + count, 0);
/** The lines a report prints: problems, failures, per family, the passed-through tables, and the summary last. */
export function reportLines({ report, unstable }) {
  const errors = report.incomplete.map(formatIncomplete);
  const lines = [];
  for (const entry of unstable) lines.push(`unstable (recording ${entry.run}): ${formatDifference(entry)}`);
  for (const entry of report.failures) lines.push(`fail (${entry.check}): ${entry.container ? `${entry.container} ${entry.case} step ${entry.step}: ` : ''}${entry.detail}`);
  for (const [name, family] of Object.entries(report.families)) {
    const exports = family.exports;
    const events = family.events ? `; events ${family.events.exercised}/${family.events.total} exercised, ${family.events.waived} waived` : '';
    lines.push(`${name}: ${family.cases} cases, ${family.steps} steps (${family.outcomes.recorded} recorded, ${family.outcomes.unrecordable} unrecordable, ${family.outcomes.inconclusive} inconclusive); exports ${exports.exercised}/${exports.total} exercised, ${exports.waived} waived, ${exports.inlined} inlined, ${exports.failed} failing${exports.unjudged ? `, ${exports.unjudged} not judged (chosen test files)` : ''}; ports ${family.ports.exercised}/${family.ports.total}${events}`);
  }
  const { passed } = report;
  for (const [family, byExport] of Object.entries(passed.unmapped).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`passed through, ${family}: ${Object.entries(byExport).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => `${name} ${count}`).join(', ')}`);
  }
  const byCaller = new Map();
  for (const [file, row] of Object.entries(passed.callers)) byCaller.set(file, { calls: sumOf(row), ports: 0 });
  for (const [file, row] of Object.entries(passed.portCallers)) { const entry = byCaller.get(file) ?? { calls: 0, ports: 0 }; entry.ports = sumOf(row); byCaller.set(file, entry); }
  for (const [file, { calls, ports }] of [...byCaller].sort(([a, x], [b, y]) => (y.calls + y.ports) - (x.calls + x.ports) || (a < b ? -1 : 1))) {
    lines.push(`passed-through caller ${file}: ${calls} calls${ports ? `, ${ports} port uses` : ''}`);
  }
  const totals = passed.totals;
  const discovery = report.discovery ? `; ${report.discovery.loading} of ${report.discovery.searched} searched test files load a family` : '';
  lines.push(`${report.files} files recorded ${report.runs} times (${report.timingsMs.map(seconds).join(', ')})${discovery}${report.complete ? '' : '; census of the chosen files only'}; ${report.cases} cases, ${report.steps} steps (${report.outcomes.recorded} recorded, ${report.outcomes.unrecordable} unrecordable, ${report.outcomes.inconclusive} inconclusive); raw ${report.rawBytes.map((bytes) => `${(bytes / 1e6).toFixed(1)} MB`).join(', ')}, stored ${(report.storedBytes / 1e6).toFixed(1)} MB in ${report.containers} containers; ${report.changeSetsChecked} change sets checked; ${report.unstableCases.length} unstable cases (${report.unstableCases.filter((entry) => entry.waived).length} waived), ${report.failures.length} failed checks, ${report.incomplete.length} inconclusive problems; passed through ${totals.calls} calls (${totals.nested} inside pass-through calls, ${totals.noFrame} with no frame) and ${totals.ports} port uses (${totals.portsNested} inside pass-through calls)`);
  return { errors, lines };
}

/**
 * The command: parses `argv`, records and judges with `setup`, prints through
 * `log` and `error`, and resolves the exit code. `name` is the command's file
 * name, for its usage line.
 */
export async function familyCommand(argv, setup, { name = 'family command', log = console.log, error = console.error } = {}) {
  const usage = `usage: ${name} [--runs=N (2 or more)] [--families=a,b] [--json=<file>] [--out=<new or empty dir outside the repository>] [--keep-artifacts] [<test file or directory, relative to ${path.relative(setup.root ?? REPOSITORY_ROOT, setup.cwd) || '.'}>...]`;
  const parsed = parseOptions(argv, { flags: ['keep-artifacts'], values: ['runs', 'families', 'json', 'out'] });
  if (parsed.error) { error(`${parsed.error}\n${usage}`); return EXIT.usage; }
  const { options, positionals } = parsed;
  const runs = Number(options.runs ?? 2);
  if (!Number.isInteger(runs) || runs < 2) { error(`--runs must be 2 or more: each file is recorded at least twice\n${usage}`); return EXIT.usage; }
  const outDir = options.out && path.resolve(options.out);
  if (outDir && existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) { error(`--out=${options.out} must be a new or empty directory`); return EXIT.usage; }
  const repository = setup.root ?? REPOSITORY_ROOT;
  if (outDir && (outDir === repository || outDir.startsWith(repository + path.sep))) { error('--out must be outside the repository: recordings of the product are never tracked'); return EXIT.usage; }
  const families = options.families !== undefined ? options.families.split(',').filter(Boolean) : null;
  if (families !== null && families.length === 0) { error(`--families needs at least one family\n${usage}`); return EXIT.usage; }
  try {
    const portMap = loadPortMap(setup.portMapFile, { root: repository });
    loadCensus(setup.censusFile);
    for (const family of families ?? []) if (!portMap.families.some((item) => item.name === family)) throw new Error(`--families: ${family} is not a family of ${path.basename(setup.portMapFile)}`);
  } catch (failure) { error(failure.message); return EXIT.usage; }
  const scratch = createScratch('client-conformance-families', { keepArtifacts: options['keep-artifacts'] === true });
  let status = 'failed';
  try {
    let result;
    try { result = await recordFamilies({ setup, targets: positionals, runs, families, workDir: scratch.dir, out: outDir, parallel: setup.parallel }); } catch (failure) { error(failure.message); return EXIT.inconclusive; }
    const { errors, lines } = reportLines(result);
    for (const line of errors) error(line);
    for (const line of lines) log(line);
    if (options.json) writeFileSync(options.json, `${JSON.stringify(result.report, null, 2)}\n`);
    status = result.code === EXIT.pass ? 'passed' : 'failed';
    return result.code;
  } finally {
    scratch.finish(status);
  }
}

