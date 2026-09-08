// Optional integration check against a disposable Context Mode installation.
// Run with Bun so the worker uses the same runtime as managed OpenCode.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { applyContextModeHotfix } from '../packages/web/server/lib/opencode/context-mode-hotfix.js';

const root = process.cwd();
const packageRoot = path.resolve(process.argv[2] || '.cache/context-mode-worker-check');
assert.ok(packageRoot.startsWith(path.join(root, '.cache') + path.sep), 'Use a disposable package inside .cache');
const hotfix = applyContextModeHotfix({ configDirectory: packageRoot });
assert.ok(hotfix.ok, hotfix.error);
const build = path.join(packageRoot, 'node_modules/context-mode/build');
const { ContextModeWorkerPool } = await import(pathToFileURL(path.join(build, 'devryan-context-mode-worker-pool.js')).href);
const runRoot = await fs.mkdtemp(path.join(root, '.cache/context-worker-integration-'));
const projects = await Promise.all(Array.from({ length: 15 }, async (_, index) => {
  const project = path.join(runRoot, `project-${index}`);
  await fs.mkdir(project);
  return project;
}));
const env = { ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG']
  .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]])),
  HOME: path.join(runRoot, 'home'), TMPDIR: path.join(runRoot, 'tmp'), TEMP: path.join(runRoot, 'tmp'), TMP: path.join(runRoot, 'tmp'),
  CONTEXT_MODE_PLATFORM: 'opencode', CONTEXT_MODE_DIR: path.join(runRoot, 'context-data'),
  CONTEXT_MODE_DATA_DIR: path.join(runRoot, 'runtime-data'),
  OPENCODE_CONFIG_DIR: path.join(runRoot, 'config'), OPENCHAMBER_DATA_DIR: path.join(runRoot, 'runtime-data'),
  XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'), XDG_DATA_HOME: path.join(runRoot, 'xdg-data'),
  XDG_STATE_HOME: path.join(runRoot, 'xdg-state'), XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache') };
await Promise.all([env.HOME, env.TMPDIR].map((directory) => fs.mkdir(directory)));
const events = [];
const phases = {};
let peakRss = process.memoryUsage().rss;
let workerRss = 0;
let maxActiveWorkers = 0;
let phase = 'setup';
let lastSample = performance.now();
const eventLoopDelays = [];
const sample = setInterval(() => {
  const now = performance.now();
  eventLoopDelays.push(Math.max(0, now - lastSample - 20));
  lastSample = now;
  peakRss = Math.max(peakRss, process.memoryUsage().rss + workerRss);
}, 20);
const runtimes = JSON.parse(execFileSync(process.execPath, ['--eval', `const { detectRuntimes } = await import(${JSON.stringify(pathToFileURL(path.join(build, 'runtime.js')).href)}); console.log(JSON.stringify(detectRuntimes()));`], { env, cwd: projects[0], encoding: 'utf8', timeout: 15000 }));
const pool = new ContextModeWorkerPool({ workerURL: pathToFileURL(path.join(build, 'devryan-context-mode-worker.js')),
  runtime: { executable: process.execPath, runtimes }, stateDirectory: runRoot,
  onEvent: (event) => {
    events.push({ ...event, benchmarkPhase: phase });
    maxActiveWorkers = Math.max(maxActiveWorkers, [...pool.workers].filter((slot) => slot.active).length);
  } });
let samplingWorkers = false;
const memorySample = setInterval(() => {
  const pids = [...pool.workers].map((slot) => slot.worker.pid).filter(Number.isSafeInteger);
  if (samplingWorkers || !pids.length) return;
  samplingWorkers = true;
  execFile('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000 }, (_error, stdout) => {
    workerRss = stdout.trim().split(/\s+/).reduce((total, value) => total + (Number(value) || 0) * 1024, 0);
    peakRss = Math.max(peakRss, process.memoryUsage().rss + workerRss);
    samplingWorkers = false;
  });
}, 250);
const percentile = (values, percentile) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * percentile) - 1)] ?? 0;
const measure = async (name, operation) => {
  console.log(`Checking Context Mode: ${name}`);
  phase = name;
  const start = performance.now();
  await operation();
  const observations = events.filter((event) => event.benchmarkPhase === name);
  phases[name] = { durationMs: Math.round(performance.now() - start),
    dispatches: observations.filter((event) => event.phase === 'dispatched').length,
    startupP95Ms: percentile(observations.filter((event) => event.phase === 'executing').map((event) => event.elapsedMs), 0.95),
    completionP95Ms: percentile(observations.filter((event) => event.phase === 'completed').map((event) => event.elapsedMs), 0.95),
    workerStarts: observations.filter((event) => event.phase === 'worker_started').length,
    workerReuses: observations.filter((event) => event.phase === 'worker_reused').length };
};
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('loopbackfixture This page belongs exclusively to the disposable concurrency test.');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fetchUrl = `http://127.0.0.1:${server.address().port}/fixture`;
let heldLock;
let releaseHeldLock;

const call = (index, name, args) => pool.execute({ name, args, env, projectDir: projects[index], sessionId: `ses_synthetic_${index}` });
const output = (result) => JSON.stringify(result);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    // Bun may retain a terminated worker's dead child as a zombie until the
    // runtime exits. A zombie cannot execute; report it separately below.
    return !execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return false; }
};
const deadline = setTimeout(() => { console.error('Worker integration check timed out'); void pool.close(); }, 240_000);
const waitUntil = async (label, condition, timeoutMs = 10_000) => {
  const end = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < end, label);
    await sleep(25);
  }
};
const assertSuccess = (result) => { assert.ok(!result.isError, output(result)); return result; };
const idleLimit = () => waitUntil('retire excess workers after concurrent work', () =>
  [...pool.workers].filter((slot) => slot.processes.size === 0).length <= 4);

try {
  await measure('sameProjectCold30', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => pool.execute({
      name: 'ctx_index', args: { content: `# Fixture\nconcurrentfixture Independent payload number ${index}.`, source: `parallel-${index}` },
      env, projectDir: projects[0], sessionId: `ses_parallel_${Math.floor(index / 2)}` })));
    results.forEach(assertSuccess);
  });
  assert.ok(maxActiveWorkers >= 30, 'All thirty calls must be dispatched concurrently');
  await idleLimit();
  await measure('sameProjectWarm4', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => pool.execute({
      name: 'ctx_search', args: { queries: ['concurrentfixture'], source: `parallel-${index}` },
      env, projectDir: projects[0], sessionId: `ses_warm_${index}` })));
    results.forEach((result, index) => assert.ok(output(assertSuccess(result)).includes(`payload number ${index}`), output(result)));
  });
  assert.equal(phases.sameProjectWarm4.workerReuses, 4, 'Warm calls must reuse idle workers');
  for (let iteration = 0; iteration < 2; iteration++) {
    await measure(`sameProjectRepeat30_${iteration}`, async () => {
      (await Promise.all(Array.from({ length: 30 }, (_, index) => pool.execute({ name: 'ctx_index',
        args: { content: `# Fixture\nconcurrentfixture Independent payload number ${index}, revision ${iteration + 1}.`, source: `parallel-${index}` },
        env, projectDir: projects[0], sessionId: `ses_parallel_${Math.floor(index / 2)}` })))).forEach(assertSuccess);
    });
    await idleLimit();
  }
  // Counter totals must survive concurrent completion and repeated worker reuse.
  for (const [file, entry] of pool.state.stats) await pool.state.flush(file, entry);
  for (let index = 0; index < 15; index++) {
    const statsFile = [...pool.state.stats.keys()].find((file) => path.basename(file) === `stats-ses_parallel_${index}.json`);
    assert.ok(statsFile, 'Per-session statistics file must be tracked');
    const stats = JSON.parse(await fs.readFile(statsFile, 'utf8'));
    assert.equal(stats.by_tool.ctx_index.calls, 6, 'Each session owns exactly its six completed indexing calls');
  }
  await measure('sameLabelWriters', async () => {
    (await Promise.all(Array.from({ length: 4 }, (_, index) => pool.execute({ name: 'ctx_index',
      args: { content: `# Replacement\nreplacementfixture revision-${index}`, source: 'replacement' },
      env, projectDir: projects[0], sessionId: `ses_replace_${index}` })))).forEach(assertSuccess);
    await call(0, 'ctx_index', { content: '# Replacement\nreplacementfixture final-committed-version', source: 'replacement' }).then(assertSuccess);
    const found = output(assertSuccess(await call(0, 'ctx_search', { queries: ['replacementfixture'], source: 'replacement' })));
    assert.ok(found.includes('final-committed-version') && !found.includes('revision-'), found);
  });
  // Hold only the database write mutex in this disposable fixture. The real
  // index call lasts beyond the old deadline while same-project reads/commands
  // continue; this is a controlled storage stall, not a throughput benchmark.
  const contentEntry = [...pool.state.storage].find(([file]) => file.includes(`${path.sep}content${path.sep}`));
  assert.ok(contentEntry, 'Content database coordination must exist');
  heldLock = contentEntry[1].lockPath;
  await fs.writeFile(heldLock, '', { flag: 'wx' });
  await measure('indexBeyondOldQueueDeadline', async () => {
    let completed = false;
    const longIndex = pool.execute({ name: 'ctx_index', args: { content: '# Slow\nlongindexfixture completed', source: 'slow-index' },
      env, projectDir: projects[0], sessionId: 'ses_slow_index' }).then((result) => { assertSuccess(result); completed = true; });
    releaseHeldLock = setTimeout(() => fsSync.unlinkSync(heldLock), 31_100);
    const quick = assertSuccess(await pool.execute({ name: 'ctx_execute', args: { language: 'javascript', code: 'console.log("independent-command-completed");' },
      env, projectDir: projects[0], sessionId: 'ses_independent_command' }));
    assert.ok(output(quick).includes('independent-command-completed'), output(quick));
    assert.equal(completed, false, 'A command must finish while the index remains blocked');
    const quickSearch = assertSuccess(await pool.execute({ name: 'ctx_search', args: { queries: ['concurrentfixture'], source: 'parallel-0' },
      env, projectDir: projects[0], sessionId: 'ses_independent_search' }));
    assert.ok(output(quickSearch).includes('payload number 0'), output(quickSearch));
    assert.equal(completed, false, 'A search must finish while the index remains blocked');
    assert.ok(events.some((event) => event.sessionID === 'ses_slow_index' && event.phase === 'storage_contended'));
    await longIndex;
    assert.ok(events.some((event) => event.sessionID === 'ses_slow_index' && event.phase === 'storage_acquired'));
  });
  heldLock = null;
  await measure('warmIndexMaintenanceBoundary', async () => {
    // Cross the pinned store's periodic 50-insert maintenance threshold on a
    // reused worker; full-index optimization must stay off response completion.
    for (let index = 0; index < 51; index++) {
      assertSuccess(await pool.execute({ name: 'ctx_index', env, projectDir: projects[0], sessionId: 'ses_maintenance',
        args: { content: `maintenancefixture revision ${index}`, source: 'maintenance-boundary' } }));
    }
    const found = assertSuccess(await pool.execute({ name: 'ctx_search', env, projectDir: projects[0], sessionId: 'ses_maintenance_reader',
      args: { queries: ['maintenancefixture'], source: 'maintenance-boundary' } }));
    assert.ok(output(found).includes('revision 50'), output(found));
  });
  await measure('differentProjectsCold30', async () => {
    (await Promise.all(Array.from({ length: 30 }, (_, index) => pool.execute({ name: 'ctx_index',
      args: { content: `# Fixture\nworkerfixture This project owns isolated payload number ${Math.floor(index / 2)}.`, source: `fixture-${index % 2}` },
      env, projectDir: projects[Math.floor(index / 2)], sessionId: `ses_project_${Math.floor(index / 2)}` })))).forEach(assertSuccess);
  });
  await idleLimit();
  const search = output(assertSuccess(await call(0, 'ctx_search', { queries: ['workerfixture'], source: 'fixture-0' })));
  assert.ok(search.includes('isolated payload number 0') && !search.includes('isolated payload number 14'), search);
  const sourceFile = path.join(projects[0], 'fixture.txt');
  await fs.writeFile(sourceFile, 'filefixture Exact file-backed payload.');
  await measure('mixedTools30', async () => {
    const tools = [
      ['ctx_execute', { language: 'javascript', code: 'console.log("execute-fixture-completed");' }],
      ['ctx_execute_file', { path: sourceFile, language: 'javascript', code: 'console.log(FILE_CONTENT);' }],
      ['ctx_batch_execute', { commands: [{ label: 'batch fixture', command: 'echo batchfixture-completed' }], queries: ['batchfixture'], concurrency: 1 }],
      ['ctx_index', { path: sourceFile, source: 'file-fixture' }],
      ['ctx_search', { queries: ['workerfixture'], source: 'fixture-0' }],
      ['ctx_stats', {}],
      ['ctx_fetch_and_index', { url: fetchUrl, source: 'loopback-fixture', force: true, concurrency: 1 }],
    ];
    const mixed = await Promise.all(Array.from({ length: 30 }, (_, index) => {
      const [name, args] = tools[index % tools.length];
      return pool.execute({ name, args, env, projectDir: projects[0], sessionId: `ses_mixed_${Math.floor(index / 2)}` });
    }));
    mixed.forEach(assertSuccess);
    assert.ok(output(mixed[1]).includes('filefixture'), output(mixed[1]));
    assert.ok(output(mixed[6]).includes('loopbackfixture'), output(mixed[6]));
  });
  // Provision a real SessionDB only inside the disposable environment. The
  // "latest" session deliberately differs from the two callers so a regression
  // to latest-session attribution cannot accidentally pass.
  const sessionDbPath = [...pool.state.storage].find(([file, entry]) => file.includes(`${path.sep}sessions${path.sep}`)
    && [...entry.owners].some((slot) => slot.lastCall.projectDir === projects[0]))?.[0];
  assert.ok(sessionDbPath, 'Project SessionDB path must be available');
  const runFixture = async (code) => JSON.parse((await promisify(execFile)(process.execPath, ['--eval', code], {
    cwd: projects[0], env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  })).stdout);
  await runFixture(`const { SessionDB } = await import(${JSON.stringify(pathToFileURL(path.join(build, 'session/db.js')).href)});
    const db = new SessionDB({ dbPath: ${JSON.stringify(sessionDbPath)} });
    for (const id of ['ses_counter_first', 'ses_counter_child', 'ses_counter_latest']) db.ensureSession(id, ${JSON.stringify(projects[0])});
    db.db.prepare("UPDATE session_meta SET started_at = '2099-01-01 00:00:00' WHERE session_id = ?").run('ses_counter_latest');
    db.close(); console.log('null');`);
  await measure('sessionDatabaseAttribution', async () => {
    (await Promise.all(['ses_counter_first', 'ses_counter_child'].map((sessionId) => pool.execute({ name: 'ctx_execute',
      args: { language: 'javascript', code: 'console.log("counter-fixture");' }, env, projectDir: projects[0], sessionId })))).forEach(assertSuccess);
    const counters = await runFixture(`const { Database } = await import('bun:sqlite');
      const db = new Database(${JSON.stringify(sessionDbPath)}, { readonly: true });
      console.log(JSON.stringify(db.query("SELECT session_id, calls FROM tool_calls WHERE tool = 'ctx_execute' AND session_id LIKE 'ses_counter_%' ORDER BY session_id").all())); db.close();`);
    assert.deepEqual(counters, [{ session_id: 'ses_counter_child', calls: 1 }, { session_id: 'ses_counter_first', calls: 1 }]);
  });
  await idleLimit();
  const background = await call(0, 'ctx_execute', { language: 'javascript', code: 'console.log("owned-background");', timeout: 1000, background: true, cwd: projects[0] });
  assert.ok(output(background).includes('backgrounded'), output(background));
  const backgroundSlot = [...pool.workers].find((slot) => slot.processes.size > 0);
  assert.ok(backgroundSlot, 'Background child must be tracked');
  const pids = [...backgroundSlot.processes.keys()];
  assert.ok(pids.length && pids.every(Number.isSafeInteger), 'Process ownership must contain actual PIDs');
  for (let index = 1; index < 6; index++) {
    await call(index, 'ctx_search', { queries: ['workerfixture'], source: 'fixture-0' });
    assert.ok(pool.workers.has(backgroundSlot), 'An active background command must pin its worker');
  }
  // Shorten only the warm command probe, not cold worker initialization.
  const normalBudget = pool.executionTimeoutMs;
  pool.executionTimeoutMs = 1000;
  const timedDefault = await call(0, 'ctx_execute', { language: 'shell', code: 'echo default-budget; sleep 30' });
  assert.ok(timedDefault.isError && output(timedDefault).includes('TIMEOUT'), output(timedDefault));
  assert.ok(pids.every(alive), 'Default timeout killed a previously detached process');
  const timedExplicit = await call(0, 'ctx_execute', { language: 'shell', code: 'echo explicit-budget; sleep 30', timeout: 200 });
  assert.ok(timedExplicit.isError && output(timedExplicit).includes('TIMEOUT'), output(timedExplicit));
  const extended = await call(0, 'ctx_execute', { language: 'shell', code: 'sleep 1.2; echo extended-budget-completed', timeout: 2500 });
  assert.ok(!extended.isError && output(extended).includes('extended-budget-completed'), output(extended));
  pool.executionTimeoutMs = normalBudget;
  // Parallel jobs share one call budget. A later queued job must never write its sentinel.
  const sentinel = path.join(projects[0], 'batch-must-not-run');
  const batch = await call(0, 'ctx_batch_execute', { commands: [
    { label: 'first', command: 'sleep 30' }, { label: 'second', command: 'sleep 30' },
    { label: 'never', command: `touch '${sentinel}'` },
  ], queries: ['timeout'], concurrency: 2, timeout: 200 });
  assert.ok(batch.isError && output(batch).includes('TIMEOUT'), output(batch));
  assert.equal(await fs.stat(sentinel).catch(() => null), null, 'Batch executed a job beyond its deadline');
  for (let iteration = 0; iteration < 3; iteration++) {
    const controller = new AbortController();
    const running = pool.execute({ name: 'ctx_execute', args: { language: 'shell', code: 'echo cancellation-started; sleep 30' },
      env, projectDir: projects[0], sessionId: `ses_cancel_${iteration}`, signal: controller.signal });
    const activeSlot = [...pool.workers].find(slot => slot.active?.sessionId === `ses_cancel_${iteration}`);
    await waitUntil('foreground PID attribution', () => [...activeSlot.processes.values()].includes(activeSlot.active?.id));
    const foregroundPids = [...activeSlot.processes].filter(([, id]) => id === activeSlot.active.id).map(([pid]) => pid);
    const sibling = pool.execute({ name: 'ctx_index', args: { content: 'sibling-completes-during-cancellation', source: 'cancel-sibling' },
      env, projectDir: projects[0], sessionId: `ses_sibling_${iteration}` });
    const runningAssertion = assert.rejects(running, /CANCELLED.*outcome is unknown/);
    const independent = call(1, 'ctx_search', { queries: ['workerfixture'], source: 'fixture-0' });
    controller.abort();
    const [, siblingResult, independentResult] = await Promise.all([runningAssertion, sibling, independent]);
    assertSuccess(siblingResult);
    assertSuccess(independentResult);
    await waitUntil('cancelled foreground stopped and scope recovered', () => foregroundPids.every(pid => !alive(pid)) && !activeSlot.blocked);
    assert.ok(pids.every(alive), 'Cancellation killed another session background command');
    const reopened = await call(0, 'ctx_search', { queries: ['workerfixture'], source: 'fixture-0' });
    assert.ok(output(reopened).includes('isolated payload number 0'), output(reopened));
    await idleLimit();
  }
  // Simulate only this disposable worker crashing. The pool must clean up its
  // tracked background child; it must not rerun the original command.
  await backgroundSlot.worker.terminate();
  for (let index = 0; index < 40 && pids.some(alive); index++) await sleep(25);
  assert.ok(pids.every((pid) => !alive(pid)), 'Crashed worker left an owned child running');
  await waitUntil('crashed worker released after process cleanup', () => !pool.workers.has(backgroundSlot));
  await measure('compiledHostWorkerLaunch', async () => {
    const source = path.join(runRoot, 'compiled-host.mjs');
    const binary = path.join(runRoot, process.platform === 'win32' ? 'compiled-host.exe' : 'compiled-host');
    const config = path.join(runRoot, 'compiled-host.json');
    await fs.writeFile(config, JSON.stringify({ env, projectDir: projects[0], root: runRoot, runtimes,
      workerURL: pathToFileURL(path.join(build, 'devryan-context-mode-worker.js')).href }));
    await fs.writeFile(source, `import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { ContextModeWorkerPool } from ${JSON.stringify(path.join(build, 'devryan-context-mode-worker-pool.js'))};
      const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
      const pool = new ContextModeWorkerPool({ workerURL: new URL(config.workerURL), stateDirectory: config.root,
        runtime: { executable: process.execPath, runtimes: config.runtimes } });
      try {
        const result = await pool.execute({ name: 'ctx_execute', projectDir: config.projectDir, sessionId: 'ses_compiled_host',
          env: config.env, args: { language: 'javascript', code: 'console.log(process.env.BUN_BE_BUN === undefined ? "compiled-worker-env-restored" : "unexpected-cli-mode");' } });
        assert.ok(!result.isError && JSON.stringify(result).includes('compiled-worker-env-restored'));
      } finally {
        await pool.close();
        const end = performance.now() + 10000;
        while (pool.workers.size && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(pool.workers.size, 0);
        await pool.state.disposal;
      }`);
    const run = promisify(execFile);
    await run(process.execPath, ['build', '--compile', source, '--outfile', binary], { env, cwd: runRoot, timeout: 60000 });
    await run(binary, [config], { env, cwd: runRoot, timeout: 30000 });
  });
  assert.ok(!events.some((event) => ['queued', 'queue_timeout'].includes(event.phase)), 'No call may enter a scheduling queue');
  await idleLimit();
  const report = { ok: true, sessions: 15, concurrentCalls: 30, maxActiveWorkers, idleWorkers: pool.workers.size,
    rssScope: 'Sum of verification parent and worker-process RSS; includes shared mappings in each process and excludes spawned commands.',
    peakRssMiB: Math.round(peakRss / 1024 / 1024), eventLoopDelayP95Ms: Math.round(percentile(eventLoopDelays, 0.95)),
    eventLoopDelayMaxMs: Math.round(Math.max(...eventLoopDelays)), phases,
    projectIsolation: true, indexReopening: true, perSessionStats: true, sessionDatabaseAttribution: true, sameLabelReplacement: true,
    sameProjectCancellationIsolation: true, defaultTimeout: true, explicitTimeout: true, extendedTimeout: true,
    parallelBatchDeadline: true, otherSessionBackgroundPreserved: true, crashStopsBackground: true,
    compiledHostWorkerLaunch: true,
    indexingStall: 'A real indexing call held at its storage transaction for 31.1 seconds; sibling reads and execution completed during the hold.',
    caveat: 'Bun can defer reaping an already dead child until runtime exit after a hard worker crash.' };
  await fs.writeFile(path.join(packageRoot, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Context Mode verification failed:', error);
  console.error(JSON.stringify({ phases, workers: [...pool.workers].map((slot) => ({
    tool: slot.active?.name ?? null, exited: slot.exited, blocked: slot.blocked,
    retiring: slot.retiring, quarantined: slot.quarantined === true, processes: slot.processes.size,
  })) }));
  throw error;
} finally {
  clearTimeout(deadline);
  clearTimeout(releaseHeldLock);
  clearInterval(sample);
  clearInterval(memorySample);
  if (heldLock) await fs.unlink(heldLock).catch(() => {});
  await pool.close();
  await waitUntil('all disposable workers exited', () => pool.workers.size === 0);
  await pool.state.disposal;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(runRoot, { recursive: true, force: true });
}
