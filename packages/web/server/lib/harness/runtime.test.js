import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebHarnessRuntime } from './runtime.js';

const temporaryDirectories = [];

const createResponse = () => {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = {};
  response.body = null;
  response.setHeader = (name, value) => {
    response.headers[name] = value;
  };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('web harness prompt admission', () => {
  it('returns retryable 503 before initialization and records only accepted prompts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({
      dataDirectory: directory,
      runtime: 'test',
    });
    const recordPromptAccepted = vi.fn();
    const middleware = runtime.promptAdmissionMiddleware({ recordPromptAccepted });
    const request = {
      method: 'POST',
      principal: { id: 'user-1', role: 'developer', scope: 'managed' },
      params: { sessionID: 'ses_1' },
      query: { directory: '/repo' },
      headers: { 'x-openchamber-message-id': 'msg_1' },
      body: { parts: [{ type: 'text', text: 'hello' }] },
    };

    const initializingResponse = createResponse();
    const initializingNext = vi.fn();
    middleware(request, initializingResponse, initializingNext);
    expect(initializingResponse.statusCode).toBe(503);
    expect(initializingResponse.headers['Retry-After']).toBe('1');
    expect(initializingResponse.body).toMatchObject({ code: 'HARNESS_INITIALIZING' });
    expect(initializingNext).not.toHaveBeenCalled();

    await runtime.initialize();
    const releaseRecoveryHold = runtime.acquirePromptAdmissionHold('context_mode_recovery', {
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
      error: 'Context-mode recovery is pending',
      retryAfterSeconds: 1,
    });
    const recoveryResponse = createResponse();
    middleware(request, recoveryResponse, vi.fn());
    expect(recoveryResponse.statusCode).toBe(503);
    expect(recoveryResponse.headers['Retry-After']).toBe('1');
    expect(recoveryResponse.body).toEqual({
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
      error: 'Context-mode recovery is pending',
    });
    releaseRecoveryHold();

    const acceptedResponse = createResponse();
    const acceptedNext = vi.fn();
    middleware(request, acceptedResponse, acceptedNext);
    expect(acceptedNext).toHaveBeenCalledOnce();
    acceptedResponse.statusCode = 202;
    acceptedResponse.emit('finish');
    expect(recordPromptAccepted).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      directory: '/repo',
    });

    const rejectedResponse = createResponse();
    middleware(request, rejectedResponse, vi.fn());
    rejectedResponse.statusCode = 500;
    rejectedResponse.emit('finish');
    expect(recordPromptAccepted).toHaveBeenCalledOnce();
    await runtime.journal.flush();
    const records = await runtime.journal.readRecords();
    expect(records.find((record) => record.type === 'prompt')).toMatchObject({
      actor: { id: 'user-1', role: 'developer', scope: 'managed' },
      sessionID: 'ses_1',
    });
    await runtime.drain();
  });

  it('bounds oversized prompt audit bodies while retaining a hash and actor', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const middleware = runtime.promptAdmissionMiddleware();
    const response = createResponse();
    middleware({
      method: 'POST',
      principal: { id: 'user-large', role: 'developer', scope: 'managed' },
      params: { sessionID: 'ses_large' },
      query: { directory: '/projects/project/developer' },
      headers: {},
      body: { parts: [{ type: 'text', text: 'x'.repeat(70 * 1024) }] },
    }, response, vi.fn());
    await runtime.journal.flush();

    const prompt = (await runtime.journal.readRecords()).find((record) => record.type === 'prompt');
    expect(prompt.actor).toEqual({ id: 'user-large', role: 'developer', scope: 'managed' });
    expect(prompt.payload.body).toMatchObject({
      truncated: true,
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(prompt.payload.body.size).toBeGreaterThan(64 * 1024);
    await runtime.drain();
  });

  it('records small prompt bodies verbatim without truncation metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-web-harness-'));
    temporaryDirectories.push(directory);
    const runtime = createWebHarnessRuntime({ dataDirectory: directory, runtime: 'test' });
    await runtime.initialize();
    const middleware = runtime.promptAdmissionMiddleware();
    const body = { parts: [{ type: 'text', text: 'small prompt' }] };
    middleware({
      method: 'POST',
      principal: { id: 'user-small', role: 'developer', scope: 'managed' },
      params: { sessionID: 'ses_small' },
      query: { directory: '/repo' },
      headers: {},
      body,
    }, createResponse(), vi.fn());
    await runtime.journal.flush();

    const prompt = (await runtime.journal.readRecords()).find((record) => record.type === 'prompt');
    expect(prompt.payload.body).toEqual(body);
    expect(prompt.payload.body.truncated).toBeUndefined();
    await runtime.drain();
  });
});
