import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/plugin', () => {
  const makeSchema = () => {
    const schema = {
      description: null,
      describe: (description) => {
        schema.description = description;
        return schema;
      },
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
    expect(plugin.tool.devryan_task.description).toContain(
      'A queued, starting, or running wait result is a live polling snapshot',
    );
    expect(plugin.tool.devryan_task.description).toContain(
      'does not impose a managed concurrency cap',
    );
    expect(plugin.tool.devryan_task.args.timeout_seconds.description).toContain(
      'use at least 3600 for multi-file implementation plus tests',
    );
    expect(plugin.tool.devryan_task.args.timeout_seconds.description).toContain(
      'enforced 3600 minimum for Oracle',
    );
    expect(plugin.tool.devryan_task.args.timeout_seconds.description).toContain(
      '7200 when the child also owns builds or browser verification',
    );
    expect(plugin.tool.devryan_task.args.action.description).toContain(
      'Provider usage-limit recovery is handled by the user-facing Model Recovery controls',
    );
    expect(plugin.tool.devryan_task.args.action.description).not.toContain('recover_in_place');
    expect(plugin.tool.devryan_task.args.provider_id.description).toContain(
      'when no runtime agent catalog is available',
    );
    expect(plugin.tool.devryan_task.args.provider_id.description).toContain(
      'Supply together with model_id',
    );
    expect(plugin.tool.devryan_task.args.model_id.description).toContain(
      'configured agent settings are authoritative',
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

  it('defaults omitted deadlines to 30 minutes, enforces 60 minutes for Oracle, and caps at 24 hours', async () => {
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
    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'oracle',
      prompt: 'Review within the Oracle deadline floor.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
      timeout_seconds: 1_800,
    }, context({ messageID: 'msg_third' }));

    expect(requests[0].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 1_800_000);
    expect(requests[0].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(requests[1].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 86_400_000);
    expect(requests[1].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
    expect(requests[2].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 3_600_000);
    expect(requests[2].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('requires wait before disposition and routes scoped control actions', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? { task: { taskId: 'dvr_task_1', status: 'failed' } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
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
    expect(requests.find((request) => request.method === 'wait').params.waitTimeoutMs).toBe(25_000);
    expect(requests.at(-1).params.action).toBe('retry');
  });

  it('keeps live wait snapshots uncollected until a repeated wait returns terminal', async () => {
    const requests = [];
    const statuses = ['queued', 'starting', 'running', 'failed'];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const status = request.method === 'wait' ? statuses.shift() : null;
      const result = status
        ? { task: { taskId: 'dvr_task_live', status } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    for (const expectedStatus of ['queued', 'starting', 'running']) {
      const output = await plugin.tool.devryan_task.execute({
        action: 'wait',
        task_id: 'dvr_task_live',
      }, context());
      expect(JSON.parse(output).task.status).toBe(expectedStatus);
      await expect(plugin.tool.devryan_task.execute({
        action: 'abandon',
        task_id: 'dvr_task_live',
      }, context())).rejects.toThrow('wait for dvr_task_live');
    }

    await plugin.tool.devryan_task.execute({ action: 'wait', task_id: 'dvr_task_live' }, context());
    await plugin.tool.devryan_task.execute({ action: 'abandon', task_id: 'dvr_task_live' }, context());

    expect(requests.map(({ method }) => method)).toEqual(['wait', 'wait', 'wait', 'wait', 'acknowledge']);
    expect(requests.filter(({ method }) => method === 'wait').every(
      ({ params }) => params.waitTimeoutMs === 25_000,
    )).toBe(true);
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

  it('serializes a terminal managed result payload only once for the parent model', async () => {
    const recoverablePreview = `<results>${'x'.repeat(4_096)}</results>`;
    const canonicalRefs = [{ type: 'message', id: 'msg_child' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        task: {
          taskId: 'dvr_task_1',
          status: 'completed',
          partial: false,
          failureReason: null,
          recoverablePreview,
          canonicalRefs,
        },
        resultEnvelope: {
          taskId: 'dvr_task_1',
          status: 'completed',
          partial: false,
          failureReason: null,
          recoverablePreview,
          canonicalRefs,
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_1',
    }, context());
    const parsed = JSON.parse(output);

    expect(output.split(recoverablePreview)).toHaveLength(2);
    expect(parsed.task).not.toHaveProperty('recoverablePreview');
    expect(parsed.task).not.toHaveProperty('failureReason');
    expect(parsed.task).not.toHaveProperty('canonicalRefs');
    expect(parsed.task).toMatchObject({ taskId: 'dvr_task_1', status: 'completed' });
    expect(parsed.resultEnvelope).toMatchObject({
      taskId: 'dvr_task_1',
      recoverablePreview,
      canonicalRefs,
    });
  });

  it('compacts nested results without hiding divergent task payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        tasks: [
          {
            task: {
              taskId: 'dvr_task_matching',
              status: 'failed',
              failureReason: 'matching failure',
              recoverablePreview: 'matching preview',
              canonicalRefs: [],
            },
            resultEnvelope: {
              taskId: 'dvr_task_matching',
              status: 'failed',
              failureReason: 'matching failure',
              recoverablePreview: 'matching preview',
              canonicalRefs: [],
            },
          },
          {
            task: {
              taskId: 'dvr_task_divergent',
              status: 'failed',
              failureReason: 'task failure',
              recoverablePreview: 'task preview',
              canonicalRefs: [],
            },
            resultEnvelope: {
              taskId: 'dvr_task_divergent',
              status: 'failed',
              failureReason: 'envelope failure',
              recoverablePreview: 'envelope preview',
              canonicalRefs: [],
            },
          },
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'cancel',
      task_id: 'dvr_task_matching',
      cascade: true,
    }, context());
    const parsed = JSON.parse(output);

    expect(parsed.tasks[0].task).not.toHaveProperty('failureReason');
    expect(parsed.tasks[0].task).not.toHaveProperty('recoverablePreview');
    expect(parsed.tasks[0].task).not.toHaveProperty('canonicalRefs');
    expect(parsed.tasks[1].task).toMatchObject({
      failureReason: 'task failure',
      recoverablePreview: 'task preview',
    });
    expect(parsed.tasks[1].task).not.toHaveProperty('canonicalRefs');
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

  it('releases an abandoned pending start only when its session becomes idle', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      expect(request.method).toBe('barrier_status');
      return new Response(JSON.stringify({
        ok: true,
        result: { state: 'clear', taskIds: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    const startArgs = {
      action: 'start',
      agent: 'explorer',
      prompt: 'This start is abandoned by a later pre-execution hook.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
    };

    await plugin['tool.execute.before'](
      { tool: 'devryan_task', sessionID: 'ses_root', callID: 'call_abandoned_start' },
      { args: startArgs },
    );
    const guardedWork = plugin['tool.execute.before'](
      { tool: 'read', sessionID: 'ses_root', callID: 'call_after_abandoned_start' },
      { args: { filePath: '/workspace/src/math.ts' } },
    );

    await Promise.resolve();
    expect(requests).toEqual([]);
    plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_unrelated' } },
    });
    await Promise.resolve();
    expect(requests).toEqual([]);

    plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_root' } },
    });

    await expect(guardedWork).resolves.toBeUndefined();
    expect(requests.map(({ method }) => method)).toEqual(['barrier_status']);
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

  it('blocks provider-native task for Orchestrator before child or scheduler work', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = createToolOwnerClient([
      toolCallRecord('call_native_task', 'orchestrator'),
    ]);
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await expect(plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_root', callID: 'call_native_task' },
      { args: { subagent_type: 'explorer' } },
    )).rejects.toThrow('must use devryan_task');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.session.messages).toHaveBeenCalledTimes(1);
  });

  it('leaves provider-native task unchanged for non-Orchestrator agents', async () => {
    const client = createToolOwnerClient([
      toolCallRecord('call_builder_task', 'builder'),
      toolCallRecord('call_custom_task', 'primary', { agent: 'project-agent' }),
    ]);
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await expect(plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_root', callID: 'call_builder_task' },
      { args: { subagent_type: 'explorer' } },
    )).resolves.toBeUndefined();
    await expect(plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_root', callID: 'call_custom_task' },
      { args: { subagent_type: 'project-child' } },
    )).resolves.toBeUndefined();
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
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? { task: { taskId: 'dvr_task_1', status: 'failed' } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
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

  it('ignores either partial start override when the configured agent model is available', async () => {
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
          name: 'designer',
          model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
          variant: 'high',
        }] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Review the first interface.',
      model_id: 'gpt-5.4',
    }, context());
    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Review the second interface.',
      provider_id: 'openai',
    }, context({ messageID: 'msg_second' }));

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.params).toMatchObject({
        providerId: 'anthropic',
        modelId: 'claude-opus-5',
        agent: 'designer',
        variant: 'high',
      });
    }
  });

  it('requires paired compatibility fallback IDs only when the agent catalog is unavailable', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Review with a partial model fallback.',
      model_id: 'claude-opus-5',
    }, context())).rejects.toThrow('provider_id and model_id must be supplied together');
    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Review with a partial provider fallback.',
      provider_id: 'anthropic',
    }, context())).rejects.toThrow('provider_id and model_id must be supplied together');
    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Review with a complete compatibility fallback.',
      provider_id: 'anthropic',
      model_id: 'claude-opus-5',
      variant: 'high',
    }, context({ messageID: 'msg_complete' }));

    expect(requests).toHaveLength(1);
    expect(requests[0].params).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      variant: 'high',
    });
  });

  it('does not bypass an available catalog when the configured agent model is incomplete', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [{
          name: 'designer',
          model: { providerID: 'anthropic' },
        }] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Do not bypass the configured agent.',
      provider_id: 'openai',
      model_id: 'gpt-5.4',
    }, context())).rejects.toThrow('Managed agent designer has no executable model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the parent wait through user-facing Model Recovery and returns the recovered result', async () => {
    const requests = [];
    let recoveredWaitCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      let result;
      if (request.method === 'wait' && request.params.taskId === 'dvr_task_limited') {
        result = {
          task: {
            taskId: 'dvr_task_limited',
            status: 'failed',
            childSessionId: 'ses_designer',
            failureKind: 'provider_usage_limit',
          },
        };
      } else if (request.method === 'wait_result_action') {
        result = {
          resultEnvelope: {
            taskId: 'dvr_task_limited',
            action: 'retry_in_place',
            followUpTaskId: 'dvr_task_recovered',
          },
          followUpTask: {
            task: {
              taskId: 'dvr_task_recovered',
              status: 'running',
              childSessionId: 'ses_designer',
            },
          },
        };
      } else if (request.method === 'wait' && request.params.taskId === 'dvr_task_recovered') {
        recoveredWaitCount += 1;
        result = {
          task: {
            taskId: 'dvr_task_recovered',
            status: recoveredWaitCount === 1 ? 'running' : 'completed',
            childSessionId: 'ses_designer',
            recoverablePreview: recoveredWaitCount === 1 ? null : 'Recovered result',
          },
        };
      } else {
        result = { accepted: true };
      }
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_limited',
    }, context());
    const parsed = JSON.parse(output);

    expect(parsed.task).toMatchObject({
      taskId: 'dvr_task_recovered',
      status: 'completed',
      childSessionId: 'ses_designer',
      recoverablePreview: 'Recovered result',
    });
    expect(output).not.toContain('provider_usage_limit');
    await expect(plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_limited',
    }, context())).rejects.toThrow('wait for dvr_task_limited');
    await plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_recovered',
    }, context());

    expect(requests.map(({ method }) => method)).toEqual([
      'wait',
      'wait_result_action',
      'wait',
      'wait',
      'acknowledge',
    ]);
    expect(requests.slice(1, 4).map(({ params }) => params.taskId)).toEqual([
      'dvr_task_limited',
      'dvr_task_recovered',
      'dvr_task_recovered',
    ]);
    expect(requests.slice(2, 4).every(
      ({ params }) => params.waitTimeoutMs === 25_000,
    )).toBe(true);
    await expect(plugin.tool.devryan_task.execute({
      action: 'recover_in_place',
      task_id: 'dvr_task_limited',
    }, context())).rejects.toThrow('Unsupported managed task action');
  });

  it('wakes an idle parent exactly once after a detached provider-recovery wait', async () => {
    const scheduled = [];
    const records = [{
      info: {
        id: 'msg_parent_user',
        role: 'user',
        agent: 'orchestrator',
        model: {
          providerID: 'openai',
          modelID: 'gpt-5.6',
          variant: 'xhigh',
        },
      },
      parts: [{ type: 'text', text: 'Review the project.' }],
    }];
    const client = {
      session: {
        messages: vi.fn(async () => ({ data: records })),
        status: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async (request) => {
          records.push({
            info: {
              id: request.body.messageID,
              role: 'user',
              agent: request.body.agent,
              model: {
                ...request.body.model,
                variant: request.body.variant,
              },
            },
            parts: request.body.parts,
          });
          return { data: true };
        }),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      expect(request.method).toBe('list_provider_recovery_continuations');
      return new Response(JSON.stringify({
        ok: true,
        result: {
          continuations: [{
            sourceTaskId: 'dvr_task_limited',
            taskId: 'dvr_task_recovered',
            rootSessionId: 'ses_root',
            childSessionId: 'ses_oracle',
            directory: '/workspace',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client,
      scheduleTimeout(callback) {
        scheduled.push(callback);
        return { unref() {} };
      },
    });

    expect(scheduled).toHaveLength(1);
    scheduled.shift()();
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_root' },
      query: { directory: '/workspace' },
      body: {
        // No explicit messageID: OpenCode must mint an ordered one, or the wake
        // can sort below the session's latest message and never be processed.
        agent: 'orchestrator',
        model: {
          providerID: 'openai',
          modelID: 'gpt-5.6',
        },
        variant: 'xhigh',
        parts: [{
          type: 'text',
          synthetic: true,
          text: expect.stringContaining(
            '[devryan-provider-recovery:v1:dvr_task_recovered]',
          ),
        }],
      },
    }, { throwOnError: false });

    plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_root' },
      },
    });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('does not re-send a wake that is not yet visible in the parent transcript', async () => {
    const scheduled = [];
    const records = [{
      info: {
        id: 'msg_user',
        role: 'user',
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-5.6', variant: 'xhigh' },
      },
      parts: [{ type: 'text', text: 'Review the project.' }],
    }];
    // A real wake is accepted well before session.messages can observe it. The
    // marker check therefore cannot deduplicate the settle-retry scan, which is
    // how the same wake was sent twice and left the parent with a message it
    // never answered.
    const client = {
      session: {
        messages: vi.fn(async () => ({ data: records })),
        status: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async () => ({ data: true })),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        continuations: [{
          sourceTaskId: 'dvr_task_limited',
          taskId: 'dvr_task_recovered',
          rootSessionId: 'ses_root',
          childSessionId: 'ses_oracle',
          directory: '/workspace',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client,
      scheduleTimeout(callback) {
        scheduled.push(callback);
        return { unref() {} };
      },
    });

    expect(scheduled).toHaveLength(1);
    scheduled.shift()();
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));

    plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_root' } },
    });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // fetch resolves well before a wake would be sent, so let the second scan
    // drain fully before asserting; otherwise a re-send is simply not observed
    // yet and the assertion passes for the wrong reason.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning briefly when an idle edge arrives before recovery is durably terminal', async () => {
    const scheduled = [];
    const records = [{
      info: {
        id: 'msg_parent_user',
        role: 'user',
        agent: 'orchestrator',
        model: {
          providerID: 'openai',
          modelID: 'gpt-5.6',
          variant: 'high',
        },
      },
      parts: [{ type: 'text', text: 'Delegate a visual review.' }],
    }];
    const client = {
      session: {
        messages: vi.fn(async () => ({ data: records })),
        status: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async (request) => {
          records.push({
            info: {
              id: request.body.messageID,
              role: 'user',
              agent: request.body.agent,
              model: request.body.model,
            },
            parts: request.body.parts,
          });
          return { data: true };
        }),
      },
    };
    let scanCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      scanCount += 1;
      const continuations = scanCount < 3
        ? []
        : [{
            sourceTaskId: 'dvr_task_limited',
            taskId: 'dvr_task_recovered',
            rootSessionId: 'ses_root',
            childSessionId: 'ses_designer',
            directory: '/workspace',
          }];
      return new Response(JSON.stringify({
        ok: true,
        result: { continuations },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client,
      scheduleTimeout(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return { unref() {} };
      },
    });

    // The startup scan can happen arbitrarily long before the user chooses a
    // recovery model, so it must not own the later settlement window.
    scheduled.shift().callback();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toEqual([]);

    plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_designer' },
      },
    });
    expect(scheduled[0].delayMs).toBe(500);
    scheduled.shift().callback();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(client.session.promptAsync).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(scheduled[0].delayMs).toBe(1_000);
    scheduled.shift().callback();
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(3);

    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift().callback();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toEqual([]);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('does not drop an idle recovery trigger while a scan is in flight', async () => {
    const scheduled = [];
    let resolveFirstScan;
    const firstScan = new Promise((resolve) => {
      resolveFirstScan = resolve;
    });
    const client = {
      session: {
        messages: vi.fn(async () => ({
          data: [{
            info: {
              id: 'msg_parent_user',
              role: 'user',
              agent: 'orchestrator',
              model: {
                providerID: 'openai',
                modelID: 'gpt-5.6',
              },
            },
            parts: [{ type: 'text', text: 'Delegate a review.' }],
          }],
        })),
        status: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async () => ({ data: true })),
      },
    };
    let scanCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      scanCount += 1;
      if (scanCount === 1) return await firstScan;
      return new Response(JSON.stringify({
        ok: true,
        result: {
          continuations: [{
            sourceTaskId: 'dvr_task_limited',
            taskId: 'dvr_task_recovered',
            rootSessionId: 'ses_root',
            childSessionId: 'ses_oracle',
            directory: '/workspace',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client,
      scheduleTimeout(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return { unref() {} };
      },
    });

    scheduled.shift().callback();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_oracle' },
      },
    });

    resolveFirstScan(new Response(JSON.stringify({
      ok: true,
      result: { continuations: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));

    expect(scheduled[0].delayMs).toBe(1_000);
    scheduled.shift().callback();
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
  });

  it('leaves the live parent wait in control while the root session is busy', async () => {
    const scheduled = [];
    const client = {
      session: {
        messages: vi.fn(async () => ({ data: [] })),
        status: vi.fn(async () => ({
          data: { ses_root: { type: 'busy' } },
        })),
        promptAsync: vi.fn(async () => ({ data: true })),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        continuations: [{
          sourceTaskId: 'dvr_task_limited',
          taskId: 'dvr_task_recovered',
          rootSessionId: 'ses_root',
          childSessionId: 'ses_oracle',
          directory: '/workspace',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await DevRyanManagedOrchestrationPlugin({
      client,
      scheduleTimeout(callback) {
        scheduled.push(callback);
        return { unref() {} };
      },
    });

    scheduled.shift()();
    await vi.waitFor(() => expect(client.session.status).toHaveBeenCalledTimes(1));
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
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
