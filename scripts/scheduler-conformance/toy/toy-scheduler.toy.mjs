// The recorder's self-test corpus: every test here must be recorded, twice
// byte-equal, and conformance.test.mjs checks each one's events by name
// (checks.mjs) and against the golden event list (golden.json). Nothing here
// depends on how long anything takes: at most one recorder timer is pending
// at a time, and timers that race are the test's own, fired in order.
// Named *.toy.mjs so that no suite discovers it.
import { expect, jest, test, vi } from 'bun:test';
import timers from 'node:timers';
import * as timerPromises from 'node:timers/promises';
import { promisify } from 'node:util';
import { createManagedTaskScheduler, ToyError } from './toy-scheduler.mjs';

const rest = () => new Promise((resolve) => { setImmediate(resolve); });

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

test('where each input arrives is marked: at rest, in the same run, in a settlement\'s continuation, or busy', async () => {
  const starts = [];
  const h = harness({ executor: { start: () => new Promise((resolve) => { starts.push(resolve); }) } });
  const rest = () => new Promise((resolve) => { setImmediate(resolve); });
  const first = h.scheduler.submit({ prompt: 'five' }); // with: in the run the construction returned in
  await rest();
  h.scheduler.echo('at rest'); // rest: nothing written since the recorder's own setImmediate ran
  await rest();
  starts[0]();
  h.scheduler.echo('after a silent settlement'); // busy: the executor's promise settled since that rest point
  await first;
  await rest();
  const value = await h.scheduler.later('x', 1); // rest
  h.scheduler.echo(value); // settle: the continuation of later's settlement
  await null;
  h.scheduler.echo('after a job boundary'); // busy: a job ran since echo returned
  await rest();
  const again = await h.scheduler.later('y', 1); // rest
  await null;
  h.scheduler.echo(again); // busy: a job ran since later settled
  queueMicrotask(() => { h.scheduler.echo('in another job'); }); // busy: its job holds another call's stamp
  h.scheduler.echo('in the same run'); // with: in the run the echo before it returned in
  await rest();
  // A recorder timer due before the recorder's next setImmediate (Bun runs the timers of the next turn first, and the
  // spin makes this one due whatever the load): its fire is at rest because a timer callback starts with no job queued.
  const fired = h.scheduler.laterAt(1);
  for (const until = performance.now() + 5; performance.now() < until;);
  await fired;
  expect(starts.length).toBe(1);
});

// Each way of awaiting a member, the echo after it with the mark it must get (checks.mjs `settle-window`). A
// settlement's window holds only the reactions its own settlement queued: one microtask later is not in it.
test('a settlement\'s window holds only the reactions it queued', async () => {
  const s = harness().scheduler;
  const rest = () => new Promise((resolve) => { setImmediate(resolve); });
  await rest();
  await s.settleAfter(1);
  s.echo('directly'); // settle
  await rest();
  await s.settleAfter(0);
  s.echo('already settled'); // settle: its promise was settled when it returned
  for (const k of [0, 1, 2, 3, 19]) {
    await rest();
    const kept = s.settleAfter(2);
    for (let i = 0; i < k; i += 1) await null;
    s.echo(`kept ${k}`); // with for 0, else busy: a chain beside the kept promise is never in its window
    await kept;
  }
  await rest();
  const kept = s.settleAfter(2);
  await kept;
  s.echo('kept, awaited before it settles'); // settle
  await rest();
  const wrapper = async () => { await s.settleAfter(1); s.echo('in a function that awaits it'); }; // settle
  await wrapper();
  s.echo('after that function'); // busy: the function's own promise settled in the window
  await rest();
  await s.settleAfter(1).then(() => { s.echo('in a then'); }).then(() => { s.echo('in the then of that then'); }); // settle, busy
  await rest();
  await Promise.all([s.settleAfter(1), s.settleAfter(1)]);
  s.echo('after Promise.all'); // busy
  await rest();
  const first = s.gate();
  const second = s.gate();
  s.open();
  await second;
  s.echo('after the second of two settled in one run'); // settle: its own settlement was written last
  await rest();
  const third = s.gate();
  const fourth = s.gate();
  s.open();
  await third;
  s.echo('after the first of two settled in one run'); // busy: the other settlement was written since
  await Promise.all([first, fourth]);
  await rest();
  // Two timers of the test's own, due at once, so fired in one timer phase, before the recorder's next probe: the
  // second's entry is the rest point the echo after it stands on, whatever the load.
  await new Promise((resolve) => { setTimeout(() => { s.echo('in a test timer'); }, 1); setTimeout(resolve, 1); }); // rest
  s.echo('in the next test timer of that phase'); // rest: a timer callback starts with no job queued
});

// Fake timers (O0c review 3, B1): a fake clock runs timer callbacks from the test's own code, with microtasks still
// queued, so no such entry is a rest point (checks.mjs `fake-timers`). `settleAfter(3)` still has jobs queued when
// the fake clock runs the callback.
test('under fake timers a test timer the fake clock runs is no rest point (advanceTimersByTime)', async () => {
  const s = harness().scheduler;
  await rest();
  jest.useFakeTimers();
  try {
    const busy = s.settleAfter(3); // rest
    await null;
    setTimeout(() => { s.echo('in a fake timer'); }, 10);
    jest.advanceTimersByTime(20); // the echo: busy
    await busy;
  } finally { jest.useRealTimers(); }
});

test('under fake timers a test timer the fake clock runs is no rest point (runAllTimers, through vi)', async () => {
  const s = harness().scheduler;
  await rest();
  vi.useFakeTimers();
  try {
    const busy = s.settleAfter(3); // rest
    await null;
    setTimeout(() => { s.echo('in a fake timer'); }, 10);
    vi.runAllTimers(); // the echo: busy
    await busy;
  } finally { vi.useRealTimers(); }
});

test('under fake timers the recorder\'s own timer is no rest point either', async () => {
  const s = harness().scheduler;
  await rest();
  jest.useFakeTimers();
  try {
    const later = s.later('x', 5); // rest: its timer is the recorder's, over the native setTimeout, which the fake clock owns now
    await null;
    jest.advanceTimersByTime(10); // the fire: busy
    expect(await later).toBe('x');
  } finally { jest.useRealTimers(); }
});

// Two real timers of the test's own, set before fake timers are installed and fired by the event loop while they are
// (in one timer phase, before the recorder's next probe): while fake timers are installed no timer entry is a rest
// point, so the second echo is busy.
test('while fake timers are installed even a real timer\'s entry is no rest point', async () => {
  const s = harness().scheduler;
  await rest();
  const fired = new Promise((resolve) => { setTimeout(() => { s.echo('first real timer'); }, 1); setTimeout(() => { s.echo('second real timer'); resolve(); }, 1); });
  jest.useFakeTimers();
  try { await fired; } finally { jest.useRealTimers(); }
});

test('fake timers installed and removed mid-test, the clock set while they are: a real timer after them is a rest point again', async () => {
  const s = harness().scheduler;
  await rest();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(1_800_000_000_000));
  const busy = s.settleAfter(3); // rest
  await null;
  setTimeout(() => { s.echo('in a fake timer'); }, 1);
  jest.advanceTimersByTime(5); // busy
  await busy;
  jest.useRealTimers();
  jest.setSystemTime();
  await new Promise((resolve) => { setTimeout(() => { s.echo('in a real timer after them'); resolve(); }, 1); }); // rest
});

test('setSystemTime alone installs no fake timers: a real timer is a rest point', async () => {
  const s = harness().scheduler;
  await rest();
  jest.setSystemTime(new Date(1_800_000_000_000));
  try { await new Promise((resolve) => { setTimeout(() => { s.echo('in a real timer'); resolve(); }, 1); }); } finally { jest.setSystemTime(); } // rest
});

// Work the scheduler queues of its own, outside its options (O0c review 3, S4; checks.mjs `own-macrotask`): after it
// no input is at rest. Each route its own case, since the first one ends rest marks for the case.
for (const route of ['setTimeout', 'setInterval', 'setImmediate', 'Bun.sleep', 'postMessage']) {
  test(`a scheduler that queues work of its own through ${route}: no rest mark after it`, async () => {
    const s = harness().scheduler;
    await rest();
    s.queueOwn(route); // rest
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect(s.ownWork()).toBe(1); // busy
  });
}

test('a scheduler that queues microtasks and ticks of its own keeps its rest marks', async () => {
  const s = harness().scheduler;
  await rest();
  s.queueOwn('queueMicrotask'); // rest
  s.queueOwn('nextTick'); // with
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  expect(s.ownWork()).toBe(2); // rest
});

// What the recorder changes in what a test sees (O0c review 3, S2 and S3; checks.mjs `timer-globals`,
// `promise-identity`): the wrapped timer globals keep their own properties, util.promisify's custom function among
// them, and two calls answered with one promise get one promise.
test('the wrapped timer globals keep their name, length and promisified form', async () => {
  const s = harness().scheduler;
  const custom = promisify.custom;
  const woke = await promisify(setTimeout)(1, 'woke').catch((error) => error.name);
  s.echo([
    setTimeout.name, setTimeout.length === timers.setTimeout.length, setTimeout[custom] === timerPromises.setTimeout,
    setImmediate.name, setImmediate.length === timers.setImmediate.length, setImmediate[custom] === timerPromises.setImmediate,
    setInterval.name, setInterval.length === timers.setInterval.length, woke,
  ]);
});

test('a member that answers two calls with one promise answers with one promise under the recorder too', async () => {
  const s = harness().scheduler;
  const first = s.memo();
  const second = s.memo();
  s.echo([first === second, await first, await second]);
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
