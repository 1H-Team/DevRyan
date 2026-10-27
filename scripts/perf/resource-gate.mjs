// No-regression resource gate over interleaved electron-resource-benchmark runs.
// Each input is one benchmark summary.json; run baseline and candidate packages
// alternately (B C C B ...) with identical options, then:
//
//   node scripts/perf/resource-gate.mjs --scenarios idle,twelve-stream \
//     --baseline <summary.json> --baseline <summary.json> --candidate <summary.json> --candidate <summary.json>
//
// Per scenario, across all runs of a side: reject median total-app CPU growth
// above max(5%, 1 percentage point), or median / p95 total working-set growth
// above max(5%, 16 MiB). Electron reports working sets in kilobytes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { median } from './electron-resource-benchmark.mjs';

export const RELATIVE_LIMIT = 0.05;
export const CPU_FLOOR_POINTS = 1;
export const WORKING_SET_FLOOR_KB = 16 * 1024;
const IDENTITY_KEYS = ['fixtureSha256', 'lifecycleProtocolSha256', 'startupMode', 'fixtureGeneration', 'warmupMs', 'measureMs', 'sampleIntervalMs'];
const METRICS = [
  { name: 'median total app CPU %', pick: 'medianTotalAppCpu', floor: CPU_FLOOR_POINTS },
  { name: 'median total working set', pick: 'medianTotalAppWorkingSet', floor: WORKING_SET_FLOOR_KB },
  { name: 'p95 total working set', pick: 'p95TotalAppWorkingSet', floor: WORKING_SET_FLOOR_KB },
];

function assertSide(summaries, label) {
  if (!Array.isArray(summaries) || summaries.length === 0) throw new Error(`resource_gate_${label}_required`);
  for (const summary of summaries) {
    if (summary?.schemaVersion !== 1 || summary.integrity?.passed !== true || summary.workloadError) throw new Error(`resource_gate_${label}_incomplete`);
  }
  if (new Set(summaries.map(summary => summary.packageEvidence?.archiveSha256 ?? null)).size !== 1 || !summaries[0].packageEvidence?.archiveSha256) {
    throw new Error(`resource_gate_${label}_package_changed`);
  }
}

/** Interleaving proof: by creation time, neither side runs more than twice in a row. */
export function assertInterleaved(baseline, candidate) {
  const order = [...baseline.map(summary => ({ side: 'B', at: Date.parse(summary.createdAt) })),
    ...candidate.map(summary => ({ side: 'C', at: Date.parse(summary.createdAt) }))];
  if (order.some(entry => !Number.isFinite(entry.at))) throw new Error('resource_gate_created_at_invalid');
  const sides = order.sort((left, right) => left.at - right.at).map(entry => entry.side).join('');
  if (/BBB|CCC/.test(sides)) throw new Error('resource_gate_not_interleaved');
  return sides;
}

export function compareResourceRuns({ baseline, candidate, scenarios }) {
  assertSide(baseline, 'baseline');
  assertSide(candidate, 'candidate');
  if (baseline.length !== candidate.length) throw new Error('resource_gate_unpaired');
  if (baseline[0].packageEvidence.archiveSha256 === candidate[0].packageEvidence.archiveSha256) throw new Error('resource_gate_same_package');
  const order = assertInterleaved(baseline, candidate);
  for (const key of IDENTITY_KEYS) {
    if (new Set([...baseline, ...candidate].map(summary => summary[key])).size !== 1) throw new Error(`resource_gate_${key}_mismatch`);
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('resource_gate_scenarios_required');
  const results = scenarios.map(scenario => {
    const runs = summaries => summaries.flatMap(summary => {
      const entry = summary.scenarios?.[scenario];
      if (!entry?.runs?.length) throw new Error(`resource_gate_${scenario}_missing`);
      return entry.runs.map(run => ({ ...run, chromium: JSON.stringify(entry.chromium) }));
    });
    const before = runs(baseline), after = runs(candidate);
    if (new Set([...before, ...after].map(run => run.chromium)).size !== 1) throw new Error(`resource_gate_${scenario}_chromium_mismatch`);
    const types = list => JSON.stringify([...new Set(list.flatMap(run => run.summary?.processTypes ?? []))].sort());
    if (types(before) === '[]' || types(before) !== types(after)) throw new Error(`resource_gate_${scenario}_process_tree_mismatch`);
    const checks = METRICS.map(({ name, pick, floor }) => {
      const value = list => median(list.map(run => run.summary?.[pick]));
      const baselineValue = value(before), candidateValue = value(after);
      if (!Number.isFinite(baselineValue) || !Number.isFinite(candidateValue)) return { name, baseline: baselineValue, candidate: candidateValue, passed: false, reason: 'unavailable' };
      const allowance = Math.max(RELATIVE_LIMIT * baselineValue, floor);
      return { name, baseline: baselineValue, candidate: candidateValue, growth: candidateValue - baselineValue, allowance,
        passed: candidateValue - baselineValue <= allowance };
    });
    return { scenario, runs: { baseline: before.length, candidate: after.length },
      concurrency: after.map(run => run.concurrency ?? null), checks, passed: checks.every(check => check.passed) };
  });
  return { schemaVersion: 1, order, pairs: baseline.length, scenarios: results, passed: results.every(result => result.passed) };
}


export function parseResourceGateArgs(argv) {
  const options = { baseline: [], candidate: [], scenarios: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--baseline') options.baseline.push(path.resolve(value));
    else if (flag === '--candidate') options.candidate.push(path.resolve(value));
    else if (flag === '--scenarios') options.scenarios = value.split(',').map(item => item.trim()).filter(Boolean);
    else throw new Error(`Unexpected option ${flag}`);
  }
  if (!options.baseline.length || !options.candidate.length || !options.scenarios.length) {
    throw new Error('Usage: node scripts/perf/resource-gate.mjs --scenarios <a,b> --baseline <summary.json>... --candidate <summary.json>...');
  }
  return options;
}

export async function main(argv) {
  const options = parseResourceGateArgs(argv);
  const read = async file => JSON.parse(await readFile(file, 'utf8'));
  const result = compareResourceRuns({ baseline: await Promise.all(options.baseline.map(read)),
    candidate: await Promise.all(options.candidate.map(read)), scenarios: options.scenarios });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : 'resource_gate_failed');
    process.exitCode = 1;
  });
}
