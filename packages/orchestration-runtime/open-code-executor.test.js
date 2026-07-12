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

describe('managed OpenCode executor', () => {
  test('stops on the first provider retry and continues the same child with a selected model', async () => {
    const calls = [];
    const statuses = [
      { type: 'retry', message: 'out of usage', attempt: 1, next: 5_000 },
      { type: 'idle' },
      { type: 'idle' },
      { type: 'busy' },
      { type: 'idle' },
    ];
    let continued = false;
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession(input) { calls.push(['prompt', input]); continued = true; },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() { return continued ? [assistant()] : []; },
      async abortSession(input) { calls.push(['abort', input]); return true; },
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      idleStablePolls: 1,
      retryStopPollLimit: 4,
    });
    const original = task({ childSessionId: 'ses_child', status: 'running' });

    const failed = await executor.observe(original, {});
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: 'out of usage',
      partial: false,
      resumable: true,
    });
    expect(calls.filter(([name]) => name === 'prompt')).toHaveLength(0);

    const control = { async markAccepted() { calls.push(['accepted']); } };
    const result = await executor.retryInPlace(task({
      childSessionId: 'ses_child',
      status: 'starting',
      executionKind: 'retry_in_place',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
      attempt: 2,
      priorTaskId: 'dvr_task_original',
    }), control);

    expect(calls[0][0]).toBe('abort');
    expect(calls.find(([name]) => name === 'prompt')?.[1]).toMatchObject({
      sessionId: 'ses_child',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });
    expect(calls.find(([name]) => name === 'prompt')?.[1].prompt).toContain('Continue the task');
    expect(result.status).toBe('completed');
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

  test('reserves re-aborts for a new retry attempt instead of unchanged sleep snapshots', async () => {
    let abortCount = 0;
    const retry = { type: 'retry', message: 'rate limited', attempt: 1, next: 5_000 };
    const statuses = [retry, retry, retry, { type: 'busy' }, { type: 'idle' }];
    const transport = {
      async createSession() { throw new Error('must not create'); },
      async promptSession() { throw new Error('must not prompt'); },
      async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return statuses.shift() ?? { type: 'idle' }; },
      async readMessages() { return []; },
      async abortSession() { abortCount += 1; return true; },
    };
    const executor = createManagedOpenCodeExecutor({
      transport,
      sleep: async () => undefined,
      retryStopPollLimit: 6,
    });

    await executor.observe(task({ childSessionId: 'ses_child', status: 'running' }), {});
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(abortCount).toBe(2);
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

    const result = await executor.start(task({ label: 'inspect-auth_flow' }), control);

    expect(calls.map(([name]) => name)).toEqual(['create', 'child', 'prompt', 'accepted']);
    expect(calls[0][1]).toEqual({
      directory: '/workspace',
      parentSessionId: 'ses_root',
      title: 'Inspect auth flow',
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
