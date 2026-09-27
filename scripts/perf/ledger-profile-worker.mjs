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
  let runtime, host, bridge, model, upstream, sampler, samplePending = Promise.resolve(), companionSamples = [], started, measured;
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
    if (options.mode === 'companion') {
      const [{ reservePort, startOwnedProcess }, { startRevertModelFixture }, { createSessionExecutionHost },
        { createManagedOrchestrationPrivateHost }, { resolveCursorRipgrepPath }, { executionArtifacts, executionEnvironment }] = await Promise.all([
        import('../qa/process.mjs'), import('../qa/revert-model-fixture.mjs'), import('../../packages/web/server/lib/opencode/session-execution-host.js'),
        import('../../packages/web/server/lib/orchestration/private-host.js'), import('../../packages/cursor-sdk-runtime/ripgrep-path.js'),
        import('../../packages/web/server/lib/opencode/execution-artifacts.js'),
      ]);
      const artifacts = executionArtifacts(path.join(repository, 'packages/web/runtime', `${process.platform}-${process.arch}`));
      const { executionSocketDirectory } = await import(pathToFileURL(path.join(options.runtime, 'session-execution.js')).href);
      const dataDirectory = path.join(root, 'app-data');
      const environment = await executionEnvironment({ directory: artifacts.directory, dataDirectory,
        pluginDirectory: path.join(repository, 'packages/web/server/default-config/plugins'), runtimeMode: 'captured' });
      report.companion = { sha256: await digest(artifacts.opencode), manifest: JSON.parse(await fs.readFile(path.join(artifacts.directory, 'companion.json'), 'utf8')) };
      const origin = `http://127.0.0.1:${await reservePort()}`;
      host = createSessionExecutionHost({ dataDirectory, getLauncher: () => artifacts.launcher, buildOpenCodeUrl: route => origin + route,
        admissionSummaryMinMs: 0, onDiagnostic: recordDiagnostic });
      runtime = host.runtime;
      bridge = createManagedOrchestrationPrivateHost({ handleRpc: async ({ method, params }) => {
        assert.equal(method, 'session_execution');
        const row = { action: params.action, callID: params.callID, started: clock() }; actions.push(row);
        try {
          const result = await host.plugin(params);
          if (result?.lease?.token) {
            const socket = executionSocketDirectory(result.lease);
            if (socket) nativeSocketDirectories.add(socket);
          }
          return result;
        } finally { row.ended = clock(); }
      } });
      model = await startRevertModelFixture();
      const home = path.join(root, 'home'); await fs.mkdir(home);
      const configDirectory = path.join(root, 'config-only'); await fs.mkdir(configDirectory);
      const env = { PATH: [path.dirname(resolveCursorRipgrepPath().path), process.env.PATH].join(path.delimiter),
        HOME: home, TMPDIR: root, OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
        XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
        OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture',
          provider: { fixture: model.config }, plugin: [], mcp: {}, snapshot: false, lsp: false, permission: 'allow' }),
        ...environment, ...await bridge.start(), DEVRYAN_EXECUTION_TRACE: '1' };
      upstream = startOwnedProcess(artifacts.opencode, ['serve', '--hostname', '127.0.0.1', '--port', new URL(origin).port, '--print-logs', '--log-level', 'ERROR'], { cwd: directory, env });
      const sample = async () => {
        try {
          const { stdout } = await run('ps', ['-p', String(upstream.child.pid), '-o', 'rss=,time='], { timeout: 1000 });
          const row = parseProcessSample(stdout); if (row) companionSamples.push(row);
        } catch { /* Missing process samples remain unavailable. */ }
      };
      let sampling = false;
      sampler = setInterval(() => {
        if (sampling) return;
        sampling = true;
        samplePending = sample().finally(() => { sampling = false; });
      }, 250);
      const startupStarted = clock();
      while (!await fetch(origin + '/global/health', { signal: AbortSignal.timeout(1000) }).then(async response => { await response.text(); return response.ok; }, () => false)) {
        upstream.check(); assert(clock() - startupStarted < 60_000, 'Companion startup timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      report.startupMs = round(clock() - startupStarted);
      const request = async (route, body) => {
        const url = new URL(route, origin); url.searchParams.set('directory', directory);
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs - 500) });
        const value = await response.json(); assert(response.ok, `Fixture request failed: ${response.status}`); return value;
      };
      const session = await request('/session', { title: 'Ledger preparation profile' });
      measured = async () => {
        await sample();
        const initialCpu = companionSamples.at(-1)?.cpuMs;
        const result = await request(`/session/${session.id}/message`, { model: { providerID: 'fixture', modelID: 'fixture' }, agent: 'build',
          parts: [{ type: 'text', text: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name: 'write', args: { filePath: path.join(directory, 'profile-result.txt'), content: 'Fixture complete.\n' } })}` }] });
        const returnedAt = clock();
        const messages = await request(`/session/${session.id}/message`);
        const tool = messages.filter(row => row.info.parentID === result.info.parentID).flatMap(row => row.parts).find(part => part.type === 'tool');
        assert.equal(tool?.state.status, 'completed', `Fixture tool state: ${tool?.state.status}`);
        assert.equal(await fs.readFile(path.join(directory, 'profile-result.txt'), 'utf8'), 'Fixture complete.\n');
        await sample();
        const lastCpu = companionSamples.at(-1)?.cpuMs;
        report.metrics.companionCpuMs = Number.isFinite(initialCpu) && Number.isFinite(lastCpu) ? lastCpu - initialCpu : null;
        const trace = Object.fromEntries([...upstream.getLog().matchAll(/^worker ([a-z]+) (\d+)ms$/gm)].map(match => [match[1], Number(match[2])]));
        report.workerTrace = trace;
        report.metrics.toolExecutionMs = Number.isFinite(trace.result) && Number.isFinite(trace.execute) ? trace.result - trace.execute : null;
        report.metrics.toolEnvelopeMs = tool.state.time.end - tool.state.time.start;
        const finish = actions.findLast(row => row.action === 'finish');
        report.metrics.publicationMs = finish?.ended ? round(finish.ended - finish.started) : null;
        report.metrics.resultReturnMs = finish?.ended ? round(returnedAt - finish.ended) : null;
        report.metrics.promptWallMs = round(returnedAt - started);
      };
    } else {
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
    report.status = 'completed';
  } catch (error) {
    report.reason = error.code ?? error.message;
  } finally {
    // Save measurements before shutdown, retaining evidence even when a drain
    // exceeds the parent's process lifetime bound.
    await save();
    clearInterval(sampler); await samplePending;
    report.metrics.companionSampledPeakRssMiB = companionSamples.length ? round(Math.max(...companionSamples.map(row => row.rssMiB))) : null;
    if (upstream) await fs.writeFile(path.join(options.trialRoot, 'companion.log'), upstream.getLog());
    try {
      // Keep the companion reachable while owned host preparations drain.
      if (host) await host.drain(); else await runtime?.drain();
    } catch (error) { report.status = 'cleanup-failed'; report.cleanupReason = error.code ?? error.message; }
    const stopped = await Promise.allSettled([upstream?.stop(), model?.stop(), bridge?.stop()]);
    if (stopped[0].status === 'fulfilled') report.companionCleanup = stopped[0].value;
    const failed = stopped.find(result => result.status === 'rejected');
    if (failed) { report.status = 'cleanup-failed'; report.cleanupReason = failed.reason?.message ?? 'resource shutdown failed'; }
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
