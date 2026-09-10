import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { deadline } from './devryan-context-mode-worker-pool.js';
import { ContextModeWorkerStorage } from './context-mode-worker-storage.js';
import { statsDelta } from './context-mode-worker-state.js';

let receive;
let initialize;
const requests = [];
const initialized = new Promise((resolve) => { initialize = resolve; });
process.on('message', (request) => {
  if (request?.type === 'initialize') initialize(request.workerData);
  else if (receive) void receive(request);
  else requests.push(request);
});
const parentPort = { postMessage: (message) => process.send?.(message), close: () => process.disconnect?.() };
const workerData = await initialized;
// A compiled OpenCode binary can act as Bun for worker startup. Restore the
// original environment before any user command can inherit this CLI switch.
if (workerData.bunCliMode) {
  if (typeof workerData.inheritedBunMode === 'string') process.env.BUN_BE_BUN = workerData.inheritedBunMode;
  else delete process.env.BUN_BE_BUN;
}

if (process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== '1'
  || process.env.CONTEXT_MODE_PROJECT_DIR !== workerData.projectDir) {
  throw new Error('Context Mode worker environment isolation is unavailable');
}

const calls = new AsyncLocalStorage();
const ownedProcesses = new Set();
globalThis[Symbol.for('devryan.context-mode.runtimes')] = workerData.runtimes;
globalThis[Symbol.for('devryan.context-mode.call')] = () => calls.getStore();
globalThis[Symbol.for('devryan.context-mode.storage')] = () => calls.getStore()?.storage;
globalThis[Symbol.for('devryan.context-mode.session-db')] = (path) => {
  const db = calls.getStore()?.sessionDb;
  return db?.dbPath === path ? db : undefined;
};
globalThis[Symbol.for('devryan.context-mode.process')] = (event) => {
  if (event.running) ownedProcesses.add(event.pid);
  else ownedProcesses.delete(event.pid);
  parentPort.postMessage({ type: 'process', ...event });
};
let closing = false;
process.on('disconnect', () => {
  if (closing) return;
  // Also handle an abruptly lost parent. Each command has its own process
  // group; killing this worker's children cannot touch a sibling worker.
  for (const pid of ownedProcesses) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 2000 });
      else process.kill(-pid, 'SIGKILL');
    } catch { /* Best effort after parent loss. */ }
  }
  process.exit(1);
});
// Attach an import rejection handler immediately; report it through the exact
// call rather than leaking an unhandled rejection while waiting for dispatch.
const ready = import('./server.js').then((module) => ({ module }), (error) => ({ error }));
let active = null;
receive = async (request) => {
  if (request?.type === 'prepared') {
    if (active?.id === request.id) active.prepared?.(request);
    return;
  }
  if (request?.type === 'prepare_failed') {
    if (active?.id === request.id) active.prepareFailed?.(new Error('worker storage initialization failed'));
    return;
  }
  if (request?.type === 'cancel') {
    if (active?.id === request.id) { active.controller.abort(); active.prepared?.(null); }
    return;
  }
  if (request?.type === 'close') {
    if (active) return;
    const loaded = await ready;
    if (loaded.module) loaded.module.devryanCloseWorker();
    closing = true;
    parentPort.postMessage({ type: 'closed' });
    parentPort.close();
    return;
  }
  if (request?.type !== 'execute') return;
  if (active || request.projectDir !== workerData.projectDir || request.scope !== workerData.scope
    || typeof request.sessionId !== 'string' || !request.sessionId
    || !Number.isFinite(request.budgetMs) || request.budgetMs <= 0) {
    parentPort.postMessage({ type: 'error', id: request.id, error: 'invalid worker scope or concurrent dispatch' });
    return;
  }
  const call = { id: request.id, controller: new AbortController(), started: performance.now(), budget: request.budgetMs };
  active = call;
  let mod;
  let statsBefore;
  const reportStats = () => {
    if (!statsBefore) return;
    parentPort.postMessage({ type: 'stats', id: call.id,
      delta: statsDelta(statsBefore, mod.devryanWorkerStats()), price: mod.devryanStatsPrice(), lifetimeTokens: mod.devryanStatsLifetime() });
    statsBefore = null;
  };
  try {
    parentPort.postMessage({ type: 'phase', id: call.id, phase: 'initializing' });
    const loaded = await ready;
    call.controller.signal.throwIfAborted();
    if (loaded.error) throw loaded.error;
    mod = loaded.module;
    const registered = mod.REGISTERED_CTX_TOOLS.find((tool) => tool.name === request.name);
    if (!registered) throw new Error('unknown Context Mode tool');
    const remainingMs = () => Math.max(0, call.budget - (performance.now() - call.started));
    const storage = new ContextModeWorkerStorage({ remainingMs,
      onContention: (phase) => {
        if (phase === 'storage_contended' && !call.contentionReported) {
          call.contentionReported = true;
          parentPort.postMessage({ type: 'phase', id: call.id, phase });
        } else if (phase === 'storage_acquired' && !call.acquisitionReported) {
          call.acquisitionReported = true;
          parentPort.postMessage({ type: 'phase', id: call.id, phase });
        }
      } });
    const result = await calls.run({ id: call.id, sessionId: request.sessionId, projectDir: request.projectDir, signal: call.controller.signal, deadline,
      onTimeout: () => { call.timedOut = true; },
      onExecutionFailure: (failure) => parentPort.postMessage({ type: 'execution_failure', id: call.id, ...failure }), remainingMs, storage },
    () => mod.withProjectDirOverride({ projectDir: request.projectDir, sessionId: request.sessionId }, async () => {
      const prepared = await new Promise((resolve, reject) => {
        call.prepared = resolve;
        call.prepareFailed = reject;
        parentPort.postMessage({ type: 'prepare', id: call.id, ...mod.devryanWorkerPaths() });
      });
      call.controller.signal.throwIfAborted();
      storage.configure(prepared);
      calls.getStore().sessionDb = mod.devryanPrepareWorkerSession();
      statsBefore = prepared.stats;
      mod.devryanRestoreWorkerStats(statsBefore);
      parentPort.postMessage({ type: 'phase', id: call.id, phase: 'executing' });
      try { return await registered.handler(request.args); }
      finally {
        // The adapter schedules bounded SessionDB capture on setImmediate.
        // Drain that turn before reuse/retirement can reset attribution or
        // terminate the worker; lifetime scans and JSON persistence stay off it.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }));
    reportStats();
    if (!call.controller.signal.aborted) parentPort.postMessage({ type: 'result', id: call.id,
      result: call.timedOut ? { isError: true, content: [
        { type: 'text', text: 'Context Mode worker: TIMEOUT: command budget exceeded. Execution outcome is unknown; inspect state before any mutation or retry. This call was not replayed. Use permitted native read/search tools.' },
        ...(Array.isArray(result?.content) ? result.content : []),
      ] } : result });
  } catch (error) {
    reportStats();
    if (!call.controller.signal.aborted) parentPort.postMessage({ type: 'error', id: call.id,
      error: typeof error?.message === 'string' ? error.message : 'tool execution failed; outcome may be unknown' });
  } finally {
    reportStats();
    active = null;
    if (call.controller.signal.aborted) parentPort.postMessage({ type: 'cancelled', id: call.id });
  }
};
for (const request of requests.splice(0)) void receive(request);
