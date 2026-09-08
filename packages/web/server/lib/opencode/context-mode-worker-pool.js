import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { ContextModeWorkerState } from './context-mode-worker-state.js';
import { ContextModeWorkerProcess } from './context-mode-worker-process.js';

const MAX_IDLE_WORKERS = 4;
const EXECUTION_TOOLS = new Set(['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute']);
const failure = (code, message) => Object.assign(new Error(`Context Mode worker: ${code}: ${message}`), { code });
const NOT_EXECUTED = 'This call was not executed. Use permitted native read/search tools.';
const UNKNOWN = 'Execution outcome is unknown. This call was not replayed. Inspect state before any mutation or retry; use permitted native read/search tools.';

// Avoid Node/Bun's signed-32-bit timer overflow for explicit long budgets.
export const deadline = (ms, callback) => {
  const start = performance.now();
  let timer;
  const arm = () => {
    const remaining = ms - (performance.now() - start);
    if (remaining <= 0) { callback(); return; }
    timer = setTimeout(arm, Math.min(remaining, 2 ** 31 - 1));
    timer.unref?.();
  };
  timer = setTimeout(arm, Math.min(ms, 2 ** 31 - 1));
  timer.unref?.();
  return () => clearTimeout(timer);
};

const stopProcess = (pid) => {
  if (process.platform === 'win32') {
    // Never block unrelated sessions on synchronous taskkill subprocesses.
    return new Promise((resolve) => execFile('taskkill', ['/F', '/T', '/PID', String(pid)],
      { timeout: 2000, windowsHide: true }, (error) => resolve(!error)));
  }
  try { process.kill(-pid, 'SIGKILL'); return true; }
  catch { return false; } // An independent probe must prove cleanup.
};
const processGone = (pid) => {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  if (process.platform === 'win32') return false;
  // Bun can defer reaping dead children after a worker crash. A process group
  // containing only zombies is settled; a failed probe never proves cleanup.
  return new Promise((resolve) => execFile('ps', ['-axo', 'pgid=,stat='], {
    encoding: 'utf8', timeout: 500, maxBuffer: 4 * 1024 * 1024,
  }, (error, output) => {
    if (error) { resolve(false); return; }
    resolve(!output.trim().split('\n').some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith('Z');
    }));
  }));
};

// One pool per runtime. Only idle retention is capped; calls never wait for a worker.
export class ContextModeWorkerPool {
  constructor({ workerURL = new URL('./devryan-context-mode-worker.js', import.meta.url), WorkerClass = ContextModeWorkerProcess,
    maxIdleWorkers = MAX_IDLE_WORKERS, idleTimeoutMs = 30_000,
    executionTimeoutMs = 120_000, cleanupTimeoutMs = 5_000,
    onEvent = () => {}, runtime, stateDirectory, requireStopReceipt = process.platform === 'win32', stopProcess: stop = stopProcess, processGone: gone = processGone } = {}) {
    for (const value of [maxIdleWorkers, idleTimeoutMs, executionTimeoutMs, cleanupTimeoutMs]) {
      if (!Number.isFinite(value) || value < 1) throw new RangeError('Worker limits must be positive and finite');
    }
    Object.assign(this, { workerURL, WorkerClass, runtime, idleTimeoutMs, executionTimeoutMs, cleanupTimeoutMs, onEvent, requireStopReceipt,
      stopProcess: stop, processGone: gone });
    this.maxIdleWorkers = Math.min(MAX_IDLE_WORKERS, Math.floor(maxIdleWorkers));
    this.workers = new Set();
    this.state = new ContextModeWorkerState({ directory: stateDirectory });
    this.nextOwner = 1;
    this.closed = false;
  }

  emit(call, phase) {
    if (!call) return;
    try {
      this.onEvent({ phase, sessionID: call.sessionId, callID: call.callId, messageID: call.messageId, workerCallID: call.id,
        tool: call.name, sequence: (call.sequence = (call.sequence || 0) + 1), sourceAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - call.createdAt)), budgetMs: call.budget });
    } catch { /* Diagnostics cannot prevent settlement. */ }
  }

  settle(call, error, result) {
    if (call.settled) return;
    call.settled = true;
    call.clearTimer?.();
    call.clearAbort();
    const { reject, resolve } = call;
    call.reject = null;
    call.resolve = null;
    if (error) reject(error);
    else resolve(result);
  }

  execute({ name, args, projectDir, sessionId, callId, messageId, onStart, signal, runtime = this.runtime, env = process.env }) {
    const reject = (code, message) => Promise.reject(failure(code, message));
    if (this.closed) return reject('UNAVAILABLE', `pool is closed. ${NOT_EXECUTED}`);
    if (!isAbsolute(projectDir || '') || !sessionId || typeof sessionId !== 'string') {
      return reject('INVALID_REQUEST', 'an absolute project directory and initiating session are required');
    }
    if (signal?.aborted) return reject('CANCELLED', `cancelled before execution. ${NOT_EXECUTED}`);
    let budget = this.executionTimeoutMs;
    if (EXECUTION_TOOLS.has(name) && args?.timeout !== undefined) {
      if (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0) {
        return reject('INVALID_TIMEOUT', `timeout must be positive and finite. ${NOT_EXECUTED}`);
      }
      budget = args.timeout;
    }
    const scope = JSON.stringify([projectDir, env.CONTEXT_MODE_DIR, env.CONTEXT_MODE_DATA_DIR, env.OPENCODE_CONFIG_DIR,
      env.OPENCHAMBER_DATA_DIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.HOME]);
    const effectiveArgs = EXECUTION_TOOLS.has(name) ? { ...args, timeout: budget } : args;
    try { JSON.stringify(effectiveArgs); }
    catch { return reject('INVALID_REQUEST', `arguments are not serializable. ${NOT_EXECUTED}`); }
    return new Promise((resolve, rejectCall) => {
      const call = { id: randomUUID(), callId: typeof callId === 'string' ? callId : null, messageId: typeof messageId === 'string' ? messageId : null, name,
        projectDir, sessionId, scope, env: { ...env }, runtime, budget, createdAt: performance.now(), resolve, reject: rejectCall,
        settled: false, clearAbort: () => signal?.removeEventListener('abort', abort) };
      const abort = () => {
        if (call.slot?.active === call) this.cancel(call.slot, 'CANCELLED');
      };
      try { onStart?.(call.id); } catch { /* Metadata is diagnostic, never execution authority. */ }
      if (signal?.aborted) {
        this.settle(call, failure('CANCELLED', `cancelled before execution. ${NOT_EXECUTED}`));
        return;
      }
      let slot = [...this.workers].find((candidate) => candidate.scope === scope
        && !candidate.active && !candidate.blocked && !candidate.retiring);
      if (slot) this.emit(call, 'worker_reused');
      else {
        try { slot = this.spawn(call); this.emit(call, 'worker_started'); }
        catch (error) {
          this.emit(call, 'unavailable');
          const reason = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? ` (${error.code})` : '';
          this.settle(call, failure('UNAVAILABLE', `could not start worker${reason}. ${NOT_EXECUTED}`));
          return;
        }
      }
      slot.clearIdle?.();
      call.env = undefined; // Worker creation copied it; retain only bounded lifecycle metadata.
      slot.clearIdle = null;
      slot.active = call;
      slot.lastCall = call;
      slot.cleanupAck = false;
      slot.cancellationPath = null;
      call.slot = slot;
      signal?.addEventListener('abort', abort, { once: true });
      const watchdogMs = budget + (EXECUTION_TOOLS.has(name) ? this.cleanupTimeoutMs : 0);
      call.clearTimer = deadline(watchdogMs, () => this.cancel(slot, 'TIMEOUT'));
      this.emit(call, 'dispatched');
      try {
        slot.worker.postMessage({ type: 'execute', id: call.id, name, args: effectiveArgs,
          projectDir, sessionId, scope, budgetMs: budget });
      } catch { this.cancel(slot, 'DISPATCH_FAILED'); }

    });
  }

  spawn(call) {
    const owner = this.nextOwner++;
    const worker = new this.WorkerClass(this.workerURL, {
      env: { ...call.env, CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS: '1', CONTEXT_MODE_PROJECT_DIR: call.projectDir },
      execPath: call.runtime?.executable,
      workerData: { projectDir: call.projectDir, scope: call.scope, owner, runtimes: call.runtime?.runtimes },
    });
    const slot = { worker, owner, cancellation: null, scope: call.scope, active: null, processes: new Map(), stopReceipts: new Map(), retiring: false, blocked: false,
      exited: false, used: 0, lastCall: call, cleanupAck: false };
    this.workers.add(slot);
    worker.on('message', (message) => this.message(slot, message));
    worker.on('error', () => {
      if (!this.workers.has(slot)) return;
      if (slot.active) this.cancel(slot, 'WORKER_EXITED');
      this.terminate(slot);
    });
    worker.on('exit', () => {
      slot.exited = true;
      slot.exitedAt = performance.now();
      if (!this.workers.has(slot)) return;
      if (slot.active && !slot.active.settled) {
        this.emit(slot.active, 'worker_exit');
        this.settle(slot.active, failure('WORKER_EXITED', UNKNOWN));
      }
      slot.blocked = true;
      this.killProcesses(slot);
      const released = this.state.release(slot);
      if (released) void released.then(() => this.releaseExited(slot));
      else this.releaseExited(slot);
    });
    try { worker.unref?.(); } catch { /* Keepalive hints cannot prevent dispatch. */ }
    return slot;
  }

  message(slot, message) {
    if (!this.workers.has(slot)) return;
    // The worker closes its own message port after cleanup. Let its event loop
    // drain normally; forcing termination here can interrupt native fetch/child
    // cleanup in Bun. The retirement watchdog still bounds a stuck exit.
    if (message?.type === 'closed' && slot.retiring) return;
    if (message?.type === 'process' && Number.isSafeInteger(message.pid) && message.pid > 0) {
      if (message.running) {
        slot.clearIdle?.();
        slot.clearIdle = null;
        if (slot.processes.get(message.pid) !== message.id) slot.stopReceipts.delete(message.pid);
        slot.processes.set(message.pid, message.id);
        if (slot.blocked && message.id === slot.active?.id) this.stopOwnedProcess(slot, message.pid);
      } else if (slot.processes.get(message.pid) === message.id) {
        if (!slot.blocked) { slot.processes.delete(message.pid); slot.stopReceipts.delete(message.pid); }
        else this.probeProcess(slot, message.pid, message.id, () => this.finishCleanup(slot));
      }
      if (slot.exited) this.releaseExited(slot);
      else if (slot.blocked) {
        this.finishCleanup(slot);
        if (slot.quarantined && ![...slot.processes.values()].some((owner) => owner !== slot.active?.id)) this.terminate(slot);
      }
      this.trimIdle();
      return;
    }
    const call = slot.active;
    if (!call || message?.id !== call.id) return;
    if (message.type === 'prepare' && !slot.blocked && !call.preparing) {
      call.preparing = true;
      void this.state.prepare(slot, message).then((state) => {
        if (slot.active === call && !slot.blocked) slot.worker.postMessage({ type: 'prepared', id: call.id, ...state });
      }).catch(() => {
        if (slot.active === call && !slot.blocked) {
          try { slot.worker.postMessage({ type: 'prepare_failed', id: call.id }); }
          catch { this.cancel(slot, 'DISPATCH_FAILED'); }
        }
      });
      return;
    }
    if (message.type === 'stats' && !call.statsRecorded) {
      call.statsRecorded = true;
      this.state.update(slot, message.delta, message);
      return;
    }
    if (message.type === 'phase' && ['initializing', 'executing', 'storage_contended', 'storage_acquired'].includes(message.phase)) {
      this.emit(call, message.phase); return;
    }
    if (message.type === 'cancelled') {
      if (!slot.blocked) return;
      slot.cleanupAck = true;
      this.finishCleanup(slot);
      return;
    }
    if (!['result', 'error'].includes(message.type)) return;
    if (slot.blocked) {
      // A result can race cancellation. It proves handler settlement, never a
      // successful result for the already failed caller.
      slot.cleanupAck = true;
      this.finishCleanup(slot);
      return;
    }
    slot.active = null;
    slot.used = performance.now();
    this.emit(call, message.type === 'result' && !message.result?.isError ? 'completed' : 'failed');
    this.settle(call, message.type === 'error' ? failure('EXECUTION_FAILED', message.error || UNKNOWN) : null, message.result);
    this.trimIdle();
  }

  cancel(slot, code) {
    if (slot.blocked || !slot.active) return;
    slot.blocked = true;
    this.signalCancellation(slot);
    slot.cleanupAck = false;
    const call = slot.active;
    this.emit(call, code === 'TIMEOUT' ? 'timeout' : 'cancelled');
    this.settle(call, failure(code, UNKNOWN));
    slot.clearCleanup = deadline(this.cleanupTimeoutMs, () => {
      if (!this.workers.has(slot) || !slot.blocked) return;
      // Do not kill another session's successfully backgrounded command.
      if ([...slot.processes.values()].some((owner) => owner !== call.id)) this.quarantine(slot);
      else this.terminate(slot);
    });
    for (const [pid, owner] of slot.processes) if (owner === call.id) this.stopOwnedProcess(slot, pid);
    try { slot.worker.postMessage({ type: 'cancel', id: call.id }); } catch { /* Parent cleanup remains authoritative. */ }
  }

  finishCleanup(slot) {
    if (slot.terminating || slot.exited || slot.retiring || !slot.cleanupAck || [...slot.processes.values()].some((id) => id === slot.active?.id)) return;
    slot.clearCleanup?.();
    slot.active = null;
    slot.blocked = false;
    slot.quarantined = false;
    slot.used = performance.now();
    this.emit(slot.lastCall, 'recovered');
    this.trimIdle();
  }

  quarantine(slot) {
    slot.clearCleanup?.();
    slot.blocked = true;
    if (!slot.quarantined) this.emit(slot.active || slot.lastCall, 'quarantined');
    slot.quarantined = true;
    // Shutdown can race the first process-group probe. Keep accepting later
    // cleanup proof even after admission closes; timers remain unreferenced.
    if (slot.exited) slot.clearCleanup = deadline(1000, () => this.releaseExited(slot));
  }

  terminate(slot) {
    if (slot.terminating) return;
    slot.clearIdle?.();
    slot.clearIdle = null;
    slot.terminating = true;
    slot.blocked = true;
    slot.clearCleanup?.();
    slot.clearCleanup = deadline(this.cleanupTimeoutMs, () => this.quarantine(slot));
    try { Promise.resolve(slot.worker.terminate()).catch(() => this.quarantine(slot)); }
    catch { this.quarantine(slot); }
  }

  probeProcess(slot, pid, owner, complete = () => {}) {
    const accept = (gone) => {
      if (gone === true && slot.processes.get(pid) === owner) { slot.processes.delete(pid); slot.stopReceipts.delete(pid); }
      complete();
    };
    try {
      const observed = this.processGone(pid);
      // Windows has no process-group probe. PID disappearance alone does not
      // prove that taskkill finished terminating the descendant tree.
      const result = this.requireStopReceipt
        ? Promise.all([observed, slot.stopReceipts.get(pid)]).then(([gone, stopped]) => gone === true && stopped === true)
        : observed;
      if (result && typeof result.then === 'function') return result.then(accept, () => complete());
      accept(result);
    } catch { complete(); }
  }

  releaseExited(slot) {
    if (slot.probing || !this.workers.has(slot)) return;
    slot.probing = true;
    const pending = [];
    for (const [pid, owner] of slot.processes) {
      const probe = this.probeProcess(slot, pid, owner);
      if (probe) pending.push(probe);
    }
    const finish = () => {
      slot.probing = false;
      if (!this.workers.has(slot)) return;
      if (slot.processes.size) {
        slot.clearCleanup?.();
        if (performance.now() - slot.exitedAt >= this.cleanupTimeoutMs) this.quarantine(slot);
        else slot.clearCleanup = deadline(50, () => this.releaseExited(slot));
        return;
      }
      slot.clearCleanup?.();
      this.workers.delete(slot);
      this.emit(slot.active || slot.lastCall, slot.retiring ? 'worker_retired' : 'recovered');
      slot.active = null;
      this.trimIdle();
      if (this.closed && !this.workers.size) void this.state.dispose();
    };
    if (pending.length) void Promise.all(pending).then(finish);
    else finish();
  }

  retire(slot) {
    if (slot.retiring || slot.blocked || slot.active || slot.processes.size) return;
    slot.clearIdle?.();
    slot.clearIdle = null;
    slot.retiring = true;
    this.emit(slot.lastCall, 'worker_retiring');
    slot.clearCleanup = deadline(this.cleanupTimeoutMs, () => this.terminate(slot));
    try { slot.worker.postMessage({ type: 'close' }); } catch { this.terminate(slot); }
  }

  trimIdle() {
    if (this.closed) return;
    const idle = [...this.workers].filter((slot) => !slot.active && !slot.retiring && !slot.blocked && slot.processes.size === 0)
      .sort((a, b) => b.used - a.used);
    for (const [index, slot] of idle.entries()) {
      if (index >= this.maxIdleWorkers) this.retire(slot);
      else if (!slot.clearIdle) slot.clearIdle = deadline(this.idleTimeoutMs, () => {
        slot.clearIdle = null;
        this.retire(slot);
      });
    }
  }

  stopOwnedProcess(slot, pid) {
    if (slot.stopReceipts.has(pid)) return;
    try { slot.stopReceipts.set(pid, Promise.resolve(this.stopProcess(pid)).catch(() => false)); }
    catch { slot.stopReceipts.set(pid, Promise.resolve(false)); }
  }

  killProcesses(slot) { for (const pid of slot.processes.keys()) this.stopOwnedProcess(slot, pid); }

  signalCancellation(slot) {
    if (!slot.cancellationPath) return;
    try { fs.writeFileSync(slot.cancellationPath, '1', { mode: 0o600 }); }
    catch { /* The IPC abort and bounded process termination remain authoritative. */ }
  }

  async close() {
    this.closed = true;
    for (const slot of this.workers) {
      if (slot.active) {
        this.signalCancellation(slot);
        try { slot.worker.postMessage({ type: 'cancel', id: slot.active.id }); } catch { /* Termination is still required. */ }
        this.settle(slot.active, failure('UNAVAILABLE', `runtime shutting down. ${UNKNOWN}`));
      }
      this.killProcesses(slot);
      this.terminate(slot);
    }
    await this.state.close();
    if (!this.workers.size) await this.state.dispose();
  }
}

const poolKey = Symbol.for('devryan.context-mode.worker-pool');
const diagnosticQueue = [];
let diagnosticsSending = false;
let droppedEvents = 0;
const reportEvent = (event) => {
  const rawUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
  const token = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  if (!rawUrl || !token) return;
  let url;
  try { url = new URL(rawUrl); } catch { return; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') return;
  if (diagnosticQueue.length >= 128) { droppedEvents++; return; }
  diagnosticQueue.push(event);
  if (diagnosticsSending) return;
  diagnosticsSending = true;
  void (async () => {
    try {
      while (diagnosticQueue.length) {
        const next = diagnosticQueue.shift();
        const lost = droppedEvents;
        try {
          const response = await fetch(url, { method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'context_mode_diagnostic', params: { ...next, droppedEvents: lost } }),
            signal: AbortSignal.timeout(2000),
          });
          await response.body?.cancel();
          if (response.ok) droppedEvents -= lost;
          else droppedEvents++;
        } catch { droppedEvents++; }
      }
    } finally { diagnosticsSending = false; }
  })();
};
export function executeContextModeTool(request) {
  if (!globalThis[poolKey]) {
    const pool = new ContextModeWorkerPool({ onEvent: reportEvent });
    globalThis[poolKey] = pool;
    process.once('exit', () => {
      for (const slot of pool.workers) {
        if (process.platform !== 'win32') { pool.killProcesses(slot); continue; }
        // The process exit hook cannot await asynchronous taskkill receipts.
        for (const pid of slot.processes.keys()) {
          try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 2000, windowsHide: true }); }
          catch { /* Best effort at process exit; never claim successful recovery. */ }
        }
      }
    });
  }
  return globalThis[poolKey].execute(request);
}
