#!/usr/bin/env node
// Runs the scripted scenarios (scenarios.mjs, package O0b of design file 30)
// and judges them:
//
//   node scripts/scheduler-conformance/drive.mjs [--runs=2] [--scenarios=<name,...>] [--no-crash-points] [--large]
//     [--json=<file>] [--out=<new or empty dir>] [--keep-artifacts]
//
// The corpus (scenarios.corpus.mjs) runs once without the recorder and
// `--runs` times (at least 2) under it with the driver's own drain (one
// setImmediate boundary), then once more under it with the paranoid drain
// (design §8.2 Q1: sixteen boundaries and two real timer turns per step).
// Judged: pass-set parity, every case recorded, every case byte-equal
// between the recordings (stability) and between the one-boundary and the
// paranoid recording (quiescence); a case that differs is printed with its
// first differing event, never accepted. Each case prints its event count
// and its facts read from the trace itself: steps, saves, launches (in
// order, with their steps and the saves before the first), reconciles.
// `--large` also runs the large F1 sizes in one bun process each, twice,
// without the recorder, and compares the driver's logs.
// Every case's facts are compared with what its scenario states (in the
// run itself, and from the first recording's trace with its step markers).
// Exit 0 only for a complete run with nothing wrong; 1 when a scenario
// fails (a driver check or a stated fact, plainly or recorded, or a fact or
// step marker read from its trace), parity differs or a large run fails; 2
// when a case is unrecordable, unstable or depends on the drain, or a large
// run is unstable; 64 for a usage error. Scratch lives in <os tmpdir>/
// devryan-scheduler-conformance and is removed unless artifacts are kept.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOptions, runBunTests } from '../client-conformance/record.mjs';
import { createScratch, HARNESS_DIR, judgeRecording, RECORDER, REPOSITORY_ROOT } from './record.mjs';
import { compareFacts, TRACE_FACT_KEYS, traceFacts as scenarioTraceFacts } from './scenario-facts.mjs';
import { buildContainers, EXIT, formatIncomplete, readContainer, readRaws } from './trace.mjs';

export const CORPUS = './scripts/scheduler-conformance/scenarios.corpus.mjs';
const CORPUS_FILE = CORPUS.slice(2);
const LAUNCH = new Set(['executor.start', 'executor.resume', 'executor.retryInPlace']);
// Read on every save by the scheduler: pinned so a recording does not depend on the caller's environment.
export const SCENARIO_ENV = Object.freeze({ DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY: '1' });

/**
 * Records the corpus: one plain run, `runs` recordings with the driver's
 * drain, and one with `drain` `paranoid` (unless `paranoid: false`).
 * `names` keeps those corpus tests. Returns `{ plain, recordings, paranoid }`
 * shaped as record.mjs judges them.
 */
export async function recordCorpus({ names = null, runs = 2, workDir, recorder = RECORDER, paranoid = true, env = {} }) {
  const selection = { ...SCENARIO_ENV, ...(names ? { DEVRYAN_SCHEDULER_SCENARIOS: names.join(',') } : {}), ...env };
  const files = [CORPUS];
  const plain = await runBunTests({ files, cwd: REPOSITORY_ROOT, root: REPOSITORY_ROOT, env: selection, junitFile: path.join(workDir, 'plain.xml'), parallel: 1 });
  const record = async (run, drain) => {
    const out = path.join(workDir, `raw-${run}-${drain}`);
    mkdirSync(out, { recursive: true });
    const result = await runBunTests({ files, cwd: REPOSITORY_ROOT, root: REPOSITORY_ROOT, preload: [recorder], env: { ...selection, DEVRYAN_CONFORMANCE_OUT: out, DEVRYAN_SCHEDULER_DRIVER_DRAIN: drain }, junitFile: path.join(workDir, `recorded-${run}-${drain}.xml`), parallel: 1 });
    const raws = readRaws(out);
    return { run, drain, status: result.status, junit: result.junit, junitError: result.junitError, output: result.output, raws, ...buildContainers({ raws, junit: result.junit, root: REPOSITORY_ROOT, expectedFiles: [CORPUS_FILE], harnessDir: path.dirname(recorder) }) };
  };
  const all = await Promise.all([...Array.from({ length: runs }, (_, index) => record(index + 1, 'one')), ...(paranoid ? [record(runs + 1, 'paranoid')] : [])]);
  return { plain, recordings: all.filter((entry) => entry.drain === 'one'), paranoid: all.find((entry) => entry.drain === 'paranoid') ?? null };
}

/** A case's events in their one total order (`at`), each with its construction's number. */
export const caseEvents = (record) => record.constructions.flatMap((construction) => construction.events.map((event) => ({ ...event, construction: construction.n }))).sort((a, b) => a.at - b.at);

/** Facts of one recorded case, read from its trace alone. */
export function traceFacts(record, resolve) {
  const facts = { events: 0, constructions: record.constructions.length, steps: 0, saves: 0, launches: [], savesBeforeFirstLaunch: null, reconciles: [], kinds: {} };
  let step = 0;
  for (const event of caseEvents(record)) {
    facts.events += 1;
    facts.kinds[`${event.dir} ${event.kind}`] = (facts.kinds[`${event.dir} ${event.kind}`] ?? 0) + 1;
    if (event.kind === 'step') { step = event.step; facts.steps = step; continue; }
    if (event.kind !== 'port') continue;
    if (event.name === 'persistence.save') facts.saves += 1;
    const taskId = () => { const args = resolve(event.args); return Array.isArray(args) && args[0] && typeof args[0].taskId === 'string' ? args[0].taskId : null; };
    if (LAUNCH.has(event.name)) {
      if (facts.savesBeforeFirstLaunch === null) facts.savesBeforeFirstLaunch = facts.saves;
      facts.launches.push({ construction: event.construction, port: event.name, taskId: taskId(), step, savesBefore: facts.saves });
    }
    if (event.name === 'executor.reconcile') facts.reconciles.push({ construction: event.construction, taskId: taskId(), step });
  }
  return facts;
}

/** The first event at which two recordings of one case differ (by `at` order), with both events, or null. */
export function firstDifferingEvent(left, right, resolveLeft, resolveRight) {
  const a = caseEvents(left);
  const b = caseEvents(right);
  const show = (event, resolve) => (event ? JSON.stringify(Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === 'string' && /^=[0-9a-f]{16}$/.test(value) ? resolve(value) : value]))).slice(0, 400) : '(no event)');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = show(a[index], resolveLeft);
    const y = show(b[index], resolveRight);
    if (x !== y) return { index, at: a[index]?.at ?? b[index]?.at, left: x, right: y };
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) return { index: -1, at: null, left: 'the case records differ outside their events', right: '' };
  return null;
}

// A container read once per text: the judgements read the same recording several times.
const readCache = new Map();
const readOnce = (text) => {
  if (!readCache.has(text)) { if (readCache.size > 64) readCache.clear(); readCache.set(text, readContainer(text)); }
  return readCache.get(text);
};

/** Every case of a recording by id: its record, resolver and case line. */
function casesById(recording) {
  const out = new Map();
  for (const container of recording.containers) {
    const read = readOnce(container.text);
    read.cases.forEach((record, index) => out.set(record.id, { record, resolve: read.resolve, line: read.lines[index + 2] }));
  }
  return out;
}

/**
 * Compares two recordings case by case (byte-equal case lines, which hold
 * content hashes): each case only one has, or whose line differs, with its
 * first differing event.
 */
export function compareCases(first, second) {
  const a = casesById(first);
  const b = casesById(second);
  const found = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(id);
    const right = b.get(id);
    if (!left || !right) { found.push({ case: id, detail: `only ${left ? 'the first' : 'the second'} recording has it` }); continue; }
    if (left.line === right.line) continue;
    const difference = firstDifferingEvent(left.record, right.record, left.resolve, right.resolve);
    found.push({ case: id, detail: difference ? `first differing event #${difference.index + 1} (at ${difference.at}): ${difference.left} then ${difference.right}` : 'the case lines differ' });
  }
  return found;
}

/** Judges a corpus recording: record.mjs's judgement plus the quiescence comparison, case facts and the exit code. */
export function judgeCorpus({ plain, recordings, paranoid }) {
  const judged = judgeRecording({ plain, recordings });
  // Stability with the first differing event (record.mjs compares the bytes, this names the event).
  const unstable = recordings.slice(1).flatMap((later) => compareCases(recordings[0], later).map((entry) => ({ run: later.run, ...entry })));
  const drainDiffers = paranoid ? compareCases(recordings[0], paranoid) : [];
  const incomplete = [...judged.incomplete, ...(paranoid ? paranoid.incomplete.map((entry) => ({ run: 'paranoid', ...entry })) : [{ check: 'no-paranoid', detail: 'no recording with the paranoid drain: quiescence is unchecked' }])];
  const plainFailed = (plain?.junit ?? []).filter((test) => test.status === 'failed').map((test) => test.name);
  const cases = [];
  if (recordings[0]) for (const [id, { record, resolve }] of casesById(recordings[0])) cases.push({ id, name: record.name, outcome: record.outcome, facts: traceFacts(record, resolve) });
  const code = judged.differences.length || plainFailed.length ? EXIT.fail
    : incomplete.length || unstable.length || judged.unstable.length || drainDiffers.length ? EXIT.inconclusive : EXIT.pass;
  return { code, differences: judged.differences, incomplete, unstable, recordedUnstable: judged.unstable, drainDiffers, plainFailed, cases, outcomes: judged.outcomes };
}

/**
 * Each recorded case against what its scenario states (the keys a trace
 * gives, TRACE_FACT_KEYS of scenario-facts.mjs), and its step markers against
 * its events (every listed input is in its step, every input of the step is
 * listed, every clock read in a step equals the marker's time). `entries` is
 * corpusTests() of scenarios.mjs. Returns one line per problem.
 */
export function traceFactProblems(recording, entries) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const problems = [];
  for (const [, { record, resolve }] of casesById(recording)) {
    const read = scenarioTraceFacts(record, resolve);
    for (const problem of read.problems) problems.push(`${record.name}: ${problem}`);
    const entry = byName.get(record.name);
    if (!entry) { problems.push(`${record.name}: no corpus test has this name`); continue; }
    // A crash point states its restart, which a trace shows through the save digests (driver.test.mjs checks them).
    if (entry.crash) continue;
    for (const difference of compareFacts(entry.scenario.facts, read.facts, TRACE_FACT_KEYS)) problems.push(`${record.name}: trace ${difference}`);
  }
  return problems;
}

/** Runs the large F1 sizes in their own bun processes (twice each, no recorder) and compares the driver logs. */
async function runLarge(names) {
  const results = [];
  for (const name of names) {
    const runs = [];
    for (let run = 0; run < 2; run += 1) runs.push(await bunJson([`--large-only=${name}`]));
    const [first, second] = runs;
    const differences = [...(first.differences ?? []), ...(second.differences ?? [])];
    results.push({ name, facts: first.facts, ms: [first.ms, second.ms], logLength: first.logLength, stable: first.digest === second.digest, error: first.error ?? second.error ?? (differences.length ? `facts differ from what the scenario states: ${differences.join('; ')}` : null) });
  }
  return results;
}
const bunJson = (args) => new Promise((resolve, reject) => {
  const child = spawn('bun', [fileURLToPath(import.meta.url), ...args], { cwd: REPOSITORY_ROOT, env: { ...process.env, ...SCENARIO_ENV }, stdio: ['ignore', 'pipe', 'inherit'] });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.on('error', reject);
  child.on('close', () => { try { resolve(JSON.parse(text.trim().split('\n').pop())); } catch (error) { resolve({ error: `no result (${error.message})` }); } });
});

const factLine = (facts) => {
  const perStep = new Map();
  for (const launch of facts.launches) perStep.set(launch.step, (perStep.get(launch.step) ?? 0) + 1);
  const launchSteps = [...perStep].map(([step, count]) => `${step}${count > 1 ? ` (${count})` : ''}`);
  return `${facts.events} events, ${facts.constructions} construction${facts.constructions === 1 ? '' : 's'}, ${facts.steps} steps, ${facts.saves} saves, ${facts.launches.length} launches${facts.launches.length ? ` (first after ${facts.savesBeforeFirstLaunch} saves; in step${launchSteps.length === 1 ? '' : 's'} ${launchSteps.join(', ')})` : ''}${facts.reconciles.length ? `, ${facts.reconciles.length} reconciles` : ''}`;
};

const USAGE = 'usage: drive.mjs [--runs=N] [--scenarios=<name,...>] [--no-crash-points] [--large] [--json=<file>] [--out=<new or empty dir>] [--keep-artifacts]';

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['keep-artifacts', 'no-crash-points', 'large'], values: ['runs', 'scenarios', 'json', 'out', 'large-only'] });
  if (parsed.error) { console.error(`${parsed.error}\n${USAGE}`); return EXIT.usage; }
  const { options } = parsed;
  const { corpusTests, SCENARIOS, scenarioNamed } = await import('./scenarios.mjs');
  if (options['large-only']) {
    // The child of --large: one large scenario, its facts and a digest of its log, as one JSON line.
    const { runScenario } = await import('./scenarios.mjs');
    const { compareFacts, scenarioFacts } = await import('./scenario-facts.mjs');
    const { createHash } = await import('node:crypto');
    const scenario = scenarioNamed(options['large-only']);
    const started = performance.now();
    try {
      const result = await runScenario(scenario);
      const facts = { ...result.facts, launches: result.facts.launches.length, firstLaunchStep: result.facts.launchSteps[0] ?? null, lastLaunchStep: result.facts.launchSteps.at(-1) ?? null, launchSteps: undefined };
      const differences = compareFacts(scenario.facts, scenarioFacts(result.driver));
      console.log(JSON.stringify({ facts, differences, logLength: result.log.length, digest: createHash('sha256').update(JSON.stringify(result.log)).digest('hex'), ms: Math.round(performance.now() - started) }));
      return differences.length ? EXIT.fail : EXIT.pass;
    } catch (error) {
      console.log(JSON.stringify({ error: String(error?.message ?? error) }));
      return EXIT.fail;
    }
  }
  const runs = Number(options.runs ?? 2);
  if (!Number.isInteger(runs) || runs < 2) { console.error(`--runs must be an integer of at least 2\n${USAGE}`); return EXIT.usage; }
  const wanted = options.scenarios ? options.scenarios.split(',') : null;
  for (const name of wanted ?? []) if (!scenarioNamed(name)) { console.error(`unknown scenario ${name}\n${USAGE}`); return EXIT.usage; }
  const outDir = options.out && path.resolve(options.out);
  if (outDir && existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) { console.error(`--out=${options.out} must be a new or empty directory`); return EXIT.usage; }
  if (wanted && !options.large && wanted.every((name) => scenarioNamed(name).large)) { console.error(`the large scenarios run only with --large\n${USAGE}`); return EXIT.usage; }
  const names = corpusTests().filter((entry) => (!wanted || wanted.includes(entry.scenario.name)) && !(options['no-crash-points'] && entry.crash)).map((entry) => entry.name);
  const scratch = createScratch('scheduler-conformance-drive');
  let status = 'failed';
  try {
    // Only large scenarios asked for: nothing to record.
    const recorded = names.length ? await recordCorpus({ names, runs, workDir: scratch.dir }) : { plain: null, recordings: [], paranoid: null };
    const judged = names.length ? judgeCorpus(recorded) : { code: EXIT.pass, differences: [], incomplete: [], unstable: [], drainDiffers: [], plainFailed: [], cases: [] };
    for (const name of judged.plainFailed) console.log(`failed (plain run): ${name}`);
    for (const difference of judged.differences) console.log(`differs (${difference.check}, run ${difference.run}): ${difference.detail}`);
    for (const entry of judged.incomplete) console.log(formatIncomplete(entry));
    for (const entry of judged.unstable) console.log(`unstable (run 1 against run ${entry.run}): ${entry.case}: ${entry.detail}`);
    for (const entry of judged.drainDiffers) console.log(`quiescence: the one-boundary drain and the paranoid drain differ: ${entry.case}: ${entry.detail}`);
    if (judged.plainFailed.length || judged.code !== EXIT.pass) console.log(recorded.recordings[0]?.output.split('\n').filter((line) => /error|fail|check/i.test(line)).slice(0, 30).join('\n'));
    for (const entry of judged.cases) console.log(`scenario ${entry.name} (${entry.outcome}): ${factLine(entry.facts)}`);
    const factProblems = recorded.recordings[0] ? traceFactProblems(recorded.recordings[0], corpusTests()) : [];
    for (const problem of factProblems) console.log(`facts: ${problem}`);
    const large = options.large ? await runLarge(SCENARIOS.filter((scenario) => scenario.large && (!wanted || wanted.includes(scenario.name))).map((scenario) => scenario.name)) : [];
    for (const entry of large) console.log(`large ${entry.name}: ${entry.error ? `ERROR ${entry.error}` : `${entry.facts.steps} steps, ${entry.facts.saves} saves, ${entry.facts.launches} launches (first after ${entry.facts.savesBeforeFirstLaunch} saves, steps ${entry.facts.firstLaunchStep}-${entry.facts.lastLaunchStep}); log ${entry.logLength} entries, ${entry.stable ? 'stable' : 'UNSTABLE'} over 2 runs (${entry.ms.join(' ms, ')} ms)`}`);
    const largeBad = large.filter((entry) => entry.error || !entry.stable);
    const code = largeBad.some((entry) => entry.error) || factProblems.length ? EXIT.fail : judged.code === EXIT.pass && largeBad.length ? EXIT.inconclusive : judged.code;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      for (const container of recorded.recordings[0]?.containers ?? []) writeFileSync(path.join(outDir, container.name), container.text);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, ...judged, large }, null, 2)}\n`);
    const verdict = code === EXIT.pass ? 'complete' : code === EXIT.fail ? 'FAILED' : 'INCONCLUSIVE';
    console.log(`scheduler scenarios ${verdict}: ${judged.cases.length} cases (${names.length} asked), ${runs} recordings and one paranoid; ${judged.plainFailed.length} failed, ${judged.differences.length} parity differences, ${judged.unstable.length} unstable, ${judged.drainDiffers.length} drain-dependent, ${judged.incomplete.length} inconclusive${large.length ? `; large ${large.length} (${largeBad.length} bad)` : ''}`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
export { HARNESS_DIR };
