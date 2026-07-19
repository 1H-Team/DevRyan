import { describe, expect, test } from 'bun:test';

import { createManagedOpenCodeExecutor } from './open-code-executor.js';

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

describe('managed OpenCode executor', () => {
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
    });
    expect(reads).toBe(1);
    expect(calls.filter(([name]) => name === 'abort')).toHaveLength(1);
  });

  test('keeps the same child live through a transient rate limit and busy before completing', async () => {
    const calls = [];
    const statuses = [
      { type: 'retry', message: 'rate limited', attempt: 1, next: 5_000 },
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
    const statuses = [{ type: 'idle' }, { type: 'idle' }, { type: 'busy' }, { type: 'idle' }];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() {},
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
  });

  test('keeps repeated identical provider retry snapshots live', async () => {
    let abortCount = 0;
    let reads = 0;
    const retry = { type: 'retry', message: 'rate limited', attempt: 1, next: 5_000 };
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
    const statuses = [{ type: 'retry', message: 'rate limited' }, { type: 'idle' }];
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
    const statuses = [{ type: 'retry', message: 'rate limited' }, { type: 'idle' }];
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
      directory: '/workspace',
      parentSessionId: 'ses_root',
      title: 'Locate Chat UI',
    });
    expect(calls[2][1]).toMatchObject({
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
      async readMessages() { throw new Error('must not observe messages'); },
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

    expect(calls).toEqual(['status', 'prompt', 'abort']);
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

  test('does not report an empty completed assistant shell as successful work', async () => {
    const transport = {
      async createSession() { return { id: 'ses_empty' }; },
      async promptSession() {},
      async readSession() { return { id: 'ses_empty' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() {
        return [assistant({
          info: { finish: undefined, time: { completed: 2_000 } },
          parts: [],
        })];
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
      canonicalRefs: [{ type: 'message', id: 'msg_assistant' }],
      resumable: true,
    });
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

    expect((await executor.resume(existing, {})).status).toBe('completed');
    expect(await executor.abort(existing)).toEqual({ aborted: true });
    expect(calls).toEqual([{ sessionId: 'ses_existing', directory: '/workspace', providerId: 'github-copilot' }]);
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
