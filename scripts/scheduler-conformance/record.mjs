#!/usr/bin/env node
// Records scheduler test files under the recorder (recorder.mjs) and judges
// the recording (design file 30 §4.1 recorder gates, §4.8 outcomes).
//
//   node scripts/scheduler-conformance/record.mjs [--runs=2] [--cwd=packages/orchestration-runtime]
//     [--clock=nominal|real] [--out=<new or empty dir>] [--json=<file>] [--allow-inconclusive=<file>] [--keep-artifacts] [<test file>...]
//
// Without test files it records the 21 `scheduler.*.test.js` files of the
// package. The files run once without the recorder and `--runs` times (at
// least 2) with it. The run fails (exit 1) when a test's outcome differs
// without the recorder (pass-set parity, by outcome; parity.mjs adds
// assertion counts and output). It is inconclusive (exit 2) when a named
// file built no scheduler, when nothing was recorded, when a case is
// unrecordable (a late effect after the recording was written, an accessor
// or foreign Proxy in a value, overlapping tests) or comes from a failing
// test, on any recorder error, when the recorder saw another number of tests
// than junit lists, and when a case's trace differs between two recordings
// (unstable). Exit 0 only for a complete run with nothing wrong or explicitly
// allowed: `--allow-inconclusive=<file>` names cases, each with its reason
// (a JSON list of `{ "case": "<case id>", "reason": "<why>" }`, design §4.8),
// whose unrecordable, failed or unstable outcome is printed `(allowed)` and
// does not count against the exit; an allowance that names no such case is
// itself inconclusive, so a stale one cannot hide. A case that keeps its
// outcome with a note (`mutated-by-receiver`) is printed as `info`. 64 for a
// usage error, and then nothing is written. The last line counts everything.
// Scratch lives in <os tmpdir>/devryan-scheduler-conformance and is removed on
// pass, failure and interruption (--keep-artifacts keeps it).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTestFiles, parseOptions, plainDifferences, runBunTests } from '../client-conformance/record.mjs';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { buildContainers, compareRecordings, EXIT, formatIncomplete, identifierOrder, outcomeLine, readRaws } from './trace.mjs';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(HARNESS_DIR, '../..');
export const PACKAGE_DIR = path.join(REPOSITORY_ROOT, 'packages/orchestration-runtime');
export const RECORDER = path.join(HARNESS_DIR, 'recorder.mjs');

/** The 21 scheduler test files (design §4.1 R1), relative to the package. */
export const schedulerTestFiles = (directory = PACKAGE_DIR) => readdirSync(directory)
  .filter((name) => /^scheduler\..+\.test\.js$/.test(name)).sort().map((name) => `./${name}`);

/** A scratch run root for one tool run (scripts/qa/run-root.mjs lifecycle). */
export const createScratch = (owner) => createRunRoot({ parent: scratchParent('scheduler-conformance'), prefix: 'run-', owner });

/**
 * Records `files` (relative to `cwd`) once plainly and `runs` times under the
 * recorder. Returns everything the judgement needs:
 * `{ files, expectedFiles, plain, recordings: [{ status, junit, raws, containers, incomplete, outcomes, cases }] }`.
 */
export async function recordFiles({ files, cwd = PACKAGE_DIR, runs = 2, workDir, recorder = RECORDER, root = REPOSITORY_ROOT, env = {}, parallel, clock, plainRun = true }) {
  const expectedFiles = discoverTestFiles(files, { cwd, root });
  const workers = parallel ?? Math.max(1, Math.min(files.length, 4));
  // The pass set without the recorder (`plainRun: false` skips it, for planted recorders judged by their traces alone).
  const plain = plainRun ? await runBunTests({ files, cwd, root, junitFile: path.join(workDir, 'plain.xml'), parallel: workers }) : null;
  const recordings = [];
  for (let run = 1; run <= runs; run += 1) {
    const out = path.join(workDir, `raw-${run}`);
    mkdirSync(out, { recursive: true });
    const recorderEnv = { DEVRYAN_CONFORMANCE_OUT: out, ...(clock ? { DEVRYAN_SCHEDULER_CONFORMANCE_CLOCK: clock } : {}), ...env };
    const result = await runBunTests({ files, cwd, root, preload: [recorder], env: recorderEnv, junitFile: path.join(workDir, `recorded-${run}.xml`), parallel: workers });
    const raws = readRaws(out);
    recordings.push({ run, harnessDir: path.dirname(recorder), status: result.status, junit: result.junit, junitError: result.junitError, output: result.output, raws, ...buildContainers({ raws, junit: result.junit, root, expectedFiles, harnessDir: path.dirname(recorder) }) });
  }
  return { files, expectedFiles, plain, recordings };
}

/**
 * Judges a recording (pure: the self-test feeds it fixed inputs). `allow`
 * lists `{ case, reason }`: a problem of that case (unrecordable, failed,
 * unstable) moves to `allowed`; an allowance that matches nothing is a
 * problem itself (`allowance-unused`). Returns
 * `{ code, differences, incomplete, unstable, allowed, info, outcomes }`.
 */
export function judgeRecording({ plain, recordings, allow = [] }) {
  const differences = [];
  const incomplete = [];
  const unstable = [];
  if (!plain) incomplete.push({ check: 'no-plain-run', detail: 'the files were not run without the recorder' });
  else if (plain.junitError) incomplete.push({ check: 'no-junit', detail: `the plain run: ${plain.junitError}` });
  for (const recording of recordings) {
    if (plain) for (const difference of plainDifferences(plain.junit, recording.junit)) differences.push({ run: recording.run, ...difference });
    for (const entry of recording.incomplete) incomplete.push({ run: recording.run, ...entry });
    if (recording.junitError) incomplete.push({ run: recording.run, check: 'no-junit', detail: recording.junitError });
    if (plain && recording.status !== 0 && plain.status === 0) incomplete.push({ run: recording.run, check: 'bun-exit', detail: `bun exited ${recording.status} under the recorder and 0 without it` });
  }
  if (recordings.length < 2) incomplete.push({ check: 'runs', detail: 'stability needs two recordings' });
  for (const later of recordings.slice(1)) for (const entry of compareRecordings(recordings[0].containers, later.containers)) unstable.push({ run: later.run, ...entry });
  // Allowances (design §4.8): per named case, with its reason; never for a file-level problem or a recorder error.
  const reasons = new Map(allow.map((entry) => [entry.case, entry.reason]));
  const allowed = [];
  const used = new Set();
  const keep = (entry, kind) => {
    if (!entry.case || !reasons.has(entry.case)) return true;
    used.add(entry.case);
    allowed.push({ ...entry, kind, reason: reasons.get(entry.case) });
    return false;
  };
  const open = incomplete.filter((entry) => keep(entry, entry.check));
  const shaky = unstable.filter((entry) => keep(entry, 'unstable'));
  for (const entry of allow) if (!used.has(entry.case)) open.push({ check: 'allowance-unused', case: entry.case, detail: `the allowance for ${entry.case} names no unrecordable, failed or unstable case` });
  const info = recordings[0]?.info ?? [];
  const outcomes = { ...(recordings[0]?.outcomes ?? {}), allowed: new Set(allowed.map((entry) => entry.case)).size };
  const code = differences.length ? EXIT.fail : open.length || shaky.length ? EXIT.inconclusive : EXIT.pass;
  return { code, differences, incomplete: open, unstable: shaky, allowed, info, outcomes };
}

/** Reads an allowance file: a JSON list of `{ case, reason }`, each reason a non-empty string. Returns `{ allow }` or `{ error }`. */
export function readAllowances(file) {
  let list;
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { error: `--allow-inconclusive=${file}: ${error.message}` }; }
  if (!Array.isArray(list) || list.some((entry) => entry === null || typeof entry !== 'object' || typeof entry.case !== 'string' || !entry.case || typeof entry.reason !== 'string' || !entry.reason.trim())) {
    return { error: `--allow-inconclusive=${file}: want a JSON list of { "case": "<case id>", "reason": "<why>" }, every reason given` };
  }
  return { allow: list.map((entry) => ({ case: entry.case, reason: entry.reason })) };
}

const USAGE = 'usage: record.mjs [--runs=N] [--cwd=<dir>] [--clock=nominal|real] [--out=<new or empty dir>] [--json=<file>] [--allow-inconclusive=<file>] [--keep-artifacts] [<test file>...]';

async function main(argv) {
  const parsed = parseOptions(argv, { flags: ['keep-artifacts'], values: ['runs', 'cwd', 'clock', 'out', 'json', 'allow-inconclusive'] });
  if (parsed.error) { console.error(`${parsed.error}\n${USAGE}`); return EXIT.usage; }
  const { options, positionals } = parsed;
  const runs = Number(options.runs ?? 2);
  if (!Number.isInteger(runs) || runs < 2) { console.error(`--runs must be an integer of at least 2\n${USAGE}`); return EXIT.usage; }
  if (options.clock !== undefined && !['nominal', 'real'].includes(options.clock)) { console.error(`--clock must be nominal or real\n${USAGE}`); return EXIT.usage; }
  const allowances = options['allow-inconclusive'] === undefined ? { allow: [] } : readAllowances(path.resolve(options['allow-inconclusive']));
  if (allowances.error) { console.error(`${allowances.error}\n${USAGE}`); return EXIT.usage; }
  const outDir = options.out && path.resolve(options.out);
  if (outDir && existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) { console.error(`--out=${options.out} must be a new or empty directory`); return EXIT.usage; }
  const cwd = path.resolve(REPOSITORY_ROOT, options.cwd ?? 'packages/orchestration-runtime');
  const files = positionals.length ? positionals : schedulerTestFiles(cwd);
  const scratch = createScratch('scheduler-conformance-record');
  let status = 'failed';
  try {
    const result = await recordFiles({ files, cwd, runs, workDir: scratch.dir, clock: options.clock });
    const judged = judgeRecording({ ...result, allow: allowances.allow });
    for (const difference of judged.differences) console.log(`differs (${difference.check}, run ${difference.run}): ${difference.detail}`);
    for (const entry of judged.incomplete) console.log(formatIncomplete(entry));
    for (const entry of judged.unstable) console.log(`unstable (run 1 against run ${entry.run}): ${entry.case}: ${entry.detail}`);
    for (const line of new Set(judged.allowed.map((entry) => `(allowed) ${entry.kind}: ${entry.case}: ${entry.reason}`))) console.log(line);
    for (const entry of judged.info) console.log(`info (${entry.note}) ${entry.file}: ${entry.detail}`);
    const first = result.recordings[0];
    const ids = identifierOrder(first.containers);
    for (const [site, entry] of Object.entries(ids)) console.log(`identifier order ${site}: ${entry.identifiers} identifiers, ${entry.pairs} pairs, ${entry.differing} ordered differently by code unit and by localeCompare('en')${entry.examples.length ? ` (${entry.examples.map((pair) => pair.join(' / ')).join('; ')})` : ''}`);
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      for (const container of first.containers) writeFileSync(path.join(outDir, container.name), container.text);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ outcomes: judged.outcomes, differences: judged.differences, incomplete: judged.incomplete, unstable: judged.unstable, allowed: judged.allowed, info: judged.info, identifiers: ids }, null, 2)}\n`);
    const tests = result.plain.junit.length;
    const verdict = judged.code === EXIT.pass ? 'complete' : judged.code === EXIT.fail ? 'FAILED' : 'INCONCLUSIVE';
    console.log(`scheduler recording ${verdict}: ${result.expectedFiles.length} files, ${tests} tests, ${runs} recordings; cases ${outcomeLine(judged.outcomes)}, ${judged.outcomes.allowed} allowed, ${judged.info.length} with a note; ${judged.unstable.length} unstable, ${judged.differences.length} differences, ${judged.incomplete.length} inconclusive${outDir ? `; containers in ${outDir}` : ''}`);
    status = judged.code === EXIT.pass ? 'passed' : 'failed';
    return judged.code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
