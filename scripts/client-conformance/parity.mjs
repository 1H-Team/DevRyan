#!/usr/bin/env node
// Pass-set parity (design file 29 §2.7): for every test file, the tests that
// pass with the recorder must be the tests that pass without it, with the
// same number of assertions each, and the run must print the same lines.
// Each run executes the targets plainly twice and then under the recorder
// (recording into scratch, so encoding is exercised too). The two plain runs
// teach what varies without the recorder: an output line that differs
// between them gives its shape (digit runs as #), and only lines of a learned
// shape are left out of the comparison, and counted. Nothing is masked by a
// pattern: "retry in 500ms" against "retry in 1000ms" is a difference unless
// the plain runs already disagreed on that line.
//
//   node scripts/client-conformance/parity.mjs [--runs=3] [--cwd=packages/ui] [--port-map=<file>] [--layers=clock,random,...] [--json=<file>] <target>...
// Targets are what `bun test` takes (files or directories, relative to --cwd;
// default ./src/sync in packages/ui). Exit 0 when every run is complete and
// matches; 1 on a difference (a test whose outcome or assertion count differs,
// a line printed by one run only); 3 when a run is inconclusive (no tests, a
// test file missing from either run, a file the recorder left no recording
// for or recorded a different number of tests in, a recorder error); 64 on a
// usage error (an unknown option included).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bunTestWorkers } from '../test-runner-utils.mjs';
import { testKeys } from './junit.mjs';
import { createScratch, discoverTestFiles, EXIT, formatIncomplete, parseOptions, readRaws, REPOSITORY_ROOT, runBunTests } from './record.mjs';

const RECORDER = path.join(REPOSITORY_ROOT, 'scripts/client-conformance/recorder.mjs');

// What the test runner itself prints about timing and grouping is not test
// output: the time it took to run one test, appended to that test's result
// line, and the group markers it writes for a hosted runner's log. The first
// can be equal in two plain runs and differ in the third; the second depends
// on how the runner was started. Both are the runner's, at fixed places, and
// are dropped here; a duration inside a message a test prints is untouched.
const RESULT_LINE = /^(\((?:pass|fail|skip|todo)\) .*) \[[0-9]+(?:\.[0-9]+)?(?:ms|s)\]$/;
const RUNNER_MARKER = /^::(?:group|endgroup)::/;
/** Output lines, without colour, without the harness's own notes ([run-root], [client-conformance]) and without the runner's own timing and group markers. */
export function outputLines(output) {
  return String(output).replace(/\u001b\[[0-9;]*m/g, '').split('\n')
    .map((line) => line.trimEnd().replace(RESULT_LINE, '$1'))
    .filter((line) => line && !/^\[run-root\]/.test(line) && !/^\[client-conformance\]/.test(line) && !RUNNER_MARKER.test(line));
}
/** A line's shape: its digit runs as #. */
export const lineShape = (line) => line.replace(/[0-9]+/g, '#');
/** The shapes of the lines two plain runs disagree on: what varies without the recorder. */
export function learnVarying(firstPlain, secondPlain) {
  return new Set(multisetDifference(outputLines(firstPlain), outputLines(secondPlain)).map(([line]) => lineShape(line)));
}

function multisetDifference(left, right) {
  const counts = new Map();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of right) counts.set(line, (counts.get(line) ?? 0) - 1);
  return [...counts].filter(([, count]) => count !== 0);
}

/**
 * Judges one parity run from its parts (pure, so the self-test can feed it
 * fixed inputs). Returns `{ differences, incomplete }`: a difference is
 * `{ run, check, test?, baseline?, recorded?, detail? }`, an incomplete entry
 * `{ run, check, file?, detail }`.
 */
export function judgeParity({ run = 1, baseline, recorded, raws, expectedFiles = [], baselineOutput = '', secondBaselineOutput = baselineOutput, recordedOutput = '' }) {
  const differences = [];
  const incomplete = [];
  const byKey = (junit) => new Map(testKeys(junit).map((test) => [test.key, test]));
  const plain = byKey(baseline);
  const under = byKey(recorded);
  for (const key of new Set([...plain.keys(), ...under.keys()])) {
    const left = plain.get(key);
    const right = under.get(key);
    const leftStatus = left?.status ?? 'absent';
    const rightStatus = right?.status ?? 'absent';
    if ((leftStatus === 'passed') !== (rightStatus === 'passed') || leftStatus !== rightStatus) differences.push({ run, check: 'outcome', test: key, baseline: leftStatus, recorded: rightStatus });
    else if (left && right && left.assertions !== right.assertions) differences.push({ run, check: 'assertions', test: key, baseline: String(left.assertions), recorded: String(right.assertions) });
  }
  const filesOf = (map) => new Set([...map.values()].map((test) => test.file));
  const plainFiles = filesOf(plain);
  const recordedFiles = filesOf(under);
  if (plain.size === 0) incomplete.push({ run, check: 'no-tests', detail: 'the plain run reported no tests' });
  for (const file of new Set([...expectedFiles, ...plainFiles, ...recordedFiles])) {
    if (!plainFiles.has(file)) incomplete.push({ run, check: 'lost-file', file, detail: 'the plain run reported no test of this file' });
    if (!recordedFiles.has(file)) incomplete.push({ run, check: 'lost-file', file, detail: 'the recorded run reported no test of this file' });
  }
  const rawByFile = new Map(raws.map((raw) => [raw.file, raw]));
  for (const file of recordedFiles) {
    const raw = rawByFile.get(file);
    if (!raw) { incomplete.push({ run, check: 'no-recording', file, detail: 'the recorder left no recording (did the preload run to the end?)' }); continue; }
    const ran = [...under.values()].filter((test) => test.file === file && test.status !== 'skipped').length;
    const cases = raw.cases.filter((entry) => entry.kind === 'test').length;
    if (ran !== cases) incomplete.push({ run, check: 'count', file, detail: `junit lists ${ran} tests that ran, the recorder saw ${cases}` });
  }
  for (const raw of raws) for (const error of raw.errors) incomplete.push({ run, check: 'recorder-error', file: raw.file, detail: `recorder error: ${error}` });
  const varying = learnVarying(baselineOutput, secondBaselineOutput);
  let masked = 0;
  const kept = (output) => outputLines(output).filter((line) => { if (!varying.has(lineShape(line))) return true; masked += 1; return false; });
  const printed = multisetDifference(kept(baselineOutput), kept(recordedOutput));
  if (printed.length) differences.push({ run, check: 'output', detail: printed.slice(0, 8).map(([line, count]) => `${count > 0 ? 'plain only' : 'recorded only'} x${Math.abs(count)}: ${line}`).join(' | ') });
  return { differences, incomplete, masked, varying: [...varying] };
}

/**
 * Runs parity `runs` times. Returns `{ runs: [...], differences, incomplete }`.
 * `plain` (`{ first, second }`, runBunTests results) supplies the two plain
 * runs of the same files made elsewhere (the self-test shares them between
 * planted differences that leave the test files alone).
 */
export async function passSetParity({ targets, cwd, runs = 1, portMap, layers, recorder = RECORDER, root = REPOSITORY_ROOT, workDir, parallel = bunTestWorkers(), plain }) {
  const results = [];
  const differences = [];
  const incomplete = [];
  const expectedFiles = discoverTestFiles(targets, { cwd, root });
  for (let run = 1; run <= runs; run += 1) {
    const baselineRun = plain?.first ?? await runBunTests({ files: targets, cwd, root, junitFile: path.join(workDir, `baseline-${run}.xml`), parallel });
    // A second plain run: what differs between the two varies without the recorder.
    const secondRun = plain?.second ?? await runBunTests({ files: targets, cwd, root, junitFile: path.join(workDir, `baseline-${run}b.xml`), parallel });
    const out = path.join(workDir, `raw-${run}`);
    const env = { DEVRYAN_CONFORMANCE_OUT: out, ...(portMap ? { DEVRYAN_CONFORMANCE_PORT_MAP: portMap } : {}), ...(layers ? { DEVRYAN_CONFORMANCE_LAYERS: layers } : {}) };
    const recordedRun = await runBunTests({ files: targets, cwd, root, preload: [recorder], env, junitFile: path.join(workDir, `recorded-${run}.xml`), parallel });
    const raws = readRaws(out);
    const judged = judgeParity({ run, baseline: baselineRun.junit, recorded: recordedRun.junit, raws, expectedFiles, baselineOutput: baselineRun.output, secondBaselineOutput: secondRun.output, recordedOutput: recordedRun.output });
    // The two plain runs must agree on outcomes too, or the comparison with the recorded run proves nothing.
    const plainAgain = judgeParity({ run, baseline: baselineRun.junit, recorded: secondRun.junit, raws: [], expectedFiles: [] });
    for (const difference of plainAgain.differences.filter((entry) => entry.check !== 'output')) judged.incomplete.push({ run, check: 'plain-unstable', file: difference.test, detail: `two plain runs disagree (${difference.check}: ${difference.baseline} then ${difference.recorded})` });
    const count = (junit, status) => junit.filter((test) => test.status === status).length;
    results.push({
      run, files: new Set(baselineRun.junit.map((test) => test.file)).size, tests: baselineRun.junit.length, baselinePassed: count(baselineRun.junit, 'passed'), recordedPassed: count(recordedRun.junit, 'passed'),
      assertions: baselineRun.junit.reduce((sum, test) => sum + (test.assertions ?? 0), 0), recordedAssertions: recordedRun.junit.reduce((sum, test) => sum + (test.assertions ?? 0), 0),
      outputLines: outputLines(baselineRun.output).length, baselineExit: baselineRun.status, recordedExit: recordedRun.status, ...judged,
      outputMasked: judged.masked,
    });
    differences.push(...judged.differences);
    incomplete.push(...judged.incomplete);
  }
  return { runs: results, differences, incomplete };
}

/** The exit code of a parity result. */
export const parityExit = (result) => (result.incomplete.length ? EXIT.inconclusive : result.differences.length ? EXIT.fail : EXIT.pass);

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['keep-artifacts'], values: ['runs', 'cwd', 'port-map', 'layers', 'json'] });
  if (parsed.error) { console.error(`${parsed.error}\nusage: parity.mjs [--runs=N] [--cwd=<dir>] [--port-map=<file>] [--layers=a,b] [--json=<file>] <target>...`); return EXIT.usage; }
  const { options, positionals: targets } = parsed;
  const runs = Number(options.runs ?? 1);
  if (!Number.isInteger(runs) || runs < 1) { console.error('--runs must be a positive integer'); return EXIT.usage; }
  const cwd = path.resolve(REPOSITORY_ROOT, options.cwd ?? 'packages/ui');
  const scratch = createScratch('client-conformance-parity');
  let status = 'failed';
  try {
    const result = await passSetParity({ targets: targets.length ? targets : ['./src/sync'], cwd, runs, portMap: options['port-map'] && path.resolve(options['port-map']), layers: options.layers, workDir: scratch.dir });
    for (const run of result.runs) {
      console.log(`run ${run.run}: ${run.files} files, ${run.tests} tests; passed ${run.baselinePassed} plain, ${run.recordedPassed} recorded; assertions ${run.assertions} plain, ${run.recordedAssertions} recorded; ${run.outputLines} output lines, ${run.outputMasked} left out as varying between plain runs (${run.varying.length} shapes); ${run.differences.length} differences, ${run.incomplete.length} inconclusive`);
      for (const shape of run.varying) console.log(`  varies without the recorder: ${shape}`);
      for (const difference of run.differences) console.log(difference.test ? `  differs (${difference.check}): ${difference.test} (plain ${difference.baseline}, recorded ${difference.recorded})` : `  differs (${difference.check}): ${difference.detail}`);
      for (const entry of run.incomplete) console.log(`  ${formatIncomplete(entry)}`);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
    const code = parityExit(result);
    status = code === EXIT.pass ? 'passed' : 'failed';
    // Both counts, always: an inconclusive run may hide real differences above.
    console.log(`pass-set parity ${code === EXIT.pass ? `holds in ${runs} run${runs === 1 ? '' : 's'}` : code === EXIT.inconclusive ? 'INCONCLUSIVE' : 'FAILED'}: ${result.differences.length} differences, ${result.incomplete.length} inconclusive`);
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
