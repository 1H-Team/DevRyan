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

const submitParams = (index: number) => ({
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
});

const getTask = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('task' in value)) {
    throw new TypeError('expected task result');
  }
  const task = value.task;
  if (!task || typeof task !== 'object') throw new TypeError('expected task record');
  return task as { taskId: string; status: string; childSessionId?: string | null };
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
      const params = submitParams(index);
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
    expect(submitted.every((result) => !('prompt' in getTask(result)))).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    runs[0].result.resolve({ status: 'completed', recoverablePreview: 'done' });
    await runtime.flush();
    expect(runs[3].taskId).toBe('dvr_task_vscode_4');
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
