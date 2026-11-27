#!/usr/bin/env node
// Planted behaviour changes in the Rust candidate of a group (BH6, BH7; docs/TESTING.md,
// "Backend route-group conformance harness"): each plant is one switch of the
// crate's test-only `plants` feature (its `--plant <id>`), run as the candidate
// against its scenario's R, R' and J recordings, and must do what its `expect`
// says: be caught by the named component and rule (or fault) at the named step,
// or escape for the stated reason. Too heavy for a test file, so it is a command:
//
//   (first, outside the guard: the Rust candidate's build command with --plants)
//   node scripts/test-isolation-guard.mjs node scripts/backend-conformance/rust-plants.mjs [--group=<name>] [--plant=<id>,...] [--keep-artifacts]
//
// (the group defaults to magic-prompts, the pilot.)
//
// The scenarios run once on R, R' and J (each row must be passed or the open row its scenario waives), and
// once on the unplanted Rust candidate (every row passed or open in the same way); then every plant. One
// line per row mismatch and per plant, and a last line with every count. Exit 0: everything as expected;
// 1: a mismatch; 64: refused (outside the guard, the binary missing or stale).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClosure } from './closure.mjs';
import { interruptTeardown } from './driver.mjs';
import { GROUPS } from './groups.mjs';
import { plantResult } from './plants.mjs';
import { rustCandidateCommand } from './rust-candidate.mjs';
import { RunRefused, createBackendRun } from './run-scratch.mjs';
import { FILE_STATES, READS_AND_WRITES, REQUEST_FORMS, RESTARTS, ROUTES_AND_FORMS, OVERLAPPING_WRITES, TEXTS_AND_FILES, UMASK, WRITE_LOCK, WRITE_ORDER } from './scenarios/magic-prompts.mjs';
import * as SF from './scenarios/session-folders.mjs';
import { SCENARIOS_BY_GROUP } from './scenario-rows.mjs';

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
  { id: 'no-write-lock-plain', scenario: OVERLAPPING_WRITES.id, step: 'overlapping-puts-1', component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
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
  // Fix round 1 of BH7 (S4): a mode the umask no longer gives; equal under 022, so judged under 027.
  { id: 'mode-fixed-644', scenario: UMASK.id, step: 'put-new', component: 'tree.magic-prompts.json.mode', rule: 'inode' },
].map((plant) => ({ expect: 'caught', ...plant })));

const SF_RW = SF.READS_AND_WRITES.id;
const SF_WO = SF.WRITE_ORDER.id;
const SF_RS = SF.RESTARTS.id;
const SF_FS = SF.FILE_STATES.id;
const SF_TF = SF.TEMPORARY_FILES.id;
const SF_RF = SF.REQUEST_FORMS.id;
const DOC = 'tree.sessions-directories.json';
const SF_OS = SF.OVERLAPPING_SAVES.id;
const SF_U027 = SF.UMASK_027.id;
const VECTORS = 'held by the crate\'s vectors instead: ROUTE_PLANT=<id> cargo test -p devryan-route-session-folders --features plants --test vectors fails';
/** The second group's plants: the shared request path's 14 switches on its scenarios, and its own. */
export const SESSION_FOLDERS_PLANTS = Object.freeze([
  { id: 'etag-dropped', scenario: SF_RW, step: 'get-empty', component: 'headers.etag', rule: 'headers' },
  { id: 'headers-reordered', scenario: SF_RW, expect: 'by-design', why: ORDER },
  { id: 'extra-header', scenario: SF_RW, step: 'get-empty', component: 'headers.x-powered-by', rule: 'headers' },
  { id: 'content-type-no-charset', scenario: SF_RW, step: 'get-empty', component: 'headers.content-type', rule: 'headers' },
  { id: 'duplicate-key-first-wins', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'never-not-modified', scenario: SF_RF, step: 'get-if-none-match', component: 'status', rule: 'bytes' },
  { id: 'content-length-off-by-one', scenario: SF_RW, step: 'get-empty', fault: 'response-incomplete' },
  { id: 'brotli-unsupported', scenario: SF_RF, step: 'post-brotli', component: 'status', rule: 'bytes' },
  { id: 'envelope-echoed', scenario: SF_RW, step: 'get-empty', component: 'headers.x-devryan-harness-seq', rule: 'headers' },
  { id: 'head-with-body', scenario: SF_RF, step: 'head', fault: 'response-trailing' },
  { id: 'tickets-at-body-end', scenario: SF_WO, step: 'unread-body-get', component: 'body', rule: 'bytes' },
  { id: 'compressed-ticket-at-body-end', scenario: SF_WO, step: 'compressed-and-plain', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'accept-order', scenario: SF_WO, step: 'readable-together', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'gzip-first-member-only', scenario: SF_RF, step: 'post-gzip-two-members', component: 'status', rule: 'bytes' },
  { id: 'status-422', scenario: SF_RW, step: 'post-array', component: 'status', rule: 'bytes' },
  { id: 'error-text', scenario: SF_RW, step: 'post-array', component: 'body', rule: 'bytes' },
  { id: 'limit-off-by-one', scenario: SF_RW, step: 'post-at-limit', component: 'status', rule: 'bytes' },
  { id: 'limit-in-utf16-units', scenario: SF_RW, step: 'post-over-limit-utf8', component: 'status', rule: 'bytes' },
  { id: 'trailing-newline', scenario: SF_RW, step: 'post-document', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'indent-4', scenario: SF_RW, step: 'post-document', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'file-mode-600', scenario: SF_RW, step: 'post-document', component: `${DOC}.mode`, rule: 'inode' },
  { id: 'written-in-place', scenario: SF_RW, step: 'post-replace', component: `${DOC}.replaced`, rule: 'inode' },
  { id: 'temporary-left-behind', scenario: SF_FS, step: 'post-directory', component: `${DOC}.tmp-`, rule: 'inode' },
  { id: 'temporary-name-without-pid', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'shared-temporary-name', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'no-cleanup', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp-`, rule: 'inode' },
  { id: 'cleanup-follows-links', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp-6-link`, rule: 'inode' },
  { id: 'cleanup-ignores-age', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp-2-fresh`, rule: 'inode' },
  { id: 'cleanup-after-write', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp-`, rule: 'inode' },
  { id: 'missing-write', scenario: SF_RW, step: 'post-document', component: DOC, rule: 'inode' },
  { id: 'answered-before-durable', scenario: SF_RW, step: 'post-document', component: DOC, rule: 'inode' },
  { id: 'get-waits-for-turn', scenario: SF_WO, step: 'read-during-write', component: 'body', rule: 'bytes' },
  { id: 'stale-cache', scenario: SF_RS, step: 'get-after-external', component: 'body', rule: 'bytes' },
  { id: 'case-sensitive-routes', scenario: SF_RF, step: 'get-other-case', component: 'status', rule: 'bytes' },
  { id: 'read-bom-stripped', scenario: SF_FS, step: 'get-bom-file', component: 'body', rule: 'bytes' },
  { id: 'replacement-per-byte', scenario: SF_FS, step: 'get-not-utf8-file', component: 'body', rule: 'bytes' },
  { id: 'lone-surrogate-raw', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'index-keys-in-place', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'duplicate-key-last-place', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'proto-dropped', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'negative-zero-kept', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rust-error-text', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'read-errors-as-empty', scenario: SF_FS, step: 'get-directory', component: 'body', rule: 'bytes' },
  { id: 'depth-limit-100', scenario: SF_FS, step: 'get-deep-ok', component: 'body', rule: 'bytes' },
  { id: 'form-holes-kept', scenario: SF_RF, step: 'post-form-shapes', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'empty-json-refused', scenario: SF_RW, step: 'post-empty-json', component: 'status', rule: 'bytes' },
  // The independent review's 42 plants (BH7 fix round 1), each with the row that catches it now, or why none can and
  // what holds it instead (VECTORS: tests/vectors.rs of the crate, run with the plants feature and ROUTE_PLANT).
  { id: 'rv-empty-doc-order', scenario: SF_RW, step: 'get-empty', component: 'headers.etag', rule: 'etag' },
  { id: 'rv-get-text-no-path', scenario: SF_FS, step: 'get-directory', component: 'body', rule: 'bytes' },
  { id: 'rv-get-loop-empty', scenario: SF_FS, step: 'get-link-loop', component: 'status', rule: 'bytes' },
  { id: 'rv-tmp-in-subdir', scenario: SF_RW, step: 'post-document', component: 'tree..tmp', rule: 'inode' },
  { id: 'rv-tmp-in-os-tmpdir', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'rv-mode-640', scenario: SF_RW, step: 'post-document', component: `${DOC}.mode`, rule: 'inode' },
  { id: 'rv-no-mkdir', scenario: SF_RW, expect: 'by-design', why: NO_MKDIR },
  { id: 'rv-cleanup-recurses', scenario: SF_TF, step: 'post-read-only-root', component: 'tree.folder', rule: 'inode' },
  { id: 'rv-cleanup-on-get', scenario: SF_TF, step: 'get-before', component: `${DOC}.tmp-`, rule: 'inode' },
  { id: 'rv-get-trailing-newline', scenario: SF_RW, step: 'get-after-post', component: 'headers.etag', rule: 'etag' },
  { id: 'rv-get-pretty', scenario: SF_RW, step: 'get-after-post', component: 'headers.etag', rule: 'etag' },
  { id: 'rv-get-non-object-empty', scenario: SF_FS, step: 'get-null-file', component: 'headers.etag', rule: 'etag' },
  { id: 'rv-get-raw-bytes', scenario: SF_RW, step: 'get-after-post', component: 'headers.etag', rule: 'etag' },
  { id: 'rv-post-accepts-array', scenario: SF_RW, step: 'post-array', component: 'status', rule: 'bytes' },
  { id: 'rv-size-before-type', scenario: SF_RW, step: 'post-array-over-limit', component: 'status', rule: 'bytes' },
  { id: 'rv-limit-ignores-newlines', scenario: SF_RW, step: 'post-form-over-limit', component: 'status', rule: 'bytes' },
  { id: 'rv-success-extra-key', scenario: SF_RW, step: 'post-document', component: 'headers.etag', rule: 'etag' },
  { id: 'rv-error-key-message', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'rv-no-save-lock', scenario: SF_OS, step: 'two-saves-1', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-rename-through-link', scenario: SF_FS, step: 'post-over-dangling-link', component: `${DOC}.type`, rule: 'inode' },
  { id: 'rv-rename-text-from-only', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'rv-uuid-v7', scenario: SF_FS, step: 'post-directory', component: 'body', rule: 'bytes' },
  { id: 'rv-uuid-constant', scenario: SF_FS, step: 'post-read-only-root', component: 'body', rule: 'bytes' },
  { id: 'rv-mode-fixed-644', scenario: SF_U027, step: 'post-new', component: `${DOC}.mode`, rule: 'inode' },
  { id: 'rv-cleanup-boundary-strict', scenario: SF_TF, expect: 'by-design', why: `the day boundary needs a clock both arms share; ${VECTORS} (cleanup.tsv: the files exactly a day before the clock)` },
  { id: 'rv-cleanup-continues', scenario: SF_TF, expect: 'by-design', why: 'a removal refused while a later one succeeds needs an unremovable file in a writable folder (an immutable flag), which neither a data-root state nor the vectors (an unprivileged scratch folder) can make; the JavaScript defect 6' },
  { id: 'rv-cleanup-removes-dirs', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp-3-stale-dir`, rule: 'inode' },
  { id: 'rv-cleanup-prefix-no-dash', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp`, rule: 'inode' },
  { id: 'rv-cleanup-uses-ctime', scenario: SF_TF, step: 'post-fails-after-cleaning', component: `${DOC}.tmp-`, rule: 'inode' },
  { id: 'rv-cleanup-any-file-prefix', scenario: SF_TF, step: 'post-fails-after-cleaning', component: 'tree.other.json.tmp-4-stale', rule: 'inode' },
  { id: 'rv-read-nofollow', scenario: SF_FS, step: 'get-dangling-link', component: 'status', rule: 'bytes' },
  { id: 'rv-escape-del', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-escape-2028', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-transcode-nested-number-raw', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-transcode-escape-raw', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-index-key-01', scenario: SF_RW, step: 'post-values-in-order', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-index-key-max', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-canonical-integer-any-length', scenario: SF_RW, step: 'post-values', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-form-number-coerce', scenario: SF_RF, step: 'post-form', component: `${DOC}.bytes`, rule: 'bytes' },
  { id: 'rv-bom-kept', scenario: SF_RF, step: 'post-utf16', component: 'status', rule: 'bytes' },
  { id: 'rv-param-limit-1001', scenario: SF_RF, expect: 'by-design', why: `1 001 parameters are refused by the edge (body-parser's 413 page), and an edge exchange is never sent to a candidate; ${VECTORS} (requests.tsv: 1 000 and 1 001 parameters, plain and gzip)` },
  { id: 'rv-chunk-ext-refused', scenario: SF_RF, step: 'post-chunked-extension', component: 'status', rule: 'bytes' },
].map((plant) => ({ expect: 'caught', ...plant })));

/** Each group's plant table. */
export const RUST_PLANTS_BY_GROUP = Object.freeze({ 'magic-prompts': RUST_PLANTS, 'session-folders': SESSION_FOLDERS_PLANTS });
for (const [group, table] of Object.entries(RUST_PLANTS_BY_GROUP)) if (new Set(table.map((plant) => plant.id)).size !== table.length) throw new Error(`rust plants: an id of ${group} is given twice`);

/** The rows a group's scenarios leave open, each with its one check (their waivers). */
export const expectedOpen = (scenarios) => new Map(scenarios.flatMap((scenario) => Object.entries(scenario.waivers ?? {}).filter(([, waiver]) => (waiver.checks ?? []).length === 1).map(([step, waiver]) => [`${scenario.id}/${step}`, waiver.checks[0]])));

// One planted candidate at a time: each closure run starts four processes (the machine's rule for heavy work).
const WORKERS = 1;

/** Whether a row is as the closure check expects it: passed, or open with exactly its one check. */
const rowMismatch = (row, open) => {
  const expected = open.get(row.id);
  const ok = expected ? row.outcome === 'inconclusive' && row.checks.length === 1 && row.checks[0] === expected : row.outcome === 'passed';
  return ok ? null : `ROW MISMATCH ${row.id}: ${row.outcome} (${row.checks.join(', ')}), expected ${expected ? `inconclusive (${expected})` : 'passed'}: ${row.reason}${row.differences.map((line) => `\n    ${line}`).join('')}`;
};

export async function main({ argv = process.argv.slice(2), log = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const only = argv.find((arg) => arg.startsWith('--plant='))?.slice('--plant='.length).split(',').filter(Boolean) ?? null;
  const NAME = argv.find((arg) => arg.startsWith('--group='))?.slice('--group='.length) ?? 'magic-prompts';
  const unknown = argv.filter((arg) => !arg.startsWith('--plant=') && !arg.startsWith('--group=') && arg !== '--keep-artifacts');
  if (unknown.length) { error(`rust plants: unknown option ${unknown.join(' ')}\nusage: [--group=<name>] [--plant=<id>,...] [--keep-artifacts]`); return 64; }
  if (!Object.hasOwn(RUST_PLANTS_BY_GROUP, NAME)) { error(`rust plants: no plants for group ${NAME} (known: ${Object.keys(RUST_PLANTS_BY_GROUP).join(', ')})`); return 64; }
  const GROUP = GROUPS[NAME];
  const SCENARIOS = SCENARIOS_BY_GROUP[NAME];
  const open = expectedOpen(SCENARIOS);
  const plants = RUST_PLANTS_BY_GROUP[NAME].filter((plant) => !only || only.includes(plant.id));
  if (only && plants.length !== only.length) { error(`rust plants: no plant ${only.filter((id) => !plants.some((plant) => plant.id === id)).join(', ')}`); return 64; }
  let interrupted = null;
  let run;
  let unplanted;
  try {
    unplanted = rustCandidateCommand({ plants: true, group: NAME });
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
    for (const row of result.rows) { const line = rowMismatch(row, open); if (line) { mismatches += 1; say(line); } }
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
