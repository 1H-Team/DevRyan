import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/plugin', () => {
  const makeSchema = () => {
    const schema = {
      describe: () => schema,
      optional: () => schema,
      int: () => schema,
      min: () => schema,
      max: () => schema,
    };
    return schema;
  };
  const mockTool = (definition) => definition;
  mockTool.schema = {
    boolean: makeSchema,
    enum: makeSchema,
    number: makeSchema,
    string: makeSchema,
  };
  return { tool: mockTool };
});

const { DevRyanManagedOrchestrationPlugin } = await import('./devryan-managed-orchestration.mjs');

const originalUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
const originalToken = process.env.DEVRYAN_ORCHESTRATION_TOKEN;

beforeEach(() => {
  process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:43210/rpc';
  process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'private-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.DEVRYAN_ORCHESTRATION_URL;
  else process.env.DEVRYAN_ORCHESTRATION_URL = originalUrl;
  if (originalToken === undefined) delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  else process.env.DEVRYAN_ORCHESTRATION_TOKEN = originalToken;
});

const context = (overrides = {}) => ({
  sessionID: 'ses_root',
  messageID: 'msg_parent',
  agent: 'orchestrator',
  directory: '/workspace',
  abort: new AbortController().signal,
  ...overrides,
});

const createToolOwnerClient = (records) => ({
  session: {
    messages: vi.fn(async () => ({ data: records })),
  },
});

const toolCallRecord = (callID, mode, overrides = {}) => ({
  info: {
    id: `msg_${callID}`,
    role: 'assistant',
    mode,
    parentID: `msg_user_${callID}`,
    ...overrides,
  },
  parts: [{
    id: `part_${callID}`,
    type: 'tool',
    callID,
    messageID: `msg_${callID}`,
  }],
});

describe('DevRyan managed orchestration plugin', () => {
  it('exposes one tool and derives root scope plus stable idempotency from context', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true,
        result: {
          task: { taskId: 'dvr_task_1', status: 'queued', rootSessionId: 'ses_root' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    expect(Object.keys(plugin.tool)).toEqual(['devryan_task']);
    expect(plugin.tool.devryan_task.description).toContain(
      'start it before any standalone todo read/write whose only purpose is to restate that delegation',
    );
    const args = {
      action: 'start',
      label: 'Inspect auth',
      prompt: 'Inspect authentication.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
      agent: 'explorer',
      timeout_seconds: 120,
    };

    const startedAt = Date.now();
    const first = await plugin.tool.devryan_task.execute(args, context());
    await plugin.tool.devryan_task.execute(args, context());

    expect(first).toContain('dvr_task_1');
    expect(first).not.toContain('private-token');
    expect(requests[0].url).toBe('http://127.0.0.1:43210/rpc');
    expect(requests[0].init.headers.authorization).toBe('Bearer private-token');
    expect(requests[0].body.method).toBe('submit');
    expect(requests[0].body.params).toMatchObject({
      rootSessionId: 'ses_root',
      dispatchGroupId: 'msg_parent',
      directory: '/workspace',
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      timeoutAt: expect.any(Number),
    });
    expect(requests[0].body.params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 1_800_000);
    expect(requests[0].body.params.timeoutAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(requests[1].body.params.idempotencyKey).toBe(requests[0].body.params.idempotencyKey);
  });

  it('defaults omitted deadlines to 30 minutes and caps requested deadlines at 24 hours', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    const startedAt = Date.now();

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Use the default deadline.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
    }, context());
    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Cap the requested deadline.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
      timeout_seconds: 90_000,
    }, context({ messageID: 'msg_second' }));

    expect(requests[0].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 1_800_000);
    expect(requests[0].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(requests[1].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 86_400_000);
    expect(requests[1].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it('requires wait before disposition and routes scoped control actions', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    for (const action of ['status', 'wait', 'cancel']) {
      await plugin.tool.devryan_task.execute({
        action,
        task_id: 'dvr_task_1',
      }, context());
    }
    await plugin.tool.devryan_task.execute({ action: 'retry', task_id: 'dvr_task_1' }, context());
    await expect(plugin.tool.devryan_task.execute({
      action: 'resume',
      task_id: 'dvr_task_2',
    }, context())).rejects.toThrow('wait for dvr_task_2');

    expect(requests.map((request) => request.method)).toEqual([
      'status',
      'wait',
      'cancel',
      'acknowledge',
    ]);
    expect(requests.every((request) => request.params.rootSessionId === 'ses_root')).toBe(true);
    expect(requests.every((request) => request.params.directory === '/workspace')).toBe(true);
    expect(requests.at(-1).params.action).toBe('retry');
  });

  it('requires continue after waiting for a successful result', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? { task: { taskId: 'dvr_task_1', status: 'completed' } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await plugin.tool.devryan_task.execute({ action: 'wait', task_id: 'dvr_task_1' }, context());
    await expect(plugin.tool.devryan_task.execute({
      action: 'retry',
      task_id: 'dvr_task_1',
    }, context())).rejects.toThrow('successful result requires continue');
    await plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_1',
    }, context());

    expect(requests.map(({ method }) => method)).toEqual(['wait', 'acknowledge']);
  });

  it('blocks same-response work until start is submitted, then rejects it while acknowledgement is pending', async () => {
    let resolveSubmit;
    const submitResponse = new Promise((resolve) => { resolveSubmit = resolve; });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'submit') return await submitResponse;
      if (request.method === 'barrier_status') {
        return new Response(JSON.stringify({
          ok: true,
          result: { state: 'awaiting_acknowledgement', taskIds: ['dvr_task_1'] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected RPC ${request.method}`);
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: createToolOwnerClient([toolCallRecord('call_read', 'orchestrator')]),
    });
    const startArgs = {
      action: 'start',
      agent: 'explorer',
      prompt: 'Inspect the task.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
    };
    await plugin['tool.execute.before'](
      { tool: 'devryan_task', sessionID: 'ses_root', callID: 'call_start' },
      { args: startArgs },
    );
    const starting = plugin.tool.devryan_task.execute(startArgs, context());
    const guardedWork = plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_root', callID: 'call_read' },
      { args: { filePath: '/workspace/src/math.ts' } },
    );

    await vi.waitFor(() => {
      expect(requests.map(({ method }) => method)).toEqual(['submit']);
    });
    resolveSubmit(new Response(JSON.stringify({
      ok: true,
      result: { task: { taskId: 'dvr_task_1', status: 'queued' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await starting;
    await expect(guardedWork).rejects.toThrow('dvr_task_1');
    expect(requests.map(({ method }) => method)).toEqual(['submit', 'barrier_status']);
  });

  it('keeps skill, managed-task, and todo controls available while a barrier is locked', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        ok: true,
        result: { state: 'awaiting_acknowledgement', taskIds: ['dvr_task_1'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    for (const toolName of ['skill', 'devryan_task', 'todowrite', 'todoread']) {
      await expect(plugin['tool.execute.before'](
        { tool: toolName, sessionID: 'ses_root', callID: `call_${toolName}` },
        { args: toolName === 'devryan_task' ? { action: 'status' } : {} },
      )).resolves.toBeUndefined();
    }
    expect(requests).toEqual([]);
  });

  it('allows Builder direct tools through a stale Orchestrator barrier using the matching tool-call record', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return new Response(JSON.stringify({
        ok: true,
        result: { state: 'active', taskIds: ['dvr_task_stale'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = createToolOwnerClient([
      toolCallRecord('call_builder', 'builder'),
      toolCallRecord('call_unrelated', 'orchestrator'),
    ]);
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await expect(plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_root', callID: 'call_builder' },
      { args: {} },
    )).resolves.toBeUndefined();
    await expect(plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_root', callID: 'call_builder' },
      { args: {} },
    )).resolves.toBeUndefined();

    expect(requests.map(({ method }) => method).every((method) => method === 'barrier_status')).toBe(true);
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: 'ses_root' },
      query: { limit: 20 },
    });
  });

  it('gates Orchestrator work and fails closed when the matching tool-call owner is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { state: 'awaiting_acknowledgement', taskIds: ['dvr_task_1'] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const records = [
      toolCallRecord('call_orchestrator', 'orchestrator'),
      toolCallRecord('call_other', 'builder'),
    ];
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: createToolOwnerClient(records),
    });

    await expect(plugin['tool.execute.before'](
      { tool: 'write', sessionID: 'ses_root', callID: 'call_orchestrator', agent: 'builder' },
      { args: {} },
    )).rejects.toThrow('dvr_task_1');
    await expect(plugin['tool.execute.before'](
      { tool: 'write', sessionID: 'ses_root', callID: 'call_missing', agent: 'builder' },
      { args: {} },
    )).rejects.toThrow('cannot establish invoking agent ownership');
  });

  it('allows direct work when no dispatch is known, but fails closed after a local barrier is known', async () => {
    const plugin = await DevRyanManagedOrchestrationPlugin();
    delete process.env.DEVRYAN_ORCHESTRATION_URL;

    await expect(plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_direct', callID: 'call_direct' },
      { args: {} },
    )).resolves.toBeUndefined();

    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:43210/rpc';
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'submit') {
        return new Response(JSON.stringify({
          ok: true,
          result: { task: { taskId: 'dvr_task_1', status: 'queued' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('bridge failed');
    }));
    const startArgs = {
      action: 'start',
      agent: 'explorer',
      prompt: 'Inspect the task.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
    };
    await plugin['tool.execute.before'](
      { tool: 'devryan_task', sessionID: 'ses_root', callID: 'call_start' },
      { args: startArgs },
    );
    await plugin.tool.devryan_task.execute(startArgs, context());

    await expect(plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_root', callID: 'call_blocked' },
      { args: {} },
    )).rejects.toThrow('cannot establish invoking agent ownership');
  });

  it('fails closed after discovering a recovered barrier', async () => {
    let barrierCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      expect(request.method).toBe('barrier_status');
      barrierCalls += 1;
      if (barrierCalls === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: { state: 'awaiting_acknowledgement', taskIds: ['dvr_task_recovered'] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('recovered bridge failed');
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: createToolOwnerClient([
        toolCallRecord('call_discover', 'orchestrator'),
        toolCallRecord('call_fail_closed', 'orchestrator'),
      ]),
    });

    await expect(plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_recovered', callID: 'call_discover' },
      { args: {} },
    )).rejects.toThrow('dvr_task_recovered');
    await expect(plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_recovered', callID: 'call_fail_closed' },
      { args: {} },
    )).rejects.toThrow('cannot verify the dispatch barrier');
  });

  it('resolves omitted provider and model from the authoritative agent catalog', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { task: { taskId: 'dvr_task_2' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [{
          name: 'explorer',
          model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
          variant: 'medium',
        }] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Locate the relevant files.',
    }, context());

    expect(client.app.agents).toHaveBeenCalledWith({ query: { directory: '/workspace' } });
    expect(requests[0].params).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'deepseek-v4-flash',
      variant: 'medium',
    });
  });

  it('keeps the configured agent model authoritative over explicit start and retry overrides', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [{
          name: 'fixer',
          model: { providerID: 'cursor-acp', modelID: 'grok-4.5' },
          variant: 'medium',
        }] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'fixer',
      prompt: 'Implement the feature.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context());
    await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_1',
    }, context());
    await plugin.tool.devryan_task.execute({
      action: 'retry',
      task_id: 'dvr_task_1',
      agent: 'fixer',
      provider_id: 'opencode',
      model_id: 'gpt-5.4',
    }, context());

    expect(requests[0].params).toMatchObject({
      providerId: 'cursor-acp',
      modelId: 'grok-4.5',
      agent: 'fixer',
      variant: 'medium',
    });
    expect(requests[2].params).toMatchObject({
      action: 'retry',
      providerId: 'cursor-acp',
      modelId: 'grok-4.5',
      agent: 'fixer',
      variant: 'medium',
    });
  });

  it('fails visibly when the bridge is unavailable or rejects a request', async () => {
    delete process.env.DEVRYAN_ORCHESTRATION_URL;
    const plugin = await DevRyanManagedOrchestrationPlugin();
    await expect(plugin.tool.devryan_task.execute({ action: 'status', task_id: 'dvr_task_1' }, context()))
      .rejects.toThrow('bridge is unavailable');

    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:43210/rpc';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'task_not_found', message: 'task was not found' },
    }), { status: 404, headers: { 'content-type': 'application/json' } })));
    await expect(plugin.tool.devryan_task.execute({ action: 'status', task_id: 'dvr_task_1' }, context()))
      .rejects.toThrow('task was not found');
  });
});
