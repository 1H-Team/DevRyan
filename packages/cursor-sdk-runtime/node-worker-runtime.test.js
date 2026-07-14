import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  createCursorSdkRuntime,
  resolveCursorSdkWorkerRuntimeConfig,
} from './index.js';

let tempDir = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const createFakeWorkerSpawn = (capture) => (command, args, options) => {
  const child = new EventEmitter();
  let rawInput = '';

  capture.calls.push({ command, args, options });
  child.exitCode = null;
  child.killed = false;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      rawInput += chunk.toString();
      callback();
    },
    final(callback) {
      capture.input = JSON.parse(rawInput);
      queueMicrotask(() => {
        child.stdout.push(`${JSON.stringify({
          type: 'message',
          message: {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'worker ok' }] },
          },
        })}\n`);
        child.stdout.push(`${JSON.stringify({ type: 'done', status: 'finished' })}\n`);
        child.stdout.push(null);
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      callback();
    },
  });
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 130;
    queueMicrotask(() => child.emit('close', child.exitCode, signal));
    return true;
  };

  return child;
};

const createFinalResultBeforeStreamWorkerSpawn = (capture) => (command, args, options) => {
  const child = new EventEmitter();
  let rawInput = '';

  capture.calls.push({ command, args, options });
  child.exitCode = null;
  child.killed = false;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      rawInput += chunk.toString();
      callback();
    },
    final(callback) {
      capture.input = JSON.parse(rawInput);
      queueMicrotask(() => {
        child.stdout.push(`${JSON.stringify({
          type: 'final-result',
          result: {
            ok: true,
            finalStatus: 'success',
            finalText: 'worker final text before stream completion',
          },
        })}\n`);
      });
      callback();
    },
  });
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 130;
    queueMicrotask(() => child.emit('close', child.exitCode, signal));
    return true;
  };

  return child;
};

const createFakeTitleWorkerSpawn = (capture) => (command, args, options) => {
  const child = new EventEmitter();
  let rawInput = '';

  capture.calls.push({ command, args, options });
  child.exitCode = null;
  child.killed = false;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      rawInput += chunk.toString();
      callback();
    },
    final(callback) {
      capture.input = JSON.parse(rawInput);
      queueMicrotask(() => {
        child.stdout.push(`${JSON.stringify({ type: 'title-result', title: '# Worker Generated Title.' })}\n`);
        child.stdout.push(null);
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      callback();
    },
  });
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 130;
    queueMicrotask(() => child.emit('close', child.exitCode, signal));
    return true;
  };

  return child;
};

const createFakePersistentWorkerSpawn = (capture, options = {}) => (command, args, spawnOptions) => {
  const child = new EventEmitter();
  let pendingInput = '';

  capture.calls.push({ command, args, options: spawnOptions });
  capture.children.push(child);
  child.exitCode = null;
  child.killed = false;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      pendingInput += chunk.toString();
      const lines = pendingInput.split('\n');
      pendingInput = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const commandPayload = JSON.parse(line);
        capture.commands.push(commandPayload);
        if (commandPayload.type === 'prepare' && options.autoRespond !== false) {
          queueMicrotask(() => {
            child.stdout.push(`${JSON.stringify({
              requestID: commandPayload.requestID,
              type: 'prepared',
              agentID: 'agent-prepared',
              cacheHit: false,
            })}\n`);
          });
        }
        if (commandPayload.type === 'prompt' && options.autoRespond !== false) {
          queueMicrotask(() => {
            child.stdout.push(`${JSON.stringify({
              requestID: commandPayload.requestID,
              type: 'message',
              message: {
                type: 'assistant',
                message: { content: [{ type: 'text', text: `persistent ${capture.commands.filter((entry) => entry.type === 'prompt').length}` }] },
              },
            })}\n`);
            child.stdout.push(`${JSON.stringify({
              requestID: commandPayload.requestID,
              type: 'final-result',
              result: { ok: true, finalStatus: 'success', finalText: '' },
            })}\n`);
            child.stdout.push(`${JSON.stringify({
              requestID: commandPayload.requestID,
              type: 'done',
              status: 'finished',
            })}\n`);
          });
        }
        if (commandPayload.type === 'title' && options.autoRespond !== false) {
          queueMicrotask(() => {
            child.stdout.push(`${JSON.stringify({
              requestID: commandPayload.requestID,
              type: 'title-result',
              title: 'Persistent Worker Title.',
            })}\n`);
          });
        }
      }
      callback();
    },
  });
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 130;
    queueMicrotask(() => {
      child.stdout.push(null);
      child.emit('close', child.exitCode, signal);
    });
    return true;
  };
  child.emitWorkerEvent = (payload) => {
    child.stdout.push(`${JSON.stringify(payload)}\n`);
  };

  if (options.autoReady !== false) {
    queueMicrotask(() => {
      child.stdout.push(`${JSON.stringify({ type: 'ready' })}\n`);
    });
  }

  return child;
};

const waitFor = async (predicate, timeoutMs = 500) => {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('Cursor SDK worker runtime config', () => {
  test('runs desktop Electron prompt work in an Electron-as-Node worker', () => {
    const config = resolveCursorSdkWorkerRuntimeConfig({
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      hasInjectedLoadSdk: false,
      isBunRuntime: false,
      isElectronRuntime: true,
      execPath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      nodeBinaryEnv: '',
      requestedNodeBinary: '',
      requestedUseNodeWorkerForPrompts: undefined,
      requestedWorkerCwd: '',
      requestedWorkerEnv: {},
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      ripgrepPath: '/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
    });

    expect(config.useNodeWorkerForPrompts).toBe(true);
    expect(config.nodeBinary).toBe('/Applications/DevRyan.app/Contents/MacOS/DevRyan');
    expect(config.workerCwd).toBe('/Applications/DevRyan.app/Contents/Resources');
    expect(config.workerEnv).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      CURSOR_SDK_RIPGREP_PATH: '/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
    });
  });

  test('passes configured worker process settings to spawned prompt workers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      nodeBinary: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      workerCwd: '/Applications/DevRyan.app/Contents/Resources',
      workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
      ripgrepPath: '/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
      spawnImpl: createFakeWorkerSpawn(capture),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_worker',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_worker_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].command).toBe('/Applications/DevRyan.app/Contents/MacOS/DevRyan');
    expect(capture.calls[0].args).toEqual([
      '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
    ]);
    expect(capture.calls[0].options.cwd).toBe('/tmp/project');
    expect(capture.calls[0].options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(capture.calls[0].options.env.CURSOR_SDK_RIPGREP_PATH).toBe('/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg');
    expect(capture.input.modelSelection).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
    });
  });

  test('generates titles through an ephemeral one-shot Cursor Auto worker request', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-title-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      nodeBinary: '/custom/node',
      workerPath: '/custom/title-worker.mjs',
      workerCwd: '/custom/cwd',
      spawnImpl: createFakeTitleWorkerSpawn(capture),
    });

    const title = await runtime.generateTitle({ text: 'Summarize this Cursor prompt', directory: '/repo' });

    expect(title).toBe('Worker Generated Title');
    expect(capture.input).toMatchObject({
      type: 'title',
      apiKey: 'cursor-sdk-key',
      text: 'Summarize this Cursor prompt',
      directory: '/repo',
      modelID: 'auto',
      modelSelection: { id: 'auto' },
    });
    expect(capture.input.sessionID).toBeUndefined();
    expect(capture.input.agentID).toBeUndefined();
  });

  test('generates titles through the persistent worker without a prompt session request', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-title-'));
    const capture = { calls: [], commands: [], children: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
    });

    const title = await runtime.generateTitle({ text: 'Summarize persistent title', directory: '/repo' });

    expect(title).toBe('Persistent Worker Title');
    expect(capture.commands.filter((entry) => entry.type === 'title')).toHaveLength(1);
    expect(capture.commands.filter((entry) => entry.type === 'prompt')).toHaveLength(0);
    expect(capture.commands.find((entry) => entry.type === 'title')).toMatchObject({
      apiKey: 'cursor-sdk-key',
      text: 'Summarize persistent title',
      directory: '/repo',
      modelID: 'auto',
      modelSelection: { id: 'auto' },
    });

    await runtime.dispose();
  });

  test('passes inherited Cursor SDK subagent definitions to one-shot prompt workers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      spawnImpl: createFakeWorkerSpawn(capture),
      resolveAgentDefinitions: async () => ({
        explorer: {
          description: 'Read-only code explorer',
          prompt: 'Inspect the repository and report findings.',
          model: 'inherit',
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_worker_agents',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_worker_agents_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    expect(capture.input.agents).toEqual({
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository and report findings.',
        model: 'inherit',
      },
    });
  });

  test('passes explicit Cursor SDK subagent models to one-shot prompt workers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      spawnImpl: createFakeWorkerSpawn(capture),
      resolveAgentDefinitions: async () => ({
        fixer: {
          description: 'Fast implementation specialist',
          prompt: 'Apply the requested fix.',
          model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_worker_explicit_agent_model',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
        messageID: 'msg_worker_explicit_agent_model_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    expect(capture.input.agents).toEqual({
      fixer: {
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      },
    });
  });

  test('applies worker final result while stdout stream remains open', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      nodeBinary: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      workerCwd: '/Applications/DevRyan.app/Contents/Resources',
      workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
      spawnImpl: createFinalResultBeforeStreamWorkerSpawn(capture),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_worker_final',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_worker_final_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    let records = [];
    for (let index = 0; index < 25; index += 1) {
      records = await runtime.getSessionMessages('ses_worker_final');
      if (records.some((record) => record.info?.role === 'assistant' && record.info?.finish)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(records?.[1]?.info.finish).toBe('stop');
    expect(records?.[1]?.parts?.find((part) => part.type === 'text')?.text).toBe('worker final text before stream completion');
    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
  });

  test('passes data URL image attachments to prompt workers as Cursor data images', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      nodeBinary: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      workerCwd: '/Applications/DevRyan.app/Contents/Resources',
      workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
      spawnImpl: createFakeWorkerSpawn(capture),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_worker_image',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_worker_image_user',
        parts: [
          { type: 'text', text: 'describe this' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'sample.png',
            url: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      },
    });

    expect(capture.input.images).toEqual([
      { data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
  });

  test('encodes non-base64 data URL image attachments for prompt workers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-worker-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      nodeBinary: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      workerCwd: '/Applications/DevRyan.app/Contents/Resources',
      workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
      spawnImpl: createFakeWorkerSpawn(capture),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_worker_plain_image',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_worker_plain_image_user',
        parts: [
          { type: 'text', text: 'describe this' },
          {
            type: 'file',
            mime: 'image/svg+xml',
            filename: 'sample.svg',
            url: 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E',
          },
        ],
      },
    });

    expect(capture.input.images).toEqual([
      { data: 'PHN2Zz48L3N2Zz4=', mimeType: 'image/svg+xml' },
    ]);
  });

  test('direct Cursor SDK runs send data URL image attachments as Cursor data images', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-direct-'));
    let sentMessage = null;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      useNodeWorkerForPrompts: false,
      loadSdk: async () => ({
        Agent: {
          create: async () => ({
            agentId: 'agent_direct_image',
            send: async (message) => {
              sentMessage = message;
              return {
                status: 'finished',
                stream: async function* stream() {},
                wait: async () => ({ status: 'finished', result: 'ok' }),
              };
            },
          }),
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_direct_image',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_direct_image_user',
        parts: [
          { type: 'text', text: 'describe this' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'sample.png',
            url: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      },
    });

    expect(sentMessage.images).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png' }]);
    expect(sentMessage.text).toContain('describe this');
  });

  test('preserves provider-native task output and its failure reason when a run fails', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-partial-tool-failure-'));
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      createPromptRun: async () => ({
        async *stream() {
          yield {
            type: 'tool_call',
            call_id: 'call_partial_task',
            name: 'task',
            status: 'running',
            args: { subagent_type: 'explorer', description: 'Inspect provider activity' },
            result: { partialSummary: 'Inspected 12 files before disconnecting' },
          };
          yield {
            type: 'tool_call',
            call_id: 'call_partial_task',
            name: 'task',
            status: 'error',
            result: {
              status: 'error',
              error: { message: 'subagent failed after partial output' },
            },
          };
          yield {
            type: 'tool_call',
            call_id: 'call_string_failure_task',
            name: 'task',
            status: 'running',
            args: { subagent_type: 'reviewer', description: 'Review provider activity' },
            result: { partialSummary: 'Reviewed the retained partial result' },
          };
          yield {
            type: 'tool_call',
            call_id: 'call_string_failure_task',
            name: 'task',
            status: 'error',
            result: 'reviewer stopped unexpectedly',
          };
          throw new Error('provider disconnected after partial output');
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_partial_tool_failure',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_partial_tool_failure_user',
        parts: [{ type: 'text', text: 'write the file' }],
      },
    });

    const records = await waitFor(async () => {
      const next = await runtime.getSessionMessages('ses_partial_tool_failure');
      return next.some((record) => record.info?.role === 'assistant' && record.info?.finish) ? next : null;
    });
    const assistant = records.find((record) => record.info?.role === 'assistant');
    const nestedFailureTool = assistant?.parts?.find((part) => part.id?.endsWith('call_partial_task'));
    const stringFailureTool = assistant?.parts?.find((part) => part.id?.endsWith('call_string_failure_task'));

    expect(assistant?.info.finish).toBe('error');
    expect(nestedFailureTool?.state?.status).toBe('error');
    expect(nestedFailureTool?.state?.output).toContain('"partialSummary": "Inspected 12 files before disconnecting"');
    expect(nestedFailureTool?.state?.error).toBe('subagent failed after partial output');
    expect(stringFailureTool?.state?.status).toBe('error');
    expect(stringFailureTool?.state?.output).toContain('"partialSummary": "Reviewed the retained partial result"');
    expect(stringFailureTool?.state?.error).toBe('reviewer stopped unexpectedly');

    await runtime.dispose();
  });

  test('non-data image URLs are rejected before calling the Cursor SDK', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-url-image-'));
    let promptRunCalled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      createPromptRun: async () => {
        promptRunCalled = true;
        throw new Error('should not call Cursor SDK');
      },
    });

    const result = await runtime.handlePromptAsync({
      sessionID: 'ses_url_image',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_url_image_user',
        parts: [
          { type: 'text', text: 'describe this' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'remote.png',
            url: 'https://example.com/remote.png',
          },
        ],
      },
    });

    const records = await runtime.getSessionMessages('ses_url_image');
    const assistantText = records
      .find((record) => record.info.role === 'assistant')
      ?.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n') || '';

    expect(promptRunCalled).toBe(false);
    expect(result).toEqual({ handled: true, status: 204, body: null });
    expect(assistantText).toContain('Cursor SDK provider sessions support data-backed image attachments only.');
    expect(assistantText).not.toContain('Cursor SDK error: URL images');
  });

  test('non-image attachments still produce the unsupported Cursor attachment message', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-pdf-'));
    let promptRunCalled = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      createPromptRun: async () => {
        promptRunCalled = true;
        throw new Error('should not call Cursor SDK');
      },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_pdf_attachment',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_pdf_attachment_user',
        parts: [
          { type: 'text', text: 'read this' },
          {
            type: 'file',
            mime: 'application/pdf',
            filename: 'document.pdf',
            url: 'data:application/pdf;base64,JVBERi0xLjQ=',
          },
        ],
      },
    });

    const records = await runtime.getSessionMessages('ses_pdf_attachment');
    const assistantText = records
      .find((record) => record.info.role === 'assistant')
      ?.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n') || '';

    expect(promptRunCalled).toBe(false);
    expect(assistantText).toContain('Cursor SDK provider sessions support image attachments only.');
    expect(assistantText).toContain('document.pdf (application/pdf)');
  });

  test('reuses one persistent worker across sequential Composer 2.5 prompts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-worker-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      nodeBinary: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      workerCwd: '/Applications/DevRyan.app/Contents/Resources',
      workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
      ripgrepPath: '/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
      spawnImpl: createFakePersistentWorkerSpawn(capture),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_persistent',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_persistent_1_user',
        parts: [{ type: 'text', text: 'hello one' }],
      },
    });
    await waitFor(async () => {
      const records = await runtime.getSessionMessages('ses_persistent');
      return records.some((record) => record.info?.id === 'msg_persistent_1_user_assistant' && record.info?.finish);
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_persistent',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_persistent_2_user',
        parts: [{ type: 'text', text: 'hello two' }],
      },
    });
    await waitFor(async () => {
      const records = await runtime.getSessionMessages('ses_persistent');
      return records.some((record) => record.info?.id === 'msg_persistent_2_user_assistant' && record.info?.finish);
    });

    const promptCommands = capture.commands.filter((entry) => entry.type === 'prompt');
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].args).toEqual([
      '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/persistent-worker.mjs',
    ]);
    expect(capture.calls[0].options.cwd).toBe('/tmp/project');
    expect(capture.calls[0].options.env.CURSOR_SDK_RIPGREP_PATH).toBe('/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg');
    expect(promptCommands).toHaveLength(2);
    expect(promptCommands[0].modelSelection).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'false' }],
    });
    expect(runtime.getRuntimeStatus()).toMatchObject({
      workerMode: 'persistent-node-worker',
      workerReady: true,
      workerRestarts: 0,
      ripgrepConfigured: true,
      ripgrepSource: 'explicit',
    });

    await runtime.dispose();
    expect(capture.children[0].killed).toBe(true);
  });

  test('isolates persistent Node workers by project directory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-directories-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
    });

    for (const [sessionID, directory] of [
      ['ses_project_a', '/tmp/project-a'],
      ['ses_project_b', '/tmp/project-b'],
    ]) {
      await runtime.handlePromptAsync({
        sessionID,
        directory,
        body: {
          model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
          messageID: `${sessionID}_user`,
          parts: [{ type: 'text', text: 'hello' }],
        },
      });
      await waitFor(async () => {
        const records = await runtime.getSessionMessages(sessionID);
        return records.some((record) => record.info?.id === `${sessionID}_user_assistant` && record.info?.finish);
      });
    }

    expect(capture.calls.map((call) => call.options.cwd)).toEqual([
      '/tmp/project-a',
      '/tmp/project-b',
    ]);

    await runtime.dispose();
    expect(capture.children.every((child) => child.killed)).toBe(true);
  });

  test('caps simultaneous cold persistent workers and falls back to one-shot for the fourth directory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-cold-cap-'));
    const capture = { calls: [], children: [], commands: [], input: null };
    const persistentSpawn = createFakePersistentWorkerSpawn(capture, { autoReady: false });
    const oneShotSpawn = createFakeWorkerSpawn(capture);
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: (command, args, options) => (
        args[0]?.endsWith('persistent-worker.mjs')
          ? persistentSpawn(command, args, options)
          : oneShotSpawn(command, args, options)
      ),
      logger: { warn: () => {}, error: () => {} },
    });

    const starts = Array.from({ length: 4 }, (_, index) => runtime.handlePromptAsync({
      sessionID: `ses_cold_cap_${index}`,
      directory: `/tmp/cold-cap-${index}`,
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: `msg_cold_cap_${index}_user`,
        parts: [{ type: 'text', text: `hello ${index}` }],
      },
    }));

    await waitFor(() => (capture.calls.length === 4 ? true : null));
    expect(capture.calls.filter((call) => call.args[0]?.endsWith('persistent-worker.mjs'))).toHaveLength(3);
    expect(capture.calls.filter((call) => call.args[0]?.endsWith('node-worker.mjs'))).toHaveLength(1);

    for (const child of capture.children) {
      child.emitWorkerEvent({ type: 'ready' });
    }
    await Promise.all(starts);
    await runtime.dispose();
  });

  test('falls back to one-shot when three directory workers all have active prompts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-busy-cap-'));
    const capture = { calls: [], children: [], commands: [], input: null };
    const persistentSpawn = createFakePersistentWorkerSpawn(capture, { autoRespond: false });
    const oneShotSpawn = createFakeWorkerSpawn(capture);
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: (command, args, options) => (
        args[0]?.endsWith('persistent-worker.mjs')
          ? persistentSpawn(command, args, options)
          : oneShotSpawn(command, args, options)
      ),
      logger: { warn: () => {}, error: () => {} },
    });

    for (let index = 0; index < 3; index += 1) {
      await runtime.handlePromptAsync({
        sessionID: `ses_busy_cap_${index}`,
        directory: `/tmp/busy-cap-${index}`,
        body: {
          model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
          messageID: `msg_busy_cap_${index}_user`,
          parts: [{ type: 'text', text: `hello ${index}` }],
        },
      });
    }
    await waitFor(() => (
      capture.commands.filter((command) => command.type === 'prompt').length === 3 ? true : null
    ));

    await runtime.handlePromptAsync({
      sessionID: 'ses_busy_cap_fourth',
      directory: '/tmp/busy-cap-fourth',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_busy_cap_fourth_user',
        parts: [{ type: 'text', text: 'hello fourth' }],
      },
    });

    expect(capture.calls.filter((call) => call.args[0]?.endsWith('persistent-worker.mjs'))).toHaveLength(3);
    expect(capture.calls.filter((call) => call.args[0]?.endsWith('node-worker.mjs'))).toHaveLength(1);
    await runtime.dispose();
  });

  test('does not evict reused workers while prompt admission is still registering requests', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-admission-cap-'));
    const capture = { calls: [], children: [], commands: [] };
    const admissionReleases = new Map();
    let pauseAdmissions = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
      resolveAgentDefinitions: async ({ directory }) => {
        if (!pauseAdmissions) return null;
        await new Promise((resolve) => {
          admissionReleases.set(directory, resolve);
        });
        return null;
      },
    });
    const directories = ['/tmp/admission-a', '/tmp/admission-b', '/tmp/admission-c'];

    for (const [index, directory] of directories.entries()) {
      await runtime.prewarmSession({
        sessionID: `ses_admission_seed_${index}`,
        directory,
        modelID: 'composer-2.5',
      });
    }
    expect(capture.calls).toHaveLength(3);

    pauseAdmissions = true;
    const admissions = [...directories, '/tmp/admission-fourth'].map((directory, index) => runtime.prewarmSession({
      sessionID: `ses_admission_live_${index}`,
      directory,
      modelID: 'composer-2.5',
    }));
    await waitFor(() => (admissionReleases.size === 4 ? true : null));

    for (const directory of directories) {
      admissionReleases.get(directory)?.();
    }
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    admissionReleases.get('/tmp/admission-fourth')?.();

    const results = await Promise.all(admissions);
    expect(capture.calls).toHaveLength(3);
    expect(results.slice(0, 3).every((result) => result.ok)).toBe(true);
    expect(results[3]).toMatchObject({
      ok: false,
      error: 'Cursor SDK persistent worker capacity (3) is full.',
    });
    await runtime.dispose();
    expect(capture.children.every((child) => child.killed)).toBe(true);
  });

  test('prewarms a session through the persistent worker prepare command', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-worker-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
    });

    const result = await runtime.prewarmSession({
      sessionID: 'ses_prepare',
      directory: '/tmp/project',
      modelID: 'composer-2.5',
      agent: 'builder',
    });

    const prepareCommand = await waitFor(() => capture.commands.find((entry) => entry.type === 'prepare'));
    expect(result).toEqual({
      ok: true,
      agentID: 'agent-prepared',
      cacheHit: false,
    });
    expect(prepareCommand).toMatchObject({
      apiKey: 'cursor-sdk-key',
      sessionID: 'ses_prepare',
      directory: '/tmp/project',
      modelID: 'composer-2.5',
      modelSelection: {
        id: 'composer-2.5',
        params: [{ id: 'fast', value: 'false' }],
      },
    });
    expect(capture.calls).toHaveLength(1);

    await runtime.dispose();
  });

  test('releases persistent worker Agent entries when session state is deleted', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-release-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
    });

    await runtime.prewarmSession({
      sessionID: 'ses_release',
      directory: '/tmp/project',
      modelID: 'composer-2.5',
    });
    expect(await runtime.deleteSessionState('ses_release')).toBe(true);

    const releaseCommand = await waitFor(() => (
      capture.commands.find((entry) => entry.type === 'release-session')
    ));
    expect(releaseCommand).toEqual({
      type: 'release-session',
      sessionID: 'ses_release',
    });

    await runtime.dispose();
  });

  test('passes inherited Cursor SDK subagent definitions to persistent prompt workers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-worker-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
      resolveAgentDefinitions: async () => ({
        explorer: {
          description: 'Read-only code explorer',
          prompt: 'Inspect the repository and report findings.',
          model: 'inherit',
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_persistent_agents',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_persistent_agents_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const promptCommand = await waitFor(() => capture.commands.find((entry) => entry.type === 'prompt'));

    expect(promptCommand.agents).toEqual({
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository and report findings.',
        model: 'inherit',
      },
    });

    await runtime.dispose();
  });

  test('passes explicit Cursor SDK subagent models to persistent prompt workers', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-worker-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
      resolveAgentDefinitions: async () => ({
        fixer: {
          description: 'Fast implementation specialist',
          prompt: 'Apply the requested fix.',
          model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
        },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_persistent_explicit_agent_model',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'gpt-5.5' },
        messageID: 'msg_persistent_explicit_agent_model_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const promptCommand = await waitFor(() => capture.commands.find((entry) => entry.type === 'prompt'));

    expect(promptCommand.agents).toEqual({
      fixer: {
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      },
    });

    await runtime.dispose();
  });

  test('routes interleaved persistent worker events by request id', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-routing-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture, { autoRespond: false }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_route_one',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_route_one_user',
        parts: [{ type: 'text', text: 'one' }],
      },
    });
    await runtime.handlePromptAsync({
      sessionID: 'ses_route_two',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_route_two_user',
        parts: [{ type: 'text', text: 'two' }],
      },
    });

    const promptCommands = await waitFor(() => (
      capture.commands.filter((entry) => entry.type === 'prompt').length === 2
        ? capture.commands.filter((entry) => entry.type === 'prompt')
        : null
    ));
    const child = capture.children[0];
    child.emitWorkerEvent({
      requestID: promptCommands[1].requestID,
      type: 'message',
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second response' }] },
      },
    });
    child.emitWorkerEvent({ requestID: promptCommands[1].requestID, type: 'done', status: 'finished' });
    child.emitWorkerEvent({
      requestID: promptCommands[0].requestID,
      type: 'message',
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first response' }] },
      },
    });
    child.emitWorkerEvent({ requestID: promptCommands[0].requestID, type: 'done', status: 'finished' });

    const firstRecords = await waitFor(async () => {
      const records = await runtime.getSessionMessages('ses_route_one');
      return records.some((record) => record.info?.role === 'assistant' && record.info?.finish) ? records : null;
    });
    const secondRecords = await waitFor(async () => {
      const records = await runtime.getSessionMessages('ses_route_two');
      return records.some((record) => record.info?.role === 'assistant' && record.info?.finish) ? records : null;
    });

    expect(firstRecords[1].parts.find((part) => part.type === 'text')?.text).toBe('first response');
    expect(secondRecords[1].parts.find((part) => part.type === 'text')?.text).toBe('second response');
    await runtime.dispose();
  });

  test('sends persistent worker cancel commands for active prompts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-cancel-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture, { autoRespond: false }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_cancel',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_cancel_user',
        parts: [{ type: 'text', text: 'cancel me' }],
      },
    });

    const promptCommand = await waitFor(() => capture.commands.find((entry) => entry.type === 'prompt'));
    await runtime.abortSession('ses_cancel');

    const cancelCommand = capture.commands.find((entry) => entry.type === 'cancel');
    expect(cancelCommand).toEqual({
      type: 'cancel',
      requestID: promptCommand.requestID,
    });
    await runtime.dispose();
  });

  test('abortSession frees the session immediately even when the underlying cancel never settles', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-abort-nonblock-'));
    const events = [];
    let cancelInvoked = false;
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => { events.push(payload); },
      // A run whose stream blocks forever and whose cancel never resolves. The
      // pre-fix abortSession awaited cancel and would hang here, wedging the
      // session so a follow-up model switch / prompt froze.
      createPromptRun: async () => ({
        async *stream() { await new Promise(() => {}); },
        cancel() { cancelInvoked = true; return new Promise(() => {}); },
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_hang',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_hang_user',
        parts: [{ type: 'text', text: 'stop me midway' }],
      },
    });

    await waitFor(() => (runtime.getRuntimeStatus().activeRuns === 1 ? true : null));

    // Must resolve promptly — the test times out against the pre-fix code.
    const aborted = await runtime.abortSession('ses_hang');

    expect(aborted).toBe(true);
    expect(cancelInvoked).toBe(true);
    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    const idleEvent = events.find(
      (event) => event?.type === 'session.status'
        && event?.properties?.sessionID === 'ses_hang'
        && event?.properties?.status?.type === 'idle',
    );
    expect(idleEvent).toBeTruthy();
    await runtime.dispose();
  });

  test('abortSession preserves provider-native task output and stops consuming cancel-tail events', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-abort-partial-task-'));
    const events = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: (payload) => { events.push(payload); },
      createPromptRun: async () => ({
        async *stream() {
          yield {
            type: 'tool_call',
            call_id: 'call_abort_partial_task',
            name: 'task',
            status: 'running',
            args: { subagent_type: 'explorer', description: 'Inspect before abort' },
            result: { partialSummary: 'Useful task output before abort' },
          };
          await new Promise(() => {});
        },
        cancel: async () => {},
      }),
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_abort_partial_task',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_abort_partial_task_user',
        parts: [{ type: 'text', text: 'inspect and report' }],
      },
    });

    await waitFor(async () => {
      const records = await runtime.getSessionMessages('ses_abort_partial_task');
      const task = records.flatMap((record) => record.parts || []).find((part) => part.tool === 'task');
      return task?.state?.output?.includes('Useful task output before abort') ? true : null;
    });
    expect(await runtime.abortSession('ses_abort_partial_task')).toBe(true);

    const records = await waitFor(async () => {
      const next = await runtime.getSessionMessages('ses_abort_partial_task');
      return next.some((record) => record.info?.role === 'assistant' && record.info?.finish) ? next : null;
    });
    const assistant = records.find((record) => record.info?.role === 'assistant');
    const task = assistant?.parts?.find((part) => part.tool === 'task');
    const eventCountAfterFinalization = events.length;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(assistant?.info.finish).toBe('cancelled');
    expect(task?.state?.status).toBe('cancelled');
    expect(task?.state?.output).toContain('Useful task output before abort');
    expect(task?.state?.error).toBeUndefined();
    expect(runtime.getRuntimeStatus().activeRuns).toBe(0);
    expect(events).toHaveLength(eventCountAfterFinalization);

    await runtime.dispose();
  });

  test('a new prompt supersedes and cancels a prior active run for the same session', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-supersede-'));
    const created = [];
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: {},
      emitEvent: () => {},
      createPromptRun: async () => {
        const run = {
          cancelCalled: false,
          async *stream() { await new Promise(() => {}); },
          cancel() { this.cancelCalled = true; return Promise.resolve(); },
        };
        created.push(run);
        return run;
      },
    });

    const send = (text, messageID) => runtime.handlePromptAsync({
      sessionID: 'ses_supersede',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID,
        parts: [{ type: 'text', text }],
      },
    });

    await send('first', 'msg_one');
    await waitFor(() => (created.length === 1 ? true : null));
    await send('second', 'msg_two');
    await waitFor(() => (created.length === 2 ? true : null));

    // The superseded run was cancelled, and only the new run remains active.
    expect(created[0].cancelCalled).toBe(true);
    expect(runtime.getRuntimeStatus().activeRuns).toBe(1);
    await runtime.dispose();
  });

  test('falls back to the one-shot worker when persistent worker startup fails before prompt submission', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-persistent-fallback-'));
    const capture = { calls: [], input: null };
    const spawnImpl = (command, args, options) => {
      if (capture.calls.length === 0) {
        const child = new EventEmitter();
        capture.calls.push({ command, args, options });
        child.exitCode = null;
        child.killed = false;
        child.stdout = new Readable({ read() {} });
        child.stderr = new Readable({ read() {} });
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = (signal) => {
          child.killed = true;
          child.exitCode = signal === 'SIGKILL' ? 137 : 130;
          queueMicrotask(() => child.emit('close', child.exitCode, signal));
          return true;
        };
        queueMicrotask(() => {
          child.emit('error', new Error('persistent worker failed before ready'));
          child.exitCode = 1;
          child.stdout.push(null);
          child.emit('close', 1, null);
        });
        return child;
      }
      return createFakeWorkerSpawn(capture)(command, args, options);
    };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      nodeBinary: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      workerPath: '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
      workerCwd: '/Applications/DevRyan.app/Contents/Resources',
      workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
      ripgrepPath: '/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg',
      spawnImpl,
      logger: { warn: () => {}, error: () => {} },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_fallback',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        messageID: 'msg_fallback_user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });

    const records = await waitFor(async () => {
      const current = await runtime.getSessionMessages('ses_fallback');
      return current.some((record) => record.info?.role === 'assistant' && record.info?.finish)
        ? current
        : null;
    });

    expect(capture.calls).toHaveLength(2);
    expect(capture.calls[0].args).toEqual([
      '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/persistent-worker.mjs',
    ]);
    expect(capture.calls[1].args).toEqual([
      '/Applications/DevRyan.app/Contents/Resources/app.asar/node_modules/@openchamber/cursor-sdk-runtime/node-worker.mjs',
    ]);
    expect(capture.calls[0].options.env.CURSOR_SDK_RIPGREP_PATH).toBe('/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg');
    expect(capture.calls[1].options.env.CURSOR_SDK_RIPGREP_PATH).toBe('/Applications/DevRyan.app/Contents/Resources/app.asar.unpacked/node_modules/@cursor/sdk-darwin-arm64/bin/rg');
    expect(records[1].parts.find((part) => part.type === 'text')?.text).toBe('worker ok');
    await runtime.dispose();
  });

  test('passes question MCP configuration through one-shot worker commands', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-question-one-shot-'));
    const capture = { calls: [], input: null };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      usePersistentWorkerForPrompts: false,
      spawnImpl: createFakeWorkerSpawn(capture),
      questionRuntime: {
        getMcpServerConfig: async () => ({
          identity: 'question-identity',
          mcpServers: {
            devryan_question: {
              type: 'http',
              url: 'http://127.0.0.1:43123/mcp/scope',
              headers: { Authorization: 'Bearer worker-secret' },
            },
          },
        }),
        listPendingQuestions: () => [],
        replyToQuestion: async () => false,
        rejectQuestion: async () => false,
        cancelSession: () => 0,
        revokeSessionScope: () => true,
        deleteSession: async () => false,
        dispose: async () => {},
      },
    });

    await runtime.handlePromptAsync({
      sessionID: 'ses_question_worker',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        agent: 'Builder',
        messageID: 'msg_question_worker',
        parts: [{ type: 'text', text: 'ask when ambiguous' }],
      },
    });

    await waitFor(() => capture.input);
    expect(capture.input.mcpServerIdentity).toBe('question-identity');
    expect(capture.input.mcpServers.devryan_question.headers.Authorization).toBe('Bearer worker-secret');
    await runtime.dispose();
  });

  test('passes question MCP configuration through persistent prompt and prewarm commands', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cursor-sdk-question-persistent-'));
    const capture = { calls: [], children: [], commands: [] };
    const runtime = createCursorSdkRuntime({
      storageDir: tempDir,
      readAuth: () => ({ 'cursor-acp': { key: 'cursor-sdk-key' } }),
      env: { OPENCHAMBER_RUNTIME: 'desktop' },
      useNodeWorkerForPrompts: true,
      spawnImpl: createFakePersistentWorkerSpawn(capture),
      questionRuntime: {
        getMcpServerConfig: async () => ({
          identity: 'persistent-question-identity',
          mcpServers: {
            devryan_question: {
              type: 'http',
              url: 'http://127.0.0.1:43123/mcp/scope',
              headers: { Authorization: 'Bearer persistent-secret' },
            },
          },
        }),
        listPendingQuestions: () => [],
        replyToQuestion: async () => false,
        rejectQuestion: async () => false,
        cancelSession: () => 0,
        revokeSessionScope: () => true,
        deleteSession: async () => false,
        dispose: async () => {},
      },
    });

    await runtime.prewarmSession({
      sessionID: 'ses_question_prewarm',
      directory: '/tmp/project',
      modelID: 'composer-2.5',
      agent: 'Orchestrator',
    });
    await runtime.handlePromptAsync({
      sessionID: 'ses_question_prompt',
      directory: '/tmp/project',
      body: {
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
        agent: 'Builder',
        messageID: 'msg_question_prompt',
        parts: [{ type: 'text', text: 'ask when ambiguous' }],
      },
    });

    const prepare = await waitFor(() => capture.commands.find((entry) => entry.type === 'prepare'));
    const prompt = await waitFor(() => capture.commands.find((entry) => entry.type === 'prompt'));
    for (const command of [prepare, prompt]) {
      expect(command.mcpServerIdentity).toBe('persistent-question-identity');
      expect(command.mcpServers.devryan_question.headers.Authorization).toBe('Bearer persistent-secret');
    }
    await runtime.dispose();
  });
});
