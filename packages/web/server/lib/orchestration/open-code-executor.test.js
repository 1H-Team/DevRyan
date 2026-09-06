import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_CONTEXT_MODE_WRITABLE_PROMPT,
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
  MANAGED_TURN_BUDGET_PROMPT,
} from '@openchamber/orchestration-runtime';

import { createWebManagedOpenCodeExecutor } from './open-code-executor.js';

const WRITABLE_CONTEXT_MODE_TOOLS = Object.freeze({
  ctx_execute: true,
  mcp__context_mode__ctx_execute: true,
  ctx_execute_file: true,
  mcp__context_mode__ctx_execute_file: true,
  ctx_batch_execute: true,
  mcp__context_mode__ctx_batch_execute: true,
  ctx_index: true,
  mcp__context_mode__ctx_index: true,
  ctx_search: true,
  mcp__context_mode__ctx_search: true,
  ctx_stats: true,
  mcp__context_mode__ctx_stats: true,
  ctx_fetch_and_index: true,
  mcp__context_mode__ctx_fetch_and_index: true,
  ctx_purge: false,
  mcp__context_mode__ctx_purge: false,
  ctx_upgrade: false,
  mcp__context_mode__ctx_upgrade: false,
  ctx_insight: false,
  mcp__context_mode__ctx_insight: false,
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
      variant: '',
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        ...WRITABLE_CONTEXT_MODE_TOOLS,
        task: false,
      },
      parts: [{
        type: 'text',
        text: `${MANAGED_CONTEXT_MODE_WRITABLE_PROMPT}\n\nInspect the project.`,
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

  it('sends an idempotent same-child continuation after a terminal operation timeout', async () => {
    const requests = [];
    let statusReads = 0;
    const timeoutMessage = {
      info: {
        id: 'msg_timeout',
        role: 'assistant',
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
        const type = statusReads === 2 ? 'busy' : 'idle';
        return jsonResponse({ ses_child: { type } });
      }
      if (pathname.endsWith('/message')) {
        // The recovery message appears once the continuation prompt was sent,
        // rather than after a fixed number of transcript reads: a live child is
        // no longer re-read on every poll.
        const continued = requests.some(({ url: sent }) => (
          new URL(sent).pathname.endsWith('/prompt_async')
        ));
        return jsonResponse(!continued
          ? [timeoutMessage]
          : [
              timeoutMessage,
              {
                info: { id: 'msg_done', role: 'assistant', finish: 'stop' },
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
      childSessionId: 'ses_child',
      directory: '/workspace',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'fixer',
      variant: 'high',
    });

    expect(result.status).toBe('completed');
    const promptRequests = requests.filter(({ url }) => (
      new URL(url).pathname.endsWith('/prompt_async')
    ));
    expect(promptRequests).toHaveLength(1);
    const continuationBody = JSON.parse(promptRequests[0].init.body);
    expect(continuationBody).toMatchObject({
      agent: 'fixer',
      model: { providerID: 'github-copilot', modelID: 'gpt-4.1' },
      variant: 'high',
      tools: {
        'resend_*': false,
        'mcp__resend__*': false,
        ...WRITABLE_CONTEXT_MODE_TOOLS,
        task: false,
      },
      parts: [{ type: 'text', text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT }],
    });
    // OpenCode must mint the id. A task-derived one is not ordered like an
    // OpenCode id, and a continuation that sorts below the session's latest
    // message is written into the past and silently never runs.
    expect(continuationBody).not.toHaveProperty('messageID');
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
      `Contract.\n\n${MANAGED_CONTEXT_MODE_WRITABLE_PROMPT}\n\nInspect the project.`,
      MANAGED_TURN_BUDGET_PROMPT,
    ]);
  });
});
