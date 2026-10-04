#!/usr/bin/env node
// Times the session mutation ledger on a real repository: the first confined
// call (which builds the ledger's file records unless --prewarm did), warm
// confined calls and a control call. Each iteration uses a fresh clone
// and fresh ledger storage under the repository cache, so it never touches a
// user's project or runtime state.
//
//   node scripts/perf/ledger-benchmark.mjs [--repo <git repo> | --fixture-files <count>] [--runtime <harness-runtime/lib>]
//     [--iterations 3] [--warm-calls 3] [--seed-calls <n>] [--parallel <calls>] [--same-session] [--deferred-cleanup]
//     [--restamp] [--prewarm] [--out <report.json>] [--keep]
//   --fixture-files builds (once) a deterministic synthetic repository under
//   .cache/perf/ledger-fixtures. --seed-calls (0-200000) replays n direct
//   read/glob/grep/skill receipts (admitDirect + finishDirect, as the host
//   records them) over five synthetic sessions, eight per assistant step,
//   before the timed calls, so the ledger carries production-shaped call
//   history; it runs after --prewarm (without it the seeded ledger has no file
//   records and a warning is printed), is one ledger commit per call, so its
//   time grows with the seed (hours at tens of thousands), and reports its
//   duration and the ledger entry count by kind. The seed's background ledger
//   maintenance is awaited before the timed calls (`seed.maintenanceDrainMs`).
//   --parallel adds a burst of concurrent confined calls after the warm calls,
//   in distinct sessions by default or, with --same-session, as one assistant
//   step of the warm session (report `burstMode`). --deferred-cleanup starts
//   view cleanup without awaiting it on the timed path, as the host does
//   (DEVRYAN_DEFERRED_LEASE_CLEANUP); later timed calls overlap it, and what
//   remains after the last timed call is drained before the control call
//   (`drainMs`). --restamp then rewrites every tracked file with identical
//   bytes (new inode and ctime) and times the next call. Each iteration awaits
//   the runtime's ledger maintenance before counting entries and removing the
//   clone (`maintenanceDrainMs`).
//   --profile [--parallel <calls> [--same-session]] [--timeout-ms 300000]
//   runs cold, prewarmed, metadata-only and changed-content cases in fresh
//   worker processes; --parallel adds a
//   measured burst after each case's call, with its Git counts. --restamp,
//   --seed-calls and --deferred-cleanup apply to the call benchmark only.
//
// `--runtime` points at another checkout's `packages/harness-runtime/lib` so a
// frozen baseline and a candidate run the same workload. Kill-switch variables
// in the environment are passed through unchanged, for per-switch A/B runs.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { startOwnedProcess } from '../qa/process.mjs';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function parseLedgerBenchmarkArgs(argv) {
  const options = { repo: repositoryRoot, runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'),
    iterations: 3, warmCalls: 3, prewarm: false, out: null, keep: false, profile: false, timeoutMs: 300_000,
    fixtureFiles: null, parallel: 1, restamp: false, seedCalls: 0, sameSession: false, deferredCleanup: false };
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
    else if (flag === '--profile') options.profile = true;
    else if (flag === '--companion') throw new Error('The legacy companion benchmark is retired; use native-upgrade-benchmark.mjs');
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value());
    else if (flag === '--fixture-files') options.fixtureFiles = Number(value());
    else if (flag === '--parallel') options.parallel = Number(value());
    else if (flag === '--restamp') options.restamp = true;
    else if (flag === '--seed-calls') options.seedCalls = Number(value());
    else if (flag === '--same-session') options.sameSession = true;
    else if (flag === '--deferred-cleanup') options.deferredCleanup = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (options.fixtureFiles !== null && (!Number.isSafeInteger(options.fixtureFiles) || options.fixtureFiles < 1 || options.fixtureFiles > 200_000)) {
    throw new Error('--fixture-files must be an integer from 1 to 200000');
  }
  if (!Number.isSafeInteger(options.parallel) || options.parallel < 1 || options.parallel > 32) throw new Error('--parallel must be an integer from 1 to 32');
  if (!Number.isSafeInteger(options.seedCalls) || options.seedCalls < 0 || options.seedCalls > 200_000) throw new Error('--seed-calls must be an integer from 0 to 200000');
  if (options.sameSession && options.parallel < 2) throw new Error('--same-session applies to the --parallel burst');
  if (options.profile && (options.restamp || options.seedCalls > 0 || options.deferredCleanup)) {
    throw new Error('--restamp, --seed-calls and --deferred-cleanup apply to the call benchmark, not --profile');
  }
  for (const [name, count] of [['--iterations', options.iterations], ['--warm-calls', options.warmCalls]]) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error(`${name} must be an integer from 1 to 50`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 900_000) throw new Error('--timeout-ms must be an integer from 1000 to 900000');
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

// `deferred` is the iteration's set of in-flight cleanups: when given, view
// cleanup starts after publication but is not awaited on the timed path,
// mirroring the host (session-execution-host.js, DEVRYAN_DEFERRED_LEASE_CLEANUP).
// The row's cleanupMs is filled in when that work settles; the iteration drains
// the set before it ends, so a failed cleanup still fails the run.
async function processCall(runtime, directory, ids, edit, deferred = null) {
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
  const row = { beginMs: begin.ms, beginCpuMs: begin.cpuMs, finishMs: finish.ms, finishCpuMs: finish.cpuMs, cleanupMs: null, cleanupDeferred: deferred !== null };
  const cleanup = timed(() => runtime.cleanupLease({ directory, token: lease.token })).then((result) => { row.cleanupMs = result.ms; });
  if (deferred === null) { await cleanup; return row; }
  deferred.add(cleanup);
  cleanup.catch(() => { /* Not unhandled: the drain rethrows it. */ });
  return row;
}

// A --parallel burst is one assistant step: with --same-session every call
// shares the warm session and one user message (as in production); by default
// each call keeps its own session, the historical shape.
export const burstModeFor = (options) => (options.parallel > 1 ? (options.sameSession ? 'same-session' : 'distinct-sessions') : null);
export function burstCallIdentity(call, sameSession, session = 's1') {
  return sameSession ? { session, user: 'ub', call: `bc${call}` } : { session: `b${call}`, user: `bu${call}`, call: `bc${call}` };
}

// Synthetic direct calls spread over a handful of sessions, eight calls per
// assistant step, as read/glob/grep/skill receipts arrive in production.
export const SEED_SESSIONS = 5;
export function seedCallIdentity(index) {
  const session = index % SEED_SESSIONS;
  const user = `seed-u${session}-${Math.floor(index / (SEED_SESSIONS * 8))}`;
  return { sessionID: `seed-s${session}`, userMessageID: user, messageID: `${user}-assistant`, callID: `seed-c${index}` };
}

// Replays direct receipts through the same runtime API the host uses for
// built-in read-only tools (session-execution-host.js direct-admit and
// direct-finish: admitDirect, then finishDirect in one locked commit, and no
// execution receipt while DEVRYAN_DIRECT_LEDGER_ONLY is on); no view, no
// provider, no raw Git. Direct receipts record no file state: the first
// seeded call only initializes the ledger store (reported apart), and file
// records still come from --prewarm or the first confined call. The last
// calls show the per-commit cost at the seeded size.
async function seedDirectCalls(runtime, directory, count) {
  if (typeof runtime.admitDirect !== 'function' || typeof runtime.finishDirect !== 'function') {
    throw new Error('This runtime has no direct receipts (admitDirect/finishDirect); run without --seed-calls');
  }
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const identity = { directory, ...seedCallIdentity(index) };
    const started = performance.now();
    const { generation } = await runtime.admitDirect(identity);
    await runtime.finishDirect({ ...identity, token: randomUUID(), generation,
      executionFingerprint: createHash('sha256').update(identity.callID).digest('hex') });
    durations.push(Math.round(performance.now() - started));
  }
  return { firstCallMs: durations[0] ?? null, callMs: summarize(durations.slice(1)), lastCallsMs: summarize(durations.slice(Math.max(1, count - 50))) };
}

// Awaits the runtime's background ledger maintenance (count-objects/repack/
// prune, scheduled with setImmediate every 64 commits) and any other owned
// work, so no Git child outlives the phase it belongs to or races the clone's
// removal. One tick first lets a just-scheduled maintenance run register.
// Null for a runtime without drain() (an older --runtime baseline).
export async function drainRuntime(runtime) {
  if (typeof runtime?.drain !== 'function') return null;
  return (await timed(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.drain();
  })).ms;
}

// Entries in the ledger's state tree, by top-level kind (files, sessions,
// prompts, calls, leases, operations, ...). The runtime exposes no count, so
// this lists the committed tree read-only; null before any ledger commit.
async function ledgerEntryCount(changeKey, storage, project) {
  const gitDir = path.join(storage, changeKey(await fs.realpath(project)), 'git');
  if (!await fs.access(path.join(gitDir, 'HEAD')).then(() => true, () => false)) return null;
  const ref = (await execute('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname)', 'refs/devryan/state'])).stdout.trim();
  if (!ref) return null;
  const { stdout } = await execute('git', ['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--name-only', ref], { maxBuffer: 256 * 1024 * 1024 });
  const byKind = {};
  let total = 0;
  for (const key of stdout.split('\0')) {
    if (!key) continue;
    total += 1;
    const slash = key.indexOf('/'), kind = slash === -1 ? '.' : key.slice(0, slash);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { total, byKind };
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

// Deterministic synthetic project: nested directories (depth 3-6), mixed
// sizes, some executable files and symbolic links, and an ignored dependency
// input. Built once per size and committed, so every arm clones the same tree.
export function fixtureEntries(count) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const depth = 3 + (index % 4);
    const parts = [`d${index % 7}`, `s${(index >> 3) % 11}`, `t${(index >> 6) % 13}`, `u${(index >> 9) % 5}`, `v${(index >> 11) % 3}`, `w${(index >> 12) % 2}`];
    const file = [...parts.slice(0, depth - 1), `f${index}.${index % 5 === 0 ? 'bin' : 'ts'}`].join('/');
    if (index % 499 === 498) { entries.push({ file: file.replace(/\.[a-z]+$/, '.link'), link: `f${index - 1}.ts` }); continue; }
    entries.push({ file, text: `// fixture ${index}\n${'export const value = 1;\n'.repeat(1 + (index % 40))}`, executable: index % 97 === 0 });
  }
  return entries;
}

async function ensureFixtureRepository(count) {
  const directory = path.join(repositoryRoot, '.cache/perf/ledger-fixtures', `files-${count}`);
  if (await fs.access(path.join(directory, '.fixture-ready')).then(() => true, () => false)) return directory;
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  await execute('git', ['init', '--quiet', directory]);
  await fs.writeFile(path.join(directory, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(directory, 'README.md'), '# ledger fixture\n');
  await fs.mkdir(path.join(directory, 'node_modules/dep'), { recursive: true });
  await fs.writeFile(path.join(directory, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  for (const entry of fixtureEntries(count)) {
    const target = path.join(directory, entry.file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (entry.link) await fs.symlink(entry.link, target);
    else await fs.writeFile(target, entry.text, { mode: entry.executable ? 0o755 : 0o644 });
  }
  await execute('git', ['-C', directory, 'add', '-A'], { maxBuffer: 64 * 1024 * 1024 });
  await execute('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { maxBuffer: 64 * 1024 * 1024 });
  await fs.writeFile(path.join(directory, '.fixture-ready'), '');
  return directory;
}

async function restampTrackedFiles(directory) {
  const { stdout } = await execute('git', ['-C', directory, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  let rewritten = 0;
  for (const file of stdout.split('\0').filter(Boolean)) {
    const target = path.join(directory, file);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isFile()) continue;
    const bytes = await fs.readFile(target);
    await fs.rm(target);
    await fs.writeFile(target, bytes, { mode: stat.mode & 0o777 });
    rewritten += 1;
  }
  return rewritten;
}

async function trackedFileCount(directory) {
  const { stdout } = await execute('git', ['-C', directory, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean).length;
}

export async function runLedgerBenchmark(options) {
  const { createSessionMutationRuntime } = await import(pathToFileURL(path.join(options.runtime, 'session-mutations.js')).href);
  const { changeKey } = await import(pathToFileURL(path.join(options.runtime, 'session-changes-store.js')).href);
  if (options.fixtureFiles !== null) options = { ...options, repo: await ensureFixtureRepository(options.fixtureFiles) };
  const burstMode = burstModeFor(options);
  // Direct receipts record no file state, so a seed without --prewarm commits
  // on a ledger far smaller than production's: say so rather than mislead.
  if (options.seedCalls > 0 && !options.prewarm) {
    console.error('ledger-benchmark: --seed-calls without --prewarm seeds a ledger with no file records (not production-shaped); add --prewarm');
  }
  const benchRoot = path.join(repositoryRoot, '.cache/perf/ledger-bench');
  await fs.mkdir(benchRoot, { recursive: true });
  const iterations = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const root = await fs.mkdtemp(path.join(benchRoot, 'run-'));
    const project = path.join(root, 'project'), storage = path.join(root, 'ledger');
    const deferred = options.deferredCleanup ? new Set() : null;
    let runtime = null;
    try {
      // A shallow copy of the committed tree: the ledger sees tracked files
      // only, identical for every arm, and never the source's working state.
      await execute('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(options.repo).href, project], { maxBuffer: 16 * 1024 * 1024 });
      const files = await trackedFileCount(project);
      const edit = 'README.md';
      await fs.access(path.join(project, edit));
      runtime = createSessionMutationRuntime({ directory: storage });
      let prewarmMs = null;
      if (options.prewarm) {
        if (typeof runtime.warm !== 'function') throw new Error('This runtime has no warm(); run without --prewarm');
        prewarmMs = (await timed(() => runtime.warm({ directory: project }))).ms;
      }
      // Seeded history precedes every timed call (and follows the prewarm, so
      // the seed commits rewrite a ledger that already holds the file tree).
      let seed = null;
      if (options.seedCalls > 0) {
        const seeded = await timed(() => seedDirectCalls(runtime, project, options.seedCalls));
        // Seeding is setup: its background repack finishes (timed apart, not
        // in `ms`) before the first timed call, so it cannot skew that call.
        const maintenanceDrainMs = await drainRuntime(runtime);
        seed = { calls: options.seedCalls, sessions: Math.min(options.seedCalls, SEED_SESSIONS), ms: seeded.ms, cpuMs: seeded.cpuMs,
          ...seeded.value, maintenanceDrainMs, ledgerEntries: await ledgerEntryCount(changeKey, storage, project) };
      }
      const first = await processCall(runtime, project, { session: 's1', user: 'u0', call: 'c0' }, edit, deferred);
      const warm = [];
      for (let call = 1; call <= options.warmCalls; call += 1) {
        warm.push(await processCall(runtime, project, { session: 's1', user: `u${call}`, call: `c${call}` }, edit, deferred));
      }
      let burst = null;
      if (options.parallel > 1) {
        // Concurrent calls of one assistant step: each edits its own new file.
        const started = performance.now();
        const calls = await Promise.all(Array.from({ length: options.parallel }, (_, call) => processCall(runtime, project,
          burstCallIdentity(call, options.sameSession), `ledger-bench-burst-${call}.txt`, deferred)));
        burst = { mode: burstMode, spanMs: Math.round(performance.now() - started), calls };
      }
      let restamp = null;
      if (options.restamp) {
        const rewritten = await restampTrackedFiles(project);
        restamp = { rewritten, ...await processCall(runtime, project, { session: 's1', user: 'ur', call: 'cr' }, edit, deferred) };
      }
      // Deferred cleanups overlap the later timed calls, as in the host. The
      // remainder drains right after the last producer (timed as `drainMs`),
      // before the control call, so the control call never queues behind them.
      const drainMs = deferred ? (await timed(() => Promise.all([...deferred]))).ms : null;
      // The control call keeps its synchronous cleanup: it is the round-trip reference.
      const control = await controlCall(runtime, project, { session: 's1', user: 'uc', call: 'cc' });
      // Background ledger maintenance finishes before the count and removal.
      const maintenanceDrainMs = await drainRuntime(runtime);
      const ledgerEntries = await ledgerEntryCount(changeKey, storage, project);
      iterations.push({ iteration, files, prewarmMs, seed, first, warm, burst, restamp, control, drainMs, maintenanceDrainMs, ledgerEntries,
        maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) });
      console.error(JSON.stringify({ iteration, files, prewarmMs, seedMs: seed?.ms ?? null, seedLedgerEntries: seed?.ledgerEntries?.total ?? null,
        firstBeginMs: first.beginMs, firstFinishMs: first.finishMs,
        warmBeginMs: warm.map(row => row.beginMs), warmFinishMs: warm.map(row => row.finishMs),
        burstMode, burstSpanMs: burst?.spanMs ?? null, burstBeginMs: burst?.calls.map(row => row.beginMs) ?? null,
        restampBeginMs: restamp?.beginMs ?? null, controlMs: control.totalMs, drainMs, maintenanceDrainMs, ledgerEntries: ledgerEntries?.total ?? null }));
    } finally {
      // A failed iteration still waits for its in-flight cleanups and ledger
      // maintenance before the clone and ledger go.
      if (deferred) await Promise.allSettled([...deferred]);
      await drainRuntime(runtime).catch(() => { /* Best effort: the iteration's own error, if any, is what propagates. */ });
      if (!options.keep) await fs.rm(root, { recursive: true, force: true });
    }
  }
  const pick = (select) => summarize(iterations.flatMap(select));
  const switches = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^DEVRYAN_(LEDGER|LAZY|VIEW|EXECUTION)_/.test(key)).sort());
  return {
    version: 1, runtime: options.runtime, repo: options.repo, iterations: options.iterations, warmCalls: options.warmCalls,
    prewarm: options.prewarm, parallel: options.parallel, restamp: options.restamp, fixtureFiles: options.fixtureFiles,
    seedCalls: options.seedCalls, sameSession: options.sameSession, burstMode, deferredCleanup: options.deferredCleanup,
    switches, platform: `${process.platform}-${process.arch}`, node: process.version,
    summary: {
      files: pick(row => [row.files]),
      prewarmMs: pick(row => [row.prewarmMs]),
      seedMs: pick(row => (row.seed ? [row.seed.ms] : [])),
      seedLastCallMs: pick(row => (row.seed ? [row.seed.lastCallsMs.p50] : [])),
      seedLedgerEntries: pick(row => (row.seed?.ledgerEntries ? [row.seed.ledgerEntries.total] : [])),
      ledgerEntries: pick(row => (row.ledgerEntries ? [row.ledgerEntries.total] : [])),
      drainMs: pick(row => [row.drainMs]), maintenanceDrainMs: pick(row => [row.maintenanceDrainMs]),
      seedMaintenanceDrainMs: pick(row => (row.seed ? [row.seed.maintenanceDrainMs] : [])),
      firstBeginMs: pick(row => [row.first.beginMs]), firstFinishMs: pick(row => [row.first.finishMs]),
      warmBeginMs: pick(row => row.warm.map(call => call.beginMs)), warmFinishMs: pick(row => row.warm.map(call => call.finishMs)),
      warmCleanupMs: pick(row => row.warm.map(call => call.cleanupMs)),
      burstSpanMs: pick(row => (row.burst ? [row.burst.spanMs] : [])),
      burstBeginMs: pick(row => row.burst?.calls.map(call => call.beginMs) ?? []),
      burstFinishMs: pick(row => row.burst?.calls.map(call => call.finishMs) ?? []),
      burstCleanupMs: pick(row => row.burst?.calls.map(call => call.cleanupMs) ?? []),
      restampBeginMs: pick(row => (row.restamp ? [row.restamp.beginMs] : [])),
      controlMs: pick(row => [row.control.totalMs]), maxRssMiB: pick(row => [row.maxRssMiB]),
    },
    rows: iterations,
  };
}

// Phase profiling runs each case in a fresh process so maxRSS, caches and
// initialization from earlier cases cannot silently affect the next sample.
export async function runPreparationProfile(options) {
  if (options.fixtureFiles !== null) options = { ...options, repo: await ensureFixtureRepository(options.fixtureFiles) };
  const cacheRoot = path.join(repositoryRoot, '.cache/perf/ledger-profile');
  await fs.mkdir(cacheRoot, { recursive: true });
  const outputRoot = await fs.mkdtemp(path.join(cacheRoot, 'run-'));
  const rows = [];
  for (const mode of ['ledger']) {
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      // Rotate case order to avoid assigning every first/cold trial to the
      // same filesystem-cache and machine-load position.
      const cases = ['cold', 'warm', 'metadata-only', 'changed-content'];
      for (const scenario of [...cases.slice(iteration % 4), ...cases.slice(0, iteration % 4)]) {
        const trialRoot = path.join(outputRoot, `${mode}-${scenario}-${iteration}`);
        await fs.mkdir(trialRoot);
        const resultFile = path.join(trialRoot, 'result.json');
        const worker = startOwnedProcess(process.execPath, [path.join(repositoryRoot, 'scripts/perf/ledger-profile-worker.mjs'),
          JSON.stringify({ ...options, mode, scenario, trialRoot, resultFile })], { cwd: repositoryRoot,
          env: { PATH: process.env.PATH, HOME: path.join(trialRoot, 'home'), TMPDIR: trialRoot, LC_ALL: 'C',
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^DEVRYAN_(LEDGER|LAZY|VIEW|EXECUTION)_/.test(key)
              && !/(TOKEN|URL|PASSWORD|SECRET)/.test(key))) } });
        let timer, timedOut = false, cleanupError = null, cleanup;
        try {
          await Promise.race([
            new Promise(resolve => worker.child.once('close', resolve)),
            new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, options.timeoutMs); }),
          ]);
        } finally {
          clearTimeout(timer);
          try { cleanup = await worker.stop(); } catch (error) { cleanupError = error.message; cleanup = worker.getCleanupEvidence(); }
        }
        const result = await fs.readFile(resultFile, 'utf8').then(JSON.parse, () => ({ status: 'failed', reason: 'worker produced no completed result' }));
        const row = { mode, scenario, iteration, evidenceDirectory: trialRoot, ...result, ...(timedOut ? { status: 'timeout' } : {}), cleanup, cleanupError };
        if (cleanupError) row.status = 'cleanup-failed';
        await fs.writeFile(path.join(trialRoot, 'worker.log'), worker.getLog());
        // Delete only after retained OS identities confirm the owned process tree stopped.
        if (!options.keep && !cleanupError && row.status === 'completed') {
          await fs.rm(path.join(trialRoot, 'fixture'), { recursive: true, force: true });
          await fs.rm(path.join(trialRoot, 'home'), { recursive: true, force: true });
          row.fixtureRemoved = await fs.access(path.join(trialRoot, 'fixture')).then(() => false, () => true);
          row.homeRemoved = await fs.access(path.join(trialRoot, 'home')).then(() => false, () => true);
        } else { row.fixtureRemoved = false; row.homeRemoved = false; }
        rows.push(row);
        await fs.writeFile(path.join(outputRoot, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
        console.error(JSON.stringify({ mode, scenario, iteration, status: row.status, wallMs: row.metrics?.wallMs, preparationMs: row.metrics?.preparationMs }));
      }
    }
  }
  const summary = {};
  for (const row of rows) {
    const key = `${row.mode}/${row.scenario}`;
    summary[key] ??= { completed: 0, failed: 0, metrics: {} };
    summary[key][row.status === 'completed' ? 'completed' : 'failed'] += 1;
    for (const metric of Object.keys(row.metrics ?? {})) summary[key].metrics[metric] = summarize(rows
      .filter(item => item.status === 'completed' && `${item.mode}/${item.scenario}` === key).map(item => item.metrics?.[metric]));
  }
  return { version: 2, at: new Date().toISOString(), outputRoot, repo: options.repo, runtime: options.runtime,
    platform: `${process.platform}-${process.arch}`, node: process.version, iterations: options.iterations,
    parallel: options.parallel, burstMode: burstModeFor(options),
    measurement: 'Independent fresh processes; prewarm is separate. Nested phases and concurrent Git/copy work overlap and must not be added. Host CPU/maxRSS exclude child processes; companion RSS is sampled, not an exact peak. No installed-app state or live provider.', summary, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseLedgerBenchmarkArgs(process.argv.slice(2));
  const report = await (options.profile ? runPreparationProfile(options) : runLedgerBenchmark(options));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) { await fs.mkdir(path.dirname(options.out), { recursive: true }); await fs.writeFile(options.out, text); }
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
  if (options.profile && report.rows.some(row => row.status !== 'completed')) process.exitCode = 1;
}
