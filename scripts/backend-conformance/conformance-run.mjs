// One backend conformance run (BH0; design file 31 §8.2): the run root, the
// composition check, the rows and the verdict. The command-line entry wires
// in the real composition check; the self-test hands in its own, so it never
// loads (or names) the module that reads the server's composition.
//
// A run whose composition check finds anything judges nothing: no row is
// produced, the verdict is COMPOSITION DRIFT and the exit is 2
// (inconclusive), with every problem named.
import { EXIT, judgeRun, lastLine, reportLines } from './outcomes.mjs';
import { RunRefused, createBackendRun, isolationRefusal } from './run-scratch.mjs';
import { GROUPS } from './groups.mjs';

/**
 * The run's output after an interrupt (SIGINT, SIGTERM, SIGHUP): once `interrupt(signal)` is called, one line
 * says so and every later line is dropped, so a summary made from the teardown's half-finished
 * recordings (an arm killed under it) is never printed as if it were a result.
 */
export function interruptGate(log) {
  let signal = null;
  return {
    log: (line) => { if (signal === null) log(line); },
    interrupt: (name) => { if (signal !== null) return; signal = name; log(`backend conformance: interrupted by ${name}; nothing recorded is judged, and no summary is printed`); },
    get interrupted() { return signal; },
  };
}

export const USAGE = 'usage: --group=<name> [--candidate=<name>] [--scenario=<id>,...] [--allow-inconclusive=<row>,...] [--keep-artifacts]';
/** The candidates `--candidate` can name, by group: a candidate is judged instead of J (which still runs, for the closure check). */
export const CANDIDATES = Object.freeze(Object.fromEntries(Object.keys(GROUPS).filter((name) => GROUPS[name].rust).map((name) => [name, Object.freeze(['rust'])])));

export function parseArguments(argv, groups = GROUPS, candidates = CANDIDATES) {
  const options = { allowInconclusive: [], keepArtifacts: false, group: null, scenarios: [], candidate: null };
  for (const argument of argv) {
    if (argument === '--keep-artifacts') { options.keepArtifacts = true; continue; }
    const match = /^--(group|allow-inconclusive|scenario|candidate)=(.+)$/.exec(argument);
    if (!match) return { error: `unknown option ${argument}` };
    if (match[1] === 'candidate') {
      if (options.candidate) return { error: '--candidate given twice' };
      options.candidate = match[2];
    } else if (match[1] === 'group') {
      if (options.group) return { error: '--group given twice' };
      options.group = match[2];
    } else if (match[1] === 'scenario') options.scenarios.push(...match[2].split(',').filter(Boolean));
    else options.allowInconclusive.push(...match[2].split(',').filter(Boolean));
  }
  if (!options.group) return { error: '--group is required' };
  if (!Object.hasOwn(groups, options.group)) return { error: `unknown group ${options.group} (known: ${Object.keys(groups).join(', ')})` };
  const known = candidates[options.group] ?? [];
  if (options.candidate && !known.includes(options.candidate)) return { error: `unknown candidate ${options.candidate} for group ${options.group} (known: ${known.join(', ') || 'none'})` };
  return { options };
}

/**
 * One run. `checkComposition({ run, group, name, log })` returns the
 * composition problems (any makes the run inconclusive before a row is
 * produced); `produceRows({ run, group, name })` returns the judged rows and
 * the group's waiver table (`{ rows, waivers, gaps?, limits?, unjudged? }`; it
 * also gets `options`, the parsed command line; `unjudged` names a judgement
 * the run did not make, which keeps it from passing). `onInterrupt` runs on SIGINT, SIGTERM and SIGHUP
 * before the run root is removed (the driver kills what it started).
 * A row awaiting comparison (`awaiting` set: recorded, nothing judged it) can
 * never be waived: a waiver of one is refused.
 */
export async function runMain({ argv = process.argv.slice(2), env = process.env, log = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`),
  produceRows = async () => ({ rows: [], waivers: {} }), checkComposition, onInterrupt, parent } = {}) {
  if (typeof checkComposition !== 'function') throw new TypeError('runMain needs a composition check');
  const refusal = isolationRefusal({ env });
  if (refusal) { error(`backend conformance: ${refusal}`); return EXIT.refused; }
  const parsed = parseArguments(argv);
  if (parsed.error) { error(`backend conformance: ${parsed.error}\n${USAGE}`); return EXIT.refused; }
  const { options } = parsed;
  const gate = interruptGate(log);
  const interrupted = async (signal) => { gate.interrupt(signal); await onInterrupt?.(signal); };
  let run;
  // `parent`: the self-test's private scratch parent (no other run's sweep reaches it); the command never passes one.
  try { run = createBackendRun({ env, argv, keepArtifacts: options.keepArtifacts, onInterrupt: interrupted, parent }); } catch (failure) {
    if (failure instanceof RunRefused) { error(`backend conformance: ${failure.message}`); return EXIT.refused; }
    throw failure;
  }
  const exit = await judgedRun({ run, options, produceRows, checkComposition, log: gate.log, error });
  try { run.finish(exit === EXIT.passed ? 'passed' : 'failed'); } catch (failure) {
    error(`backend conformance: ${failure.message}; the run directory ${run.dir} was left in place`);
    return EXIT.refused;
  }
  return exit;
}

async function judgedRun({ run, options, produceRows, checkComposition, log, error }) {
  try {
    const group = GROUPS[options.group];
    let drift;
    try { drift = await checkComposition({ run, group, name: options.group, log }); } catch (failure) { drift = [`the composition check could not complete: ${failure.message}`]; }
    if (drift.length) {
      // Nothing is judged against a reference that may not be the server's.
      for (const problem of drift) log(`DRIFT ${problem}`);
      const judgement = { exit: EXIT.incomplete, verdict: 'COMPOSITION DRIFT', counts: { rows: 0, passed: 0, failed: 0, inconclusive: 0, unstable: 0, unrecordable: 0, waived: 0, waivers: 0, gaps: 0 }, rows: [], problems: drift.map((problem) => `composition drift: ${problem}`) };
      run.writeFile('report.json', `${JSON.stringify({ group: options.group, ...judgement }, null, 2)}\n`);
      log(lastLine(judgement));
      return judgement.exit;
    }
    const produced = await produceRows({ run, group, name: options.group, options, log });
    const waivers = { ...(produced.waivers ?? {}) };
    for (const id of options.allowInconclusive) {
      if (Object.hasOwn(waivers, id)) { error(`backend conformance: --allow-inconclusive=${id} repeats a waiver of the table`); return EXIT.refused; }
      if (produced.rows.some((row) => row.id === id && row.awaiting)) { error(`backend conformance: --allow-inconclusive=${id} names a row awaiting comparison; nothing judged it, so nothing can waive it`); return EXIT.refused; }
      waivers[id] = { outcome: 'inconclusive', reason: '(allowed) by --allow-inconclusive on the command line' };
    }
    // A table waiver of a row awaiting comparison waives nothing judged: it is dropped and counted as a gap.
    const gaps = [...(produced.gaps ?? [])];
    for (const row of produced.rows) if (row.awaiting && Object.hasOwn(waivers, row.id)) { delete waivers[row.id]; gaps.push(`waiver ${row.id} covers a row awaiting comparison (nothing judged it)`); }
    const judgement = judgeRun({ rows: produced.rows, waivers, gaps, limits: produced.limits ?? [], unjudged: produced.unjudged ?? [] });
    run.writeFile('report.json', `${JSON.stringify({ group: options.group, ...judgement }, null, 2)}\n`);
    for (const line of reportLines(judgement)) log(line);
    return judgement.exit;
  } catch (failure) {
    if (failure instanceof RunRefused) { error(`backend conformance: ${failure.message}`); return EXIT.refused; }
    error(`backend conformance: the run failed: ${failure.stack ?? failure}`);
    return EXIT.failed;
  }
}
