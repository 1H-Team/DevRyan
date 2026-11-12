// The recorder's self-test corpus: every test here must be recorded, twice
// byte-equal, and conformance.test.mjs checks each one's events by name
// (checks.mjs) and against the golden event list (golden.json). Nothing here
// depends on how long anything takes: at most one recorder timer is pending
// at a time, and timers that race are the test's own, fired in order.
// Named *.toy.mjs so that no suite discovers it.
import { expect, test } from 'bun:test';
import { createManagedTaskScheduler, ToyError } from './toy-scheduler.mjs';

const harness = (extra = {}) => {
  const saves = [];
  const published = [];
  const starts = [];
  const scheduler = createManagedTaskScheduler({
    executor: { async start(task, control) { starts.push(task.taskId); await control.markAccepted(); } },
    persistence: { async load() { return null; }, async save(state, { onProgress }) { onProgress({ phase: 'write' }); saves.push(state); } },
    publishEvent: (event) => { published.push(event); },
    ...extra,
  });
  return { scheduler, saves, published, starts };
};

test('submits two tasks with the nominal clock and served identifiers', async () => {
  const h = harness();
  const first = await h.scheduler.submit({ prompt: 'one' });
  const second = await h.scheduler.submit({ prompt: 'two' });
  expect([first.status, second.status]).toEqual(['running', 'running']);
  expect(h.starts).toEqual([first.taskId, second.taskId]);
  expect(h.saves.length).toBe(4);
  expect(h.published.map((event) => event.type)).toEqual(['queued', 'running', 'queued', 'running']);
  expect(first.taskId.startsWith('toy_task_')).toBe(true);
  expect(first.createdAt).toBeLessThanOrEqual(Date.now());
});

test('an injected clock and injected identifiers are the test\'s', async () => {
  let n = 0;
  const h = harness({ now: () => 5000, createTaskId: () => `task-${(n += 1)}`, createLeaseToken: () => 'lease-1' });
  const task = await h.scheduler.submit({ prompt: 'three' });
  expect(task).toMatchObject({ taskId: 'task-1', leaseToken: 'lease-1', createdAt: 5000, startedAt: 5000 });
});

test('settlements stay with their calls', async () => {
  const timers = [];
  const h = harness({ scheduleTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancelTimeout: () => {} });
  const slow = h.scheduler.later('slow', 30);
  const fast = h.scheduler.later('fast', 1);
  for (const timer of [...timers].sort((a, b) => a.delay - b.delay)) timer.fn();
  expect(await Promise.all([slow, fast])).toEqual(['slow', 'fast']);
});

test('errors and identity', () => {
  const h = harness();
  expect(() => h.scheduler.fail('toy_code')).toThrow(ToyError);
  const value = { k: 1 };
  expect(h.scheduler.echo(value)).toBe(value);
  expect(h.scheduler.copy(value)).not.toBe(value);
});

test('a stop draws its request id at a named site', async () => {
  const aborts = [];
  const h = harness({ executor: { async start() {}, async abort(stop) { aborts.push(stop.requestId); } } });
  const stop = await h.scheduler.stop('task-x');
  expect(stop.requestId.startsWith('toy_stop_')).toBe(true);
  expect(aborts).toEqual([stop.requestId]);
});

test('mutation timing reads performance at named sites', async () => {
  const rows = [];
  const h = harness({ onMutationTiming: (row) => { rows.push(row); } });
  await h.scheduler.submit({ prompt: 'four' });
  expect(rows.length).toBe(2);
});

test('an abort reaches the scheduler as an input', async () => {
  const h = harness();
  const controller = new AbortController();
  const waiting = h.scheduler.waitForAbort({ signal: controller.signal });
  controller.abort('stopped');
  expect(await waiting).toBe('stopped');
});

test('a signal the scheduler hands a port and aborts is an output', () => {
  const reasons = [];
  const h = harness({ executor: { async start() {}, watch({ signal }) { signal.addEventListener('abort', () => { reasons.push(signal.reason.code); }); } } });
  expect(h.scheduler.abortPort()).toBe(true);
  expect(reasons).toEqual(['toy_abort']);
  expect(h.published).toEqual([{ type: 'aborted' }]);
});

test('signals are numbered in order of first sight, at any depth', async () => {
  const h = harness();
  const [first, second, deep] = [new AbortController(), new AbortController(), new AbortController()];
  const nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { signal: deep.signal } } } } } } } } } } };
  const waiting = h.scheduler.waitForSignals({ first: first.signal, second: second.signal, nested });
  second.abort('two');
  deep.abort('three');
  first.abort('one');
  expect(await waiting).toEqual(['two', 'three', 'one']);
});

test('a callback the test passes is a port', async () => {
  const h = harness();
  let authorized = 0;
  expect(await h.scheduler.authorize((value) => value * 2, { value: 21, authorize: async () => { authorized += 1; } })).toBe(42);
  expect(authorized).toBe(1);
});

test('a later change to the options is what the scheduler reads', () => {
  const options = { executor: { async start() {} } };
  const scheduler = createManagedTaskScheduler(options);
  expect(scheduler.flags()).toEqual({ expire: undefined, timing: 'undefined', proofStore: false, load: true, hasNow: false, ownLoad: true });
  options.expireUnacknowledged = false;
  options.onMutationTiming = () => {};
  expect(scheduler.flags()).toEqual({ expire: false, timing: 'function', proofStore: false, load: true, hasNow: false, ownLoad: true });
});

test('without a persistence the scheduler saves through the recorded default', async () => {
  const scheduler = createManagedTaskScheduler({ executor: { async start(task, control) { await control.markAccepted(); } } });
  expect(await scheduler.initialize()).toBe(null);
  expect((await scheduler.submit({ prompt: 'five' })).status).toBe('running');
});

test('options set to null are left out, as the scheduler\'s ?? treats them', async () => {
  const scheduler = createManagedTaskScheduler({
    executor: { async start(task, control) { await control.markAccepted(); } },
    persistence: null, now: null, scheduleTimeout: null, cancelTimeout: null, createTaskId: null, createLeaseToken: null, publishEvent: null,
  });
  expect((await scheduler.submit({ prompt: 'six' })).taskId.startsWith('toy_task_')).toBe(true);
  expect(typeof (await scheduler.laterAt(5))).toBe('number');
});

test('a value the scheduler hands out and the test changes later keeps its case', () => {
  const h = harness();
  const copied = h.scheduler.copy({ k: 1 });
  copied.k = 2;
  expect(copied).toEqual({ k: 2 });
});

test('a clear through a handle two live timers share is ambiguous', () => {
  const h = harness({ scheduleTimeout: () => 7, cancelTimeout: () => {} });
  expect(h.scheduler.twoTimers(5)).toBe(true);
});

test('the nominal clock moves with the recorder\'s timers, and new Date() agrees with Date.now()', async () => {
  const h = harness();
  const before = [Date.now(), new Date().getTime()];
  expect(await h.scheduler.later('x', 20)).toBe('x');
  expect(h.scheduler.pause(50)).toBe(true);
  const after = [Date.now(), new Date().getTime(), Date.parse(Date()), new Date(5).getTime(), new Date() instanceof Date];
  expect(h.scheduler.echo([...before, ...after]).length).toBe(7);
});

let carried = null;
test('leaves a recorder timer for the next test', () => {
  carried = harness().scheduler.laterAt(30);
  expect(typeof carried.then).toBe('function');
});

test('reads the clock after the previous test\'s timer fired', async () => {
  const at = await carried;
  const h = harness();
  expect(h.scheduler.echo([at, Date.now()]).length).toBe(2);
});

const pending = [];
let leftOver = null;
test('leaves a timer for the next test', () => {
  const h = harness({ scheduleTimeout: (fn) => { pending.push(fn); return pending.length; }, cancelTimeout: () => {} });
  leftOver = h.scheduler.later('late', 10);
  expect(pending.length).toBe(1);
});

test('fires the timer the previous test left', async () => {
  for (const fire of pending.splice(0)) fire();
  expect(await leftOver).toBe('late');
});
