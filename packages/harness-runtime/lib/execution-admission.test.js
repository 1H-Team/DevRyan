import { expect, test } from 'bun:test';
import { executionPhase, withExecutionAdmission } from './execution-admission.js';

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
