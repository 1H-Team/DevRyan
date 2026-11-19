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

export const USAGE = 'usage: --group=<name> [--allow-inconclusive=<row>,...] [--keep-artifacts]';

export function parseArguments(argv, groups = GROUPS) {
  const options = { allowInconclusive: [], keepArtifacts: false, group: null };
  for (const argument of argv) {
    if (argument === '--keep-artifacts') { options.keepArtifacts = true; continue; }
    const match = /^--(group|allow-inconclusive)=(.+)$/.exec(argument);
    if (!match) return { error: `unknown option ${argument}` };
    if (match[1] === 'group') {
      if (options.group) return { error: '--group given twice' };
      options.group = match[2];
    } else options.allowInconclusive.push(...match[2].split(',').filter(Boolean));
  }
  if (!options.group) return { error: '--group is required' };
  if (!Object.hasOwn(groups, options.group)) return { error: `unknown group ${options.group} (known: ${Object.keys(groups).join(', ')})` };
  return { options };
}

/**
 * One run. `checkComposition({ run, group, name, log })` returns the
 * composition problems (any makes the run inconclusive before a row is
 * produced); `produceRows({ run, group, name })` returns the judged rows and
 * the group's waiver table (`{ rows, waivers }`); until the scenario driver
 * exists (BH2-BH4) the CLI produces none.
 */
export async function runMain({ argv = process.argv.slice(2), env = process.env, log = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`),
  produceRows = async () => ({ rows: [], waivers: {} }), checkComposition } = {}) {
  if (typeof checkComposition !== 'function') throw new TypeError('runMain needs a composition check');
  const refusal = isolationRefusal({ env });
  if (refusal) { error(`backend conformance: ${refusal}`); return EXIT.refused; }
  const parsed = parseArguments(argv);
  if (parsed.error) { error(`backend conformance: ${parsed.error}\n${USAGE}`); return EXIT.refused; }
  const { options } = parsed;
  let run;
  try { run = createBackendRun({ env, argv, keepArtifacts: options.keepArtifacts }); } catch (failure) {
    if (failure instanceof RunRefused) { error(`backend conformance: ${failure.message}`); return EXIT.refused; }
    throw failure;
  }
  const exit = await judgedRun({ run, options, produceRows, checkComposition, log, error });
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
    const produced = await produceRows({ run, group, name: options.group });
    const waivers = { ...(produced.waivers ?? {}) };
    for (const id of options.allowInconclusive) {
      if (Object.hasOwn(waivers, id)) { error(`backend conformance: --allow-inconclusive=${id} repeats a waiver of the table`); return EXIT.refused; }
      waivers[id] = { outcome: 'inconclusive', reason: '(allowed) by --allow-inconclusive on the command line' };
    }
    const judgement = judgeRun({ rows: produced.rows, waivers });
    run.writeFile('report.json', `${JSON.stringify({ group: options.group, ...judgement }, null, 2)}\n`);
    for (const line of reportLines(judgement)) log(line);
    return judgement.exit;
  } catch (failure) {
    if (failure instanceof RunRefused) { error(`backend conformance: ${failure.message}`); return EXIT.refused; }
    error(`backend conformance: the run failed: ${failure.stack ?? failure}`);
    return EXIT.failed;
  }
}
