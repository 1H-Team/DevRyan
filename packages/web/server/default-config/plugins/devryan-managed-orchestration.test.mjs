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
const originalAccountDefaults = process.env.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS;
const originalResultMode = process.env.DEVRYAN_MANAGED_RESULT_MODE;

beforeEach(() => {
  process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:43210/rpc';
  process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'private-token';
  delete process.env.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS;
  delete process.env.DEVRYAN_MANAGED_RESULT_MODE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.DEVRYAN_ORCHESTRATION_URL;
  else process.env.DEVRYAN_ORCHESTRATION_URL = originalUrl;
  if (originalToken === undefined) delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  else process.env.DEVRYAN_ORCHESTRATION_TOKEN = originalToken;
  if (originalAccountDefaults === undefined) delete process.env.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS;
  else process.env.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS = originalAccountDefaults;
  if (originalResultMode === undefined) delete process.env.DEVRYAN_MANAGED_RESULT_MODE;
  else process.env.DEVRYAN_MANAGED_RESULT_MODE = originalResultMode;
});

const context = (overrides = {}) => ({
  sessionID: 'ses_root',
  messageID: 'msg_parent',
  agent: 'orchestrator',
  directory: '/workspace',
  abort: new AbortController().signal,
  ...overrides,
});

const rpcResponse = (result, status = 200) => new Response(JSON.stringify({
  ok: status >= 200 && status < 300,
  ...(status >= 200 && status < 300 ? { result } : { error: result }),
}), { status, headers: { 'content-type': 'application/json' } });

const healthyRootSnapshot = (overrides = {}) => ({
  available: true,
  bridgeReady: true,
  recoveryWarning: null,
  tasks: [],
  resultEnvelopes: [],
  ...overrides,
});

const collectableTaskResult = (taskId, overrides = {}) => ({
  task: { taskId, status: 'completed' },
  resultEnvelope: { taskId, action: null },
  ...overrides,
});

const createToolOwnerClient = (records) => ({
  session: {
    messages: vi.fn(async () => ({ data: [
      ...records,
      {
        info: { id: 'msg_user_parent', role: 'user' },
        parts: [{ type: 'text', text: 'Proceed normally.' }],
      },
      {
        info: { id: 'msg_parent', role: 'assistant', parentID: 'msg_user_parent' },
        parts: [],
      },
    ] })),
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
  it('rejects Designer from the exact parent plan turn before RPC submission', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = {
      session: {
        messages: vi.fn(async () => ({ data: [
          {
            info: {
              id: 'msg_user_plan',
              role: 'user',
            },
            parts: [{
              type: 'text',
              text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
              synthetic: true,
            }],
          },
          {
            info: { id: 'msg_parent', role: 'assistant', parentID: 'msg_user_plan' },
            parts: [],
          },
        ] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Inspect the interface without changing it.',
      provider_id: 'anthropic',
      model_id: 'claude-opus-4-5',
    }, context())).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED',
      statusCode: 409,
    });

    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: 'ses_root' },
      query: { directory: '/workspace', limit: 100 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the adjacent persisted same-turn assistant when the in-flight assistant is not visible yet', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        ok: true,
        result: { task: { taskId: 'dvr_task_adjacent_parent' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = {
      session: {
        messages: vi.fn(async () => ({ data: [
          {
            info: { id: 'msg_001', role: 'user', mode: 'plan' },
            parts: [{ type: 'text', text: 'Inspect only.' }],
          },
          {
            info: {
              id: 'msg_002',
              role: 'assistant',
              parentID: 'msg_001',
              providerID: 'openai',
              modelID: 'gpt-5.6-sol',
              variant: 'xhigh',
            },
            parts: [],
          },
        ] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    const output = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Inspect the implementation.',
      provider_id: 'cursor-acp',
      model_id: 'composer-2.5',
    }, context({ messageID: 'msg_003' })));

    expect(requests[0].params).toMatchObject({
      readOnly: true,
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
    expect(output.executionNotice).toContain('from the parent Orchestrator');
  });

  it.each(['fixer', 'oracle'])('resolves %s policy by exact message ids after the parent leaves the list window', async (agent) => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return rpcResponse({ task: { taskId: `dvr_task_${agent}` } });
    }));
    const client = {
      session: {
        message: vi.fn(async ({ path }) => {
          if (path.messageID === 'msg_parent') {
            return { data: {
              info: {
                id: 'msg_parent',
                sessionID: 'ses_root',
                role: 'assistant',
                parentID: 'msg_user_older_than_window',
                providerID: 'openai',
                modelID: 'gpt-5.6-sol',
              },
              parts: [],
            } };
          }
          return { data: {
            info: {
              id: 'msg_user_older_than_window',
              sessionID: 'ses_root',
              role: 'user',
              mode: 'plan',
            },
            parts: [{ type: 'text', text: 'Inspect this read-only.' }],
          } };
        }),
        messages: vi.fn(async () => ({ data: Array.from({ length: 100 }, (_, index) => ({
          info: {
            id: `msg_assistant_${index.toString().padStart(3, '0')}`,
            role: 'assistant',
            parentID: 'msg_user_older_than_window',
          },
          parts: [],
        })) })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent,
      prompt: 'Review the bounded target.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context());

    expect(client.session.message).toHaveBeenNthCalledWith(1, {
      path: { id: 'ses_root', messageID: 'msg_parent' },
      query: { directory: '/workspace' },
    });
    expect(client.session.message).toHaveBeenNthCalledWith(2, {
      path: { id: 'ses_root', messageID: 'msg_user_older_than_window' },
      query: { directory: '/workspace' },
    });
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(requests[0].params).toMatchObject({ agent, readOnly: true });
    expect(requests[0].params.timeoutAt).toBeGreaterThan(Date.now() + 59 * 60 * 1_000);
  });

  it('uses the bounded adjacent-assistant fallback only when the exact assistant is not persisted', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return rpcResponse({ task: { taskId: 'dvr_task_adjacent_direct_parent' } });
    }));
    const client = {
      session: {
        message: vi.fn(async ({ path }) => {
          if (path.messageID === 'msg_003') {
            return { error: { status: 404 }, response: { status: 404 } };
          }
          return { data: {
            info: { id: 'msg_001', sessionID: 'ses_root', role: 'user', mode: 'plan' },
            parts: [{ type: 'text', text: 'Inspect only.' }],
          } };
        }),
        messages: vi.fn(async () => ({ data: [{
          info: {
            id: 'msg_002',
            role: 'assistant',
            parentID: 'msg_001',
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
          },
          parts: [],
        }] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Inspect the implementation.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context({ messageID: 'msg_003' }));

    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(requests[0].params).toMatchObject({ readOnly: true });
  });

  it('fails closed when direct message identity does not match the requested assistant', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: {
        session: {
          message: vi.fn(async () => ({ data: {
            info: { id: 'msg_other', sessionID: 'ses_root', role: 'assistant', parentID: 'msg_user' },
            parts: [],
          } })),
        },
      },
    });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'oracle',
      prompt: 'Review the target.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context())).rejects.toThrow('Cannot verify the invoking assistant');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the direct parent response mismatches the assistant parent relationship', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: {
        session: {
          message: vi.fn(async ({ path }) => ({ data: path.messageID === 'msg_parent'
            ? {
                info: {
                  id: 'msg_parent',
                  sessionID: 'ses_root',
                  role: 'assistant',
                  parentID: 'msg_user',
                },
                parts: [],
              }
            : {
                info: { id: 'msg_other_user', sessionID: 'ses_root', role: 'user' },
                parts: [],
              } })),
        },
      },
    });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'fixer',
      prompt: 'Implement the bounded fix.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context())).rejects.toThrow('Cannot verify the parent turn');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the direct parent is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: {
        session: {
          message: vi.fn(async ({ path }) => (
            path.messageID === 'msg_parent'
              ? { data: {
                  info: {
                    id: 'msg_parent',
                    sessionID: 'ses_root',
                    role: 'assistant',
                    parentID: 'msg_user',
                  },
                  parts: [],
                } }
              : { error: { status: 404 }, response: { status: 404 } }
          )),
        },
      },
    });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'oracle',
      prompt: 'Review the bounded fix.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context())).rejects.toThrow('Cannot verify the parent turn');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed with a precise diagnostic when direct message transport fails', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: {
        session: {
          message: vi.fn(async () => {
            throw new Error('connection reset');
          }),
        },
      },
    });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'oracle',
      prompt: 'Review the bounded fix.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
    }, context())).rejects.toThrow('Cannot load managed-dispatch message msg_parent: connection reset');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still submits Designer implementation work from a normal parent turn', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { task: { taskId: 'dvr_task_designer' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: createToolOwnerClient([]),
    });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Implement the approved interface brief and verify it visually.',
      provider_id: 'anthropic',
      model_id: 'claude-opus-4-5',
    }, context());

    expect(requests[0].params).toMatchObject({
      agent: 'designer',
      readOnly: false,
    });
  });

  it('routes a Cursor specialist plan task through the non-Cursor parent execution', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return new Response(JSON.stringify({
        ok: true,
        result: {
          task: {
            taskId: 'dvr_task_parent_fallback',
            providerId: request.params.providerId,
            modelId: request.params.modelId,
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [
          {
            name: 'explorer',
            model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
            variant: 'medium',
          },
          {
            name: 'plan',
            model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
            variant: 'high',
          },
        ] })),
      },
      session: {
        messages: vi.fn(async () => ({ data: [
          {
            info: {
              id: 'msg_user_plan',
              role: 'user',
              model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
            },
            parts: [{
              type: 'text',
              text: 'User has requested to enter plan mode.\nInspect only.',
              synthetic: true,
            }],
          },
          {
            info: {
              id: 'msg_parent',
              role: 'assistant',
              parentID: 'msg_user_plan',
              providerID: 'openai',
              modelID: 'gpt-5.6-sol',
            },
            parts: [],
          },
        ] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    const output = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Map the relevant implementation.',
    }, context()));

    expect(requests[0].params).toMatchObject({
      readOnly: true,
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: 'xhigh',
      agent: 'explorer',
    });
    expect(output.executionNotice).toContain('from the parent Orchestrator');
    expect(output.executionNotice).toContain('cursor-acp/composer-2.5');
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(client.app.agents).toHaveBeenCalledTimes(1);
  });

  it('uses the configured Plan agent when the parent and specialist both use Cursor', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return new Response(JSON.stringify({
        ok: true,
        result: { task: { taskId: 'dvr_task_plan_fallback' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [
          {
            name: 'explorer',
            model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
          },
          {
            name: 'plan',
            model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
            variant: 'high',
          },
        ] })),
      },
      session: {
        messages: vi.fn(async () => ({ data: [
          {
            info: { id: 'msg_user_plan', role: 'user', mode: 'plan' },
            parts: [{ type: 'text', text: 'Plan this work.' }],
          },
          {
            info: {
              id: 'msg_parent',
              role: 'assistant',
              parentID: 'msg_user_plan',
              providerID: 'cursor-acp',
              modelID: 'composer-2.5',
            },
            parts: [],
          },
        ] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    const output = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Inspect the architecture.',
    }, context()));

    expect(requests[0].params).toMatchObject({
      readOnly: true,
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      variant: 'high',
    });
    expect(output.executionNotice).toContain('from the configured Plan agent');
  });

  it('rejects an incompatible plan task before submission when no plan-safe model exists', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [
          {
            name: 'explorer',
            model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
          },
          {
            name: 'plan',
            model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
          },
        ] })),
      },
      session: {
        messages: vi.fn(async () => ({ data: [
          {
            info: { id: 'msg_user_plan', role: 'user', mode: 'plan' },
            parts: [{ type: 'text', text: 'Plan this work.' }],
          },
          {
            info: {
              id: 'msg_parent',
              role: 'assistant',
              parentID: 'msg_user_plan',
              providerID: 'cursor-acp',
              modelID: 'composer-2.5',
            },
            parts: [],
          },
        ] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'explorer',
      prompt: 'Inspect the architecture.',
    }, context())).rejects.toMatchObject({
      code: 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED',
      statusCode: 409,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing records', []],
    ['first step without a persisted assistant sibling', [
      { info: { id: 'msg_001', role: 'user' }, parts: [] },
    ]],
    ['a conflicting assistant parent', [
      { info: { id: 'msg_001', role: 'user' }, parts: [] },
      {
        info: {
          id: 'msg_002',
          role: 'assistant',
          parentID: 'msg_other',
          providerID: 'openai',
          modelID: 'gpt-5.6-sol',
        },
        parts: [],
      },
    ]],
    ['records newer than the in-flight assistant', [
      { info: { id: 'msg_004', role: 'user' }, parts: [] },
      {
        info: {
          id: 'msg_005',
          role: 'assistant',
          parentID: 'msg_004',
          providerID: 'openai',
          modelID: 'gpt-5.6-sol',
        },
        parts: [],
      },
    ]],
  ])('fails closed without RPC submission for %s', async (_case, records) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const plugin = await DevRyanManagedOrchestrationPlugin({
      client: {
        session: { messages: vi.fn(async () => ({ data: records })) },
      },
    });

    await expect(plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'designer',
      prompt: 'Inspect the interface.',
      provider_id: 'anthropic',
      model_id: 'claude-opus-4-5',
    }, context({ messageID: 'msg_003' }))).rejects.toThrow('Cannot verify the parent turn');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

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
      'keeps each wait call attached while repeating bounded polling slices internally',
    );
    expect(plugin.tool.devryan_task.description).toContain(
      'does not impose a managed concurrency cap',
    );
    expect(plugin.tool.devryan_task.args.timeout_seconds.description).toContain(
      'Defaults to 3600 for Fixer and Oracle',
    );
    expect(plugin.tool.devryan_task.args.timeout_seconds.description).toContain(
      '1800 for other ordinary specialists',
    );
    expect(plugin.tool.devryan_task.args.timeout_seconds.description).toContain(
      '7200 when a closed task also owns builds or browser verification',
    );
    expect(plugin.tool.devryan_task.args.action.description).toContain(
      'A resumable failure with no agent retry remaining returns manualRecoveryRequired',
    );
    expect(plugin.tool.devryan_task.args.action.description).toContain(
      'Wait stays attached only until the requested task is terminal',
    );
    expect(plugin.tool.devryan_task.args.action.description).toContain(
      'use status for a non-blocking live snapshot',
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
      readOnly: false,
      providerId: 'github-copilot',
      modelId: 'gpt-4.1',
      agent: 'explorer',
      resultMode: 'reference',
      timeoutAt: expect.any(Number),
    });
    expect(requests[0].body.params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 1_800_000);
    expect(requests[0].body.params.timeoutAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(requests[1].body.params.idempotencyKey).toBe(requests[0].body.params.idempotencyKey);
  });

  it('defaults ordinary deadlines to 30 minutes, enforces 60 minutes for Fixer and Oracle, and caps at 24 hours', async () => {
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
      agent: 'fixer',
      prompt: 'Fix within the Fixer deadline floor.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-luna',
      timeout_seconds: 1_800,
    }, context({ messageID: 'msg_third' }));
    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'oracle',
      prompt: 'Review within the Oracle deadline floor.',
      provider_id: 'openai',
      model_id: 'gpt-5.6-sol',
      timeout_seconds: 1_800,
    }, context({ messageID: 'msg_fourth' }));

    expect(requests[0].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 1_800_000);
    expect(requests[0].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(requests[1].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 86_400_000);
    expect(requests[1].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
    expect(requests[2].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 3_600_000);
    expect(requests[2].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(requests[3].params.timeoutAt).toBeGreaterThanOrEqual(startedAt + 3_600_000);
    expect(requests[3].params.timeoutAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('clamps an explicit Fixer recovery window to 60 minutes', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? { task: { taskId: 'dvr_task_fixer_recovery', status: 'failed' } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_fixer_recovery',
    }, context());
    await plugin.tool.devryan_task.execute({
      action: 'retry',
      task_id: 'dvr_task_fixer_recovery',
      agent: 'fixer',
      timeout_seconds: 1_800,
    }, context());

    expect(requests[1]).toMatchObject({
      method: 'acknowledge',
      params: { action: 'retry', agent: 'fixer', timeoutSeconds: 3_600 },
    });
  });

  it('forwards timeout_seconds when retrying or resuming an existing task', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? { task: { taskId: 'dvr_task_long_recovery', status: 'failed' } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_long_recovery',
    }, context());
    await plugin.tool.devryan_task.execute({
      action: 'resume',
      task_id: 'dvr_task_long_recovery',
      timeout_seconds: 7_200,
    }, context());

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      method: 'acknowledge',
      params: {
        taskId: 'dvr_task_long_recovery',
        action: 'resume',
        timeoutSeconds: 7_200,
      },
    });
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
      'status',
    ]);
    expect(requests.every((request) => request.params.rootSessionId === 'ses_root')).toBe(true);
    expect(requests.every((request) => request.params.directory === '/workspace')).toBe(true);
    expect(requests.every((request) => request.params.resultMode === 'reference')).toBe(true);
    expect(requests.find((request) => request.method === 'wait').params.waitTimeoutMs).toBe(25_000);
    expect(requests.find((request) => request.method === 'acknowledge').params.action).toBe('retry');
  });

  it.each(['status', 'wait', 'continue'])(
    'recovers a compacted task reference during %s when the root snapshot is healthy and clear',
    async (action) => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const request = JSON.parse(init.body);
        requests.push(request);
        if (request.method === 'snapshot') return rpcResponse(healthyRootSnapshot());
        if (request.method === 'barrier_status') {
          return rpcResponse({ state: 'clear', taskIds: [] });
        }
        return rpcResponse({ code: 'task_not_found', message: 'task was compacted' }, 404);
      }));
      const plugin = await DevRyanManagedOrchestrationPlugin();

      const output = JSON.parse(await plugin.tool.devryan_task.execute({
        action,
        task_id: 'dvr_task_compacted',
      }, context()));

      expect(output).toEqual({
        state: 'stale_task_reference',
        taskId: 'dvr_task_compacted',
        dispositionRequired: false,
        instruction: expect.stringContaining('without restarting'),
      });
      expect(requests.map(({ method }) => method)).toEqual([
        action === 'continue' ? 'status' : action,
        'snapshot',
        'barrier_status',
      ]);
      expect(requests.map(({ method }) => method)).not.toContain('submit');
      expect(requests.map(({ method }) => method)).not.toContain('acknowledge');
    },
  );

  it.each([
    ['active', ['dvr_task_live_a', 'dvr_task_live_b'], 'active managed tasks'],
    ['awaiting_acknowledgement', ['dvr_task_pending'], 'awaiting acknowledgement'],
  ])('keeps a missing reference blocked behind the authoritative %s barrier', async (
    barrierState,
    taskIds,
    expectedMessage,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const { method } = JSON.parse(init.body);
      if (method === 'snapshot') return rpcResponse(healthyRootSnapshot());
      if (method === 'barrier_status') return rpcResponse({ state: barrierState, taskIds });
      return rpcResponse({ code: 'task_not_found', message: 'task was compacted' }, 404);
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await expect(plugin.tool.devryan_task.execute({
      action: 'status',
      task_id: 'dvr_task_stale',
    }, context())).rejects.toThrow(expectedMessage);
    await expect(plugin.tool.devryan_task.execute({
      action: 'status',
      task_id: 'dvr_task_stale',
    }, context())).rejects.toThrow(taskIds.join(', '));
  });

  it.each([
    [
      'a recovery warning',
      (method) => method === 'snapshot'
        ? rpcResponse(healthyRootSnapshot({ recoveryWarning: 'ledger quarantined' }))
        : rpcResponse({ code: 'task_not_found', message: 'task was compacted' }, 404),
      'recovery warning',
    ],
    [
      'a snapshot bridge failure',
      (method) => method === 'snapshot'
        ? rpcResponse({ code: 'bridge_unavailable', message: 'bridge refresh failed' }, 503)
        : rpcResponse({ code: 'task_not_found', message: 'task was compacted' }, 404),
      'bridge refresh failed',
    ],
    [
      'a malformed barrier',
      (method) => method === 'snapshot'
        ? rpcResponse(healthyRootSnapshot())
        : method === 'barrier_status'
          ? rpcResponse({ state: 'clear' })
          : rpcResponse({ code: 'task_not_found', message: 'task was compacted' }, 404),
      'barrier status is malformed',
    ],
  ])('fails closed for a missing task when root verification has %s', async (
    _label,
    respond,
    expectedMessage,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const { method } = JSON.parse(init.body);
      return respond(method);
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const request = plugin.tool.devryan_task.execute({
      action: 'status',
      task_id: 'dvr_task_stale',
    }, context());
    await expect(request).rejects.toMatchObject({ code: 'task_not_found' });
    await expect(request).rejects.toThrow(expectedMessage);
  });

  it('recognizes an already-dispositioned retained task after plugin restart', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'status') {
        return rpcResponse({
          task: { taskId: 'dvr_task_retained', status: 'completed' },
          resultEnvelope: {
            taskId: 'dvr_task_retained',
            action: 'continue',
            acknowledgedAt: 123,
          },
        });
      }
      if (request.method === 'snapshot') {
        return rpcResponse(healthyRootSnapshot({
          tasks: [{ taskId: 'dvr_task_retained', status: 'completed' }],
          resultEnvelopes: [{ taskId: 'dvr_task_retained', action: 'continue' }],
        }));
      }
      if (request.method === 'barrier_status') {
        return rpcResponse({ state: 'clear', taskIds: [] });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_retained',
    }, context()));

    expect(output).toMatchObject({
      state: 'already_dispositioned',
      dispositionRequired: false,
      barrier: { state: 'clear', taskIds: [] },
      resultEnvelope: { action: 'continue' },
    });
    expect(requests.map(({ method }) => method)).toEqual([
      'status',
      'snapshot',
      'barrier_status',
    ]);
  });

  it.each(['continue', 'retry', 'resume', 'abandon'])(
    'evicts the collected-result cache after successful %s',
    async (action) => {
      const requests = [];
      let acknowledged = false;
      const terminalStatus = action === 'continue' ? 'completed' : 'failed';
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const request = JSON.parse(init.body);
        requests.push(request);
        if (request.method === 'wait') {
          return rpcResponse({
            task: { taskId: 'dvr_task_disposed', status: terminalStatus },
            resultEnvelope: { taskId: 'dvr_task_disposed', action: null },
          });
        }
        if (request.method === 'acknowledge') {
          acknowledged = true;
          return rpcResponse({
            resultEnvelope: { taskId: 'dvr_task_disposed', action },
            followUpTask: null,
          });
        }
        if (request.method === 'status') {
          return rpcResponse({
            task: { taskId: 'dvr_task_disposed', status: terminalStatus },
            resultEnvelope: {
              taskId: 'dvr_task_disposed',
              action: acknowledged ? action : null,
            },
          });
        }
        if (request.method === 'snapshot') return rpcResponse(healthyRootSnapshot());
        if (request.method === 'barrier_status') {
          return rpcResponse({ state: 'clear', taskIds: [] });
        }
        throw new Error(`Unexpected RPC method: ${request.method}`);
      }));
      const plugin = await DevRyanManagedOrchestrationPlugin();

      await plugin.tool.devryan_task.execute({
        action: 'wait',
        task_id: 'dvr_task_disposed',
      }, context());
      await plugin.tool.devryan_task.execute({
        action,
        task_id: 'dvr_task_disposed',
      }, context());
      const repeated = JSON.parse(await plugin.tool.devryan_task.execute({
        action,
        task_id: 'dvr_task_disposed',
      }, context()));

      expect(repeated.state).toBe('already_dispositioned');
      expect(requests.filter(({ method }) => method === 'acknowledge')).toHaveLength(1);
      expect(requests.map(({ method }) => method)).toEqual([
        'wait',
        'acknowledge',
        'status',
        'snapshot',
        'barrier_status',
      ]);
    },
  );

  it('keeps one wait attached across live polling slices until terminal', async () => {
    const requests = [];
    const statuses = ['queued', 'starting', 'running', 'completed'];
    let releaseTerminal;
    const terminalGate = new Promise((resolve) => {
      releaseTerminal = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const status = request.method === 'wait' ? statuses.shift() : null;
      if (status === 'completed') await terminalGate;
      const result = status
        ? { task: { taskId: 'dvr_task_live', status } }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    let settled = false;
    const wait = plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_live',
    }, context()).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(settled).toBe(false);

    releaseTerminal();
    expect(JSON.parse(await wait).task.status).toBe('completed');
    await plugin.tool.devryan_task.execute({ action: 'continue', task_id: 'dvr_task_live' }, context());

    expect(requests.map(({ method }) => method)).toEqual(['wait', 'wait', 'wait', 'wait', 'acknowledge']);
    expect(requests.filter(({ method }) => method === 'wait').every(
      ({ params }) => params.waitTimeoutMs === 25_000,
    )).toBe(true);
  });

  it('rejects an unrecognized live wait status instead of polling forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { task: { taskId: 'dvr_task_invalid', status: 'paused' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await expect(plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_invalid',
    }, context())).rejects.toThrow('invalid task status: paused');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts an attached wait without collecting a live snapshot', async () => {
    const controller = new AbortController();
    let markSecondWaitStarted;
    const secondWaitStarted = new Promise((resolve) => {
      markSecondWaitStarted = resolve;
    });
    let waitCallCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'status') {
        return rpcResponse({ task: { taskId: 'dvr_task_abort', status: 'running' } });
      }
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: { task: { taskId: 'dvr_task_abort', status: 'running' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      markSecondWaitStarted();
      return await new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(init.signal.reason ?? new Error('aborted'));
        if (init.signal.aborted) rejectAbort();
        else init.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    const wait = plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_abort',
    }, context({ abort: controller.signal }));
    const rejection = expect(wait).rejects.toThrow('stop requested');

    await secondWaitStarted;
    controller.abort(new Error('stop requested'));
    await rejection;
    await expect(plugin.tool.devryan_task.execute({
      action: 'abandon',
      task_id: 'dvr_task_abort',
    }, context())).rejects.toThrow('wait for dvr_task_abort');
    expect(waitCallCount).toBe(2);
  });

  it('waits for concurrent children independently until both are terminal', async () => {
    const requests = [];
    const statusesByTask = new Map([
      ['dvr_task_alpha', ['running', 'completed']],
      ['dvr_task_beta', ['queued', 'running', 'completed']],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method !== 'wait') {
        return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const status = statusesByTask.get(request.params.taskId)?.shift();
      return new Response(JSON.stringify({
        ok: true,
        result: { task: { taskId: request.params.taskId, status } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const [alpha, beta] = await Promise.all([
      plugin.tool.devryan_task.execute({ action: 'wait', task_id: 'dvr_task_alpha' }, context()),
      plugin.tool.devryan_task.execute({ action: 'wait', task_id: 'dvr_task_beta' }, context()),
    ]);
    expect(JSON.parse(alpha).task.status).toBe('completed');
    expect(JSON.parse(beta).task.status).toBe('completed');
    await Promise.all([
      plugin.tool.devryan_task.execute({ action: 'continue', task_id: 'dvr_task_alpha' }, context()),
      plugin.tool.devryan_task.execute({ action: 'continue', task_id: 'dvr_task_beta' }, context()),
    ]);

    const waitRequests = requests.filter(({ method }) => method === 'wait');
    expect(waitRequests).toHaveLength(5);
    expect(waitRequests.every(({ params }) => params.waitTimeoutMs === 25_000)).toBe(true);
    expect(requests.filter(({ method }) => method === 'acknowledge')).toHaveLength(2);
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
    const incompatible = plugin.tool.devryan_task.execute({
      action: 'retry',
      task_id: 'dvr_task_1',
    }, context());
    await expect(incompatible).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: {
        taskId: 'dvr_task_1',
        state: 'completed',
        receivedAction: 'retry',
        requiredAction: 'continue',
      },
    });
    await expect(incompatible).rejects.toThrow(
      'Required next action: {"action":"continue","task_id":"dvr_task_1"}',
    );
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

  it('reads reference pages sequentially without acknowledging or advancing on invalid pages', async () => {
    const requests = [];
    let rejectFinalPageOnce = true;
    const initialReference = {
      taskId: 'dvr_task_paged',
      envelopeId: 'dvr_result_paged_1',
      totalBytes: 17_000,
      text: 'a'.repeat(8_192),
      returnedBytes: 8_192,
      nextCursor: 'cursor-page-2',
      complete: false,
    };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'wait') {
        return rpcResponse({
          task: { taskId: 'dvr_task_paged', status: 'completed' },
          resultEnvelope: {
            taskId: 'dvr_task_paged',
            envelopeId: 'dvr_result_paged_1',
            action: null,
          },
          resultReference: initialReference,
        });
      }
      if (request.method === 'read_result' && request.params.resultCursor === 'cursor-page-2') {
        return rpcResponse({ resultReference: {
          ...initialReference,
          text: 'b'.repeat(8_192),
          returnedBytes: 16_384,
          nextCursor: 'cursor-page-3',
        } });
      }
      if (request.method === 'read_result' && request.params.resultCursor === 'cursor-page-3') {
        if (rejectFinalPageOnce) {
          rejectFinalPageOnce = false;
          return rpcResponse({ code: 'invalid_result_cursor', message: 'temporary cursor rejection' }, 400);
        }
        return rpcResponse({ resultReference: {
          ...initialReference,
          text: 'c'.repeat(616),
          returnedBytes: 17_000,
          nextCursor: null,
          complete: true,
        } });
      }
      if (request.method === 'acknowledge') {
        return rpcResponse({
          resultEnvelope: { taskId: 'dvr_task_paged', action: 'continue' },
          followUpTask: null,
        });
      }
      throw new Error(`Unexpected request ${request.method}`);
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await expect(plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-2',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'wait_required' },
    });

    const waited = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_paged',
    }, context()));
    expect(waited.resultReference).toEqual(initialReference);
    expect(requests[0].params.resultMode).toBe('reference');

    await expect(plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-3',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'result_cursor_mismatch' },
    });
    const second = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-2',
    }, context()));
    expect(second.resultReference).toMatchObject({
      returnedBytes: 16_384,
      nextCursor: 'cursor-page-3',
    });
    await expect(plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-2',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'result_cursor_mismatch' },
    });

    await expect(plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-3',
    }, context())).rejects.toMatchObject({ code: 'invalid_result_cursor' });
    const finalPage = JSON.parse(await plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-3',
    }, context()));
    expect(finalPage.resultReference).toMatchObject({
      returnedBytes: 17_000,
      nextCursor: null,
      complete: true,
    });
    await expect(plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_paged',
      result_cursor: 'cursor-page-3',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'result_complete' },
    });

    expect(requests.map(({ method }) => method)).toEqual([
      'wait',
      'read_result',
      'read_result',
      'read_result',
    ]);
    expect(requests.filter(({ method }) => method === 'read_result').every(
      ({ params }) => !Object.hasOwn(params, 'resultMode'),
    )).toBe(true);
    expect(requests.map(({ method }) => method)).not.toContain('barrier_status');
    expect(requests.map(({ method }) => method)).not.toContain('acknowledge');

    await plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_paged',
    }, context());
    expect(requests.at(-1)).toMatchObject({
      method: 'acknowledge',
      params: { resultMode: 'reference', action: 'continue' },
    });
  });

  it.each([
    [
      'premature completion',
      {
        task: { taskId: 'dvr_task_malformed_page', status: 'completed' },
        resultEnvelope: {
          taskId: 'dvr_task_malformed_page',
          envelopeId: 'dvr_result_malformed_page_1',
          action: null,
        },
        resultReference: {
          taskId: 'dvr_task_malformed_page',
          envelopeId: 'dvr_result_malformed_page_1',
          totalBytes: 9_000,
          text: 'a'.repeat(8_192),
          returnedBytes: 8_192,
          nextCursor: null,
          complete: true,
        },
      },
    ],
    [
      'a missing envelope identity',
      {
        task: { taskId: 'dvr_task_malformed_page', status: 'completed' },
        resultEnvelope: { taskId: 'dvr_task_malformed_page', action: null },
        resultReference: {
          taskId: 'dvr_task_malformed_page',
          envelopeId: 'dvr_result_malformed_page_1',
          totalBytes: 9_000,
          text: 'a'.repeat(8_192),
          returnedBytes: 8_192,
          nextCursor: 'cursor-page-2',
          complete: false,
        },
      },
    ],
  ])('rejects reference pages with %s and does not cache them', async (_label, result) => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse(result)));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    await expect(plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_malformed_page',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'invalid_result_page' },
    });
    await expect(plugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: 'dvr_task_malformed_page',
      result_cursor: 'cursor-page-2',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'wait_required' },
    });
  });

  it('requires another terminal wait after plugin restart before paging retained output', async () => {
    const requests = [];
    const initialReference = {
      taskId: 'dvr_task_restart_page',
      envelopeId: 'dvr_result_restart_page_1',
      totalBytes: 9_000,
      text: 'a'.repeat(8_192),
      returnedBytes: 8_192,
      nextCursor: 'restart-cursor',
      complete: false,
    };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'wait') {
        return rpcResponse({
          task: { taskId: initialReference.taskId, status: 'failed' },
          resultEnvelope: {
            taskId: initialReference.taskId,
            envelopeId: initialReference.envelopeId,
            action: null,
          },
          resultReference: initialReference,
        });
      }
      if (request.method === 'read_result') {
        return rpcResponse({ resultReference: {
          ...initialReference,
          text: 'b'.repeat(808),
          returnedBytes: 9_000,
          nextCursor: null,
          complete: true,
        } });
      }
      throw new Error(`Unexpected request ${request.method}`);
    }));
    const firstPlugin = await DevRyanManagedOrchestrationPlugin();
    await firstPlugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: initialReference.taskId,
    }, context());

    const restartedPlugin = await DevRyanManagedOrchestrationPlugin();
    await expect(restartedPlugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: initialReference.taskId,
      result_cursor: 'restart-cursor',
    }, context())).rejects.toMatchObject({
      code: 'DEVRYAN_TOOL_INPUT_INVALID',
      details: { state: 'wait_required' },
    });
    await restartedPlugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: initialReference.taskId,
    }, context());
    await expect(restartedPlugin.tool.devryan_task.execute({
      action: 'read_result',
      task_id: initialReference.taskId,
      result_cursor: 'restart-cursor',
    }, context())).resolves.toContain('"complete": true');
    expect(requests.map(({ method }) => method)).toEqual(['wait', 'wait', 'read_result']);
  });

  it('keeps exact eager mode serialization and omits the resultMode RPC parameter', async () => {
    process.env.DEVRYAN_MANAGED_RESULT_MODE = 'eager';
    const recoverablePreview = `eager:${'x'.repeat(9_000)}`;
    const canonicalRefs = [{ type: 'message', id: 'msg_eager' }];
    const requests = [];
    const response = {
      task: {
        taskId: 'dvr_task_eager',
        status: 'completed',
        partial: false,
        failureReason: null,
        recoverablePreview,
        canonicalRefs,
      },
      resultEnvelope: {
        taskId: 'dvr_task_eager',
        envelopeId: 'dvr_result_eager_1',
        status: 'completed',
        partial: false,
        failureReason: null,
        recoverablePreview,
        canonicalRefs,
        action: null,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'wait') return rpcResponse(response);
      if (request.method === 'acknowledge') {
        return rpcResponse({
          resultEnvelope: { ...response.resultEnvelope, action: 'continue' },
          followUpTask: null,
        });
      }
      throw new Error(`Unexpected request ${request.method}`);
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_eager',
    }, context());
    expect(output).toBe(JSON.stringify({
      task: {
        taskId: 'dvr_task_eager',
        status: 'completed',
        partial: false,
      },
      resultEnvelope: response.resultEnvelope,
    }, null, 2));
    await plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_eager',
    }, context());
    expect(requests.every(({ params }) => !Object.hasOwn(params, 'resultMode'))).toBe(true);
  });

  it('captures the exact eager override at plugin startup and applies changes only after restart', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return rpcResponse({ task: { taskId: request.params.taskId, status: 'running' } });
    }));

    process.env.DEVRYAN_MANAGED_RESULT_MODE = 'eager';
    const eagerPlugin = await DevRyanManagedOrchestrationPlugin();
    delete process.env.DEVRYAN_MANAGED_RESULT_MODE;
    await eagerPlugin.tool.devryan_task.execute({
      action: 'status',
      task_id: 'dvr_task_eager_startup',
    }, context());

    const referencePlugin = await DevRyanManagedOrchestrationPlugin();
    await referencePlugin.tool.devryan_task.execute({
      action: 'status',
      task_id: 'dvr_task_reference_restart',
    }, context());

    process.env.DEVRYAN_MANAGED_RESULT_MODE = 'EAGER';
    const exactValuePlugin = await DevRyanManagedOrchestrationPlugin();
    await exactValuePlugin.tool.devryan_task.execute({
      action: 'status',
      task_id: 'dvr_task_uppercase_override',
    }, context());

    expect(requests.map(({ params }) => params.resultMode)).toEqual([
      undefined,
      'reference',
      'reference',
    ]);
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
    expect(requests[0].params.dispatchCallId).toBe('call_start');
    resolveSubmit(new Response(JSON.stringify({
      ok: true,
      result: { task: { taskId: 'dvr_task_1', status: 'queued' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await starting;
    await expect(guardedWork).rejects.toThrow('dvr_task_1');
    expect(requests.map(({ method }) => method)).toEqual(['submit', 'barrier_status']);
  });

  it('correlates parallel starts to their exact call ids even when execution order reverses', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return new Response(JSON.stringify({
        ok: true,
        result: { task: { taskId: `dvr_task_${request.params.dispatchCallId}` } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();
    const explorerArgs = {
      action: 'start',
      agent: 'explorer',
      label: 'Inspect runtime',
      prompt: 'Inspect the runtime.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
    };
    const designerArgs = {
      action: 'start',
      agent: 'designer',
      label: 'Inspect layout',
      prompt: 'Inspect the layout.',
      provider_id: 'github-copilot',
      model_id: 'gpt-4.1',
    };

    await plugin['tool.execute.before'](
      { tool: 'devryan_task', sessionID: 'ses_root', callID: 'call_explorer' },
      { args: explorerArgs },
    );
    await plugin['tool.execute.before'](
      { tool: 'devryan_task', sessionID: 'ses_root', callID: 'call_designer' },
      { args: designerArgs },
    );

    await plugin.tool.devryan_task.execute(designerArgs, context());
    await plugin.tool.devryan_task.execute(explorerArgs, context());

    expect(requests.map(({ params }) => params.dispatchCallId)).toEqual([
      'call_designer',
      'call_explorer',
    ]);
    expect(requests[0].params.idempotencyKey).not.toBe(requests[1].params.idempotencyKey);
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

  it('resolves the root-session owner account default before submitting a child task', async () => {
    process.env.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS = '1';
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'resolve_agent_execution') {
        return rpcResponse({
          providerId: 'anthropic',
          modelId: 'claude-sonnet-4-6',
          variant: 'high',
          source: 'personal',
        });
      }
      return rpcResponse({ task: { taskId: 'dvr_task_owner_default' } });
    }));
    const client = {
      app: {
        agents: vi.fn(async () => ({ data: [{
          name: 'Orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
          variant: 'medium',
        }] })),
      },
    };
    const plugin = await DevRyanManagedOrchestrationPlugin({ client });

    await plugin.tool.devryan_task.execute({
      action: 'start',
      agent: 'orchestrator',
      prompt: 'Coordinate the bounded implementation.',
    }, context());

    expect(requests.map((request) => request.method)).toEqual(['resolve_agent_execution', 'submit']);
    expect(requests[0].params).toMatchObject({
      rootSessionId: 'ses_root',
      directory: '/workspace',
      agent: 'orchestrator',
      fallbackExecution: {
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'medium',
      },
    });
    expect(requests[1].params).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      variant: 'high',
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

  it('returns provider Model Recovery immediately without holding the parent tool call', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait' && request.params.taskId === 'dvr_task_limited'
        ? {
          task: {
            taskId: 'dvr_task_limited',
            status: 'failed',
            childSessionId: 'ses_designer',
            mode: 'orchestrator',
            attempt: 1,
            agentRetryAvailable: false,
            failureKind: 'provider_usage_limit',
          },
          resultEnvelope: {
            taskId: 'dvr_task_limited',
            action: null,
            resumable: true,
          },
        }
        : { accepted: true };
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

    expect(parsed).toMatchObject({
      manualRecoveryRequired: true,
      manualRecoveryInstruction: expect.stringContaining('awaiting user action'),
      task: {
        taskId: 'dvr_task_limited',
        status: 'failed',
        childSessionId: 'ses_designer',
        failureKind: 'provider_usage_limit',
      },
      resultEnvelope: {
        taskId: 'dvr_task_limited',
        action: null,
        resumable: true,
      },
    });
    await expect(plugin.tool.devryan_task.execute({
      action: 'continue',
      task_id: 'dvr_task_limited',
    }, context())).rejects.toThrow('Manual model recovery requires');
    expect(requests.map(({ method }) => method)).toEqual(['wait']);
    await expect(plugin.tool.devryan_task.execute({
      action: 'recover_in_place',
      task_id: 'dvr_task_limited',
    }, context())).rejects.toThrow('Unsupported managed task action');
  });

  it('returns exhausted provider prompt rejection for agent disposition without Model Recovery', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? {
            task: {
              taskId: 'dvr_task_prompt_rejected',
              status: 'failed',
              childSessionId: 'ses_fixer_retry',
              mode: 'orchestrator',
              attempt: 2,
              agentRetryAvailable: false,
              failureKind: 'provider_prompt_rejected',
            },
            resultEnvelope: {
              taskId: 'dvr_task_prompt_rejected',
              action: null,
              resumable: true,
            },
          }
        : { task: { taskId: 'dvr_task_prompt_rejected' }, resultEnvelope: { action: 'abandon' } };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_prompt_rejected',
    }, context());
    expect(JSON.parse(output).task).toMatchObject({
      failureKind: 'provider_prompt_rejected',
      agentRetryAvailable: false,
    });

    await plugin.tool.devryan_task.execute({
      action: 'abandon',
      task_id: 'dvr_task_prompt_rejected',
    }, context());
    expect(requests.map(({ method }) => method)).toEqual(['wait', 'acknowledge']);
  });

  it('returns manual Model Recovery immediately after a grouped agent retry is exhausted', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const result = request.method === 'wait'
        ? {
            task: {
              taskId: 'dvr_task_fixer_attempt_2',
              status: 'failed',
              childSessionId: 'ses_fixer',
              mode: 'orchestrator',
              dispatchGrouped: true,
              attempt: 2,
              agentRetryAvailable: false,
              failureKind: null,
            },
            resultEnvelope: {
              taskId: 'dvr_task_fixer_attempt_2',
              action: null,
              resumable: true,
            },
          }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_fixer_attempt_2',
    }, context());

    expect(JSON.parse(output)).toMatchObject({
      manualRecoveryRequired: true,
      task: {
        taskId: 'dvr_task_fixer_attempt_2',
        status: 'failed',
        childSessionId: 'ses_fixer',
      },
      resultEnvelope: {
        taskId: 'dvr_task_fixer_attempt_2',
        action: null,
        resumable: true,
      },
    });
    expect(requests.map(({ method }) => method)).toEqual(['wait']);
  });

  it('wakes an idle parent exactly once after any detached terminal wait', async () => {
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
      if (request.method === 'status') {
        return rpcResponse(collectableTaskResult('dvr_task_completed'));
      }
      expect(request.method).toBe('list_provider_recovery_continuations');
      return rpcResponse({
          continuations: [{
            sourceTaskId: null,
            taskId: 'dvr_task_completed',
            rootSessionId: 'ses_root',
            childSessionId: 'ses_explorer',
            directory: '/workspace',
            kind: 'collect',
          }],
      });
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
            '[devryan-provider-recovery:v1:dvr_task_completed]',
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
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('does not claim manual Model Recovery for an ungrouped orchestrator retry', async () => {
    // The scheduler only parks grouped dispatches; without this the plugin told the user
    // to use a Model Recovery card that the UI never renders.
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      const result = request.method === 'wait'
        ? {
            task: {
              taskId: 'dvr_task_ungrouped_attempt_2',
              status: 'failed',
              childSessionId: 'ses_ungrouped',
              mode: 'orchestrator',
              dispatchGrouped: false,
              attempt: 2,
              agentRetryAvailable: false,
              failureKind: null,
            },
            resultEnvelope: {
              taskId: 'dvr_task_ungrouped_attempt_2',
              action: null,
              resumable: true,
            },
          }
        : { accepted: true };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const plugin = await DevRyanManagedOrchestrationPlugin();

    const output = await plugin.tool.devryan_task.execute({
      action: 'wait',
      task_id: 'dvr_task_ungrouped_attempt_2',
    }, context());

    expect(JSON.parse(output).manualRecoveryRequired).toBeUndefined();
  });

  const parkedContinuation = (taskId, childSessionId) => ({
    sourceTaskId: `${taskId}_source`,
    taskId,
    rootSessionId: 'ses_root',
    childSessionId,
    directory: '/workspace',
    kind: 'manual_recovery',
    label: 'Designer',
    failureReason: 'Monthly usage limit reached',
    failureKind: 'provider_usage_limit',
  });

  const scanParkedContinuations = async (continuations) => {
    const scheduled = [];
    const methods = [];
    const client = {
      session: {
        messages: vi.fn(async () => ({
          data: [{
            info: {
              id: 'msg_parent_user',
              role: 'user',
              agent: 'orchestrator',
              model: { providerID: 'openai', modelID: 'gpt-5.6', variant: 'xhigh' },
            },
            parts: [{ type: 'text', text: 'Ship the release blockers.' }],
          }],
        })),
        status: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async () => ({ data: true })),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      methods.push(request.method);
      return new Response(JSON.stringify({
        ok: true,
        result: { continuations },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await DevRyanManagedOrchestrationPlugin({
      client,
      scheduleTimeout(callback) {
        scheduled.push(callback);
        return { unref() {} };
      },
    });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return { client, methods };
  };

  it('does not inject a parked-notice turn for one or more parked tasks', async () => {
    const { client, methods } = await scanParkedContinuations([
      parkedContinuation('dvr_task_parked_a', 'ses_designer_a'),
      parkedContinuation('dvr_task_parked_b', 'ses_designer_b'),
    ]);

    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(methods).toEqual(['list_provider_recovery_continuations']);
    expect(methods).not.toContain('acknowledge');
  });

  it('ignores a leftover manual_recovery RPC entry instead of collecting it', async () => {
    const { client, methods } = await scanParkedContinuations([
      parkedContinuation('dvr_task_parked', 'ses_designer'),
    ]);

    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(methods).not.toContain('acknowledge');
    expect(methods).not.toContain('wait');
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
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'status') {
        return rpcResponse(collectableTaskResult('dvr_task_recovered'));
      }
      return rpcResponse({
        continuations: [{
          sourceTaskId: 'dvr_task_limited',
          taskId: 'dvr_task_recovered',
          rootSessionId: 'ses_root',
          childSessionId: 'ses_oracle',
          directory: '/workspace',
          kind: 'collect',
        }],
      });
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

    plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_root' } },
    });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
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
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'status') {
        return rpcResponse(collectableTaskResult('dvr_task_recovered'));
      }
      scanCount += 1;
      const continuations = scanCount < 3
        ? []
        : [{
            sourceTaskId: 'dvr_task_limited',
            taskId: 'dvr_task_recovered',
            rootSessionId: 'ses_root',
            childSessionId: 'ses_designer',
            directory: '/workspace',
            kind: 'collect',
          }];
      return rpcResponse({ continuations });
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
    expect(scanCount).toBe(3);

    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift().callback();
    await vi.waitFor(() => expect(scanCount).toBe(4));
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
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'status') {
        return rpcResponse(collectableTaskResult('dvr_task_recovered'));
      }
      scanCount += 1;
      if (scanCount === 1) return await firstScan;
      return rpcResponse({
          continuations: [{
            sourceTaskId: 'dvr_task_limited',
            taskId: 'dvr_task_recovered',
            rootSessionId: 'ses_root',
            childSessionId: 'ses_oracle',
            directory: '/workspace',
            kind: 'collect',
          }],
      });
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

  it.each(['already_dispositioned', 'task_compacted'])(
    'skips a stale recovery wake when the candidate is %s before injection',
    async (candidateState) => {
      const scheduled = [];
      const methods = [];
      const client = {
        session: {
          messages: vi.fn(async () => ({
            data: [{
              info: {
                id: 'msg_parent_user',
                role: 'user',
                agent: 'orchestrator',
                model: { providerID: 'openai', modelID: 'gpt-5.6' },
              },
              parts: [{ type: 'text', text: 'Finish the parent task.' }],
            }],
          })),
          status: vi.fn(async () => ({ data: {} })),
          promptAsync: vi.fn(async () => ({ data: true })),
        },
      };
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const request = JSON.parse(init.body);
        methods.push(request.method);
        if (request.method === 'list_provider_recovery_continuations') {
          return rpcResponse({
            continuations: [{
              sourceTaskId: null,
              taskId: 'dvr_task_stale_wake',
              rootSessionId: 'ses_root',
              childSessionId: 'ses_child',
              directory: '/workspace',
              kind: 'collect',
            }],
          });
        }
        if (request.method === 'status') {
          return candidateState === 'already_dispositioned'
            ? rpcResponse({
                task: { taskId: 'dvr_task_stale_wake', status: 'completed' },
                resultEnvelope: { taskId: 'dvr_task_stale_wake', action: 'continue' },
              })
            : rpcResponse({ code: 'task_not_found', message: 'task was compacted' }, 404);
        }
        if (request.method === 'snapshot') return rpcResponse(healthyRootSnapshot());
        if (request.method === 'barrier_status') {
          return rpcResponse({ state: 'clear', taskIds: [] });
        }
        throw new Error(`Unexpected RPC method: ${request.method}`);
      }));
      await DevRyanManagedOrchestrationPlugin({
        client,
        scheduleTimeout(callback) {
          scheduled.push(callback);
          return { unref() {} };
        },
      });

      scheduled.shift()();
      const expectedMethods = candidateState === 'already_dispositioned'
        ? ['list_provider_recovery_continuations', 'status']
        : ['list_provider_recovery_continuations', 'status', 'snapshot', 'barrier_status'];
      await vi.waitFor(() => expect(methods).toEqual(expectedMethods));
      expect(client.session.promptAsync).not.toHaveBeenCalled();
    },
  );

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
          kind: 'collect',
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
