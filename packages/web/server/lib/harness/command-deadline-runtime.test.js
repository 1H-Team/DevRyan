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

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return body === null ? '' : JSON.stringify(body); },
});

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

describe('web command deadline adapter', () => {
  it('uses authenticated exact-message and abort requests scoped to the event directory', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({
        info: { id: 'msg/1', sessionID: 'ses/1' },
        parts: [runningPart],
      }))
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({
        info: { id: 'msg/1', sessionID: 'ses/1' },
        parts: [{
          ...runningPart,
          state: { status: 'aborted', time: { start: 1_000, end: 2_000 } },
        }],
      }));
    const publishEvent = vi.fn();
    const runtime = createWebCommandDeadlineRuntime({
      store: createStore(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      fetchImpl,
      publishEvent,
      restartOpenCode: vi.fn(),
      isExternalOpenCode: () => false,
      controllerOptions: {
        now: () => now,
        graceMs: 0,
        confirmationMs: 0,
      },
    });

    await runtime.observe(event, '/workspace/project');
    now = 2_000;
    await runtime.reconcile();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [messageUrl, messageRequest] = fetchImpl.mock.calls[0];
    expect(messageUrl.pathname).toBe('/session/ses%2F1/message/msg%2F1');
    expect(messageUrl.searchParams.get('directory')).toBe('/workspace/project');
    expect(messageRequest.headers.Authorization).toBe('Basic test');
    const [abortUrl, abortRequest] = fetchImpl.mock.calls[1];
    expect(abortUrl.pathname).toBe('/session/ses%2F1/abort');
    expect(abortUrl.searchParams.get('directory')).toBe('/workspace/project');
    expect(abortRequest.method).toBe('POST');
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.part.updated',
        properties: expect.objectContaining({ sessionID: 'ses/1', messageID: 'msg/1' }),
      }),
      { directory: '/workspace/project' },
    );
  });
});
