// Paired no-regression gate for the streaming reducer benchmark. Runs the
// benchmark from two checkouts (a baseline worktree and the candidate) in
// alternating order on the same Bun, then compares each scenario's reported
// p95Ms (p95 of 50 samples, each a 100-event batch average per event).
//
//   bun scripts/perf/reducer-comparison.mjs --baseline <checkout> [--candidate <checkout>] [--pairs 10] [--output <file>]
//
// Per scenario: B = baseline median p95Ms, D = its median absolute deviation,
// allowance = max(5% x B, 3 x D). An allowance above 15% x B is too noisy to
// qualify. Otherwise a candidate median above B + allowance is a regression.
// Fewer than ten pairs is a smoke run and never qualifies.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const BENCHMARK = 'scripts/perf/streaming-reducer-benchmark.mjs';
export const RELATIVE_ALLOWANCE = 0.05;
export const NOISE_MULTIPLIER = 3;
export const NOISE_CEILING = 0.15;
/** Fewer pairs are a smoke run: per-scenario verdicts are reported, the overall verdict never qualifies. */
export const REQUIRED_PAIRS = 10;

export const median = values => {
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export const medianAbsoluteDeviation = values => {
  const center = median(values);
  return median(values.map(value => Math.abs(value - center)));
};
const scenarioKey = scenario => `${scenario.sessionCount}x${scenario.historySize}:${scenario.kind}`;

function assertReports(reports, label) {
  if (!Array.isArray(reports) || reports.length < 2) throw new Error(`reducer_comparison_${label}_runs_required`);
  for (const report of reports) {
    if (report?.schemaVersion !== 1 || !Array.isArray(report.scenarios) || report.scenarios.length === 0) throw new Error(`reducer_comparison_${label}_report_invalid`);
    if (!report.scenarios.every(scenario => Number.isFinite(scenario.p95Ms) && scenario.p95Ms >= 0)) throw new Error(`reducer_comparison_${label}_timing_invalid`);
  }
  for (const key of ['revision', 'reducerSha256', 'runtime']) {
    if (new Set(reports.map(report => report[key])).size !== 1) throw new Error(`reducer_comparison_${label}_${key}_changed`);
  }
}

/** Pure gate over already collected baseline and candidate benchmark reports. */
export function compareReducerReports(baselineReports, candidateReports, { requiredPairs = REQUIRED_PAIRS } = {}) {
  assertReports(baselineReports, 'baseline');
  assertReports(candidateReports, 'candidate');
  if (baselineReports.length !== candidateReports.length) throw new Error('reducer_comparison_unpaired');
  if (baselineReports[0].runtime !== candidateReports[0].runtime) throw new Error('reducer_comparison_runtime_mismatch');
  const keys = report => report.scenarios.map(scenarioKey).join(',');
  const expected = keys(baselineReports[0]);
  if (![...baselineReports, ...candidateReports].every(report => keys(report) === expected)) throw new Error('reducer_comparison_scenarios_mismatch');
  const series = (reports, index) => reports.map(report => report.scenarios[index].p95Ms);
  const scenarios = baselineReports[0].scenarios.map((scenario, index) => {
    const baseline = series(baselineReports, index), candidate = series(candidateReports, index);
    const baselineMedian = median(baseline), deviation = medianAbsoluteDeviation(baseline), candidateMedian = median(candidate);
    const allowance = Math.max(RELATIVE_ALLOWANCE * baselineMedian, NOISE_MULTIPLIER * deviation);
    const verdict = allowance > NOISE_CEILING * baselineMedian ? 'too-noisy'
      : candidateMedian > baselineMedian + allowance ? 'regressed' : 'passed';
    return { scenario: scenarioKey(scenario), baselineMedianP95Ms: baselineMedian, baselineMadMs: deviation,
      allowanceMs: allowance, candidateMedianP95Ms: candidateMedian, deltaMs: candidateMedian - baselineMedian, verdict };
  });
  const verdict = baselineReports.length < requiredPairs ? 'unqualified'
    : scenarios.some(row => row.verdict === 'regressed') ? 'regressed'
      : scenarios.some(row => row.verdict === 'too-noisy') ? 'unqualified' : 'passed';
  return { schemaVersion: 1, verdict, pairs: baselineReports.length, requiredPairs, runtime: baselineReports[0].runtime,
    baseline: { revision: baselineReports[0].revision, reducerSha256: baselineReports[0].reducerSha256 },
    candidate: { revision: candidateReports[0].revision, reducerSha256: candidateReports[0].reducerSha256 },
    scope: 'reducer only; excludes rendering, network, and provider latency', scenarios };
}

export function parseReducerComparisonArgs(argv) {
  const options = { candidate: repository, pairs: 10 };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--baseline') options.baseline = path.resolve(value);
    else if (flag === '--candidate') options.candidate = path.resolve(value);
    else if (flag === '--output') options.output = path.resolve(value);
    else if (flag === '--pairs' && /^[1-9]\d*$/.test(value) && Number(value) >= 2) options.pairs = Number(value);
    else throw new Error(`Unexpected option ${flag}`);
  }
  if (!options.baseline) throw new Error('Usage: bun scripts/perf/reducer-comparison.mjs --baseline <checkout> [--candidate <checkout>] [--pairs 10] [--output <file>]');
  if (options.baseline === options.candidate) throw new Error('Baseline and candidate must be different checkouts');
  for (const checkout of [options.baseline, options.candidate]) {
    if (!existsSync(path.join(checkout, BENCHMARK))) throw new Error(`No reducer benchmark in ${checkout}`);
  }
  return options;
}

const runBenchmark = checkout => JSON.parse(execFileSync('bun', [BENCHMARK], { cwd: checkout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));

export async function main(argv) {
  const options = parseReducerComparisonArgs(argv);
  const baseline = [], candidate = [];
  for (let pair = 0; pair < options.pairs; pair += 1) {
    // Alternate which side runs first so warm-machine drift does not favour one side.
    const order = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const side of order) {
      process.stderr.write(`[reducer-comparison] pair ${pair + 1}/${options.pairs} ${side}\n`);
      (side === 'baseline' ? baseline : candidate).push(runBenchmark(options[side]));
    }
  }
  const result = compareReducerReports(baseline, candidate);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, text, { mode: 0o600 });
  }
  process.stdout.write(text);
  return result.verdict === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : 'reducer_comparison_failed');
    process.exitCode = 1;
  });
}
