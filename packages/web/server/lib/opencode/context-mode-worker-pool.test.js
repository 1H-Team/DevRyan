import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextModeWorkerPool } from './context-mode-worker-pool.js';
import { WORKER_POOL_SOURCE, WORKER_SOURCE } from './context-mode-worker-sources.js';

class FakeWorker extends EventEmitter {
  static instances = [];
  messages = [];
  constructor(url, options) { super(); this.options = options; FakeWorker.instances.push(this); }
  postMessage(message) { this.messages.push(message); if (message.type === 'close') queueMicrotask(() => this.emit('message', { type: 'closed' })); }
  complete(result = 'ok') { this.emit('message', { type: 'result', id: this.messages.at(-1).id, result }); }
  async terminate() { this.emit('exit', 0); }
}
const pools = [];
const pool = (options) => { const result = new ContextModeWorkerPool({ WorkerClass: FakeWorker, ...options }); pools.push(result); return result; };
const call = (projectDir = '/repo', sessionId = 'ses_one', args = {}) => ({ name: 'ctx_index', projectDir, sessionId, args, env: { CONTEXT_MODE_DIR: '/isolated/data' } });
afterEach(async () => { await Promise.all(pools.splice(0).map((item) => item.close())); FakeWorker.instances = []; });

describe('Context Mode worker isolation', () => {
  it('ships identical helpers in bundled web provisioning', () => {
    expect(WORKER_POOL_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker-pool.js', import.meta.url), 'utf8'));
    expect(WORKER_SOURCE).toBe(fs.readFileSync(new URL('./context-mode-worker.js', import.meta.url), 'utf8'));
  });
  it('serializes a project and attributes every call to its initiating session', async () => {
    const runtime = pool();
    const first = runtime.execute(call());
    const second = runtime.execute(call('/repo', 'ses_two'));
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    expect(worker.messages).toHaveLength(1);
    worker.complete('first');
    expect(worker.messages[1].sessionId).toBe('ses_two');
    worker.complete('second');
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
  });
  it('separates projects and storage roots without exceeding four workers', async () => {
    const runtime = pool();
    const calls = [0, 1, 2, 3, 4].map((index) => runtime.execute(call(`/repo${index}`)));
    expect(FakeWorker.instances).toHaveLength(4);
    expect(runtime.queue).toHaveLength(1);
    FakeWorker.instances[0].complete();
    await Promise.resolve();
    expect(runtime.workers.size).toBe(4);
    expect(FakeWorker.instances).toHaveLength(5);
    for (const worker of FakeWorker.instances.slice(1)) worker.complete();
    await Promise.all(calls);
    const differentData = runtime.execute({ ...call('/repo4'), env: { CONTEXT_MODE_DIR: '/other/data' } });
    await Promise.resolve();
    expect(FakeWorker.instances.at(-1).options.env.CONTEXT_MODE_DIR).toBe('/other/data');
    FakeWorker.instances.at(-1).complete();
    await differentData;
  });
  it('never evicts a worker while a background process is alive', async () => {
    const runtime = pool({ maxWorkers: 1 });
    const running = runtime.execute(call());
    const worker = FakeWorker.instances[0];
    worker.emit('message', { type: 'process', pid: 2147483000, running: true });
    worker.complete();
    await running;
    const next = runtime.execute(call('/other'));
    expect(worker.messages.at(-1).type).toBe('execute');
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
  it('bounds queued calls and bytes, and explicitly fails without dispatch', async () => {
    const runtime = pool({ maxQueue: 1, maxQueuedBytes: 20 });
    const active = runtime.execute(call());
    const queued = runtime.execute(call());
    await expect(runtime.execute(call())).rejects.toThrow('not executed');
    FakeWorker.instances[0].complete();
    FakeWorker.instances[0].complete();
    await Promise.all([active, queued]);
    await expect(runtime.execute(call('/repo', 'ses_one', { text: 'a'.repeat(21) }))).rejects.toThrow('capacity');
  });
  it('rejects crashed active calls and never replays a potentially mutating tool', async () => {
    const runtime = pool();
    const active = runtime.execute({ ...call(), name: 'ctx_execute' });
    const assertion = expect(active).rejects.toThrow('not replayed');
    FakeWorker.instances[0].emit('error', new Error('crash'));
    await assertion;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(runtime.queue).toHaveLength(0);
  });
  it('removes cancelled queued calls without executing them or evicting the active worker', async () => {
    const runtime = pool();
    const active = runtime.execute(call());
    const controller = new AbortController();
    const queued = runtime.execute({ ...call(), name: 'ctx_execute', signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow('cancelled before execution');
    expect(runtime.queuedBytes).toBe(0);
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
});
