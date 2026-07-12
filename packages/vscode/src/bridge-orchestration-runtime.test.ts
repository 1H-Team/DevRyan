import { describe, expect, it, vi } from 'vitest';

import { handleManagedOrchestrationBridgeMessage } from './bridge-orchestration-runtime';

describe('VS Code managed orchestration bridge', () => {
  it('returns null for unrelated bridge messages', async () => {
    const runtime = { getSnapshot: vi.fn(), handleRpc: vi.fn() };
    expect(await handleManagedOrchestrationBridgeMessage({
      id: 'req_1',
      type: 'api:config/settings:get',
    }, runtime)).toBeNull();
  });

  it('maps snapshot and task actions to the scoped runtime contract', async () => {
    const runtime = {
      getSnapshot: vi.fn(async () => ({ available: true, tasks: [] })),
      handleRpc: vi.fn(async () => ({ task: { taskId: 'dvr_task_1', status: 'running' } })),
    };

    const snapshot = await handleManagedOrchestrationBridgeMessage({
      id: 'req_snapshot',
      type: 'api:orchestration:request',
      payload: { action: 'snapshot', rootSessionId: 'ses_root' },
    }, runtime);
    expect(snapshot).toEqual({
      id: 'req_snapshot',
      type: 'api:orchestration:request',
      success: true,
      data: { status: 200, body: { available: true, tasks: [] } },
    });
    expect(runtime.getSnapshot).toHaveBeenCalledWith({ rootSessionId: 'ses_root' });

    const task = await handleManagedOrchestrationBridgeMessage({
      id: 'req_task',
      type: 'api:orchestration:request',
      payload: {
        action: 'status',
        taskId: 'dvr_task_1',
        rootSessionId: 'ses_root',
        directory: '/workspace',
      },
    }, runtime);
    expect(task?.data).toEqual({
      status: 200,
      body: { task: { taskId: 'dvr_task_1', status: 'running' } },
    });
    expect(runtime.handleRpc).toHaveBeenCalledWith({
      method: 'status',
      params: {
        taskId: 'dvr_task_1',
        rootSessionId: 'ses_root',
        directory: '/workspace',
      },
    });
  });

  it('maps cancel and acknowledge bodies without allowing path identity override', async () => {
    const runtime = {
      getSnapshot: vi.fn(),
      handleRpc: vi.fn(async ({ method }) => ({ method })),
    };

    await handleManagedOrchestrationBridgeMessage({
      id: 'req_cancel',
      type: 'api:orchestration:request',
      payload: {
        action: 'cancel',
        taskId: 'dvr_task_path',
        body: {
          taskId: 'dvr_task_body',
          rootSessionId: 'ses_root',
          directory: '/workspace',
          reason: 'stop one child',
        },
      },
    }, runtime);
    expect(runtime.handleRpc).toHaveBeenLastCalledWith({
      method: 'cancel',
      params: {
        taskId: 'dvr_task_path',
        rootSessionId: 'ses_root',
        directory: '/workspace',
        reason: 'stop one child',
      },
    });

    await handleManagedOrchestrationBridgeMessage({
      id: 'req_ack',
      type: 'api:orchestration:request',
      payload: {
        action: 'acknowledge',
        taskId: 'dvr_task_path',
        body: {
          rootSessionId: 'ses_root',
          action: 'retry_in_place',
          idempotencyKey: 'retry-1',
          providerId: 'openai',
          modelId: 'gpt-5.4',
          variant: 'high',
        },
      },
    }, runtime);
    expect(runtime.handleRpc).toHaveBeenLastCalledWith({
      method: 'acknowledge',
      params: {
        taskId: 'dvr_task_path',
        rootSessionId: 'ses_root',
        action: 'retry_in_place',
        idempotencyKey: 'retry-1',
        providerId: 'openai',
        modelId: 'gpt-5.4',
        variant: 'high',
      },
    });
  });

  it('preserves deterministic runtime status and error shape', async () => {
    const error = Object.assign(new Error('wrong root'), {
      code: 'task_scope_mismatch',
      statusCode: 403,
    });
    const runtime = {
      getSnapshot: vi.fn(),
      handleRpc: vi.fn(async () => { throw error; }),
    };

    const response = await handleManagedOrchestrationBridgeMessage({
      id: 'req_error',
      type: 'api:orchestration:request',
      payload: {
        action: 'status',
        taskId: 'dvr_task_1',
        rootSessionId: 'ses_other',
      },
    }, runtime);

    expect(response).toEqual({
      id: 'req_error',
      type: 'api:orchestration:request',
      success: true,
      data: {
        status: 403,
        body: {
          ok: false,
          error: { code: 'task_scope_mismatch', message: 'wrong root' },
        },
      },
    });
  });
});
