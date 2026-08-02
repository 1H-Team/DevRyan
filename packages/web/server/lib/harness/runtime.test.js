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
    await runtime.drain();
  });
});
