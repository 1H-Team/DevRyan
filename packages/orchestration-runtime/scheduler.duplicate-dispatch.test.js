import { describe, expect, test } from 'bun:test';

import { createManagedTaskScheduler } from './scheduler.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const createHarness = async () => {
  let taskCounter = 0;
  let leaseCounter = 0;
  const runs = [];
  const executor = {
    // Never settles, so every submitted task stays 'running' — which is the
    // state the duplicate guard is scoped to.
    start: (task, taskControl) => {
      const run = { task, taskControl, result: deferred() };
      runs.push(run);
      return run.result.promise;
    },
    resume: () => { throw new Error('resume not expected'); },
    abort: async () => undefined,
    reconcile: async () => ({ state: 'unavailable' }),
    readRecoverableResult: async () => ({ preview: '', canonicalRefs: [] }),
  };
  const scheduler = createManagedTaskScheduler({
    executor,
    now: () => 1_000,
    createTaskId: () => `dvr_task_${++taskCounter}`,
    createLeaseToken: () => `dvr_lease_${++leaseCounter}`,
    publishEvent: () => undefined,
  });
  await scheduler.initialize();
  return { runs, scheduler };
};

// The three prompts below are the real ones from root session
// ses_fdbbff48cffe14VuHtvaCtBIdk on 2026-08-21, dispatched 22s and 28s apart.
// All three ran to completion as separate subagents.
const PROMPT_A = 'Find: The full support live-chat pipeline in the 1Health repo (/Users/zoubair/Repositories/onehealth-connector): how a signed-out visitor\'s support chat message gets submitted, how it is routed to an available agent (auto-assignment when agent has <5 concurrent active chats), how agent availability ("Available" toggle in /admin/support/live-chat) is stored/read.';
const PROMPT_B = 'Find: The full support live-chat pipeline in the 1Health repo (/Users/zoubair/Repositories/onehealth-connector) - how a signed-out visitor\'s support chat message gets submitted, how it is routed to an available agent (auto assignment when agent has < 5 concurrent active chats), how agent availability ("Available" toggle in /admin/support/live-chat) is stored / read!';

const submitInput = (index, overrides = {}) => ({
  idempotencyKey: `tool:ses_root:msg_${index}:hash-${index}`,
  rootSessionId: 'ses_root',
  dispatchGroupId: `msg_${index}`,
  dispatchCallId: `toolu_${index}`,
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator',
  providerId: 'xai',
  modelId: 'grok-4.6',
  agent: 'explorer',
  variant: null,
  label: 'Map support live-chat routing flow',
  prompt: PROMPT_A,
  timeoutAt: null,
  ...overrides,
});

describe('duplicate dispatch guard', () => {
  test('a re-issued dispatch in a later message collapses onto the running task', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1));
    // Different messageID, different callID, different idempotencyKey — exactly
    // what the orchestrator produced when it re-dispatched.
    const second = await scheduler.submit(submitInput(2));

    expect(second.taskId).toBe(first.taskId);
    expect(runs).toHaveLength(1);
  });

  test('collapses a reworded restatement of the same request', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1, { prompt: PROMPT_A }));
    const second = await scheduler.submit(submitInput(2, { prompt: PROMPT_B }));

    expect(second.taskId).toBe(first.taskId);
    expect(runs).toHaveLength(1);
  });

  test('allow_duplicate opts back in to deliberate parallel fan-out', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1));
    const second = await scheduler.submit(submitInput(2, { allowDuplicate: true }));

    expect(second.taskId).not.toBe(first.taskId);
    expect(runs).toHaveLength(2);
  });

  test('a genuinely different prompt is never collapsed', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1));
    const second = await scheduler.submit(submitInput(2, {
      prompt: 'Find: the Stripe webhook signature verification path and where replay protection is enforced.',
    }));

    expect(second.taskId).not.toBe(first.taskId);
    expect(runs).toHaveLength(2);
  });

  test('the same prompt for a different agent is never collapsed', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1));
    const second = await scheduler.submit(submitInput(2, { agent: 'fixer' }));

    expect(second.taskId).not.toBe(first.taskId);
    expect(runs).toHaveLength(2);
  });

  test('the same prompt in a different root session is never collapsed', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1));
    const second = await scheduler.submit(submitInput(2, { rootSessionId: 'ses_other' }));

    expect(second.taskId).not.toBe(first.taskId);
    expect(runs).toHaveLength(2);
  });

  test('an explicit child task is never collapsed onto its sibling', async () => {
    const { runs, scheduler } = await createHarness();

    const parent = await scheduler.submit(submitInput(1));
    const child = await scheduler.submit(submitInput(2, { parentTaskId: parent.taskId }));

    expect(child.taskId).not.toBe(parent.taskId);
    expect(runs).toHaveLength(2);
  });

  test('the original idempotency key still collapses a literal retry', async () => {
    const { runs, scheduler } = await createHarness();

    const first = await scheduler.submit(submitInput(1));
    const retry = await scheduler.submit(submitInput(1));

    expect(retry.taskId).toBe(first.taskId);
    expect(runs).toHaveLength(1);
  });
});
