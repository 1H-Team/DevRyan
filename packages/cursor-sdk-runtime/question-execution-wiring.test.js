import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCursorSdkRuntime } from './index.js';

const waitFor = async (read, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const descriptor = (identity = 'question-bridge-1', token = 'secret-token') => ({
  identity,
  mcpServers: {
    devryan_question: {
      type: 'http',
      url: 'http://127.0.0.1:43123/mcp/opaque-scope',
      headers: { Authorization: `Bearer ${token}` },
    },
  },
});

const promptBody = (messageID, agent = 'Builder') => ({
  model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
  messageID,
  agent,
  parts: [{ type: 'text', text: 'Clarify unresolved intent.' }],
});

describe('Cursor question execution wiring', () => {
  const runtimes = [];
  const tempDirs = [];

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const makeStorage = async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-question-wiring-'));
    tempDirs.push(directory);
    return directory;
  };

  it('passes eligible MCP configuration to prompt runs and exposes the public question contract', async () => {
    const calls = [];
    const questionCalls = [];
    const questionRuntime = {
      getMcpServerConfig: async (input) => {
        questionCalls.push(['config', input]);
        return input.agent.toLowerCase() === 'builder' ? descriptor() : null;
      },
      listPendingQuestions: (options) => [{ id: 'que_1', sessionID: 'ses_1', questions: [], options }],
      replyToQuestion: async (...args) => { questionCalls.push(['reply', ...args]); return true; },
      rejectQuestion: async (...args) => { questionCalls.push(['reject', ...args]); return true; },
      cancelSession: (...args) => { questionCalls.push(['cancel', ...args]); return 1; },
      revokeSessionScope: (...args) => { questionCalls.push(['revoke', ...args]); return true; },
      deleteSession: async (...args) => { questionCalls.push(['delete', ...args]); return true; },
      dispose: async () => { questionCalls.push(['dispose']); },
    };
    const runtime = createCursorSdkRuntime({
      storageDir: await makeStorage(),
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-key' } }),
      env: {},
      questionRuntime,
      getWorkspaceDiff: async () => '',
      createPromptRun: async (input) => {
        calls.push(input);
        return {
          cancel: async () => {},
          async *stream() {
            yield { type: 'message', message: { type: 'status', status: 'FINISHED' } };
          },
        };
      },
    });
    runtimes.push(runtime);

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: promptBody('msg_1'),
    });
    await waitFor(() => calls[0]);
    expect(calls[0]).toMatchObject({
      mcpServerIdentity: 'question-bridge-1',
      mcpServers: descriptor().mcpServers,
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_2',
      directory: '/tmp/project',
      body: promptBody('msg_2', 'fixer'),
    });
    await waitFor(() => calls[1]);
    expect(calls[1].mcpServers).toBeNull();
    expect(calls[1].mcpServerIdentity).toBe('');

    expect(runtime.listPendingQuestions({ directory: '/tmp/project' })[0].id).toBe('que_1');
    expect(await runtime.replyToQuestion('que_1', [['Answer']])).toBe(true);
    expect(await runtime.rejectQuestion('que_1')).toBe(true);
    await runtime.abortSession('ses_1');
    await runtime.deleteSessionState('ses_1');
    expect(questionCalls).toContainEqual(['reply', 'que_1', [['Answer']]]);
    expect(questionCalls).toContainEqual(['reject', 'que_1']);
    expect(questionCalls.some(([kind, sessionID, options]) => (
      kind === 'revoke'
      && sessionID === 'ses_1'
      && options?.messageID === 'msg_1'
      && options?.identity === 'question-bridge-1'
    ))).toBe(true);
    expect(questionCalls).toContainEqual(['delete', 'ses_1']);
    await waitFor(async () => {
      const records = await runtime.getSessionMessages('ses_2');
      const finished = records.some((record) => record.info?.role === 'assistant' && record.info?.finish);
      return finished && runtime.getSessionStatus().ses_2?.type === 'idle';
    });
  });

  it('uses sanitized MCP identity in direct Agent caching while passing current credentials to create and resume', async () => {
    const agentOptions = [];
    let currentDescriptor = descriptor('identity-a', 'token-a');
    const makeAgent = () => ({
      agentId: 'cursor_agent_1',
      send: async () => ({
        status: 'finished',
        wait: async () => ({ status: 'finished', result: 'done' }),
        async *stream() {
          yield { type: 'status', status: 'FINISHED' };
        },
      }),
    });
    const runtime = createCursorSdkRuntime({
      storageDir: await makeStorage(),
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-key' } }),
      env: {},
      getWorkspaceDiff: async () => '',
      questionRuntime: {
        getMcpServerConfig: async () => currentDescriptor,
        listPendingQuestions: () => [],
        replyToQuestion: async () => false,
        rejectQuestion: async () => false,
        cancelSession: () => 0,
        revokeSessionScope: () => true,
        deleteSession: async () => false,
        dispose: async () => {},
      },
      loadSdk: async () => ({
        Agent: {
          create: async (options) => { agentOptions.push(['create', options]); return makeAgent(); },
          resume: async (_agentID, options) => { agentOptions.push(['resume', options]); return makeAgent(); },
        },
      }),
    });
    runtimes.push(runtime);

    const send = async (messageID) => {
      await runtime.handlePromptAsync({
        sessionID: 'ses_cache',
        directory: '/tmp/project',
        body: promptBody(messageID),
      });
      await waitFor(async () => {
        const records = await runtime.getSessionMessages('ses_cache');
        const finished = records.some((record) => record.info?.role === 'assistant' && record.info?.finish);
        return finished && runtime.getSessionStatus().ses_cache?.type === 'idle';
      });
    };

    await send('msg_1');
    currentDescriptor = descriptor('identity-a', 'token-b');
    await send('msg_2');
    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0][1].mcpServers.devryan_question.headers.Authorization).toBe('Bearer token-a');

    currentDescriptor = descriptor('identity-b', 'token-c');
    await send('msg_3');
    expect(agentOptions).toHaveLength(2);
    expect(agentOptions[1][0]).toBe('resume');
    expect(agentOptions[1][1].mcpServers.devryan_question.headers.Authorization).toBe('Bearer token-c');
    expect(JSON.stringify(runtime.getRuntimeStatus())).not.toContain('token-');
  });
});
