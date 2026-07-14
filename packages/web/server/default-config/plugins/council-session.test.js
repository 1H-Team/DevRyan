import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@opencode-ai/plugin', () => {
  const makeStringSchema = () => {
    const schema = {
      describe: () => schema,
      optional: () => schema,
    };
    return schema;
  };
  const mockTool = (definition) => definition;
  mockTool.schema = { string: makeStringSchema };
  return { tool: mockTool };
});

const { CouncilSessionPlugin } = await import('./council-session.js');

const PROJECT_DIR = '/project';
const PARENT_SESSION_ID = 'parent-session';
const realSetImmediate = globalThis.setImmediate;

const assistantMessage = (sessionID, text, options = {}) => ({
  info: {
    id: `msg_${sessionID}`,
    sessionID,
    role: 'assistant',
    time: {
      created: 1_000,
      ...(options.completed ? { completed: options.completed } : {}),
    },
    ...(options.finish ? { finish: options.finish } : {}),
  },
  parts: [{ type: 'text', text }],
});

const createClient = (sessionStates) => {
  const createdSessions = [];

  const client = {
    app: {
      agents: vi.fn(async () => ({ data: [] })),
    },
    session: {
      create: vi.fn(async ({ query, body }) => {
        const id = `ses_${createdSessions.length + 1}`;
        const state = sessionStates[createdSessions.length] ?? {};
        createdSessions.push({ id, query, body, state });
        return { data: { id } };
      }),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async ({ path: requestPath }) => {
        const created = createdSessions.find((session) => session.id === requestPath.id);
        const messages = typeof created?.state.messages === 'function'
          ? created.state.messages(created.id)
          : created?.state.messages;
        return { data: Array.isArray(messages) ? messages : [] };
      }),
      status: vi.fn(async () => ({
        data: Object.fromEntries(createdSessions.map((session) => {
          const status = typeof session.state.status === 'function'
            ? session.state.status(session.id)
            : session.state.status;
          return [session.id, status ?? { type: 'busy' }];
        })),
      })),
    },
  };

  return { client, createdSessions };
};

const writeCouncilConfig = async (configDir, councillors) => {
  await fs.mkdir(path.join(configDir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(configDir, 'agents', 'council.md'), [
    '---',
    'councillors:',
    ...councillors.flatMap((entry) => [
      `  - model: ${entry.model}`,
      ...(entry.variant ? [`    variant: ${entry.variant}`] : []),
    ]),
    '---',
    '',
    'Council prompt',
    '',
  ].join('\n'));
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitForMockCalls = async (mockFn, count = 1) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mockFn.mock.calls.length >= count) {
      return;
    }
    await new Promise((resolve) => realSetImmediate(resolve));
    await flushMicrotasks();
  }
  throw new Error(`Expected mock to be called ${count} time(s), received ${mockFn.mock.calls.length}`);
};

const createCouncilTool = async ({ sessionStates, councillors }) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-council-plugin-'));
  await writeCouncilConfig(configDir, councillors);
  process.env.OPENCODE_CONFIG_DIR = configDir;
  const { client, createdSessions } = createClient(sessionStates);
  const plugin = await CouncilSessionPlugin({ client });
  return { client, configDir, createdSessions, execute: plugin.tool.council_session.execute };
};

describe('CouncilSessionPlugin', () => {
  let originalConfigDir;
  let originalOrchestrationUrl;
  let originalOrchestrationToken;
  const tempDirs = [];

  beforeEach(() => {
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    originalOrchestrationUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
    originalOrchestrationToken = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
    delete process.env.DEVRYAN_ORCHESTRATION_URL;
    delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (originalConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    }
    if (originalOrchestrationUrl === undefined) delete process.env.DEVRYAN_ORCHESTRATION_URL;
    else process.env.DEVRYAN_ORCHESTRATION_URL = originalOrchestrationUrl;
    if (originalOrchestrationToken === undefined) delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
    else process.env.DEVRYAN_ORCHESTRATION_TOKEN = originalOrchestrationToken;
    vi.unstubAllGlobals();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses only Cursor Composer 2 when the cursor-composer-2 preset is requested', async () => {
    const setup = await createCouncilTool({
      sessionStates: [{
        status: { type: 'busy' },
        messages: (sessionID) => [assistantMessage(sessionID, 'composer 2 answer', {
          finish: 'stop',
          completed: 3_000,
        })],
      }],
      councillors: [{ model: 'cursor-acp/composer-2.5' }],
    });
    tempDirs.push(setup.configDir);

    const output = await setup.execute({
      prompt: 'review this plan',
      preset: 'cursor-composer-2',
    }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
    });

    expect(output).toContain('Council session preset: cursor-composer-2');
    expect(output).toContain('Councillors requested: 1');
    expect(output).toContain('### Councillor 1 (cursor-acp/composer-2)');
    expect(output).not.toContain('composer-2.5');
    expect(setup.client.session.promptAsync.mock.calls[0][0].body.model).toEqual({
      providerID: 'cursor-acp',
      modelID: 'composer-2',
    });
  });

  it('does not resolve a councillor while assistant text is still busy and incomplete', async () => {
    const state = {
      status: { type: 'busy' },
      messages: (sessionID) => [assistantMessage(sessionID, 'partial response')],
    };
    const setup = await createCouncilTool({
      sessionStates: [state],
      councillors: [{ model: 'openai/gpt-5.5' }],
    });
    tempDirs.push(setup.configDir);

    let settled = false;
    const run = setup.execute({ prompt: 'review this plan' }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
    }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();
    await waitForMockCalls(setup.client.session.messages, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(false);

    state.status = { type: 'idle' };
    state.messages = (sessionID) => [assistantMessage(sessionID, 'final response', {
      finish: 'stop',
      completed: 4_000,
    })];

    await vi.advanceTimersByTimeAsync(1_000);
    const output = await run;

    expect(output).toContain('Status: completed');
    expect(output).toContain('final response');
    expect(output).not.toContain('partial response');
    expect(setup.client.session.create).toHaveBeenCalledWith({
      query: { directory: PROJECT_DIR },
      body: {
        title: 'Counsellor 1: openai/gpt-5.5',
        parentID: PARENT_SESSION_ID,
      },
    });
  });

  it('resolves a councillor when the latest assistant message is terminal', async () => {
    const setup = await createCouncilTool({
      sessionStates: [{
        status: { type: 'busy' },
        messages: (sessionID) => [assistantMessage(sessionID, 'terminal answer', {
          finish: 'stop',
          completed: 3_000,
        })],
      }],
      councillors: [{ model: 'openai/gpt-5.5', variant: 'high' }],
    });
    tempDirs.push(setup.configDir);

    const output = await setup.execute({ prompt: 'review this plan' }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
    });

    expect(output).toContain('### Councillor 1 (openai/gpt-5.5/high)');
    expect(output).toContain('Status: completed');
    expect(output).toContain('terminal answer');
  });

  it('resolves stable assistant text after the child session stays idle for a grace window', async () => {
    const setup = await createCouncilTool({
      sessionStates: [{
        status: { type: 'idle' },
        messages: (sessionID) => [assistantMessage(sessionID, 'stable idle answer')],
      }],
      councillors: [{ model: 'openai/gpt-5.5' }],
    });
    tempDirs.push(setup.configDir);

    let settled = false;
    const run = setup.execute({ prompt: 'review this plan' }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
    }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();
    await waitForMockCalls(setup.client.session.messages, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const output = await run;

    expect(output).toContain('Status: completed');
    expect(output).toContain('stable idle answer');
  });

  it('reports a failed councillor when no assistant response is recorded after idle settlement', async () => {
    const setup = await createCouncilTool({
      sessionStates: [{
        status: { type: 'idle' },
        messages: [],
      }],
      councillors: [{ model: 'openai/gpt-5.5' }],
    });
    tempDirs.push(setup.configDir);

    const run = setup.execute({ prompt: 'review this plan' }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
    });

    await waitForMockCalls(setup.client.session.status, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    const output = await run;

    expect(output).toContain('Status: failed');
    expect(output).toContain('No assistant response was recorded.');
  });

  it('waits for all councillors before returning the council session result', async () => {
    const firstState = {
      status: { type: 'idle' },
      messages: (sessionID) => [assistantMessage(sessionID, 'first final', {
        finish: 'stop',
        completed: 2_000,
      })],
    };
    const secondState = {
      status: { type: 'busy' },
      messages: (sessionID) => [assistantMessage(sessionID, 'second partial')],
    };
    const setup = await createCouncilTool({
      sessionStates: [firstState, secondState],
      councillors: [
        { model: 'openai/gpt-5.5' },
        { model: 'opencode-go/kimi-k2.6' },
      ],
    });
    tempDirs.push(setup.configDir);

    let settled = false;
    const run = setup.execute({ prompt: 'review this plan' }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
    }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();
    await waitForMockCalls(setup.client.session.messages, 2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(false);

    secondState.status = { type: 'idle' };
    secondState.messages = (sessionID) => [assistantMessage(sessionID, 'second final', {
      finish: 'stop',
      completed: 5_000,
    })];

    await vi.advanceTimersByTimeAsync(1_000);
    const output = await run;

    expect(output).toContain('Councillors requested: 2');
    expect(output).toContain('first final');
    expect(output).toContain('second final');
    expect(output).not.toContain('second partial');
  });

  it('routes local council fanout through the shared managed scheduler bridge', async () => {
    const councillors = Array.from({ length: 5 }, (_, index) => ({
      model: `provider-${index + 1}/model-${index + 1}`,
    }));
    const setup = await createCouncilTool({ sessionStates: [], councillors });
    tempDirs.push(setup.configDir);
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:43210/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'private-token';
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.method === 'submit') {
        const index = requests.filter((request) => request.method === 'submit').length;
        return new Response(JSON.stringify({
          ok: true,
          result: { task: { taskId: `dvr_task_${index}`, status: index <= 3 ? 'starting' : 'queued' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const index = Number.parseInt(body.params.taskId.split('_').at(-1), 10);
      return new Response(JSON.stringify({
        ok: true,
        result: {
          task: { taskId: body.params.taskId, status: 'completed' },
          resultEnvelope: {
            status: 'completed',
            recoverablePreview: `managed answer ${index}`,
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const output = await setup.execute({ prompt: 'review this plan' }, {
      directory: PROJECT_DIR,
      sessionID: PARENT_SESSION_ID,
      messageID: 'msg_council',
      abort: new AbortController().signal,
    });

    expect(requests.filter((request) => request.method === 'submit')).toHaveLength(5);
    expect(requests.filter((request) => request.method === 'wait')).toHaveLength(5);
    expect(requests.filter((request) => request.method === 'submit').map((request) => request.params.mode))
      .toEqual(['orchestrator', 'orchestrator', 'orchestrator', 'orchestrator', 'orchestrator']);
    expect(requests.filter((request) => request.method === 'submit')
      .every((request) => request.params.deadlineClass === 'council')).toBe(true);
    expect(setup.client.session.create).not.toHaveBeenCalled();
    expect(output).toContain('Councillors requested: 5');
    expect(output).toContain('managed answer 1');
    expect(output).toContain('managed answer 5');
  });
});
