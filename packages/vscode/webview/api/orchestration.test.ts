import { describe, expect, it, vi } from 'vitest';

import { handleManagedOrchestrationApiRequest } from './orchestration';

const responseJson = async (response: Response | null) => {
  if (!response) throw new TypeError('expected a response');
  return { status: response.status, body: await response.json() as unknown };
};

describe('VS Code managed orchestration webview API', () => {
  it('routes scoped snapshot and task status requests through the extension host', async () => {
    const send = vi.fn(async (_type: string, payload: unknown) => ({
      status: 200,
      body: { payload },
    }));

    const snapshot = await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/snapshot?rootSessionId=ses_root'),
      method: 'GET',
      send,
    });
    expect(await responseJson(snapshot)).toEqual({
      status: 200,
      body: { payload: { action: 'snapshot', rootSessionId: 'ses_root' } },
    });

    const status = await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/task/dvr_task_1?rootSessionId=ses_root&directory=%2Fworkspace'),
      method: 'GET',
      send,
    });
    expect(await responseJson(status)).toEqual({
      status: 200,
      body: {
        payload: {
          action: 'status',
          taskId: 'dvr_task_1',
          rootSessionId: 'ses_root',
          directory: '/workspace',
        },
      },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([type]) => type === 'api:orchestration:request')).toBe(true);
  });

  it('routes cancel and acknowledge bodies without allowing body task identity to win', async () => {
    const send = vi.fn(async (_type: string, payload: unknown) => ({ status: 202, body: payload }));
    const cancel = await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/task/dvr_task_path/cancel'),
      method: 'POST',
      readBody: async () => JSON.stringify({
        taskId: 'dvr_task_body',
        rootSessionId: 'ses_root',
        reason: 'stop',
      }),
      send,
    });
    expect(await responseJson(cancel)).toEqual({
      status: 202,
      body: {
        action: 'cancel',
        taskId: 'dvr_task_path',
        body: {
          taskId: 'dvr_task_body',
          rootSessionId: 'ses_root',
          reason: 'stop',
        },
      },
    });

    await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/task/dvr_task_path/acknowledge'),
      method: 'POST',
      readBody: async () => JSON.stringify({
        rootSessionId: 'ses_root',
        action: 'retry_in_place',
        providerId: 'openai',
        modelId: 'gpt-5.4',
        variant: 'high',
      }),
      send,
    });
    expect(send).toHaveBeenLastCalledWith('api:orchestration:request', {
      action: 'acknowledge',
      taskId: 'dvr_task_path',
      body: {
        rootSessionId: 'ses_root',
        action: 'retry_in_place',
        providerId: 'openai',
        modelId: 'gpt-5.4',
        variant: 'high',
      },
    });
  });

  it('preserves authoritative HTTP errors and rejects malformed or oversized bodies locally', async () => {
    const send = vi.fn(async () => ({
      status: 404,
      body: { ok: false, error: { code: 'task_not_found', message: 'missing' } },
    }));
    const missing = await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/task/dvr_task_missing?rootSessionId=ses_root'),
      method: 'GET',
      send,
    });
    expect(await responseJson(missing)).toEqual({
      status: 404,
      body: { ok: false, error: { code: 'task_not_found', message: 'missing' } },
    });

    const malformed = await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/task/dvr_task_1/cancel'),
      method: 'POST',
      readBody: async () => '{invalid',
      send,
    });
    expect(await responseJson(malformed)).toMatchObject({
      status: 400,
      body: { ok: false, error: { code: 'invalid_json' } },
    });

    const oversized = await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/orchestration/task/dvr_task_1/cancel'),
      method: 'POST',
      readBody: async () => JSON.stringify({ reason: 'x'.repeat(129 * 1024) }),
      send,
    });
    expect(await responseJson(oversized)).toMatchObject({
      status: 413,
      body: { ok: false, error: { code: 'body_too_large' } },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated API paths', async () => {
    const send = vi.fn();
    expect(await handleManagedOrchestrationApiRequest({
      url: new URL('https://webview.invalid/api/config/providers'),
      method: 'GET',
      send,
    })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
