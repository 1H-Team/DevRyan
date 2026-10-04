// Benchmark-only observers live in this disposable process, never the host app.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, appendFileSync } from 'node:fs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(childProcess.execFile);
const clock = () => performance.now();
const round = value => Math.round(value * 10) / 10;
export function phaseTotals(records) {
  const totals = {};
  // Only summary rows: slow phase events repeat entries in their summary.
  for (const record of records.filter(row => row.phase === 'admission')) {
    for (const step of (record.steps ?? '').split(',')) {
      const match = /^([a-z_]+):(\d+)\/(\d+)$/.exec(step);
      if (!match) continue;
      const entry = totals[match[1]] ??= { count: 0, elapsedMs: 0 };
      entry.count += Number(match[2]); entry.elapsedMs += Number(match[3]);
    }
  }
  return totals;
}

export function parseProcessSample(text) {
  const match = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  return { rssMiB: Number(match[1]) / 1024,
    cpuMs: ((Number(match[2] ?? 0) * 86400) + Number(match[3] ?? 0) * 3600 + Number(match[4]) * 60 + Number(match[5])) * 1000 };
}

const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

function observeWork() {
  const git = [], copies = [];
  const spawn = childProcess.spawn, copyFile = fs.copyFile;
  const commands = new Set(['init', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'hash-object', 'write-tree',
    'read-tree', 'update-index', 'commit-tree', 'update-ref', 'for-each-ref', 'show', 'diff', 'diff-files', 'diff-index', 'status', 'config', 'check-ignore', 'rev-list', 'count-objects', 'repack', 'prune']);
  childProcess.spawn = function (command, args, options) {
    const started = clock(), child = spawn.call(this, command, args, options);
    if (command === 'git') child.once('close', code => git.push({ command: args.find(arg => commands.has(arg)) ?? 'other',
      started, ended: clock(), code }));
    return child;
  };
  fs.copyFile = async (...args) => {
    const started = clock();
    try { return await copyFile(...args); }
    finally { copies.push({ started, ended: clock() }); }
  };
  syncBuiltinESMExports();
  return {
    metrics(started, ended) {
      const gitRows = git.filter(row => row.started >= started && row.ended <= ended);
      const copyRows = copies.filter(row => row.started >= started && row.ended <= ended);
      const gitCommands = {};
      for (const row of gitRows) {
        const entry = gitCommands[row.command] ??= { count: 0, workMs: 0 };
        entry.count += 1; entry.workMs += row.ended - row.started;
      }
      for (const entry of Object.values(gitCommands)) entry.workMs = round(entry.workMs);
      return { gitWorkMs: round(gitRows.reduce((sum, row) => sum + row.ended - row.started, 0)), gitProcesses: gitRows.length,
        gitTreeWrites: gitRows.filter(row => row.command === 'write-tree' && row.code === 0).length,
        copyWorkMs: round(copyRows.reduce((sum, row) => sum + row.ended - row.started, 0)), copyCount: copyRows.length, gitCommands };
    },
    restore() { childProcess.spawn = spawn; fs.copyFile = copyFile; syncBuiltinESMExports(); },
  };
}

export async function measurePreparation(options) {
  const root = path.join(options.trialRoot, 'fixture'), directory = path.join(root, 'project');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(options.trialRoot, 'home'), { recursive: true });
  await run('git', ['clone', '--quiet', '--depth', '1', pathToFileURL(options.repo).href, directory], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const { stdout: listed } = await run('git', ['-C', directory, 'ls-files', '-z'], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  const files = listed.split('\0').filter(Boolean).length;
  const projectCommit = (await run('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim();
  const diagnostics = [], actions = [], observer = observeWork();
  const recordDiagnostic = row => {
    diagnostics.push(row);
    // Slow/failing phase evidence survives a hard parent deadline. Summaries
    // are bounded and infrequent; no per-file/per-Git-process logging here.
    appendFileSync(path.join(options.trialRoot, 'diagnostics.jsonl'), JSON.stringify(row) + '\n');
  };
  const nativeSocketDirectories = new Set();
  let runtime, started, measured;
  const report = { status: 'failed', observationSchemaVersion: 2, files, projectCommit, metrics: {}, diagnostics, actions,
    unavailable: ['Git child CPU and exact process-tree peak RSS', 'Copy timing includes copyFile only; hashing/chmod/rename are inside preparation', 'Concurrent/nested phase totals overlap'] };
  report.sourceHashes = Object.fromEntries(await Promise.all(['session-mutations.js', 'session-mutation-files.js', 'execution-admission.js']
    .map(async file => [file, await digest(path.join(options.runtime, file))])));
  const admission = await import(pathToFileURL(path.join(options.runtime, 'execution-admission.js')).href);
  const context = (fn, preparation = false) => (preparation ? admission.withExecutionPreparation : admission.withExecutionAdmission)({}, fn,
    { timeoutMs: options.timeoutMs - 500, onDiagnostic: recordDiagnostic, summary: { minMs: 0 } });
  const measure = async fn => {
    const started = clock(), cpu = process.cpuUsage(), diagnosticStart = diagnostics.length;
    const value = await fn(), ended = clock(), used = process.cpuUsage(cpu);
    return { value, started, ended, wallMs: round(ended - started), cpuMs: round((used.user + used.system) / 1000),
      phases: phaseTotals(diagnostics.slice(diagnosticStart)), ...observer.metrics(started, ended) };
  };
  const save = () => fs.writeFile(options.resultFile, JSON.stringify(report, null, 2) + '\n');
  await save();
  try {
    assert.equal(options.mode, 'ledger', 'Only isolated ledger profiling is supported');
    {
      const { createSessionMutationRuntime } = await import(pathToFileURL(path.join(options.runtime, 'session-mutations.js')).href);
      runtime = createSessionMutationRuntime({ directory: path.join(root, 'ledger') });
      measured = async () => {
        const input = { directory, sessionID: 'profile', userMessageID: 'user', messageID: 'assistant', callID: 'call' };
        const prepared = await measure(() => context(() => runtime.begin(input), true));
        const lease = prepared.value;
        report.metrics.preparationMs = prepared.wallMs;
        report.preparation = { ...prepared, value: undefined };
        await context(() => runtime.claimLease({ directory, token: lease.token, kind: 'process' }));
        const toolStarted = clock();
        await fs.writeFile(path.join(lease.workingDirectory, 'profile-result.txt'), 'Fixture complete.\n');
        report.metrics.toolExecutionMs = round(clock() - toolStarted);
        await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }));
        const finishStarted = clock();
        await context(() => runtime.finish({ directory, token: lease.token }));
        report.metrics.publicationMs = round(clock() - finishStarted);
        const cleanupStarted = clock();
        await context(() => runtime.cleanupLease({ directory, token: lease.token }));
        report.metrics.cleanupMs = round(clock() - cleanupStarted);
        report.metrics.resultReturnMs = null;
        report.unavailable.push('Direct ledger mode has synthetic tool/termination; no transport result-return measurement');
      };
    }
    if (options.scenario !== 'cold') {
      const prewarm = await measure(() => context(() => runtime.warm({ directory }), true));
      report.prewarm = prewarm;
      report.metrics.prewarmMs = prewarm.wallMs;
      assert.equal(prewarm.value?.built, true, `Prewarm did not build a ledger: ${prewarm.value?.skipped ?? 'unknown'}`);
    } else report.metrics.prewarmMs = null;
    if (options.scenario === 'metadata-only') {
      const file = path.join(directory, 'README.md'), stat = await fs.stat(file);
      await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 1000));
    }
    if (options.scenario === 'changed-content') await fs.appendFile(path.join(directory, 'README.md'), '\nFixture incoming content change.\n');
    const diagnosticStart = diagnostics.length;
    started = clock();
    const sample = await measure(measured);
    const phases = phaseTotals(diagnostics.slice(diagnosticStart));
    Object.assign(report.metrics, { wallMs: sample.wallMs, hostCpuMs: sample.cpuMs, hostPeakRssMiB: round(process.resourceUsage().maxRSS / 1024),
      gitWorkMs: sample.gitWorkMs, gitProcesses: sample.gitProcesses, gitTreeWrites: sample.gitTreeWrites, copyWorkMs: sample.copyWorkMs, copyCount: sample.copyCount,
      preparationMs: report.metrics.preparationMs ?? phases.preparation?.elapsedMs ?? null,
      queueWaitMs: phases.queue_wait?.elapsedMs ?? null, ledgerCommitMs: phases.ledger_commit?.elapsedMs ?? null,
      ledgerCommitCount: phases.ledger_commit?.count ?? null });
    report.phases = phases;
    report.gitCommands = sample.gitCommands;
    // The parent supports only ledger mode: a
    // burst of concurrent calls after the measured one, each writing its own
    // file, so the burst's Git processes and tree writes are counted over its
    // span. Nested and concurrent phases overlap; totals must not be added.
    if (options.mode === 'ledger' && options.parallel > 1) {
      // Loaded only for a burst, so unburst workers initialize as before.
      const { burstCallIdentity, burstModeFor } = await import('./ledger-benchmark.mjs');
      const burstCall = async (call) => {
        const ids = burstCallIdentity(call, options.sameSession, 'profile');
        const input = { directory, sessionID: ids.session, userMessageID: ids.user, messageID: `${ids.user}-assistant`, callID: ids.call };
        const lease = await context(() => runtime.begin(input), true);
        await context(() => runtime.claimLease({ directory, token: lease.token, kind: 'process' }));
        await fs.writeFile(path.join(lease.workingDirectory, `profile-burst-${call}.txt`), 'Fixture complete.\n');
        await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }));
        await context(() => runtime.finish({ directory, token: lease.token }));
        await context(() => runtime.cleanupLease({ directory, token: lease.token }));
      };
      const burst = await measure(() => Promise.all(Array.from({ length: options.parallel }, (_, call) => burstCall(call))));
      report.burst = { mode: burstModeFor(options), calls: options.parallel, ...burst, value: undefined };
      Object.assign(report.metrics, { burstSpanMs: burst.wallMs, burstGitWorkMs: burst.gitWorkMs, burstGitProcesses: burst.gitProcesses,
        burstGitTreeWrites: burst.gitTreeWrites, burstLedgerCommitCount: burst.phases.ledger_commit?.count ?? null,
        burstLedgerCommitMs: burst.phases.ledger_commit?.elapsedMs ?? null });
    }
    report.status = 'completed';
  } catch (error) {
    report.reason = error.code ?? error.message;
  } finally {
    // Save measurements before shutdown, retaining evidence even when a drain
    // exceeds the parent's process lifetime bound.
    await save();
    try { await runtime?.drain(); } catch (error) { report.status = 'cleanup-failed'; report.cleanupReason = error.code ?? error.message; }
    report.nativeSocketDirectoryCount = nativeSocketDirectories.size;
    report.nativeSocketCleanupVerified = (await Promise.all([...nativeSocketDirectories].map(directory => fs.access(directory).then(() => false, error => error.code === 'ENOENT')))).every(Boolean);
    if (!report.nativeSocketCleanupVerified) { report.status = 'cleanup-failed'; report.cleanupReason = 'owned native socket directory remains'; }
    observer.restore(); await save();
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(process.argv[2]);
  try {
    const report = await measurePreparation(options);
    if (report.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    await fs.writeFile(options.resultFile, JSON.stringify({ status: 'failed', reason: error.code ?? error.message }) + '\n');
    process.exitCode = 1;
  }
}
