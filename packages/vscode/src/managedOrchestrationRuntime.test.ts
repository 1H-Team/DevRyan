import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createManagedTaskRecord,
  type ManagedOrchestrationState,
  type ManagedTaskExecutorResult,
} from '@openchamber/orchestration-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVsCodeManagedOpenCodeExecutor,
  createVsCodeManagedOrchestrationHost,
  createVsCodeManagedOrchestrationLedger,
  createVsCodeManagedOrchestrationRuntime,
} from './managedOrchestrationRuntime';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-orchestration-'));
  temporaryDirectories.push(directory);
  return directory;
};

const queuedTask = (index: number) => createManagedTaskRecord({
  taskId: `dvr_task_${index}`,
  idempotencyKey: `task-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  sequence: index,
  mode: 'orchestrator',
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Run task ${index}.`,
  attempt: 1,
  priorTaskId: null,
  executionKind: 'start',
  createdAt: 1_000 + index,
  timeoutAt: null,
});

const submitParams = (index: number, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: `root-message-task-${index}`,
  rootSessionId: 'ses_root',
  parentTaskId: null,
  directory: '/workspace',
  mode: 'orchestrator' as const,
  providerId: 'github-copilot',
  modelId: 'gpt-4.1',
  agent: 'explorer',
  variant: null,
  label: `Task ${index}`,
  prompt: `Run task ${index}.`,
  ...overrides,
});

const getTask = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('task' in value)) {
    throw new TypeError('expected task result');
  }
  const task = value.task;
  if (!task || typeof task !== 'object') throw new TypeError('expected task record');
  return task as {
    taskId: string;
    status: string;
    childSessionId?: string | null;
    timeoutAt: number | null;
  };
};

const createPersistence = () => {
  let state: ManagedOrchestrationState | null = null;
  return {
    async load() { return state; },
    async save(value: ManagedOrchestrationState) { state = structuredClone(value); },
  };
};

const deferred = () => {
  let resolve!: (value: ManagedTaskExecutorResult) => void;
  const promise = new Promise<ManagedTaskExecutorResult>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('VS Code managed orchestration owner', () => {
  it('matches the web handoff validation and safe task projection', async () => {
    const runs: Array<{ result: ReturnType<typeof deferred> }> = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start() {
          const result = deferred();
          runs.push({ result });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_vscode_handoff',
      createLeaseToken: () => 'dvr_lease_vscode_handoff',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { dispatchGroupId: 'msg_parent' }),
    });

    const inspection = await runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    }) as { state: string; tasks: Array<{ task: Record<string, unknown> }> };
    expect(inspection.state).toBe('confirmation_required');
    expect(inspection.tasks[0].task.taskId).toBe(getTask(submitted).taskId);
    expect(inspection.tasks[0].task).not.toHaveProperty('prompt');
    expect(inspection.tasks[0].task).not.toHaveProperty('idempotencyKey');
    expect(inspection.tasks[0].task).not.toHaveProperty('dispatchGroupId');
    expect(inspection.tasks[0].task).not.toHaveProperty('leaseToken');

    const confirmed = await runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
        idempotencyKey: 'switch-vscode-01',
      },
    }) as { state: string; tasks: Array<{ task: Record<string, unknown> }> };
    expect(confirmed.state).toBe('clear');
    expect(confirmed.tasks[0].task).toMatchObject({ status: 'aborted' });

    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'builder',
        toMode: 'orchestrator',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'invalid_handoff_scope', statusCode: 400 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
      },
    })).rejects.toMatchObject({ code: 'missing_idempotency_key', statusCode: 400 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'invalid_handoff_scope', statusCode: 400 });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: 'false',
      },
    })).rejects.toMatchObject({ code: 'invalid_handoff_scope', statusCode: 400 });
    expect(runs).toHaveLength(1);
    await runtime.shutdown();
  });

  it('persists a private atomic ledger under extension storage', async () => {
    const storageDirectory = await createTemporaryDirectory();
    const ledger = createVsCodeManagedOrchestrationLedger({ storageDirectory });
    const expected = { version: 1 as const, tasks: [queuedTask(1)], resultEnvelopes: [] };

    await ledger.save(expected);

    expect(await ledger.load()).toEqual(expected);
    expect(ledger.filePath.startsWith(storageDirectory)).toBe(true);
    expect((await fs.stat(ledger.filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(ledger.filePath))).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('hydrates legacy tasks without dispatch groups instead of quarantining them', async () => {
    const storageDirectory = await createTemporaryDirectory();
    const ledger = createVsCodeManagedOrchestrationLedger({ storageDirectory });
    const legacyTask = { ...queuedTask(1) } as Record<string, unknown>;
    delete legacyTask.dispatchGroupId;
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, JSON.stringify({
      version: 1,
      tasks: [legacyTask],
      resultEnvelopes: [],
    }), { mode: 0o600 });

    const loaded = await ledger.load();

    expect(loaded?.tasks[0].dispatchGroupId).toBeNull();
    expect(ledger.getDiagnostics?.().quarantinedPath).toBeNull();
  });

  it('publishes a visible recovery warning after quarantining an invalid ledger', async () => {
    const storageDirectory = await createTemporaryDirectory();
    const ledger = createVsCodeManagedOrchestrationLedger({ storageDirectory });
    await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
    await fs.writeFile(ledger.filePath, '{invalid json', { mode: 0o600 });
    const events: unknown[] = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory,
      persistence: ledger,
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      publishEvent: (event) => { events.push(event); },
      logger: { warn: vi.fn() },
    });

    await runtime.initialize();

    expect(events).toEqual([{
      type: 'openchamber:managed-orchestration-warning',
      properties: { message: expect.stringContaining('ledger was quarantined') },
    }]);
    await runtime.shutdown();
  });

  it('binds a token-authenticated private IPv4 RPC host and releases it', async () => {
    const handleRpc = vi.fn(async (request: unknown) => request);
    const host = createVsCodeManagedOrchestrationHost({ handleRpc });
    const environment = await host.start();

    try {
      expect(environment.DEVRYAN_ORCHESTRATION_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
      const unauthorized = await fetch(environment.DEVRYAN_ORCHESTRATION_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'status', params: {} }),
      });
      expect(unauthorized.status).toBe(401);
      expect(handleRpc).not.toHaveBeenCalled();

      const accepted = await fetch(environment.DEVRYAN_ORCHESTRATION_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${environment.DEVRYAN_ORCHESTRATION_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'status', params: { taskId: 'dvr_task_1' } }),
      });
      expect(accepted.status).toBe(200);
      expect(handleRpc).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }

    expect(host.getDiagnostics()).toMatchObject({ started: false, activeRequests: 0 });
    await expect(fetch(environment.DEVRYAN_ORCHESTRATION_URL)).rejects.toThrow();
  });

  it('owns one three-slot scheduler and keeps projections prompt-free', async () => {
    const runs: Array<{ taskId: string; prompt: string; result: ReturnType<typeof deferred> }> = [];
    const events: unknown[] = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start(task) {
          const result = deferred();
          runs.push({ taskId: task.taskId, prompt: task.prompt, result });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      publishEvent: (event) => { events.push(event); },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_vscode_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_vscode_${++index}`;
      })(),
      now: () => 1_000,
    });

    const submitted: unknown[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const params = submitParams(index, index === 1 ? { timeoutAt: 1_500 } : {});
      if (index === 1) params.prompt = '  preserve RPC prompt whitespace\n';
      submitted.push(await runtime.handleRpc({ method: 'submit', params }));
    }
    await runtime.flush();

    expect(runs.map((run) => run.taskId)).toEqual([
      'dvr_task_vscode_1',
      'dvr_task_vscode_2',
      'dvr_task_vscode_3',
    ]);
    expect(runs[0].prompt).toBe('  preserve RPC prompt whitespace\n');
    expect(getTask(submitted[3]).status).toBe('queued');
    expect(getTask(submitted[4]).status).toBe('queued');
    expect(submitted.every((result) => getTask(result).timeoutAt === 1_801_000)).toBe(true);
    expect(submitted.every((result) => !('prompt' in getTask(result)))).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    await runtime.flush();
    expect(runs[3].taskId).toBe('dvr_task_vscode_4');
    await runtime.shutdown();
  });

  it('waits on a root-scoped private dispatch barrier with web-runtime parity', async () => {
    const runs: Array<{ result: ReturnType<typeof deferred> }> = [];
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        start() {
          const result = deferred();
          runs.push({ result });
          return result.promise;
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_barrier',
      createLeaseToken: () => 'dvr_lease_barrier',
      now: () => 1_000,
    });
    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { dispatchGroupId: 'msg_parent' }),
    });
    expect(getTask(submitted)).not.toHaveProperty('dispatchGroupId');
    expect(await runtime.handleRpc({
      method: 'barrier',
      params: { rootSessionId: 'ses_other' },
    })).toEqual({ state: 'clear', taskIds: [] });

    const barrier = runtime.handleRpc({
      method: 'barrier',
      params: { rootSessionId: 'ses_root' },
    });
    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    expect(await barrier).toEqual({
      state: 'awaiting_acknowledgement',
      taskIds: [getTask(submitted).taskId],
    });

    await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(submitted).taskId,
        rootSessionId: 'ses_root',
        action: 'continue',
        idempotencyKey: 'continue-barrier',
      },
    });
    expect(await runtime.handleRpc({
      method: 'barrier',
      params: { rootSessionId: 'ses_root' },
    })).toEqual({ state: 'clear', taskIds: [] });
    await runtime.shutdown();
  });

  it('gives retry, resume, and retry-in-place follow-ups a fresh default deadline', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async resume() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async retryInPlace() {
          return { status: 'failed', failureReason: 'temporary failure', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
        async shutdown() {},
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_deadline_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_deadline_${++index}`;
      })(),
      now: () => 10_000,
    });
    const originals: unknown[] = [];
    for (let index = 1; index <= 3; index += 1) {
      originals.push(await runtime.handleRpc({
        method: 'submit',
        params: submitParams(index, { childSessionId: `ses_child_${index}` }),
      }));
    }
    await runtime.flush();

    const actions = ['retry', 'resume', 'retry_in_place'] as const;
    for (let index = 0; index < actions.length; index += 1) {
      const result = await runtime.handleRpc({
        method: 'acknowledge',
        params: {
          taskId: getTask(originals[index]).taskId,
          rootSessionId: 'ses_root',
          directory: '/workspace',
          action: actions[index],
          idempotencyKey: `ack-${actions[index]}`,
        },
      }) as { followUpTask: unknown };
      expect(getTask(result.followUpTask).timeoutAt).toBe(1_810_000);
    }

    await runtime.shutdown();
  });

  it('maps the grouped agent retry ceiling to HTTP 409', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() {
          return { status: 'failed' as const, failureReason: 'usage limit', resumable: true };
        },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: (() => {
        let index = 0;
        return () => `dvr_task_retry_limit_${++index}`;
      })(),
      createLeaseToken: (() => {
        let index = 0;
        return () => `dvr_lease_retry_limit_${++index}`;
      })(),
      now: () => 10_000,
    });
    const original = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, { dispatchGroupId: 'msg_parent' }),
    });
    await runtime.flush();
    const firstRecovery = await runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(original).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'grouped-retry-1',
      },
    }) as { followUpTask: unknown };
    await runtime.flush();

    await expect(runtime.handleRpc({
      method: 'acknowledge',
      params: {
        taskId: getTask(firstRecovery.followUpTask).taskId,
        rootSessionId: 'ses_root',
        directory: '/workspace',
        action: 'retry',
        idempotencyKey: 'grouped-retry-2',
      },
    })).rejects.toMatchObject({ code: 'managed_retry_limit_reached', statusCode: 409 });

    await runtime.shutdown();
  });

  it('preserves the private Council three-minute deadline class', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      persistence: createPersistence(),
      executor: {
        async start() { return await new Promise<ManagedTaskExecutorResult>(() => {}); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
      createTaskId: () => 'dvr_task_council_deadline',
      createLeaseToken: () => 'dvr_lease_council_deadline',
      now: () => 10_000,
    });

    const submitted = await runtime.handleRpc({
      method: 'submit',
      params: submitParams(1, {
        deadlineClass: 'council',
        timeoutAt: 190_000,
      }),
    });

    expect(getTask(submitted).timeoutAt).toBe(190_000);
    await runtime.shutdown();
  });

  it('does not expose a bridge or scheduler API to configured external OpenCode', async () => {
    const runtime = createVsCodeManagedOrchestrationRuntime({
      storageDirectory: '/unused',
      isManagedOpenCode: () => false,
      persistence: createPersistence(),
      executor: {
        async start() { throw new Error('must not start'); },
        async abort() { return { aborted: true }; },
        async reconcile() { return { state: 'unavailable' as const }; },
        async readRecoverableResult() { return {}; },
      },
    });

    await expect(runtime.prepareBridge()).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
      statusCode: 503,
    });
    await expect(runtime.handleRpc({
      method: 'handoff',
      params: {
        rootSessionId: 'ses_root',
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      },
    })).rejects.toMatchObject({ code: 'managed_runtime_unavailable', statusCode: 503 });
    expect(await runtime.getSnapshot()).toMatchObject({ available: false, tasks: [] });
    await runtime.shutdown();
  });

  it('routes normal and Cursor children through their authoritative owners', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const cursorSdkRuntime = {
      handlePromptAsync: vi.fn(async () => ({ handled: true, status: 204 })),
      getSessionStatus: vi.fn(() => ({ ses_cursor: { type: 'idle' } })),
      getSessionMessages: vi.fn(async () => [{
        info: { id: 'msg_cursor', role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: 'cursor result' }],
      }]),
      abortSession: vi.fn(async () => true),
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const id = body.title === 'Cursor child' ? 'ses_cursor' : 'ses_normal';
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (pathname === '/session/status') return new Response(JSON.stringify({ ses_normal: { type: 'idle' } }));
      if (pathname.endsWith('/message')) return new Response(JSON.stringify([{
        info: { id: 'msg_normal', role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: 'normal result' }],
      }]));
      throw new Error(`unexpected request ${pathname}`);
    });
    const manager = {
      getApiUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
    };
    const executor = createVsCodeManagedOpenCodeExecutor({
      manager,
      cursorSdkRuntime,
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const control = { async setChildSessionId() {}, async markAccepted() {} };

    const normal = await executor.start({
      ...queuedTask(1),
      label: 'Normal child',
      prompt: '  preserve prompt whitespace\n',
    }, control);
    expect(normal.recoverablePreview).toBe('normal result');
    const promptRequest = requests.find(({ url }) => new URL(url).pathname.endsWith('/prompt_async'));
    expect(JSON.parse(String(promptRequest?.init?.body))).toMatchObject({
      tools: { 'resend_*': false, 'mcp__resend__*': false },
      parts: [{ type: 'text', text: '  preserve prompt whitespace\n' }],
    });

    const cursor = await executor.start({
      ...queuedTask(2),
      providerId: 'cursor-acp',
      modelId: 'composer-2',
      agent: 'builder',
      label: 'Cursor child',
    }, control);
    expect(cursor.recoverablePreview).toBe('cursor result');
    expect(cursorSdkRuntime.handlePromptAsync).toHaveBeenCalledTimes(1);
  });
});
