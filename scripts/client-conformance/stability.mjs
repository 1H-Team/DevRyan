#!/usr/bin/env node
// Double-recording stability (design file 29 §2.5): record the same test
// files two or more times and compare every container byte for byte. A case
// whose bytes differ between recordings is unstable: it is reported with the
// check and the first differing path, and never counted as passed. Reordered
// cases or value tables are differences too.
//
//   node scripts/client-conformance/stability.mjs --toys [--runs=2]
//   node scripts/client-conformance/stability.mjs [--runs=2] [--cwd=<dir>] [--port-map=<file>] [--families=a,b] [--json=<file>] <test file>...
// Exit 0 when every case of a complete recording is stable, 2 when any case
// is unstable, 3 when a recording is inconclusive (nothing recorded, a file or
// a family missing, a test failed, an unrecordable case, bun exited with an
// error), 64 on a usage error (an unknown option included). An inconclusive
// recording wins over instability: its comparison proves nothing.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareContainers } from './compare.mjs';
import { createScratch, EXIT, formatDifference, formatIncomplete, parseOptions, recordOnce, recordToys, REPOSITORY_ROOT, requiredFamilies } from './record.mjs';

/**
 * Compares recordings (each a list of containers `{ name, text }`): returns
 * `{ cases, unstable, incomplete }`. `unstable` lists `{ run, container, case?,
 * check, step?, path?, expected?, actual?, detail? }`.
 */
export function compareRecordings(recordings) {
  const [first = [], ...rest] = recordings;
  const unstable = [];
  const incomplete = [];
  const named = (recording, run) => {
    const byName = new Map();
    for (const container of recording) {
      if (byName.has(container.name)) incomplete.push({ check: 'duplicate', detail: `recording ${run} has two containers named ${container.name}` });
      byName.set(container.name, container);
    }
    return byName;
  };
  named(first, 1);
  let cases = 0;
  for (const container of first) cases += container.text.split('\n').length - 3;
  rest.forEach((recording, index) => {
    const run = index + 2;
    const byName = named(recording, run);
    for (const container of first) {
      const other = byName.get(container.name);
      if (!other) { unstable.push({ run, container: container.name, check: 'container-set', detail: 'missing from this recording' }); continue; }
      if (other.text === container.text) continue;
      const found = compareContainers(container.text, other.text);
      for (const difference of found) unstable.push({ run, container: container.name, ...difference });
      if (found.length === 0) unstable.push({ run, container: container.name, check: 'bytes', detail: 'the bytes differ and no check names why' });
    }
    for (const container of recording) if (!first.some((entry) => entry.name === container.name)) unstable.push({ run, container: container.name, check: 'container-set', detail: 'only in this recording' });
  });
  if (cases === 0) incomplete.push({ check: 'empty', detail: 'no case was recorded: stability of nothing proves nothing' });
  return { cases, unstable, incomplete };
}

/** Records `runs` times with `recordRun(workDir)` and compares; returns `{ recordings, incomplete, cases, unstable }`. */
export async function checkStability({ runs = 2, workDir, recordRun }) {
  const recordings = [];
  const incomplete = [];
  let outcomes = null;
  for (let run = 1; run <= runs; run += 1) {
    const recording = await recordRun(path.join(workDir, `recording-${run}`));
    outcomes ??= recording.outcomes ?? null;
    for (const entry of recording.incomplete ?? []) incomplete.push({ ...entry, detail: `recording ${run}: ${entry.detail}` });
    if (recording.status !== 0 && !(recording.incomplete ?? []).some((entry) => entry.check === 'bun-exit')) {
      incomplete.push({ check: 'bun-exit', detail: `recording ${run}: bun exited ${recording.status}\n${String(recording.output ?? '').slice(-2000)}` });
    }
    recordings.push(recording.containers);
  }
  const compared = compareRecordings(recordings);
  return { recordings, incomplete: [...incomplete, ...compared.incomplete], cases: compared.cases, unstable: compared.unstable, outcomes };
}

/** The exit code of a stability result. */
export const stabilityExit = (result) => (result.incomplete.length ? EXIT.inconclusive : result.unstable.length ? EXIT.unstable : EXIT.pass);

async function main(argv) {
  const usage = 'usage: stability.mjs --toys [--runs=N] | [--runs=N] [--port-map=<file>] [--families=a,b] [--cwd=<dir>] [--json=<file>] <test file>...';
  const parsed = parseOptions(argv, { flags: ['toys', 'keep-artifacts'], values: ['runs', 'cwd', 'port-map', 'families', 'json'] });
  if (parsed.error) { console.error(`${parsed.error}\n${usage}`); return EXIT.usage; }
  const { options, positionals: files } = parsed;
  const option = (name) => options[name];
  const runs = Number(option('runs') ?? 2);
  if (!Number.isInteger(runs) || runs < 2) { console.error('--runs must be 2 or more'); return EXIT.usage; }
  if (options.toys ? files.length > 0 || option('port-map') || option('families') || option('cwd') : files.length === 0) { console.error(usage); return EXIT.usage; }
  const cwd = path.resolve(REPOSITORY_ROOT, option('cwd') ?? '.');
  const portMap = option('port-map') && path.resolve(option('port-map'));
  let families;
  try { families = requiredFamilies(portMap, option('families')?.split(',').filter(Boolean)); } catch (error) { console.error(error.message); return EXIT.usage; }
  const scratch = createScratch('client-conformance-stability');
  let status = 'failed';
  try {
    const recordRun = options.toys ? (workDir) => recordToys({ workDir }) : (workDir) => recordOnce({ files, cwd, portMap, families, workDir, plain: true });
    const result = await checkStability({ runs, workDir: scratch.dir, recordRun });
    for (const entry of result.incomplete) console.error(formatIncomplete(entry));
    for (const entry of result.unstable) console.log(`unstable (recording ${entry.run}): ${formatDifference(entry)}`);
    if (option('json')) writeFileSync(option('json'), `${JSON.stringify({ incomplete: result.incomplete, cases: result.cases, unstable: result.unstable }, null, 2)}\n`);
    const unstableCases = new Set(result.unstable.map((entry) => `${entry.container} ${entry.case ?? '(container)'}`)).size;
    const code = stabilityExit(result);
    const outcomes = result.outcomes ? ` (${result.outcomes.recorded} recorded, ${result.outcomes.unrecordable} unrecordable, ${result.outcomes.inconclusive} inconclusive)` : '';
    console.log(`${result.cases} cases${outcomes} recorded ${runs} times: ${result.cases - Math.min(result.cases, unstableCases)} stable, ${unstableCases} unstable${result.incomplete.length ? `; INCONCLUSIVE: ${result.incomplete.length} problems` : ''}`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
