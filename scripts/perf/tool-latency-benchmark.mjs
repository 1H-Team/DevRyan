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
//     [--seed-calls 12000] [--reads 40] [--bursts 8] [--parallel 8] [--edits 12] [--count-git] [--out <report.json>] [--keep]
//
// `--runtime` points at another checkout's `packages/harness-runtime/lib`, so a
// baseline and a candidate run the same workload. `--count-git` puts a logging
// `git` shim first on PATH and reports Git spawns and ledger commits per call
// (the shim adds a few milliseconds per spawn, so timings from that run are
// not comparable with an uncounted run).
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function parseToolLatencyArgs(argv) {
  const options = { runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'), files: 3000, seedCalls: 12_000,
    reads: 40, bursts: 8, parallel: 8, edits: 12, countGit: false, out: null, keep: false };
  const numbers = { '--files': 'files', '--seed-calls': 'seedCalls', '--reads': 'reads', '--bursts': 'bursts', '--parallel': 'parallel', '--edits': 'edits' };
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
    else if (flag === '--keep' || flag === '--keep-artifacts') options.keep = true;
    else if (numbers[flag]) options[numbers[flag]] = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const [flag, name] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 0 || options[name] > 200_000) throw new Error(`${flag} must be an integer from 0 to 200000`);
  }
  if (options.parallel < 1 || options.parallel > 64) throw new Error('--parallel must be an integer from 1 to 64');
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-tool-latency-'));
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  const counter = options.countGit ? await installGitCounter(root) : null;
  try {
    await createRepository(directory, options.files);
    const { createSessionMutationRuntime } = await import(pathToFileURL(path.join(options.runtime, 'session-mutations.js')).href);
    const runtime = createSessionMutationRuntime({ directory: storage, maintenance: { looseObjects: 1_000, packs: 12, commits: 64 } });
    const report = { files: options.files, seedCalls: options.seedCalls, phases: {}, git: {} };
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
    for (let index = 0; index < options.edits; index += 1) {
      const identity = { ...step(`e${index}`), callID: `edit-${index}` }, target = `src${index % 23}/mod${index % 7}/file${index}.ts`;
      await countGit('edit', () => elapsed(rows, 'edit.total', async () => {
        const lease = await elapsed(rows, 'edit.begin', () => runtime.begin(identity));
        await elapsed(rows, 'edit.claim', () => runtime.claimLease({ directory, token: lease.token, kind: 'process' }));
        await fs.appendFile(path.join(lease.viewDirectory, target), `// edit ${index}\n`);
        await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
          JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
        const result = await elapsed(rows, 'edit.finish', () => runtime.finish({ directory, token: lease.token }));
        if (result.files?.[0]?.path !== target) throw new Error(`edit ${index} did not publish ${target}`);
        await elapsed(rows, 'edit.receipt', async () => {
          const receipt = await runtime.executionReceipt({ directory, token: lease.token });
          for (const file of receipt.files) for (const side of [file.before, file.after]) if (side) for await (const _ of side.byteStream);
        });
        await elapsed(rows, 'edit.cleanup', () => runtime.cleanupLease({ directory, token: lease.token }));
      }));
    }
    await runtime.drain();
    report.phases = Object.fromEntries(Object.entries(rows).map(([phase, values]) => [phase, summarize(values)]));
    report.git = Object.fromEntries(Object.entries(gitRows).map(([phase, values]) => [phase, summarize(values)]));
    return report;
  } finally {
    if (!options.keep) await fs.rm(root, { recursive: true, force: true });
    else process.stderr.write(`kept ${root}\n`);
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseToolLatencyArgs(process.argv.slice(2));
  const report = await runToolLatencyBenchmark(options);
  const text = JSON.stringify(report, null, 2);
  if (options.out) await fs.writeFile(options.out, `${text}\n`);
  process.stdout.write(`${text}\n`);
}
