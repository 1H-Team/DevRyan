// Read-only execution-cost report for baseline QA runs. It summarizes the host's
// per-dispatch admission phase summaries from retained journals (journal every
// dispatch with DEVRYAN_EXECUTION_SUMMARY_MIN_MS=0) and, optionally, companion
// worker trace lines (DEVRYAN_EXECUTION_TRACE=1) from a captured runtime log.
// Worker trace lines carry no call identity, so concurrent workers can only be
// reported as time-since-worker-start at each milestone, not per-phase deltas.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 128 * 1024 * 1024;
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, totalMs: sorted.reduce((a, b) => a + b, 0),
    p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? null };
};

// `steps` is `phase:count/elapsedMs,...` (execution-admission.js formatSteps).
export const parseAdmissionSteps = (steps) => typeof steps !== 'string' ? [] : steps.split(',').flatMap((entry) => {
  const match = /^([a-z_]{1,64}):(\d{1,9})\/(\d{1,12})$/.exec(entry);
  return match ? [{ phase: match[1], count: Number(match[2]), elapsedMs: Number(match[3]) }] : [];
});
const WORKER_TRACE = /^worker ([a-z]{1,32}) (\d{1,9})ms$/;
export const parseWorkerTrace = (line) => {
  const match = WORKER_TRACE.exec(line.trim());
  return match ? { milestone: match[1], sinceStartMs: Number(match[2]) } : null;
};

export function createExecutionPhaseCollector() {
  const admissions = [], phases = new Map(), milestones = new Map();
  let failed = 0, gaps = 0;
  return {
    gap() { gaps++; },
    addJournalRecord(record) {
      const payload = record?.type === 'lifecycle' && record.event === 'session_execution' ? record.payload : null;
      if (payload?.phase !== 'admission' || !Number.isFinite(payload.elapsedMs)) return;
      if (payload.state === 'failed') failed++;
      admissions.push(payload.elapsedMs);
      for (const step of parseAdmissionSteps(payload.steps)) {
        const entry = phases.get(step.phase) ?? { calls: 0, perAdmissionMs: [] };
        entry.calls += step.count; entry.perAdmissionMs.push(step.elapsedMs);
        phases.set(step.phase, entry);
      }
    },
    addLogLine(line) {
      const trace = parseWorkerTrace(line);
      if (!trace) return;
      (milestones.get(trace.milestone) ?? milestones.set(trace.milestone, []).get(trace.milestone)).push(trace.sinceStartMs);
    },
    finish() {
      return { version: 1, source: 'retained-journal', coverage: { admissions: admissions.length, failed, gaps },
        admissionMs: distribution(admissions),
        phases: Object.fromEntries([...phases].sort(([a], [b]) => a.localeCompare(b))
          .map(([phase, entry]) => [phase, { calls: entry.calls, ...distribution(entry.perAdmissionMs) }])),
        workerMilestonesSinceStartMs: Object.fromEntries([...milestones].map(([name, values]) => [name, distribution(values)])),
        limitations: ['Admissions below the summary threshold are absent unless DEVRYAN_EXECUTION_SUMMARY_MIN_MS=0 was set for the run.',
          'Worker milestones are cumulative since worker start and are not attributed to calls.'] };
    },
  };
}

const lines = async function* (input) {
  const stat = await fs.lstat(input);
  if (stat.isSymbolicLink()) throw new Error('Execution phase report does not follow symlinks');
  if (stat.size > MAX_BYTES) { yield null; return; }
  const stream = createReadStream(input), decoded = input.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
  const reader = createInterface({ input: decoded, crlfDelay: Infinity });
  try { for await (const line of reader) yield line; }
  finally { reader.close(); decoded.destroy(); stream.destroy(); }
};

export async function readExecutionPhaseReport({ journals = [], logs = [] }) {
  const collector = createExecutionPhaseCollector();
  const visit = async (input) => {
    const stat = await fs.lstat(input);
    if (stat.isSymbolicLink()) throw new Error('Execution phase report does not follow symlinks');
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(input)).sort()) if (!name.endsWith('.blobs') && name !== 'blobs') await visit(path.join(input, name));
      return;
    }
    if (!/\.ndjson(?:\.gz)?$/.test(input)) return;
    for await (const line of lines(input)) {
      if (line === null) { collector.gap(); break; }
      if (!line.trim()) continue;
      try { collector.addJournalRecord(JSON.parse(line)); } catch { collector.gap(); }
    }
  };
  for (const input of journals) await visit(path.resolve(input));
  for (const input of logs) for await (const line of lines(path.resolve(input))) {
    if (line === null) { collector.gap(); break; }
    collector.addLogLine(line);
  }
  return collector.finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), journals = [], logs = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--log' && args[index + 1]) logs.push(args[++index]);
    else journals.push(args[index]);
  }
  if (!journals.length && !logs.length) throw new Error('Usage: node scripts/qa/execution-phase-report.mjs JOURNAL_DIR [--log RUNTIME_LOG]');
  console.log(JSON.stringify(await readExecutionPhaseReport({ journals, logs }), null, 2));
}
