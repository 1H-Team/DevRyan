// Fixtures the recorder must refuse: each test here must come out
// unrecordable with exactly the flag conformance.test.mjs names.
import { afterAll, expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './toy-scheduler.mjs';

const executor = { async start() {} };
let fireLater = null;
let afterWrite = null;

test('a scheduler that acts after the recording was written', () => {
  const scheduler = createManagedTaskScheduler({ executor, scheduleTimeout: (fn) => { fireLater = fn; return 1; }, cancelTimeout: () => {} });
  afterWrite = scheduler.later('after', 5);
  expect(typeof fireLater).toBe('function');
});

test('a member that hands the test scheduler code', () => {
  const scheduler = createManagedTaskScheduler({ executor, scheduleTimeout: () => 2, cancelTimeout: () => {} });
  const armed = scheduler.arm(5);
  expect(typeof armed.disarm).toBe('function');
});

test('a port answer that holds a function', async () => {
  const scheduler = createManagedTaskScheduler({ executor: { async start() { return { cancel() { return 'cancelled'; } }; } } });
  expect((await scheduler.submit({ prompt: 'p' })).status).toBe('queued');
});

class Handle { cancel() { return 'cancelled'; } }
test('a port answer that is a class instance holding a method', async () => {
  const scheduler = createManagedTaskScheduler({ executor: { async start() { return new Handle(); } } });
  expect((await scheduler.submit({ prompt: 'p' })).status).toBe('queued');
});

test('a value the scheduler handed out crosses back in, changed', () => {
  const scheduler = createManagedTaskScheduler({ executor });
  const copied = scheduler.copy({ k: 1 });
  copied.k = 2;
  expect(scheduler.echo(copied)).toBe(copied);
});

test('an input the test changes after passing it', () => {
  const scheduler = createManagedTaskScheduler({ executor });
  const input = { prompt: 'before' };
  expect(scheduler.echo(input)).toBe(input);
  input.prompt = 'after';
});

// Two tests that overlap: the first waits for the second to start.
let release = null;
const gate = new Promise((resolve) => { release = resolve; });
test.concurrent('an overlapping test waits', async () => {
  const scheduler = createManagedTaskScheduler({ executor });
  await gate;
  expect(scheduler.echo('one')).toBe('one');
});
test.concurrent('an overlapping test releases', () => {
  const scheduler = createManagedTaskScheduler({ executor });
  release();
  expect(scheduler.echo('two')).toBe('two');
});

// Bun runs this file's afterAll, then the recorder's (which writes the recording), then this immediate.
afterAll(() => { setImmediate(() => { fireLater?.(); void afterWrite; }); });
