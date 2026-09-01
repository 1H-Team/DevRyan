import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MAX_WORKERS = 4;
const MAX_QUEUE = 32;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const failure = (message) => new Error(`Context Mode worker: ${message}`);

// One pool per runtime, shared by all project plugin instances. A worker owns
// exactly one project/storage scope because upstream caches its ContentStore.
export class ContextModeWorkerPool {
  constructor({ workerURL = new URL('./devryan-context-mode-worker.js', import.meta.url), WorkerClass = Worker,
    maxWorkers = MAX_WORKERS, maxQueue = MAX_QUEUE, maxQueuedBytes = MAX_QUEUED_BYTES } = {}) {
    this.workerURL = workerURL;
    this.WorkerClass = WorkerClass;
    this.maxWorkers = Math.min(MAX_WORKERS, maxWorkers);
    this.maxQueue = Math.min(MAX_QUEUE, maxQueue);
    this.maxQueuedBytes = Math.min(MAX_QUEUED_BYTES, maxQueuedBytes);
    this.workers = new Set();
    this.queue = [];
    this.queuedBytes = 0;
    this.closed = false;
  }

  execute({ name, args, projectDir, sessionId, signal, env = process.env }) {
    if (this.closed) return Promise.reject(failure('pool is closed'));
    if (!isAbsolute(projectDir || '') || !sessionId || typeof sessionId !== 'string') {
      return Promise.reject(failure('an absolute project directory and initiating session are required'));
    }
    if (signal?.aborted) return Promise.reject(failure('cancelled before execution'));
    // Do not change storage locations: inherit precisely the managed runtime's
    // environment, including existing legacy/default storage resolution.
    const scope = JSON.stringify([projectDir, env.CONTEXT_MODE_DIR, env.CONTEXT_MODE_DATA_DIR, env.OPENCODE_CONFIG_DIR,
      env.OPENCHAMBER_DATA_DIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.HOME]);
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(args)); }
    catch { return Promise.reject(failure('arguments are not serializable')); }
    if (this.queue.length >= this.maxQueue || bytes + this.queuedBytes > this.maxQueuedBytes) {
      return Promise.reject(failure('queue capacity exceeded; this call was not executed'));
    }
    return new Promise((resolve, reject) => {
      const call = { id: randomUUID(), name, args, projectDir, sessionId, scope, env: { ...env }, bytes, resolve, reject,
        clearAbort: () => signal?.removeEventListener('abort', abortQueued) };
      const abortQueued = () => {
        const index = this.queue.indexOf(call);
        if (index < 0) return; // Already executing: never terminate or replay it.
        this.queue.splice(index, 1);
        this.queuedBytes -= call.bytes;
        call.clearAbort();
        reject(failure('cancelled before execution'));
        this.drain();
      };
      this.queue.push(call);
      signal?.addEventListener('abort', abortQueued, { once: true });
      this.queuedBytes += bytes;
      this.drain();
    });
  }

  spawn(call) {
    const worker = new this.WorkerClass(this.workerURL, {
      env: { ...call.env, CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS: '1', CONTEXT_MODE_PROJECT_DIR: call.projectDir },
      workerData: { projectDir: call.projectDir, scope: call.scope },
    });
    const slot = { worker, scope: call.scope, active: null, processes: new Set(), retiring: false, used: 0 };
    this.workers.add(slot);
    worker.on('message', (message) => {
      if (message?.type === 'closed' && slot.retiring) {
        // Bun can retain a worker after parentPort.close(). Wait for database
        // flush/close acknowledgment, then release only this idle worker.
        void worker.terminate();
        return;
      }
      if (message?.type === 'process' && Number.isSafeInteger(message.pid) && message.pid > 0) {
        if (message.running) slot.processes.add(message.pid);
        else slot.processes.delete(message.pid);
        this.drain();
        return;
      }
      if (message?.id !== slot.active?.id) return;
      const active = slot.active;
      slot.active = null;
      slot.used = Date.now();
      if (message.type === 'result') active.resolve(message.result);
      else active.reject(failure(message.error || 'execution failed; outcome may be unknown'));
      this.drain();
    });
    const failed = () => {
      if (!this.workers.delete(slot)) return;
      this.killProcesses(slot);
      slot.active?.reject(failure('worker exited; execution outcome is unknown. This call was not replayed.'));
      slot.active = null;
      this.drain();
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    worker.unref?.();
    return slot;
  }

  killProcesses(slot) {
    for (const pid of slot.processes) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 2000 });
        } else {
          // The owning worker has failed or the runtime is shutting down.
          // Do not allow a child that ignores SIGTERM to keep mutating files.
          process.kill(-pid, 'SIGKILL');
        }
      }
      catch { /* Already exited. */ }
    }
    slot.processes.clear();
  }

  drain() {
    if (this.closed) return;
    for (let index = 0; index < this.queue.length;) {
      const call = this.queue[index];
      let slot = [...this.workers].find((candidate) => candidate.scope === call.scope);
      if (slot?.active || slot?.retiring) { index += 1; continue; }
      if (!slot && this.workers.size < this.maxWorkers) {
        try { slot = this.spawn(call); }
        catch { this.queue.splice(index, 1); this.queuedBytes -= call.bytes; call.clearAbort(); call.reject(failure('could not start worker; call was not executed')); continue; }
      }
      if (!slot) {
        const idle = [...this.workers].filter((candidate) => !candidate.active && !candidate.retiring
          && candidate.processes.size === 0 && !this.queue.some((pending) => pending.scope === candidate.scope))
          .sort((a, b) => a.used - b.used)[0];
        if (idle) {
          idle.retiring = true;
          idle.worker.postMessage({ type: 'close' });
        }
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.queuedBytes -= call.bytes;
      call.clearAbort();
      slot.active = call;
      try {
        slot.worker.postMessage({ type: 'execute', id: call.id, name: call.name, args: call.args,
          projectDir: call.projectDir, sessionId: call.sessionId, scope: call.scope });
      } catch {
        slot.active = null;
        call.reject(failure('dispatch failed; call was not replayed'));
      }
    }
  }

  async close() {
    this.closed = true;
    for (const call of this.queue.splice(0)) { call.clearAbort(); call.reject(failure('runtime shutting down; queued call was not executed')); }
    this.queuedBytes = 0;
    await Promise.all([...this.workers].map(async (slot) => {
      slot.active?.reject(failure('runtime shutting down; execution outcome is unknown'));
      slot.active = null;
      this.killProcesses(slot);
      await slot.worker.terminate();
    }));
  }
}

const poolKey = Symbol.for('devryan.context-mode.worker-pool');
export function executeContextModeTool(request) {
  if (!globalThis[poolKey]) {
    const pool = new ContextModeWorkerPool();
    globalThis[poolKey] = pool;
    process.once('exit', () => { for (const slot of pool.workers) pool.killProcesses(slot); });
  }
  return globalThis[poolKey].execute(request);
}
