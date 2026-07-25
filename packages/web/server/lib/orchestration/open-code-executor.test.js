import { describe, expect, it, vi } from 'vitest';

import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200,
  headers: { 'content-type': 'application/json' },
});

describe('web managed OpenCode executor transport', () => {
  it('uses the managed OpenCode HTTP contract with directory and auth isolation', async () => {
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
    const executor = createWebManagedOpenCodeExecutor({
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
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
      },
      parts: [{ type: 'text', text: 'Inspect the project.' }],
    });
    expect(requests.every((request) => request.init.headers.authorization === 'Basic opaque')).toBe(true);
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
        parts: [{ type: 'text', text: 'Implement the change.' }],
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
