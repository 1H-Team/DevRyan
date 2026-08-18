import { describe, expect, it, vi } from 'vitest';

import type {
  CommandDeadlineRecord,
  RecordStore,
} from '@openchamber/harness-runtime';
import { createVsCodeCommandDeadlineRuntime } from './commandDeadlineRuntime';
import type { OpenCodeManager } from './opencode';

const createStore = (): RecordStore<CommandDeadlineRecord> => {
  const records = new Map<string, CommandDeadlineRecord>();
  return {
    directory: '/diagnostics',
    async initialize() {},
    async readRecord(key) { return records.get(key) ?? null; },
    async listRecords() { return [...records].map(([key, record]) => ({ key, record })); },
    async writeRecord(key, record) { records.set(key, structuredClone(record)); return record; },
    async deleteRecord(key) { records.delete(key); },
    async reconcile() { return []; },
    async drain() {},
    getDiagnostics: () => ({
      directory: '/diagnostics',
      initialized: true,
      pendingWrites: 0,
      quarantineCount: 0,
    }),
  };
};

const jsonResponse = (body: unknown, status = 200) => new Response(
  body === null ? null : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

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

describe('VS Code command deadline adapter', () => {
  it('authenticates exact-message reconciliation and publishes the terminal part', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        info: { id: 'msg/1', sessionID: 'ses/1' },
        parts: [runningPart],
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({
        info: { id: 'msg/1', sessionID: 'ses/1' },
        parts: [{
          ...runningPart,
          state: { status: 'aborted', time: { start: 1_000, end: 2_000 } },
        }],
      }));
    const manager = {
      getApiUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic vscode-test' }),
      getDebugInfo: () => ({ mode: 'managed' }),
      restart: vi.fn(async () => undefined),
    } as unknown as OpenCodeManager;
    const publishEvent = vi.fn();
    const runtime = createVsCodeCommandDeadlineRuntime({
      store: createStore(),
      manager,
      fetchImpl,
      publishEvent,
      controllerOptions: {
        now: () => now,
        graceMs: 0,
        confirmationMs: 0,
      },
    });

    await runtime.observe({
      type: 'message.part.updated',
      properties: { sessionID: 'ses/1', messageID: 'msg/1', part: runningPart },
    }, '/workspace/project');
    now = 2_000;
    await runtime.reconcile();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [messageTarget, messageInit] = fetchImpl.mock.calls[0];
    const messageUrl = messageTarget as URL;
    expect(messageUrl.pathname).toBe('/session/ses%2F1/message/msg%2F1');
    expect(messageUrl.searchParams.get('directory')).toBe('/workspace/project');
    expect((messageInit?.headers as Record<string, string>).Authorization).toBe('Basic vscode-test');
    const abortUrl = fetchImpl.mock.calls[1][0] as URL;
    expect(abortUrl.pathname).toBe('/session/ses%2F1/abort');
    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message.part.updated',
      properties: expect.objectContaining({ sessionID: 'ses/1', messageID: 'msg/1' }),
    }));
  });
});
