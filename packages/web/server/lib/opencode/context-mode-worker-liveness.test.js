import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextModeWorkerPool } from './context-mode-worker-pool.js';

class Worker extends EventEmitter {
  static instances = [];
  messages = [];
  terminated = false;
  constructor() { super(); Worker.instances.push(this); }
  postMessage(message) { this.messages.push(message); }
  async terminate() { this.terminated = true; this.emit('exit', 0); }
  get execution() { return this.messages.findLast((message) => message.type === 'execute'); }
  result(result = 'done', id = this.execution.id) { this.emit('message', { type: 'result', id, result }); }
  process(pid, running, id = this.execution.id) { this.emit('message', { type: 'process', pid, running, id }); }
  cancelled() { this.emit('message', { type: 'cancelled', id: this.execution.id }); }
}
const pools = [];
const create = (options = {}) => {
  const pool = new ContextModeWorkerPool({ WorkerClass: Worker, idleTimeoutMs: 30_000,
    executionTimeoutMs: 120, cleanupTimeoutMs: 5, ...options });
  pools.push(pool);
  return pool;
};
const request = (options = {}) => ({ name: 'ctx_index', projectDir: '/fixture', sessionId: 'ses_a', callId: 'call_a', args: {}, env: {}, ...options });
const track = (promise) => {
  const state = { status: 'pending' };
  state.done = promise.then((value) => Object.assign(state, { status: 'completed', value }),
    (error) => Object.assign(state, { status: 'failed', error }));
  return state;
};
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  Worker.instances = [];
});

describe('Context Mode bounded cross-session liveness', () => {
  it('keeps same-session and sibling-session calls live beyond the former queue deadline', async () => {
    const pool = create({ executionTimeoutMs: 120_000 });
    const first = track(pool.execute(request()));
    const second = track(pool.execute(request()));
    const third = track(pool.execute(request({ sessionId: 'ses_b' })));
    expect(Worker.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_001);
    expect([first.status, second.status, third.status]).toEqual(['pending', 'pending', 'pending']);
    Worker.instances[1].result('fast same session');
    Worker.instances[2].result('fast sibling');
    await Promise.all([second.done, third.done]);
    expect(first.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(56_999);
    Worker.instances[0].result('long index completed');
    await first.done;
    expect(first.value).toBe('long index completed');
    await pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a worker that never initializes without blocking another same-project worker', async () => {
    class SlowExitWorker extends Worker { async terminate() { this.terminated = true; } }
    const events = [];
    const pool = create({ WorkerClass: SlowExitWorker, onEvent: (event) => events.push(event) });
    const first = track(pool.execute(request()));
    await vi.advanceTimersByTimeAsync(120);
    expect(first.error.code).toBe('TIMEOUT');
    expect(first.error.message).toContain('outcome is unknown');
    const worker = Worker.instances[0];
    await vi.advanceTimersByTimeAsync(5);
    expect(worker.terminated).toBe(true);
    const recovered = track(pool.execute(request({ sessionId: 'ses_b' })));
    expect(Worker.instances).toHaveLength(2);
    Worker.instances[1].result('new result');
    await recovered.done;
    expect(recovered.value).toBe('new result');
    worker.emit('exit', 0);
    expect(events.map((event) => event.phase)).toContain('recovered');
    expect(events[0]).toMatchObject({ sessionID: 'ses_a', callID: 'call_a' });
    expect(JSON.stringify(events)).not.toContain('/fixture');
  });

  it('cancels only the active call while same-project siblings and other projects continue', async () => {
    const controller = new AbortController();
    const stop = vi.fn();
    let gone = false;
    const pool = create({ stopProcess: stop, processGone: () => gone });
    const active = track(pool.execute(request({ signal: controller.signal })));
    const sibling = track(pool.execute(request({ sessionId: 'ses_b' })));
    const other = track(pool.execute(request({ projectDir: '/other', sessionId: 'ses_c' })));
    const [worker, siblingWorker, independent] = Worker.instances;
    worker.process(101, true);
    controller.abort();
    await active.done;
    expect(active.error.code).toBe('CANCELLED');
    expect([sibling.status, other.status]).toEqual(['pending', 'pending']);
    expect(stop).toHaveBeenCalledExactlyOnceWith(101);
    worker.cancelled();
    expect([...pool.workers][0].blocked).toBe(true);
    siblingWorker.result('same project unaffected');
    independent.result('other project unaffected');
    await Promise.all([sibling.done, other.done]);
    expect(sibling.value).toBe('same project unaffected');
    expect(other.value).toBe('other project unaffected');
    gone = true;
    worker.process(101, false);
    expect([...pool.workers][0].blocked).toBe(false);
    await pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not terminate another session background command when a later call hangs', async () => {
    const stop = vi.fn();
    const pool = create({ stopProcess: stop });
    const background = track(pool.execute(request({ name: 'ctx_execute' })));
    const worker = Worker.instances[0];
    worker.process(101, true);
    worker.result('backgrounded');
    await background.done;
    const foreground = track(pool.execute(request({ sessionId: 'ses_b', name: 'ctx_execute' })));
    worker.process(202, true);
    await vi.advanceTimersByTimeAsync(130);
    expect(foreground.error.code).toBe('TIMEOUT');
    expect(stop.mock.calls.flat()).toEqual([202]);
    expect(worker.terminated).toBe(false);
    expect([...pool.workers][0].quarantined).toBe(true);
    worker.process(202, false);
    worker.cancelled();
    const next = track(pool.execute(request({ sessionId: 'ses_c' })));
    worker.result();
    await next.done;
    expect(next.status).toBe('completed');
    expect(worker.terminated).toBe(false);
  });

  it('quarantines missing termination acknowledgement without quarantining the project', async () => {
    class StuckWorker extends Worker { async terminate() { this.terminated = true; } }
    const pool = create({ WorkerClass: StuckWorker });
    const active = track(pool.execute(request()));
    await vi.advanceTimersByTimeAsync(130);
    expect(active.status).toBe('failed');
    expect([...pool.workers][0].quarantined).toBe(true);
    const sibling = track(pool.execute(request()));
    const [worker, independent] = Worker.instances;
    worker.result('too late');
    independent.result('sibling completed');
    await sibling.done;
    expect(sibling.value).toBe('sibling completed');
    expect(active.status).toBe('failed');
    worker.emit('exit', 0);
    expect(pool.workers.size).toBe(1);
    expect([...pool.workers][0].worker).toBe(independent);
  });

  it('waits for independent process cleanup proof after a worker exits', async () => {
    let gone = false;
    const pool = create({ stopProcess: vi.fn(), processGone: () => gone, cleanupTimeoutMs: 100 });
    const active = track(pool.execute(request()));
    const worker = Worker.instances[0];
    worker.process(101, true);
    worker.emit('exit', 1);
    await active.done;
    expect([...pool.workers][0].blocked).toBe(true);
    const sibling = track(pool.execute(request()));
    Worker.instances[1].result('unaffected');
    await sibling.done;
    expect(sibling.value).toBe('unaffected');
    gone = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(pool.workers.size).toBe(1);
    expect([...pool.workers][0].worker).toBe(Worker.instances[1]);
  });

  it('requires a descendant-tree stop receipt when a PID probe alone cannot establish cleanup', async () => {
    let finishStop;
    const pool = create({ requireStopReceipt: true, processGone: () => true,
      stopProcess: () => new Promise((resolve) => { finishStop = resolve; }) });
    const active = track(pool.execute(request()));
    Worker.instances[0].process(101, true);
    Worker.instances[0].emit('exit', 1);
    await active.done;
    expect([...pool.workers][0].blocked).toBe(true);
    expect(pool.workers.size).toBe(1);
    finishStop(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.workers.size).toBe(0);
  });

  it('does not replay crashed calls and settles error plus exit only once', async () => {
    const events = [];
    const pool = create({ onEvent: (event) => events.push(event.phase) });
    const active = track(pool.execute(request({ name: 'ctx_execute' })));
    Worker.instances[0].emit('error', new Error('fixture crash'));
    await active.done;
    expect(active.error.code).toBe('WORKER_EXITED');
    expect(Worker.instances).toHaveLength(1);
    expect(pool.workers.size).toBe(0);
    expect(events.filter((phase) => phase === 'recovered')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a cleaned idle worker to exit naturally before forcing termination', async () => {
    const pool = create({ idleTimeoutMs: 30 });
    const call = track(pool.execute(request()));
    const worker = Worker.instances[0];
    worker.result();
    await call.done;
    await vi.advanceTimersByTimeAsync(30);
    worker.emit('message', { type: 'closed' });
    expect(worker.terminated).toBe(false);
    expect(pool.workers.size).toBe(1);
    worker.emit('exit', 0);
    expect(pool.workers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds idle retirement when a close acknowledgement never arrives', async () => {
    const pool = create({ maxIdleWorkers: 1, idleTimeoutMs: 30 });
    const first = track(pool.execute(request()));
    Worker.instances[0].result();
    await first.done;
    const second = track(pool.execute(request({ projectDir: '/other' })));
    expect(Worker.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30);
    expect(Worker.instances[0].messages.at(-1).type).toBe('close');
    await vi.advanceTimersByTimeAsync(5);
    expect(Worker.instances).toHaveLength(2);
    Worker.instances[1].result();
    await second.done;
    expect(second.status).toBe('completed');
  });

  it('removes abort listeners after completion and ignores late old-call messages', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pool = create();
    const first = track(pool.execute(request({ signal: controller.signal })));
    const worker = Worker.instances[0];
    const oldID = worker.execution.id;
    worker.result('first');
    await first.done;
    expect(remove).toHaveBeenCalledTimes(1);
    controller.abort();
    const second = track(pool.execute(request({ sessionId: 'ses_b' })));
    worker.result('late duplicate', oldID);
    await Promise.resolve();
    expect(second.status).toBe('pending');
    worker.result('second');
    await second.done;
    expect(second.value).toBe('second');
    expect(vi.getTimerCount()).toBe(1); // Only the idle-retention timer remains.
    await pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, '100'])('rejects invalid explicit timeout %s before dispatch', async (timeout) => {
    const pool = create();
    await expect(pool.execute(request({ name: 'ctx_execute', args: { timeout } }))).rejects.toThrow('INVALID_TIMEOUT');
    expect(Worker.instances).toHaveLength(0);
  });

  it('passes default and explicit budgets to commands and the complete batch without truncating long timers', async () => {
    const pool = create();
    const first = track(pool.execute(request({ name: 'ctx_execute' })));
    const worker = Worker.instances[0];
    expect(worker.execution.args.timeout).toBe(120);
    worker.result();
    await first.done;
    const second = track(pool.execute(request({ name: 'ctx_batch_execute', args: { timeout: 2 ** 32, commands: [] } })));
    expect(worker.execution.budgetMs).toBe(2 ** 32);
    expect(worker.execution.args.timeout).toBe(2 ** 32);
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.status).toBe('pending');
    worker.result();
    await second.done;
    expect(vi.getTimerCount()).toBe(1);
    await pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails dispatch exceptions without replay and bounds cleanup', async () => {
    class ThrowingWorker extends Worker { postMessage() { throw new Error('fixture clone failure'); } }
    const pool = create({ WorkerClass: ThrowingWorker });
    const result = track(pool.execute(request()));
    await result.done;
    expect(result.error.code).toBe('DISPATCH_FAILED');
    await vi.advanceTimersByTimeAsync(5);
    expect(pool.workers.size).toBe(0);
    expect(Worker.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles every concurrent shutdown caller with an unknown outcome', async () => {
    const pool = create();
    const active = track(pool.execute(request()));
    const sibling = track(pool.execute(request({ sessionId: 'ses_b' })));
    await pool.close();
    await Promise.all([active.done, sibling.done]);
    expect(active.error.message).toContain('outcome is unknown');
    expect(sibling.error.message).toContain('outcome is unknown');
    expect(pool.workers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('notifies synchronous storage waits on shutdown and accepts late process cleanup proof', async () => {
    let gone = false;
    const pool = create({ stopProcess: vi.fn(), processGone: () => gone });
    const active = track(pool.execute(request()));
    const worker = Worker.instances[0];
    const cancellation = vi.spyOn(pool, 'signalCancellation');
    worker.process(101, true);
    await pool.close();
    await active.done;
    expect(cancellation).toHaveBeenCalledOnce();
    expect(worker.messages.some((message) => message.type === 'cancel')).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(pool.workers.size).toBe(1);
    expect([...pool.workers][0].quarantined).toBe(true);
    gone = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.workers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
