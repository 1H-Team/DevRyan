#!/usr/bin/env node
// The comparer's heavy sweeps (design file 30 §4.4, §4.5, package O0d), a
// command for a manual or scheduled run, never a test file (they cost minutes
// of CPU):
//
//   node scripts/scheduler-conformance/sweep.mjs [--scenarios=<name,...>] [--workers=N]
//     [--deadline-ms=N] [--option-varies] [--json=<file>] [--keep-artifacts]
//
// - Restart at every save point of every scripted scenario, durable and torn
//   (scenarios.mjs `CRASH_SWEEP_ENV`; F7, which states its own crash, aside):
//   one recording and one replay process per scenario, against a second copy
//   of the package with the comparer on. Every case must be reproduced with
//   the comparer passing.
// - With `--option-varies`, also OD2's corpus count: every recording of the
//   three sources is read for the cases whose compared prefix reads one option
//   key with more than one value (printed; a count, not a failure).
//
// Each scenario runs in a child process of its own (this file with
// `--scenario-run`: its recording, then its replay in a bun process), bounded
// by its own deadline (`--deadline-ms`, default 20 minutes per recording or
// replay, twice that and a minute for the child); a deadline stops that
// child's processes only, never a sibling's, and is inconclusive, naming the
// scenario. Exit codes: 0 every case reproduced and judged; 1 a case different
// or a judgement failure; 2 inconclusive (a recording problem, a deadline, a
// scenario not run, a source with no case); 64 a usage error. The last line
// prints every count. Scratch lives in <os tmpdir>/devryan-scheduler-conformance,
// removed on pass, failure and interruption (its children stopped first)
// unless artifacts are kept.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOptions } from '../client-conformance/record.mjs';
import { DeadlineError, replayBounded, runBounded, withDeadline } from './bounded.mjs';
import { judgeClosure, packageTestFiles, recordQuick } from './closure.mjs';
import { fromRecorded, readTable } from './compare.mjs';
import { createScratch, schedulerTestFiles, stopDescendants } from './record.mjs';
import { prepareCopy } from './replay.mjs';
import { corpusTests, CRASH_SWEEP_ENV } from './scenarios.mjs';
import { casePlacement, EXIT, readContainer } from './trace.mjs';

const USAGE = 'usage: sweep.mjs [--scenarios=<name,...>] [--workers=N] [--deadline-ms=N] [--option-varies] [--json=<file>] [--keep-artifacts]';
const SELF = fileURLToPath(import.meta.url);
/** The result file a scenario's child writes in its directory. */
const RESULT = 'result.json';

// Once interrupted, no new child is started (the run root's own handler stops the ones running).
let stopping = false;

/** Runs `tasks` at most `workers` at a time, results in order; none is started once the tool is interrupted. */
async function pool(tasks, workers) {
  const results = new Array(tasks.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, tasks.length)) }, async () => {
    while (next < tasks.length && !stopping) { const index = next++; results[index] = await tasks[index](); }
  }));
  return results;
}

/** The sweep's cases of one scenario: its plain case and every crash point (scenarios.mjs `corpusTests`, sweep on). */
const sweepCases = (name) => corpusTests({ sweep: true }).filter((entry) => entry.scenario.name === name).map((entry) => entry.name);

/**
 * One scenario, in this process (the child a sweep starts, `--scenario-run`): its cases recorded (bounded; this
 * process runs nothing else then), then replayed in a bun process of its own (bounded). Writes `{ replay, problems }`
 * to `<dir>/result.json`. On SIGTERM it stops its own descendants and exits.
 */
async function scenarioRun({ name, dir, copyDir, deadlineMs }) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stopDescendants().finally(() => { process.exit(signal === 'SIGINT' ? 130 : 143); }); });
  const cases = sweepCases(name);
  const problems = [];
  let replay = null;
  try {
    const recorded = await withDeadline(recordQuick({ workDir: dir, scenarios: cases, env: { [CRASH_SWEEP_ENV]: '1' } }), deadlineMs, `the recording of scenario ${name} (${cases.length} cases)`);
    if (recorded.problems.length || recorded.scenarios.length !== 1) problems.push({ kind: 'inconclusive', check: 'recording', detail: `${name}: ${recorded.problems.join('; ') || 'no container'}` });
    else {
      replay = await replayBounded(recorded.scenarios[0], { copyDir, json: path.join(dir, 'replay.json'), deadlineMs, label: `the replay of scenario ${name}` });
      if (replay.deadline) { problems.push({ kind: 'inconclusive', check: 'deadline', detail: replay.error }); replay = null; }
    }
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error;
    problems.push({ kind: 'inconclusive', check: 'deadline', detail: error.message });
  }
  writeFileSync(path.join(dir, RESULT), `${JSON.stringify({ name, cases: cases.length, replay, problems })}\n`);
  return 0;
}

/**
 * What one scenario's child left (pure: the self-test feeds it fixed inputs). `done` is the bounded run's `{ code,
 * signal, expired, stderr }`, `result` its result file or null. A deadline, the child's or one inside it, is
 * inconclusive naming the scenario; a child that ended without a result fails (`scenario-process`). Returns
 * `{ replay, problems }`.
 */
export function scenarioOutcome(name, done, result, { deadlineMs }) {
  if (done.expired) return { replay: null, problems: [{ kind: 'inconclusive', check: 'deadline', detail: `scenario ${name} was still running after ${deadlineMs} ms (deadline); its processes were stopped, no other scenario's` }] };
  if (!result) return { replay: null, problems: [{ kind: 'fail', check: 'scenario-process', detail: `scenario ${name}: its process ended (${done.code ?? done.signal}) without a result: ${String(done.stderr ?? '').trim().split('\n').slice(-4).join(' | ')}` }] };
  return { replay: result.replay, problems: result.problems ?? [] };
}

/** Every crash point of the selected scenarios, each scenario in its own bounded child process; the closure judgement of all. */
export async function crashSweep({ workDir, names = null, workers = 2, deadlineMs }) {
  const byScenario = new Map();
  for (const entry of corpusTests({ sweep: true })) {
    if (names && !names.includes(entry.scenario.name)) continue;
    byScenario.set(entry.scenario.name, [...(byScenario.get(entry.scenario.name) ?? []), entry.name]);
  }
  const copyDir = prepareCopy(workDir);
  const problems = [];
  const childMs = 2 * deadlineMs + 60_000;
  const runs = await pool([...byScenario].map(([name, cases], index) => async () => {
    const dir = path.join(workDir, `sweep-${index}`);
    mkdirSync(dir, { recursive: true });
    const done = await runBounded(process.execPath, [SELF, `--scenario-run=${name}`, `--dir=${dir}`, `--copy=${copyDir}`, `--deadline-ms=${deadlineMs}`], { deadlineMs: childMs });
    const file = path.join(dir, RESULT);
    let result = null;
    try { result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { result = null; }
    const outcome = scenarioOutcome(name, done, result, { deadlineMs: done.expired ? childMs : deadlineMs });
    problems.push(...outcome.problems);
    const shown = outcome.replay ? (outcome.replay.error ? `FAILED: ${outcome.replay.error}` : `replayed, ${(outcome.replay.results ?? []).filter((item) => item.outcome === 'reproduced').length} reproduced`) : outcome.problems.map((problem) => `${problem.kind === 'fail' ? 'FAILED' : 'inconclusive'} (${problem.check})`).join(', ');
    console.log(`${name}: ${cases.length} cases ${shown}`);
    return { ran: true, replay: outcome.replay };
  }), workers);
  // A scenario whose run never started (the tool interrupted) is not a pass.
  for (const [index, name] of [...byScenario.keys()].entries()) if (!runs[index]?.ran) problems.push({ kind: 'inconclusive', check: 'not-run', detail: `scenario ${name} was not run` });
  const judged = judgeClosure([{ source: 'scenarios', recording: null, replays: runs.map((run) => run?.replay).filter(Boolean) }]);
  const crashes = judged.cases.filter((entry) => / crash at save \d+ (durable|torn) /.test(entry.id)).length;
  return { judged, problems, cases: [...byScenario.values()].reduce((sum, list) => sum + list.length, 0), crashes, scenarios: byScenario.size };
}

/** OD2's corpus count: the compared cases that read one option key with more than one value. */
export async function optionVaries({ workDir, deadlineMs }) {
  const recorded = await withDeadline(recordQuick({ workDir: path.join(workDir, 'corpus'), tests: [...schedulerTestFiles(), ...packageTestFiles()], scenarios: corpusTests().map((entry) => entry.name) }), deadlineMs, 'the recording of the whole corpus');
  const count = { cases: 0, reads: 0, varies: 0, variesWhole: 0, keys: {}, problems: recorded.problems };
  for (const file of [...recorded.tests, ...recorded.scenarios]) {
    const { cases, resolve } = readContainer(readFileSync(file, 'utf8'));
    for (const record of cases) {
      if (record.outcome !== 'recorded') continue;
      const { limit } = casePlacement(record);
      if (limit === 0) continue;
      const events = fromRecorded(record, resolve);
      const compared = events.slice(0, limit);
      count.cases += 1;
      count.reads += compared.filter((event) => event.kind === 'read').length;
      const table = readTable(compared);
      if (table.varies.size) count.varies += 1;
      for (const key of table.varies) { const name = key.split('|').slice(1).join('|'); count.keys[name] = (count.keys[name] ?? 0) + 1; }
      if (readTable(events).varies.size) count.variesWhole += 1;
    }
  }
  return count;
}

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['keep-artifacts', 'option-varies'], values: ['scenarios', 'workers', 'deadline-ms', 'json', 'scenario-run', 'dir', 'copy'] });
  if (parsed.error || parsed.positionals.length) { console.error(`${parsed.error ?? 'no positional arguments'}\n${USAGE}`); return EXIT.usage; }
  const { options } = parsed;
  if (options['scenario-run']) return scenarioRun({ name: options['scenario-run'], dir: options.dir, copyDir: options.copy, deadlineMs: Number(options['deadline-ms']) });
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { stopping = true; });
  const workers = Number(options.workers ?? 2);
  const deadlineMs = Number(options['deadline-ms'] ?? 1_200_000);
  if (!Number.isInteger(workers) || workers < 1 || !Number.isInteger(deadlineMs) || deadlineMs < 1_000) { console.error(USAGE); return EXIT.usage; }
  const names = options.scenarios ? options.scenarios.split(',') : null;
  const known = new Set(corpusTests().map((entry) => entry.scenario.name));
  if (names?.some((name) => !known.has(name))) { console.error(`--scenarios: unknown ${names.filter((name) => !known.has(name)).join(', ')}\n${USAGE}`); return EXIT.usage; }
  const scratch = createScratch('scheduler-conformance-sweep');
  let status = 'failed';
  try {
    const started = Date.now();
    const sweep = await crashSweep({ workDir: scratch.dir, names, workers, deadlineMs });
    const varies = options['option-varies'] ? await optionVaries({ workDir: scratch.dir, deadlineMs }) : null;
    const { judged } = sweep;
    for (const entry of judged.cases.filter((item) => item.outcome !== 'reproduced')) console.log(`${entry.outcome.toUpperCase()} ${entry.id}: ${entry.check ? `(${entry.check}${entry.rule ? `/${entry.rule}` : ''}) ` : ''}${String(entry.detail ?? entry.reason ?? '').slice(0, 400)}`);
    const problems = [...sweep.problems, ...judged.problems];
    for (const problem of problems) console.log(`${problem.kind === 'fail' ? 'FAILED' : 'inconclusive'} (${problem.check}): ${problem.detail}`);
    if (varies) console.log(`option-varies: ${varies.varies} of ${varies.cases} compared cases (${varies.variesWhole} counting events past a busy input), ${varies.reads} reads compared${Object.keys(varies.keys).length ? `; keys ${JSON.stringify(varies.keys)}` : ''}${varies.problems.length ? `; recording problems: ${varies.problems.join('; ')}` : ''}`);
    const code = problems.some((problem) => problem.kind === 'fail') ? EXIT.fail : problems.length || (varies && varies.problems.length) ? EXIT.inconclusive : judged.code;
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, table: judged.table, compared: judged.compared, problems, cases: sweep.cases, crashes: sweep.crashes, varies }, null, 2)}\n`);
    console.log(`scheduler sweep ${code === EXIT.pass ? 'complete' : code === EXIT.fail ? 'FAILED' : 'INCONCLUSIVE'}: ${sweep.cases} cases (${sweep.crashes} crash points over ${sweep.scenarios} scenarios), ${Math.round((Date.now() - started) / 1000)} s; ${Object.entries(judged.counts).map(([outcome, count]) => `${count} ${outcome}`).join(', ')}; comparer info ${Object.entries(judged.compared.info).map(([rule, count]) => `${rule} ${count}`).join(', ') || 'none'}; independence-table moves ${judged.compared.independence}; ${problems.length} problems`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
