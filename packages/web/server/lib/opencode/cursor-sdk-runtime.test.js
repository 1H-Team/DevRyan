import { mkdtempSync, rmSync } from 'fs';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCursorSdkRuntime } from '@openchamber/cursor-sdk-runtime';

const waitFor = async (predicate) => {
  for (let index = 0; index < 25; index += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
};

describe('Cursor SDK runtime', () => {
  let tempDir = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('keeps SDK assistant messages after the submitted user message with agent metadata', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async () => ({
              stream: async function* stream() {
                yield {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: 'SDK_INTERCEPT' }],
                  },
                };
                yield {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: '_OK' }],
                  },
                };
              },
            }),
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        agent: 'builder',
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(records?.[0]?.info).toMatchObject({
      id: 'msg_e999_user',
      providerID: 'cursor-acp',
      modelID: 'composer-2.5',
      agent: 'builder',
    });
    expect(records?.[1]?.info).toMatchObject({
      id: 'msg_e999_user_assistant',
      parentID: 'msg_e999_user',
      providerID: 'cursor-acp',
      modelID: 'composer-2.5',
      agent: 'builder',
      finish: 'stop',
    });
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('SDK_INTERCEPT_OK');
  });

  it('prewarms a Cursor agent and persists the prepared agent id for a later prompt', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const createCalls = [];
    const resumeCalls = [];
    const sendCalls = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      getWorkspaceDiff: async () => '',
      loadSdk: async () => ({
        Agent: {
          create: async (options) => {
            createCalls.push(options);
            return {
              agentId: 'agent-prepared',
              send: async () => {
                sendCalls.push('prepared');
                return {
                  stream: async function* stream() {
                    yield {
                      type: 'assistant',
                      message: { content: [{ type: 'text', text: 'prepared ok' }] },
                    };
                  },
                };
              },
            };
          },
        },
      }),
    });

    const result = await runtime.prewarmSession({
      sessionID: 'ses_prewarm',
      directory: '/tmp/project',
      modelID: 'composer-2.5',
      agent: 'builder',
    });

    expect(result).toEqual({
      ok: true,
      agentID: 'agent-prepared',
      cacheHit: false,
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      local: { cwd: '/tmp/project' },
      platform: { workspaceRef: '/tmp/project' },
    });
    expect(sendCalls).toHaveLength(0);

    const secondRuntime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      getWorkspaceDiff: async () => '',
      loadSdk: async () => ({
        Agent: {
          resume: async (agentID, options) => {
            resumeCalls.push({ agentID, options });
            return {
              agentId: agentID,
              send: async () => {
                sendCalls.push('resumed');
                return {
                  stream: async function* stream() {
                    yield {
                      type: 'assistant',
                      message: { content: [{ type: 'text', text: 'resumed ok' }] },
                    };
                  },
                };
              },
            };
          },
          create: async () => {
            throw new Error('prompt should resume the prewarmed Cursor agent');
          },
        },
      }),
    });

    await secondRuntime.handlePromptAsync({
      sessionID: 'ses_prewarm',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        agent: 'builder',
        messageID: 'msg_prewarm_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await waitFor(async () => {
      const current = await secondRuntime.getSessionMessages('ses_prewarm');
      return current.some((record) => record.info?.id === 'msg_prewarm_user_assistant' && record.info?.finish);
    });

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].agentID).toBe('agent-prepared');
    expect(resumeCalls[0].options).toMatchObject({
      local: { cwd: '/tmp/project' },
      platform: { workspaceRef: '/tmp/project' },
    });
    expect(sendCalls).toEqual(['resumed']);
  });

  it('starts Cursor prompt runs without waiting for the workspace diff baseline', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let resolveDiff = null;
    let promptRunCalled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      getWorkspaceDiff: async () => new Promise((resolve) => {
        resolveDiff = resolve;
      }),
      createPromptRun: async () => {
        promptRunCalled = true;
        return {
          cancel: async () => {},
          waitFinalResult: async () => ({
            ok: true,
            finalStatus: 'success',
            finalText: 'done',
          }),
          stream: async function* stream() {},
        };
      },
    });

    const resultPromise = runtime.handlePromptAsync({
      sessionID: 'ses_deferred_diff',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_deferred_diff_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await expect(waitFor(() => promptRunCalled)).resolves.toBe(true);
    resolveDiff?.('');
    await expect(resultPromise).resolves.toMatchObject({ handled: true, status: 204 });
  });

  it('uses the direct Cursor SDK wait result when the stream has no assistant text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async () => ({
              stream: async function* stream() {},
              wait: async () => ({
                status: 'finished',
                result: 'All tests have passed successfully.',
              }),
            }),
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('All tests have passed successfully.');
  });

  it('surfaces Cursor final text while the SDK stream remains pending', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (event) => emitted.push(event),
      createPromptRun: async () => ({
        cancel: async () => {},
        waitFinalResult: async () => ({
          ok: true,
          finalStatus: 'success',
          finalText: 'Finished while the Cursor stream is quiet.',
        }),
        stream: async function* stream() {
          await new Promise(() => {});
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_wait_before_stream',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_wait_before_stream_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_wait_before_stream');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const textEvents = emitted.filter((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.messageID === 'msg_wait_before_stream_user_assistant'
      && event.properties?.part?.type === 'text'
    ));
    const idleEvents = emitted.filter((event) => (
      event?.type === 'session.status'
      && event.properties?.sessionID === 'ses_wait_before_stream'
      && event.properties?.status?.type === 'idle'
    ));

    expect(textEvents.at(-1)?.properties?.part?.text).toBe('Finished while the Cursor stream is quiet.');
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('Finished while the Cursor stream is quiet.');
    expect(idleEvents).toHaveLength(1);
    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
  });

  it('finalizes open-stream Cursor edit tool activity when the SDK wait result finishes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (event) => emitted.push(event),
      createPromptRun: async () => ({
        cancel: async () => {},
        waitFinalResult: async () => ({
          ok: true,
          finalStatus: 'success',
          finalText: 'Edited the file and finished.',
        }),
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_edit_1',
              name: 'edit',
              status: 'running',
              args: { file: 'src/app.ts' },
            },
          };
          await new Promise(() => {});
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_open_stream_edit',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_open_stream_edit_user',
        parts: [{ type: 'text', text: 'edit this file' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_open_stream_edit');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const editTool = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'edit');
    const idleEvents = emitted.filter((event) => (
      event?.type === 'session.status'
      && event.properties?.sessionID === 'ses_open_stream_edit'
      && event.properties?.status?.type === 'idle'
    ));

    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(runtime.getSessionStatus?.().ses_open_stream_edit).toEqual({ type: 'idle' });
    expect(assistant?.info.finish).toBe('stop');
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('Edited the file and finished.');
    expect(editTool?.state?.status).toBe('completed');
    expect(typeof editTool?.state?.time?.end).toBe('number');
    expect(idleEvents).toHaveLength(1);
  });

  it('passes selected Cursor SDK thinking and fast parameters to prompt runs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let sentModelSelection = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Cursor: {
          models: {
            list: async () => [
              {
                id: 'claude-opus-4-7',
                displayName: 'Opus 4.7',
                parameters: [
                  { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
                  { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
                  { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
                ],
                variants: [
                  {
                    displayName: 'Opus 4.7',
                    params: [
                      { id: 'thinking', value: 'true' },
                      { id: 'effort', value: 'high' },
                      { id: 'fast', value: 'true' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
      createPromptRun: async ({ modelSelection }) => {
        sentModelSelection = modelSelection;
        return {
          cancel: async () => {},
          stream: async function* stream() {
            yield {
              type: 'message',
              message: {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'done' }],
                },
              },
            };
          },
        };
      },
    });

    await runtime.getVirtualProvider();
    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'claude-opus-4-7-fast' },
        variant: 'thinking-high',
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.info.finish).toBe('stop');
    expect(sentModelSelection).toEqual({
      id: 'claude-opus-4-7',
      params: [
        { id: 'thinking', value: 'true' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
    });
  });

  it('pins Cursor SDK subagent definitions to the session model selection on direct agent creation', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let createOptions = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      useNodeWorkerForPrompts: false,
      resolveAgentDefinitions: async () => ({
        explorer: {
          description: 'Read-only code explorer',
          prompt: 'Inspect the repository and report findings.',
          model: 'inherit',
        },
      }),
      loadSdk: async () => ({
        Agent: {
          create: async (options = {}) => {
            createOptions = options;
            return {
              agentId: 'agent-test',
              send: async () => ({
                stream: async function* stream() {
                  yield {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: 'done' }],
                    },
                  };
                },
                wait: async () => ({ status: 'finished', result: '' }),
              }),
            };
          },
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_agents',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        agent: 'builder',
        messageID: 'msg_cursor_agents_user',
        parts: [{ type: 'text', text: 'delegate safely' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_agents');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.info.finish).toBe('stop');
    // Subagents are pinned to the session's exact model selection (composer-2.5,
    // fast=false) instead of the SDK's "inherit", which resolves a subagent's
    // model from cursor-agent's desktop-app default and could trip the
    // model-boundary guard (e.g. fast=false -> fast=true). Pinning keeps the
    // DevRyan-selected model authoritative and independent of the Cursor app.
    expect(createOptions?.agents).toEqual({
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository and report findings.',
        model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      },
    });
  });

  it('preserves explicit Cursor SDK subagent model defaults on direct agent creation', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let createOptions = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      useNodeWorkerForPrompts: false,
      resolveAgentDefinitions: async () => ({
        fixer: {
          description: 'Fast implementation specialist',
          prompt: 'Apply the requested fix.',
          model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
        },
      }),
      loadSdk: async () => ({
        Agent: {
          create: async (options = {}) => {
            createOptions = options;
            return {
              agentId: 'agent-test',
              send: async () => ({
                stream: async function* stream() {
                  yield {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: 'done' }],
                    },
                  };
                },
                wait: async () => ({ status: 'finished', result: '' }),
              }),
            };
          },
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_explicit_agent_model',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
        agent: 'orchestrator',
        messageID: 'msg_cursor_explicit_agent_model_user',
        parts: [{ type: 'text', text: 'delegate to fixer' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_explicit_agent_model');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.info.finish).toBe('stop');
    expect(createOptions?.model).toEqual({ id: 'gpt-5.5' });
    expect(createOptions?.agents).toEqual({
      fixer: {
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      },
    });
  });

  it('passes a model-selection resolver to Cursor SDK agent definitions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let createOptions = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      useNodeWorkerForPrompts: false,
      resolveAgentDefinitions: async ({ resolveModelSelection }) => {
        const model = await resolveModelSelection({ modelID: 'composer-2.5' });
        return {
          fixer: {
            description: 'Fast implementation specialist',
            prompt: 'Apply the requested fix.',
            model,
          },
        };
      },
      loadSdk: async () => ({
        Agent: {
          create: async (options = {}) => {
            createOptions = options;
            return {
              agentId: 'agent-test',
              send: async () => ({
                stream: async function* stream() {
                  yield {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: 'done' }],
                    },
                  };
                },
                wait: async () => ({ status: 'finished', result: '' }),
              }),
            };
          },
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_agent_model_resolver',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
        messageID: 'msg_cursor_agent_model_resolver_user',
        parts: [{ type: 'text', text: 'delegate to fixer' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_agent_model_resolver');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.info.finish).toBe('stop');
    expect(createOptions?.agents?.fixer?.model).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
    });
  });

  it('uses the direct Cursor SDK wait result when the stream remains open', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async () => ({
              stream: async function* stream() {
                await new Promise(() => {});
              },
              wait: async () => ({
                status: 'finished',
                result: 'Final result from wait.',
              }),
            }),
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('Final result from wait.');
  });

  it('streams Cursor SDK onDelta text before the final wait result', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    const timingMarks = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      recordTimingMark: (mark) => timingMarks.push(mark),
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async (_message, options = {}) => {
              setTimeout(() => {
                options.onDelta?.({
                  update: {
                    type: 'text-delta',
                    text: 'First streamed chunk. ',
                  },
                });
              }, 5);
              return {
                stream: async function* stream() {
                  await new Promise(() => {});
                },
                wait: async () => {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  return {
                    status: 'finished',
                    result: 'First streamed chunk. Final answer.',
                  };
                },
              };
            },
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_delta_stream',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        messageID: 'msg_delta_stream_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_delta_stream');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantTextEvents = emitted.filter((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.messageID === 'msg_delta_stream_user_assistant'
      && event.properties?.part?.type === 'text'
    ));
    expect(assistantTextEvents[0]?.properties?.part?.text).toBe('First streamed chunk. ');
    expect(assistantTextEvents.at(-1)?.properties?.part?.text).toBe('First streamed chunk. Final answer.');
    expect(timingMarks).toContainEqual(expect.objectContaining({
      sessionId: 'ses_delta_stream',
      messageId: 'msg_delta_stream_user',
      mark: 'cursor_first_emitted_text_delta',
      metadata: { providerID: 'cursor-acp', modelID: 'composer-2' },
    }));
  });

  it('deduplicates Cursor onDelta text mirrored by the legacy stream', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async (_message, options = {}) => {
              setTimeout(() => {
                options.onDelta?.({
                  update: {
                    type: 'text-delta',
                    text: 'Mirrored streamed chunk. ',
                  },
                });
              }, 5);
              return {
                stream: async function* stream() {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                  yield {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: 'Mirrored streamed chunk. ' }],
                    },
                  };
                },
                wait: async () => {
                  await new Promise((resolve) => setTimeout(resolve, 40));
                  return {
                    status: 'finished',
                    result: 'Mirrored streamed chunk. Final answer.',
                  };
                },
              };
            },
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_delta_dedupe',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        messageID: 'msg_delta_dedupe_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_delta_dedupe');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantTextEvents = emitted.filter((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.messageID === 'msg_delta_dedupe_user_assistant'
      && event.properties?.part?.type === 'text'
    ));
    const emittedTexts = assistantTextEvents.map((event) => event.properties.part.text);
    expect(emittedTexts).not.toContain('Mirrored streamed chunk. Mirrored streamed chunk. ');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe(
      'Mirrored streamed chunk. Final answer.',
    );
  });

  it('merges a richer direct Cursor SDK wait result after partial streamed text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async () => ({
              stream: async function* stream() {
                yield {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: 'All tests' }],
                  },
                };
              },
              wait: async () => ({
                status: 'finished',
                result: 'All tests have passed successfully.',
              }),
            }),
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('All tests have passed successfully.');
  });

  it('places the final Cursor wait summary after tool activity instead of merging into progress text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        waitFinalResult: async () => ({
          ok: true,
          finalStatus: 'success',
          finalText: 'Upgraded OpenCode to v1.17.8 and verified the installed version.',
        }),
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{
                  type: 'text',
                  text: 'Checking how opencode is installed and what version currently on the system.',
                }],
              },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'bash_upgrade',
              name: 'bash',
              status: 'completed',
              args: { command: 'opencode upgrade' },
              result: 'Upgraded to v1.17.8',
            },
          };
          await new Promise(() => {});
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_wait_summary_after_tool',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_wait_summary_after_tool_user',
        parts: [{ type: 'text', text: 'upgrade opencode' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_wait_summary_after_tool');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const textParts = assistant?.parts?.filter((part) => part.type === 'text') ?? [];
    const toolIndex = assistant?.parts?.findIndex((part) => part.type === 'tool') ?? -1;
    const finalTextIndex = assistant?.parts?.findIndex((part) => (
      part.type === 'text'
      && part.text === 'Upgraded OpenCode to v1.17.8 and verified the installed version.'
    )) ?? -1;

    expect(assistant?.info.finish).toBe('stop');
    expect(textParts.map((part) => part.text)).toEqual([
      'Checking how opencode is installed and what version currently on the system.',
      'Upgraded OpenCode to v1.17.8 and verified the installed version.',
    ]);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(finalTextIndex).toBeGreaterThan(toolIndex);
  });

  it('sends synthetic context to the SDK without storing it in the visible user message', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let sentPrompt = '';
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async ({ prompt }) => {
        sentPrompt = prompt;
        return {
          cancel: async () => {},
          stream: async function* stream() {
            yield {
              type: 'message',
              message: {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'done' }],
                },
              },
            };
          },
        };
      },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [
          { type: 'text', text: 'Hidden context', synthetic: true },
          { type: 'text', text: 'Visible prompt' },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(sentPrompt).toContain('Hidden context');
    expect(sentPrompt).toContain('Visible prompt');
    expect(records?.[0]?.parts?.find((part) => part.type === 'text')?.text).toBe('Visible prompt');
  });

  it('prepends resolved agent instructions to Cursor prompts without storing them in the visible user message', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let sentPrompt = '';
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      resolveAgentPrompt: async ({ agent, directory }) => {
        expect(agent).toBe('builder');
        expect(directory).toBe('/tmp/project');
        return 'Builder must always finish with Summary and Verification sections.';
      },
      createPromptRun: async ({ prompt }) => {
        sentPrompt = prompt;
        return {
          cancel: async () => {},
          stream: async function* stream() {
            yield {
              type: 'message',
              message: {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'done' }],
                },
              },
            };
          },
        };
      },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_agent_prompt',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        agent: 'builder',
        messageID: 'msg_agent_prompt_user',
        parts: [{ type: 'text', text: 'Fix the startup race.' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_agent_prompt');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(sentPrompt).toContain('<agent_instructions name="builder">');
    expect(sentPrompt).toContain('This Cursor SDK parent session is pinned to model "composer-2".');
    expect(sentPrompt).toContain('Cursor-managed task/subagent tools may report a different provider-selected model without changing the parent session model.');
    expect(sentPrompt).toContain('Builder must always finish with Summary and Verification sections.');
    expect(sentPrompt).toContain('<user_request>');
    expect(sentPrompt).toContain('Fix the startup race.');
    expect(records?.[0]?.parts?.find((part) => part.type === 'text')?.text).toBe('Fix the startup race.');
  });

  it('passes image file parts to the Cursor SDK and keeps them in the visible user message', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let sentImages = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async ({ images }) => {
        sentImages = images;
        return {
          cancel: async () => {},
          stream: async function* stream() {
            yield {
              type: 'message',
              message: {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'The image shows a simple sample.' }],
                },
              },
            };
          },
        };
      },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_image',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        agent: 'builder',
        messageID: 'msg_cursor_image_user',
        parts: [
          { type: 'text', text: 'Describe this image.' },
          {
            id: 'part_image_1',
            type: 'file',
            mime: 'image/png',
            url: 'data:image/png;base64,aGVsbG8=',
            filename: 'image.png',
          },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_image');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(sentImages).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png' }]);
    expect(records?.[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'part_image_1',
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,aGVsbG8=',
        filename: 'image.png',
      }),
    ]));
    expect(records?.[1]?.info.finish).toBe('stop');
  });

  it('blocks unsupported Cursor file parts instead of dropping them silently', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let runCreated = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => {
        runCreated = true;
        throw new Error('Cursor run should not start for unsupported file attachments');
      },
    });

    const result = await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_pdf',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        agent: 'builder',
        messageID: 'msg_cursor_pdf_user',
        parts: [
          { type: 'text', text: 'Summarize this document.' },
          {
            id: 'part_pdf_1',
            type: 'file',
            mime: 'application/pdf',
            url: 'data:application/pdf;base64,JVBERi0xLjQ=',
            filename: 'document.pdf',
          },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_pdf');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(result).toMatchObject({ handled: true, status: 204 });
    expect(runCreated).toBe(false);
    expect(records?.[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'part_pdf_1',
        type: 'file',
        mime: 'application/pdf',
        url: 'data:application/pdf;base64,JVBERi0xLjQ=',
        filename: 'document.pdf',
      }),
    ]));
    expect(records?.[1]?.info.finish).toBe('error');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toContain(
      'Cursor SDK provider sessions support image attachments only',
    );
  });

  it('ends Cursor Council sessions with a deterministic unsupported-agent error', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let runCreated = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => {
        runCreated = true;
        throw new Error('Cursor run should not start for Council');
      },
    });

    const result = await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_council',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        agent: 'council',
        messageID: 'msg_cursor_council_user',
        parts: [{ type: 'text', text: 'Use council_session with cursor-composer-2.' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_council');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(result).toMatchObject({ handled: true, status: 204 });
    expect(runCreated).toBe(false);
    expect(records?.[1]?.info.finish).toBe('error');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toContain(
      'requires the OpenCode council_session plugin tool',
    );
  });

  it('preserves pinned Cursor Orchestrator plan-mode Explorer delegation instructions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Composer 2 Plan Mode',
      '',
      '## Context',
      '',
      'Cursor Composer 2 plan mode should stream through the SDK runtime.',
      '',
      '## Implementation',
      '',
      '1. Keep the run pinned to Composer 2.',
      '',
      '## Verification',
      '',
      '1. Confirm the plan is rendered as a plan card.',
    ].join('\n');
    let sentPrompt = '';
    let sentAgentDefinitions = null;
    let runCreated = false;
    let resolvedAgentPrompt = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      resolveAgentPrompt: async () => {
        resolvedAgentPrompt = true;
        return [
          'Unknown codebase location: call `explorer` before broad direct search.',
          'Unknown file/code discovery in plan mode also routes to `explorer`; keep the rest of the turn read-only and produce only the plan.',
        ].join('\n');
      },
      resolveAgentDefinitions: async () => ({
        explorer: {
          description: 'Read-only code explorer',
          prompt: 'Inspect the repository and report findings.',
          model: 'inherit',
        },
      }),
      createPromptRun: async ({ prompt, modelID, agentDefinitions }) => {
        runCreated = true;
        sentPrompt = prompt;
        sentAgentDefinitions = agentDefinitions;
        expect(modelID).toBe('composer-2');
        return {
          cancel: async () => {},
          stream: async function* stream() {
            yield {
              type: 'message',
              message: {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: structuredPlanBody }],
                },
              },
            };
          },
        };
      },
    });

    const result = await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_orchestrator_plan',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        agent: 'orchestrator',
        messageID: 'msg_cursor_orchestrator_plan_user',
        parts: [
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce a plan only.',
            synthetic: true,
          },
          { type: 'text', text: 'Plan the audit.' },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_orchestrator_plan');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(result).toMatchObject({ handled: true, status: 204 });
    expect(runCreated).toBe(true);
    expect(sentPrompt.startsWith('User has requested to enter plan mode')).toBe(true);
    expect(sentPrompt).toContain('This Cursor SDK parent session is pinned to model "composer-2".');
    expect(sentPrompt).toContain('Cursor-managed task/subagent tools may report a different provider-selected model without changing the parent session model.');
    expect(sentPrompt).toContain('<agent_instructions name="orchestrator">');
    expect(sentPrompt).toContain('Unknown codebase location: call `explorer` before broad direct search.');
    expect(sentPrompt).toContain('Unknown file/code discovery in plan mode also routes to `explorer`; keep the rest of the turn read-only and produce only the plan.');
    expect(sentPrompt).toContain('Plan mode is running directly on Cursor model "composer-2".');
    expect(sentPrompt).toContain('Plan mode is no-mutation: do not edit files, run modifying commands, or delegate implementation work.');
    expect(sentPrompt).not.toContain('Do not call task, subagent, delegation, explorer, fixer, or council tools.');
    expect(sentAgentDefinitions).toMatchObject({
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository and report findings.',
        model: 'inherit',
      },
    });
    expect(resolvedAgentPrompt).toBe(true);
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe(
      `<!--plan-->\n${structuredPlanBody}`,
    );
  });

  it('finalizes still-running SDK tool parts when the assistant run completes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'running',
              args: { pattern: 'Open request form' },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const tool = records?.[1]?.parts?.find((part) => part.type === 'tool');
    expect(tool?.state?.status).toBe('completed');
    expect(typeof tool?.state?.time?.end).toBe('number');
  });

  it('adds a visible completion summary when Cursor finishes with only tool activity', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'completed',
              args: { pattern: 'Open request form' },
              result: 'src/a.ts:1:Open request form',
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe(
      'Completed the requested work. See the tool activity above for details.',
    );
    expect(records?.[1]?.parts?.find((part) => part.type === 'tool')?.state?.status).toBe('completed');
  });

  it('does not re-emit large completed Cursor tool parts after later stream events', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    const largeTaskOutput = 'x'.repeat(256 * 1024);
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_1',
              name: 'task',
              status: 'completed',
              args: { description: 'Explore service loading' },
              result: largeTaskOutput,
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'Continuing after task.' }],
              },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'read_1',
              name: 'read',
              status: 'completed',
              args: { path: 'src/a.ts' },
              result: 'export const value = 1;',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'Done.' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_large_tool',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_large_tool_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_large_tool');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const taskEvents = emitted.filter((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.tool === 'task'
    ));
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]?.properties?.part?.output).toBe(largeTaskOutput);
    expect(records?.[1]?.parts?.find((part) => part.tool === 'task')?.output).toBe(largeTaskOutput);
  });

  it('does not emit duplicate Cursor tool updates when the SDK repeats the same state', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          for (let index = 0; index < 2; index += 1) {
            yield {
              type: 'message',
              message: {
                type: 'tool_call',
                call_id: 'read_1',
                name: 'read',
                status: 'running',
                args: { path: 'src/a.ts' },
              },
            };
          }
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_duplicate_tool',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_duplicate_tool_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_duplicate_tool');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const readEvents = emitted.filter((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.tool === 'read'
    ));
    expect(readEvents.map((event) => event.properties.part.state.status)).toEqual(['running', 'completed']);
  });

  it('finishes the assistant turn when Cursor emits a terminal status before closing the stream', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'running',
              args: { pattern: 'Open request form' },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'status',
              status: 'FINISHED',
            },
          };
          await new Promise(() => {});
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('done');
    expect(records?.[1]?.parts?.find((part) => part.type === 'tool')?.state?.status).toBe('completed');
  });

  it('finishes quiet Cursor streams after substantial assistant text and completed tool activity', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      streamIdleTimeoutMs: 20,
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'read',
              status: 'completed',
              args: { path: 'src/pages/dashboard/Practice/Reviews.tsx' },
              result: 'export function Reviews() {}',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{
                  type: 'text',
                  text: 'The Open request form button is already removed from the professional reviews page, and the related review test now asserts that it stays absent.',
                }],
              },
            },
          };
          await new Promise(() => {});
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'tool')?.state?.status).toBe('completed');
  });

  it('finishes quiet Cursor streams after a short assistant summary and completed tool activity', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      streamIdleTimeoutMs: 20,
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'bash',
              status: 'completed',
              args: { command: 'bun test' },
              result: 'pass',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'All tests have passed successfully.' }],
              },
            },
          };
          await new Promise(() => {});
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('All tests have passed successfully.');
    expect(records?.[1]?.parts?.find((part) => part.type === 'tool')?.state?.status).toBe('completed');
  });

  it('stamps text and reasoning end times when finalizing a Cursor run', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield { type: 'message', message: { type: 'thinking', text: 'I will run the tests.' } };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'All tests have passed successfully.' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const text = records?.[1]?.parts?.find((part) => part.type === 'text');
    const reasoning = records?.[1]?.parts?.find((part) => part.type === 'reasoning');
    expect(typeof text?.time?.end).toBe('number');
    expect(typeof reasoning?.time?.end).toBe('number');
  });

  it('records Cursor thinking incrementally and mirrors tool input/output into state for UI rendering', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield { type: 'message', message: { type: 'thinking', text: 'I will inspect ' } };
          yield { type: 'message', message: { type: 'thinking', text: 'the files.' } };
          yield { type: 'message', message: { type: 'thinking', text: 'The button is gone.' } };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'completed',
              args: { pattern: 'Open request form' },
              result: 'src/pages/dashboard/Practice/Reviews.tsx:40:Open request form',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantParts = records?.[1]?.parts ?? [];
    expect(assistantParts.find((part) => part.type === 'reasoning')?.text).toBe('I will inspect the files. The button is gone.');

    const tool = assistantParts.find((part) => part.type === 'tool');
    expect(tool?.input).toEqual({ pattern: 'Open request form' });
    expect(tool?.output).toBe('src/pages/dashboard/Practice/Reviews.tsx:40:Open request form');
    expect(tool?.state).toMatchObject({
      status: 'completed',
      input: { pattern: 'Open request form' },
      output: 'src/pages/dashboard/Practice/Reviews.tsx:40:Open request form',
    });
  });

  it('starts a new Cursor thinking block when thinking resumes after tool activity', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield { type: 'message', message: { type: 'thinking', text: 'I will inspect ' } };
          yield { type: 'message', message: { type: 'thinking', text: 'the reviews page.' } };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'completed',
              args: { pattern: 'Open request form' },
              result: 'src/pages/dashboard/Practice/Reviews.tsx:40:Open request form',
            },
          };
          yield { type: 'message', message: { type: 'thinking', text: 'The button only exists in the clinic page.' } };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantParts = records?.[1]?.parts ?? [];
    const reasoningParts = assistantParts.filter((part) => part.type === 'reasoning');
    expect(reasoningParts.map((part) => part.text)).toEqual([
      'I will inspect the reviews page.',
      'The button only exists in the clinic page.',
    ]);

    const toolIndex = assistantParts.findIndex((part) => part.type === 'tool');
    expect(toolIndex).toBeGreaterThan(reasoningParts.length === 0 ? -1 : assistantParts.indexOf(reasoningParts[0]));
    expect(assistantParts.indexOf(reasoningParts[1])).toBeGreaterThan(toolIndex);
  });

  it('finalizes a Cursor thinking block when the SDK reports thinking completion', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield { type: 'message', message: { type: 'thinking', text: 'First thought.' } };
          yield { type: 'message', message: { type: 'thinking_completed' } };
          yield { type: 'message', message: { type: 'thinking', text: 'Second thought.' } };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_thinking_completed',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_thinking_completed_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_thinking_completed');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const reasoningParts = records?.[1]?.parts?.filter((part) => part.type === 'reasoning') ?? [];
    expect(reasoningParts.map((part) => part.text)).toEqual(['First thought.', 'Second thought.']);
    expect(typeof reasoningParts[0]?.time?.end).toBe('number');
    expect(reasoningParts[0]?.metadata).toMatchObject({
      providerID: 'cursor-acp',
      cursorSdk: true,
    });
  });

  it('removes dangling Cursor thinking fragments left before tool activity', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'thinking',
              text: 'Good. So for the professional dashboard, the required changes are:\n\n1.',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'completed',
              args: { pattern: 'Reviews & Reputation' },
              result: 'src/pages/dashboard/Practice/Reviews.tsx:272:Reviews & Reputation',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_reasoning_trim',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_reasoning_trim_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_reasoning_trim');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const reasoning = records?.[1]?.parts?.find((part) => part.type === 'reasoning');
    expect(reasoning?.text).toBe('Good.');
  });

  it('preserves Cursor stream order across text, tools, thinking, and final plan text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Cursor Plan Card Fix',
      '',
      '## Context',
      '',
      'Cursor emits interleaved stream events.',
      '',
      '## Implementation',
      '',
      '1. Preserve chronological parts.',
    ].join('\n');

    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'I will inspect the repo first.' }],
              },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'grep',
              status: 'completed',
              args: { pattern: 'Cursor SDK' },
              result: 'packages/cursor-sdk-runtime/index.js:1:Cursor SDK',
            },
          };
          yield {
            type: 'message',
            message: { type: 'thinking', text: 'The grep result points at the adapter.' },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: structuredPlanBody }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_plan_order',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_plan_order_user',
        parts: [
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
            synthetic: true,
          },
          { type: 'text', text: 'make a plan' },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_plan_order');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantParts = records?.[1]?.parts ?? [];
    expect(assistantParts.map((part) => part.type)).toEqual(['text', 'tool', 'reasoning', 'text']);
    expect(assistantParts[0]?.text).toBe('I will inspect the repo first.');
    expect(assistantParts[1]?.tool).toBe('grep');
    expect(assistantParts[2]?.text).toBe('The grep result points at the adapter.');
    expect(assistantParts[3]?.text).toBe(`<!--plan-->\n${structuredPlanBody}`);
    expect(assistantParts.map((part) => part.id)).toEqual([
      'msg_plan_order_user_assistant_part_000001_text',
      'msg_plan_order_user_assistant_part_000002_tool_tool_1',
      'msg_plan_order_user_assistant_part_000003_reasoning',
      'msg_plan_order_user_assistant_part_000004_text',
    ]);
  });

  it('normalizes Cursor plan-mode delta output into a plan card and returns to idle', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Cursor Streaming Plan',
      '',
      '## Context',
      '',
      'Composer streams interaction deltas before legacy final output.',
      '',
      '## Implementation',
      '',
      '1. Wire onDelta into the Cursor bridge.',
      '',
      '## Verification',
      '',
      '1. Confirm plan mode receives a plan card.',
    ].join('\n');
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent-test',
            send: async (_message, options = {}) => {
              setTimeout(() => {
                options.onDelta?.({
                  update: {
                    type: 'text-delta',
                    text: structuredPlanBody,
                  },
                });
              }, 5);
              return {
                stream: async function* stream() {
                  await new Promise(() => {});
                },
                wait: async () => {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  return {
                    status: 'finished',
                    result: structuredPlanBody,
                  };
                },
              };
            },
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_cursor_plan_delta',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2' },
        messageID: 'msg_cursor_plan_delta_user',
        parts: [
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
            synthetic: true,
          },
          { type: 'text', text: 'Plan the Cursor streaming bridge fix.' },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_cursor_plan_delta');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantText = records?.[1]?.parts?.find((part) => part.type === 'text')?.text;
    expect(assistantText).toContain('<!--plan-->');
    expect(assistantText).toContain('# Cursor Streaming Plan');
    expect(runtime.getSessionStatus?.().ses_cursor_plan_delta).toEqual({ type: 'idle' });
  });

  it('exposes Cursor session status as busy during a run and idle after completion', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let releaseStream;
    const streamReady = new Promise((resolve) => {
      releaseStream = resolve;
    });
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'edit_1',
              name: 'edit',
              status: 'completed',
              args: { path: 'src/a.ts' },
              result: 'edited',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'working' }],
              },
            },
          };
          await streamReady;
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: ' done' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_status',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_status_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await waitFor(async () => (
      runtime.getSessionStatus?.().ses_status?.type === 'busy' ? true : null
    ));
    expect(runtime.getSessionStatus?.().ses_status).toEqual({ type: 'busy' });

    releaseStream();

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_status');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('working done');
    await waitFor(async () => (
      runtime.getSessionStatus?.().ses_status?.type === 'idle' ? true : null
    ));
    expect(runtime.getSessionStatus?.().ses_status).toEqual({ type: 'idle' });
  });

  it('continues a Grok parent run when a generic Cursor task uses Composer 2.5', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let cancelled = false;
    let sentModelSelection = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Cursor: {
          models: {
            list: async () => [{
              id: 'grok-4.5',
              displayName: 'Grok 4.5',
              parameters: [
                { id: 'effort', values: [{ value: 'low' }] },
                { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
              ],
              variants: [{
                displayName: 'Grok 4.5 Low',
                isDefault: true,
                params: [
                  { id: 'effort', value: 'low' },
                  { id: 'fast', value: 'false' },
                ],
              }],
            }],
          },
        },
      }),
      createPromptRun: async ({ modelSelection }) => ({
        cancel: async () => {
          cancelled = true;
        },
        stream: async function* stream() {
          sentModelSelection = modelSelection;
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Explore with a subagent',
                prompt: 'Read-only exploration',
                model: {
                  id: 'composer-2.5',
                  params: [{ id: 'fast', value: 'false' }],
                },
              },
              result: 'Subagent completed on Composer 2.5.',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'continued on the Grok parent' }],
              },
            },
          };
        },
      }),
    });

    await runtime.getVirtualProvider();
    await runtime.handlePromptAsync({
      sessionID: 'ses_model_boundary',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'grok-4.5' },
        variant: 'low',
        messageID: 'msg_model_boundary_user',
        parts: [{ type: 'text', text: 'delegate and continue on Grok' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_model_boundary');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const taskPart = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(sentModelSelection).toEqual({
      id: 'grok-4.5',
      params: [
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(cancelled).toBe(false);
    await waitFor(async () => (
      runtime.getSessionStatus?.().ses_model_boundary?.type === 'idle' ? true : null
    ));
    expect(runtime.getSessionStatus?.().ses_model_boundary).toEqual({ type: 'idle' });
    expect(runtime.getRuntimeStatus().lastCancellation).toBeNull();
    expect(assistant?.info.finish).toBe('stop');
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('continued on the Grok parent');
    expect(taskPart?.output).toBe('Subagent completed on Composer 2.5.');
    expect(taskPart?.state).toMatchObject({
      status: 'completed',
      input: {
        model: {
          id: 'composer-2.5',
          params: [{ id: 'fast', value: 'false' }],
        },
      },
    });
  });

  it('preserves Task input, output, metadata, and terminal status across split SDK events', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_split_1',
              name: 'task',
              status: 'running',
              args: {
                description: 'Explore with a subagent',
                model: {
                  id: 'composer-2.5',
                  params: [{ id: 'fast', value: 'false' }],
                },
              },
              metadata: { startedBy: 'cursor' },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_split_1',
              name: 'task',
              status: 'completed',
              result: 'Subagent completed on Composer 2.5.',
              metadata: { resultSource: 'sdk' },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_split_1',
              name: 'task',
              status: 'running',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'parent continued' }] },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_split_task_events',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'grok-4.5' },
        messageID: 'msg_split_task_events_user',
        parts: [{ type: 'text', text: 'delegate and continue' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_split_task_events');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });
    const taskPart = records?.[1]?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(taskPart?.input).toEqual({
      description: 'Explore with a subagent',
      model: {
        id: 'composer-2.5',
        params: [{ id: 'fast', value: 'false' }],
      },
    });
    expect(taskPart?.output).toBe('Subagent completed on Composer 2.5.');
    expect(taskPart?.state).toMatchObject({
      status: 'completed',
      metadata: {
        startedBy: 'cursor',
        resultSource: 'sdk',
      },
    });
    expect(taskPart?.state?.time?.end).toEqual(expect.any(Number));
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('parent continued');
    await runtime.dispose();
  });

  it('continues a Cursor parent run when a named custom task reports a different model', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let cancelled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      resolveAgentDefinitions: async () => ({
        explorer: {
          description: 'Read-only code explorer',
          prompt: 'Inspect the repository and report findings.',
          model: 'inherit',
        },
      }),
      createPromptRun: async () => ({
        cancel: async () => {
          cancelled = true;
        },
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_named_model_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Explore with the named agent',
                prompt: 'Read-only exploration',
                subagentType: { kind: 'custom', name: 'explorer' },
                model: 'composer-2.5',
              },
              result: 'Named subagent completed.',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'continued after named task' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_named_model_boundary',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
        messageID: 'msg_named_model_boundary_user',
        parts: [{ type: 'text', text: 'delegate to explorer' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_named_model_boundary');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const taskPart = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(cancelled).toBe(false);
    expect(assistant?.info.finish).toBe('stop');
    expect(taskPart?.state).toMatchObject({
      status: 'completed',
      input: {
        subagentType: { kind: 'custom', name: 'explorer' },
        model: 'composer-2.5',
      },
    });
    expect(taskPart?.output).toBe('Named subagent completed.');
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('continued after named task');
    expect(runtime.getRuntimeStatus().lastCancellation).toBeNull();
  });

  it('allows Cursor task subagents that use a configured explicit subagent model', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let cancelled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      resolveAgentDefinitions: async () => ({
        fixer: {
          description: 'Fast implementation specialist',
          prompt: 'Apply the requested fix.',
          model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
        },
      }),
      createPromptRun: async () => ({
        cancel: async () => {
          cancelled = true;
        },
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_configured_model_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Fix with a subagent',
                prompt: 'Apply a small edit',
                model: 'composer-2.5',
              },
              result: 'Subagent completed on its configured model.',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'continued after configured subagent' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_configured_subagent_model_boundary',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
        messageID: 'msg_configured_subagent_model_boundary_user',
        parts: [{ type: 'text', text: 'delegate to configured fixer model' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_configured_subagent_model_boundary');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const taskPart = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(cancelled).toBe(false);
    expect(assistant?.info.finish).toBe('stop');
    expect(taskPart?.state?.status).toBe('completed');
    expect(taskPart?.output).toBe('Subagent completed on its configured model.');
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('continued after configured subagent');
    expect(runtime.getRuntimeStatus().lastCancellation).toBeNull();
  });

  it('preserves structured model input for Cursor task subagents', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let cancelled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {
          cancelled = true;
        },
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_fast_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Explore with a subagent',
                prompt: 'Read-only exploration',
                model: {
                  id: 'composer-2.5',
                  params: [{ id: 'fast', value: 'true' }],
                },
              },
              result: 'Subagent completed on the inherited fast model.',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'continued after task' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_fast_model_boundary',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5-fast' },
        messageID: 'msg_fast_model_boundary_user',
        parts: [{ type: 'text', text: 'stay on composer 2.5 fast' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_fast_model_boundary');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const taskPart = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(cancelled).toBe(false);
    expect(assistant?.info.finish).toBe('stop');
    expect(taskPart?.state?.status).toBe('completed');
    expect(taskPart?.output).toBe('Subagent completed on the inherited fast model.');
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('continued after task');
    expect(runtime.getRuntimeStatus().lastCancellation).toBeNull();
  });

  it('continues the parent run when Cursor reports a different task fast toggle', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let cancelled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {
          cancelled = true;
        },
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_fast_mismatch_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Explore with a subagent',
                prompt: 'Read-only exploration',
                model: {
                  id: 'composer-2.5',
                  params: [{ id: 'fast', value: 'true' }],
                },
              },
              result: 'Subagent completed despite the fast toggle.',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'continued without abort' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_fast_mismatch_boundary',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_fast_mismatch_boundary_user',
        parts: [{ type: 'text', text: 'stay on composer 2.5 (non-fast)' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_fast_mismatch_boundary');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const taskPart = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(cancelled).toBe(false);
    expect(assistant?.info.finish).toBe('stop');
    expect(taskPart?.state?.status).toBe('completed');
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('continued without abort');
    expect(runtime.getRuntimeStatus().lastCancellation).toBeNull();
  });

  it('attaches Cursor task summary events to the active task tool output', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_summary_1',
              name: 'task',
              status: 'running',
              args: {
                description: 'Inspect spacing',
                prompt: 'Find spacing problems',
              },
            },
          };
          yield { type: 'message', message: { type: 'task', text: 'Explorer found the profile tab spacing issue.' } };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_summary_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Inspect spacing',
                prompt: 'Find spacing problems',
              },
              result: '',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'I will fix it next.' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_task_summary',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_task_summary_user',
        parts: [{ type: 'text', text: 'review profiles' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_task_summary');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const taskPart = assistant?.parts?.find((part) => part.type === 'tool' && part.tool === 'task');

    expect(taskPart?.output).toBe('Explorer found the profile tab spacing issue.');
    expect(taskPart?.state?.output).toBe('Explorer found the profile tab spacing issue.');
    expect(taskPart?.state?.metadata).toMatchObject({
      cursorTaskSummary: 'Explorer found the profile tab spacing issue.',
    });
    expect(assistant?.parts?.find((part) => part.type === 'text')?.text).toBe('I will fix it next.');
  });

  it('surfaces a diagnostic when Cursor ends the parent run immediately after a task', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        waitFinalResult: async () => ({
          ok: true,
          finalStatus: 'success',
          finalText: '',
        }),
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'task_empty_1',
              name: 'task',
              status: 'completed',
              args: {
                description: 'Inspect spacing',
                prompt: 'Find spacing problems',
              },
              result: 'Subagent completed.',
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_task_empty_finish',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_task_empty_finish_user',
        parts: [{ type: 'text', text: 'review profiles' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_task_empty_finish');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistant = records?.find((record) => record.info?.role === 'assistant');
    const text = assistant?.parts?.find((part) => part.type === 'text')?.text || '';

    expect(assistant?.info.finish).toBe('stop');
    expect(text).toContain('Cursor ended the parent run immediately after a subagent task completed');
    expect(text).not.toBe('Completed the requested work. See the tool activity above for details.');
    expect(runtime.getRuntimeStatus().lastPostTaskEmptyFinish).toMatchObject({
      sessionID: 'ses_task_empty_finish',
      assistantMessageID: 'msg_task_empty_finish_user_assistant',
      at: expect.any(Number),
    });
  });

  it('records explicit user aborts separately from provider cancellations', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    let releaseStream;
    const streamReleased = new Promise((resolve) => {
      releaseStream = resolve;
    });
    let cancelled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {
          cancelled = true;
          releaseStream();
        },
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'working' }],
              },
            },
          };
          await streamReleased;
          yield {
            type: 'status',
            status: 'CANCELLED',
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_abort',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_abort_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await waitFor(async () => (
      runtime.getSessionStatus?.().ses_abort?.type === 'busy' ? true : null
    ));

    expect(await runtime.abortSession('ses_abort')).toBe(true);

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_abort');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(cancelled).toBe(true);
    expect(records?.find((record) => record.info?.role === 'assistant')?.info.finish).toBe('cancelled');
    expect(runtime.getRuntimeStatus().lastCancellation).toMatchObject({
      sessionID: 'ses_abort',
      assistantMessageID: 'msg_abort_user_assistant',
      source: 'user_abort',
      finalStatus: 'cancelled',
    });
  });

  it('stops forwarding Cursor stream deltas the moment a user abort lands (no post-stop flood)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const emitted = [];
    let firstDeltaYielded;
    const firstDelta = new Promise((resolve) => {
      firstDeltaYielded = resolve;
    });
    let releaseTail;
    const tailGate = new Promise((resolve) => {
      releaseTail = resolve;
    });
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (event) => emitted.push(event),
      createPromptRun: async () => ({
        // A slow SDK cancel that does NOT unblock the stream — mimics the
        // cursor-agent continuing to flush buffered deltas after Stop while the
        // underlying cancel is still settling. The pump must not wait on it.
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'before-stop' }] },
            },
          };
          firstDeltaYielded();
          await tailGate;
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'AFTER-STOP-TAIL' }] },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_abort_no_flood',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_no_flood_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await firstDelta;
    await waitFor(async () => (
      emitted.some((event) => (
        event?.type === 'message.part.updated'
        && event.properties?.part?.text === 'before-stop'
      )) ? true : null
    ));

    expect(await runtime.abortSession('ses_abort_no_flood')).toBe(true);

    // The run finalizes as cancelled from the abort signal alone — the tail is
    // still gated, so reaching `finish` here proves the pump did not wait to
    // drain the stream.
    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_abort_no_flood');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });
    expect(records?.find((record) => record.info?.role === 'assistant')?.info.finish).toBe('cancelled');
    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(runtime.getRuntimeStatus().lastCancellation).toMatchObject({
      sessionID: 'ses_abort_no_flood',
      source: 'user_abort',
      finalStatus: 'cancelled',
    });

    // Release the buffered tail the cursor-agent had queued behind the cancel.
    // The pump already left, so this delta must never reach the renderer — that
    // post-stop forwarding is exactly what froze the UI.
    releaseTail();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const tailForwarded = emitted.some((event) => (
      event?.type === 'message.part.updated'
      && typeof event.properties?.part?.text === 'string'
      && event.properties.part.text.includes('AFTER-STOP-TAIL')
    ));
    expect(tailForwarded).toBe(false);
  });

  it('repairs persisted SDK assistant parent ids and stale running tools on read', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    writeFileSync(
      join(tempDir, 'ses_1.json'),
      `${JSON.stringify({
        sessionID: 'ses_1',
        agentID: null,
        records: [
          {
            info: {
              id: 'msg_e999_user',
              sessionID: 'ses_1',
              role: 'user',
              time: { created: 10 },
            },
            parts: [],
          },
          {
            info: {
              id: 'msg_e999_user_assistant',
              sessionID: 'ses_1',
              role: 'assistant',
              finish: 'stop',
              time: { created: 11, completed: 20 },
            },
            parts: [
              {
                id: 'msg_e999_user_assistant_tool_1',
                sessionID: 'ses_1',
                messageID: 'msg_e999_user_assistant',
                type: 'tool',
                tool: 'grep',
                input: { pattern: 'Open request form' },
                output: 'src/a.ts:1:Open request form',
                state: { status: 'running', time: { start: 12 } },
              },
            ],
          },
        ],
      })}\n`,
    );
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {},
      }),
    });

    const records = await runtime.getSessionMessages('ses_1');

    expect(records[1]?.info.parentID).toBe('msg_e999_user');
    expect(records[1]?.parts?.[0]?.state).toMatchObject({
      status: 'completed',
      input: { pattern: 'Open request form' },
      output: 'src/a.ts:1:Open request form',
      time: { start: 12, end: 20 },
    });
  });

  it('synthesizes an apply_patch tool when a Cursor SDK run changes the workspace diff', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+line',
    ].join('\n');
    const diffs = ['', patch];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      getWorkspaceDiff: async () => diffs.shift() ?? patch,
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'edit_1',
              name: 'edit',
              status: 'completed',
              args: { path: 'src/a.ts' },
              result: 'edited',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'edited' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const patchTool = records?.[1]?.parts?.find((part) => part.type === 'tool' && part.tool === 'apply_patch');
    expect(patchTool?.state).toMatchObject({
      status: 'completed',
      output: 'Applied 1 patch.',
      metadata: {
        files: [
          {
            relativePath: 'src/a.ts',
            additions: 2,
            deletions: 1,
          },
        ],
      },
    });
    expect(patchTool?.state?.metadata?.patchText).toContain('+line');
  });

  it('adds scoped diff summary metadata to Cursor user messages when the workspace changes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+line',
    ].join('\n');
    const diffs = ['', patch];
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      getWorkspaceDiff: async () => diffs.shift() ?? patch,
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'edit_1',
              name: 'edit',
              status: 'completed',
              args: { path: 'src/a.ts' },
              result: 'edited',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'edited' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[0]?.info.summary).toEqual({
      diffs: [{ file: 'src/a.ts', additions: 2, deletions: 1 }],
    });
    expect(emitted.some((event) => (
      event?.type === 'message.updated'
      && event.properties?.info?.id === 'msg_e999_user'
      && event.properties.info.summary?.diffs?.[0]?.file === 'src/a.ts'
    ))).toBe(true);
  });

  it('does not synthesize diff metadata for search-only Cursor SDK turns', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+line',
    ].join('\n');
    const diffs = ['', patch];
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      getWorkspaceDiff: async () => diffs.shift() ?? patch,
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'grep_1',
              name: 'grep',
              status: 'completed',
              args: { pattern: 'old' },
              result: 'src/a.ts:1:old',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'read_1',
              name: 'read',
              status: 'completed',
              args: { path: 'src/a.ts' },
              result: 'old',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'searched only' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_search_only',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_search_only_user',
        parts: [{ type: 'text', text: 'search for old' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_search_only');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(records?.[0]?.info.summary).toBe(undefined);
    expect(records?.[1]?.parts?.some((part) => part.type === 'tool' && part.tool === 'apply_patch')).toBe(false);
    expect(emitted.some((event) => (
      event?.type === 'message.updated'
      && event.properties?.info?.id === 'msg_search_only_user'
      && Array.isArray(event.properties.info.summary?.diffs)
    ))).toBe(false);
  });

  it('emits the synthesized apply_patch tool before finalizing the assistant turn', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+line',
    ].join('\n');
    const diffs = ['', patch, patch];
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      getWorkspaceDiff: async () => diffs.shift() ?? patch,
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_1',
              name: 'bash',
              status: 'completed',
              args: { command: 'perl -0pi -e s/old/new/ src/a.ts' },
              result: 'done',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'edited' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish);
    });

    const patchEventIndex = emitted.findIndex((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.type === 'tool'
      && event.properties.part.tool === 'apply_patch'
    ));
    const finalEventIndex = emitted.findIndex((event) => (
      event?.type === 'message.updated'
      && event.properties?.info?.role === 'assistant'
      && event.properties.info.finish === 'stop'
    ));

    expect(patchEventIndex).toBeGreaterThan(-1);
    expect(finalEventIndex).toBeGreaterThan(-1);
    expect(patchEventIndex).toBeLessThan(finalEventIndex);
  });

  it('emits message.part.removed when a synthesized Cursor patch disappears before finalization', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const diffs = ['', patch, ''];
    const emitted = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => emitted.push(payload),
      getWorkspaceDiff: async () => diffs.shift() ?? '',
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'edit_1',
              name: 'edit',
              status: 'completed',
              args: { path: 'src/a.ts' },
              result: 'edited',
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'reverted before finishing' }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_patch_removed',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_patch_removed_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_patch_removed');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const patchEvent = emitted.find((event) => (
      event?.type === 'message.part.updated'
      && event.properties?.part?.tool === 'apply_patch'
    ));
    expect(patchEvent).toBeTruthy();
    expect(emitted).toContainEqual({
      type: 'message.part.removed',
      properties: {
        messageID: 'msg_patch_removed_user_assistant',
        partID: patchEvent.properties.part.id,
      },
    });
    expect(records?.[1]?.parts?.some((part) => part.tool === 'apply_patch')).toBe(false);
  });

  it('marks SDK stream failures as completed error messages and clears active status', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'partial' }],
              },
            },
          };
          throw new Error('stream exploded');
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        agent: 'builder',
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish === 'error')
        ? current
        : null;
    });

    expect(runtime.getRuntimeStatus()).toMatchObject({
      activeRuns: 0,
      lastError: 'stream exploded',
    });
    expect(records?.[1]?.info).toMatchObject({
      role: 'assistant',
      finish: 'error',
    });
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('partial');
  });

  it('creates a fresh Cursor agent when a saved agent id is stale', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    writeFileSync(
      join(tempDir, 'ses_1.json'),
      `${JSON.stringify({ sessionID: 'ses_1', agentID: 'agent-stale', records: [] })}\n`,
    );
    let created = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      loadSdk: async () => ({
        Agent: {
          resume: async () => {
            throw new Error('Agent agent-stale not found');
          },
          create: async () => {
            created = true;
            return {
              agentId: 'agent-fresh',
              send: async () => ({
                stream: async function* stream() {
                  yield {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: 'fresh' }],
                    },
                  };
                },
              }),
            };
          },
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_e999_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_1');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(created).toBe(true);
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('fresh');
  });

  it('injects a plan card sentinel for plan-mode prompts that omit it', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Cursor Plan Card Fix',
      '',
      '## Context',
      '',
      'Cursor models omit the sentinel.',
      '',
      '## Implementation',
      '',
      '1. Add fallback detection.',
    ].join('\n');

    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: structuredPlanBody }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_plan',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_plan_user',
        parts: [
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
            synthetic: true,
          },
          { type: 'text', text: 'make a plan' },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_plan');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const text = records?.[1]?.parts?.find((part) => part.type === 'text')?.text ?? '';
    expect(text.startsWith('<!--plan-->\n')).toBe(true);
    expect(text).toContain('## Context');
    expect(text).toContain('## Implementation');
  });

  it('detects plan mode when the visible prompt precedes synthetic plan instructions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Cursor Plan Card Fix',
      '',
      '## Context',
      '',
      'Cursor models omit the sentinel.',
      '',
      '## Implementation',
      '',
      '1. Add fallback detection.',
    ].join('\n');
    let capturedPrompt = '';

    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          cancel: async () => {},
          stream: async function* stream() {
            yield {
              type: 'message',
              message: {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: structuredPlanBody }],
                },
              },
            };
          },
        };
      },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_plan_visible_first',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_plan_visible_first_user',
        parts: [
          { type: 'text', text: 'make a plan' },
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
            synthetic: true,
          },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_plan_visible_first');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(capturedPrompt.startsWith('User has requested to enter plan mode')).toBe(true);
    expect(capturedPrompt).toContain('\n\nmake a plan');
    expect(records?.[0]?.info?.metadata).toMatchObject({ openchamberPlanMode: true });
    expect(records?.[0]?.parts?.map((part) => part.text)).toEqual([
      'make a plan',
      'User has requested to enter plan mode.\nProduce an implementation plan only.',
    ]);
    expect(records?.[0]?.parts?.[1]?.synthetic).toBe(true);
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text)
      .toBe(`<!--plan-->\n${structuredPlanBody}`);
  });

  it('normalizes streamed Cursor plan text before emitting the part update', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Cursor Plan Card Fix',
      '',
      '## Context',
      '',
      'Cursor models omit the sentinel.',
      '',
      '## Implementation',
      '',
      '1. Add fallback detection.',
    ].join('\n');
    const events = [];

    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (event) => {
        events.push(event);
      },
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: structuredPlanBody }],
              },
            },
          };
          yield {
            type: 'message',
            message: {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: structuredPlanBody }],
              },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_plan_stream_normalize',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_plan_stream_normalize_user',
        parts: [
          { type: 'text', text: 'make a plan' },
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
            synthetic: true,
          },
        ],
      },
    });

    await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_plan_stream_normalize');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const structuredPlanUpdates = events
      .filter((event) => event.type === 'message.part.updated')
      .map((event) => event.properties?.part)
      .filter((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(structuredPlanBody));
    const streamingStructuredPlanUpdates = structuredPlanUpdates.filter((part) => typeof part.time?.end !== 'number');

    expect(structuredPlanUpdates.length).toBeGreaterThan(0);
    expect(structuredPlanUpdates.every((part) => part.text.startsWith('<!--plan-->\n'))).toBe(true);
    expect(streamingStructuredPlanUpdates).toHaveLength(1);
  });

  it('promotes Cursor createPlan tool payloads into plan card text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-runtime-'));
    const structuredPlanBody = [
      '# Cursor Plan Card Fix',
      '',
      '## Context',
      '',
      'Cursor models can emit createPlan tool calls.',
      '',
      '## Implementation',
      '',
      '1. Promote the tool plan into a text part.',
      '',
      '## Verification',
      '',
      '1. Render the plan card.',
    ].join('\n');

    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => ({
        cancel: async () => {},
        stream: async function* stream() {
          yield {
            type: 'message',
            message: {
              type: 'tool_call',
              call_id: 'tool_plan',
              name: 'createPlan',
              status: 'completed',
              args: { plan: structuredPlanBody },
              result: { status: 'success', value: {} },
            },
          };
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_plan_tool',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_plan_tool_user',
        parts: [
          { type: 'text', text: 'make a plan' },
          {
            type: 'text',
            text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
            synthetic: true,
          },
        ],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_plan_tool');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    const assistantParts = records?.[1]?.parts ?? [];
    expect(assistantParts.map((part) => part.type)).toEqual(['tool', 'text']);
    expect(assistantParts[0]?.tool).toBe('createPlan');
    expect(assistantParts[1]?.text).toBe(`<!--plan-->\n${structuredPlanBody}`);
  });
});
