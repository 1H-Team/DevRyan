#!/usr/bin/env node
// Pass-set parity of the scheduler recorder (design file 30 §4.1): every test
// passes with the recorder exactly when it passes without it, with the same
// number of assertions, and prints the same lines. Each run executes the
// files plainly twice and then under the recorder (recording into scratch,
// so encoding is exercised too). The per-test and per-file checks are the
// client harness's (`judgeParity` in scripts/client-conformance/parity.mjs),
// and so is the normalisation of what the test runner prints about itself
// (`outputLines`: its per-test timing, its group markers, a file heading it
// repeats, the wall time on its closing summary line). What the two plain runs disagree on teaches what varies without
// the recorder: a differing line gives its shape, and only lines of a learned
// shape are left out, and counted. The shape here also writes as # every run
// of hex digits that holds a decimal digit, because the scheduler prints
// random identifiers (`ownerID: "dvr_save_8256…"` in a stall warning) whose
// letters vary too; a line both plain runs print the same is never left out.
//
//   node scripts/scheduler-conformance/parity.mjs [--runs=N] [--cwd=packages/orchestration-runtime] [--clock=nominal|real] [--json=<file>] [--keep-artifacts] [<test file>...]
//
// Without test files it checks the 21 `scheduler.*.test.js` files. Exit 0 when
// every run is complete and matches; 1 on a difference (it names the test or
// the line); 2 when a run is inconclusive (no tests, a file lost, a file
// without a recording, another number of tests recorded, a recorder error,
// two plain runs that disagree on an outcome); 64 on a usage error.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeParity, outputLines } from '../client-conformance/parity.mjs';
import { discoverTestFiles, formatIncomplete, parseOptions, runBunTests } from '../client-conformance/record.mjs';
import { createScratch, RECORDER, REPOSITORY_ROOT, schedulerTestFiles } from './record.mjs';
import { EXIT, readRaws } from './trace.mjs';

/** A line's shape: every run of hex digits that holds a decimal digit as #. */
export const lineShape = (line) => line.replace(/[0-9a-f]*[0-9][0-9a-f]*/g, '#');

const multisetDifference = (left, right) => {
  const counts = new Map();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of right) counts.set(line, (counts.get(line) ?? 0) - 1);
  return [...counts].filter(([, count]) => count !== 0);
};

/** The output check alone (pure): `{ difference, masked, varying }`. */
export function judgeOutput({ baselineOutput, secondBaselineOutput, recordedOutput }) {
  const varying = new Set(multisetDifference(outputLines(baselineOutput), outputLines(secondBaselineOutput)).map(([line]) => lineShape(line)));
  let masked = 0;
  const kept = (output) => outputLines(output).filter((line) => { if (!varying.has(lineShape(line))) return true; masked += 1; return false; });
  const printed = multisetDifference(kept(baselineOutput), kept(recordedOutput));
  const difference = printed.length ? printed.slice(0, 8).map(([line, count]) => `${count > 0 ? 'plain only' : 'recorded only'} x${Math.abs(count)}: ${line}`).join(' | ') : null;
  return { difference, masked, varying: [...varying] };
}

/**
 * Runs parity `runs` times. `plain` (`{ first, second }`, runBunTests results)
 * supplies the two plain runs when the caller already has them. Returns
 * `{ runs: [...], differences, incomplete }`.
 */
export async function schedulerParity({ files, cwd, runs = 1, workDir, recorder = RECORDER, root = REPOSITORY_ROOT, parallel, clock, env = {}, plain }) {
  const results = [];
  const differences = [];
  const incomplete = [];
  const expectedFiles = discoverTestFiles(files, { cwd, root });
  const workers = parallel ?? Math.max(1, Math.min(files.length, 4));
  for (let run = 1; run <= runs; run += 1) {
    const baseline = plain?.first ?? await runBunTests({ files, cwd, root, junitFile: path.join(workDir, `baseline-${run}.xml`), parallel: workers });
    const second = plain?.second ?? await runBunTests({ files, cwd, root, junitFile: path.join(workDir, `baseline-${run}b.xml`), parallel: workers });
    const out = path.join(workDir, `parity-raw-${run}`);
    mkdirSync(out, { recursive: true });
    const recorderEnv = { DEVRYAN_CONFORMANCE_OUT: out, ...(clock ? { DEVRYAN_SCHEDULER_CONFORMANCE_CLOCK: clock } : {}), ...env };
    const recorded = await runBunTests({ files, cwd, root, preload: [recorder], env: recorderEnv, junitFile: path.join(workDir, `recorded-${run}.xml`), parallel: workers });
    const raws = readRaws(out);
    const judged = judgeParity({ run, baseline: baseline.junit, recorded: recorded.junit, raws, expectedFiles });
    const plainAgain = judgeParity({ run, baseline: baseline.junit, recorded: second.junit, raws: [], expectedFiles: [] });
    for (const difference of plainAgain.differences) judged.incomplete.push({ run, check: 'plain-unstable', file: difference.test, detail: `two plain runs disagree (${difference.check}: ${difference.baseline} then ${difference.recorded})` });
    const output = judgeOutput({ baselineOutput: baseline.output, secondBaselineOutput: second.output, recordedOutput: recorded.output });
    if (output.difference) judged.differences.push({ run, check: 'output', detail: output.difference });
    const count = (junit, status) => junit.filter((test) => test.status === status).length;
    results.push({
      run, files: new Set(baseline.junit.map((test) => test.file)).size, tests: baseline.junit.length,
      baselinePassed: count(baseline.junit, 'passed'), recordedPassed: count(recorded.junit, 'passed'),
      assertions: baseline.junit.reduce((sum, test) => sum + (test.assertions ?? 0), 0), recordedAssertions: recorded.junit.reduce((sum, test) => sum + (test.assertions ?? 0), 0),
      outputLines: outputLines(baseline.output).length, outputMasked: output.masked, varying: output.varying, differences: judged.differences, incomplete: judged.incomplete,
    });
    differences.push(...judged.differences);
    incomplete.push(...judged.incomplete);
  }
  return { runs: results, differences, incomplete };
}

/** The exit code of a parity result (design §4.8: 2 for anything inconclusive). */
export const parityExit = (result) => (result.differences.length ? EXIT.fail : result.incomplete.length ? EXIT.inconclusive : EXIT.pass);

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['keep-artifacts'], values: ['runs', 'cwd', 'clock', 'json'] });
  if (parsed.error) { console.error(`${parsed.error}\nusage: parity.mjs [--runs=N] [--cwd=<dir>] [--clock=nominal|real] [--json=<file>] [<test file>...]`); return EXIT.usage; }
  const { options, positionals } = parsed;
  const runs = Number(options.runs ?? 1);
  if (!Number.isInteger(runs) || runs < 1) { console.error('--runs must be a positive integer'); return EXIT.usage; }
  if (options.clock !== undefined && !['nominal', 'real'].includes(options.clock)) { console.error('--clock must be nominal or real'); return EXIT.usage; }
  const cwd = path.resolve(REPOSITORY_ROOT, options.cwd ?? 'packages/orchestration-runtime');
  const files = positionals.length ? positionals : schedulerTestFiles(cwd);
  const scratch = createScratch('scheduler-conformance-parity');
  let status = 'failed';
  try {
    const result = await schedulerParity({ files, cwd, runs, workDir: scratch.dir, clock: options.clock });
    for (const run of result.runs) {
      console.log(`run ${run.run}: ${run.files} files, ${run.tests} tests; passed ${run.baselinePassed} plain, ${run.recordedPassed} recorded; assertions ${run.assertions} plain, ${run.recordedAssertions} recorded; ${run.outputLines} output lines, ${run.outputMasked} left out as varying between plain runs (${run.varying.length} shapes); ${run.differences.length} differences, ${run.incomplete.length} inconclusive`);
      for (const shape of run.varying) console.log(`  varies without the recorder: ${shape}`);
      for (const difference of run.differences) console.log(difference.test ? `  differs (${difference.check}): ${difference.test} (plain ${difference.baseline}, recorded ${difference.recorded})` : `  differs (${difference.check}): ${difference.detail}`);
      for (const entry of run.incomplete) console.log(`  ${formatIncomplete(entry)}`);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
    const code = parityExit(result);
    status = code === EXIT.pass ? 'passed' : 'failed';
    console.log(`scheduler pass-set parity ${code === EXIT.pass ? `holds in ${runs} run${runs === 1 ? '' : 's'}` : code === EXIT.fail ? 'FAILED' : 'INCONCLUSIVE'}: ${result.differences.length} differences, ${result.incomplete.length} inconclusive`);
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
