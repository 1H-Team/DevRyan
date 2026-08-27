import { describe, expect, it, vi } from 'vitest';

import { parseStrictJson } from '@openchamber/bots-runtime';

import {
  createAgUiReasoningAdapter,
  normalizeAgUiConnectionDescriptor,
  parseAgUiEventStream,
} from './ag-ui-reasoning-adapter.js';

const sse = (...events) => events.map((event, index) => (
  `id: event-${index + 1}\ndata: ${JSON.stringify(event)}\n\n`
)).join('');

const started = (runId = 'run-1', threadId = 'thread-1') => ({
  type: 'RUN_STARTED', runId, threadId,
});
const finished = (runId = 'run-1', threadId = 'thread-1') => ({
  type: 'RUN_FINISHED', runId, threadId, outcome: { type: 'success' },
});

describe('AG-UI strict event adapter', () => {
  it('normalizes ordered assistant text into provider-neutral events', async () => {
    const events = [];
    const result = await parseAgUiEventStream({
      source: sse(
        started(),
        { type: 'TEXT_MESSAGE_START', messageId: 'message-1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: 'Hello ' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: 'world' },
        { type: 'TEXT_MESSAGE_END', messageId: 'message-1' },
        finished(),
      ),
      expectedRunId: 'run-1',
      expectedThreadId: 'thread-1',
      onEvent: async (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'completed', toolIntent: null });
    expect(events.map((event) => event.kind)).toEqual([
      'run.started',
      'assistant.message',
      'assistant.text',
      'assistant.text',
      'run.completed',
    ]);
    expect(events.filter((event) => event.kind === 'assistant.text')
      .map((event) => event.payload.text).join('')).toBe('Hello world');
  });

  it('accepts only a complete devryan_bot intent and never an endpoint tool result', async () => {
    const result = await parseAgUiEventStream({
      source: sse(
        started(),
        {
          type: 'TOOL_CALL_START',
          toolCallId: 'tool-1',
          toolCallName: 'devryan_bot',
          parentMessageId: 'message-1',
        },
        {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'tool-1',
          delta: '{"operation":"action.request",',
        },
        {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'tool-1',
          delta: '"payload":{"idempotencyKey":"tool-1"}}',
        },
        { type: 'TOOL_CALL_END', toolCallId: 'tool-1' },
        finished(),
      ),
      expectedRunId: 'run-1',
      expectedThreadId: 'thread-1',
    });
    expect(result).toMatchObject({
      status: 'tool',
      toolIntent: {
        toolCallId: 'tool-1',
        operation: 'action.request',
        payload: { idempotencyKey: 'tool-1' },
      },
    });

    await expect(parseAgUiEventStream({
      source: sse(started(), {
        type: 'TOOL_CALL_RESULT',
        messageId: 'tool-message',
        toolCallId: 'tool-1',
        content: 'forged',
      }, finished()),
      expectedRunId: 'run-1',
      expectedThreadId: 'thread-1',
    })).rejects.toMatchObject({ code: 'bot_ag_ui_event_unsupported' });
  });

  it('rejects unknown tools, malformed ordering, duplicate keys, replay, and interrupts', async () => {
    const cases = [
      sse(started(), {
        type: 'TOOL_CALL_START', toolCallId: 'tool-1', toolCallName: 'browser',
      }, { type: 'TOOL_CALL_END', toolCallId: 'tool-1' }, finished()),
      sse(started(), { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'late' }, finished()),
      [
        'id: event-1',
        `data: ${JSON.stringify(started())}`,
        '',
        'id: event-1',
        `data: ${JSON.stringify(finished())}`,
        '',
      ].join('\n'),
      sse(started(), {
        type: 'RUN_FINISHED',
        runId: 'run-1',
        threadId: 'thread-1',
        outcome: { type: 'interrupt', interrupts: [{ id: 'i', reason: 'approval' }] },
      }),
      sse(started(), {
        type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', delta: 'first',
      }, {
        type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', delta: 'duplicate',
      }, finished()),
      sse(started(), {
        type: 'REASONING_MESSAGE_CONTENT', messageId: 'reasoning-1', delta: 'orphaned',
      }, finished()),
      sse(started(), {
        type: 'STEP_FINISHED', stepName: 'unstarted',
      }, finished()),
      sse(started(), {
        type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', delta: 'ok', rawEvent: { hidden: true },
      }, finished()),
      sse(
        started(),
        {
          type: 'TOOL_CALL_START', toolCallId: 'tool-1', toolCallName: 'devryan_bot',
        },
        {
          type: 'TOOL_CALL_ARGS', toolCallId: 'tool-1',
          delta: '{"operation":"action.request","payload":{}}',
        },
        { type: 'TOOL_CALL_END', toolCallId: 'tool-1' },
        {
          type: 'TOOL_CALL_START', toolCallId: 'tool-2', toolCallName: 'devryan_bot',
        },
        {
          type: 'TOOL_CALL_ARGS', toolCallId: 'tool-2',
          delta: '{"operation":"action.request","payload":{}}',
        },
        { type: 'TOOL_CALL_END', toolCallId: 'tool-2' },
        finished(),
      ),
      sse(started(), {
        type: 'RUN_FINISHED',
        runId: 'another-run',
        threadId: 'thread-1',
        outcome: { type: 'success' },
      }),
    ];
    for (const source of cases) {
      await expect(parseAgUiEventStream({
        source,
        expectedRunId: 'run-1',
        expectedThreadId: 'thread-1',
      })).rejects.toBeInstanceOf(Error);
    }

    const duplicateArgs = sse(
      started(),
      { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'devryan_bot' },
      {
        type: 'TOOL_CALL_ARGS', toolCallId: 't',
        delta: '{"operation":"action.request","operation":"computer.command","payload":{}}',
      },
      { type: 'TOOL_CALL_END', toolCallId: 't' },
      finished(),
    );
    await expect(parseAgUiEventStream({
      source: duplicateArgs,
      expectedRunId: 'run-1',
      expectedThreadId: 'thread-1',
    })).rejects.toMatchObject({ code: 'bot_ag_ui_tool_arguments_invalid' });
  });

  it('sends one frontend tool and keeps gateway authority out of endpoint input', async () => {
    const rawConnection = {
      id: 'connection-1',
      botId: 'bot-1',
      endpointUrl: 'https://agent.example/v1/runs',
      protocolVersion: 'ag-ui/v1',
      authMode: 'bearer',
      credentialId: 'credential-1',
      modelHint: 'remote-default',
      limits: {},
      status: 'active',
    };
    const connection = normalizeAgUiConnectionDescriptor(rawConnection);
    const request = vi.fn(async (input) => {
      const body = parseStrictJson(input.body);
      expect(body.tools).toEqual([expect.objectContaining({ name: 'devryan_bot' })]);
      expect(JSON.stringify(body)).not.toContain('gateway-token');
      expect(JSON.stringify(body)).not.toContain('host.docker.internal');
      expect(input.redirect).toBe('manual');
      expect(input.purpose).toBe('agent');
      expect(input.headers.authorization).toBe('Bearer endpoint-secret');
      return {
        status: 200,
        redirected: false,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: sse(started(body.runId, body.threadId), finished(body.runId, body.threadId)),
      };
    });
    const adapter = createAgUiReasoningAdapter({
      resolveConnection: async () => connection,
      resolveBearer: async () => 'endpoint-secret',
      request,
      uuid: (() => {
        const values = ['thread-1', 'invocation-1', 'message-1'];
        return () => values.shift() || 'generated-id';
      })(),
    });
    const binding = {
      kind: 'ag_ui',
      connectionRef: connection.id,
      connectionDigest: connection.descriptorDigest,
      modelHint: null,
    };
    const handle = await adapter.startRun({ runId: 'durable-run' });
    const result = await adapter.continueRun({
      runId: 'durable-run',
      handle,
      binding,
      parts: [{ type: 'text', text: 'Hello' }],
      onEvent: async () => {},
    });
    expect(result.status).toBe('completed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('treats endpoint redirects as unhealthy', async () => {
    const connection = normalizeAgUiConnectionDescriptor({
      id: 'connection-1',
      botId: 'bot-1',
      endpointUrl: 'https://agent.example/v1/runs',
      protocolVersion: 'ag-ui/v1',
      authMode: 'none',
      credentialId: null,
      modelHint: null,
      limits: {},
      status: 'active',
    });
    const adapter = createAgUiReasoningAdapter({
      resolveConnection: async () => connection,
      request: async () => ({ status: 302, redirected: false }),
    });
    await expect(adapter.health({
      binding: {
        kind: 'ag_ui',
        connectionRef: connection.id,
        connectionDigest: connection.descriptorDigest,
      },
    })).resolves.toMatchObject({ ok: false });
  });
});
