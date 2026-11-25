#!/usr/bin/env node
// The closure check of the scheduler conformance harness (design file 30
// §4.3, §4.8, package O0c): every recording of the three sources is replayed
// (replay.mjs) against a second copy of the scheduler package made in the
// run root, JavaScript against JavaScript, and must be reproduced exactly or
// classified.
//
//   node scripts/scheduler-conformance/closure.mjs [--sources=tests,package,scenarios]
//     [--containers=<source>=<dir>,...] [--workers=N] [--json=<file>] [--keep-artifacts]
//
// Sources: `tests` (the 21 scheduler.*.test.js files), `package` (the other
// package test files that build a scheduler), `scenarios` (the driver's
// scenario corpus, crash points included). Each is recorded twice (stability)
// unless `--containers` names a directory of containers for it.
//
// Outcomes per case: reproduced (every event); partial (every event before the
// case's first input the recorder marked busy: compared, but never counted as
// a reproduction of the case); crossed (its first input is busy: nothing
// compared); unrecordable (only a case the recording itself flags, with its
// reason); empty (the test built no scheduler); different (a named check, with
// the first differing event). Partial, crossed and unrecordable are
// properties of the recording, decided before any
// replay (trace.mjs `casePlacement`): the judgement reads every container
// itself and requires each case's outcome to agree with its marks. A scenario
// must be reproduced whole: a scenario that is partial, crossed, unrecordable
// or differs is a failure of the driver or of the replayer.
//
// Exit codes (design §4.8 as the brief of O0c sets them): 0 only when every
// case is reproduced or explicitly classified (partial or crossed in a test
// recording, unrecordable where the recording says so, with its reason;
// empty) and nothing is
// unexplained; 1 on any difference, any scenario that is not reproduced
// whole, a replay process that failed or a container it could not read, a
// container whose counts or end line do not hold, a case missing from a
// replay, an outcome that does not agree with the recording's marks (a
// recorded case a replay calls unrecordable among them) or a
// case reported reproduced (or partial) that did not produce every event it
// should; 2 when the run is inconclusive: nothing reproduced at all, a
// selected source with no case, a recording that is not complete (unstable, a
// recorder problem), a copy that is not the recorded code; 64 for a usage
// error. The last line prints every count.
// Scratch lives in <os tmpdir>/devryan-scheduler-conformance and is removed
// on pass, failure and interruption unless artifacts are kept.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOptions, runBunTests } from '../client-conformance/record.mjs';
import { CORPUS, recordCorpus, SCENARIO_ENV } from './drive.mjs';
import { createScratch, judgeRecording, PACKAGE_DIR, RECORDER, recordFiles, REPOSITORY_ROOT, schedulerTestFiles } from './record.mjs';
import { prepareCopy } from './replay.mjs';
import { COPY_PLANTS, REPLAYER_PLANTS } from './replay-mutants.mjs';
import { buildContainers, casePlacement, EXIT, formatIncomplete, readContainer, readRaws } from './trace.mjs';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPLAY = path.join(HARNESS_DIR, 'replay.mjs');
const PLANTS = path.join(HARNESS_DIR, 'replay-mutants.mjs');
/** The awaiting shapes (a test file of this folder, named as the package's runner sees it). */
const SHAPES = '../../scripts/scheduler-conformance/shapes.toy.mjs';
/** How long one replay process or one plant process may take before it is killed and named. */
export const CHILD_DEADLINE_MS = 600_000;
export const SOURCES = Object.freeze(['tests', 'package', 'scenarios']);
export const CASE_OUTCOMES = Object.freeze(['reproduced', 'partial', 'crossed', 'unrecordable', 'empty', 'different']);

/** The package's other test files that build a scheduler (design §4.1 R2): every non-scheduler test file that names the factory. */
export const packageTestFiles = (directory = PACKAGE_DIR) => readdirSync(directory)
  .filter((name) => name.endsWith('.test.js') && !/^scheduler\..+\.test\.js$/.test(name) && readFileSync(path.join(directory, name), 'utf8').includes('createManagedTaskScheduler'))
  .sort().map((name) => `./${name}`);

/** Records one source twice into `<workDir>/containers/<source>`; returns its containers' paths and the recording's judgement. */
export async function recordSource(source, { workDir, names = null }) {
  const out = path.join(workDir, 'containers', source);
  mkdirSync(out, { recursive: true });
  const sourceDir = path.join(workDir, `record-${source}`);
  mkdirSync(sourceDir, { recursive: true });
  let recorded;
  if (source === 'scenarios') {
    recorded = await recordCorpus({ names, runs: 2, workDir: sourceDir, paranoid: false });
  } else {
    const files = source === 'tests' ? (names ?? schedulerTestFiles()) : (names ?? packageTestFiles());
    recorded = await recordFiles({ files, runs: 2, workDir: sourceDir });
  }
  const judged = judgeRecording({ plain: recorded.plain, recordings: recorded.recordings });
  const containers = [];
  for (const container of recorded.recordings[0]?.containers ?? []) {
    const file = path.join(out, container.name);
    writeFileSync(file, container.text);
    containers.push(file);
  }
  return { source, containers, recording: { code: judged.code, incomplete: judged.incomplete, unstable: judged.unstable, differences: judged.differences, outcomes: judged.outcomes } };
}

/**
 * One recording without a plain run or a second recording (the self-test's:
 * its containers only, judged by nothing but the replay): `tests` are files
 * of the package, `scenarios` names of corpus tests. Returns `{ tests, scenarios }`,
 * each the path of its one container (or null), and every problem the recording had.
 */
export async function recordQuick({ workDir, tests = [], scenarios = [] }) {
  const run = async (key, files, cwd, env) => {
    if (!files.length) return { key, files: [], problems: [] };
    const out = path.join(workDir, `quick-${key}`);
    mkdirSync(out, { recursive: true });
    const result = await runBunTests({ files, cwd, root: REPOSITORY_ROOT, preload: [RECORDER], env: { ...env, DEVRYAN_CONFORMANCE_OUT: out }, junitFile: path.join(workDir, `quick-${key}.xml`), parallel: 1 });
    const raws = readRaws(out);
    const built = buildContainers({ raws, junit: result.junit, root: REPOSITORY_ROOT, harnessDir: HARNESS_DIR });
    const written = built.containers.map((container) => { const file = path.join(out, container.name); writeFileSync(file, container.text); return file; });
    return { key, files: written, problems: [...built.incomplete.map((item) => formatIncomplete(item)), ...(result.status === 0 ? [] : [`bun exited ${result.status}`])] };
  };
  const [testRun, scenarioRun] = await Promise.all([
    run('tests', tests, PACKAGE_DIR, {}),
    run('scenarios', scenarios.length ? [CORPUS] : [], REPOSITORY_ROOT, { ...SCENARIO_ENV, DEVRYAN_SCHEDULER_SCENARIOS: scenarios.join(',') }),
  ]);
  return { tests: testRun.files, scenarios: scenarioRun.files, problems: [...testRun.problems, ...scenarioRun.problems] };
}

/** The containers already in a directory, for a source given with `--containers`. */
export const containersIn = (directory) => readdirSync(directory).filter((name) => name.endsWith('.ndjson')).sort().map((name) => path.join(directory, name));

/**
 * Replays one container file in its own bun process (memory stays bounded by the largest file). Bounded: a replay
 * that has not finished after `deadlineMs` is killed, and the result is an error that names the container.
 */
export function replayFile(file, { copyDir, workDir, replay = REPLAY, deadlineMs = CHILD_DEADLINE_MS }) {
  const json = path.join(workDir, `replay-${path.basename(file)}.json`);
  return new Promise((resolve) => {
    const child = spawn('bun', [replay, `--copy=${copyDir}`, `--json=${json}`, file], {
      cwd: REPOSITORY_ROOT, env: { ...process.env, ...SCENARIO_ENV, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let late = false;
    const timer = setTimeout(() => { late = true; child.kill('SIGKILL'); }, deadlineMs);
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ file, error: String(error.message) }); });
    child.on('close', (status) => {
      clearTimeout(timer);
      const recorded = recordedMarks(file);
      if (late) { resolve({ file, recorded, error: `the replay of ${path.basename(file)} did not finish within ${deadlineMs} ms and was killed` }); return; }
      if (status !== 0 || !existsSync(json)) { resolve({ file, recorded, error: `the replay process exited ${status}: ${stderr.trim().split('\n').slice(-6).join(' | ')}` }); return; }
      try { resolve({ file, recorded, ...JSON.parse(readFileSync(json, 'utf8')) }); } catch (error) { resolve({ file, recorded, error: `unreadable replay result: ${error.message}` }); }
    });
  });
}

/**
 * What the recording itself says about a container, read here and not by the
 * replayer: its end line, and per case its id, outcome, recorded event count
 * and where its comparison ends (trace.mjs `casePlacement`). `{ error }` when
 * the container cannot be read.
 */
export function recordedMarks(file) {
  try {
    const read = readContainer(readFileSync(file, 'utf8'));
    return { end: read.end, cases: read.cases.map((record) => ({ id: record.id, outcome: record.outcome, events: record.events, ...(record.outcome === 'recorded' ? { limit: casePlacement(record).limit } : {}) })) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** Runs `tasks` (functions returning promises) at most `workers` at a time, results in order. */
async function pool(tasks, workers) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, tasks.length)) }, async () => {
    while (next < tasks.length) { const index = next++; results[index] = await tasks[index](); }
  }));
  return results;
}

/**
 * Judges a closure run (pure: the self-test feeds it fixed inputs). `sources`
 * is a list of `{ source, recording, replays: [{ file, recorded, containers,
 * results } | { file, recorded, error }] }`, `recorded` being what
 * `recordedMarks` read from the container. `expectCopyDiffers` lists the
 * module paths a planted copy is known to change: a provenance difference that
 * names exactly those is information, not inconclusive (the comparer's case;
 * a closure run gives none). Returns `{ code, table, byFile, problems, info,
 * cases, counts }`.
 */
export function judgeClosure(sources, { expectCopyDiffers = [] } = {}) {
  const problems = [];
  const info = [];
  const table = {};
  const byFile = {};
  const cases = [];
  const fail = (source, check, detail) => problems.push({ kind: 'fail', source, check, detail });
  const expectedProblems = new Set(expectCopyDiffers.map((file) => `${file} differs from the recorded module`));
  for (const entry of sources) {
    const row = Object.fromEntries(CASE_OUTCOMES.map((outcome) => [outcome, 0]));
    table[entry.source] = row;
    if (entry.recording && entry.recording.code !== EXIT.pass) {
      for (const item of entry.recording.incomplete ?? []) problems.push({ kind: 'inconclusive', source: entry.source, check: `recording ${item.check}`, detail: formatIncomplete(item) });
      for (const item of entry.recording.unstable ?? []) problems.push({ kind: 'inconclusive', source: entry.source, check: 'recording unstable', detail: `${item.case}: ${item.detail}` });
      for (const item of entry.recording.differences ?? []) problems.push({ kind: 'inconclusive', source: entry.source, check: 'recording parity', detail: item.detail });
    }
    let seen = 0;
    for (const replay of entry.replays) {
      const recorded = replay.recorded ?? { error: 'the judgement was given no reading of the container' };
      if (recorded.error) { fail(entry.source, 'container-integrity', `${replay.file}: ${recorded.error}`); continue; }
      seen += recorded.cases.length;
      if (replay.error) { fail(entry.source, 'replay-process', `${replay.file}: ${replay.error}`); continue; }
      const endCases = recorded.end?.cases;
      const endEvents = recorded.end?.events;
      if (endCases !== recorded.cases.length || endEvents !== recorded.cases.reduce((sum, item) => sum + item.events, 0)) fail(entry.source, 'container-integrity', `${replay.file}: the end line says ${endCases} cases and ${endEvents} events, the container holds ${recorded.cases.length}`);
      for (const container of replay.containers ?? []) {
        if (container.provenance?.same) continue;
        const listed = container.provenance?.problems ?? ['no provenance'];
        if (expectedProblems.size && listed.length === expectedProblems.size && listed.every((item) => expectedProblems.has(item))) info.push({ source: entry.source, check: 'copy-provenance', detail: `${container.testFile}: the planted copy differs as expected (${listed.join('; ')})` });
        else problems.push({ kind: 'inconclusive', source: entry.source, check: 'copy-provenance', detail: `${container.testFile}: ${listed.join('; ')}` });
        if (container.end && (container.end.cases !== endCases || container.end.events !== endEvents)) fail(entry.source, 'container-integrity', `${replay.file}: the replayer read ${container.end.cases} cases and ${container.end.events} events, the judgement ${endCases} and ${endEvents}`);
      }
      const results = replay.results ?? [];
      // Every recorded case, in order, has exactly one result: a dropped or extra case is a failure.
      const ids = (list) => list.map((item) => item.id).join('\n');
      if (ids(results) !== ids(recorded.cases)) fail(entry.source, 'case-missing', `${replay.file}: the replay reports ${results.length} cases, the container holds ${recorded.cases.length}${results.length === recorded.cases.length ? ' (in another order or under other names)' : ''}`);
      for (const [index, result] of results.entries()) {
        const mark = recorded.cases[index];
        const outcome = CASE_OUTCOMES.includes(result.outcome) ? result.outcome : 'different';
        row[outcome] += 1;
        cases.push({ source: entry.source, ...result });
        if (result.unhandledRejections) info.push({ source: entry.source, check: 'unhandled-rejection', detail: `${result.id}: ${result.unhandledRejections} unhandled rejection(s) while the candidate ran (a test's own handlers are not in a replay)` });
        const file = result.testFile ?? result.file;
        byFile[file] ??= { cases: 0, reproduced: 0, partial: 0, crossed: 0, unrecordable: 0, empty: 0, different: 0, compared: 0, recorded: 0, prefixes: [] };
        const stats = byFile[file];
        stats[outcome] += 1;
        if (outcome !== 'empty') stats.cases += 1;
        if (mark?.outcome === 'recorded') stats.recorded += mark.events;
        if (outcome === 'reproduced' || outcome === 'partial') stats.compared += result.produced ?? 0;
        if (outcome === 'partial') stats.prefixes.push(`${result.produced}/${result.events}`);
        // Independent checks of the replayer's verdict, against what the judgement read from the recording.
        if (mark && mark.id === result.id) {
          if (result.recordedEvents !== mark.events || (mark.outcome === 'recorded' && result.events !== mark.events)) fail(entry.source, 'event-count', `${result.id}: the recording says ${mark.events} events, the replay counted ${result.events} (recorded ${result.recordedEvents})`);
          // Unrecordable is the recording's verdict only: a case it recorded that a replay calls unrecordable fails.
          const expectedOutcome = mark.outcome === 'empty' ? ['empty'] : mark.outcome !== 'recorded' ? ['unrecordable']
            : mark.limit === 0 ? ['crossed'] : mark.limit < mark.events ? ['partial', 'different'] : ['reproduced', 'different'];
          if (outcome === 'unrecordable' && mark.outcome === 'recorded') fail(entry.source, 'unrecordable-mark', `${result.id} is reported unrecordable (${result.reason ?? 'no reason'}); the recording recorded it, so it is ${expectedOutcome.join(' or ')}`);
          else if (!expectedOutcome.includes(outcome)) fail(entry.source, 'crossed-mark', `${result.id} is reported ${outcome}; the recording's marks make it ${expectedOutcome.join(' or ')} (compared up to ${mark.limit ?? 0} of ${mark.events} events)`);
          if (outcome === 'reproduced' && result.produced !== mark.events) fail(entry.source, 'reproduced-complete', `${result.id} is reported reproduced after ${result.produced} of its ${mark.events} events`);
          if (outcome === 'partial' && (result.produced !== mark.limit || result.prefix !== mark.limit)) fail(entry.source, 'reproduced-complete', `${result.id} is reported partial after ${result.produced} events; its compared prefix is ${mark.limit} of ${mark.events}`);
        }
        if (outcome === 'different') fail(entry.source, result.check ?? 'different', `${result.id}: ${result.detail ?? ''}`);
        else if (entry.source === 'scenarios' && outcome !== 'reproduced') fail(entry.source, `scenario-${outcome}`, `${result.id}: a scenario must be reproduced whole; ${outcome}: ${result.detail ?? result.reason ?? ''}`);
        else if (['unrecordable', 'crossed', 'partial'].includes(outcome) && !(result.reason || result.detail)) fail(entry.source, 'unnamed', `${result.id} is ${outcome} with no reason`);
      }
    }
    if (seen === 0) problems.push({ kind: 'inconclusive', source: entry.source, check: 'empty-source', detail: `the source ${entry.source} has no case: ${entry.replays.length} containers` });
  }
  const counts = Object.fromEntries(CASE_OUTCOMES.map((outcome) => [outcome, Object.values(table).reduce((sum, row) => sum + row[outcome], 0)]));
  if (counts.reproduced === 0) problems.push({ kind: 'inconclusive', check: 'nothing-replayed', detail: 'no case was reproduced: the run replayed nothing whole' });
  const code = problems.some((problem) => problem.kind === 'fail') ? EXIT.fail : problems.length ? EXIT.inconclusive : EXIT.pass;
  return { code, table, byFile, problems, info, cases, counts };
}

/** One line per test file: its cases by outcome and how many of its recorded events were compared. */
export function fileLines(byFile) {
  return Object.entries(byFile).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, stats]) => `  ${file}: ${stats.cases} cases: ${stats.reproduced} reproduced, ${stats.partial} partial${stats.prefixes.length ? ` (${stats.prefixes.join(', ')})` : ''}, ${stats.crossed} crossed, ${stats.unrecordable} unrecordable${stats.empty ? `, ${stats.empty} empty` : ''}${stats.different ? `, ${stats.different} DIFFERENT` : ''}; ${stats.compared} of ${stats.recorded} recorded events compared`);
}

/** The table of counts per source and outcome, as text. */
export function tableLines(table) {
  const lines = [`${'source'.padEnd(10)}${CASE_OUTCOMES.map((outcome) => outcome.padStart(14)).join('')}`];
  for (const [source, row] of Object.entries(table)) lines.push(`${source.padEnd(10)}${CASE_OUTCOMES.map((outcome) => String(row[outcome]).padStart(14)).join('')}`);
  return lines;
}

/**
 * Records the sources (or reads the containers `given` names, a Map from
 * source to directory), makes one copy of the package in `workDir`, replays
 * every container in its own bun process (`workers` at a time) and judges.
 * Returns `{ judged, containers }` (containers per source, for further use).
 */
export async function runClosure({ sources = SOURCES, given = new Map(), names = {}, workers = 4, workDir, deadlineMs = CHILD_DEADLINE_MS }) {
  const copyDir = prepareCopy(workDir);
  const recorded = [];
  for (const source of sources) {
    if (given.has(source)) recorded.push({ source, containers: containersIn(given.get(source)), recording: null });
    else recorded.push(await recordSource(source, { workDir, names: names[source] ?? null }));
  }
  const replayDir = path.join(workDir, 'replays');
  mkdirSync(replayDir, { recursive: true });
  const tasks = recorded.flatMap((entry) => entry.containers.map((file) => async () => ({ source: entry.source, replay: await replayFile(file, { copyDir, workDir: replayDir, deadlineMs }) })));
  const done = await pool(tasks, workers);
  const judged = judgeClosure(recorded.map((entry) => ({ ...entry, replays: done.filter((item) => item.source === entry.source).map((item) => item.replay) })));
  return { judged, containers: Object.fromEntries(recorded.map((entry) => [entry.source, entry.containers])) };
}

/**
 * Runs every planted scheduler copy and replayer bug of the plant tool against `scenarios` (one container) and
 * `tests` (containers), to which the awaiting shapes, recorded here, are added. At most `workers` plant processes
 * at a time (the tool's default when not given), each bounded by `deadlineMs`; the whole run is bounded as well.
 * Resolves the tool's result, or `{ error }`.
 */
export async function runPlants({ scenarios, tests = [], workDir, workers = null, deadlineMs = CHILD_DEADLINE_MS }) {
  const shapes = await recordQuick({ workDir: path.join(workDir, 'shapes'), tests: [SHAPES] });
  if (shapes.problems.length || shapes.tests.length !== 1) return { error: `the awaiting shapes did not record: ${shapes.problems.join('; ') || `${shapes.tests.length} containers`}` };
  const args = [PLANTS, `--scenarios=${scenarios}`, `--tests=${[...tests, ...shapes.tests].join(',')}`, `--root=${workDir}`, `--deadline-ms=${deadlineMs}`, ...(workers ? [`--workers=${workers}`] : [])];
  // Every plant process has its own deadline; this one is for the tool itself (every process in turn, and a minute).
  const overallMs = deadlineMs * (4 + REPLAYER_PLANTS.length + 1) + 60_000;
  return new Promise((resolve) => {
    const child = spawn('bun', args, { cwd: REPOSITORY_ROOT, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    let late = false;
    const timer = setTimeout(() => { late = true; child.kill('SIGKILL'); }, overallMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: `the plant tool did not start: ${error.message}` }); });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (late) { resolve({ error: `the plant tool did not finish within ${overallMs} ms and was killed` }); return; }
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (error) { resolve({ error: `the plant tool exited ${status} with no result: ${error.message}` }); }
    });
  });
}

/**
 * Judges a plant run (pure: the self-test feeds it fixed inputs): the unchanged copy reproduces every case, every
 * planted copy and every planted replayer bug is caught, none is missing, and the delivery copy is no difference.
 * With `lateOnReal`, a settlement delivered late must also differ on a real recording (true of a corpus that holds
 * the scheduler's own test recordings; an early delivery differs on none, only on the delivery copy). Returns
 * `{ problems, lines }`: `problems` empty when everything holds, `lines` what the settle plants found on real recordings.
 */
export function judgePlants(plants, { copyPlants = COPY_PLANTS.length, replayerPlants = REPLAYER_PLANTS.length, lateOnReal = true } = {}) {
  const problems = [];
  const lines = [];
  if (!plants || plants.error) return { problems: [plants?.error ?? 'no plant result'], lines };
  const unchanged = plants.unchanged ?? {};
  if (unchanged.error) problems.push(`the unchanged copy: ${unchanged.error}`);
  else if (!Number.isInteger(unchanged.cases) || unchanged.cases === 0 || unchanged.reproduced !== unchanged.cases || unchanged.code !== EXIT.pass) problems.push(`the unchanged copy reproduced ${unchanged.reproduced} of ${unchanged.cases} cases (exit ${unchanged.code})`);
  const copies = plants.plants ?? [];
  for (const entry of copies.filter((item) => !item.caught)) problems.push(`the planted copy ${entry.name} was not caught: ${entry.outcome ?? 'no outcome'} ${entry.found?.check ?? ''} ${entry.found?.detail ?? ''} exit ${entry.code}`.replace(/\s+/g, ' ').trim());
  if (copies.length !== copyPlants) problems.push(`${copies.length} planted copies were judged, ${copyPlants} exist`);
  const replayer = plants.replayer ?? [];
  for (const entry of replayer.filter((item) => !item.caught)) problems.push(`the planted replayer bug ${entry.name} was not caught${entry.found?.detail ? `: ${entry.found.detail}` : ''}`);
  if (replayer.length !== replayerPlants) problems.push(`${replayer.length} planted replayer bugs were judged, ${replayerPlants} exist`);
  const delivery = plants.delivery ?? {};
  if (delivery.error) problems.push(`the delivery control: ${delivery.error}`);
  else if (delivery.different !== 0 || delivery.failing !== null || delivery.delivery?.outcome !== 'reproduced') problems.push(`the delivery copy is a difference: ${delivery.different} cases differ, the delivery case is ${delivery.delivery?.outcome ?? 'missing'}`);
  for (const entry of replayer.filter((item) => item.name.startsWith('settle-delivered-') && item.real)) {
    lines.push(`${entry.name} on the real recordings: ${entry.real.different} of ${entry.real.cases} cases different (${entry.real.checks.join(', ') || 'none'})${entry.real.first ? `, first ${entry.real.first.case} [${entry.real.first.check}]` : ''}`);
  }
  if (lateOnReal) {
    for (const name of ['settle-delivered-late-1', 'settle-delivered-late-2']) {
      const entry = replayer.find((item) => item.name === name);
      if (!(entry?.real?.different > 0)) problems.push(`${name} differs on no real recording`);
    }
  }
  return { problems, lines };
}

const USAGE = 'usage: closure.mjs [--sources=tests,package,scenarios] [--containers=<source>=<dir>,...] [--workers=N] [--plants] [--json=<file>] [--keep-artifacts]';

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['keep-artifacts', 'plants'], values: ['sources', 'containers', 'workers', 'json'] });
  if (parsed.error || parsed.positionals.length) { console.error(`${parsed.error ?? 'no positional arguments'}\n${USAGE}`); return EXIT.usage; }
  const { options } = parsed;
  const sources = options.sources ? options.sources.split(',') : [...SOURCES];
  if (sources.some((source) => !SOURCES.includes(source))) { console.error(`--sources: one of ${SOURCES.join(', ')}\n${USAGE}`); return EXIT.usage; }
  const given = new Map();
  for (const item of options.containers ? options.containers.split(',') : []) {
    const [source, directory] = item.split('=');
    if (!SOURCES.includes(source) || !directory || !existsSync(directory)) { console.error(`--containers: <source>=<existing dir>\n${USAGE}`); return EXIT.usage; }
    given.set(source, path.resolve(directory));
  }
  const workers = Number(options.workers ?? 4);
  if (!Number.isInteger(workers) || workers < 1) { console.error(`--workers must be a positive integer\n${USAGE}`); return EXIT.usage; }
  if (options.plants && !sources.includes('scenarios')) { console.error(`--plants needs the scenarios source\n${USAGE}`); return EXIT.usage; }
  const scratch = createScratch('scheduler-conformance-closure');
  let status = 'failed';
  try {
    const started = Date.now();
    const { judged, containers } = await runClosure({ sources, given, workers, workDir: scratch.dir });
    // One line per case: its outcome and, unless reproduced, its reason or check with the first differing event.
    for (const entry of judged.cases) console.log(`${entry.outcome === 'different' ? 'DIFFERENT' : entry.outcome} ${entry.id}${entry.outcome === 'reproduced' ? ` (${entry.produced} events)` : `: ${entry.check && entry.outcome === 'different' ? `(${entry.check}) ` : ''}${entry.reason ?? entry.detail ?? ''}`.slice(0, 600)}`);
    for (const problem of judged.problems) console.log(`${problem.kind === 'fail' ? 'FAILED' : 'inconclusive'} (${problem.check})${problem.source ? ` ${problem.source}` : ''}: ${problem.detail}`);
    for (const line of tableLines(judged.table)) console.log(line);
    for (const item of judged.info) console.log(`info (${item.check})${item.source ? ` ${item.source}` : ''}: ${item.detail}`);
    console.log('per test file (partial: events compared / recorded):');
    for (const line of fileLines(judged.byFile)) console.log(line);
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code: judged.code, table: judged.table, byFile: judged.byFile, problems: judged.problems, info: judged.info, cases: judged.cases }, null, 2)}\n`);
    const verdict = judged.code === EXIT.pass ? 'complete' : judged.code === EXIT.fail ? 'FAILED' : 'INCONCLUSIVE';
    console.log(`scheduler closure ${verdict}: ${judged.cases.length} cases (${sources.join(', ')}), ${Math.round((Date.now() - started) / 1000)} s; ${CASE_OUTCOMES.map((outcome) => `${judged.counts[outcome]} ${outcome}`).join(', ')}; ${judged.problems.length} problems`);
    if (judged.code !== EXIT.pass || !options.plants) {
      status = judged.code === EXIT.pass ? 'passed' : 'failed';
      return judged.code;
    }
    // The planted copies and replayer bugs against everything just recorded (minutes on the whole corpus).
    const plantsStarted = Date.now();
    const plants = await runPlants({ scenarios: containers.scenarios[0], tests: [...(containers.tests ?? []), ...(containers.package ?? [])], workDir: scratch.dir, workers: options.workers ? workers : null });
    const found = judgePlants(plants, { lateOnReal: sources.includes('tests') });
    for (const line of found.lines) console.log(line);
    for (const problem of found.problems) console.log(`FAILED (plants): ${problem}`);
    console.log(`scheduler plants ${found.problems.length ? 'FAILED' : 'complete'}: ${plants.plants?.length ?? 0} planted copies, ${plants.replayer?.length ?? 0} planted replayer bugs, ${Math.round((Date.now() - plantsStarted) / 1000)} s; ${found.problems.length} problems`);
    status = found.problems.length ? 'failed' : 'passed';
    return found.problems.length ? EXIT.fail : EXIT.pass;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
