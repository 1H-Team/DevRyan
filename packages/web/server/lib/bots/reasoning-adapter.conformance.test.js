import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { parseStrictJson } from '@openchamber/bots-runtime';

import {
  createAgUiReasoningAdapter,
  normalizeAgUiConnectionDescriptor,
} from './ag-ui-reasoning-adapter.js';
import { createOpenCodeReasoningAdapter } from './opencode-reasoning-adapter.js';
import { assertBotReasoningAdapter } from './reasoning-adapter.js';

const sse = (...events) => events.map((event, index) => (
  `id: event-${index + 1}\ndata: ${JSON.stringify(event)}\n\n`
)).join('');

const openCodeHarness = () => {
  let eventHandler = null;
  const provider = {
    start: vi.fn(async () => undefined),
    setEventHandler: vi.fn((handler) => { eventHandler = handler; }),
    startReasoningRun: vi.fn(async () => ({
      modelSnapshot: { providerId: 'openai', modelId: 'test', contextLimit: 10_000 },
    })),
    createSegment: vi.fn(async () => ({ id: 'thread-opencode' })),
    prompt: vi.fn(async ({ runId, sessionId }) => {
      await eventHandler({
        runId,
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'message-opencode',
              sessionID: sessionId,
              role: 'assistant',
              tokens: {},
            },
          },
        },
      });
      await eventHandler({
        runId,
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part-opencode',
              messageID: 'message-opencode',
              sessionID: sessionId,
              type: 'text',
              text: '{"ok":true}',
            },
          },
        },
      });
      await eventHandler({
        runId,
        event: {
          type: 'session.status',
          properties: { sessionID: sessionId, status: { type: 'idle' } },
        },
      });
    }),
    inspectSegment: vi.fn(async () => ({ status: 'completed', resumable: true })),
    abort: vi.fn(async () => undefined),
    stopReasoningRun: vi.fn(async () => undefined),
    runNoToolsStructured: vi.fn(async () => ({ ok: true })),
  };
  return {
    adapter: createOpenCodeReasoningAdapter({
      provider,
      loadModelCatalog: async () => [],
      uuid: () => 'segment-opencode',
    }),
    binding: { kind: 'opencode', models: {} },
  };
};

const agUiHarness = () => {
  const connection = normalizeAgUiConnectionDescriptor({
    id: 'connection-ag-ui',
    botId: 'bot-ag-ui',
    endpointUrl: 'https://agent.example/v1/runs',
    protocolVersion: 'ag-ui/v1',
    authMode: 'none',
    credentialId: null,
    modelHint: null,
    limits: {},
    status: 'active',
  });
  let nextId = 0;
  const adapter = createAgUiReasoningAdapter({
    resolveConnection: async () => connection,
    request: async (input) => {
      if (input.method === 'HEAD') return { status: 204, redirected: false };
      const body = parseStrictJson(input.body);
      return {
        status: 200,
        redirected: false,
        headers: { 'content-type': 'text/event-stream' },
        body: sse(
          { type: 'RUN_STARTED', runId: body.runId, threadId: body.threadId },
          { type: 'TEXT_MESSAGE_START', messageId: `message-${nextId}`, role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: `message-${nextId}`, delta: '{"ok":true}' },
          { type: 'TEXT_MESSAGE_END', messageId: `message-${nextId}` },
          {
            type: 'RUN_FINISHED',
            runId: body.runId,
            threadId: body.threadId,
            outcome: { type: 'success' },
          },
        ),
      };
    },
    uuid: () => `ag-ui-id-${++nextId}`,
  });
  return {
    adapter,
    binding: {
      kind: 'ag_ui',
      connectionRef: connection.id,
      connectionDigest: connection.descriptorDigest,
      modelHint: null,
    },
  };
};

describe.each([
  ['OpenCode', openCodeHarness],
  ['AG-UI', agUiHarness],
])('%s BotReasoningAdapter conformance', (_name, createHarness) => {
  it('supports the common lifecycle and emits only normalized events', async () => {
    const { adapter, binding } = createHarness();
    expect(assertBotReasoningAdapter(adapter)).toBe(adapter);
    await expect(adapter.health({ binding })).resolves.toMatchObject({ ok: true });
    const prepared = await adapter.prepareRevision({
      run: {
        id: 'durable-run',
        botId: 'bot-id',
        channelId: 'channel-id',
        revisionId: 'revision-id',
      },
      contract: {},
      binding,
      attachmentIds: [],
      libraryVersionIds: [],
    });
    expect(prepared.modelSnapshot).toEqual(expect.objectContaining({ modelId: expect.any(String) }));

    const handle = await adapter.startRun({ runId: 'durable-run' });
    expect(handle).toMatchObject({
      threadId: expect.any(String),
      execution: { adapter: adapter.kind, checkpointVersion: 1 },
    });
    const continuedHandle = await adapter.startRun({
      runId: 'durable-run-next',
      continuation: {
        create: false,
        reason: 'continue',
        execution: handle.execution,
      },
    });
    expect(continuedHandle.threadId).toBe(handle.threadId);
    const events = [];
    await adapter.continueRun({
      runId: 'durable-run',
      handle,
      binding,
      parts: [{ type: 'text', text: 'Return JSON' }],
      onEvent: async (event) => events.push(event),
    });
    expect(events.map((event) => event.kind)).toContain('assistant.text');
    expect(events.map((event) => event.kind)).toContain('run.completed');
    expect(events.every((event) => (
      typeof event.kind === 'string'
      && event.payload
      && typeof event.payload === 'object'
    ))).toBe(true);

    await expect(adapter.inspectRun({ runId: 'durable-run', handle, binding }))
      .resolves.toEqual(expect.objectContaining({ status: expect.any(String) }));
    await adapter.cancelRun({ runId: 'durable-run', handle, binding });
    await adapter.closeRun({ runId: 'durable-run', handle, binding });
    await expect(adapter.completeStructured({
      runId: 'structured-run',
      binding,
      prepared,
      prompt: 'Return ok',
      schema: { type: 'object', required: ['ok'] },
    })).resolves.toEqual({ ok: true });
  });
});

describe('agent-neutral dispatcher source boundary', () => {
  it('contains no provider event, session, or segment semantics', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./run-dispatcher.js', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\bopencode\b|\bsession\b|\bsegment\b|message\.part/i);
  });
});
