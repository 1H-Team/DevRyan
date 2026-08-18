import { describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT,
  CONTEXT_MODE_WEDGE_FAILURE_TEXT,
  createContextModeRecovery,
  extractContextModeToolFailure,
  rewriteContextModeWedgeFailureText,
} from './context-mode-recovery.js';

const ioerrPayload = {
  type: 'message.part.updated',
  properties: {
    part: {
      id: 'part-1',
      type: 'tool',
      tool: 'ctx_batch_execute',
      state: { status: 'error', error: 'Batch execution error: disk I/O error' },
    },
  },
};

const lockedPayload = {
  ...ioerrPayload,
  properties: {
    part: {
      ...ioerrPayload.properties.part,
      state: { status: 'error', error: 'database is locked' },
    },
  },
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const createTimerHarness = () => {
  const pending = [];
  return {
    pending,
    setTimeoutFn(callback, delay) {
      const handle = { callback, delay };
      pending.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
};

describe('context-mode recovery detection', () => {
  it('matches only ctx_* IOERR failures and excludes lock contention', () => {
    expect(extractContextModeToolFailure(ioerrPayload)).toEqual({
      tool: 'ctx_batch_execute',
      failureText: 'Batch execution error: disk I/O error',
    });
    expect(extractContextModeToolFailure(lockedPayload)).toBeNull();
    expect(extractContextModeToolFailure({
      type: 'message.part.delta',
      properties: ioerrPayload.properties,
    })).toBeNull();
  });

  it('rewrites wedged-handle failure text without dropping SQLITE_IOERR', () => {
    expect(rewriteContextModeWedgeFailureText({
      tool: 'ctx_execute',
      failureText: 'SQLITE_IOERR: disk I/O error',
    })).toBe(CONTEXT_MODE_WEDGE_FAILURE_TEXT);
    expect(CONTEXT_MODE_WEDGE_FAILURE_TEXT).toMatch(/SQLITE_IOERR/);
  });
});

describe('createContextModeRecovery', () => {
  it('holds prompt admission, preserves active work, coalesces failures, and restarts at authoritative idle', async () => {
    let activeCount = 2;
    let clock = 100;
    const release = vi.fn();
    const acquireAdmissionHold = vi.fn(() => release);
    const restartOpenCode = vi.fn(async () => undefined);
    const recordIncident = vi.fn();
    const timers = createTimerHarness();
    const recovery = createContextModeRecovery({
      restartOpenCode,
      getActiveSessionCount: async () => activeCount,
      acquireAdmissionHold,
      recordIncident,
      now: () => clock++,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    expect(recovery.observeContextModeToolFailure(ioerrPayload)).toBe(true);
    expect(acquireAdmissionHold).toHaveBeenCalledWith(
      'context_mode_recovery',
      expect.objectContaining({ code: 'CONTEXT_MODE_RECOVERY_PENDING' }),
    );
    expect(recovery.observeContextModeToolFailure(ioerrPayload)).toBe(true);
    await flush();
    expect(restartOpenCode).not.toHaveBeenCalled();
    expect(timers.pending).toHaveLength(1);
    expect(recovery.getStatus()).toMatchObject({ state: 'draining', occurrenceCount: 2 });

    activeCount = 0;
    timers.pending.shift().callback();
    await flush();
    expect(restartOpenCode).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(recovery.getStatus()).toMatchObject({
      state: 'healthy',
      occurrenceCount: 2,
      restartAttempts: 1,
      outcome: 'recovered',
    });
    expect(new Set(recordIncident.mock.calls.map(([status]) => status.incidentId)).size).toBe(1);
    recovery.dispose();
  });

  it('retries failed restarts with 1, 5, then 30 second backoff and no cooldown suppression', async () => {
    const restartOpenCode = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
      .mockResolvedValue(undefined)
      .mockResolvedValue(undefined);
    const timers = createTimerHarness();
    const recovery = createContextModeRecovery({
      restartOpenCode,
      retryDelaysMs: [1000, 5000, 30000],
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    recovery.observeContextModeToolFailure(ioerrPayload);
    await flush();
    expect(timers.pending[0].delay).toBe(1000);
    timers.pending.shift().callback();
    await flush();
    expect(timers.pending[0].delay).toBe(5000);
    timers.pending.shift().callback();
    await flush();
    expect(timers.pending[0].delay).toBe(30000);
    timers.pending.shift().callback();
    await flush();
    expect(recovery.getStatus()).toMatchObject({ state: 'healthy', restartAttempts: 4 });

    recovery.observeContextModeToolFailure(ioerrPayload);
    await flush();
    expect(restartOpenCode).toHaveBeenCalledTimes(5);
    recovery.dispose();
  });

  it('keeps admission closed when authoritative status cannot be read', async () => {
    const release = vi.fn();
    const timers = createTimerHarness();
    const recovery = createContextModeRecovery({
      restartOpenCode: vi.fn(),
      getActiveSessionCount: async () => { throw new Error('status unavailable'); },
      acquireAdmissionHold: () => release,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    recovery.observeContextModeToolFailure(ioerrPayload);
    await flush();
    expect(recovery.getStatus()).toMatchObject({
      state: 'draining',
      lastRestartError: expect.stringContaining('status unavailable'),
    });
    expect(release).not.toHaveBeenCalled();
    expect(timers.pending).toHaveLength(1);
    recovery.dispose();
  });

  it('returns explicit owner guidance without mutating an external runtime', async () => {
    const restartOpenCode = vi.fn();
    const acquireAdmissionHold = vi.fn();
    const recovery = createContextModeRecovery({
      restartOpenCode,
      isExternalOpenCode: true,
      acquireAdmissionHold,
    });

    expect(recovery.observeContextModeToolFailure(ioerrPayload)).toBe(true);
    await flush();
    expect(recovery.getStatus()).toMatchObject({
      state: 'external_action_required',
      guidance: CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT,
    });
    expect(acquireAdmissionHold).not.toHaveBeenCalled();
    expect(restartOpenCode).not.toHaveBeenCalled();
    recovery.dispose();
  });
});
