import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createCursorQuestionRuntime } from './cursor-question-runtime.js';

const QUESTION = {
  header: 'Contract',
  question: 'How should an invalid range be handled?',
  options: [
    { label: 'Throw', description: 'Reject invalid bounds.' },
    { label: 'Normalize', description: 'Swap invalid bounds.' },
  ],
};

const waitFor = async (read, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const getText = (result) => result.content
  .filter((item) => item.type === 'text')
  .map((item) => item.text)
  .join('\n');

const createClient = async (descriptor) => {
  const config = descriptor.mcpServers.devryan_question;
  const requestBodies = [];
  const client = new Client({ name: 'cursor-question-runtime-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
    fetch: async (url, init) => {
      if (typeof init?.body === 'string') requestBodies.push(JSON.parse(init.body));
      return fetch(url, init);
    },
  });
  await client.connect(transport);
  return { client, transport, requestBodies };
};

describe('Cursor question MCP runtime', () => {
  const disposables = [];

  afterEach(async () => {
    await Promise.allSettled(disposables.splice(0).reverse().map((item) => item()));
  });

  const createRuntime = (options = {}) => {
    const events = [];
    const runtime = createCursorQuestionRuntime({
      emitEvent: (event, context) => events.push({ event, context }),
      logger: { error() {}, warn() {} },
      ...options,
    });
    disposables.push(() => runtime.dispose());
    return { runtime, events };
  };

  const connect = async (runtime, input = {}) => {
    const descriptor = await runtime.getMcpServerConfig({
      agent: 'Builder',
      sessionID: 'ses_builder',
      directory: '/tmp/project-a',
      messageID: 'msg_user',
      ...input,
    });
    const connected = await createClient(descriptor);
    disposables.push(() => connected.client.close());
    return { descriptor, ...connected };
  };

  it('advertises a real blocking question tool only to Builder and Orchestrator', async () => {
    const { runtime } = createRuntime();

    expect(await runtime.getMcpServerConfig({ agent: 'fixer', sessionID: 'ses_1' })).toBeNull();
    expect(await runtime.getMcpServerConfig({ agent: '', sessionID: 'ses_1' })).toBeNull();

    for (const agent of ['builder', 'BUILDER', 'Orchestrator']) {
      const descriptor = await runtime.getMcpServerConfig({ agent, sessionID: `ses_${agent}` });
      expect(descriptor.identity).toBeTruthy();
      expect(descriptor.identity).not.toContain('Bearer');
      expect(descriptor.mcpServers.devryan_question).toMatchObject({
        type: 'http',
        headers: { Authorization: expect.stringMatching(/^Bearer /) },
      });
    }

    const { client } = await connect(runtime);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['question']);
  });

  it('fails visibly when the authenticated loopback bridge cannot start', async () => {
    const { runtime } = createRuntime({
      createHttpServer: () => {
        const server = new EventEmitter();
        server.listen = () => queueMicrotask(() => server.emit('error', new Error('bind failed')));
        return server;
      },
    });

    await expect(runtime.getMcpServerConfig({ agent: 'builder', sessionID: 'ses_failure' }))
      .rejects.toThrow('Cursor question bridge failed to start: bind failed');
  });

  it('blocks until ordered answers are supplied and emits canonical events', async () => {
    const { runtime, events } = createRuntime();
    const { client, requestBodies } = await connect(runtime);

    const call = client.callTool({
      name: 'question',
      arguments: {
        questions: [
          QUESTION,
          {
            header: 'Compatibility',
            question: 'Which compatibility level?',
            options: [
              { label: 'Strict', description: 'Reject legacy input.' },
              { label: 'Legacy', description: 'Accept legacy input.' },
            ],
            multiple: true,
          },
        ],
      },
    });

    const pending = await waitFor(() => runtime.listPendingQuestions()[0]);
    const callRequest = requestBodies.find((body) => body?.method === 'tools/call');
    expect(callRequest.params.arguments.questions[1].question).toBe('Which compatibility level?');
    expect(pending.questions[1].question).toBe('Which compatibility level?');
    expect(structuredClone(pending)).toMatchObject({
      sessionID: 'ses_builder',
      questions: [QUESTION, expect.objectContaining({ multiple: true })],
      tool: { messageID: 'msg_user', callID: expect.any(String) },
    });
    expect(events.at(-1)).toEqual({
      event: { type: 'question.asked', properties: pending },
      context: { directory: '/tmp/project-a' },
    });

    expect(await runtime.replyToQuestion(pending.id, [['Normalize'], ['Strict', 'Legacy']])).toBe(true);
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getText(result))).toEqual({
      status: 'answered',
      answers: [
        { question: QUESTION.question, answers: ['Normalize'] },
        { question: 'Which compatibility level?', answers: ['Strict', 'Legacy'] },
      ],
    });
    expect(runtime.listPendingQuestions()).toEqual([]);
    expect(events.at(-1).event).toEqual({
      type: 'question.replied',
      properties: {
        sessionID: 'ses_builder',
        requestID: pending.id,
        answers: [['Normalize'], ['Strict', 'Legacy']],
      },
    });
    expect(await runtime.replyToQuestion(pending.id, [['Throw'], ['Strict']])).toBe(false);
  });

  it('accepts free-form answers and Skip resumes with an explicit assumption instruction', async () => {
    const { runtime, events } = createRuntime();
    const { client } = await connect(runtime);

    const answeredCall = client.callTool({
      name: 'question',
      arguments: { questions: [QUESTION] },
    });
    const answered = await waitFor(() => runtime.listPendingQuestions()[0]);
    await runtime.replyToQuestion(answered.id, [['Use a branded RangeError.']]);
    expect(JSON.parse(getText(await answeredCall)).answers[0].answers).toEqual(['Use a branded RangeError.']);

    const skippedCall = client.callTool({
      name: 'question',
      arguments: { questions: [QUESTION] },
    });
    const skipped = await waitFor(() => runtime.listPendingQuestions()[0]);
    expect(await runtime.rejectQuestion(skipped.id)).toBe(true);
    const skippedResult = await skippedCall;
    expect(skippedResult.isError).not.toBe(true);
    expect(getText(skippedResult)).toContain('Continue using your best judgment');
    expect(getText(skippedResult)).toContain('state the assumption');
    expect(events.at(-1).event).toEqual({
      type: 'question.rejected',
      properties: { sessionID: 'ses_builder', requestID: skipped.id },
    });
    expect(await runtime.rejectQuestion(skipped.id)).toBe(false);
  });

  it('isolates concurrent sessions and filters pending questions by directory', async () => {
    const { runtime } = createRuntime();
    const first = await connect(runtime);
    const second = await connect(runtime, {
      agent: 'orchestrator',
      sessionID: 'ses_orchestrator',
      directory: '/tmp/project-b',
      messageID: 'msg_second',
    });

    const firstCall = first.client.callTool({ name: 'question', arguments: { questions: [QUESTION] } });
    const secondCall = second.client.callTool({ name: 'question', arguments: { questions: [QUESTION] } });
    await waitFor(() => runtime.listPendingQuestions().length === 2);

    expect(runtime.listPendingQuestions({ directory: '/tmp/project-a' }).map((item) => item.sessionID))
      .toEqual(['ses_builder']);
    expect(runtime.listPendingQuestions({ directory: '/tmp/project-b' }).map((item) => item.sessionID))
      .toEqual(['ses_orchestrator']);

    const firstPending = runtime.listPendingQuestions({ directory: '/tmp/project-a' })[0];
    const secondPending = runtime.listPendingQuestions({ directory: '/tmp/project-b' })[0];
    await runtime.replyToQuestion(secondPending.id, [['Throw']]);
    await runtime.replyToQuestion(firstPending.id, [['Normalize']]);
    expect(JSON.parse(getText(await firstCall)).answers[0].answers).toEqual(['Normalize']);
    expect(JSON.parse(getText(await secondCall)).answers[0].answers).toEqual(['Throw']);
  });

  it('removes a pending card when the MCP client disconnects', async () => {
    const lifecycle = [];
    let serverSocket = null;
    const { runtime, events } = createRuntime({
      createHttpServer: (handler) => http.createServer((req, res) => {
        serverSocket = req.socket;
        req.once('aborted', () => lifecycle.push('request-aborted'));
        req.once('close', () => lifecycle.push('request-close'));
        req.socket.once('close', () => lifecycle.push('socket-close'));
        res.once('close', () => lifecycle.push('response-close'));
        res.once('finish', () => lifecycle.push('response-finish'));
        handler(req, res);
      }),
    });
    const descriptor = await runtime.getMcpServerConfig({
      agent: 'builder',
      sessionID: 'ses_builder',
      directory: '/tmp/project-a',
      messageID: 'msg_user',
    });
    const config = descriptor.mcpServers.devryan_question;
    const url = new URL(config.url);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'question', arguments: { questions: [QUESTION] } },
    });
    const socket = net.createConnection(Number(url.port), url.hostname);
    const callOutcome = new Promise((resolve) => {
      socket.once('error', resolve);
      socket.once('close', resolve);
    });
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write([
      `POST ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      `Authorization: ${config.headers.Authorization}`,
      'Accept: application/json, text/event-stream',
      'Content-Type: application/json',
      'MCP-Protocol-Version: 2025-06-18',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'));
    const pending = await waitFor(() => runtime.listPendingQuestions()[0]);

    serverSocket.destroy();
    expect(await waitFor(() => lifecycle.includes('socket-close'))).toBe(true);
    expect(await waitFor(() => runtime.listPendingQuestions().length === 0)).toBe(true);
    await callOutcome;
    expect(events.at(-1).event).toEqual({
      type: 'question.rejected',
      properties: { sessionID: 'ses_builder', requestID: pending.id },
    });
  });

  it('revokes a superseded run scope before the replacement run can ask', async () => {
    const { runtime } = createRuntime();
    const first = await runtime.getMcpServerConfig({
      agent: 'builder',
      sessionID: 'ses_shared',
      directory: '/tmp/project-a',
      messageID: 'msg_first',
    });
    const { client: firstClient } = await createClient(first);
    disposables.push(() => firstClient.close());
    const oldCall = firstClient.callTool({
      name: 'question',
      arguments: { questions: [QUESTION] },
    });
    await waitFor(() => runtime.listPendingQuestions()[0]);

    const second = await runtime.getMcpServerConfig({
      agent: 'Builder',
      sessionID: 'ses_shared',
      directory: '/tmp/project-b',
      messageID: 'msg_second',
    });

    expect(second.identity).not.toBe(first.identity);
    expect(second.mcpServers.devryan_question.url).not.toBe(first.mcpServers.devryan_question.url);
    expect((await oldCall).isError).toBe(true);
    expect(runtime.listPendingQuestions()).toEqual([]);
    const stale = await fetch(first.mcpServers.devryan_question.url, {
      method: 'POST',
      headers: {
        ...first.mcpServers.devryan_question.headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    expect(stale.status).toBe(404);
  });

  it('revokes an ended run scope without letting late cleanup remove its replacement', async () => {
    const { runtime } = createRuntime();
    const first = await runtime.getMcpServerConfig({
      agent: 'builder',
      sessionID: 'ses_lifecycle',
      directory: '/tmp/project-a',
      messageID: 'msg_first',
    });
    const { client: firstClient } = await createClient(first);
    disposables.push(() => firstClient.close());
    const blockedCall = firstClient.callTool({
      name: 'question',
      arguments: { questions: [QUESTION] },
    });
    await waitFor(() => runtime.listPendingQuestions()[0]);

    expect(runtime.revokeSessionScope('ses_lifecycle', {
      identity: first.identity,
      messageID: 'msg_first',
      reason: 'the Cursor run was aborted',
    })).toBe(true);
    expect((await blockedCall).isError).toBe(true);
    expect(runtime.listPendingQuestions()).toEqual([]);
    const stale = await fetch(first.mcpServers.devryan_question.url, {
      method: 'POST',
      headers: {
        ...first.mcpServers.devryan_question.headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    expect(stale.status).toBe(404);

    const second = await runtime.getMcpServerConfig({
      agent: 'builder',
      sessionID: 'ses_lifecycle',
      directory: '/tmp/project-b',
      messageID: 'msg_first',
    });
    expect(runtime.revokeSessionScope('ses_lifecycle', {
      identity: first.identity,
      messageID: 'msg_first',
      reason: 'late cleanup from the first run',
    })).toBe(false);

    const { client } = await createClient(second);
    disposables.push(() => client.close());
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['question']);
  });

  it('rejects unauthenticated, invalid-host, oversized, and malformed requests', async () => {
    const { runtime } = createRuntime({ maxBodyBytes: 512 });
    const descriptor = await runtime.getMcpServerConfig({
      agent: 'builder',
      sessionID: 'ses_security',
      directory: '/tmp/security',
    });
    const config = descriptor.mcpServers.devryan_question;

    const unauthorized = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);

    const invalidHost = await fetch(config.url, {
      method: 'POST',
      headers: {
        ...config.headers,
        Host: 'attacker.invalid',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(invalidHost.status).toBe(421);

    const oversized = await fetch(config.url, {
      method: 'POST',
      headers: { ...config.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(800) }),
    });
    expect(oversized.status).toBe(413);

    const malformed = await fetch(config.url, {
      method: 'POST',
      headers: { ...config.headers, 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
  });

  it('rejects malformed question shapes without creating a pending card', async () => {
    const { runtime } = createRuntime();
    const { client } = await connect(runtime);

    const result = await client.callTool({
      name: 'question',
      arguments: {
        questions: [{
          header: '',
          question: 'Missing options',
          options: [],
        }],
      },
    });
    expect(result.isError).toBe(true);
    expect(runtime.listPendingQuestions()).toEqual([]);
  });

  it('cleans up blocked tool work on abort, delete, and disposal without a user timeout', async () => {
    const { runtime } = createRuntime();
    const { client } = await connect(runtime);

    const abortedCall = client.callTool({ name: 'question', arguments: { questions: [QUESTION] } });
    const aborted = await waitFor(() => runtime.listPendingQuestions()[0]);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(runtime.listPendingQuestions()).toHaveLength(1);
    expect(runtime.cancelSession('ses_builder', { reason: 'aborted' })).toBe(1);
    expect((await abortedCall).isError).toBe(true);
    expect(await runtime.replyToQuestion(aborted.id, [['Throw']])).toBe(false);

    const deletedCall = client.callTool({ name: 'question', arguments: { questions: [QUESTION] } });
    await waitFor(() => runtime.listPendingQuestions().length === 1);
    expect(await runtime.deleteSession('ses_builder')).toBe(true);
    expect((await deletedCall).isError).toBe(true);

    const { client: disposalClient } = await connect(runtime, { sessionID: 'ses_dispose' });
    const disposedCall = disposalClient.callTool({ name: 'question', arguments: { questions: [QUESTION] } });
    await waitFor(() => runtime.listPendingQuestions().length === 1);
    await runtime.dispose();
    expect((await disposedCall).isError).toBe(true);
    expect(runtime.listPendingQuestions()).toEqual([]);
  });
});
