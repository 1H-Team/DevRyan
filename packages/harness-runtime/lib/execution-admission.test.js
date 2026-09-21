import { expect, test } from 'bun:test';
import { executionPhase, withExecutionAdmission, withExecutionPreparation, withoutExecutionDeadline, executionProgress, executionProgressMeter, waitForExecutionQueue } from './execution-admission.js';

test('an expired active operation retains ownership until it actually settles', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const work = withExecutionAdmission({ sessionID: 's' }, () => executionPhase('lease_preparation', () => held), { timeoutMs: 10 });
  const result = work.catch((cause) => { settled = true; return cause; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  release();
  expect((await result).code).toBe('local_execution_timeout');
});

test('local HTTP and lock deadlines do not masquerade as provider timeouts', async () => {
  for (const cause of [new DOMException('expired', 'TimeoutError'), Object.assign(new Error('lock'), { code: 'LOCK_TIMEOUT' })]) {
    const error = await withExecutionAdmission({ sessionID: 's' }, async () => { throw cause; }).catch((value) => value);
    expect(error.code).toBe('local_execution_timeout');
    expect(error.cause).toBe(cause);
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('shared preparation reports real progress across copied contexts while joiners keep their own deadlines', async () => {
  let meter;
  const producer = withExecutionPreparation({}, () => {
    meter = executionProgressMeter();
    return withoutExecutionDeadline(async () => {
      for (let i = 0; i < 20; i++) { await delay(10); executionProgress(); }
      return 'ready';
    });
  }, { stallMs: 80 });
  const join = (options = {}) => withExecutionPreparation({}, () => waitForExecutionQueue(producer, meter), { stallMs: 80, ...options });
  const controller = new AbortController();
  const cancelled = join({ signal: controller.signal }).catch((cause) => cause.message);
  const expired = join({ timeoutMs: 40 }).catch((cause) => cause.code);
  const healthy = join();
  controller.abort(new Error('cancelled'));
  expect(await cancelled).toBe('cancelled');
  expect(await expired).toBe('local_execution_timeout');
  expect(await healthy).toBe('ready');
  expect(await producer).toBe('ready');
});
test('following a hung shared preparation does not disable the stall watchdog', async () => {
  const never = new Promise(() => {});
  const meter = { progress: Date.now(), waiters: 0 };
  await expect(withExecutionPreparation({}, () => waitForExecutionQueue(never, meter), { stallMs: 20 }))
    .rejects.toMatchObject({ code: 'execution_preparation_stalled' });
});
