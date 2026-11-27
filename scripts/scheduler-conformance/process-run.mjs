// A scheduler in another process (plan package OR2, the Rust core) replayed
// under the conformance harness: every case of the containers given, or of
// the scenarios named (recorded once here), is replayed against the process
// through the process candidate (process-candidate.mjs) in OD2's read mode
// (`free`), with the replayer's checks, the comparer and its oracles, exactly
// as the JavaScript candidate is judged.
//
//   node scripts/scheduler-conformance/process-run.mjs --command=<binary> [--arg=<argument>]...
//        (--scenarios=<name,...> | --containers=<file or directory>,...) [--json=<file>] [--keep-artifacts]
//
// It prints each case's outcome, then per member of the scheduler (a member
// call or a control method a case makes) how many of the cases that touch it
// were reproduced whole, partial, different, not-ported or otherwise. Exit 0
// only when every case was judged and none was different (a case the process
// refused, `not-ported`, makes the run incomplete: exit 2, never 0); exit 1 on
// any difference or a failure of the process; 64 on a usage error.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordQuick } from './closure.mjs';
import { CandidateProcessError, processCandidate } from './process-candidate.mjs';
import { createScratch } from './record.mjs';
import { DEFAULT_MODE, installReplayHooks, loadCopy, loadReference, prepareCopy, replayCase } from './replay.mjs';
import { caseEvents, EXIT, readContainer } from './trace.mjs';

const MODE = Object.freeze({ ...DEFAULT_MODE, reads: 'free' });
const JUDGED = new Set(['reproduced', 'partial', 'crossed', 'unrecordable', 'empty']);

/** The members a recorded case touches: its member calls (`member`) and its control methods (`control.<method>`). */
export function touchedMembers(record) {
  if (record.outcome !== 'recorded') return [];
  const touched = new Set();
  for (const event of caseEvents(record)) {
    if (event.dir !== 'in') continue;
    if (event.kind === 'call' && event.call > 0) touched.add(event.member);
    if (event.kind === 'control') touched.add(`control.${event.method}`);
  }
  return [...touched].sort();
}

/** The run's judgement from its results: `{ code, counts, members }`. */
export function judgeProcessRun(results) {
  const counts = {};
  const members = {};
  for (const result of results) {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    for (const member of result.members ?? []) {
      members[member] ??= {};
      members[member][result.outcome] = (members[member][result.outcome] ?? 0) + 1;
    }
  }
  const different = results.some((result) => !JUDGED.has(result.outcome) && result.outcome !== 'not-ported' && result.outcome !== 'inconclusive');
  const incomplete = results.some((result) => result.outcome === 'not-ported' || result.outcome === 'inconclusive');
  const code = different ? EXIT.fail : incomplete || results.length === 0 || !counts.reproduced ? EXIT.inconclusive : EXIT.pass;
  return { code, counts, members };
}

export function containerFiles(list) {
  const files = [];
  for (const item of list) {
    if (statSync(item).isDirectory()) files.push(...readdirSync(item).filter((name) => name.endsWith('.ndjson')).sort().map((name) => path.join(item, name)));
    else files.push(item);
  }
  return files;
}

/** Replays every case of `files` against the process; one result per case. */
export async function runProcess({ files, copyDir, command, args = [] }) {
  installReplayHooks();
  const copy = await loadCopy(copyDir);
  const reference = await loadReference();
  const makeCandidate = processCandidate({ command, args });
  const results = [];
  for (const file of files) {
    const read = readContainer(readFileSync(file, 'utf8'));
    for (const record of read.cases) {
      let result;
      try {
        result = await replayCase({ record, resolve: read.resolve, header: read.header, copy, reference, makeCandidate, mode: MODE });
      } catch (error) {
        // The process did not start or speak the protocol: a failure, never a pass.
        if (!(error instanceof CandidateProcessError)) throw error;
        result = { outcome: 'different', check: 'candidate-process', detail: error.message, events: record.events };
      }
      results.push({ id: record.id, outcome: result.outcome, check: result.check ?? null, rule: result.rule ?? null, detail: result.detail ?? null, at: result.at ?? null, produced: result.produced ?? 0, events: result.events ?? 0, members: touchedMembers(record), compare: result.compare ? { verdict: result.compare.verdict, rules: result.compare.rules } : null });
    }
  }
  return results;
}

export function reportLines(results, judged) {
  const lines = results.map((result) => `${result.outcome.padEnd(13)} ${result.id}${result.outcome === 'reproduced' ? ` (${result.produced} events compared, comparer ${result.compare?.verdict ?? 'not run'})` : result.detail ? `: ${result.check ?? ''}${result.rule ? `/${result.rule}` : ''} at #${result.at ?? '?'} (${result.produced} events compared before): ${String(result.detail).slice(0, 300)}` : ''}`);
  lines.push('per member (cases that touch it, by outcome):');
  for (const [member, row] of Object.entries(judged.members).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`  ${member.padEnd(40)} ${Object.entries(row).map(([outcome, count]) => `${count} ${outcome}`).join(', ')}`);
  }
  lines.push(`process run: ${results.length} cases; ${Object.entries(judged.counts).map(([outcome, count]) => `${count} ${outcome}`).join(', ')}; exit ${judged.code}`);
  return lines;
}

async function main(argv) {
  const options = { arg: [] };
  for (const item of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(item);
    if (!match) { console.error(`process run: unknown argument ${item}`); return EXIT.usage; }
    if (match[1] === 'arg') options.arg.push(match[2] ?? '');
    else options[match[1]] = match[2] ?? true;
  }
  if (typeof options.command !== 'string' || (!options.scenarios && !options.containers)) {
    console.error('usage: node scripts/scheduler-conformance/process-run.mjs --command=<binary> [--arg=<argument>]... (--scenarios=<name,...> | --containers=<file or directory>,...) [--json=<file>] [--keep-artifacts]');
    return EXIT.usage;
  }
  const scratch = createScratch('scheduler-conformance-process-run');
  let code = EXIT.fail;
  try {
    let files;
    if (options.containers) files = containerFiles(String(options.containers).split(',').filter(Boolean));
    else {
      const recorded = await recordQuick({ workDir: scratch.dir, scenarios: String(options.scenarios).split(',').filter(Boolean) });
      if (recorded.problems.length) { console.error(`process run: the scenarios did not record: ${recorded.problems.join('; ')}`); return EXIT.inconclusive; }
      files = recorded.scenarios;
    }
    const copyDir = prepareCopy(scratch.dir);
    const results = await runProcess({ files, copyDir, command: path.resolve(options.command), args: options.arg });
    const judged = judgeProcessRun(results);
    for (const line of reportLines(results, judged)) console.log(line);
    if (typeof options.json === 'string') writeFileSync(options.json, `${JSON.stringify({ results, ...judged })}\n`);
    code = judged.code;
    return code;
  } finally {
    scratch.finish(code === EXIT.pass ? 'passed' : 'failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
