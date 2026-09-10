import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextModeWorkerPool } from './context-mode-worker-pool.js';
import { WORKER_POOL_SOURCE, WORKER_SOURCE, WORKER_STATE_SOURCE, WORKER_STORAGE_SOURCE, WORKER_PROCESS_SOURCE, EXECUTION_SOURCE } from './context-mode-worker-sources.js';

class FakeWorker extends EventEmitter {
  static instances = [];
  messages = [];
  constructor(url, options) { super(); this.options = options; FakeWorker.instances.push(this); }
  postMessage(message) { this.messages.push(message); if (message.type === 'close') queueMicrotask(() => { this.emit('message', { type: 'closed' }); this.emit('exit', 0); }); }
  complete(result = 'ok') { this.emit('message', { type: 'result', id: this.messages.at(-1).id, result }); }
  async terminate() { this.emit('exit', 0); }
}
const pools = [];
const pool = (options) => { const result = new ContextModeWorkerPool({ WorkerClass: FakeWorker, ...options }); pools.push(result); return result; };
const call = (projectDir = '/repo', sessionId = 'ses_one', args = {}) => ({ name: 'ctx_index', projectDir, sessionId, args, env: { CONTEXT_MODE_DIR: '/isolated/data' } });
afterEach(async () => { await Promise.all(pools.splice(0).map((item) => item.close())); FakeWorker.instances = []; });

describe('Context Mode worker isolation', () => {
  it('never reuses a worker with a different explicit heap option', async () => {
    const runtime = pool();
    const first = runtime.execute({ ...call(), env: { NODE_OPTIONS: '--max-old-space-size=256' } });
    FakeWorker.instances[0].complete();
    await first;
    const second = runtime.execute({ ...call(), env: {} });
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].complete();
    await second;
  });

  it('ships identical helpers in bundled web provisioning', () => {
    expect(EXECUTION_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-execution.js', import.meta.url), 'utf8'));
    expect(WORKER_POOL_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker-pool.js', import.meta.url), 'utf8'));
    expect(WORKER_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker.js', import.meta.url), 'utf8'));
    expect(WORKER_STATE_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker-state.js', import.meta.url), 'utf8'));
    expect(WORKER_STORAGE_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker-storage.js', import.meta.url), 'utf8'));
    expect(WORKER_PROCESS_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker-process.js', import.meta.url), 'utf8'));
  });
  it.each([true, false])('dispatches two calls from each of fifteen sessions immediately (same project: %s)', async (sameProject) => {
    const runtime = pool();
    const tools = ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_index', 'ctx_search', 'ctx_stats', 'ctx_fetch_and_index'];
    const calls = Array.from({ length: 30 }, (_, index) => runtime.execute({
      ...call(sameProject ? '/repo' : `/repo${Math.floor(index / 2)}`, `ses_${Math.floor(index / 2)}`),
      name: tools[index % tools.length],
    }));
    expect(FakeWorker.instances).toHaveLength(30);
    expect(runtime.workers.size).toBe(30);
    expect(FakeWorker.instances.every((worker) => worker.messages.length === 1)).toBe(true);
    expect(FakeWorker.instances.map((worker) => worker.messages[0].sessionId))
      .toEqual(Array.from({ length: 30 }, (_, index) => `ses_${Math.floor(index / 2)}`));
    for (const worker of FakeWorker.instances) worker.complete();
    await Promise.all(calls);
    await Promise.resolve();
    expect(runtime.workers.size).toBe(4);
    expect([...runtime.workers].every((slot) => !slot.active)).toBe(true);
  });
  it('reuses an idle compatible worker while separating different storage environments', async () => {
    const runtime = pool();
    const first = runtime.execute(call());
    FakeWorker.instances[0].complete('first');
    await first;
    const second = runtime.execute(call('/repo', 'ses_two'));
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].messages.at(-1).sessionId).toBe('ses_two');
    const other = runtime.execute({ ...call(), env: { CONTEXT_MODE_DIR: '/other/data' } });
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].options.env.CONTEXT_MODE_DIR).toBe('/other/data');
    for (const worker of FakeWorker.instances) worker.complete();
    await Promise.all([second, other]);
  });
  it('never evicts a worker while a background process is alive', async () => {
    const runtime = pool({ maxIdleWorkers: 1 });
    const running = runtime.execute(call());
    const worker = FakeWorker.instances[0];
    worker.emit('message', { type: 'process', pid: 2147483000, running: true });
    worker.complete();
    await running;
    const next = runtime.execute(call('/other'));
    expect(worker.messages.at(-1).type).toBe('execute');
    expect(FakeWorker.instances).toHaveLength(2);
    worker.emit('message', { type: 'process', pid: 2147483000, running: false });
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].complete();
    await next;
  });
  it('separates legacy data-directory overrides even when the project and primary directory match', async () => {
    const runtime = pool();
    const first = runtime.execute({ ...call(), env: { CONTEXT_MODE_DIR: '/shared', CONTEXT_MODE_DATA_DIR: '/first' } });
    const second = runtime.execute({ ...call(), env: { CONTEXT_MODE_DIR: '/shared', CONTEXT_MODE_DATA_DIR: '/second' } });
    expect(FakeWorker.instances).toHaveLength(2);
    for (const worker of FakeWorker.instances) worker.complete();
    await Promise.all([first, second]);
  });
  it('validates serialization without imposing a pending-call byte budget', async () => {
    const runtime = pool();
    const circular = {};
    circular.self = circular;
    await expect(runtime.execute(call('/repo', 'ses_one', circular))).rejects.toThrow('not serializable');
    const active = runtime.execute(call('/repo', 'ses_one', { content: 'a'.repeat(1024 * 1024) }));
    FakeWorker.instances[0].complete();
    await active;
  });
  it('rejects crashed active calls and never replays a potentially mutating tool', async () => {
    const runtime = pool();
    const active = runtime.execute({ ...call(), name: 'ctx_execute' });
    const assertion = expect(active).rejects.toThrow('not replayed');
    FakeWorker.instances[0].emit('error', new Error('crash'));
    await assertion;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(runtime.workers.size).toBe(0);
  });
  it('does not dispatch a pre-cancelled call or disturb an active sibling', async () => {
    const runtime = pool();
    const active = runtime.execute(call());
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.execute({ ...call(), name: 'ctx_execute', signal: controller.signal }))
      .rejects.toThrow('cancelled before execution');
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].messages).toHaveLength(1);
    FakeWorker.instances[0].complete();
    await active;
  });
  it('rejects missing attribution and relative project roots', async () => {
    const runtime = pool();
    await expect(runtime.execute(call('relative'))).rejects.toThrow('absolute project');
    await expect(runtime.execute(call('/repo', ''))).rejects.toThrow('initiating session');
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('records only one statistics delta for a call and ignores late deltas after reuse', async () => {
    const runtime = pool();
    const recorded = [];
    runtime.state.update = (_slot, delta) => recorded.push(delta);
    const first = runtime.execute(call());
    const worker = FakeWorker.instances[0];
    const id = worker.messages[0].id;
    const delta = { calls: { ctx_index: 1 } };
    worker.emit('message', { type: 'stats', id, delta });
    worker.emit('message', { type: 'stats', id, delta });
    worker.complete();
    await first;
    const second = runtime.execute(call());
    worker.emit('message', { type: 'stats', id, delta });
    expect(recorded).toEqual([delta]);
    worker.complete();
    await second;
  });
});
