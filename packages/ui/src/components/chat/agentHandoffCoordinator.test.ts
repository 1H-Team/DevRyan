import { describe, expect, test } from 'bun:test';

import type {
  ManagedAgentHandoffRequest,
  ManagedAgentHandoffResponse,
  ManagedOrchestrationApi,
} from '@/lib/orchestrationApi';
import {
  createAgentHandoffCoordinator,
  shouldReconcileBuilderSession,
} from './agentHandoffCoordinator';
import {
  guardQueuedBuilderSend,
  registerQueuedBuilderSendGuard,
} from './agentHandoffGuardContext';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const response = (
  state: ManagedAgentHandoffResponse['state'],
  overrides: Partial<ManagedAgentHandoffResponse> = {},
): ManagedAgentHandoffResponse => ({
  rootSessionId: 'ses_root',
  fromMode: 'orchestrator',
  toMode: 'builder',
  state,
  tasks: [],
  failures: [],
  ...overrides,
});

const createApi = (handler: (request: ManagedAgentHandoffRequest) => Promise<ManagedAgentHandoffResponse>) => ({
  handoff: handler,
}) as Pick<ManagedOrchestrationApi, 'handoff'>;

describe('agent handoff coordinator', () => {
  test('reconciles only Builder sessions without explicit handoff clearance', () => {
    expect(shouldReconcileBuilderSession({
      sessionId: 'ses_new',
      savedAgentName: 'Builder',
      handoffCleared: true,
    })).toBe(false);
    expect(shouldReconcileBuilderSession({
      sessionId: 'ses_restored',
      savedAgentName: 'builder',
      handoffCleared: false,
    })).toBe(true);
    expect(shouldReconcileBuilderSession({
      sessionId: 'ses_orchestrator',
      savedAgentName: 'Orchestrator',
      handoffCleared: false,
    })).toBe(false);
  });

  test('fails closed for background Builder queue dispatch until a guard owner is mounted', async () => {
    expect(await guardQueuedBuilderSend({ sessionId: 'ses_root', agentName: 'Builder' })).toBe(false);
    expect(await guardQueuedBuilderSend({ sessionId: 'ses_root', agentName: 'Orchestrator' })).toBe(true);
    const unregister = registerQueuedBuilderSendGuard(async ({ sessionId }) => sessionId === 'ses_clear');
    expect(await guardQueuedBuilderSend({ sessionId: 'ses_clear', agentName: 'Builder' })).toBe(true);
    expect(await guardQueuedBuilderSend({ sessionId: 'ses_blocked', agentName: 'Builder' })).toBe(false);
    unregister();
  });

  test('never commits the agent before inspection or confirmed cleanup returns clear', async () => {
    const requests: ManagedAgentHandoffRequest[] = [];
    let commitCount = 0;
    const api = createApi(async (request) => {
      requests.push(request);
      return response(request.confirm ? 'clear' : 'confirmation_required');
    });
    const coordinator = createAgentHandoffCoordinator({
      api,
      createIdempotencyKey: () => 'switch-01',
    });
    coordinator.setSession('ses_root');

    await coordinator.requestAgentChange({
      sessionId: 'ses_root',
      currentAgentName: 'Orchestrator',
      nextAgentName: 'Builder',
      commit: () => { commitCount += 1; },
    });

    expect(commitCount).toBe(0);
    expect(coordinator.getState().open).toBe(true);
    expect(coordinator.getState().phase).toBe('confirmation');
    await coordinator.confirm();
    expect(commitCount).toBe(1);
    expect(coordinator.getState().open).toBe(false);
    expect(coordinator.getState().phase).toBe('idle');
    expect(requests).toEqual([{
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: false,
    }, {
      rootSessionId: 'ses_root',
      fromMode: 'orchestrator',
      toMode: 'builder',
      confirm: true,
      idempotencyKey: 'switch-01',
    }]);
  });

  test('cancels before cleanup and bypasses new drafts plus reverse switches', async () => {
    let apiCalls = 0;
    let commits = 0;
    const coordinator = createAgentHandoffCoordinator({
      api: createApi(async () => {
        apiCalls += 1;
        return response('confirmation_required');
      }),
    });
    coordinator.setSession('ses_root');
    await coordinator.requestAgentChange({
      sessionId: 'ses_root',
      currentAgentName: 'Orchestrator',
      nextAgentName: 'Builder',
      commit: () => { commits += 1; },
    });
    expect(coordinator.cancel()).toBe(true);
    expect(commits).toBe(0);

    await coordinator.requestAgentChange({
      sessionId: null,
      currentAgentName: 'Orchestrator',
      nextAgentName: 'Builder',
      commit: () => { commits += 1; },
    });
    await coordinator.requestAgentChange({
      sessionId: 'ses_root',
      currentAgentName: 'Builder',
      nextAgentName: 'Orchestrator',
      commit: () => { commits += 1; },
    });
    expect(commits).toBe(2);
    expect(apiCalls).toBe(1);
  });

  test('keeps partial cleanup retryable, updates task projections, and reuses its key', async () => {
    const requests: ManagedAgentHandoffRequest[] = [];
    let commitCount = 0;
    const api = createApi(async (request) => {
      requests.push(request);
      if (!request.confirm) return response('confirmation_required');
      if (requests.filter((entry) => entry.confirm).length === 1) {
        return response('blocked', {
          tasks: [{ task: { taskId: 'dvr_task_1', status: 'aborted', label: 'Stopped task' } } as never],
          failures: [{ taskId: 'dvr_task_2', code: 'cleanup_failed', message: 'Managed task cleanup failed' }],
        });
      }
      return response('clear');
    });
    const coordinator = createAgentHandoffCoordinator({
      api,
      createIdempotencyKey: () => 'switch-retry',
    });
    coordinator.setSession('ses_root');
    await coordinator.requestAgentChange({
      sessionId: 'ses_root',
      currentAgentName: 'orchestrator',
      nextAgentName: 'builder',
      commit: () => { commitCount += 1; },
    });
    await coordinator.confirm();

    expect(commitCount).toBe(0);
    expect(coordinator.getState().open).toBe(true);
    expect(coordinator.getState().phase).toBe('error');
    expect(coordinator.getState().errorKind).toBe('cleanup');
    expect(coordinator.getState().tasks[0]?.task.taskId).toBe('dvr_task_1');
    expect(coordinator.getState().tasks[0]?.task.status).toBe('aborted');
    await coordinator.retry();
    expect(commitCount).toBe(1);
    expect(requests.filter((entry) => entry.confirm).map((entry) => entry.idempotencyKey)).toEqual([
      'switch-retry',
      'switch-retry',
    ]);
  });

  test('coalesces rapid clicks and ignores a clear response after the session changes', async () => {
    const inspection = deferred<ManagedAgentHandoffResponse>();
    let apiCalls = 0;
    let commits = 0;
    const coordinator = createAgentHandoffCoordinator({
      api: createApi(async () => {
        apiCalls += 1;
        return await inspection.promise;
      }),
    });
    coordinator.setSession('ses_root');
    const input = {
      sessionId: 'ses_root',
      currentAgentName: 'Orchestrator',
      nextAgentName: 'Builder',
      commit: () => { commits += 1; },
    };
    const first = coordinator.requestAgentChange(input);
    const second = coordinator.requestAgentChange(input);
    expect(apiCalls).toBe(1);

    coordinator.setSession('ses_other');
    inspection.resolve(response('clear'));
    await Promise.all([first, second]);
    expect(commits).toBe(0);
    expect(coordinator.getState().open).toBe(false);
    expect(coordinator.getState().phase).toBe('idle');
    expect(coordinator.getState().sessionId).toBe('ses_other');
  });

  test('restores a persisted Builder session, blocks its send, then reapplies Builder only after cleanup', async () => {
    let restored = 0;
    let committed = 0;
    const coordinator = createAgentHandoffCoordinator({
      api: createApi(async (request) => response(request.confirm ? 'clear' : 'confirmation_required')),
      createIdempotencyKey: () => 'switch-restored',
    });
    coordinator.setSession('ses_root');
    await coordinator.reconcileBuilderSession({
      sessionId: 'ses_root',
      restoreOrchestrator: () => { restored += 1; },
      commitBuilder: () => { committed += 1; },
    });

    expect(restored).toBe(1);
    expect(committed).toBe(0);
    expect(coordinator.isBuilderSendBlocked('ses_root')).toBe(true);
    await coordinator.confirm();
    expect(committed).toBe(1);
    expect(coordinator.isBuilderSendBlocked('ses_root')).toBe(false);
  });

  test('reapplies a restored persisted Builder session when an inspection retry is already clear', async () => {
    let calls = 0;
    let restored = 0;
    let committed = 0;
    const coordinator = createAgentHandoffCoordinator({
      api: createApi(async () => {
        calls += 1;
        if (calls === 1) throw new Error('Managed runtime is starting');
        return response('clear');
      }),
    });
    coordinator.setSession('ses_root');
    await coordinator.reconcileBuilderSession({
      sessionId: 'ses_root',
      restoreOrchestrator: () => { restored += 1; },
      commitBuilder: () => { committed += 1; },
    });

    expect(restored).toBe(1);
    expect(committed).toBe(0);
    expect(coordinator.getState().errorKind).toBe('inspection');
    await coordinator.retry();
    expect(committed).toBe(1);
    expect(coordinator.getState().open).toBe(false);
    expect(coordinator.getState().phase).toBe('idle');
  });
});
