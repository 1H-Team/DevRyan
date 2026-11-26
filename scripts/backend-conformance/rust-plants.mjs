#!/usr/bin/env node
// Planted behaviour changes in the Rust candidate of the pilot (BH6; docs/TESTING.md,
// "Backend route-group conformance harness"): each plant is one switch of the
// crate's test-only `plants` feature (its `--plant <id>`), run as the candidate
// against its scenario's R, R' and J recordings, and must do what its `expect`
// says: be caught by the named component and rule (or fault) at the named step,
// or escape for the stated reason. Too heavy for a test file, so it is a command:
//
//   (first, outside the guard: the Rust candidate's build command with --plants)
//   node scripts/test-isolation-guard.mjs node scripts/backend-conformance/rust-plants.mjs [--plant=<id>,...] [--keep-artifacts]
//
// The scenarios run once on R, R' and J (each row must be passed or the open row its scenario waives), and
// once on the unplanted Rust candidate (every row passed or open in the same way); then every plant. One
// line per row mismatch and per plant, and a last line with every count. Exit 0: everything as expected;
// 1: a mismatch; 64: refused (outside the guard, the binary missing or stale).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClosure } from './closure.mjs';
import { EXPECTED_OPEN } from './closure-plants.mjs';
import { interruptTeardown } from './driver.mjs';
import { GROUPS } from './groups.mjs';
import { plantResult } from './plants.mjs';
import { rustCandidateCommand } from './rust-candidate.mjs';
import { RunRefused, createBackendRun } from './run-scratch.mjs';
import { FILE_STATES, READS_AND_WRITES, REQUEST_FORMS, RESTARTS, ROUTES_AND_FORMS, SCENARIOS, TEXTS_AND_FILES, WRITE_LOCK, WRITE_ORDER } from './scenarios/magic-prompts.mjs';

const NAME = 'magic-prompts';
const GROUP = GROUPS[NAME];
const RW = READS_AND_WRITES.id;
const WL = WRITE_LOCK.id;
const RS = RESTARTS.id;
const RF = REQUEST_FORMS.id;
const RAF = ROUTES_AND_FORMS.id;
const FS = FILE_STATES.id;
const WO = WRITE_ORDER.id;
const TF = TEXTS_AND_FILES.id;
const NO_MKDIR = 'the data file\'s folder is the data root itself, which the harness makes and which also holds the reference\'s own edge files (its vault key): no data-root state the harness can make removes it, so the runtime\'s mkdir never has anything to make';
const ORDER = 'the order of different header names is the transport\'s framing, which the comparer does not compare (design §2.2; the comparer\'s header rule)';

/** Each plant: the `--plant` id of the crate (its plant switch list), its scenario, and what must happen. */
export const RUST_PLANTS = Object.freeze([
  { id: 'status-422', scenario: RW, step: 'put-id-161', component: 'status', rule: 'bytes' },
  { id: 'etag-dropped', scenario: RW, step: 'get-empty', component: 'headers.etag', rule: 'headers' },
  { id: 'headers-reordered', scenario: RW, expect: 'by-design', why: ORDER },
  { id: 'extra-header', scenario: RW, step: 'get-empty', component: 'headers.x-powered-by', rule: 'headers' },
  { id: 'content-type-no-charset', scenario: RW, step: 'get-empty', component: 'headers.content-type', rule: 'headers' },
  { id: 'version-string', scenario: RW, step: 'get-empty', component: 'body', rule: 'bytes' },
  { id: 'error-text', scenario: RW, step: 'put-text-number', component: 'body', rule: 'bytes' },
  { id: 'trailing-newline', scenario: RW, step: 'put-visible', component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
  { id: 'file-mode-600', scenario: RW, step: 'put-visible', component: 'tree.magic-prompts.json.mode', rule: 'inode' },
  { id: 'replaced-not-in-place', scenario: RW, step: 'put-replace', component: 'tree.magic-prompts.json.replaced', rule: 'inode' },
  { id: 'temporary-left-behind', scenario: RW, step: 'put-visible', component: 'tree.magic-prompts.json.tmp', rule: 'inode' },
  { id: 'missing-write', scenario: RW, step: 'put-visible', component: 'tree.magic-prompts.json', rule: 'inode' },
  { id: 'no-write-lock', scenario: WL, step: 'two-puts', component: 'concurrency(not admissible)', rule: 'concurrency' },
  { id: 'id-limit-159', scenario: RW, step: 'put-id-160', component: 'status', rule: 'bytes' },
  { id: 'text-limit-off-by-one', scenario: RW, step: 'put-text-200000', component: 'status', rule: 'bytes' },
  { id: 'lone-surrogate-rejected', scenario: RW, step: 'put-text-lone-surrogate', component: 'status', rule: 'bytes' },
  { id: 'stale-cache', scenario: RS, step: 'get-after-external', component: 'body', rule: 'bytes' },
  { id: 'answered-before-durable', scenario: RW, step: 'put-visible', component: 'tree.magic-prompts.json', rule: 'inode' },
  { id: 'rust-error-text', scenario: FS, step: 'put-directory', component: 'body', rule: 'bytes' },
  { id: 'duplicate-key-first-wins', scenario: RW, step: 'put-duplicate-keys', component: 'body', rule: 'bytes' },
  { id: 'case-sensitive-routes', scenario: RF, step: 'get-other-case', component: 'status', rule: 'bytes' },
  { id: 'never-not-modified', scenario: RF, step: 'get-if-none-match', component: 'status', rule: 'bytes' },
  { id: 'content-length-off-by-one', scenario: RW, step: 'get-empty', fault: 'response-incomplete' },
  { id: 'brotli-unsupported', scenario: RAF, step: 'put-brotli', component: 'status', rule: 'bytes' },
  { id: 'envelope-echoed', scenario: RW, step: 'get-empty', component: 'headers.x-devryan-harness-seq', rule: 'headers' },
  { id: 'head-with-body', scenario: RF, step: 'head', fault: 'response-trailing' },
  // Fix round 1: the order of writes the JavaScript gives timelines of bytes, and the review's plants that escaped (S7).
  { id: 'tickets-at-body-end', scenario: WO, step: 'unread-body-delete-all', component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
  { id: 'compressed-ticket-at-body-end', scenario: WO, step: 'compressed-and-plain', component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
  { id: 'accept-order', scenario: WO, step: 'readable-together', component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
  { id: 'get-waits-for-turn', scenario: WO, step: 'read-during-write', component: 'body', rule: 'bytes' },
  { id: 'no-trim-delete', scenario: TF, step: 'delete-id-space', component: 'status', rule: 'bytes' },
  { id: 'visible-ascii-trim', scenario: TF, step: 'put-visible-unicode-spaces', component: 'status', rule: 'bytes' },
  { id: 'length-in-utf8-bytes', scenario: TF, step: 'put-text-emoji-200000', component: 'status', rule: 'bytes' },
  { id: 'proto-kept-on-read', scenario: TF, step: 'get-proto-file', component: 'body', rule: 'bytes' },
  { id: 'read-bom-stripped', scenario: TF, step: 'get-bom-file', component: 'body', rule: 'bytes' },
  { id: 'gzip-first-member-only', scenario: TF, step: 'put-gzip-two-members', component: 'status', rule: 'bytes' },
  { id: 'no-mkdir', scenario: TF, expect: 'by-design', why: NO_MKDIR },
].map((plant) => ({ expect: 'caught', ...plant })));
if (new Set(RUST_PLANTS.map((plant) => plant.id)).size !== RUST_PLANTS.length) throw new Error('rust plants: an id is given twice');

const WORKERS = 3;

/** Whether a row is as the closure check expects it on the pilot: passed, or open with exactly its one check. */
const rowMismatch = (row) => {
  const expected = EXPECTED_OPEN.get(row.id);
  const ok = expected ? row.outcome === 'inconclusive' && row.checks.length === 1 && row.checks[0] === expected : row.outcome === 'passed';
  return ok ? null : `ROW MISMATCH ${row.id}: ${row.outcome} (${row.checks.join(', ')}), expected ${expected ? `inconclusive (${expected})` : 'passed'}: ${row.reason}${row.differences.map((line) => `\n    ${line}`).join('')}`;
};

export async function main({ argv = process.argv.slice(2), log = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const only = argv.find((arg) => arg.startsWith('--plant='))?.slice('--plant='.length).split(',').filter(Boolean) ?? null;
  const unknown = argv.filter((arg) => !arg.startsWith('--plant=') && arg !== '--keep-artifacts');
  if (unknown.length) { error(`rust plants: unknown option ${unknown.join(' ')}\nusage: [--plant=<id>,...] [--keep-artifacts]`); return 64; }
  const plants = RUST_PLANTS.filter((plant) => !only || only.includes(plant.id));
  if (only && plants.length !== only.length) { error(`rust plants: no plant ${only.filter((id) => !plants.some((plant) => plant.id === id)).join(', ')}`); return 64; }
  let interrupted = null;
  let run;
  let unplanted;
  try {
    unplanted = rustCandidateCommand({ plants: true });
    run = createBackendRun({ owner: 'backend-conformance-rust-plants', keepArtifacts: argv.includes('--keep-artifacts'), onInterrupt: async (signal) => { interrupted = signal; log(`rust plants: interrupted by ${signal}; no summary is printed`); await interruptTeardown(); } });
  } catch (failure) {
    if (failure instanceof RunRefused) { error(`rust plants: ${failure.message}`); return 64; }
    throw failure;
  }
  const say = (line) => { if (!interrupted) log(line); };
  let mismatches = 0;
  const base = new Map();
  const scenarios = only ? SCENARIOS.filter((scenario) => plants.some((plant) => plant.scenario === scenario.id)) : SCENARIOS;
  for (const scenario of scenarios) {
    // The plants build with no plant switched on must pass like the plain build: what a plant changes is all it changes.
    const result = await runClosure({ run, scenario, name: NAME, group: GROUP, candidateCommand: unplanted, candidateLabel: 'rust-unplanted' });
    base.set(scenario.id, result);
    for (const row of result.rows) { const line = rowMismatch(row); if (line) { mismatches += 1; say(line); } }
    say(`rows ${scenario.id}: ${result.rows.length} rows (${result.rows.filter((row) => row.outcome === 'passed').length} passed) on the unplanted Rust candidate`);
  }
  const table = [];
  const queue = [...plants];
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (let plant = queue.shift(); plant && !interrupted; plant = queue.shift()) {
      const scenario = SCENARIOS.find((item) => item.id === plant.scenario);
      const { recordings } = base.get(plant.scenario);
      let result;
      try {
        result = plantResult(plant, await runClosure({ run, scenario, name: NAME, group: GROUP, candidateCommand: [...unplanted, '--plant', plant.id], candidateLabel: `rust-planted-${plant.id}`, recordings: { reference: recordings.reference, second: recordings.second, js: recordings.js } }));
      } catch (failure) { result = { outcome: 'error', matches: false, by: String(failure?.message ?? failure).slice(0, 300), failedRows: 0, rules: '' }; }
      const asExpected = plant.expect === 'caught' ? result.matches : result.outcome === 'escaped';
      if (!asExpected) mismatches += 1;
      table.push({ plant, result, asExpected });
      say(`${asExpected ? '' : 'PLANT MISMATCH '}${result.outcome} ${plant.id} (expected ${plant.expect}${plant.step ? ` at ${plant.step}` : ''}): ${result.by ?? '-'}${plant.why ? ` | ${plant.why}` : ''} (${result.failedRows} failed rows; rules ${result.rules || 'none'})`);
    }
  }));
  if (interrupted) return 128;
  const exit = mismatches ? 1 : 0;
  const caught = table.filter((row) => row.plant.expect === 'caught');
  log(`rust plants: ${mismatches ? 'MISMATCH' : 'as expected'} (${[...base.values()].reduce((sum, { rows }) => sum + rows.length, 0)} rows; ${table.length} plants: ${caught.filter((row) => row.asExpected).length} of ${caught.length} caught by their named check, ${table.length - caught.length} escaping by design; ${mismatches} mismatches) exit ${exit}`);
  try { run.finish(exit === 0 ? 'passed' : 'failed'); } catch { /* finished */ }
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
  process.exit();
}
