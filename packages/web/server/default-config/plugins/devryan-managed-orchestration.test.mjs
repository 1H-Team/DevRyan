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
    const args = {
      action: 'start',
      label: 'Inspect auth',
      prompt: 'Inspect authentication.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
      agent: 'explorer',
      timeout_seconds: 120,
    };

    const first = await plugin.tool.devryan_task.execute(args, context());
    await plugin.tool.devryan_task.execute(args, context());

    expect(first).toContain('dvr_task_1');
    expect(first).not.toContain('private-token');
    expect(requests[0].url).toBe('http://127.0.0.1:43210/rpc');
    expect(requests[0].init.headers.authorization).toBe('Bearer private-token');
    expect(requests[0].body.method).toBe('submit');
    expect(requests[0].body.params).toMatchObject({
      rootSessionId: 'ses_root',
      directory: '/workspace',
      mode: 'orchestrator',
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      timeoutAt: expect.any(Number),
    });
    expect(requests[1].body.params.idempotencyKey).toBe(requests[0].body.params.idempotencyKey);
  });

  it('routes status, wait, cancel, retry, and resume through scoped RPC actions', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    for (const action of ['status', 'wait', 'cancel', 'retry', 'resume']) {
      await plugin.tool.devryan_task.execute({
        action,
        task_id: 'dvr_task_1',
      }, context());
    }

    expect(requests.map((request) => request.method)).toEqual([
      'status',
      'wait',
      'cancel',
      'acknowledge',
      'acknowledge',
    ]);
    expect(requests.every((request) => request.params.rootSessionId === 'ses_root')).toBe(true);
    expect(requests.every((request) => request.params.directory === '/workspace')).toBe(true);
    expect(requests.at(-2).params.action).toBe('retry');
    expect(requests.at(-1).params.action).toBe('resume');
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
    expect(requests[1].params).toMatchObject({
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
