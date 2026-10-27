#!/usr/bin/env node
// Per-tool harness overhead of the session mutation ledger, by phase: direct
// read receipts (admitDirect + finishDirect, as the host records built-in
// read/glob/grep/skill calls), a burst of parallel direct receipts arriving as
// separate requests, and a single-file confined edit (reserve, view
// preparation, claim, publication, execution receipt, cleanup). The ledger is
// seeded with production-shaped call history first, so per-lookup and
// per-commit costs reflect a large ledger. Everything runs on a synthetic
// repository and private storage under the OS scratch directory.
//
//   bun scripts/perf/tool-latency-benchmark.mjs [--runtime <harness-runtime/lib>] [--files 3000]
//     [--seed-calls 12000] [--reads 40] [--bursts 8] [--parallel 8] [--edits 12] [--writers 1]
//     [--host] [--count-git] [--out <report.json>] [--keep]
//
// `--writers N` runs the edits as N sessions editing in parallel (as parallel
// subagents do). Every edit's preparation reports its summary steps
// (`steps.<phase>` in ms, `units.<phase>` for counted steps such as
// view_copied), and `cpu` reports this process's CPU time per edit wave, so
// main-thread cost is visible next to wall time. `--host` runs the ledger
// through createSessionMutationHost (its worker thread under Node), so `cpu`
// separates process CPU (all threads) from the host event-loop busy time.
// `samples` pairs phase timings and file counts by call/writer/wave; nested
// subphase timings overlap and must not be added to their parent totals.
//
// `--runtime` points at another checkout's `packages/harness-runtime/lib`, so a
// baseline and a candidate run the same workload. `--count-git` puts a logging
// `git` shim first on PATH and reports Git spawns and ledger commits per call
// (the shim adds a few milliseconds per spawn, so timings from that run are
// not comparable with an uncounted run).
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRunRoot, scratchParent } from '../qa/run-root.mjs';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function parseToolLatencyArgs(argv) {
  const options = { runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'), files: 3000, seedCalls: 12_000,
    reads: 40, bursts: 8, parallel: 8, edits: 12, writers: 1, host: false, countGit: false, out: null, keep: false };
  const numbers = { '--files': 'files', '--seed-calls': 'seedCalls', '--reads': 'reads', '--bursts': 'bursts', '--parallel': 'parallel', '--edits': 'edits', '--writers': 'writers' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    if (flag === '--runtime') options.runtime = path.resolve(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--count-git') options.countGit = true;
    else if (flag === '--host') options.host = true;
    else if (flag === '--keep' || flag === '--keep-artifacts') options.keep = true;
    else if (numbers[flag]) options[numbers[flag]] = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const [flag, name] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 0 || options[name] > 200_000) throw new Error(`${flag} must be an integer from 0 to 200000`);
  }
  if (options.parallel < 1 || options.parallel > 64) throw new Error('--parallel must be an integer from 1 to 64');
  if (options.writers < 1 || options.writers > 8) throw new Error('--writers must be an integer from 1 to 8');
  return options;
}

export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p90: null, max: null };
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) };
}

const elapsed = async (rows, phase, fn) => {
  const started = performance.now();
  try { return await fn(); }
  finally { (rows[phase] ??= []).push(Math.round(performance.now() - started)); }
};

async function createRepository(directory, files) {
  await fs.mkdir(directory, { recursive: true });
  await execute('git', ['init', '--quiet', directory]);
  for (let index = 0; index < files; index += 1) {
    const folder = path.join(directory, `src${index % 23}`, `mod${index % 7}`);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `file${index}.ts`), `export const value${index} = ${index};\n`.repeat(4 + (index % 9)));
  }
  await execute('git', ['-C', directory, 'add', '-A']);
  await execute('git', ['-C', directory, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
}

// Writes a `git` shim that logs each invocation's arguments before running the
// real binary, and returns a reader for the log.
async function installGitCounter(root) {
  const real = (await execute('/usr/bin/env', ['which', 'git'])).stdout.trim();
  const bin = path.join(root, 'bin'), log = path.join(root, 'git.log');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  await fs.writeFile(log, '');
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  let offset = 0;
  return async () => {
    const text = (await fs.readFile(log, 'utf8')).slice(offset);
    offset += text.length;
    const lines = text.split('\n').filter(Boolean);
    return { spawns: lines.length, commits: lines.filter((line) => / update-ref refs\/devryan\/state /.test(line)).length };
  };
}

const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

export async function runToolLatencyBenchmark(options) {
  let runtime, completed = false;
  const originalPath = process.env.PATH;
  const run = createRunRoot({ parent: scratchParent('perf'), prefix: 'tool-latency-', owner: 'scripts/perf/tool-latency-benchmark.mjs',
    keepArtifacts: options.keep, onInterrupt: async () => { await runtime?.drain().catch(() => {}); await runtime?.close?.(); } });
  const root = run.dir;
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  try {
    const counter = options.countGit ? await installGitCounter(root) : null;
    await createRepository(directory, options.files);
    const { createSessionMutationRuntime } = await import(pathToFileURL(path.join(options.runtime, 'session-mutations.js')).href);
    const create = options.host ? (await import(pathToFileURL(path.join(options.runtime, 'session-mutation-host.js')).href)).createSessionMutationHost
      : createSessionMutationRuntime;
    const { withExecutionPreparation, withExecutionTiming } = await import(pathToFileURL(path.join(options.runtime, 'execution-admission.js')).href);
    runtime = create({ directory: storage, maintenance: { looseObjects: 1_000, packs: 12, commits: 64 } });
    const report = { files: options.files, seedCalls: options.seedCalls, writers: options.writers, host: options.host, phases: {}, steps: {}, units: {}, cpu: {}, git: {}, samples: [], waves: [] };
    const stepRows = {}, unitRows = {}, cpuRows = {};
    const started = performance.now();
    await runtime.warm({ directory, maxFiles: 20_000 });
    report.warmMs = Math.round(performance.now() - started);
    // Seed: groups of 64 concurrent direct receipts, eight per assistant step.
    const seedStarted = performance.now();
    for (let start = 0; start < options.seedCalls; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, options.seedCalls - start) }, async (_, offset) => {
        const index = start + offset, user = `seed-u${index % 5}-${Math.floor(index / 40)}`;
        const identity = { directory, sessionID: `seed-s${index % 5}`, userMessageID: user, messageID: `${user}-assistant`, callID: `seed-c${index}` };
        const { generation } = await runtime.admitDirect(identity);
        await runtime.finishDirect({ ...identity, token: randomUUID(), generation, executionFingerprint: fingerprint(identity.callID) });
      }));
    }
    report.seedMs = Math.round(performance.now() - seedStarted);
    await runtime.drain();
    const rows = report.phases, gitRows = {};
    const countGit = async (phase, fn) => {
      await counter?.();
      const value = await fn();
      if (counter) { const counted = await counter(); (gitRows[`${phase}.spawns`] ??= []).push(counted.spawns); (gitRows[`${phase}.commits`] ??= []).push(counted.commits); }
      return value;
    };
    const readCall = async (identity, phasePrefix) => {
      const { generation } = await elapsed(rows, `${phasePrefix}.admit`, () => runtime.admitDirect(identity));
      await fs.readFile(path.join(directory, 'src0', 'mod0', 'file0.ts'));
      await elapsed(rows, `${phasePrefix}.finish`, () => runtime.finishDirect({ ...identity, token: randomUUID(), generation,
        executionFingerprint: fingerprint(identity.callID) }));
    };
    const step = (index) => ({ directory, sessionID: 'bench', userMessageID: `bench-u${index}`, messageID: `bench-u${index}-assistant` });
    // One registered prompt per step, as the host registers each user message.
    for (let index = 0; index < options.reads; index += 1) {
      const identity = { ...step(`r${Math.floor(index / 8)}`), callID: `read-${index}` };
      await countGit('read', () => elapsed(rows, 'read.total', () => readCall(identity, 'read')));
    }
    for (let burst = 0; burst < options.bursts; burst += 1) {
      await countGit('parallel', () => elapsed(rows, 'parallel.wall', () => Promise.all(Array.from({ length: options.parallel }, async (_, call) => {
        // Separate requests: each arrives a couple of milliseconds after the previous one.
        await new Promise((resolve) => setTimeout(resolve, call * 2));
        await readCall({ ...step(`p${burst}`), callID: `burst-${burst}-${call}` }, 'parallel');
      }))));
    }
    // Preparation steps as the host journals them: `phase:count/ms` pairs.
    const collectSteps = (records, rootPhase, sample) => {
      const summary = records.find((record) => record.phase === rootPhase && record.state === 'completed');
      for (const step of String(summary?.steps ?? '').split(',').filter(Boolean)) {
        const [phase, value] = step.split(':'), [count, ms] = value.split('/').map(Number);
        const unit = ['view_copied', 'view_reused', 'object_verify_hashed', 'finish_files', 'finish_reused', 'finish_inspected', 'finish_touched'].includes(phase);
        const name = rootPhase === 'finish' ? `finish.${phase.replace(/^finish_/, '')}` : phase;
        sample.steps[name] = ms;
        if (!unit || ms > 0) (stepRows[name] ??= []).push(ms);
        if (unit) { (unitRows[name] ??= []).push(count); sample.units[name] = count; }
      }
    };
    const prepare = async (identity, sample) => {
      const records = [];
      const lease = await withExecutionPreparation(identity, () => runtime.begin(identity),
        { onDiagnostic: (record) => records.push(record), summary: { minMs: 0 } });
      collectSteps(records, 'preparation', sample);
      return lease;
    };
    const editOnce = async (index, writer) => {
      const identity = { ...step(`e${index}-w${writer}`), sessionID: `bench-w${writer}`, callID: `edit-${index}-${writer}` };
      const file = index * options.writers + writer, target = `src${file % 23}/mod${file % 7}/file${file % options.files}.ts`;
      const sample = { wave: index, writer, callID: identity.callID, phases: {}, steps: {}, units: {} };
      const measure = (phase, action) => elapsed(rows, phase, async () => {
        const started = performance.now();
        try { return await action(); } finally { sample.phases[phase] = Math.round(performance.now() - started); }
      });
      await measure('edit.total', async () => {
        const lease = await measure('edit.begin', () => prepare(identity, sample));
        await measure('edit.claim', () => runtime.claimLease({ directory, token: lease.token, kind: 'process' }));
        await fs.appendFile(path.join(lease.viewDirectory, target), `// edit ${index}\n`);
        await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
          JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
        const records = [];
        const result = await measure('edit.finish', () => withExecutionTiming(identity,
          () => runtime.finish({ directory, token: lease.token }), { phase: 'finish', minMs: 0, onDiagnostic: record => records.push(record) }));
        collectSteps(records, 'finish', sample);
        if (result.files?.[0]?.path !== target) throw new Error(`edit ${index} did not publish ${target}`);
        await measure('edit.receipt', async () => {
          const receipt = await runtime.executionReceipt({ directory, token: lease.token });
          for (const file of receipt.files) for (const side of [file.before, file.after]) if (side) for await (const _ of side.byteStream);
        });
        await measure('edit.cleanup', () => runtime.cleanupLease({ directory, token: lease.token }));
      });
      report.samples.push(sample);
    };
    for (let index = 0; index < options.edits; index += 1) {
      const cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
      await countGit('edit', () => elapsed(rows, 'edit.wave', () => Promise.all(Array.from({ length: options.writers }, (_, writer) => editOnce(index, writer)))));
      const used = process.cpuUsage(cpu), busy = performance.eventLoopUtilization(loop);
      // Process CPU counts every thread; the event loop's busy time is this
      // (the host's) thread only.
      (cpuRows['edit.wave.ms'] ??= []).push(Math.round((used.user + used.system) / 1000));
      (cpuRows['edit.wave.hostLoopBusyMs'] ??= []).push(Math.round(busy.active));
      report.waves.push({ wave: index, processCpuMs: Math.round((used.user + used.system) / 1000), hostLoopBusyMs: Math.round(busy.active) });
    }
    await runtime.drain();
    report.phases = Object.fromEntries(Object.entries(rows).map(([phase, values]) => [phase, summarize(values)]));
    report.git = Object.fromEntries(Object.entries(gitRows).map(([phase, values]) => [phase, summarize(values)]));
    report.steps = Object.fromEntries(Object.entries(stepRows).map(([phase, values]) => [phase, summarize(values)]));
    report.units = Object.fromEntries(Object.entries(unitRows).map(([phase, values]) => [phase, summarize(values)]));
    report.cpu = Object.fromEntries(Object.entries(cpuRows).map(([phase, values]) => [phase, summarize(values)]));
    completed = true;
    return report;
  } finally {
    try { await runtime?.drain().catch(() => {}); await runtime?.close?.(); }
    finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      run.finish(completed ? 'passed' : 'failed');
      if (run.keepArtifacts) process.stderr.write(`kept ${root}\n`);
    }
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseToolLatencyArgs(process.argv.slice(2));
  const report = await runToolLatencyBenchmark(options);
  const text = JSON.stringify(report, null, 2);
  if (options.out) await fs.writeFile(options.out, `${text}\n`);
  process.stdout.write(`${text}\n`);
}
