import { describe, expect, it, vi } from 'vitest';

import { createWebCommandDeadlineRuntime } from './command-deadline-runtime.js';

const createStore = () => {
  const records = new Map();
  return {
    records,
    async initialize() {},
    async listRecords() { return [...records].map(([key, record]) => ({ key, record })); },
    async writeRecord(key, record) { records.set(key, structuredClone(record)); return record; },
    async deleteRecord(key) { records.delete(key); },
    async drain() {},
  };
};

const runningPart = {
  id: 'part/1',
  messageID: 'msg/1',
  sessionID: 'ses/1',
  type: 'tool',
  tool: 'bash',
  callID: 'call/1',
  state: {
    status: 'running',
    input: { command: 'sleep forever', timeout: 1_000 },
    time: { start: 1_000 },
  },
};

const event = {
  type: 'message.part.updated',
  properties: {
    sessionID: 'ses/1',
    messageID: 'msg/1',
    part: runningPart,
  },
};

describe('web command deadline adapter on gen 2 (openCodeClient)', () => {
  const createClient = ({ generation = 2, messages, statuses = {} } = {}) => {
    const queue = [...(messages ?? [])];
    return {
      generation: vi.fn(() => {
        if (generation instanceof Error) throw generation;
        return generation;
      }),
      sessions: {
        message: vi.fn(async () => queue.shift() ?? null),
        abort: vi.fn(async () => true),
        status: vi.fn(async () => statuses),
      },
    };
  };

  const createRuntime = (openCodeClient, extra = {}) => {
    const clock = { now: 1_000 };
    const fetchImpl = vi.fn(async (url) => { throw new Error(`gen 2 leaked a direct request: ${url}`); });
    const publishEvent = vi.fn();
    const runtime = createWebCommandDeadlineRuntime({
      store: createStore(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      fetchImpl,
      publishEvent,
      restartOpenCode: vi.fn(),
      isExternalOpenCode: () => false,
      openCodeClient,
      controllerOptions: {
        now: () => clock.now,
        graceMs: 0,
        confirmationMs: 0,
      },
      ...extra,
    });
    return { runtime, fetchImpl, publishEvent, clock };
  };

  it('rejects an injected client that is not an openCodeClient', () => {
    expect(() => createRuntime({ sessions: {} })).toThrow('openCodeClient must be an openCodeClient');
  });

  it('reads the exact message and aborts through the client, scoped to the event directory', async () => {
    const openCodeClient = createClient({
      messages: [
        { info: { id: 'msg/1', sessionID: 'ses/1' }, parts: [runningPart] },
        {
          info: { id: 'msg/1', sessionID: 'ses/1' },
          parts: [{ ...runningPart, state: { status: 'error', error: 'aborted', time: { start: 1_000, end: 2_000 } } }],
        },
      ],
    });
    const { runtime, fetchImpl, publishEvent, clock } = createRuntime(openCodeClient);

    await runtime.observe(event, '/workspace/project');
    clock.now = 2_000;
    await runtime.reconcile();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.message).toHaveBeenCalledWith('ses/1', 'msg/1',
      { directory: '/workspace/project', allowNotFound: true, timeoutMs: 5_000 });
    expect(openCodeClient.sessions.abort).toHaveBeenCalledWith('ses/1', { directory: '/workspace/project', timeoutMs: 5_000 });
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.part.updated',
        properties: expect.objectContaining({ sessionID: 'ses/1', messageID: 'msg/1' }),
      }),
      { directory: '/workspace/project' },
    );
  });

  it('treats a message the client cannot find as replaced, without aborting', async () => {
    const openCodeClient = createClient({ messages: [null] });
    const { runtime, clock } = createRuntime(openCodeClient);

    await runtime.observe(event, '/workspace/project');
    clock.now = 2_000;
    await runtime.reconcile();

    expect(openCodeClient.sessions.message).toHaveBeenCalledTimes(1);
    expect(openCodeClient.sessions.abort).not.toHaveBeenCalled();
  });

  it('restarts the managed runtime only when the client reports the command session as the sole active one', async () => {
    const stillRunning = { info: { id: 'msg/1', sessionID: 'ses/1' }, parts: [runningPart] };
    const openCodeClient = createClient({
      messages: [stillRunning, stillRunning],
      statuses: { 'ses/1': { type: 'busy' }, 'ses/idle': { type: 'idle' } },
    });
    const restartOpenCode = vi.fn(async () => {});
    const { runtime, clock } = createRuntime(openCodeClient, { restartOpenCode });

    await runtime.observe(event, '/workspace/project');
    clock.now = 2_000;
    await runtime.reconcile();

    expect(openCodeClient.sessions.status).toHaveBeenCalledWith({ directory: '/workspace/project' }, { timeoutMs: 5_000 });
    expect(restartOpenCode).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3, null])('refuses unsupported runtime identity %s without fetching or aborting', async (generation) => {
    const openCodeClient = createClient({ generation });
    const { runtime, clock, fetchImpl } = createRuntime(openCodeClient);
    await runtime.observe(event, '/workspace/project');
    clock.now = 2_000;
    await runtime.reconcile();
    expect(openCodeClient.sessions.message).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.abort).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
