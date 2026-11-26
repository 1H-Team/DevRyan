#!/usr/bin/env node
// The closure check on the whole pilot with every planted difference (BH4 and
// the fix round of its review; docs/TESTING.md, "Backend route-group
// conformance harness"). Too heavy for a test file's CPU budget, so it is a
// command:
//
//   node scripts/test-isolation-guard.mjs node scripts/backend-conformance/closure-plants.mjs [--plant=<id>,...] [--keep-artifacts]
//
// 1. Every scenario of magic-prompts on R, R' and J: each row must be passed, or the open row named in
//    EXPECTED_OPEN with exactly its check.
// 2. Every plant of plants.mjs (the builder's 31, the review's 30, the fix round's 14) runs as the
//    candidate against its scenario's recordings and must do what its `expect` says: caught by its named
//    rule (or fault, at its step), or not caught for the stated reason (a limit, by design, equivalent,
//    unjudgeable).
// It prints one line per row mismatch and per plant, the limit of the candidate's observation, and a
// last line with every count. Exit 0: everything as expected; 1: a mismatch; 64: refused.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JS_CANDIDATE, runClosure } from './closure.mjs';
import { interruptTeardown } from './driver.mjs';
import { GROUPS } from './groups.mjs';
import { CANDIDATE_EFFECT_LIMIT } from './observe.mjs';
import { ALL_PLANTS, plantResult, plantedFiles } from './plants.mjs';
import { RunRefused, createBackendRun } from './run-scratch.mjs';
import { READS_AND_WRITES, REQUEST_FORMS, ROUTES_AND_FORMS, SCENARIOS } from './scenarios/magic-prompts.mjs';

const NAME = 'magic-prompts';
const GROUP = GROUPS[NAME];
const MANAGED = ['get-managed-admin', 'put-managed-admin', 'get-managed-developer', 'put-managed-developer', 'delete-managed-developer'];
/** The rows the closure cannot pass on the pilot, each with the one check that classifies it (every other row passes). */
export const EXPECTED_OPEN = new Map([
  ...MANAGED.map((id) => [`${READS_AND_WRITES.id}/${id}`, 'principal-unavailable']),
  ...['put-body-null', 'put-malformed-json', 'get-remote', 'put-remote'].map((id) => [`${READS_AND_WRITES.id}/${id}`, 'edge-exchange']),
  ...['put-charset-latin1', 'put-over-limit'].map((id) => [`${REQUEST_FORMS.id}/${id}`, 'edge-exchange']),
  ...['get-malformed-body', 'put-unknown-encoding', 'put-percent-malformed', 'delete-malformed-body', 'delete-percent-malformed', 'delete-remote', 'delete-all-malformed-body', 'delete-all-remote'].map((id) => [`${ROUTES_AND_FORMS.id}/${id}`, 'edge-exchange']),
  ...['options-collection', 'post-collection', 'options-item', 'patch-item', ...['get', 'put', 'delete', 'delete-all'].flatMap((name) => [`${name}-literal-encoded`, `${name}-empty-segment`])].map((id) => [`${ROUTES_AND_FORMS.id}/${id}`, 'tail-exchange']),
]);
const WORKERS = 3;

export async function main({ argv = process.argv.slice(2), log = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const only = argv.find((arg) => arg.startsWith('--plant='))?.slice('--plant='.length).split(',').filter(Boolean) ?? null;
  const unknown = argv.filter((arg) => !arg.startsWith('--plant=') && arg !== '--keep-artifacts');
  if (unknown.length) { error(`closure plants: unknown option ${unknown.join(' ')}\nusage: [--plant=<id>,...] [--keep-artifacts]`); return 64; }
  const plants = ALL_PLANTS.filter((plant) => !only || only.includes(plant.id));
  if (only && plants.length !== only.length) { error(`closure plants: no plant ${only.filter((id) => !plants.some((plant) => plant.id === id)).join(', ')}`); return 64; }
  let interrupted = null;
  let run;
  try { run = createBackendRun({ owner: 'backend-conformance-plants', keepArtifacts: argv.includes('--keep-artifacts'), onInterrupt: async (signal) => { interrupted = signal; log(`closure plants: interrupted by ${signal}; no summary is printed`); await interruptTeardown(); } }); } catch (failure) {
    if (failure instanceof RunRefused) { error(`closure plants: ${failure.message}`); return 64; }
    throw failure;
  }
  const say = (line) => { if (!interrupted) log(line); };
  let mismatches = 0;
  const base = new Map();
  const scenarios = only ? SCENARIOS.filter((scenario) => plants.some((plant) => plant.scenario === scenario.id)) : SCENARIOS;
  for (const scenario of scenarios) {
    const result = await runClosure({ run, scenario, name: NAME, group: GROUP });
    base.set(scenario.id, result);
    for (const row of result.rows) {
      const expected = EXPECTED_OPEN.get(row.id);
      const ok = expected ? row.outcome === 'inconclusive' && row.checks.length === 1 && row.checks[0] === expected : row.outcome === 'passed';
      if (!ok) { mismatches += 1; say(`ROW MISMATCH ${row.id}: ${row.outcome} (${row.checks.join(', ')}), expected ${expected ? `inconclusive (${expected})` : 'passed'}: ${row.reason}${[...row.differences, ...row.inconclusive].map((line) => `\n    ${line}`).join('')}`); }
    }
    say(`rows ${scenario.id}: ${result.rows.length} rows (${result.rows.filter((row) => row.outcome === 'passed').length} passed)`);
  }
  const table = [];
  const queue = [...plants];
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (let plant = queue.shift(); plant && !interrupted; plant = queue.shift()) {
      const { handlers, compose } = plantedFiles(run, plant);
      const scenario = SCENARIOS.find((item) => item.id === plant.scenario);
      const { recordings } = base.get(plant.scenario);
      let result;
      try {
        result = plantResult(plant, await runClosure({ run, scenario, name: NAME, group: GROUP, candidateCommand: [process.execPath, JS_CANDIDATE, '--group', NAME, '--handlers', handlers, ...(compose ? ['--compose', compose] : [])], candidateLabel: `planted-${plant.id}`, recordings: { reference: recordings.reference, second: recordings.second, js: recordings.js } }));
      } catch (failure) { result = { outcome: 'error', matches: false, by: String(failure?.message ?? failure).slice(0, 300), failedRows: 0, rules: '' }; }
      const asExpected = plant.expect === 'caught' ? result.matches : result.outcome === 'escaped';
      if (!asExpected) mismatches += 1;
      table.push({ plant, result, asExpected });
      say(`${asExpected ? '' : 'PLANT MISMATCH '}${result.outcome} ${plant.id} (${plant.origin}; expected ${plant.expect}): ${result.by ?? '-'}${plant.why ? ` | ${plant.why}` : ''} (${result.failedRows} failed rows; rules ${result.rules || 'none'})`);
    }
  }));
  if (interrupted) return 128;
  const count = (expect) => table.filter((row) => row.plant.expect === expect).length;
  const exchanges = [...base.values()].reduce((sum, { recordings }) => sum + (recordings.js?.observation?.exchanges ?? 0), 0);
  log(`LIMIT ${CANDIDATE_EFFECT_LIMIT.name} (${exchanges} candidate exchanges of J, and every exchange of each plant): ${CANDIDATE_EFFECT_LIMIT.text}`);
  const exit = mismatches ? 1 : 0;
  log(`closure plants: ${mismatches ? 'MISMATCH' : 'as expected'} (${[...base.values()].reduce((sum, { rows }) => sum + rows.length, 0)} rows; ${table.length} plants: ${table.filter((row) => row.plant.expect === 'caught' && row.asExpected).length} of ${count('caught')} caught by their rule, ${count('limit')} under the limit, ${count('by-design')} by design, ${count('equivalent')} equivalent, ${count('unjudgeable')} unjudgeable; ${mismatches} mismatches) exit ${exit}`);
  try { run.finish(exit === 0 ? 'passed' : 'failed'); } catch { /* finished */ }
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
  process.exit();
}
