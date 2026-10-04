import { describe, expect, test } from 'bun:test';
import { appendManagedAssignment, stripManagedAssignment } from './continuation-assignment.js';
import { createManagedAssistantActivityRegistry } from './assistant-activity.js';

import {
  createManagedOpenCodeExecutor,
  isManagedResumeContinuationPrompt,
  isManagedRetryInPlacePrompt,
  isManagedTransientTransportContinuationPrompt,
  MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX,
  MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT,
  MANAGED_READ_ONLY_PROMPT,
  MANAGED_RESUME_CONTINUATION_PROMPT,
  MANAGED_RETRY_IN_PLACE_PROMPT,
  MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT,
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
  MANAGED_TURN_BUDGET_ABORT_GRACE_TURNS,
  MANAGED_TURN_BUDGET_PROMPT,
} from './open-code-executor.js';

describe('managed continuation prompt recognition', () => {
  test('recognizes writable and read-only timeout/connection continuations exactly', () => {
    for (const prompt of [
      MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT,
      MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
    ]) {
      expect(isManagedTransientTransportContinuationPrompt(prompt)).toBe(true);
      expect(isManagedTransientTransportContinuationPrompt(
        `${MANAGED_READ_ONLY_PROMPT}\n\n${prompt}`,
      )).toBe(true);
      expect(isManagedTransientTransportContinuationPrompt(`${prompt} extra`)).toBe(false);
    }
  });

  test('does not classify manual or empty-output continuations as transport recovery', () => {
    expect(isManagedTransientTransportContinuationPrompt(
      MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT,
    )).toBe(false);
    expect(isManagedTransientTransportContinuationPrompt('Continue the task.')).toBe(false);
    expect(isManagedTransientTransportContinuationPrompt(null)).toBe(false);
  });

  test('recognizes only the exact writable and read-only resume continuation', () => {
    expect(isManagedResumeContinuationPrompt(MANAGED_RESUME_CONTINUATION_PROMPT)).toBe(true);
    expect(isManagedResumeContinuationPrompt(
      `${MANAGED_READ_ONLY_PROMPT}\n\n${MANAGED_RESUME_CONTINUATION_PROMPT}`,
    )).toBe(true);
    expect(isManagedResumeContinuationPrompt(`${MANAGED_RESUME_CONTINUATION_PROMPT} extra`)).toBe(false);
    expect(isManagedResumeContinuationPrompt(null)).toBe(false);
  });

  test('recognizes the retry-in-place prompt with and without its model continuation notice', () => {
    expect(MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX).toBe('Continuing on ');
    const notice = `${MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX}openai/gpt-5.6 · high after a provider usage limit.`;
    expect(isManagedRetryInPlacePrompt(MANAGED_RETRY_IN_PLACE_PROMPT)).toBe(true);
    expect(isManagedRetryInPlacePrompt(`${MANAGED_RETRY_IN_PLACE_PROMPT}\n\n${notice}`)).toBe(true);
    expect(isManagedRetryInPlacePrompt(
      `${MANAGED_READ_ONLY_PROMPT}\n\n${MANAGED_RETRY_IN_PLACE_PROMPT}\n\n${notice}`,
    )).toBe(true);
    expect(isManagedRetryInPlacePrompt(`${MANAGED_RETRY_IN_PLACE_PROMPT} extra`)).toBe(false);
    expect(isManagedRetryInPlacePrompt(`${MANAGED_RETRY_IN_PLACE_PROMPT}\n\nSomething else.`)).toBe(false);
    expect(isManagedResumeContinuationPrompt(`${MANAGED_RESUME_CONTINUATION_PROMPT}\n\n${notice}`)).toBe(true);
  });
});

const task = (overrides = {}) => ({
  owner: 'devryan',
  taskId: 'dvr_task_1',
  idempotencyKey: 'task-1',
  rootSessionId: 'ses_root',
  parentTaskId: null,
  childSessionId: null,
  directory: '/workspace',
  sequence: 1,
  mode: 'orchestrator',
  readOnly: false,
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: 'fast',
  label: 'Inspect authentication',
  prompt: 'Inspect the authentication flow.',
  status: 'starting',
  attempt: 1,
  priorTaskId: null,
  executionKind: 'start',
  leaseToken: 'dvr_lease_1',
  createdAt: 1_000,
  startedAt: 1_100,
  finishedAt: null,
  timeoutAt: null,
  failureReason: null,
  partial: false,
  recoverablePreview: '',
  canonicalRefs: [],
  ...overrides,
});

const assistant = (overrides = {}) => ({
  info: {
    id: 'msg_assistant',
    role: 'assistant',
    finish: 'stop',
    time: { completed: 2_000 },
    ...overrides.info,
  },
  parts: overrides.parts ?? [{ type: 'text', text: 'Finished analysis' }],
});

const deleteSession = async () => true;

// A disposable durable owner for executor-only recovery fixtures.
const recoveryControl = () => {
  let receipt = null;
  return {
    async markAccepted() { return true; },
    async recordTransportRecovery(next, expectedRevision) {
      expect(expectedRevision).toBe(receipt?.revision ?? 0);
      receipt = structuredClone(next);
      return true;
    },
  };
};


describe('managed OpenCode executor', () => {
  test('native removal settlement closes its observer without a second provider interrupt', async () => {
    let observing;
    const started = new Promise(resolve => { observing = resolve; });
    let providerAborts = 0;
    const current = task({ childSessionId: 'ses_child', status: 'running' });
    const executor = createManagedOpenCodeExecutor({ pollIntervalMs: 1, transport: {
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { observing(); return { type: 'busy' }; },
      async readMessages() { return []; },
      async promptSession() { throw new Error('must not prompt'); },
      async createSession() { throw new Error('must not create'); },
      async abortSession() { providerAborts++; throw new Error('native session is already held and stopped'); },
      deleteSession,
    } });
    try {
      const observation = executor.observe(current, recoveryControl());
      await started;
      await expect(executor.abort(current, { nativeSettled: true })).resolves.toEqual({ aborted: true });
      await expect(observation).resolves.toMatchObject({ status: 'aborted' });
      expect(providerAborts).toBe(0);
    } finally { await executor.shutdown(); }
  });
  test('parks the Go region rejection for one configured backup without resending to that model', async () => {
    const reason = "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.";
    const prompts = [];
    const original = task({ childSessionId: 'ses_child', status: 'running' });
    const executor = createManagedOpenCodeExecutor({ transport: {
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return [assistant({ info: { parentID: 'msg_original', error: { name: 'APIError', data: { message: reason, statusCode: 400 } } } })]; },
      async promptSession(input) { prompts.push(input); },
      async createSession() { throw new Error('must not create'); },
      async abortSession() { throw new Error('must not abort'); }, deleteSession,
    }, pollIntervalMs: 1 });
    const result = await executor.observe(original, recoveryControl());
    expect(result).toMatchObject({ status: 'failed', failureReason: reason });
    // Downgrade-compatible receipt: historical kind and a spent same-model budget.
    expect(original.transportRecovery).toMatchObject({ phase: 'exhausted', kind: 'connection_failure', sameModelAttempts: 1, backupAttempts: 0 });
    expect(prompts).toEqual([]);
    await executor.shutdown();
  });
  test.each(['event-before-finalizer', 'native-retry'])('region fallback waits for authoritative settlement: %s', async source => {
    const reason = "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.";
    let reads = 0, aborts = 0;
    const original = task({ childSessionId: 'ses_child', status: 'running' });
    const executor = createManagedOpenCodeExecutor({ transport: {
      async readSession() { return { id: 'ses_child' }; },
      async readTerminalError() { return source === 'event-before-finalizer' ? { eventId: 'event-config', message: reason, errorName: 'APIError' } : null; },
      async readStatus() { return source === 'native-retry' && !aborts ? { type: 'retry', message: reason, attempt: 1 } : { type: 'idle' }; },
      async readMessages() { reads++; return [assistant({ info: { parentID: 'msg_original',
        time: { created: 1, ...(reads >= 3 ? { completed: 2 } : {}) },
        error: { name: 'APIError', data: { message: reason, statusCode: 400 } } } })]; },
      async promptSession() { throw new Error('configuration rejection must not resend'); },
      async createSession() { throw new Error('must not create'); },
      async abortSession() { aborts++; }, deleteSession,
    }, pollIntervalMs: 1 });
    try {
      expect(await executor.observe(original, recoveryControl())).toMatchObject({ status: 'failed', failureReason: reason });
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(aborts).toBe(source === 'native-retry' ? 1 : 0);
      expect(original.transportRecovery).toMatchObject({ kind: 'connection_failure', phase: 'exhausted', sameModelAttempts: 1 });
    } finally { await executor.shutdown(); }
  });

  test('settles an authoritative model error without waiting for an assistant message', async () => {
    const terminalReads = [];
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession() {},
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return []; },
      async readTerminalError(input) {
        terminalReads.push(input);
        return {
          sessionId: 'ses_child',
          observedAt: 2_100,
          eventId: 'evt_model',
          errorName: 'UnknownError',
          message: 'Model not found: opencode/retired-model',
          code: null,
          statusCode: null,
          retryable: null,
        };
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => 2_000,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    const result = await executor.start(task(), {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
    });

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'Model not found: opencode/retired-model',
      resumable: true,
    });
    expect(terminalReads).toHaveLength(1);
    expect(terminalReads[0].after).toBe(2_000);
  });

  test('ignores a terminal error recorded before the current prompt attempt', async () => {
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession() {},
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return [assistant()]; },
      async readTerminalError(input) {
        return input.after <= 1_500 ? {
          sessionId: 'ses_child',
          observedAt: 1_500,
          eventId: 'evt_stale',
          errorName: 'UnknownError',
          message: 'Model not found: opencode/old-model',
          code: null,
          statusCode: null,
          retryable: null,
        } : null;
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => 2_000,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    await expect(executor.start(task(), {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
    })).resolves.toMatchObject({ status: 'completed' });
  });

  test('keeps a writable managed Oracle child on root-owned delegation', async () => {
    const prompts = [];
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return [assistant()]; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    const result = await executor.start(task({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      agent: 'oracle',
      readOnly: false,
    }), {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
    });

    expect(result.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe(
      'Inspect the authentication flow.',
    );
    expect(prompts[0].tools).toEqual({
      task: false,
    });
  });

  test('enforces read-only plan policy in the child prompt and tool surface', async () => {
    const prompts = [];
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return [assistant()]; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    const result = await executor.start(task({ readOnly: true }), {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
    });

    expect(result.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe([
      MANAGED_READ_ONLY_PROMPT,
      'Inspect the authentication flow.',
    ].join('\n\n'));
    expect(prompts[0].tools).toMatchObject({
      '*': false,
      task: false,
      read: true,
      glob: true,
      grep: true,
      ast_grep_search: true,
      webfetch: true,
    });
  });

  test('fails closed before child creation when Cursor cannot enforce read-only tools', async () => {
    let created = false;
    const transport = {
      async createSession() { created = true; return { id: 'ses_child' }; },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return null; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return []; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport });

    const operation = executor.start(task({
      providerId: 'cursor-acp',
      modelId: 'composer-2.5',
      readOnly: true,
    }), {});
    await expect(operation).rejects.toThrow('does not expose enforceable per-prompt write restrictions');
    await expect(operation).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED',
      statusCode: 409,
    });
    expect(created).toBe(false);
  });

  test('fails closed before child creation for a historical read-only Designer task', async () => {
    let created = false;
    const transport = {
      async createSession() { created = true; return { id: 'ses_child' }; },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return null; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return []; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport });

    const operation = executor.start(task({
      agent: 'designer',
      readOnly: true,
    }), {});
    await expect(operation).rejects.toThrow('Designer is implementation-only');
    await expect(operation).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED',
      statusCode: 409,
    });
    expect(created).toBe(false);
  });

  test('settles exhausted usage immediately while preserving partial work and stopping the retry loop', async () => {
    const calls = [];
    const statuses = [
      { type: 'retry', message: 'out of usage', attempt: 1, next: 5_000 },
      { type: 'idle' },
    ];
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        if (reads === 1) {
          return [assistant({
            info: { finish: 'tool-calls' },
            parts: [{ type: 'text', text: 'Useful partial analysis' }],
          })];
        }
        return [assistant()];
      },
      async abortSession(input) { calls.push(['abort', input]); return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      retryStopPollLimit: 4,
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({
      status: 'failed',
      failureReason: 'out of usage',
      partial: true,
      recoverablePreview: 'Useful partial analysis',
      canonicalRefs: [{ type: 'message', id: 'msg_assistant' }],
      resumable: true,
      providerResetAt: 5_000,
    });
    expect(reads).toBe(1);
    expect(calls.filter(([name]) => name === 'abort')).toHaveLength(1);
  });

  test.each([
    "Claude OAuth token has expired and could not be refreshed automatically. Run 'claude login' in your terminal to re-authenticate.",
    '{"type":"error","error":{"type":"authentication_error","message":"Claude authentication expired or invalid."}}',
  ])('parks a sign-in failure without aborting an unidentified turn: %s', async (message) => {
    const calls = [];
    const statuses = [
      { type: 'retry', message, attempt: 1, next: 2_000 },
      { type: 'idle' },
    ];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        return [assistant({ info: { finish: 'tool-calls' }, parts: [{ type: 'text', text: 'Useful partial analysis' }] })];
      },
      async abortSession(input) { calls.push(['abort', input]); return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined, retryStopPollLimit: 4 });
    const running = task({ childSessionId: 'ses_child', status: 'running' });

    const result = await executor.observe(running, {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({
      status: 'failed',
      failureReason: message,
      partial: true,
      recoverablePreview: 'Useful partial analysis',
      canonicalRefs: [{ type: 'message', id: 'msg_assistant' }],
      resumable: true,
    });
    expect(running.transportRecovery).toBeFalsy();
    expect(calls.filter(([name]) => name === 'abort')).toHaveLength(0);
  });

  test('settles the exact Zen free-tier retry without waiting for its multi-hour next attempt', async () => {
    const calls = [];
    const resetAt = Date.now() + (4 * 60 * 60 * 1_000);
    const statuses = [
      {
        type: 'retry',
        message: 'Free usage exceeded, subscribe to Go',
        attempt: 1,
        next: resetAt,
        action: { reason: 'free_tier_limit' },
      },
      { type: 'idle' },
    ];
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        return [assistant({
          info: { finish: 'tool-calls' },
          parts: [{ type: 'text', text: 'Partial Zen analysis' }],
        })];
      },
      async abortSession(input) { calls.push(['abort', input]); return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      retryStopPollLimit: 4,
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({
      status: 'failed',
      failureReason: 'Free usage exceeded, subscribe to Go',
      partial: true,
      recoverablePreview: 'Partial Zen analysis',
      canonicalRefs: [{ type: 'message', id: 'msg_assistant' }],
      resumable: true,
      // The provider's own reset hint rides along so the scheduler can plan an
      // automatic resume instead of parking blindly.
      providerResetAt: resetAt,
    });
    expect(reads).toBe(1);
    expect(calls.filter(([name]) => name === 'abort')).toHaveLength(1);
  });

  test('canonicalizes a structured free-tier failure when its message is unfamiliar', async () => {
    const statuses = [
      {
        type: 'retry',
        message: 'Subscribe to continue',
        action: { reason: 'free_tier_limit' },
      },
      { type: 'idle' },
    ];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() { return [assistant()]; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      retryStopPollLimit: 4,
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'Provider usage limit reached: Subscribe to continue',
      resumable: true,
    });
  });

  test('keeps the same child live through a transient provider retry and busy before completing', async () => {
    const calls = [];
    const statuses = [
      { type: 'retry', message: 'temporarily unavailable', attempt: 1, next: 5_000 },
      { type: 'busy' },
      { type: 'idle' },
    ];
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { calls.push(['prompt', input]); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        return reads === 3 ? [assistant()] : [];
      },
      async abortSession(input) { calls.push(['abort', input]); return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });
    const original = task({ childSessionId: 'ses_child', status: 'running' });

    const result = await executor.observe(original, {});

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Finished analysis',
    });
    expect(reads).toBe(3);
    expect(calls.filter(([name]) => name === 'prompt')).toHaveLength(0);
    expect(calls.filter(([name]) => name === 'abort')).toHaveLength(0);
  });

  test('does not settle an in-place retry from its initial empty assistant placeholder', async () => {
    let observationReads = 0;
    const prompts = [];
    const statuses = [{ type: 'idle' }, { type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        observationReads += 1;
        if (observationReads < 3) {
          return [assistant({
            info: { id: 'msg_placeholder', finish: undefined, time: { completed: 2_000 } },
            parts: [],
          })];
        }
        return [assistant({
          info: { id: 'msg_completed', finish: 'stop', time: { completed: 3_000 } },
          parts: [{ type: 'text', text: 'Continued in the same child' }],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 2,
    });

    const result = await executor.retryInPlace(task({
      childSessionId: 'ses_child',
      executionKind: 'retry_in_place',
      attempt: 2,
      priorTaskId: 'dvr_task_original',
    }), { async markAccepted() {} });

    expect(observationReads).toBe(3);
    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Continued in the same child',
    });
    // The placeholder is the tail this retry inherited, so the stale-tail anchor waits it
    // out instead of spending the one-shot empty-output continuation on it.
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain(MANAGED_RETRY_IN_PLACE_PROMPT);
    expect(prompts.every((prompt) => prompt.tools?.task === false)).toBe(true);
  });

  test('observes a cross-provider in-place retry by creation time instead of incompatible message IDs', async () => {
    let prompted = false;
    let clock = 0;
    const prompts = [];
    const legacyCursorTail = assistant({
      info: {
        id: 'msg_1a00579c4bf255ecd54_assistant',
        finish: 'error',
        time: { created: 1_000, completed: 1_100 },
      },
      parts: [{ type: 'text', text: 'Older Cursor result' }],
    });
    const recoveredOpenAiTail = assistant({
      info: {
        id: 'msg_005959f640013jZ67Mdq5lNl0F',
        finish: 'stop',
        time: { created: 2_000, completed: 2_100 },
      },
      parts: [{ type: 'text', text: 'Newer OpenAI recovery result' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) {
        prompts.push(input);
        prompted = true;
      },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        if (!prompted) return [legacyCursorTail];
        // OpenCode's ID ordering puts the newer native message before the legacy
        // Cursor message even though its authoritative creation time is later.
        return [recoveredOpenAiTail, legacyCursorTail];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      continuationStartGraceMs: 1,
      idleStablePolls: 1,
      now: () => clock,
      sleep: async () => { clock += 2; },
    });

    const result = await executor.retryInPlace(task({
      childSessionId: 'ses_child',
      executionKind: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      attempt: 3,
      priorTaskId: 'dvr_task_cursor_retry',
    }), { async markAccepted() { return true; } });

    expect(prompts).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Newer OpenAI recovery result',
    });
  });

  test('keeps repeated identical provider retry snapshots live', async () => {
    let abortCount = 0;
    let reads = 0;
    const retry = { type: 'retry', message: 'temporarily unavailable', attempt: 1, next: 5_000 };
    const statuses = [retry, retry, retry, { type: 'idle' }];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        return reads === 4 ? [assistant()] : [];
      },
      async abortSession() { abortCount += 1; return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result.status).toBe('completed');
    expect(reads).toBe(4);
    expect(abortCount).toBe(0);
  });

  test('does not settle an assistant error while provider retry remains live', async () => {
    let reads = 0;
    const statuses = [{ type: 'retry', message: 'temporarily unavailable' }, { type: 'idle' }];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        if (reads === 1) {
          return [assistant({
            info: { finish: 'error', error: { message: 'retryable provider error' } },
            parts: [{ type: 'text', text: 'Partial work before automatic retry' }],
          })];
        }
        return [assistant({
          info: { id: 'msg_final', finish: 'stop' },
          parts: [{ type: 'text', text: 'Completed after automatic retry' }],
        })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after automatic retry',
    });
    expect(reads).toBe(2);
  });

  test('fails once and remains resumable when retry is followed by a terminal assistant error', async () => {
    let reads = 0;
    let abortCount = 0;
    const statuses = [{ type: 'retry', message: 'temporarily unavailable' }, { type: 'idle' }];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        if (reads === 1) {
          return [assistant({
            info: { finish: 'tool-calls' },
            parts: [{ type: 'text', text: 'Partial work before retry' }],
          })];
        }
        return [assistant({
          info: { finish: 'error', error: { message: 'provider failed permanently' } },
          parts: [],
        })];
      },
      async abortSession() { abortCount += 1; return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result).toEqual({
      status: 'failed',
      failureReason: 'provider failed permanently',
      partial: false,
      recoverablePreview: '',
      canonicalRefs: [{ type: 'message', id: 'msg_assistant' }],
      resumable: true,
    });
    expect(reads).toBe(2);
    expect(abortCount).toBe(0);
  });

  test('continues once in the same child after a terminal assistant operation timeout', async () => {
    const prompts = [];
    const statuses = [{ type: 'busy' }, { type: 'idle' }];
    let reads = 0;
    const timeoutMessage = assistant({
      info: {
        id: 'msg_timeout',
        finish: 'error',
        error: { message: 'The operation timed out.' },
      },
      parts: [{ type: 'text', text: 'Partial work before timeout' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return prompts.length === 0 ? { type: 'idle' } : statuses.shift() ?? { type: 'idle' }; },
      // The recovery message appears because the continuation prompt was sent,
      // not because the transcript happened to be read a certain number of
      // times — a live child is no longer re-read on every poll.
      async readMessages() {
        reads += 1;
        if (prompts.length === 0) return [timeoutMessage];
        return [
          timeoutMessage,
          assistant({
            info: { id: 'msg_completed', parentID: prompts.at(-1).messageId },
            parts: [{ type: 'text', text: 'Completed after timeout recovery' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });
    const original = task({ childSessionId: 'ses_child', status: 'running' });

    const result = await executor.observe(original, recoveryControl());

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after timeout recovery',
    });
    expect(prompts).toEqual([{
      taskId: 'dvr_task_1',
      leaseToken: 'dvr_lease_1',
      sessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: 'fast',
      // The durable receipt uses a fresh OpenCode-sortable ID.
      messageId: expect.stringMatching(/^msg_[0-9a-f]{26}$/),
      signal: expect.any(AbortSignal),
      prompt: appendManagedAssignment(task(), MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT),
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
    }]);
  });

  test('continues once in the same child after the Claude connection closes mid-response', async () => {
    const prompts = [];
    const statuses = [{ type: 'busy' }, { type: 'idle' }];
    const connectionFailure = '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}';
    const interruptedMessage = assistant({
      info: {
        id: 'msg_connection_failure',
        finish: 'error',
        error: { name: 'UnknownError', data: { message: connectionFailure } },
      },
      parts: [{ type: 'text', text: 'Useful work before the connection closed' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return prompts.length === 0 ? { type: 'idle' } : statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [interruptedMessage];
        return [
          interruptedMessage,
          {
            info: { id: prompts.at(-1).messageId, role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed', parentID: prompts.at(-1).messageId },
            parts: [{ type: 'text', text: 'Completed after connection recovery' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.resume(task({
      childSessionId: 'ses_child',
      executionKind: 'resume',
      status: 'running',
    }), recoveryControl());

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after connection recovery',
    });
    expect(prompts).toEqual([{
      taskId: 'dvr_task_1',
      leaseToken: 'dvr_lease_1',
      sessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: 'fast',
      messageId: expect.stringMatching(/^msg_[0-9a-f]{26}$/),
      signal: expect.any(AbortSignal),
      prompt: appendManagedAssignment(task(), MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT),
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
    }]);
  });

  test('settles a resumed child immediately when Zen reports structured free-tier exhaustion', async () => {
    const prompts = [];
    let accepted = 0;
    const statuses = [
      {
        type: 'retry',
        message: 'Free usage exceeded, subscribe to Go',
        action: { reason: 'free_tier_limit' },
        next: Date.now() + (4 * 60 * 60 * 1_000),
      },
      { type: 'idle' },
    ];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: { finish: 'tool-calls' },
          parts: [{ type: 'text', text: 'Retained work' }],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.resume(task({
      childSessionId: 'ses_child',
      executionKind: 'resume',
      status: 'running',
    }), {
      async markAccepted() { accepted += 1; return true; },
    });

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'Free usage exceeded, subscribe to Go',
      recoverablePreview: 'Retained work',
      resumable: true,
    });
    expect(accepted).toBe(1);
    expect(prompts).toHaveLength(0);
  });

  test('actively continues an idle aborted child exactly once when resume is selected', async () => {
    const prompts = [];
    let accepted = 0;
    const statuses = [{ type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const aborted = assistant({
      info: {
        id: 'msg_aborted',
        finish: 'error',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
      parts: [{ type: 'text', text: 'Useful work before the deadline' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [aborted];
        return [
          aborted,
          {
            info: { id: 'msg_resume_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed' },
            parts: [{ type: 'text', text: 'Completed after managed resume' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.resume(task({
      childSessionId: 'ses_child',
      executionKind: 'resume',
      status: 'starting',
    }), {
      async markAccepted() { accepted += 1; return true; },
    });

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after managed resume',
    });
    expect(accepted).toBe(1);
    expect(prompts).toEqual([{
      taskId: 'dvr_task_1',
      leaseToken: 'dvr_lease_1',
      sessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: 'fast',
      prompt: appendManagedAssignment(task(), MANAGED_RESUME_CONTINUATION_PROMPT),
      signal: expect.any(AbortSignal),
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
    }]);
  });

  test('resumes a child that is still tearing down the attempt the deadline killed', async () => {
    // The live failure: an auto-resume dispatched seconds after the timeout abort saw the
    // child still busy, skipped the continuation entirely, then read the killed turn's
    // tail and reported "Aborted" about one second after being dispatched.
    const prompts = [];
    let statusReads = 0;
    const aborted = assistant({
      info: {
        id: 'msg_killed_by_deadline',
        finish: 'error',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
      parts: [
        { type: 'text', text: 'Work completed before the deadline' },
        { type: 'tool', callID: 'tool_killed', state: { status: 'error', error: 'Tool execution aborted' } },
      ],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        statusReads += 1;
        // Teardown of the killed turn keeps reporting busy for the first few reads.
        return statusReads <= 3 ? { type: 'busy' } : { type: 'idle' };
      },
      async readMessages() {
        if (prompts.length === 0) return [aborted];
        return [
          aborted,
          {
            info: { id: 'msg_resume_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed_after_resume' },
            parts: [{ type: 'text', text: 'Finished the remaining work' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.resume(task({
      childSessionId: 'ses_child',
      executionKind: 'resume',
      status: 'starting',
      attempt: 2,
    }), { async markAccepted() { return true; } });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe(appendManagedAssignment(task(), MANAGED_RESUME_CONTINUATION_PROMPT));
    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Finished the remaining work',
    });
  });

  test('resumes again in a child that already used a continuation on an earlier attempt', async () => {
    // The gate used to count resume prompts across the whole transcript, so the second
    // recovery of the same child silently skipped its own continuation.
    const prompts = [];
    const priorResume = {
      info: { id: 'msg_prior_resume_prompt', role: 'user' },
      parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
    };
    const aborted = assistant({
      info: {
        id: 'msg_second_deadline_kill',
        finish: 'error',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
      parts: [{ type: 'text', text: 'More work before the second deadline' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [priorResume, aborted];
        return [
          priorResume,
          aborted,
          {
            info: { id: 'msg_resume_prompt_2', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed_second' },
            parts: [{ type: 'text', text: 'Finished on the second recovery' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.resume(task({
      childSessionId: 'ses_child',
      executionKind: 'resume',
      status: 'starting',
      attempt: 3,
    }), { async markAccepted() { return true; } });

    expect(prompts).toHaveLength(1);
    expect(result).toMatchObject({ status: 'completed' });
  });

  test('re-posts a dropped continuation once, then reports the stale tail honestly', async () => {
    const prompts = [];
    let clock = 0;
    const aborted = assistant({
      info: {
        id: 'msg_stale_tail',
        finish: 'error',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
      parts: [{ type: 'text', text: 'Work that survived' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      // The prompt is recorded but never starts. A pending continuation must still hit
      // the stale-tail grace bound instead of polling until the task's hard deadline.
      async readMessages() {
        return prompts.length === 0
          ? [aborted]
          : [
              aborted,
              {
                info: { id: 'msg_pending_resume', role: 'user' },
                parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
              },
            ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => { clock += 30_000; },
      now: () => clock,
    });

    const result = await executor.resume(task({
      childSessionId: 'ses_child',
      executionKind: 'resume',
      status: 'starting',
    }), { async markAccepted() { return true; } });

    // One initial continuation plus exactly one re-post, then an honest terminal result
    // rather than polling silently until the hard deadline.
    expect(prompts).toHaveLength(2);
    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'Aborted',
      partial: true,
      recoverablePreview: 'Work that survived',
    });
  });

  test('reports work completed before an abort instead of the aborted tool tail', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [
          assistant({
            info: { id: 'msg_useful', finish: 'tool-calls', time: { completed: 1_500 } },
            parts: [{ type: 'text', text: 'Applied the migration and verified the schema' }],
          }),
          assistant({
            info: {
              id: 'msg_killed',
              finish: 'error',
              error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
            },
            parts: [{
              type: 'tool',
              callID: 'tool_killed',
              state: { status: 'error', error: 'Tool execution aborted' },
            }],
          }),
        ];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const recovered = await executor.readRecoverableResult(task({ childSessionId: 'ses_child' }));

    expect(recovered.recoverablePreview).toBe('Applied the migration and verified the schema');
    expect(recovered.partial).toBe(true);
    // The killed turn's tool is still referenced so the work stays addressable.
    expect(recovered.canonicalRefs).toEqual(expect.arrayContaining([
      { type: 'tool', id: 'tool_killed', messageId: 'msg_killed' },
    ]));
  });

  test('fails honestly when the recovered child loses its provider connection again', async () => {
    const prompts = [];
    const statuses = [{ type: 'busy' }, { type: 'idle' }];
    const connectionFailure = '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}';
    const firstFailure = assistant({
      info: {
        id: 'msg_connection_failure_1',
        finish: 'error',
        error: { data: { message: connectionFailure } },
      },
      parts: [{ type: 'text', text: 'Partial work before the first disconnect' }],
    });
    const secondFailure = assistant({
      info: {
        id: 'msg_connection_failure_2',
        finish: 'error',
        error: { data: { message: connectionFailure } },
      },
      parts: [],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return prompts.length === 0 ? { type: 'idle' } : statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [firstFailure];
        return [
          firstFailure,
          {
            info: { id: prompts.at(-1).messageId, role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
          },
          { ...secondFailure, info: { ...secondFailure.info, parentID: prompts.at(-1).messageId } },
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      recoveryControl(),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: connectionFailure,
      partial: true,
      recoverablePreview: 'Partial work before the first disconnect',
      resumable: true,
    });
    expect(prompts).toHaveLength(1);
  });

  test('fails honestly when the same child times out again after automatic continuation', async () => {
    const prompts = [];
    const statuses = [{ type: 'busy' }, { type: 'idle' }];
    let reads = 0;
    const firstTimeout = assistant({
      info: {
        id: 'msg_timeout_1',
        finish: 'error',
        error: { message: 'The operation timed out.' },
      },
      parts: [{ type: 'text', text: 'Partial work before timeout' }],
    });
    const secondTimeout = assistant({
      info: {
        id: 'msg_timeout_2',
        finish: 'error',
        error: { message: 'The operation timed out.' },
      },
      parts: [],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return prompts.length === 0 ? { type: 'idle' } : statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        return prompts.length === 0 ? [firstTimeout] : [firstTimeout, { ...secondTimeout, info: { ...secondTimeout.info, parentID: prompts.at(-1).messageId } }];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      recoveryControl(),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'The operation timed out.',
      partial: true,
      recoverablePreview: 'Partial work before timeout',
      resumable: true,
    });
    expect(prompts).toHaveLength(1);
  });

  test('continues a silent busy child once in place after the live-progress timeout', async () => {
    let clock = 0;
    let aborted = false;
    let prompted = false;
    let abortCount = 0;
    const prompts = [];
    const stalled = assistant({
      info: { id: 'msg_stalled', finish: undefined, time: {} },
      parts: [{ id: 'prt_reasoning', type: 'reasoning', text: '' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); prompted = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        if (aborted && !prompted) return { type: 'idle' };
        return prompted ? { type: 'idle' } : { type: 'busy' };
      },
      async readMessages() {
        if (!prompted) return [stalled];
        return [
          stalled,
          {
            info: { id: prompts.at(-1).messageId, role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed', parentID: prompts.at(-1).messageId },
            parts: [{ type: 'text', text: 'Completed after silent-stream recovery' }],
          }),
        ];
      },
      async abortSession() {
        abortCount += 1;
        aborted = true;
        stalled.info.finish = 'abort';
        stalled.info.time.completed = clock;
        for (const part of stalled.parts) {
          if (part.type === 'tool') part.state = { ...part.state, status: 'error', error: 'Tool execution aborted' };
        }
        return true;
      },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      liveProgressTimeoutMs: 100,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      recoveryControl(),
    );

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after silent-stream recovery',
    });
    expect(abortCount).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      sessionId: 'ses_child',
      prompt: appendManagedAssignment(task(), MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT),
      tools: { task: false },
    });
  });

  test('reports deadline progress only after a changed live transcript, not startup history or busy heartbeats', async () => {
    let clock = 1_000;
    let statusReads = 0;
    const progress = [];
    const executor = createManagedOpenCodeExecutor({
      transport: {
        async createSession() { throw new Error('must not create'); },
        async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; },
        async readStatus() { return { type: ++statusReads <= 3 ? 'busy' : 'idle' }; },
        async readMessages() {
          return [assistant({
            info: statusReads <= 3 ? { finish: undefined, time: {} } : {},
            parts: [{ type: 'text', text: statusReads < 3 ? 'Retained work' : 'Retained work and new verification' }],
          })];
        },
        async abortSession() { throw new Error('must not abort'); },
        deleteSession,
      },
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
    });
    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {
      async recordProgress(value) { progress.push(value); return true; },
    });
    expect(result.status).toBe('completed');
    expect(progress.filter((value) => 'assistantProgressAt' in value)).toEqual([{ assistantProgressAt: 1_200 }]);
    await executor.shutdown();
  });

  test('continues a busy child whose provider stalls while constructing blank tool input', async () => {
    let clock = 0;
    let aborted = false;
    let prompted = false;
    let abortCount = 0;
    const prompts = [];
    const stalled = assistant({
      info: { id: 'msg_stalled_tool_input', finish: undefined, time: {} },
      parts: [
        { id: 'prt_reasoning', type: 'reasoning', text: 'Preparing the documentation patch' },
        {
          id: 'prt_pending_patch',
          type: 'tool',
          tool: 'apply_patch',
          callID: 'call_pending_patch',
          state: { status: 'pending', input: {} },
        },
      ],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); prompted = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        if (aborted && !prompted) return { type: 'idle' };
        return prompted ? { type: 'idle' } : { type: 'busy' };
      },
      async readMessages() {
        if (!prompted) return [stalled];
        return [
          stalled,
          {
            info: { id: prompts.at(-1).messageId, role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed_after_tool_input_stall', parentID: prompts.at(-1).messageId },
            parts: [{ type: 'text', text: 'Completed after blank tool-input recovery' }],
          }),
        ];
      },
      async abortSession() {
        abortCount += 1;
        aborted = true;
        stalled.info.finish = 'abort';
        stalled.info.time.completed = clock;
        for (const part of stalled.parts) {
          if (part.type === 'tool') part.state = { ...part.state, status: 'error', error: 'Tool execution aborted' };
        }
        return true;
      },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      liveProgressTimeoutMs: 100,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      recoveryControl(),
    );

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after blank tool-input recovery',
    });
    expect(abortCount).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe(appendManagedAssignment(task(), MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT));
  });

  test('ignores an abandoned in-flight tool from an earlier same-child attempt', async () => {
    let clock = 0;
    let aborted = false;
    let prompted = false;
    let abortCount = 0;
    const prompts = [];
    const abandonedTool = assistant({
      info: { id: 'msg_abandoned_tool', finish: 'tool-calls' },
      parts: [{
        id: 'prt_abandoned_tool',
        type: 'tool',
        tool: 'bash',
        callID: 'call_abandoned_tool',
        state: { status: 'running', input: { command: 'long-command' } },
      }],
    });
    const retryPrompt = {
      info: { id: 'msg_retry_in_place', role: 'user' },
      parts: [{ type: 'text', text: MANAGED_RETRY_IN_PLACE_PROMPT }],
    };
    const stalledRetry = assistant({
      info: { id: 'msg_stalled_retry', finish: undefined, time: {} },
      parts: [{ id: 'prt_stalled_retry', type: 'reasoning', text: '' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); prompted = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        if (aborted && !prompted) return { type: 'idle' };
        return prompted ? { type: 'idle' } : { type: 'busy' };
      },
      async readMessages() {
        if (!prompted) return [abandonedTool, retryPrompt, stalledRetry];
        return [
          abandonedTool,
          retryPrompt,
          stalledRetry,
          {
            info: { id: prompts.at(-1).messageId, role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed_retry', parentID: prompts.at(-1).messageId },
            parts: [{ type: 'text', text: 'Completed the recovered attempt' }],
          }),
        ];
      },
      async abortSession() {
        abortCount += 1;
        aborted = true;
        stalledRetry.info.finish = 'abort';
        stalledRetry.info.time.completed = clock;
        for (const part of stalledRetry.parts) {
          if (part.type === 'tool') part.state = { ...part.state, status: 'error', error: 'Tool execution aborted' };
        }
        return true;
      },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      liveProgressTimeoutMs: 100,
    });

    const result = await executor.observe(
      task({
        childSessionId: 'ses_child',
        status: 'running',
        attempt: 2,
        executionKind: 'retry_in_place',
      }),
      recoveryControl(),
    );

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed the recovered attempt',
    });
    expect(abortCount).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  test('fails visibly and resumably when the same child silently stalls again', async () => {
    let clock = 0;
    let generation = 0;
    let abortCount = 0;
    const prompts = [];
    const completedToolWork = assistant({
      info: { id: 'msg_tools', finish: 'tool-calls' },
      parts: [{
        id: 'prt_tool',
        type: 'tool',
        callID: 'call_tool',
        state: { status: 'completed', output: 'Useful inspected files' },
      }],
    });
    const stalledAssistant = (id) => assistant({
      info: {
        id, parentID: id === 'msg_stalled_2' ? prompts.at(-1).messageId : null,
        finish: abortCount >= (id === 'msg_stalled_2' ? 2 : 1) ? 'abort' : undefined,
        time: abortCount >= (id === 'msg_stalled_2' ? 2 : 1) ? { completed: clock } : {},
      },
      parts: [{ id: `${id}_reasoning`, type: 'reasoning', text: '' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); generation = 1; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        if ((generation === 0 && abortCount >= 1) || abortCount >= 2) return { type: 'idle' };
        return { type: 'busy' };
      },
      async readMessages() {
        if (generation === 0) return [completedToolWork, stalledAssistant('msg_stalled_1')];
        return [
          completedToolWork,
          stalledAssistant('msg_stalled_1'),
          {
            info: { id: prompts.at(-1).messageId, role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
          },
          stalledAssistant('msg_stalled_2'),
        ];
      },
      async abortSession() { abortCount += 1; return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      liveProgressTimeoutMs: 100,
    });

    const original = task({ childSessionId: 'ses_child', status: 'running' });
    const result = await executor.observe(
      original,
      recoveryControl(),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('Stream idle timeout'),
      partial: true,
      recoverablePreview: 'Useful inspected files',
      resumable: true,
    });
    expect(abortCount).toBe(2);
    expect(prompts).toHaveLength(1);
    expect(original.transportRecovery).toMatchObject({ phase: 'exhausted', failedMessageId: 'msg_stalled_2',
      failedUserMessageId: prompts[0].messageId });
  });

  test('does not apply the live-progress timeout while a tool is still running', async () => {
    let clock = 0;
    let statusReads = 0;
    let abortCount = 0;
    const toolTurn = (status) => assistant({
      info: { id: 'msg_tool', finish: 'tool-calls' },
      parts: [{
        id: 'prt_tool',
        type: 'tool',
        callID: 'call_tool',
        state: { status },
      }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        statusReads += 1;
        return statusReads <= 3 ? { type: 'busy' } : { type: 'idle' };
      },
      async readMessages() {
        if (statusReads <= 3) return [toolTurn('running')];
        return [
          toolTurn('completed'),
          assistant({
            info: { id: 'msg_completed' },
            parts: [{ type: 'text', text: 'Completed after the long tool' }],
          }),
        ];
      },
      async abortSession() { abortCount += 1; return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      liveProgressTimeoutMs: 100,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      {},
    );

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after the long tool',
    });
    expect(abortCount).toBe(0);
  });

  test('does not apply the live-progress timeout while pending tool input is material', async () => {
    let clock = 0;
    let statusReads = 0;
    let abortCount = 0;
    const pendingTool = assistant({
      info: { id: 'msg_pending_material_tool', finish: 'tool-calls' },
      parts: [{
        id: 'prt_pending_material_tool',
        type: 'tool',
        tool: 'apply_patch',
        callID: 'call_pending_material_tool',
        state: {
          status: 'pending',
          input: { patch: '*** Begin Patch' },
          raw: '{"patch":"*** Begin Patch"}',
        },
      }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        statusReads += 1;
        return statusReads <= 3 ? { type: 'busy' } : { type: 'idle' };
      },
      async readMessages() {
        if (statusReads <= 3) return [pendingTool];
        return [
          assistant({
            info: { id: 'msg_completed_material_tool' },
            parts: [{ type: 'text', text: 'Completed after material tool input' }],
          }),
        ];
      },
      async abortSession() { abortCount += 1; return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      liveProgressTimeoutMs: 100,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      {},
    );

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after material tool input',
    });
    expect(abortCount).toBe(0);
  });

  describe('operator Stop on a managed child', () => {
    // The incident: a Stop during OpenCode's provider-retry wait leaves an
    // assistant with no finish and no error, then idle.
    const user = { info: { id: 'msg_user', role: 'user', time: { created: 1_500 } }, parts: [{ type: 'text', text: 'Do the work' }] };
    const stopped = assistant({ info: { id: 'msg_stopped', finish: undefined, parentID: 'msg_user' }, parts: [] });
    const fixture = ({ statuses = [], messages = () => [user, stopped], operatorAbort = null, terminalError = null } = {}) => {
      const calls = { prompts: [], aborts: 0 };
      const transport = {
        async createSession() { throw new Error('must not create'); },
        async promptSession(input) { calls.prompts.push(input); },
        async readSession() { return { id: 'ses_child' }; },
        async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
        async readMessages() { return messages(); },
        async abortSession() { calls.aborts += 1; return true; },
        deleteSession,
        ...(operatorAbort ? { readOperatorAbort: async ({ after }) => (operatorAbort.requestedAt >= after ? operatorAbort : null) } : {}),
        ...(terminalError ? { readTerminalError: async () => terminalError } : {}),
      };
      const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined, resumeTeardownSettleMs: 0 });
      return { calls, executor };
    };

    test('without a Stop, the empty idle turn is continued automatically (baseline)', async () => {
      const seen = {};
      const continuation = { info: { id: 'msg_continue', role: 'user', time: { created: 3_000 } }, parts: [{ type: 'text', text: MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT }] };
      const { calls, executor } = fixture({ messages: () => (seen.calls?.prompts.length
        ? [user, stopped, continuation, assistant({ info: { id: 'msg_done', parentID: 'msg_continue' } })]
        : [user, stopped]) });
      seen.calls = calls;
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'completed' });
      expect(calls.prompts).toHaveLength(1);
      expect(calls.prompts[0].prompt).toContain(MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT);
    });

    test('a Stop settles the child as aborted and never sends a continuation', async () => {
      const { calls, executor } = fixture({ operatorAbort: { sessionId: 'ses_child', requestedAt: 2_500 } });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'aborted', failureReason: 'Stopped by the user', resumable: true });
      expect(calls.prompts).toHaveLength(0);
    });

    test('a cancellation error after a Stop is an abort, not a failure', async () => {
      const { calls, executor } = fixture({
        operatorAbort: { sessionId: 'ses_child', requestedAt: 2_500 },
        terminalError: { sessionId: 'ses_child', observedAt: 2_600, eventId: 'evt_abort', errorName: 'MessageAbortedError', message: 'Aborted', code: null, statusCode: null, retryable: null },
      });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'aborted', failureReason: 'Stopped by the user' });
      expect(calls.prompts).toHaveLength(0);
    });

    test('a Stop from an earlier attempt does not affect this one', async () => {
      const { calls, executor } = fixture({ operatorAbort: { sessionId: 'ses_child', requestedAt: 900 },
        messages: () => [user, assistant({ info: { id: 'msg_done', parentID: 'msg_user' } })] });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'completed' });
      expect(calls.prompts).toHaveLength(0);
    });

    test('input sent after the Stop continues the child normally', async () => {
      const steered = { info: { id: 'msg_steer', role: 'user', time: { created: 3_000 } }, parts: [{ type: 'text', text: 'Use the other file' }] };
      const { executor } = fixture({ operatorAbort: { sessionId: 'ses_child', requestedAt: 2_500 },
        messages: () => [user, stopped, steered, assistant({ info: { id: 'msg_done', parentID: 'msg_steer' } })] });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'Finished analysis' });
    });

    test('useful output that completed despite the Stop is kept', async () => {
      const { executor } = fixture({ operatorAbort: { sessionId: 'ses_child', requestedAt: 2_500 },
        messages: () => [user, assistant({ info: { id: 'msg_done', parentID: 'msg_user' } })] });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'completed' });
    });

    test('a child still retrying after the Stop is stopped without any automatic prompt', async () => {
      const { calls, executor } = fixture({
        operatorAbort: { sessionId: 'ses_child', requestedAt: 2_500 },
        statuses: [{ type: 'retry', attempt: 2, message: 'Overloaded', next: 4_000 }, { type: 'retry', attempt: 2, message: 'Overloaded', next: 4_000 }],
      });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'aborted', failureReason: 'Stopped by the user' });
      expect(calls.aborts).toBeGreaterThanOrEqual(1);
      expect(calls.prompts).toHaveLength(0);
    });
  });

  describe('managed child orphaned by an OpenCode restart', () => {
    const user = { info: { id: 'msg_user', role: 'user', time: { created: 1_500 } }, parts: [{ type: 'text', text: 'Do the work' }] };
    // The incident: an apply_patch tool part still "running" after the process died.
    const running = assistant({ info: { id: 'msg_running', finish: undefined, parentID: 'msg_user', time: {} },
      parts: [{ type: 'tool', tool: 'apply_patch', callID: 'call_patch', state: { status: 'running', input: {} } }] });
    const fixture = ({ messages, runtimeStartedAt, statuses = [] }) => {
      const calls = { prompts: 0, statusReads: 0 };
      const transport = {
        async createSession() { throw new Error('must not create'); },
        async promptSession() { calls.prompts += 1; },
        async readSession() { return { id: 'ses_child' }; },
        async readStatus() { calls.statusReads += 1; return statuses.shift() ?? { type: 'idle' }; },
        async readMessages() { return messages(); },
        async abortSession() { return true; },
        deleteSession,
        ...(runtimeStartedAt === undefined ? {} : { readRuntimeStartedAt: () => runtimeStartedAt }),
      };
      return { calls, executor: createManagedOpenCodeExecutor({ transport, sleep: async () => undefined }) };
    };

    test('settles as interrupted and resumable instead of polling to the deadline', async () => {
      const { calls, executor } = fixture({ messages: () => [user, running], runtimeStartedAt: 5_000 });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({
        status: 'interrupted',
        failureReason: 'Managed child was interrupted: the OpenCode runtime restarted while it was running',
        resumable: true,
      });
      expect(calls.prompts).toBe(0);
    });

    test('input sent to the restarted runtime is not an orphan', async () => {
      let reads = 0;
      const later = { info: { id: 'msg_later', role: 'user', time: { created: 6_000 } }, parts: [{ type: 'text', text: 'Continue' }] };
      const { executor } = fixture({ runtimeStartedAt: 5_000, messages: () => (++reads < 4
        ? [user, later]
        : [user, later, assistant({ info: { id: 'msg_done', parentID: 'msg_later' } })]) });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'completed' });
    });

    test('without a known runtime start the child keeps today\'s behaviour', async () => {
      let reads = 0;
      const { executor } = fixture({ runtimeStartedAt: null, messages: () => (++reads < 4
        ? [user, running]
        : [user, assistant({ info: { id: 'msg_done', parentID: 'msg_user' } })]) });
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      expect(result).toMatchObject({ status: 'completed' });
    });
  });

  test('never collects a child on its compaction summary; it continues with the assignment instead', async () => {
    const prompts = [];
    const statuses = [{ type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const work = assistant({ info: { id: 'msg_work', finish: 'tool-calls' },
      parts: [{ type: 'tool', callID: 'call_read', state: { status: 'completed', output: 'Parser source' } }] });
    const compaction = { info: { id: 'msg_compact', role: 'user' }, parts: [{ type: 'compaction', auto: true }] };
    const summary = assistant({ info: { id: 'msg_summary', parentID: 'msg_compact', summary: true, mode: 'compaction' },
      parts: [{ type: 'text', text: '## Delegated assignment\nFix the parser. Remaining: tests.' }] });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [work, compaction, summary];
        return [work, compaction, summary,
          { info: { id: 'msg_continue', role: 'user' }, parts: [{ type: 'text', text: MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT }] },
          assistant({ info: { id: 'msg_done' }, parts: [{ type: 'text', text: 'Parser fixed and tested' }] })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });
    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
    expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'Parser fixed and tested' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe(appendManagedAssignment(task(), MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT));
  });

  test('continues once in the same child when a provider stops after tools without a final answer', async () => {
    const prompts = [];
    const statuses = [{ type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const incomplete = assistant({
      info: {
        id: 'msg_incomplete',
        finish: 'unknown',
      },
      parts: [{ type: 'reasoning', text: 'Now I have all' }],
    });
    const toolWork = assistant({
      info: {
        id: 'msg_tools',
        finish: 'unknown',
      },
      parts: [
        {
          type: 'tool',
          callID: 'call_completed',
          state: { status: 'completed', output: 'Official documentation' },
        },
        {
          type: 'tool',
          callID: 'call_invalid',
          state: { status: 'error', error: '"undefined" cannot be parsed as a URL.' },
        },
      ],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [toolWork, incomplete];
        return [
          toolWork,
          incomplete,
          {
            info: { id: 'msg_recovery_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed' },
            parts: [{ type: 'text', text: 'Completed after empty-output recovery' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
    });

    const result = await executor.observe(
      task({ childSessionId: 'ses_child', status: 'running' }),
      {},
    );

    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after empty-output recovery',
    });
    expect(prompts).toEqual([{
      taskId: 'dvr_task_1',
      leaseToken: 'dvr_lease_1',
      sessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: 'fast',
      prompt: appendManagedAssignment(task(), MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT),
      signal: expect.any(AbortSignal),
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
    }]);
  });

  test('recovers from repeated observation timeouts without recreating or reprompting the child', async () => {
    let statusReads = 0;
    let messageReads = 0;
    let sleeps = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        statusReads += 1;
        if (statusReads <= 2) {
          const error = new Error('The operation timed out');
          error.name = 'TimeoutError';
          throw error;
        }
        return { type: 'idle' };
      },
      async readMessages() { messageReads += 1; return [assistant()]; },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => { sleeps += 1; },
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result.status).toBe('completed');
    expect(statusReads).toBe(3);
    expect(messageReads).toBe(1);
    expect(sleeps).toBe(2);
  });

  test('recovers from transient HTTP and network observation failures', async () => {
    let statusReads = 0;
    let sleeps = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        statusReads += 1;
        if (statusReads === 1) {
          const error = new Error('service unavailable');
          error.status = 503;
          throw error;
        }
        if (statusReads === 2) {
          const error = new TypeError('fetch failed');
          error.cause = { code: 'ECONNRESET' };
          throw error;
        }
        return { type: 'idle' };
      },
      async readMessages() { return [assistant()]; },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => { sleeps += 1; },
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result.status).toBe('completed');
    expect(statusReads).toBe(3);
    expect(sleeps).toBe(2);
  });

  test('returns a resumable interruption with the last successful partial observation', async () => {
    let statusReads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() {
        statusReads += 1;
        if (statusReads === 1) return { type: 'busy' };
        throw new RangeError('invalid observation payload');
      },
      async readMessages() {
        return [assistant({
          info: { finish: 'tool-calls' },
          parts: [
            { type: 'text', text: 'Retained partial analysis' },
            { type: 'tool', callID: 'call_partial', state: { status: 'completed' } },
          ],
        })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(result).toEqual({
      status: 'interrupted',
      failureReason: 'invalid observation payload',
      partial: true,
      recoverablePreview: 'Retained partial analysis',
      canonicalRefs: [
        { type: 'message', id: 'msg_assistant' },
        { type: 'tool', id: 'call_partial', messageId: 'msg_assistant' },
      ],
      resumable: true,
    });
  });

  test('waits through intermediate tool calls until a final assistant response', async () => {
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        const toolTurn = assistant({
          info: { finish: 'tool-calls', time: { completed: 2_000 } },
          parts: [{
            type: 'tool',
            callID: 'call_1',
            state: { status: reads === 1 ? 'running' : 'completed' },
          }],
        });
        if (reads < 3) return [toolTurn];
        return [toolTurn, assistant({
          info: { id: 'msg_final', finish: 'stop', time: { completed: 3_000 } },
          parts: [{ type: 'text', text: 'Finished after the tool call' }],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(reads).toBe(3);
    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Finished after the tool call',
    });
  });

  test('waits for live session status to settle after the final response arrives', async () => {
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: reads === 0 ? 'busy' : 'idle' }; },
      async readMessages() { reads += 1; return [assistant()]; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(reads).toBe(2);
    expect(result.status).toBe('completed');
  });

  test('does not fail a busy child from a trailing empty completed shell', async () => {
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: reads === 0 ? 'busy' : 'idle' }; },
      async readMessages() {
        reads += 1;
        if (reads === 1) {
          return [assistant({
            info: { id: 'msg_shell', finish: undefined, time: { completed: 2_000 } },
            parts: [],
          })];
        }
        return [assistant({
          info: { id: 'msg_final', finish: 'stop', time: { completed: 3_000 } },
          parts: [{ type: 'text', text: 'Finished after the empty shell' }],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(reads).toBe(2);
    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Finished after the empty shell',
    });
  });

  test('does not let a trailing empty shell conceal an earlier in-flight tool', async () => {
    let reads = 0;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        if (reads === 1) {
          return [
            assistant({
              info: { id: 'msg_tool', finish: 'tool-calls', time: { completed: 2_000 } },
              parts: [{ type: 'tool', callID: 'call_1', state: { status: 'running' } }],
            }),
            assistant({ info: { id: 'msg_shell', finish: undefined, time: {} }, parts: [] }),
          ];
        }
        return [assistant({
          info: { id: 'msg_final', finish: 'stop', time: { completed: 3_000 } },
          parts: [{ type: 'text', text: 'Finished after the live tool' }],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});

    expect(reads).toBe(2);
    expect(result.status).toBe('completed');
  });

  test('reconciles an idle intermediate tool-call child as live', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: { finish: 'tool-calls', time: { completed: 2_000 } },
          parts: [{ type: 'tool', callID: 'call_1', state: { status: 'completed' } }],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toEqual({ state: 'live' });
  });

  test('persists child identity before one prompt and marks provider acceptance before observation', async () => {
    const calls = [];
    const statuses = [{ type: 'busy' }, { type: 'idle' }];
    const transport = {
      async createSession(input) {
        calls.push(['create', input]);
        return { id: 'ses_child' };
      },
      async promptSession(input) {
        calls.push(['prompt', input]);
      },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        return statuses.length === 0 ? [assistant()] : [];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const control = {
      async setChildSessionId(id) { calls.push(['child', id]); },
      async markAccepted() { calls.push(['accepted']); },
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
    });

    const result = await executor.start(task({ label: 'locate-chat_ui' }), control);

    expect(calls.map(([name]) => name)).toEqual(['create', 'child', 'prompt', 'accepted']);
    expect(calls[0][1]).toEqual({
      taskId: 'dvr_task_1',
      leaseToken: 'dvr_lease_1',
      directory: '/workspace',
      parentSessionId: 'ses_root',
      title: 'Locate Chat UI',
    });
    expect(calls[2][1]).toMatchObject({
      taskId: 'dvr_task_1',
      leaseToken: 'dvr_lease_1',
      sessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: 'fast',
      prompt: 'Inspect the authentication flow.',
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
    });
    expect(result).toEqual({
      status: 'completed',
      failureReason: null,
      partial: false,
      recoverablePreview: 'Finished analysis',
      canonicalRefs: [{ type: 'message', id: 'msg_assistant' }],
      resumable: false,
    });
  });

  test('discards a fresh child when prompt acceptance loses task ownership', async () => {
    const calls = [];
    const transport = {
      async createSession() {
        calls.push('create');
        return { id: 'ses_stale_after_prompt' };
      },
      async promptSession() { calls.push('prompt'); },
      async readSession() { throw new Error('must not read session'); },
      async readStatus() { throw new Error('must not observe status'); },
      async readMessages() { throw new Error('must not observe messages'); },
      async abortSession() { calls.push('abort'); return true; },
      async deleteSession() { calls.push('delete'); return true; },
    };
    const executor = createManagedOpenCodeExecutor({ transport });

    await expect(executor.start(task(), {
      async setChildSessionId() { return true; },
      async markAccepted() { return false; },
    })).rejects.toThrow('lost launch ownership after provider prompt');

    expect(calls).toEqual(['create', 'prompt', 'abort', 'delete']);
  });

  test('accepts confirmed child deletion when stale-child abort cleanup fails', async () => {
    const calls = [];
    const transport = {
      async createSession() { calls.push('create'); return { id: 'ses_cleanup_failure' }; },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { throw new Error('must not read session'); },
      async readStatus() { throw new Error('must not observe status'); },
      async readMessages() { throw new Error('must not observe messages'); },
      async abortSession() { calls.push('abort'); throw new Error('abort cleanup failed'); },
      async deleteSession() { calls.push('delete'); return true; },
    };
    const executor = createManagedOpenCodeExecutor({ transport });

    await expect(executor.start(task(), {
      async setChildSessionId() { return false; },
      async markAccepted() { throw new Error('must not accept'); },
    })).rejects.toThrow('lost launch ownership before provider prompt');

    expect(calls).toEqual(['create', 'abort', 'delete']);
  });

  test('reports stale-child cleanup failure when deletion is not confirmed', async () => {
    const calls = [];
    const transport = {
      async createSession() { calls.push('create'); return { id: 'ses_delete_failure' }; },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { throw new Error('must not read session'); },
      async readStatus() { throw new Error('must not observe status'); },
      async readMessages() { throw new Error('must not observe messages'); },
      async abortSession() { calls.push('abort'); return true; },
      async deleteSession() { calls.push('delete'); return false; },
    };
    const executor = createManagedOpenCodeExecutor({ transport });

    await expect(executor.start(task(), {
      async setChildSessionId() { return false; },
      async markAccepted() { throw new Error('must not accept'); },
    })).rejects.toThrow('stale child cleanup also failed');

    expect(calls).toEqual(['create', 'abort', 'delete']);
  });

  test('aborts but preserves a canonical child when retry-in-place ownership is lost', async () => {
    const calls = [];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { calls.push('prompt'); },
      async readSession() { throw new Error('must not read session'); },
      async readStatus() { calls.push('status'); return { type: 'idle' }; },
      async readMessages() {
        return [assistant({ info: { id: 'msg_existing_tail' } })];
      },
      async abortSession() { calls.push('abort'); return true; },
      async deleteSession() { calls.push('delete'); return true; },
    };
    const executor = createManagedOpenCodeExecutor({ transport });

    await expect(executor.retryInPlace(task({
      childSessionId: 'ses_canonical',
      executionKind: 'retry_in_place',
    }), {
      async setChildSessionId() { throw new Error('must not set child'); },
      async markAccepted() { return false; },
    })).rejects.toThrow('lost launch ownership after retry-in-place prompt');

    // Two status reads: the retry stop check, then the required stale-tail anchor.
    expect(calls).toEqual(['status', 'status', 'prompt', 'abort']);
  });

  test('retains text and tool references when a provider fails after useful work', async () => {
    const transport = {
      async createSession() { return { id: 'ses_partial' }; },
      async promptSession() {},
      async readSession() { return { id: 'ses_partial' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: {
            finish: 'error',
            error: { data: { message: 'provider disconnected' } },
          },
          parts: [
            { type: 'text', text: 'Useful partial analysis' },
            { type: 'tool', callID: 'call_1', state: { status: 'completed' } },
          ],
        })];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_partial' }), {});

    expect(result).toEqual({
      status: 'failed',
      failureReason: 'provider disconnected',
      partial: true,
      recoverablePreview: 'Useful partial analysis',
      canonicalRefs: [
        { type: 'message', id: 'msg_assistant' },
        { type: 'tool', id: 'call_1', messageId: 'msg_assistant' },
      ],
      resumable: true,
    });
  });

  test('retains the latest useful assistant work when a later empty message records failure', async () => {
    const transport = {
      async createSession() { return { id: 'ses_partial' }; },
      async promptSession() {},
      async readSession() { return { id: 'ses_partial' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [
          assistant({
            info: { id: 'msg_work', finish: 'tool-calls' },
            parts: [
              { type: 'text', text: 'Useful work before the provider failed' },
              { type: 'tool', callID: 'call_work', state: { status: 'completed' } },
            ],
          }),
          assistant({
            info: {
              id: 'msg_failure',
              finish: 'error',
              error: { data: { message: 'provider disconnected' } },
            },
            parts: [],
          }),
        ];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_partial' }), {});

    expect(result).toEqual({
      status: 'failed',
      failureReason: 'provider disconnected',
      partial: true,
      recoverablePreview: 'Useful work before the provider failed',
      canonicalRefs: [
        { type: 'message', id: 'msg_work' },
        { type: 'tool', id: 'call_work', messageId: 'msg_work' },
        { type: 'message', id: 'msg_failure' },
      ],
      resumable: true,
    });
  });

  test('reports a child that stopped between steps instead of waiting for its deadline', async () => {
    let time = 10_000;
    const stopped = (error) => [assistant({
      info: { id: 'msg_work', finish: 'tool-calls', time: { completed: 2_000 } },
      parts: [{ type: 'text', text: 'Useful work before the stop' },
        { id: 'prt_done', type: 'tool', callID: 'call_done', tool: 'bash', state: { status: 'completed', input: {}, output: 'ok', time: { start: 1, end: 2 } } }],
    }), assistant({
      info: { id: 'msg_stopped', finish: 'tool-calls', time: { completed: 3_000 } },
      parts: [{ id: 'prt_read', type: 'tool', callID: 'call_read', tool: 'read',
        state: { status: 'error', input: { filePath: '/Applications' }, error, time: { start: 2_500, end: 2_900 } } }],
    })];
    const run = async (records, options = {}, status = { type: 'idle' }) => {
      const prompts = [];
      const executor = createManagedOpenCodeExecutor({ now: () => time, sleep: async () => { time += 750; },
        transport: { async createSession() { return { id: 'ses_stopped' }; }, async promptSession(input) { prompts.push(input); },
          async readSession() { return { id: 'ses_stopped' }; }, async readStatus() { return typeof status === 'function' ? status() : status; },
          async readMessages() { return typeof records === 'function' ? records() : records; },
          async abortSession() { return true; }, deleteSession }, ...options });
      const started = time;
      const result = await executor.observe(task({ childSessionId: 'ses_stopped', timeoutAt: time + 3_600_000 }), {});
      return { result, prompts, elapsed: time - started };
    };

    const rejected = await run(stopped('The user rejected permission to use this specific tool call.'));
    expect(rejected.result).toMatchObject({ status: 'failed', partial: true, resumable: true,
      failureReason: 'Managed child stopped before finishing: a tool permission or question was rejected' });
    expect(rejected.result.recoverablePreview).toContain('rejected permission');
    // Reported after the stop was seen for 30 seconds, not at the deadline.
    expect(rejected.elapsed).toBeGreaterThanOrEqual(30_000);
    expect(rejected.elapsed).toBeLessThan(35_000);
    expect(rejected.prompts).toHaveLength(0);

    const other = await run(stopped('File not found'));
    expect(other.result).toMatchObject({ status: 'failed', failureReason: 'Managed child stopped before finishing its turn' });

    // A child whose next step arrives within the window keeps running.
    let polls = 0;
    const resumed = await run(() => (polls += 1) < 20 ? stopped('File not found') : [...stopped('File not found'), assistant({
      info: { id: 'msg_final', finish: 'stop', time: { completed: 4_000 } },
      parts: [{ type: 'text', text: 'Finished.\n\n**Status:** complete' }],
    })]);
    expect(resumed.result).toMatchObject({ status: 'completed' });
  });

  test('a busy child between steps and the kill switch keep waiting', async () => {
    let time = 10_000, polls = 0;
    const records = () => [assistant({ info: { id: 'msg_step', finish: 'tool-calls', time: { completed: 2_000 } },
      parts: [{ id: 'prt_tool', type: 'tool', callID: 'call_tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'ok', time: { start: 1, end: 2 } } }] }),
    ...(polls > 80 ? [assistant({ info: { id: 'msg_final', finish: 'stop', time: { completed: 4_000 } }, parts: [{ type: 'text', text: 'Done.\n\n**Status:** complete' }] })] : [])];
    const create = (status) => createManagedOpenCodeExecutor({ now: () => time, sleep: async () => { time += 750; polls += 1; },
      transport: { async createSession() { return { id: 'ses_busy' }; }, async promptSession() {}, async readSession() { return { id: 'ses_busy' }; },
        async readStatus() { return status(); }, async readMessages() { return records(); }, async abortSession() { return true; }, deleteSession } });

    // The model is producing its next step: the status stays busy for a minute.
    const busy = await create(() => ({ type: polls > 80 ? 'idle' : 'busy' })).observe(task({ childSessionId: 'ses_busy', timeoutAt: time + 3_600_000 }), {});
    expect(busy).toMatchObject({ status: 'completed' });

    polls = 0; process.env.DEVRYAN_MANAGED_STOPPED_HANDOFF = '0';
    try {
      const disabled = await create(() => ({ type: 'idle' })).observe(task({ childSessionId: 'ses_busy', timeoutAt: time + 3_600_000 }), {});
      expect(disabled).toMatchObject({ status: 'completed' });
      expect(polls).toBeGreaterThan(80);
    } finally { delete process.env.DEVRYAN_MANAGED_STOPPED_HANDOFF; }
  });

  test('fails honestly when the same child ends empty again after automatic continuation', async () => {
    const prompts = [];
    const transport = {
      async createSession() { return { id: 'ses_empty' }; },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_empty' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        const records = [assistant({
          info: { id: 'msg_empty_1', finish: undefined, time: { completed: 2_000 } },
          parts: [],
        })];
        if (prompts.length === 0) return records;
        return [
          ...records,
          {
            info: { id: 'msg_recovery_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_empty_2', finish: 'unknown', time: { completed: 3_000 } },
            parts: [{ type: 'reasoning', text: 'Still no final answer' }],
          }),
        ];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    const result = await executor.observe(task({ childSessionId: 'ses_empty' }), {});

    expect(result).toEqual({
      status: 'failed',
      failureReason: 'Managed child session completed without useful assistant output',
      partial: false,
      recoverablePreview: '',
      canonicalRefs: [{ type: 'message', id: 'msg_empty_2' }],
      resumable: true,
    });
    expect(prompts).toHaveLength(1);
  });

  test('reconciles live, terminal, and missing children without replaying prompts', async () => {
    let state = 'live';
    const promptSession = () => {
      throw new Error('must not replay');
    };
    const transport = {
      async createSession() { throw new Error('must not create'); },
      promptSession,
      async readSession() { return state === 'missing' ? null : { id: 'ses_child' }; },
      async readStatus() { return state === 'live' ? { type: 'busy' } : { type: 'idle' }; },
      async readMessages() { return state === 'terminal' ? [assistant()] : []; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });
    const existing = task({ childSessionId: 'ses_child', status: 'running' });

    expect(await executor.reconcile(existing)).toEqual({ state: 'live' });
    state = 'terminal';
    expect(await executor.reconcile(existing)).toMatchObject({
      state: 'terminal',
      result: { status: 'completed', recoverablePreview: 'Finished analysis' },
    });
    state = 'missing';
    expect(await executor.reconcile(existing)).toMatchObject({
      state: 'unavailable',
      failureReason: 'Managed child session ses_child is unavailable',
    });
  });

  test('reconciles a persisted Zen free-tier retry as terminal recovery work', async () => {
    let aborts = 0;
    const statuses = [
      {
        type: 'retry',
        message: 'Free usage exceeded, subscribe to Go',
        action: { reason: 'free_tier_limit' },
      },
      { type: 'idle' },
    ];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() { return [assistant()]; },
      async abortSession() { aborts += 1; return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toMatchObject({
      state: 'terminal',
      result: {
        status: 'failed',
        failureReason: 'Free usage exceeded, subscribe to Go',
        resumable: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborts).toBe(1);
  });

  test('defers reconciliation when the child runtime is temporarily unavailable', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() {
        const error = new Error('OpenCode port is not available');
        error.code = 'managed_runtime_unavailable';
        error.statusCode = 503;
        throw error;
      },
      async readStatus() { throw new Error('must not read status'); },
      async readMessages() { throw new Error('must not read messages'); },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toEqual({
      state: 'transient',
      failureReason: 'OpenCode port is not available',
    });
  });

  test('keeps a first terminal assistant timeout live for restart-safe same-child recovery', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt during reconciliation'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: {
            id: 'msg_timeout',
            finish: 'error',
            error: { message: 'The operation timed out.' },
          },
          parts: [],
        })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toEqual({ state: 'live' });
  });

  test('keeps a first terminal connection failure live for restart-safe same-child recovery', async () => {
    const connectionFailure = '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}';
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt during reconciliation'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: {
            id: 'msg_connection_failure',
            finish: 'error',
            error: { name: 'UnknownError', data: { message: connectionFailure } },
          },
          parts: [{ type: 'text', text: 'Useful partial analysis' }],
        })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toEqual({ state: 'live' });
  });

  test('does not duplicate a legacy timeout continuation already recorded before restart', async () => {
    const timeoutMessage = assistant({
      info: {
        id: 'msg_timeout',
        finish: 'error',
        error: { message: 'The operation timed out.' },
      },
      parts: [{ type: 'text', text: 'Partial work before timeout' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt again'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [
          timeoutMessage,
          {
            info: { id: 'msg_legacy_recovery_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT }],
          },
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.observe(task({
      childSessionId: 'ses_child',
      status: 'running',
    }), {})).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'The operation timed out.',
      partial: true,
      recoverablePreview: 'Partial work before timeout',
      resumable: true,
    });
  });

  test('keeps a first empty terminal assistant live for restart-safe same-child recovery', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt during reconciliation'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: {
            id: 'msg_empty',
            finish: 'unknown',
          },
          parts: [{ type: 'reasoning', text: 'Now I have all' }],
        })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toEqual({ state: 'live' });
  });

  test('does not duplicate an empty-output continuation already recorded before restart', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt again'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [
          assistant({
            info: {
              id: 'msg_empty',
              finish: 'unknown',
            },
            parts: [{ type: 'reasoning', text: 'Now I have all' }],
          }),
          {
            info: { id: 'msg_recovery_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT }],
          },
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_child',
      status: 'running',
    }))).resolves.toMatchObject({
      state: 'terminal',
      result: {
        status: 'failed',
        failureReason: 'Managed child session completed without useful assistant output',
        resumable: true,
      },
    });
  });

  test('resumes observation without prompting and aborts only the canonical child', async () => {
    const calls = [];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_existing' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return [assistant()]; },
      async abortSession(input) { calls.push(input); return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });
    const existing = task({
      childSessionId: 'ses_existing',
      executionKind: 'resume',
      status: 'starting',
    });

    expect((await executor.resume(existing, {
      async markAccepted() { return true; },
    })).status).toBe('completed');
    expect(await executor.abort(existing)).toEqual({ aborted: true });
    expect(calls).toEqual([{ sessionId: 'ses_existing', directory: '/workspace', providerId: 'github-copilot' }]);
  });

  test('relaunches a resume after restart when its continuation was never recorded', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('reconciliation must not prompt'); },
      async readSession() { return { id: 'ses_existing' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: {
            id: 'msg_aborted',
            finish: 'error',
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
          },
        })];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_existing',
      executionKind: 'resume',
      status: 'starting',
    }))).resolves.toEqual({ state: 'relaunch' });
  });

  test('observes without duplicating a resume continuation already recorded before restart', async () => {
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('reconciliation must not prompt'); },
      async readSession() { return { id: 'ses_existing' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [
          assistant({
            info: {
              id: 'msg_aborted',
              finish: 'error',
              error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
            },
          }),
          {
            info: { id: 'msg_resume_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
          },
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined });

    await expect(executor.reconcile(task({
      childSessionId: 'ses_existing',
      executionKind: 'resume',
      status: 'starting',
    }))).resolves.toEqual({ state: 'live' });
  });

  test('shutdown interrupts observers without aborting provider work', async () => {
    let resolveSleep;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() {},
      async readSession() { return { id: 'ses_live' }; },
      async readStatus() { return { type: 'busy' }; },
      async readMessages() { return []; },
      async abortSession() { throw new Error('shutdown must not abort child'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: () => new Promise((resolve) => { resolveSleep = resolve; }),
    });
    const observation = executor.observe(task({ childSessionId: 'ses_live', status: 'running' }), {});
    await Promise.resolve();

    await executor.shutdown();
    resolveSleep?.();

    await expect(observation).rejects.toThrow('Managed OpenCode executor shut down');
  });
});

describe('managed task prompt preamble', () => {
  const control = {
    async setChildSessionId() { return true; },
    async markAccepted() { return true; },
  };
  const createStartTransport = (prompts) => ({
    async createSession() { return { id: 'ses_child' }; },
    async promptSession(input) { prompts.push(input); },
    async readSession() { return { id: 'ses_child' }; },
    async readStatus() { return { type: 'idle' }; },
    async readMessages() { return [assistant()]; },
    async abortSession() { return true; },
    deleteSession,
  });

  test('prepends a host preamble ahead of the task prompt only when the hook returns text', async () => {
    const prompts = [];
    const seen = [];
    const executor = createManagedOpenCodeExecutor({
      transport: createStartTransport(prompts),
      sleep: async () => undefined,
      idleStablePolls: 1,
      resolveTaskPromptPreamble: async (candidate) => {
        seen.push(candidate.agent);
        return candidate.agent === 'designer' ? '  Contract for designer.\n' : null;
      },
    });

    expect((await executor.start(task({ agent: 'designer' }), control)).status).toBe('completed');
    expect(prompts[0].prompt).toBe([
      'Contract for designer.',
      'Inspect the authentication flow.',
    ].join('\n\n'));

    expect((await executor.start(task({ taskId: 'dvr_task_2', agent: 'explorer' }), control)).status)
      .toBe('completed');
    expect(prompts[1].prompt).toBe(
      'Inspect the authentication flow.',
    );
    expect(seen).toEqual(['designer', 'explorer']);
  });

  test('keeps the preamble ahead of the read-only policy prefix', async () => {
    const prompts = [];
    const executor = createManagedOpenCodeExecutor({
      transport: createStartTransport(prompts),
      sleep: async () => undefined,
      idleStablePolls: 1,
      resolveTaskPromptPreamble: () => 'Contract.',
    });

    expect((await executor.start(task({ readOnly: true }), control)).status).toBe('completed');
    expect(prompts[0].prompt).toBe([
      'Contract.',
      MANAGED_READ_ONLY_PROMPT,
      'Inspect the authentication flow.',
    ].join('\n\n'));
  });

  test('resolves the preamble before the child exists so a failing hook cannot orphan a session', async () => {
    let created = 0;
    const transport = {
      ...createStartTransport([]),
      async createSession() { created += 1; return { id: 'ses_child' }; },
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      resolveTaskPromptPreamble: () => { throw new Error('settings unreadable'); },
    });

    await expect(executor.start(task(), control)).rejects.toThrow('settings unreadable');
    expect(created).toBe(0);
  });

  test('never carries the preamble on resume or retry-in-place continuations', async () => {
    const prompts = [];
    let hookCalls = 0;
    const statuses = [{ type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const aborted = assistant({
      info: {
        id: 'msg_aborted',
        finish: 'error',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
      parts: [{ type: 'text', text: 'Useful work before the deadline' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [aborted];
        return [
          aborted,
          {
            info: { id: 'msg_continuation', role: 'user' },
            parts: [{ type: 'text', text: prompts.at(-1).prompt }],
          },
          assistant({
            info: { id: `msg_done_${prompts.length}` },
            parts: [{ type: 'text', text: 'Completed' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      resolveTaskPromptPreamble: () => { hookCalls += 1; return 'Contract.'; },
    });
    const acceptOnly = { async markAccepted() { return true; } };

    const resumed = await executor.resume(
      task({ childSessionId: 'ses_child', executionKind: 'resume' }),
      acceptOnly,
    );
    expect(resumed.status).toBe('completed');
    expect(prompts.map((entry) => stripManagedAssignment(entry.prompt))).toEqual([MANAGED_RESUME_CONTINUATION_PROMPT]);

    const retried = await executor.retryInPlace(
      task({ childSessionId: 'ses_child', executionKind: 'retry_in_place', attempt: 2 }),
      acceptOnly,
    );
    expect(retried.status).toBe('completed');
    expect(prompts.map((entry) => stripManagedAssignment(entry.prompt))).toEqual([
      MANAGED_RESUME_CONTINUATION_PROMPT,
      `${MANAGED_RETRY_IN_PLACE_PROMPT}\n\n${MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX}github-copilot/gpt-4.1 · fast to continue the previous task.`,
    ]);
    expect(hookCalls).toBe(0);
  });
});

describe('managed task progress stamps', () => {
  const progressControl = () => {
    const stamps = [];
    return {
      stamps,
      control: {
        async setChildSessionId() { return true; },
        async markAccepted() { return true; },
        async recordProgress(progress) { stamps.push(progress); return true; },
      },
    };
  };

  test('stamps the child prompt and the first assistant output on start', async () => {
    let clock = 5_000;
    let prompted = false;
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession() { prompted = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return prompted ? [assistant()] : []; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      idleStablePolls: 1,
    });
    const { control, stamps } = progressControl();

    const result = await executor.start(task(), control);

    expect(result.status).toBe('completed');
    expect(stamps).toEqual([
      { childPromptedAt: 5_000 },
      { firstAssistantPartAt: expect.any(Number) },
    ]);
  });

  test('tolerates a control without recordProgress', async () => {
    let prompted = false;
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession() { prompted = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { return prompted ? [assistant()] : []; },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, sleep: async () => undefined, idleStablePolls: 1 });

    await expect(executor.start(task(), {
      async setChildSessionId() { return true; },
      async markAccepted() { return true; },
    })).resolves.toMatchObject({ status: 'completed' });
  });

  test('retry in place appends the model continuation notice and stamps only new assistant output', async () => {
    let clock = 0;
    let reads = 0;
    const prompts = [];
    const prior = assistant({
      info: { id: 'msg_prior', finish: 'error', error: { message: 'out of usage' } },
      parts: [{ type: 'text', text: 'partial before the limit' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        reads += 1;
        if (prompts.length === 0 || reads <= 2) return [prior];
        return [
          prior,
          { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: prompts[0].prompt }] },
          assistant({ info: { id: 'msg_new' }, parts: [{ type: 'text', text: 'continued on the new model' }] }),
        ];
      },
      async abortSession() { return true; },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 1; },
      idleStablePolls: 1,
    });
    const { control, stamps } = progressControl();

    const result = await executor.retryInPlace(task({
      childSessionId: 'ses_child',
      executionKind: 'retry_in_place',
      attempt: 2,
      priorTaskId: 'dvr_task_original',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      variant: null,
    }), control);

    expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'continued on the new model' });
    expect(prompts).toHaveLength(1);
    expect(stripManagedAssignment(prompts[0].prompt)).toBe(
      `${MANAGED_RETRY_IN_PLACE_PROMPT}\n\n${MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX}openai/gpt-5.6 after a provider usage limit.`,
    );
    expect(isManagedRetryInPlacePrompt(prompts[0].prompt)).toBe(true);
    // The inherited tail (msg_prior) never counts as this attempt's output.
    expect(stamps).toEqual([
      { childPromptedAt: 0 },
      { firstAssistantPartAt: expect.any(Number) },
    ]);
    expect(reads).toBe(3);
  });

  test('stamps the child prompt when resume posts its continuation', async () => {
    const prompts = [];
    const aborted = assistant({
      info: { id: 'msg_aborted', finish: 'abort' },
      parts: [{ type: 'text', text: 'stopped' }],
    });
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return [aborted];
        return [
          aborted,
          { info: { id: 'msg_continuation', role: 'user' }, parts: [{ type: 'text', text: prompts[0].prompt }] },
          assistant({ info: { id: 'msg_done' }, parts: [{ type: 'text', text: 'Completed' }] }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({ transport, now: () => 7_000, sleep: async () => undefined });
    const { control, stamps } = progressControl();

    const result = await executor.resume(task({ childSessionId: 'ses_child', executionKind: 'resume' }), control);

    expect(result.status).toBe('completed');
    expect(prompts.map((entry) => stripManagedAssignment(entry.prompt))).toEqual([MANAGED_RESUME_CONTINUATION_PROMPT]);
    expect(stamps[0]).toEqual({ childPromptedAt: 7_000 });
    expect(stamps.filter((stamp) => 'firstAssistantPartAt' in stamp)).toHaveLength(1);
  });
});

describe('managed task turn budget', () => {
  const control = {
    async setChildSessionId() { return true; },
    async markAccepted() { return true; },
  };
  const turns = (count) => Array.from({ length: count }, (_, index) => assistant({
    info: { id: `msg_${index + 1}`, finish: 'tool-calls', time: { completed: 1_500 + index } },
    parts: [{ type: 'text', text: `Step ${index + 1}` }],
  }));
  // A busy child whose transcript grows by one assistant turn per read. It only
  // goes idle when aborted or, when `finishAfterReads` is set, on that read.
  const createBusyChild = ({ finishAfterReads = Infinity } = {}) => {
    const state = { prompts: [], reads: 0, abortCount: 0, idle: false };
    const transport = {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession(input) { state.prompts.push({ ...input, atRead: state.reads }); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: state.idle ? 'idle' : 'busy' }; },
      async readMessages() {
        state.reads += 1;
        if (state.reads >= finishAfterReads) {
          state.idle = true;
          return [
            ...turns(finishAfterReads - 1),
            assistant({ info: { id: 'msg_final' }, parts: [{ type: 'text', text: 'Wrapped up' }] }),
          ];
        }
        return turns(state.reads);
      },
      async abortSession() { state.abortCount += 1; state.idle = true; return true; },
      deleteSession,
    };
    return { state, transport };
  };
  const createExecutor = (transport, options = {}) => {
    let clock = 0;
    return createManagedOpenCodeExecutor({
      transport,
      now: () => clock,
      sleep: async () => { clock += 100; },
      pollIntervalMs: 0,
      liveTranscriptRefreshMs: 0,
      idleStablePolls: 1,
      ...options,
    });
  };

  test('prompts the child to finish exactly once when its budget is used, then keeps observing', async () => {
    const { state, transport } = createBusyChild({ finishAfterReads: 6 });
    const executor = createExecutor(transport, {
      resolveTaskTurnBudget: (candidate) => (candidate.agent === 'designer' ? 3 : null),
    });

    const result = await executor.start(task({ agent: 'designer' }), control);

    expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'Wrapped up' });
    expect(state.abortCount).toBe(0);
    expect(state.prompts).toHaveLength(2);
    const budgetPrompts = state.prompts.filter((entry) => stripManagedAssignment(entry.prompt) === MANAGED_TURN_BUDGET_PROMPT);
    expect(budgetPrompts).toHaveLength(1);
    // Sent on the read that reached the budget (3 assistant turns), and never again
    // even though the child produced further turns before wrapping up.
    expect(budgetPrompts[0]).toMatchObject({
      sessionId: 'ses_child',
      agent: 'designer',
      atRead: 3,
      tools: { task: false },
    });
    expect(state.reads).toBeGreaterThan(5);
  });

  test('aborts a child that runs 20 turns past its budget and fails resumably with partial work', async () => {
    const { state, transport } = createBusyChild();
    const executor = createExecutor(transport, { maxAssistantTurns: 2 });

    const result = await executor.start(task(), control);

    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'turn budget (2) exceeded; partial results reported',
      partial: true,
      resumable: true,
    });
    expect(result.recoverablePreview).toContain('Step 22');
    expect(state.abortCount).toBe(1);
    expect(state.reads).toBe(2 + MANAGED_TURN_BUDGET_ABORT_GRACE_TURNS);
    const budgetPrompts = state.prompts.filter((entry) => stripManagedAssignment(entry.prompt) === MANAGED_TURN_BUDGET_PROMPT);
    expect(budgetPrompts).toHaveLength(1);
    expect(budgetPrompts[0].atRead).toBe(2);
  });

  test('applies no budget when none is configured or the resolver answers null', async () => {
    for (const options of [{}, { maxAssistantTurns: 2, resolveTaskTurnBudget: () => null }]) {
      const { state, transport } = createBusyChild({ finishAfterReads: 30 });
      const executor = createExecutor(transport, options);

      const result = await executor.start(task({ agent: 'designer' }), control);

      expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'Wrapped up' });
      expect(state.prompts).toHaveLength(1);
      expect(state.abortCount).toBe(0);
    }
  });

  test('gives a resumed attempt a fresh budget instead of counting the inherited tail', async () => {
    const prompts = [];
    const statuses = [{ type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const tail = [
      ...turns(4).map((record) => ({ ...record, info: { ...record.info, finish: 'stop' } })),
      assistant({
        info: {
          id: 'msg_aborted',
          finish: 'error',
          error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
        },
        parts: [{ type: 'text', text: 'Useful work before the deadline' }],
      }),
    ];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { prompts.push(input); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() {
        if (prompts.length === 0) return tail;
        return [
          ...tail,
          {
            info: { id: 'msg_resume_prompt', role: 'user' },
            parts: [{ type: 'text', text: MANAGED_RESUME_CONTINUATION_PROMPT }],
          },
          assistant({
            info: { id: 'msg_completed' },
            parts: [{ type: 'text', text: 'Completed after managed resume' }],
          }),
        ];
      },
      async abortSession() { throw new Error('must not abort'); },
      deleteSession,
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      maxAssistantTurns: 3,
    });

    const result = await executor.resume(
      task({ childSessionId: 'ses_child', executionKind: 'resume' }),
      { async markAccepted() { return true; } },
    );

    // Five inherited turns exceed the budget of three, but they belong to the
    // previous attempt: only the one new turn counts, so no wrap-up prompt goes out.
    expect(result).toMatchObject({
      status: 'completed',
      recoverablePreview: 'Completed after managed resume',
    });
    expect(prompts.map((entry) => stripManagedAssignment(entry.prompt))).toEqual([MANAGED_RESUME_CONTINUATION_PROMPT]);
  });

  test('rejects an invalid executor-wide budget up front', () => {
    const { transport } = createBusyChild();
    expect(() => createManagedOpenCodeExecutor({ transport, maxAssistantTurns: 0 })).toThrow(RangeError);
    expect(() => createManagedOpenCodeExecutor({ transport, maxAssistantTurns: 1.5 })).toThrow(RangeError);
    expect(() => createManagedOpenCodeExecutor({ transport, maxAssistantTurns: null })).not.toThrow();
  });
});

describe('attempt-scoped prompt cancellation gates', () => {
  for (const channel of ['operator', 'task']) {
    for (const path of ['initial', 'resume', 'retry', 'recovery', 'empty', 'budget', 'stale']) {
      test(`${channel} Stop during ${path} preparation prevents its pending prompt`, async () => {
        let clock = 3_000, stopped = false, idle = path !== 'budget', reads = 0;
        const prompts = [];
        const current = task({ childSessionId: path === 'initial' || path === 'budget' ? null : 'ses_child' });
        let executor;
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          if (channel === 'task') await executor.abort({ ...current, childSessionId: 'ses_child' });
        };
        const user = { info: { id: 'msg_user', role: 'user', time: { created: 2_000 } }, parts: [{ type: 'text', text: 'Original task' }] };
        const tail = assistant({ info: { id: 'msg_tail', parentID: 'msg_user', finish: path === 'empty' || path === 'budget' ? undefined : path === 'recovery' ? 'error' : 'abort',
          ...(path === 'budget' ? { time: {} } : {}),
          ...(path === 'recovery' ? { error: { message: 'The operation timed out.' } } : {}) },
          parts: path === 'empty' ? [] : [{ type: 'text', text: 'Partial work' }] });
        executor = createManagedOpenCodeExecutor({
          now: () => clock, pollIntervalMs: 0, continuationStartGraceMs: 0, resumeTeardownSettleMs: 0,
          maxAssistantTurns: path === 'budget' ? 1 : null,
          sleep: async () => { clock += 100; if (reads > 30) throw new Error('Cancellation fixture did not settle'); },
          transport: {
            async createSession() { return { id: 'ses_child' }; },
            async promptSession(input) { prompts.push(input); },
            async readSession() { return { id: 'ses_child' }; },
            async readStatus() { return { type: idle ? 'idle' : 'busy' }; },
            async readMessages() {
              reads += 1;
              if (['resume', 'retry', 'empty', 'budget'].includes(path) || (path === 'stale' && prompts.length === 1)) await stop();
              return [user, tail];
            },
            async readOperatorAbort({ after }) { return channel === 'operator' && stopped && 3_000 >= after ? { sessionId: 'ses_child', requestedAt: 3_000 } : null; },
            async abortSession() { idle = true; return true; },
            deleteSession,
          },
        });
        const control = {
          ...recoveryControl(),
          async setChildSessionId() { if (path === 'initial') await stop(); return true; },
          async recordTransportRecovery() { if (path === 'recovery') await stop(); return true; },
        };
        try {
          const method = path === 'initial' || path === 'budget' ? 'start' : path === 'resume' || path === 'stale' ? 'resume' : path === 'retry' ? 'retryInPlace' : 'observe';
          const result = await executor[method](current, control);
          expect(stopped).toBe(true);
          // A fenced durable recovery keeps its interrupted receipt contract;
          // the scheduler separately commits an explicit task cancellation.
          expect(result.status).toBe(channel === 'task' && path === 'recovery' ? 'interrupted' : 'aborted');
          expect(prompts).toHaveLength(path === 'budget' || path === 'stale' ? 1 : 0);
          for (const prompt of prompts) expect(prompt.signal).toBeInstanceOf(AbortSignal);
        } finally { await executor.shutdown(); }
      });
    }
  }

  for (const path of ['empty', 'recovery', 'stale']) {
    test(`Stop followed by steering discards pending ${path} continuation and observes the new assistant`, async () => {
      let clock = 3_000, reads = 0, stopped = false, steeredReads = 0;
      const prompts = [];
      const user = { info: { id: 'msg_user', role: 'user', time: { created: 2_000 } }, parts: [{ type: 'text', text: 'Original' }] };
      const steering = { info: { id: 'msg_steer', role: 'user', time: { created: 3_100 } }, parts: [{ type: 'text', text: 'New user steering' }] };
      const laterSteering = { info: { id: 'msg_steer_later', role: 'user', time: { created: 3_200 } }, parts: [{ type: 'text', text: 'Additional user steering' }] };
      const tail = assistant({ info: { id: 'msg_tail', parentID: 'msg_user', finish: path === 'empty' ? undefined : path === 'stale' ? 'abort' : 'error',
        ...(path === 'recovery' ? { error: { message: 'The operation timed out.' } } : {}) }, parts: [] });
      const done = assistant({ info: { id: 'msg_steered', parentID: 'msg_steer_later' }, parts: [{ type: 'text', text: 'Steered output' }] });
      const executor = createManagedOpenCodeExecutor({ now: () => clock, pollIntervalMs: 0,
        liveTranscriptRefreshMs: 0, continuationStartGraceMs: 0,
        sleep: async () => { clock += 100; if (reads > 30) throw new Error('Steering did not settle'); },
        transport: {
          async createSession() { throw new Error('unexpected create'); },
          async promptSession(input) { prompts.push(input); },
          async readSession() { return { id: 'ses_child' }; },
          async readStatus() { return { type: stopped && steeredReads < 5 ? 'busy' : 'idle' }; },
          async readMessages() {
            reads += 1;
            if (path === 'empty' || (path === 'stale' && prompts.length === 1)) stopped = true;
            if (!stopped) return [user, tail];
            steeredReads += 1;
            return [user, tail, steering, ...(steeredReads >= 4 ? [laterSteering] : []), ...(steeredReads >= 5 ? [done] : [])];
          },
          async readOperatorAbort() { return stopped ? { sessionId: 'ses_child', requestedAt: 3_000 } : null; },
          async abortSession() { return true; }, deleteSession,
        },
      });
      const control = { ...recoveryControl(), async recordTransportRecovery() { if (path === 'recovery') stopped = true; return true; } };
      try {
        const result = await executor[path === 'stale' ? 'resume' : 'observe'](task({ childSessionId: 'ses_child' }), control);
        expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'Steered output' });
        expect(prompts).toHaveLength(path === 'stale' ? 1 : 0);
        expect(steeredReads).toBeGreaterThanOrEqual(5);
      } finally { await executor.shutdown(); }
    });
  }

  test('a rejected Stop withdrawn during the gate observation does not suppress submission', async () => {
    let request = { sessionId: 'ses_child', requestedAt: 3_000 }, prompts = 0;
    const executor = createManagedOpenCodeExecutor({ sleep: async () => {}, transport: {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession() { prompts += 1; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { request = null; return [assistant()]; },
      async readOperatorAbort() { return request; },
      async abortSession() { return true; }, deleteSession,
    } });
    try {
      await expect(executor.start(task(), { async setChildSessionId() { return true; }, async markAccepted() { return true; } })).resolves.toMatchObject({ status: 'completed' });
      expect(prompts).toBe(1);
    } finally { await executor.shutdown(); }
  });
});

const cancellationDeferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test.each(['status', 'transcript'])('cancelling one task detaches its stalled %s read without releasing the other task', async (boundary) => {
  const gate = cancellationDeferred(), started = cancellationDeferred();
  let creates = 0, prompts = 0, readers = 0;
  const executor = createManagedOpenCodeExecutor({ pollIntervalMs: 0, idleStablePolls: 1,
    transport: {
      async createSession() { return { id: `ses_${++creates}` }; },
      async promptSession() { prompts++; }, async readSession() { return {}; },
      async readStatus() {
        if (boundary === 'status') { if (++readers === 2) started.resolve(); await gate.promise; }
        return { type: 'idle' };
      },
      async readMessages() {
        if (boundary === 'transcript') { if (++readers === 2) started.resolve(); await gate.promise; }
        return [assistant()];
      },
      async abortSession() { return true; }, deleteSession,
    },
  });
  const control = { async setChildSessionId() { return true; }, async markAccepted() { return true; } };
  const firstTask = task({ taskId: 'dvr_task_first' }), secondTask = task({ taskId: 'dvr_task_second' });
  const first = executor.start(firstTask, control), second = executor.start(secondTask, control);
  try {
    await started.promise;
    await executor.abort({ ...firstTask, childSessionId: 'ses_1' });
    // No release of the shared stalled IO: confirmed Stop lets only this waiter finish.
    await expect(first).resolves.toMatchObject({ status: 'aborted' });
    expect(prompts).toBe(2);
    gate.resolve();
    await expect(second).resolves.toMatchObject({ status: 'completed' });
    expect(prompts).toBe(2);
  } finally { gate.resolve(); await executor.shutdown(); }
});

test('a cancelled POST keeps unconfirmed remote work observed, without transcript polling or further prompts', async () => {
  const submitted = cancellationDeferred(), polling = cancellationDeferred(), releasePoll = cancellationDeferred();
  let aborts = 0, messages = 0, prompts = 0, settled = false;
  const current = task({ childSessionId: 'ses_child' });
  const executor = createManagedOpenCodeExecutor({
    sleep: async () => { polling.resolve(); await releasePoll.promise; }, transport: {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession({ signal }) {
        prompts += 1; submitted.resolve(signal);
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'busy' }; },
      async readMessages() { messages += 1; throw new Error('busy cancellation must not fetch transcript'); },
      async abortSession() { aborts += 1; return aborts > 1; }, deleteSession,
    },
  });
  const running = executor.start(current, { async setChildSessionId() { return true; }, async markAccepted() { return true; } });
  void running.then(() => { settled = true; });
  try {
    const signal = await submitted.promise;
    await expect(executor.abort(current)).resolves.toEqual({ aborted: false, failureReason: 'Provider did not confirm the managed child abort' });
    expect(signal.aborted).toBe(true);
    await polling.promise;
    expect(settled).toBe(false);
    expect(messages).toBe(0);
    await expect(executor.abort(current)).resolves.toEqual({ aborted: true });
    releasePoll.resolve();
    await expect(running).resolves.toMatchObject({ status: 'aborted' });
    expect(prompts).toBe(1);
  } finally { releasePoll.resolve(); await executor.shutdown(); }
});

test('last-good recovery is bounded, defensively copied, lease scoped and released with execution', async () => {
  const sleeping = cancellationDeferred(), releaseSleep = cancellationDeferred();
  const current = task({ childSessionId: 'ses_child' });
  const executor = createManagedOpenCodeExecutor({
    sleep: async () => { sleeping.resolve(); await releaseSleep.promise; }, transport: {
      async createSession() { throw new Error('unexpected create'); }, async promptSession() { throw new Error('unexpected prompt'); },
      async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: 'busy' }; },
      async readMessages() { return [assistant({ parts: [{ type: 'text', text: 'x'.repeat(100_000) }] })]; },
      async abortSession() { return true; }, deleteSession,
    },
  });
  const running = executor.observe(current, {});
  try {
    await sleeping.promise;
    const snapshot = executor.getLastRecoverableResult(current);
    expect(snapshot.recoverablePreview.length).toBeLessThanOrEqual(65_536);
    expect(snapshot.partial).toBe(true);
    snapshot.canonicalRefs[0].id = 'changed';
    expect(executor.getLastRecoverableResult(current).canonicalRefs[0].id).toBe('msg_assistant');
    expect(executor.getLastRecoverableResult({ ...current, leaseToken: 'older-lease' })).toBeNull();
    await executor.abort(current);
    releaseSleep.resolve();
    await running;
    expect(executor.getLastRecoverableResult(current)).toBeNull();
  } finally { releaseSleep.resolve(); await executor.shutdown(); }
});

for (const replacementBoundary of ['checkpoint', 'stop-read']) {
test(`old attempt gates and cleanup cannot affect a newer lease replacing it during ${replacementBoundary}`, async () => {
  const oldCheckpoint = cancellationDeferred(), releaseOld = cancellationDeferred(), newPrompt = cancellationDeferred();
  const unsubscribed = [];
  let creates = 0, aborts = 0;
  const oldTask = task(), newTask = task({ leaseToken: 'dvr_lease_2', startedAt: 4_000 });
  const executor = createManagedOpenCodeExecutor({
    subscribeAssistantActivity({ sessionId }) { return () => unsubscribed.push(sessionId); },
    transport: {
      async createSession() { return { id: `ses_${++creates}` }; },
      async promptSession({ sessionId, signal }) {
        expect(sessionId).toBe('ses_2'); newPrompt.resolve(signal);
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      async readSession() { return {}; }, async readStatus() { return { type: 'idle' }; },
      async readOperatorAbort({ sessionId }) {
        if (replacementBoundary === 'stop-read' && sessionId === 'ses_1') {
          oldCheckpoint.resolve(); await releaseOld.promise;
        }
        return null;
      },
      async readMessages() { return []; }, async abortSession() { aborts += 1; return true; }, deleteSession,
    },
  });
  const control = { async setChildSessionId() { return true; }, async markAccepted() { return true; }, async recordProgress() { return true; } };
  const oldRun = executor.start(oldTask, { ...control, async setChildSessionId() {
    if (replacementBoundary === 'checkpoint') { oldCheckpoint.resolve(); await releaseOld.promise; }
    return true;
  } });
  const oldRejected = oldRun.catch((error) => error);
  await oldCheckpoint.promise;
  const newRun = executor.start(newTask, control);
  try {
    const signal = await newPrompt.promise;
    releaseOld.resolve();
    expect(await oldRejected).toMatchObject({ message: expect.stringContaining('execution lease changed') });
    expect(signal.aborted).toBe(false);
    expect(unsubscribed).not.toContain('ses_2');
    await expect(executor.abort({ ...oldTask, childSessionId: 'ses_1' })).resolves.toMatchObject({ aborted: false });
    expect(aborts).toBe(0);
    expect(unsubscribed).not.toContain('ses_2');
    await executor.abort({ ...newTask, childSessionId: 'ses_2' });
    await expect(newRun).resolves.toMatchObject({ status: 'aborted' });
  } finally { releaseOld.resolve(); await executor.shutdown(); }
});
}

test('Stop suppresses initial submission through a failed transcript harvest without losing observation', async () => {
  let reads = 0, prompts = 0, clock = 3_000;
  const executor = createManagedOpenCodeExecutor({ now: () => clock, sleep: async (delay) => { clock += delay; }, transport: {
    async createSession() { return { id: 'ses_child' }; }, async promptSession() { prompts += 1; },
    async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: 'idle' }; },
    async readMessages() {
      reads += 1;
      if (reads < 3) throw new Error('transcript temporarily unavailable');
      return [assistant({ info: { finish: 'abort' } })];
    },
    async readOperatorAbort() { return { sessionId: 'ses_child', requestedAt: 3_000 }; },
    async abortSession() { return true; }, deleteSession,
  } });
  try {
    await expect(executor.start(task(), { async setChildSessionId() { return true; }, async markAccepted() { return true; } })).resolves.toMatchObject({ status: 'aborted' });
    expect(prompts).toBe(0);
    expect(reads).toBe(3);
  } finally { await executor.shutdown(); }
});

describe('independent observation failure clocks and owned teardown', () => {
  const timeout = () => Object.assign(new Error('Transcript read timed out'), { name: 'TimeoutError' });
  const retained = () => assistant({ info: { finish: 'tool-calls' }, parts: [{ type: 'text', text: 'Retained partial output' }] });

  test.each(['busy', 'retry'])('healthy %s polling cannot reset transcript failure grace or repeat expensive reads', async (liveType) => {
    let clock = 0, messageReads = 0, statusReads = 0, idle = false;
    const aborts = [], readTimes = [];
    const executor = createManagedOpenCodeExecutor({ now: () => clock,
      liveTranscriptRefreshMs: 750, retryStopMaxAborts: 1, retryStopPollLimit: 2,
      sleep: async (delay) => { clock += Math.max(1, delay); if (clock > 400_000) throw new Error('Fixture exceeded its stop bound'); },
      transport: {
        async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; },
        async readStatus() { statusReads += 1; return { type: idle ? 'idle' : liveType }; },
        async readMessages() { readTimes.push(clock); messageReads += 1; if (messageReads === 1) return [retained()]; throw timeout(); },
        async abortSession() { aborts.push(clock); idle = aborts.length === 2; return idle; }, deleteSession,
      },
    });
    try {
      expect(await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {}))
        .toMatchObject({ status: 'interrupted', partial: true, recoverablePreview: 'Retained partial output', resumable: true });
      expect(aborts).toHaveLength(2);
      expect(aborts[0]).toBeGreaterThanOrEqual(300_750);
      expect(aborts[1] - aborts[0]).toBeGreaterThanOrEqual(30_000);
      expect(statusReads).toBeGreaterThan(400);
      expect(messageReads).toBeLessThan(25);
      expect(readTimes.some((time, index) => index > 0 && time - readTimes[index - 1] >= 30_000)).toBe(true);
      expect(readTimes.at(-1)).toBeLessThanOrEqual(aborts[0]);
    } finally { await executor.shutdown(); }
  });

  test.each(['busy', 'idle'])('a recovered %s status clears its expired clock before any teardown', async (recoveredStatus) => {
    let clock = 0, statusReads = 0, aborts = 0, messageReads = 0;
    const executor = createManagedOpenCodeExecutor({ now: () => clock, observationFailureGraceMs: 3_000,
      sleep: async (delay) => { clock += delay; },
      transport: {
        async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; },
        async readStatus() {
          statusReads += 1;
          if (clock < 3_000) throw Object.assign(new Error('Status timed out'), { name: 'TimeoutError' });
          return { type: messageReads === 0 ? recoveredStatus : 'idle' };
        },
        async readMessages() { messageReads += 1; return [assistant()]; },
        async abortSession() { aborts += 1; return true; }, deleteSession,
      },
    });
    try {
      expect(await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {})).toMatchObject({ status: 'completed' });
      expect(aborts).toBe(0); expect(messageReads).toBeGreaterThan(0); expect(statusReads).toBeGreaterThan(4);
    } finally { await executor.shutdown(); }
  });

  test('unconfirmed teardown suppresses a later terminal event and survives concurrent fresh harvesting', async () => {
    let clock = 0, idle = false, event = false, aborts = 0, messageReads = 0, eventReadsAfterStop = 0;
    let harvested = false, fresh = false;
    const current = task({ childSessionId: 'ses_child', status: 'running' });
    const executor = createManagedOpenCodeExecutor({ now: () => clock, observationFailureGraceMs: 3_000,
      liveTranscriptRefreshMs: 750, retryStopMaxAborts: 1, retryStopPollLimit: 1,
      sleep: async (delay) => {
        clock += delay;
        if (event && !harvested) {
          harvested = true; fresh = true;
          expect(await executor.readRecoverableResult(current)).toMatchObject({ recoverablePreview: 'Fresh harvested output' });
          fresh = false;
        }
        if (clock > 50_000) throw new Error('Fixture exceeded its stop bound');
      },
      transport: {
        async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: idle ? 'idle' : 'busy' }; },
        async readMessages() {
          messageReads += 1;
          if (fresh) return [assistant({ info: { finish: 'tool-calls' }, parts: [{ type: 'text', text: 'Fresh harvested output' }] })];
          if (messageReads === 1) return [retained()];
          throw timeout();
        },
        async readTerminalError() {
          if (event) { eventReadsAfterStop += 1; return { eventId: 'permanent', message: 'Model not found: retired', observedAt: clock }; }
          return null;
        },
        async abortSession() { aborts += 1; event = true; idle = aborts === 2; return idle; }, deleteSession,
      },
    });
    try {
      expect(await executor.observe(current, {})).toMatchObject({ status: 'interrupted', recoverablePreview: 'Fresh harvested output' });
      expect(aborts).toBe(2); expect(eventReadsAfterStop).toBe(0); expect(harvested).toBe(true);
    } finally { await executor.shutdown(); }
  });

  test('fresh cancellation harvesting bypasses transcript backoff without shortening its request allowance', async () => {
    let clock = 0, reads = 0, harvested = false, idle = false;
    const current = task({ childSessionId: 'ses_child', status: 'running' });
    const readTimes = [];
    const executor = createManagedOpenCodeExecutor({ now: () => clock, liveTranscriptRefreshMs: 750,
      sleep: async (delay) => {
        if (reads === 2 && !harvested) {
          harvested = true;
          expect(await executor.readRecoverableResult(current)).toMatchObject({ recoverablePreview: 'Fresh output' });
          idle = true;
        }
        clock += delay;
      },
      transport: {
        async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: idle ? 'idle' : 'busy' }; },
        async readMessages() {
          reads += 1; readTimes.push(clock);
          if (reads === 1) return [retained()];
          if (reads === 2) throw timeout();
          return [assistant({ parts: [{ type: 'text', text: 'Fresh output' }] })];
        },
        async abortSession() { throw new Error('must not abort'); }, deleteSession,
      },
    });
    try {
      expect(await executor.observe(current, {})).toMatchObject({ status: 'completed' });
      expect(harvested).toBe(true); expect(readTimes[2]).toBe(readTimes[1]);
    } finally { await executor.shutdown(); }
  });
});

for (const channel of ['operator', 'task']) {
  test(`${channel} Stop retains a bounded transcript failure clock and last-good output`, async () => {
    let clock = 0, messageReads = 0, stopped = false, idle = false, aborts = 0;
    const current = task({ childSessionId: 'ses_child', status: 'running', startedAt: 0 });
    let executor;
    executor = createManagedOpenCodeExecutor({ now: () => clock, liveTranscriptRefreshMs: 750,
      retryStopMaxAborts: 1, retryStopPollLimit: 1,
      sleep: async (delay) => {
        clock += delay;
        if (!stopped && messageReads >= (channel === 'task' ? 2 : 1)) {
          stopped = true;
          if (channel === 'task') await executor.abort(current);
        }
        if (clock > 400_000) throw new Error('Fixture exceeded its stop bound');
      },
      transport: {
        async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; },
        async readStatus() { return { type: idle ? 'idle' : 'busy' }; },
        async readMessages() {
          messageReads += 1;
          if (messageReads === 1) return [assistant({ info: { finish: 'tool-calls' }, parts: [{ type: 'text', text: 'Before Stop' }] })];
          if (channel === 'task') idle = true;
          throw Object.assign(new Error('Transcript timed out'), { name: 'TimeoutError' });
        },
        async readOperatorAbort() { return channel === 'operator' && stopped ? { sessionId: 'ses_child', requestedAt: 500 } : null; },
        async abortSession() { aborts += 1; if (channel === 'operator') idle = true; return channel === 'operator'; },
        deleteSession,
      },
    });
    try {
      expect(await executor.observe(current, {})).toMatchObject({ status: 'interrupted', partial: true, recoverablePreview: 'Before Stop' });
      expect(clock).toBeGreaterThanOrEqual(300_750);
      expect(messageReads).toBeLessThan(25); expect(aborts).toBe(1);
    } finally { await executor.shutdown(); }
  });
}

test('expired status failures attempt bounded teardown and retain ownership through uncertain cleanup', async () => {
  let clock = 0, aborts = 0, idle = false, reads = 0;
  const abortTimes = [];
  const executor = createManagedOpenCodeExecutor({ now: () => clock, observationFailureGraceMs: 3_000,
    retryStopMaxAborts: 1, retryStopPollLimit: 1,
    sleep: async (delay) => { clock += delay; if (clock > 50_000) throw new Error('Fixture exceeded its stop bound'); },
    transport: {
      async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { if (!aborts) throw new TypeError('fetch failed'); return { type: idle ? 'idle' : 'busy' }; },
      async readMessages() { reads += 1; return [assistant()]; },
      async abortSession() { abortTimes.push(clock); aborts += 1; idle = aborts === 2; return idle; }, deleteSession,
    },
  });
  try {
    expect(await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {})).toMatchObject({ status: 'interrupted' });
    expect(aborts).toBe(2); expect(reads).toBe(0); expect(abortTimes[1] - abortTimes[0]).toBeGreaterThanOrEqual(30_000);
  } finally { await executor.shutdown(); }
});

test('successful transcript reads reset only their failure grace and retry delay', async () => {
  let clock = 0, reads = 0, aborts = 0;
  const readTimes = [];
  const executor = createManagedOpenCodeExecutor({ now: () => clock, observationFailureGraceMs: 4_000, liveTranscriptRefreshMs: 750,
    sleep: async (delay) => { clock += delay; if (clock > 10_000) throw new Error('Fixture exceeded its recovery bound'); },
    transport: {
      async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: reads >= 6 ? 'idle' : 'busy' }; },
      async readMessages() {
        reads += 1; readTimes.push(clock);
        if ([1, 2, 4, 5].includes(reads)) throw Object.assign(new Error('Transcript timeout'), { name: 'TimeoutError' });
        return [assistant()];
      },
      async abortSession() { aborts += 1; return true; }, deleteSession,
    },
  });
  try {
    expect(await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {})).toMatchObject({ status: 'completed' });
    expect(aborts).toBe(0); expect(readTimes.slice(0, 6)).toEqual([0, 750, 2_250, 3_000, 3_750, 5_250]);
  } finally { await executor.shutdown(); }
});

test('an unconfirmed operator Stop with readable output stays owned and retries after thirty seconds', async () => {
  let clock = 0, idle = false, aborts = 0, eventReads = 0;
  const abortTimes = [];
  const executor = createManagedOpenCodeExecutor({ now: () => clock, resumeTeardownSettleMs: 0,
    retryStopMaxAborts: 1, retryStopPollLimit: 1,
    sleep: async (delay) => { clock += delay; if (clock > 40_000) throw new Error('Stop fixture exceeded its retry bound'); },
    transport: {
      async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: idle ? 'idle' : 'busy' }; },
      async readMessages() { return [assistant({ info: { finish: 'abort' }, parts: [{ type: 'text', text: 'Stopped partial output' }] })]; },
      async readOperatorAbort() { return { sessionId: 'ses_child', requestedAt: 0 }; },
      async readTerminalError() { eventReads += 1; return { message: 'Model not found: old event' }; },
      async abortSession() { abortTimes.push(clock); aborts += 1; idle = aborts === 2; return idle; }, deleteSession,
    },
  });
  try {
    expect(await executor.observe(task({ childSessionId: 'ses_child', status: 'running', startedAt: 0 }), {}))
      .toMatchObject({ status: 'aborted', recoverablePreview: 'Stopped partial output' });
    expect(aborts).toBe(2); expect(abortTimes[1] - abortTimes[0]).toBeGreaterThanOrEqual(30_000);
    expect(eventReads).toBe(0);
  } finally { await executor.shutdown(); }
});

describe('canonical authentication retry cleanup', () => {
  const reason = 'Claude OAuth token has expired and could not be refreshed automatically. Run claude login to re-authenticate.';
  const otherReason = 'Invalid API key supplied';
  const run = async (source, change = 'matching') => {
    let clock = 3_000, statusReads = 0, messageReads = 0, eventReads = 0, aborts = 0, readsAfterAbort = 0;
    const user = { info: { id: 'msg_auth_user', role: 'user', time: { created: 1_500 } }, parts: [] };
    const failure = assistant({ info: { id: 'msg_auth_failed', parentID: 'msg_auth_user', finish: 'error',
      time: { created: 1_600, completed: 2_000 }, error: { name: 'APIError', data: { message: reason } } },
      parts: [{ type: 'text', text: 'Useful work before sign-in expired' }] });
    const finalMessageRead = source === 'event' ? 3 : 2;
    const finalStatusRead = source === 'event' ? 4 : 3;
    const executor = createManagedOpenCodeExecutor({ now: () => clock,
      sleep: async () => { clock += 1_000; if (clock > 10_000) throw new Error('Authentication fixture did not settle'); },
      transport: {
        async createSession() { throw new Error('must not create'); }, async promptSession() { throw new Error('must not prompt'); },
        async readSession() { return { id: 'ses_child' }; },
        async readTerminalError() {
          eventReads += 1;
          if (source !== 'event' || (eventReads === 1 && change !== 'no-prior')) return null;
          return { sessionId: 'ses_child', eventId: 'evt_auth', errorName: 'APIError', message: reason,
            observedAt: change === 'stale-event' ? 2_500 : change === 'missing-event-time' ? undefined : change === 'no-prior' ? 3_000 : 3_500 };
        },
        async readStatus() {
          statusReads += 1;
          if (aborts) readsAfterAbort += 1;
          if (source === 'event' && statusReads === 1 && change !== 'no-prior') return { type: 'busy' };
          const final = statusReads === finalStatusRead;
          const retry = { type: 'retry', message: reason, attempt: 1, next: 5_000 };
          if (change === 'idle') return { type: 'idle' };
          if (change === 'retry-failure-mismatch' && statusReads > (source === 'event' ? 2 : 1)) return { ...retry, message: otherReason };
          if (change === 'retry-changed-before-confirmation' && statusReads > (source === 'event' ? 2 : 1)) return { ...retry, attempt: 2 };
          if (final && change === 'new-retry') return { ...retry, attempt: 2, next: 6_000 };
          if (final && change === 'became-busy') return { type: 'busy' };
          if (final && change === 'became-idle') return { type: 'idle' };
          return retry;
        },
        async readMessages() {
          messageReads += 1;
          if (change === 'unreadable-final' && messageReads === finalMessageRead) throw new TypeError('fetch failed');
          const currentUser = structuredClone(user), currentFailure = structuredClone(failure);
          if (change === 'missing-user') return [currentFailure];
          if (change === 'missing-parent') delete currentFailure.info.parentID;
          if (change === 'missing-user-time') delete currentUser.info.time;
          if (change === 'old-turn') currentUser.info.time.created = 1_000;
          if (change === 'future-user') { currentUser.info.time.created = 10_000; currentFailure.info.time.completed = 11_000; }
          if (change === 'future-completion') currentFailure.info.time.completed = 11_000;
          if (change === 'turn-newer-than-event') { currentUser.info.time.created = 3_600; currentFailure.info.time.completed = 3_700; }
          if (change === 'failure-mismatch') currentFailure.info.error.data.message = otherReason;
          if ((change === 'new-user' && messageReads === finalMessageRead)
            || (change === 'event-new-turn' && source === 'event' && messageReads >= 2)) {
            currentUser.info.id = 'msg_new_user'; currentUser.info.time.created = 3_600;
            currentFailure.info.id = 'msg_new_failed'; currentFailure.info.parentID = currentUser.info.id;
            currentFailure.info.time.completed = 3_700;
          }
          if (change === 'new-assistant' && messageReads === finalMessageRead) currentFailure.info.id = 'msg_new_failed';
          return [currentUser, currentFailure];
        },
        async abortSession() { aborts += 1; return false; }, deleteSession,
      },
    });
    try {
      const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
      return { result, aborts, readsAfterAbort };
    } finally { await executor.shutdown(); }
  };

  for (const source of ['status', 'event']) {
    test(`${source} stops one freshly matched authentication retry without chasing a later turn`, async () => {
      const { result, aborts, readsAfterAbort } = await run(source);
      expect(result).toMatchObject({ status: 'failed', failureReason: reason, resumable: true, partial: true });
      expect(aborts).toBe(1); expect(readsAfterAbort).toBe(0);
    });
    for (const change of ['missing-user', 'missing-parent', 'missing-user-time', 'old-turn', 'future-user', 'future-completion', 'failure-mismatch',
      'retry-failure-mismatch', 'retry-changed-before-confirmation', 'new-user', 'new-assistant', 'new-retry', 'became-busy', 'became-idle', 'unreadable-final']) {
      test(`${source} skips authentication abort for ${change}`, async () => {
        const { result, aborts } = await run(source, change);
        expect(result).toMatchObject({ status: 'failed', failureReason: reason, resumable: true });
        expect(aborts).toBe(0);
      });
    }
  }
  for (const change of ['no-prior', 'stale-event', 'missing-event-time', 'event-new-turn', 'turn-newer-than-event', 'idle']) {
    test(`event authentication cleanup requires pre-event matching proof: ${change}`, async () => {
      const { result, aborts } = await run('event', change);
      expect(result).toMatchObject({ status: 'failed', failureReason: reason, resumable: true });
      expect(aborts).toBe(0);
    });
  }
});

test.each([true, false])('real current-assistant deltas keep the idle watchdog live while native REST text remains unsealed (durable callback %p)', async durableCallback => {
  let clock = 1000, reads = 0, aborts = 0, transcriptReads = 0;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const progress = [];
  const executor = createManagedOpenCodeExecutor({
    transport: {
      async createSession() { throw Error('unexpected create'); },
      async promptSession() { throw Error('unexpected prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: ++reads <= 6 ? 'busy' : 'idle' }; },
      async readMessages() {
        transcriptReads++;
        return [assistant({ info: { id: 'msg_live', time: reads <= 6 ? { created: 1000 } : { created: 1000, completed: clock },
          finish: reads <= 6 ? undefined : 'stop' }, parts: [{ type: 'text', text: reads <= 6 ? '' : 'Completed' }] })];
      },
      async abortSession() { aborts++; throw Error('Real semantic stream must not be stopped'); },
      deleteSession,
    },
    now: () => clock,
    sleep: async () => {
      clock += 100;
      registry.observe({ type: 'message.updated', properties: { info: {
        id: 'msg_live', sessionID: 'ses_child', role: 'assistant', time: { created: 1000 },
      } } }, '/repo');
      registry.observe({ id: `evt_${clock}`, type: 'message.part.delta', properties: {
        sessionID: 'ses_child', messageID: 'msg_live', partID: 'part_live', field: 'text', delta: '.',
      } }, '/repo');
    },
    subscribeAssistantActivity: registry.subscribe,
    pollIntervalMs: 0, liveTranscriptRefreshMs: 0, liveProgressTimeoutMs: 150, idleStablePolls: 1,
  });
  try {
    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running', startedAt: 1000, directory: '/repo' }), durableCallback ? {
      async recordProgress(value) { progress.push(value); return true; },
    } : {});
    expect(result.status).toBe('completed'); expect(aborts).toBe(0);
    expect(progress.filter(value => 'firstAssistantPartAt' in value)).toEqual(durableCallback ? [{ firstAssistantPartAt: 1100 }] : []);
    expect(progress.filter(value => 'assistantProgressAt' in value)).toEqual([]);
    expect(transcriptReads).toBe(reads);
  } finally { await executor.shutdown(); }
});

test('replayed deltas and busy heartbeats cannot keep a silent unchanged native transcript alive', async () => {
  let clock = 1000, aborts = 0;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const executor = createManagedOpenCodeExecutor({
    transport: {
      async createSession() { throw Error('unexpected create'); }, async promptSession() { throw Error('unexpected prompt'); },
      async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: 'busy' }; },
      async readMessages() { return [assistant({ info: { id: 'msg_live', finish: undefined, time: { created: 1000 } },
        parts: [{ type: 'text', text: '' }] })]; },
      async abortSession() { aborts++; throw Error('Original silent-child abort'); }, deleteSession,
    }, now: () => clock, sleep: async () => {
      clock += 100;
      registry.observe({ type: 'message.updated', properties: { info: {
        id: 'msg_live', sessionID: 'ses_child', role: 'assistant', time: { created: 1000 },
      } } }, '/repo');
      registry.observe({ id: 'evt_repeated', type: 'message.part.delta', properties: {
        sessionID: 'ses_child', messageID: 'msg_live', partID: 'part_live', field: 'text', delta: '.',
      } }, '/repo');
      registry.observe({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } }, '/repo');
    }, subscribeAssistantActivity: registry.subscribe,
    pollIntervalMs: 0, liveTranscriptRefreshMs: 0, liveProgressTimeoutMs: 150,
  });
  try {
    // No durable progress callback is required for watchdog observation.
    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running', startedAt: 1000, directory: '/repo' }), {});
    expect(result.status).toBe('interrupted'); expect(result.failureReason).toContain('Stream idle timeout');
    expect(aborts).toBeGreaterThan(0);
  } finally { await executor.shutdown(); }
});

test('same-child continuation replaces progress scope so delayed prior-turn deltas cannot sustain its watchdog', async () => {
  let clock = 1000, continued = false, aborts = 0;
  const subscriptions = [], registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const executor = createManagedOpenCodeExecutor({
    transport: {
      async createSession() { throw Error('unexpected create'); },
      async promptSession(input) { expect(input.prompt).toContain(MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT); continued = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: continued ? 'busy' : 'idle' }; },
      async readMessages() { return [assistant({ info: { id: continued ? 'msg_current' : 'msg_prior',
        finish: continued ? undefined : 'stop', time: continued ? { created: 1000 } : { created: 950, completed: 990 } },
        parts: [{ type: 'text', text: '' }] })]; },
      async abortSession() { aborts++; throw Error('Original silent-child abort'); }, deleteSession,
    }, now: () => clock, sleep: async () => {
      clock += 100;
      // Delayed old metadata lacks its later completion, as can happen across a
      // disconnected stream. Fresh IDs do not make this prior turn current.
      registry.observe({ type: 'message.updated', properties: { info: {
        id: 'msg_prior', sessionID: 'ses_child', role: 'assistant', time: { created: 950 },
      } } }, '/repo');
      registry.observe({ id: `evt_prior_${clock}`, type: 'message.part.delta', properties: {
        sessionID: 'ses_child', messageID: 'msg_prior', partID: 'part_prior', field: 'text', delta: '.',
      } }, '/repo');
    }, subscribeAssistantActivity: (input, ...callbacks) => { subscriptions.push(input); return registry.subscribe(input, ...callbacks); },
    pollIntervalMs: 0, liveTranscriptRefreshMs: 0, liveProgressTimeoutMs: 150, idleStablePolls: 1,
  });
  try {
    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running', startedAt: 900, directory: '/repo' }), {});
    expect(continued).toBe(true); expect(result.status).toBe('interrupted');
    expect(aborts).toBeGreaterThan(0);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]).toMatchObject({ after: 1000, excludedMessageId: 'msg_prior' });
  } finally { await executor.shutdown(); }
});

test('semantic progress arriving during an awaited transcript read fences the silent-stream decision', async () => {
  let clock = 1000, reads = 0, aborts = 0;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const executor = createManagedOpenCodeExecutor({
    transport: {
      async createSession() { throw Error('unexpected create'); }, async promptSession() { throw Error('unexpected prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: ++reads <= 2 ? 'busy' : 'idle' }; },
      async readMessages() {
        if (reads === 2) {
          // The decision's pre-read timestamp is already beyond the idle limit.
          clock += 10;
          registry.observe({ type: 'message.updated', properties: { info: {
            id: 'msg_live', sessionID: 'ses_child', role: 'assistant', time: { created: 1000 },
          } } }, '/repo');
          registry.observe({ id: 'evt_during_read', type: 'message.part.delta', properties: {
            sessionID: 'ses_child', messageID: 'msg_live', partID: 'part_live', field: 'text', delta: '.',
          } }, '/repo');
          await Promise.resolve();
        }
        return [assistant({ info: { id: 'msg_live', finish: reads <= 2 ? undefined : 'stop',
          time: reads <= 2 ? { created: 1000 } : { created: 1000, completed: clock } },
          parts: [{ type: 'text', text: reads <= 2 ? '' : 'Complete' }] })];
      }, async abortSession() { aborts++; throw Error('must not stop fresh progress'); }, deleteSession,
    }, now: () => clock, sleep: async () => { clock += 200; },
    subscribeAssistantActivity: registry.subscribe,
    pollIntervalMs: 0, liveTranscriptRefreshMs: 0, liveProgressTimeoutMs: 150, idleStablePolls: 1,
  });
  try {
    const result = await executor.observe(task({ childSessionId: 'ses_child', status: 'running', startedAt: 1000, directory: '/repo' }), {});
    expect(result.status).toBe('completed'); expect(aborts).toBe(0);
  } finally { await executor.shutdown(); }
});
