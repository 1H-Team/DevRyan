#!/usr/bin/env node
// Times the session mutation ledger on a real repository: the first confined
// call (which builds the ledger), warm confined calls and a control call.
// Each iteration uses a fresh clone and fresh ledger storage under the
// repository cache, so it never touches a user's project or runtime state.
//
//   node scripts/perf/ledger-benchmark.mjs [--repo <git repo>] [--runtime <harness-runtime/lib>]
//     [--iterations 3] [--warm-calls 3] [--prewarm] [--out <report.json>] [--keep]
//
// `--runtime` points at another checkout's `packages/harness-runtime/lib` so a
// frozen baseline and a candidate run the same workload. Kill-switch variables
// in the environment are passed through unchanged, for per-switch A/B runs.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function parseLedgerBenchmarkArgs(argv) {
  const options = { repo: repositoryRoot, runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'),
    iterations: 3, warmCalls: 3, prewarm: false, out: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    if (flag === '--repo') options.repo = path.resolve(value());
    else if (flag === '--runtime') options.runtime = path.resolve(value());
    else if (flag === '--iterations') options.iterations = Number(value());
    else if (flag === '--warm-calls') options.warmCalls = Number(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--prewarm') options.prewarm = true;
    else if (flag === '--keep') options.keep = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const [name, count] of [['--iterations', options.iterations], ['--warm-calls', options.warmCalls]]) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error(`${name} must be an integer from 1 to 50`);
  }
  return options;
}

export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, p50: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, min: sorted[0], p50, max: sorted.at(-1) };
}

const timed = async (fn) => {
  const cpu = process.cpuUsage(), started = performance.now();
  const value = await fn();
  const used = process.cpuUsage(cpu);
  return { value, ms: Math.round(performance.now() - started), cpuMs: Math.round((used.user + used.system) / 1000) };
};

async function processCall(runtime, directory, ids, edit) {
  const input = { directory, sessionID: ids.session, userMessageID: ids.user, messageID: `${ids.user}-assistant`, callID: ids.call };
  const begin = await timed(() => runtime.begin(input));
  const lease = begin.value;
  await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
  // A tool writes inside its view; publication then reconciles it.
  await fs.appendFile(path.join(lease.workingDirectory, edit), `\n// ledger benchmark ${ids.call}\n`);
  // The native launcher records confined termination beside the view; the
  // benchmark stands in for it, exactly as the runtime's own tests do.
  await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
    JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }));
  const finish = await timed(() => runtime.finish({ directory, token: lease.token }));
  const cleanup = await timed(() => runtime.cleanupLease({ directory, token: lease.token }));
  return { beginMs: begin.ms, beginCpuMs: begin.cpuMs, finishMs: finish.ms, finishCpuMs: finish.cpuMs, cleanupMs: cleanup.ms };
}

async function controlCall(runtime, directory, ids) {
  const input = { directory, sessionID: ids.session, userMessageID: ids.user, messageID: `${ids.user}-assistant`, callID: ids.call, kind: 'control' };
  const total = await timed(async () => {
    const lease = await runtime.begin(input);
    await runtime.claimLease({ directory, token: lease.token, kind: 'control' });
    await runtime.finish({ directory, token: lease.token });
    await runtime.cleanupLease({ directory, token: lease.token });
  });
  return { totalMs: total.ms };
}

async function trackedFileCount(directory) {
  const { stdout } = await execute('git', ['-C', directory, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean).length;
}

export async function runLedgerBenchmark(options) {
  const { createSessionMutationRuntime } = await import(pathToFileURL(path.join(options.runtime, 'session-mutations.js')).href);
  const benchRoot = path.join(repositoryRoot, '.cache/perf/ledger-bench');
  await fs.mkdir(benchRoot, { recursive: true });
  const iterations = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const root = await fs.mkdtemp(path.join(benchRoot, 'run-'));
    const project = path.join(root, 'project'), storage = path.join(root, 'ledger');
    try {
      // A shallow copy of the committed tree: the ledger sees tracked files
      // only, identical for every arm, and never the source's working state.
      await execute('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(options.repo).href, project], { maxBuffer: 16 * 1024 * 1024 });
      const files = await trackedFileCount(project);
      const edit = 'README.md';
      await fs.access(path.join(project, edit));
      const runtime = createSessionMutationRuntime({ directory: storage });
      let prewarmMs = null;
      if (options.prewarm) {
        if (typeof runtime.warm !== 'function') throw new Error('This runtime has no warm(); run without --prewarm');
        prewarmMs = (await timed(() => runtime.warm({ directory: project }))).ms;
      }
      const first = await processCall(runtime, project, { session: 's1', user: 'u0', call: 'c0' }, edit);
      const warm = [];
      for (let call = 1; call <= options.warmCalls; call += 1) {
        warm.push(await processCall(runtime, project, { session: 's1', user: `u${call}`, call: `c${call}` }, edit));
      }
      const control = await controlCall(runtime, project, { session: 's1', user: 'uc', call: 'cc' });
      iterations.push({ iteration, files, prewarmMs, first, warm, control, maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) });
      console.error(JSON.stringify({ iteration, files, prewarmMs, firstBeginMs: first.beginMs, firstFinishMs: first.finishMs,
        warmBeginMs: warm.map(row => row.beginMs), warmFinishMs: warm.map(row => row.finishMs), controlMs: control.totalMs }));
    } finally {
      if (!options.keep) await fs.rm(root, { recursive: true, force: true });
    }
  }
  const pick = (select) => summarize(iterations.flatMap(select));
  const switches = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^DEVRYAN_(LEDGER|LAZY|VIEW|EXECUTION)_/.test(key)).sort());
  return {
    version: 1, runtime: options.runtime, repo: options.repo, iterations: options.iterations, warmCalls: options.warmCalls,
    prewarm: options.prewarm, switches, platform: `${process.platform}-${process.arch}`, node: process.version,
    summary: {
      files: pick(row => [row.files]),
      prewarmMs: pick(row => [row.prewarmMs]),
      firstBeginMs: pick(row => [row.first.beginMs]), firstFinishMs: pick(row => [row.first.finishMs]),
      warmBeginMs: pick(row => row.warm.map(call => call.beginMs)), warmFinishMs: pick(row => row.warm.map(call => call.finishMs)),
      warmCleanupMs: pick(row => row.warm.map(call => call.cleanupMs)),
      controlMs: pick(row => [row.control.totalMs]), maxRssMiB: pick(row => [row.maxRssMiB]),
    },
    rows: iterations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseLedgerBenchmarkArgs(process.argv.slice(2));
  const report = await runLedgerBenchmark(options);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await fs.writeFile(options.out, text);
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
}
