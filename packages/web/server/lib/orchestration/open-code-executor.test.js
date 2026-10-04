import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
  MANAGED_TURN_BUDGET_PROMPT,
} from '@openchamber/orchestration-runtime';

import { createOpenCodeClient } from '../opencode/opencode-client/index.js';
import { createNativeConsumerFixture } from '../opencode/test-native-consumer-client.js';
import { createWebManagedOpenCodeExecutor as createNativeExecutor } from './open-code-executor.js';

// Preserve transport-independent scheduler scenarios with a typed in-memory
// native client. Wire paths and auth are covered by the real-client tests below.
const createWebManagedOpenCodeExecutor = (options = {}) => createNativeExecutor({
  ...options,
  openCodeClient: 'openCodeClient' in options ? options.openCodeClient : createNativeConsumerFixture({
    readFixture: options.fetchImpl, headers: options.getOpenCodeAuthHeaders,
    baseUrl: () => options.buildOpenCodeUrl('/', ''),
  }),
});

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200,
  headers: { 'content-type': 'application/json' },
});

const waitForCondition = async (condition) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for test condition');
};

describe('web managed OpenCode executor transport', () => {
  const childRegistrationRun = async (registerExecutionChild) => {
    const requests = [];
    const executor = createWebManagedOpenCodeExecutor({
      registerExecutionChild,
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: vi.fn(async (url, init = {}) => {
        const { pathname } = new URL(url);
        requests.push({ method: init.method ?? 'GET', pathname });
        if (pathname === '/session' && init.method === 'POST') return jsonResponse({ id: 'ses_child' });
        if (init.method === 'DELETE') return jsonResponse(true);
        throw new Error(`Unexpected request ${init.method} ${pathname}`);
      }),
      childRegistrationRetryDelayMs: 1,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const control = { setChildSessionId: vi.fn(async () => true), markAccepted: vi.fn(async () => true) };
    const result = await executor.start({ taskId: 'dvr_task_child', dispatchCallId: 'call_dispatch', rootSessionId: 'ses_root',
      childSessionId: null, directory: '/workspace', providerId: 'github-copilot', modelId: 'gpt-4.1', agent: 'explorer',
      variant: null, label: 'Child', prompt: 'Inspect.' }, control).catch((error) => ({ thrown: error }));
    await executor.shutdown?.();
    return { requests, result, control };
  };

  it('retries a transient child registration and never deletes a registered child', async () => {
    let attempts = 0;
    const { requests, control } = await childRegistrationRun(vi.fn(async () => {
      if (++attempts < 3) throw Object.assign(new Error('local_execution_timeout'), { code: 'local_execution_timeout' });
    }));
    expect(attempts).toBe(3);
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(control.setChildSessionId).toHaveBeenCalledWith('ses_child');
  });

  it('keeps a child whose registration may have committed before retries ran out', async () => {
    const registration = vi.fn(async () => { throw Object.assign(new Error('local_execution_timeout'), { code: 'local_execution_timeout' }); });
    const { requests } = await childRegistrationRun(registration);
    expect(registration).toHaveBeenCalledTimes(3);
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('deletes the unregistered child when registration fails terminally', async () => {
    const registration = vi.fn(async () => { throw Object.assign(new Error('execution_reverted'), { code: 'execution_reverted' }); });
    const { requests, control } = await childRegistrationRun(registration);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.pathname)).toEqual(['/session/ses_child']);
    expect(control.setChildSessionId).not.toHaveBeenCalled();
  });

  it('keeps directory and auth isolation in the typed managed transport fixture', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init.method === 'POST') return jsonResponse({ id: 'ses_child' });
      if (pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (pathname === '/session/status') return jsonResponse({ ses_child: { type: 'idle' } });
      if (pathname.endsWith('/message')) {
        return jsonResponse([{
          info: {
            id: 'msg_1',
            role: 'assistant',
            finish: 'stop',
            time: { completed: 2_000 },
          },
          parts: [{ type: 'text', text: 'done' }],
        }]);
      }
      if (pathname === '/session/ses_child' && init.method === 'GET') return jsonResponse({ id: 'ses_child' });
      if (pathname.endsWith('/abort')) return jsonResponse({ success: true });
      throw new Error(`Unexpected request ${init.method} ${pathname}`);
    });
    const registerExecutionChild = vi.fn(async () => { expect(requests).toHaveLength(1); });
    const executor = createWebManagedOpenCodeExecutor({
      registerExecutionChild,
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const control = {
      setChildSessionId: vi.fn(async () => true),
      markAccepted: vi.fn(async () => true),
    };
    const task = {
      taskId: 'dvr_task_1',
      dispatchCallId: 'call_owned_dispatch',
      rootSessionId: 'ses_root',
      childSessionId: null,
      directory: '/workspace with spaces',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      variant: null,
      label: 'Managed child',
      prompt: 'Inspect the project.',
    };

    const result = await executor.start(task, control);

    expect(result.status).toBe('completed');
    expect(registerExecutionChild).toHaveBeenCalledWith({ directory: '/workspace with spaces',
      sessionID: 'ses_child', parentID: 'ses_root', parentCallID: 'call_owned_dispatch' });
    expect(control.setChildSessionId).toHaveBeenCalledWith('ses_child');
    expect(requests[0].url).toBe('http://127.0.0.1:4096/session?directory=%2Fworkspace+with+spaces');
    expect(JSON.parse(requests[0].init.body)).toEqual({
      title: 'Managed Child',
      parentID: 'ses_root',
    });
    const prompt = requests.find((request) => new URL(request.url).pathname.endsWith('/prompt_async'));
    expect(JSON.parse(prompt.init.body)).toEqual({
      agent: 'explorer',
      model: { providerID: 'github-copilot', modelID: 'gpt-4.1' },
      variant: '',
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
      parts: [{
        type: 'text',
        text: 'Inspect the project.',
      }],
    });
    expect(requests.every((request) => request.init.headers.authorization === 'Basic opaque')).toBe(true);
  });

  it('preserves structured Zen free-tier status metadata for immediate recovery', async () => {
    const requests = [];
    let statusReads = 0;
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session/status') {
        statusReads += 1;
        return jsonResponse({
          ses_child: statusReads === 1
            ? {
              type: 'retry',
              message: 'Subscribe to continue',
              action: { reason: 'free_tier_limit' },
              next: Date.now() + (4 * 60 * 60 * 1_000),
            }
            : { type: 'idle' },
        });
      }
      if (pathname.endsWith('/message')) {
        return jsonResponse([{
          info: { id: 'msg_partial', role: 'assistant', finish: 'tool-calls' },
          parts: [{ type: 'text', text: 'Partial work' }],
        }]);
      }
      if (pathname.endsWith('/abort')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${init.method} ${pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
      pollIntervalMs: 0,
    });

    await expect(executor.observe({
      taskId: 'dvr_task_zen_limit',
      childSessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'opencode',
    })).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'Provider usage limit reached: Subscribe to continue',
      recoverablePreview: 'Partial work',
      resumable: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.some(({ url, init }) => (
      new URL(url).pathname.endsWith('/abort') && init.method === 'POST'
    ))).toBe(true);
  });

  it('single-flights overlapping status observers by exact URL and polls again after settlement', async () => {
    let releaseStatus;
    const firstStatusGate = new Promise((resolve) => { releaseStatus = resolve; });
    let statusRequests = 0;
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/session/status') {
        statusRequests += 1;
        if (statusRequests === 1) await firstStatusGate;
        return jsonResponse({
          ses_alpha: { type: 'idle' },
          ses_beta: { type: 'idle' },
        });
      }
      if (parsed.pathname.endsWith('/message')) {
        const sessionId = parsed.pathname.split('/')[2];
        return jsonResponse([{
          info: { id: `msg_${sessionId}`, role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: `${sessionId} result` }],
        }]);
      }
      throw new Error(`Unexpected request ${parsed.pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const observe = (sessionId) => executor.observe({
      taskId: `dvr_task_${sessionId}`,
      childSessionId: sessionId,
      directory: '/workspace',
      providerId: 'openai',
    });

    const alpha = observe('ses_alpha');
    const beta = observe('ses_beta');
    await waitForCondition(() => statusRequests === 1);
    releaseStatus();
    await expect(Promise.all([alpha, beta])).resolves.toMatchObject([
      { status: 'completed', recoverablePreview: 'ses_alpha result' },
      { status: 'completed', recoverablePreview: 'ses_beta result' },
    ]);
    expect(statusRequests).toBe(1);

    await expect(observe('ses_alpha')).resolves.toMatchObject({ status: 'completed' });
    expect(statusRequests).toBe(2);
  });

  it('does not share status requests across directory or resolved-port URL changes', async () => {
    const statusGates = [];
    const statusUrls = [];
    let activePort = 4096;
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/session/status') {
        statusUrls.push(parsed.toString());
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        statusGates.push(release);
        await gate;
        return jsonResponse({
          ses_one: { type: 'idle' },
          ses_two: { type: 'idle' },
          ses_port_a: { type: 'idle' },
          ses_port_b: { type: 'idle' },
        });
      }
      if (parsed.pathname.endsWith('/message')) {
        const sessionId = parsed.pathname.split('/')[2];
        return jsonResponse([{
          info: { id: `msg_${sessionId}`, role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: 'done' }],
        }]);
      }
      throw new Error(`Unexpected request ${parsed.pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:${activePort}${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const observe = (sessionId, directory) => executor.observe({
      taskId: `dvr_task_${sessionId}`,
      childSessionId: sessionId,
      directory,
      providerId: 'openai',
    });

    const differentDirectories = [
      observe('ses_one', '/workspace/one'),
      observe('ses_two', '/workspace/two'),
    ];
    await waitForCondition(() => statusUrls.length === 2);
    statusGates.splice(0).forEach((release) => release());
    await Promise.all(differentDirectories);
    expect(new Set(statusUrls.map((url) => new URL(url).search))).toEqual(new Set([
      '?directory=%2Fworkspace%2Fone',
      '?directory=%2Fworkspace%2Ftwo',
    ]));

    const firstPort = observe('ses_port_a', '/workspace/port');
    await waitForCondition(() => statusUrls.length === 3);
    activePort = 4097;
    const secondPort = observe('ses_port_b', '/workspace/port');
    await waitForCondition(() => statusUrls.length === 4);
    statusGates.splice(0).forEach((release) => release());
    await Promise.all([firstPort, secondPort]);
    expect(statusUrls.slice(2).map((url) => new URL(url).port)).toEqual(['4096', '4097']);
  });

  it('defers same-child reconciliation while the managed runtime port is unavailable', async () => {
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: () => {
        const error = new Error('OpenCode port is not available');
        error.code = 'managed_runtime_unavailable';
        error.statusCode = 503;
        throw error;
      },
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl: vi.fn(),
    });

    await expect(executor.reconcile({
      taskId: 'dvr_task_port_transition',
      childSessionId: 'ses_existing',
      directory: '/workspace',
      providerId: 'openai',
    })).resolves.toEqual({
      state: 'transient',
      failureReason: 'OpenCode port is not available',
    });
  });

  it.each([true, false])('recovers a finalized timeout only with the original assignment (available: %s)', async (hasAssignment) => {
    const requests = [];
    let statusReads = 0;
    const timeoutMessage = {
      info: {
        id: 'msg_timeout',
        role: 'assistant',
        time: { completed: 1_000 },
        finish: 'error',
        error: { message: 'The operation timed out.' },
      },
      parts: [{ type: 'text', text: 'partial' }],
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (pathname === '/session/status') {
        statusReads += 1;
        const type = requests.some(({ url: sent }) => new URL(sent).pathname.endsWith('/prompt_async')) && statusReads === 3 ? 'busy' : 'idle';
        return jsonResponse({ ses_child: { type } });
      }
      if (pathname.endsWith('/message')) {
        // The recovery message appears once the continuation prompt was sent,
        // rather than after a fixed number of transcript reads: a live child is
        // no longer re-read on every poll.
        const continued = requests.find(({ url: sent }) => (
          new URL(sent).pathname.endsWith('/prompt_async')
        ));
        return jsonResponse(!continued
          ? [timeoutMessage]
          : [
              timeoutMessage,
              {
                info: { id: 'msg_done', role: 'assistant', finish: 'stop', parentID: JSON.parse(continued.init.body).messageID },
                parts: [{ type: 'text', text: 'done' }],
              },
            ]);
      }
      throw new Error(`Unexpected request ${init.method} ${pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
      pollIntervalMs: 0,
    });

    const result = await executor.observe({
      taskId: 'dvr_task_1',
      rootSessionId: 'ses_root',
      label: 'Inspect project',
      prompt: hasAssignment ? 'Inspect the project.' : '',
      childSessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'fixer',
      variant: 'high',
    }, { async recordTransportRecovery() { return true; } });

    const promptRequests = requests.filter(({ url }) => (
      new URL(url).pathname.endsWith('/prompt_async')
    ));
    if (!hasAssignment) {
      expect(result).toMatchObject({ status: 'failed', resumable: false,
        failureReason: 'Managed continuation requires the original task identity and assignment',
        recoverablePreview: 'partial' });
      expect(promptRequests).toHaveLength(0);
      return;
    }
    expect(result.status).toBe('completed');
    expect(promptRequests).toHaveLength(1);
    const continuationBody = JSON.parse(promptRequests[0].init.body);
    expect(continuationBody).toMatchObject({
      agent: 'fixer',
      model: { providerID: 'github-copilot', modelID: 'gpt-4.1' },
      variant: 'high',
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        task: false,
      },
      parts: [{ type: 'text', text: expect.stringContaining(MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT) }],
    });
    expect(JSON.parse(continuationBody.parts[0].text.split('\n').at(-1))).toEqual({
      taskId: 'dvr_task_1', rootSessionId: 'ses_root', agent: 'fixer',
      label: 'Inspect project', prompt: 'Inspect the project.',
    });
    // The persisted correlation ID is fresh and sorts like an OpenCode message.
    expect(continuationBody.messageID).toMatch(/^msg_[0-9a-f]{26}$/);
  });

  it('aborts and deletes a normal-provider child when the scheduler rejects its ownership checkpoint', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init.method === 'POST') {
        return jsonResponse({ id: 'ses_stale_normal' });
      }
      if (pathname === '/session/ses_stale_normal/abort' && init.method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (pathname === '/session/ses_stale_normal' && init.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${init.method} ${pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
    });

    await expect(executor.start({
      taskId: 'dvr_task_stale_normal',
      rootSessionId: 'ses_root',
      childSessionId: null,
      directory: '/workspace',
      providerId: 'openai',
      modelId: 'gpt-5',
      agent: 'explorer',
      variant: null,
      label: 'Stale normal child',
      prompt: 'Must not run.',
    }, {
      async setChildSessionId() { return false; },
      async markAccepted() { throw new Error('must not accept'); },
    })).rejects.toThrow('lost launch ownership before provider prompt');

    expect(requests.map(({ url, init }) => [new URL(url).pathname, init.method])).toEqual([
      ['/session', 'POST'],
      ['/session/ses_stale_normal/abort', 'POST'],
      ['/session/ses_stale_normal', 'DELETE'],
    ]);
  });

  it('routes Cursor prompt, status, messages, and abort through the virtual provider owner', async () => {
    const cursorSdkRuntime = {
      handlePromptAsync: vi.fn(async () => ({ handled: true, status: 204 })),
      getSessionStatus: vi.fn(() => ({ ses_cursor: { type: 'idle' } })),
      getSessionMessages: vi.fn(async () => [{
        info: { id: 'msg_cursor', role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: 'cursor result' }],
      }]),
      abortSession: vi.fn(async () => true),
      deleteSessionState: vi.fn(async () => true),
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init.method === 'POST') return jsonResponse({ id: 'ses_cursor' });
      if (pathname === '/session/ses_cursor' && init.method === 'GET') return jsonResponse({ id: 'ses_cursor' });
      throw new Error(`Cursor request leaked upstream: ${init.method} ${pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      cursorSdkRuntime,
      pollIntervalMs: 0,
      idleStablePolls: 1,
    });
    const task = {
      taskId: 'dvr_task_cursor',
      rootSessionId: 'ses_root',
      childSessionId: null,
      directory: '/workspace',
      providerId: 'cursor-acp',
      modelId: 'composer-2',
      agent: 'builder',
      variant: 'fast',
      label: 'Cursor child',
      prompt: 'Implement the change.',
    };
    let childSessionId = null;
    const result = await executor.start(task, {
      async setChildSessionId(value) { childSessionId = value; },
      async markAccepted() {},
    });

    expect(result.recoverablePreview).toBe('cursor result');
    expect(cursorSdkRuntime.handlePromptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_cursor',
      directory: '/workspace',
      body: {
        agent: 'builder',
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        variant: 'fast',
        parts: [{
          type: 'text',
          text: 'Implement the change.',
        }],
        tools: { task: false },
      },
    });
    expect(await executor.abort({ ...task, childSessionId })).toEqual({ aborted: true });
    expect(cursorSdkRuntime.abortSession).toHaveBeenCalledWith('ses_cursor');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the scheduler abort signal for a normal-provider abort request', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
    });
    const controller = new AbortController();

    await expect(executor.abort({
      taskId: 'dvr_task_abort_signal',
      childSessionId: 'ses_abort_signal',
      directory: '/workspace',
      providerId: 'openai',
    }, { signal: controller.signal })).resolves.toEqual({ aborted: true });

    expect(requests).toHaveLength(1);
    expect(requests[0].init.signal).toBe(controller.signal);
  });

  it('surfaces bounded upstream failures without exposing a response body as success', async () => {
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => new Response('x'.repeat(10_000), { status: 503 }),
    });

    await expect(executor.start({
      taskId: 'dvr_task_failure',
      rootSessionId: 'ses_root',
      directory: '/workspace',
      providerId: 'openai',
      modelId: 'gpt-5',
      agent: 'explorer',
      variant: null,
      label: 'Failure',
      prompt: 'Fail safely.',
    }, {
      async setChildSessionId() {},
      async markAccepted() {},
    })).rejects.toMatchObject({
      code: 'opencode_http_error',
      statusCode: 503,
    });
  });
});

describe('web managed OpenCode executor host hooks', () => {
  it('forwards the prompt preamble and turn budget hooks into the child prompts', async () => {
    const prompts = [];
    let messageReads = 0;
    const handoff = {
      info: { id: 'msg_1', role: 'assistant', finish: 'tool-calls', time: { completed: 2_000 } },
      parts: [{ type: 'text', text: 'working' }],
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init.method === 'POST') return jsonResponse({ id: 'ses_child' });
      if (pathname.endsWith('/prompt_async')) {
        prompts.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (pathname === '/session/status') return jsonResponse({ ses_child: { type: 'idle' } });
      if (pathname.endsWith('/message')) {
        messageReads += 1;
        // Idle between steps first (a tool-call handoff), then the final answer.
        if (messageReads === 1) return jsonResponse([handoff]);
        return jsonResponse([
          handoff,
          {
            info: { id: 'msg_2', role: 'assistant', finish: 'stop', time: { completed: 2_100 } },
            parts: [{ type: 'text', text: 'done' }],
          },
        ]);
      }
      if (pathname === '/session/ses_child' && init.method === 'GET') return jsonResponse({ id: 'ses_child' });
      if (pathname.endsWith('/abort')) return jsonResponse({ success: true });
      throw new Error(`Unexpected request ${init.method} ${pathname}`);
    });
    const executor = createWebManagedOpenCodeExecutor({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      pollIntervalMs: 0,
      idleStablePolls: 1,
      resolveTaskPromptPreamble: (task) => (task.agent === 'explorer' ? 'Contract.' : null),
      resolveTaskTurnBudget: (task) => (task.agent === 'explorer' ? 1 : null),
    });

    const result = await executor.start({
      taskId: 'dvr_task_hooks',
      rootSessionId: 'ses_root',
      childSessionId: null,
      directory: '/workspace',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      agent: 'explorer',
      variant: null,
      label: 'Hooked child',
      prompt: 'Inspect the project.',
    }, {
      setChildSessionId: vi.fn(async () => true),
      markAccepted: vi.fn(async () => true),
    });

    expect(result.status).toBe('completed');
    expect(prompts.map((body) => body.parts[0].text)).toEqual([
      'Contract.\n\nInspect the project.',
      expect.stringContaining(MANAGED_TURN_BUDGET_PROMPT),
    ]);
    expect(JSON.parse(prompts[1].parts[0].text.split('\n').at(-1))).toEqual({
      taskId: 'dvr_task_hooks', rootSessionId: 'ses_root', agent: 'explorer',
      label: 'Hooked child', prompt: 'Inspect the project.',
    });
  });
});

describe('web managed OpenCode executor on gen 2 (openCodeClient)', () => {
  const createFakeOpenCodeClient = ({ generation = 2, ...overrides } = {}) => ({
    generation: vi.fn(() => {
      if (generation instanceof Error) throw generation;
      return generation;
    }),
    sessions: {
      create: vi.fn(async () => ({ id: 'ses_child_v2', version: '2' })),
      get: vi.fn(async (sessionID) => ({ id: sessionID })),
      status: vi.fn(async () => ({})),
      messages: vi.fn(async () => ({
        records: [{
          info: { id: 'msg_v2', role: 'assistant', finish: 'stop', time: { completed: 2_000 }, summary: { diffs: [{ patch: 'x' }] } },
          parts: [{ type: 'text', text: 'v2 done' }],
        }],
        cursor: undefined,
      })),
      abort: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      ...overrides.sessions,
    },
    prompts: {
      prompt: vi.fn(async () => true),
      ...overrides.prompts,
    },
  });

  const task = {
    taskId: 'dvr_task_v2',
    leaseToken: 'dvr_lease_v2',
    dispatchCallId: 'call_v2_dispatch',
    rootSessionId: 'ses_root',
    childSessionId: null,
    directory: '/workspace',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: 'V2 child',
    prompt: 'Inspect the project.',
  };

  const createExecutor = (openCodeClient, extra = {}) => createWebManagedOpenCodeExecutor({
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic opaque' }),
    fetchImpl: vi.fn(async (url) => { throw new Error(`gen 2 leaked a direct request: ${url}`); }),
    openCodeClient,
    pollIntervalMs: 0,
    idleStablePolls: 1,
    ...extra,
  });

  it('rejects an injected client that is not an openCodeClient', () => {
    expect(() => createExecutor({})).toThrow('openCodeClient must be an openCodeClient');
  });

  it('creates, prompts, observes and reads the child through the client with today\'s budgets', async () => {
    const client = createFakeOpenCodeClient();
    const registerExecutionChild = vi.fn(async () => {});
    const nativeTaskDispatch = vi.fn(async (input, action) => {
      if (input.operation === 'create') expect(client.sessions.create).not.toHaveBeenCalled();
      else expect(client.prompts.prompt).not.toHaveBeenCalled();
      return action();
    });
    const executor = createExecutor(client, { registerExecutionChild, nativeTaskDispatch });
    const control = { setChildSessionId: vi.fn(async () => true), markAccepted: vi.fn(async () => true) };

    const result = await executor.start(task, control);

    expect(result).toMatchObject({ status: 'completed', recoverablePreview: 'v2 done' });
    expect(nativeTaskDispatch.mock.calls.map(([input]) => input)).toEqual([
      { operation: 'create', taskId: task.taskId, leaseToken: task.leaseToken, directory: task.directory,
        parentID: task.rootSessionId, parentCallID: task.dispatchCallId },
      { operation: 'prompt', taskId: task.taskId, leaseToken: task.leaseToken, directory: task.directory,
        sessionID: 'ses_child_v2', providerId: task.providerId, modelId: task.modelId, agent: task.agent, variant: null },
    ]);
    expect(client.sessions.create).toHaveBeenCalledWith(
      { directory: '/workspace', title: 'V2 Child', parentID: 'ses_root' },
      { directory: '/workspace', timeoutMs: 30_000 },
    );
    expect(registerExecutionChild).toHaveBeenCalledWith({ directory: '/workspace', sessionID: 'ses_child_v2',
      parentID: 'ses_root', parentCallID: 'call_v2_dispatch' });
    expect(control.setChildSessionId).toHaveBeenCalledWith('ses_child_v2');
    // The v1 prompt body goes to the admission module unchanged (B.5).
    expect(client.prompts.prompt).toHaveBeenCalledWith('ses_child_v2', expect.objectContaining({
      agent: 'explorer',
      model: { providerID: 'github-copilot', modelID: 'gpt-4.1' },
      variant: '',
      parts: [{ type: 'text', text: 'Inspect the project.' }],
    }), expect.objectContaining({ directory: '/workspace', timeoutMs: 30_000 }));
    // The scheduler's launch signal travels with the dispatch budget, as on gen 1.
    const promptOptions = client.prompts.prompt.mock.calls[0][2];
    expect(Object.keys(promptOptions).sort()).toEqual(['directory', 'signal', 'timeoutMs']);
    expect(promptOptions.signal).toBeInstanceOf(AbortSignal);
    expect(client.sessions.status).toHaveBeenCalledWith({ directory: '/workspace' }, { timeoutMs: 10_000 });
    expect(client.sessions.messages).toHaveBeenCalledWith('ses_child_v2', { limit: 100 },
      { directory: '/workspace', timeoutMs: 120_000, signal: expect.any(AbortSignal) });
  });

  it('keeps native registration and observation outside the expired submitting tool context', async () => {
    const context = new AsyncLocalStorage();
    const neutralReads = [];
    const client = createFakeOpenCodeClient();
    for (const [name, method] of Object.entries(client.sessions)) {
      client.sessions[name] = vi.fn((...args) => {
        expect(context.getStore()).toBe(name === 'create' ? 'fresh-dispatch' : undefined);
        if (name !== 'create') neutralReads.push(name);
        return method(...args);
      });
    }
    const prompt = client.prompts.prompt;
    client.prompts.prompt = vi.fn((...args) => {
      expect(context.getStore()).toBe('fresh-dispatch');
      return prompt(...args);
    });
    const registerExecutionChild = vi.fn(async () => { expect(context.getStore()).toBeUndefined(); });
    const executor = createExecutor(client, {
      registerExecutionChild,
      nativeTaskDispatch: (_input, action) => {
        expect(context.getStore()).toBeUndefined();
        return context.run('fresh-dispatch', action);
      },
    });
    try {
      const result = await context.run('expired-tool', () => executor.start(task, {
        async setChildSessionId() { return true; }, async markAccepted() { return true; },
      }));
      expect(result.status).toBe('completed');
      expect(registerExecutionChild).toHaveBeenCalledOnce();
      expect(neutralReads).toEqual(expect.arrayContaining(['status', 'messages']));
      await expect(context.run('expired-tool', () => executor.observe({ ...task, childSessionId: 'ses_child_v2' })))
        .resolves.toMatchObject({ status: 'completed' });
    } finally { await executor.shutdown(); }
  });

  it.each(['create', 'prompt'])('refuses native %s before the client mutation when its lease was revoked', async (operation) => {
    const client = createFakeOpenCodeClient();
    const failure = Object.assign(new Error('task lease revoked'), { code: 'native_managed_task_lease_invalid' });
    const executor = createExecutor(client, { nativeTaskDispatch: async (input, action) => {
      if (input.operation === operation) throw failure;
      return action();
    } });
    await expect(executor.start(task, {
      async setChildSessionId() { return true; }, async markAccepted() { return true; },
    })).rejects.toBe(failure);
    expect(client.prompts.prompt).not.toHaveBeenCalled();
    expect(client.sessions.create).toHaveBeenCalledTimes(operation === 'create' ? 0 : 1);
    await executor.shutdown?.();
  });

  it('single-flights gen-2 status reads per directory', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = createFakeOpenCodeClient({
      sessions: {
        status: vi.fn(async () => {
          await gate;
          return { ses_alpha: { type: 'idle' }, ses_beta: { type: 'idle' } };
        }),
        messages: vi.fn(async (sessionID) => ({
          records: [{ info: { id: `msg_${sessionID}`, role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: `${sessionID} result` }] }],
          cursor: undefined,
        })),
      },
    });
    const executor = createExecutor(client);
    const observe = (sessionId) => executor.observe({ taskId: `dvr_task_${sessionId}`, childSessionId: sessionId,
      directory: '/workspace', providerId: 'openai' });

    const pending = Promise.all([observe('ses_alpha'), observe('ses_beta')]);
    await waitForCondition(() => client.sessions.status.mock.calls.length === 1);
    release();
    await expect(pending).resolves.toMatchObject([
      { status: 'completed', recoverablePreview: 'ses_alpha result' },
      { status: 'completed', recoverablePreview: 'ses_beta result' },
    ]);
    expect(client.sessions.status).toHaveBeenCalledTimes(1);
  });

  it('detaches a cancelled task from shared stalled status without stopping the other task', async () => {
    let release, creates = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const client = createFakeOpenCodeClient({ sessions: {
      create: vi.fn(async () => ({ id: `ses_child_${++creates}`, version: '2' })),
      status: vi.fn(async () => { await gate; return {}; }),
    } });
    const executor = createExecutor(client);
    const control = { async setChildSessionId() { return true; }, async markAccepted() { return true; } };
    const firstTask = { ...task, taskId: 'dvr_task_first' }, secondTask = { ...task, taskId: 'dvr_task_second' };
    const first = executor.start(firstTask, control);
    const second = executor.start(secondTask, control);
    try {
      await waitForCondition(() => client.prompts.prompt.mock.calls.length === 2 && client.sessions.status.mock.calls.length === 1);
      await executor.abort({ ...firstTask, childSessionId: 'ses_child_1' });
      // This must settle before the underlying HTTP read has been released.
      await expect(first).resolves.toMatchObject({ status: 'aborted' });
      expect(client.sessions.status).toHaveBeenCalledTimes(1);
      expect(client.sessions.abort).toHaveBeenCalledTimes(1);
      expect(client.sessions.abort.mock.calls[0][0]).toBe('ses_child_1');
      expect(client.sessions.status.mock.calls[0][1].signal).toBeUndefined();
      release();
      await expect(second).resolves.toMatchObject({ status: 'completed' });
      expect(client.prompts.prompt).toHaveBeenCalledTimes(2);
      expect(client.sessions.status).toHaveBeenCalledTimes(1);
    } finally { release(); await executor.shutdown(); }
  });

  it('does not consume a shared status response from a replaced runtime incarnation', async () => {
    let release, epoch = 1;
    const gate = new Promise(resolve => { release = resolve; });
    const client = createFakeOpenCodeClient({ sessions: { status: vi.fn(async () => { await gate; return {}; }) } });
    const executor = createExecutor(client, { readRuntimeStartedAt: () => epoch });
    const pending = executor.observe({ ...task, childSessionId: 'ses_child_v2' }).catch(error => error);
    try {
      await waitForCondition(() => client.sessions.status.mock.calls.length === 1);
      epoch = 2;
      release();
      expect(await pending).toMatchObject({ status: 'interrupted', resumable: true,
        failureReason: 'Managed runtime changed during status observation' });
      expect(client.sessions.messages).not.toHaveBeenCalled();
      await expect(executor.observe({ ...task, childSessionId: 'ses_child_v2' })).resolves.toMatchObject({ status: 'completed' });
      expect(client.sessions.status).toHaveBeenCalledTimes(2);
      expect(client.prompts.prompt).not.toHaveBeenCalled();
    } finally { release(); await executor.shutdown(); }
  });

  it('aborts with the scheduler signal (no extra budget) and with the request budget otherwise', async () => {
    const client = createFakeOpenCodeClient();
    const executor = createExecutor(client);
    const controller = new AbortController();
    const child = { taskId: 'dvr_task_v2_abort', childSessionId: 'ses_abort', directory: '/workspace', providerId: 'openai' };

    await expect(executor.abort(child, { signal: controller.signal })).resolves.toEqual({ aborted: true });
    expect(client.sessions.abort).toHaveBeenLastCalledWith('ses_abort', { directory: '/workspace', signal: controller.signal });

    await expect(executor.abort(child)).resolves.toEqual({ aborted: true });
    expect(client.sessions.abort).toHaveBeenLastCalledWith('ses_abort', { directory: '/workspace', timeoutMs: 10_000 });
  });

  it('removes a definitively unregistered child through the client', async () => {
    const client = createFakeOpenCodeClient();
    const executor = createExecutor(client, {
      registerExecutionChild: vi.fn(async () => {
        throw Object.assign(new Error('execution_reverted'), { code: 'execution_reverted' });
      }),
    });
    const control = { setChildSessionId: vi.fn(async () => true), markAccepted: vi.fn(async () => true) };

    await expect(executor.start(task, control)).rejects.toMatchObject({ code: 'execution_reverted' });
    expect(client.sessions.remove).toHaveBeenCalledWith('ses_child_v2',
      { directory: '/workspace', allowNotFound: true, timeoutMs: 10_000 });
    expect(client.prompts.prompt).not.toHaveBeenCalled();
  });

  it('aborts and deletes a child whose launch ownership was lost', async () => {
    const client = createFakeOpenCodeClient();
    const executor = createExecutor(client);

    await expect(executor.start({ ...task, dispatchCallId: undefined }, {
      async setChildSessionId() { return false; },
      async markAccepted() { throw new Error('must not accept'); },
    })).rejects.toThrow('lost launch ownership before provider prompt');
    expect(client.sessions.abort).toHaveBeenCalledWith('ses_child_v2', expect.objectContaining({ directory: '/workspace' }));
    expect(client.sessions.remove).toHaveBeenCalledWith('ses_child_v2',
      { directory: '/workspace', allowNotFound: true, timeoutMs: 10_000 });
  });

  it('surfaces client failures unchanged', async () => {
    const failure = Object.assign(new Error('sessions.create failed (503)'), { code: 'opencode_unavailable', statusCode: 503 });
    const client = createFakeOpenCodeClient({ sessions: { create: vi.fn(async () => { throw failure; }) } });
    const executor = createExecutor(client);

    await expect(executor.start(task, {
      async setChildSessionId() {},
      async markAccepted() {},
    })).rejects.toBe(failure);
  });

  it('reaches the 2.0.20 interrupt route through the real gen-2 client', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ interrupted: false });
    });
    const openCodeClient = createOpenCodeClient({
      getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:4097' }),
      getAuthHeaders: () => ({ authorization: 'Basic opaque' }),
      fetchImpl,
    });
    const executor = createExecutor(openCodeClient);

    await expect(executor.abort({ taskId: 'dvr_task_real_v2', childSessionId: 'ses_real_v2', directory: '/workspace',
      providerId: 'openai' })).resolves.toEqual({ aborted: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:4097/api/session/ses_real_v2/interrupt');
    expect(requests[0].init).toMatchObject({ method: 'POST', headers: { authorization: 'Basic opaque' } });
  });

  it.each([1, 3, null])('refuses unsupported runtime identity %s without any direct request', async (generation) => {
    const client = createFakeOpenCodeClient({ generation });
    const fetchImpl = vi.fn();
    const executor = createExecutor(client, { fetchImpl });
    await expect(executor.abort({ taskId: 'dvr_task_invalid_abort', childSessionId: 'ses_invalid', directory: '/workspace',
      providerId: 'openai' })).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.sessions.abort).not.toHaveBeenCalled();
  });

  it('refuses a missing native client without fetching', async () => {
    const fetchImpl = vi.fn();
    const executor = createNativeExecutor({ fetchImpl });
    await expect(executor.abort({ taskId: 'dvr_task_missing', childSessionId: 'ses_missing', directory: '/workspace',
      providerId: 'openai' })).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown generation instead of falling back to gen 1', async () => {
    const invalid = Object.assign(new Error('The OpenCode runtime generation is unknown'), { code: 'opencode_generation_invalid' });
    const client = createFakeOpenCodeClient({ generation: invalid });
    const fetchImpl = vi.fn();
    const executor = createExecutor(client, { fetchImpl });

    await expect(executor.start(task, {
      async setChildSessionId() {},
      async markAccepted() {},
    })).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.sessions.create).not.toHaveBeenCalled();
  });
});
