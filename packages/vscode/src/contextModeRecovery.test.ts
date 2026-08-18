import { describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT,
  createContextModeRecovery,
  extractContextModeToolFailure,
} from './contextModeRecovery';

const ioerrPayload = {
  type: 'message.part.updated',
  properties: {
    part: {
      id: 'part-1',
      type: 'tool',
      tool: 'ctx_batch_execute',
      state: { status: 'error', error: 'Batch execution error: SQLITE_IOERR' },
    },
  },
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const createTimerHarness = () => {
  const pending: Array<{ callback: () => void; delay: number }> = [];
  return {
    pending,
    setTimeoutFn: ((callback: () => void, delay = 0) => {
      const handle = { callback, delay };
      pending.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: ((handle: ReturnType<typeof setTimeout>) => {
      const index = pending.indexOf(handle as unknown as { callback: () => void; delay: number });
      if (index >= 0) pending.splice(index, 1);
    }) as typeof clearTimeout,
  };
};

describe('VS Code context-mode recovery', () => {
  it('excludes ordinary SQLite lock contention', () => {
    expect(extractContextModeToolFailure({
      ...ioerrPayload,
      properties: {
        part: {
          ...ioerrPayload.properties.part,
          state: { status: 'error', error: 'database is locked' },
        },
      },
    })).toBeNull();
  });

  it('holds admission until authoritative idle and releases it after readiness', async () => {
    let activeCount = 1;
    const release = vi.fn();
    const restartOpenCode = vi.fn(async () => undefined);
    const timers = createTimerHarness();
    const recovery = createContextModeRecovery({
      restartOpenCode,
      getActiveSessionCount: async () => activeCount,
      acquireAdmissionHold: () => release,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    expect(recovery.observeContextModeToolFailure(ioerrPayload)).toBe(true);
    await flush();
    expect(recovery.getStatus().state).toBe('draining');
    expect(timers.pending).toHaveLength(1);

    activeCount = 0;
    timers.pending.shift()?.callback();
    await flush();
    expect(restartOpenCode).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(recovery.getStatus()).toMatchObject({ state: 'healthy', outcome: 'recovered' });
    recovery.dispose();
  });

  it('backs off a failed restart while preserving the hold', async () => {
    const release = vi.fn();
    const restartOpenCode = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValue(undefined);
    const timers = createTimerHarness();
    const recovery = createContextModeRecovery({
      restartOpenCode,
      acquireAdmissionHold: () => release,
      retryDelaysMs: [1000, 5000, 30000],
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    recovery.observeContextModeToolFailure(ioerrPayload);
    await flush();
    expect(timers.pending[0]?.delay).toBe(1000);
    expect(release).not.toHaveBeenCalled();
    timers.pending.shift()?.callback();
    await flush();
    expect(release).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it('reports external owner action without acquiring a hold or restarting', () => {
    const restartOpenCode = vi.fn();
    const acquireAdmissionHold = vi.fn();
    const recovery = createContextModeRecovery({
      restartOpenCode,
      isExternalOpenCode: true,
      acquireAdmissionHold,
    });

    expect(recovery.observeContextModeToolFailure(ioerrPayload)).toBe(true);
    expect(recovery.getStatus()).toMatchObject({
      state: 'external_action_required',
      guidance: CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT,
    });
    expect(acquireAdmissionHold).not.toHaveBeenCalled();
    expect(restartOpenCode).not.toHaveBeenCalled();
    recovery.dispose();
  });
});
