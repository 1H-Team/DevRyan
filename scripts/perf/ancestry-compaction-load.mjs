#!/usr/bin/env node
// Measures one session's ledger calls while maintenance compacts another
// document's stored-closure ancestry (session-mutations.js `compactAncestry`).
// A hot file replays the mutation-ancestry-replay fixture through the ledger;
// its document is then rewritten as a host before direct ancestry stored it
// (every run's closure, in unfenced format 1 rows). A second session runs
// confined calls (begin, publish, cleanup) on another file, first alone and
// then while one maintenance pass compacts, and a probe records how late a
// 10 ms timer fires on the ledger's event loop. Scratch lives under the OS
// temp dir and is removed on success, failure and interruption.
//
//   node scripts/perf/ancestry-compaction-load.mjs [--runtime <harness-runtime/lib>] [--edits 70] [--blocks 40] [--seed 0]
//     [--baseline-calls 10] [--label <text>] [--out <report.json>] [--max-p99-ms 250] [--max-lateness-ms 250] [--keep-artifacts]
//   The run is a gate: it exits 1 when, during the pass, the p99 of a direct
//   (read-only tool) admission, its finish or a lease cleanup, or the timer
//   lateness, exceeds its bound, or the pass leaves the document unreduced or
//   its text changed. Confined begin and publish times are reported, not
//   gated: beside the bloated document they are slow before compaction too.
//   The ledger starts as an upgraded one does: baseline compaction already
//   stamped, ancestry not yet compacted. Percentiles are nearest-rank.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { initGitRepository } from '../test-git-template.mjs';
import { benchmarkIdentity, createReplayFixture } from './mutation-ancestry-replay.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const HOT = 'AppointmentDetailView.test.tsx', OTHER = 'other.ts';
const CALL_KINDS = ['admitMs', 'finishDirectMs', 'beginMs', 'finishMs', 'cleanupMs'];
const GATED_KINDS = ['admitMs', 'finishDirectMs', 'cleanupMs'];

export function parseCompactionLoadArgs(argv) {
  const options = { runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'), edits: 70, blocks: 40, seed: 0, baselineCalls: 10,
    label: null, out: null, maxP99Ms: 250, maxLatenessMs: 250, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    if (flag === '--runtime') options.runtime = path.resolve(value());
    else if (flag === '--edits') options.edits = Number(value());
    else if (flag === '--blocks') options.blocks = Number(value());
    else if (flag === '--seed') options.seed = Number(value());
    else if (flag === '--baseline-calls') options.baselineCalls = Number(value());
    else if (flag === '--label') options.label = value();
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--max-p99-ms') options.maxP99Ms = Number(value());
    else if (flag === '--max-lateness-ms') options.maxLatenessMs = Number(value());
    else if (flag === '--keep-artifacts') options.keep = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isSafeInteger(options.edits) || options.edits < 1 || options.edits > 500) throw new Error('--edits must be an integer from 1 to 500');
  if (!Number.isSafeInteger(options.blocks) || options.blocks < 8 || options.blocks > 400) throw new Error('--blocks must be an integer from 8 to 400');
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 1_000_000) throw new Error('--seed must be an integer from 0 to 1000000');
  if (!Number.isSafeInteger(options.baselineCalls) || options.baselineCalls < 1 || options.baselineCalls > 1000) {
    throw new Error('--baseline-calls must be an integer from 1 to 1000');
  }
  for (const [name, bound] of [['--max-p99-ms', options.maxP99Ms], ['--max-lateness-ms', options.maxLatenessMs]]) {
    if (!Number.isFinite(bound) || bound <= 0) throw new Error(`${name} must be a positive number`);
  }
  return options;
}

// Nearest-rank percentiles, in ms.
export function latencySummary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, p50: null, p99: null, max: null };
  const rank = (quantile) => sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
  return { count: sorted.length, p50: rank(0.5), p99: rank(0.99), max: sorted.at(-1) };
}

export function gateCompactionLoad({ during, latenessMs, ancestry, textUnchanged }, { maxP99Ms, maxLatenessMs }) {
  const failures = [];
  if (!during.cleanupMs.count) failures.push('no call completed during compaction');
  for (const kind of GATED_KINDS) if (during[kind].p99 !== null && during[kind].p99 > maxP99Ms) failures.push(`${kind} p99 ${during[kind].p99} ms > ${maxP99Ms} ms`);
  if (latenessMs.max !== null && latenessMs.max > maxLatenessMs) failures.push(`timer lateness ${latenessMs.max} ms > ${maxLatenessMs} ms`);
  if (!(ancestry.after < ancestry.before) || !ancestry.fenced) failures.push(`ancestry not compacted (${ancestry.before} -> ${ancestry.after} entries)`);
  if (!textUnchanged) failures.push('the compacted document projects different text');
  return { passed: failures.length === 0, failures };
}

const round = (ms) => Math.round(ms * 10) / 10;
const timed = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - started) };
};

// A read-only tool's direct receipt, as the host records it (ledger-benchmark.mjs `seedDirectCalls`).
async function directCall(runtime, directory, ids) {
  const identity = { directory, sessionID: ids.session, userMessageID: ids.user, messageID: `${ids.user}-assistant`, callID: `${ids.call}-read` };
  const admit = await timed(() => runtime.admitDirect(identity));
  const finish = await timed(() => runtime.finishDirect({ ...identity, token: randomUUID(), generation: admit.value.generation,
    executionFingerprint: createHash('sha256').update(identity.callID).digest('hex') }));
  return { admitMs: admit.ms, finishDirectMs: finish.ms };
}

// One confined shell call, as the host drives it (ledger-benchmark.mjs `processCall`).
async function confinedCall(runtime, directory, ids, file, text) {
  const input = { directory, sessionID: ids.session, userMessageID: ids.user, messageID: `${ids.user}-assistant`, callID: ids.call };
  const begin = await timed(() => runtime.begin(input));
  const lease = begin.value;
  await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
  await fs.writeFile(path.join(lease.viewDirectory, file), text);
  // The native launcher records confined termination beside the view.
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
  const finish = await timed(() => runtime.finish({ directory, token: lease.token }));
  const cleanup = await timed(() => runtime.cleanupLease({ directory, token: lease.token }));
  return { beginMs: begin.ms, finishMs: finish.ms, cleanupMs: cleanup.ms };
}

// How late a 10 ms timer fires (and when, from `origin`), sampled until stopped.
function timerProbe(origin) {
  const late = [];
  let expected = performance.now() + 10, timer = null;
  const tick = () => {
    const now = performance.now();
    late.push({ at: round(expected - origin), ms: round(Math.max(0, now - expected)) });
    expected = now + 10; timer = setTimeout(tick, 10);
  };
  timer = setTimeout(tick, 10);
  return () => { clearTimeout(timer); return late; };
}

async function hotDocument(store, root) {
  const db = await store.openChangeStore(root, path.join(root, 'git'));
  let id = null;
  for await (const { value } of db.entries('files')) if (value.published?.path === HOT) id = value.id;
  if (!id) throw new Error(`no ledger document for ${HOT}`);
  const pages = [];
  for await (const { value } of db.entries(`runs/${id}`)) pages.push(value);
  const fenced = pages[0]?.format === 'ancestry';
  const runs = store.decodeMutationRunRows(pages.slice(fenced ? 1 : 0).flat());
  return { db, id, runs, fenced, entries: runs.reduce((sum, run) => sum + run.replaces.length, 0) };
}

// Rewrites the hot document as a host before direct ancestry stored it.
async function plantStoredClosures(store, root) {
  const { db, id, runs } = await hotDocument(store, root);
  const byId = new Map();
  for (const run of runs) { const same = byId.get(run.id); if (same) same.push(run); else byId.set(run.id, [run]); }
  const closures = new Map();
  const closure = (list) => {
    if (closures.has(list)) return closures.get(list);
    const seen = new Map();
    const visit = (range) => {
      const key = `${range.id}:${range.start}:${range.length}`;
      if (seen.has(key)) return;
      seen.set(key, range);
      for (const run of byId.get(range.id) ?? []) {
        if (run.start >= range.start && run.start < range.start + range.length) for (const ancestor of run.replaces) visit(ancestor);
      }
    };
    for (const range of list) visit(range);
    closures.set(list, [...seen.values()]);
    return closures.get(list);
  };
  let entries = 0, bytes = 0;
  const rows = runs.flatMap(({ text, ...metadata }) => Array.from({ length: Math.ceil(text.length / 32_768) }, (_, chunk) => {
    const row = { ...metadata, replaces: closure(metadata.replaces), start: metadata.start + chunk * 32_768,
      bytes: Buffer.from(text.slice(chunk * 32_768, (chunk + 1) * 32_768), 'latin1').toString('base64') };
    entries += row.replaces.length; bytes += Buffer.byteLength(JSON.stringify(row));
    return row;
  }));
  await db.setList(`runs/${id}`, rows);
  await db.commit();
  return { entries, rowBytes: bytes };
}

export async function runCompactionLoad(options) {
  const moduleFile = path.join(options.runtime, 'session-mutations.js'), textFile = path.join(options.runtime, 'session-mutation-text.js');
  const { createSessionMutationRuntime } = await import(pathToFileURL(moduleFile).href);
  const { changeKey, openChangeStore } = await import(pathToFileURL(path.join(options.runtime, 'session-changes-store.js')).href);
  const { decodeMutationRunRows, mutationText } = await import(pathToFileURL(textFile).href);
  const store = { openChangeStore, decodeMutationRunRows };
  const run = createRunRoot({ parent: scratchParent('perf'), prefix: 'ancestry-compaction-', owner: 'scripts/perf/ancestry-compaction-load.mjs',
    keepArtifacts: options.keep, extraPayloads: ['project', 'ledger'] });
  const project = path.join(run.dir, 'project'), storage = path.join(run.dir, 'ledger');
  let runtime = null, completed = false;
  // A loaded machine slows every phase alike; the report says how loaded it was.
  const loadAverage = { start: os.loadavg().map((value) => Math.round(value * 10) / 10), end: null };
  try {
    await initGitRepository(project);
    const fixture = createReplayFixture(options);
    const initial = fixture.render();
    await fs.writeFile(path.join(project, HOT), initial, 'latin1');
    await fs.writeFile(path.join(project, OTHER), 'export const value = 0;\n');
    const diagnostics = [], locks = [];
    let origin = performance.now();
    // Maintenance runs only when measured: a pass during setup would find
    // nothing to reduce yet and stamp the ledger done.
    runtime = createSessionMutationRuntime({ directory: storage, maintenance: { commits: Number.POSITIVE_INFINITY },
      onDiagnostic: (record) => diagnostics.push(record),
      onLockTiming: (timing) => locks.push({ at: round(performance.now() - origin), operation: timing.operation, queueMs: timing.queueMs,
        waitMs: timing.waitMs, holdMs: timing.holdMs, failed: timing.failed }) });
    for (let edit = 1; edit <= options.edits; edit += 1) {
      fixture.edit(edit);
      await confinedCall(runtime, project, { session: 'writer', user: `w${edit}`, call: `w${edit}-call` }, HOT, fixture.render());
    }
    const expectedText = fixture.render();
    const root = path.join(storage, changeKey(await fs.realpath(project)));
    // An upgraded ledger: earlier maintenance stamped its baseline compaction;
    // the ancestry pass has not run.
    await runtime.maintainLedger({ directory: project });
    await fs.rm(path.join(root, 'ancestry-compacted'), { force: true });
    const planted = await plantStoredClosures(store, root);
    const call = async (prefix, index) => {
      const ids = { session: 'other', user: `${prefix}${index}`, call: `${prefix}${index}-call` };
      return { ...await directCall(runtime, project, ids), ...await confinedCall(runtime, project, ids, OTHER, `export const value = '${prefix}${index}';\n`) };
    };
    const alone = [];
    const stopAlone = timerProbe(performance.now());
    for (let index = 0; index < options.baselineCalls; index += 1) alone.push(await call('a', index));
    const lateAlone = stopAlone();
    origin = performance.now();
    const stop = timerProbe(origin), firstLock = locks.length;
    let settled = false;
    const pass = runtime.maintainLedger({ directory: project }).finally(() => { settled = true; });
    const during = [];
    for (let index = 0; !settled; index += 1) during.push({ at: round(performance.now() - origin), ...await call('d', index) });
    await pass;
    const passMs = round(performance.now() - origin);
    const late = stop(), passLocks = locks.slice(firstLock);
    const afterCalls = [];
    const stopAfter = timerProbe(performance.now());
    for (let index = 0; index < options.baselineCalls; index += 1) afterCalls.push(await call('z', index));
    const lateAfter = stopAfter();
    const after = await hotDocument(store, root);
    const ancestry = { before: planted.entries, plantedRowBytes: planted.rowBytes, after: after.entries, fenced: after.fenced,
      stamped: await fs.access(path.join(root, 'ancestry-compacted')).then(() => true, () => false),
      compactionMs: diagnostics.find((record) => record.phase === 'ledger_ancestry_compaction' && record.state === 'completed')?.elapsedMs ?? null,
      failures: diagnostics.filter((record) => record.phase === 'ledger_ancestry_compaction' && record.state === 'failed').map((record) => record.code) };
    const textUnchanged = mutationText(after.runs) === expectedText;
    const summary = (rows) => Object.fromEntries(CALL_KINDS.map((kind) => [kind, latencySummary(rows.map((row) => row[kind]))]));
    const result = { alone: summary(alone), during: summary(during), after: summary(afterCalls), latenessMs: latencySummary(late.map((sample) => sample.ms)),
      latenessAloneMs: latencySummary(lateAlone.map((sample) => sample.ms)), latenessAfterMs: latencySummary(lateAfter.map((sample) => sample.ms)),
      ancestry, textUnchanged, passMs };
    loadAverage.end = os.loadavg().map((value) => Math.round(value * 10) / 10);
    const identity = await benchmarkIdentity(options, moduleFile, initial);
    identity.runtime.textModuleSha256 = createHash('sha256').update(await fs.readFile(textFile)).digest('hex');
    completed = true;
    return { version: 1, identity, loadAverage, edits: options.edits, ...result, gate: gateCompactionLoad(result, options), calls: { alone, during, after: afterCalls },
      // Pass timeline: every lock taken while it ran and every timer fired 50 ms or more late.
      timeline: { locks: passLocks, lateTimers: late.filter((sample) => sample.ms >= 50) } };
  } finally {
    // Background ledger work settles before the project and ledger go.
    await runtime?.drain().catch(() => { /* Best effort: the run's own error, if any, is what propagates. */ });
    if (run.keepArtifacts) run.finish(completed ? 'passed' : 'failed');
    else { await fs.rm(run.dir, { recursive: true, force: true }); run.dispose(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCompactionLoadArgs(process.argv.slice(2));
  const report = await runCompactionLoad(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await fs.writeFile(options.out, json); else process.stdout.write(json);
  const { during, latenessMs, ancestry, gate } = report;
  console.error(`ancestry-compaction-load: ${ancestry.before} -> ${ancestry.after} entries in ${ancestry.compactionMs} ms; during compaction `
    + `admit p99 ${during.admitMs.p99} ms, direct finish p99 ${during.finishDirectMs.p99} ms, cleanup p99 ${during.cleanupMs.p99} ms, `
    + `begin p99 ${during.beginMs.p99} ms, publish p99 ${during.finishMs.p99} ms (${during.cleanupMs.count} calls), `
    + `timer lateness max ${latenessMs.max} ms, load average ${report.loadAverage.start[0]} -> ${report.loadAverage.end[0]} on ${report.identity.machine.cpus} CPUs`
    + `${gate.passed ? '' : ` — FAILED: ${gate.failures.join('; ')}`}`);
  if (!gate.passed) process.exitCode = 1;
}
