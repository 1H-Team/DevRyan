import { describe, expect, it, vi } from 'vitest';

import { createBotRunRecovery } from './run-recovery.js';

const RUN_ID = 'e0000000-0000-4000-8000-000000000001';
const UPDATED_AT = '2026-08-23T10:00:00.000Z';

const run = (state = 'running') => ({
  id: RUN_ID,
  state,
  updated_at: UPDATED_AT,
  computer_scope_key: 'bot:one',
});

const createHarness = ({ runs = [run()], actions = [] } = {}) => {
  const store = {
    settleRunTerminal: vi.fn(async (input) => ({
      ...run(),
      state: input.state,
      interruption_kind: input.interruptionKind,
      context_snapshot: input.contextSnapshot,
      finished_at: input.finishedAt,
    })),
    repositories: {
      bot_runs: {
        list: vi.fn(async ({ filters }) => ({
          items: runs.filter((item) => item.state === filters.state),
        })),
        updateIfRevision: vi.fn(async (_keys, changes) => ({ ...run(), ...changes })),
      },
      bot_action_attempts: {
        list: vi.fn(async ({ filters }) => ({
          items: actions.filter((item) => item.state === filters.state),
        })),
        updateIfRevision: vi.fn(async (_keys, changes) => ({ ...actions[0], ...changes })),
      },
    },
  };
  const dispatcher = { resumeRun: vi.fn(async () => ({ resumed: true })) };
  return { recovery: createBotRunRecovery({ store, dispatcher }), store, dispatcher };
};

describe('Production Bot restart recovery', () => {
  it('resumes a run when no interrupted write is present', async () => {
    const harness = createHarness({
      actions: [{ id: 'action-1', state: 'executing', action: 'read_page', updated_at: UPDATED_AT }],
    });
    const result = await harness.recovery.recover();
    expect(result.resumed).toBe(1);
    expect(harness.dispatcher.resumeRun).toHaveBeenCalledWith(expect.objectContaining({ id: RUN_ID }));
  });

  it('marks an interrupted write unknown and blocks the run for reconciliation', async () => {
    const harness = createHarness({
      actions: [{
        id: 'action-1',
        state: 'executing',
        action: 'submit_form',
        target: { operationKind: 'write' },
        updated_at: UPDATED_AT,
      }],
    });
    const result = await harness.recovery.recover();

    expect(result.needsReconciliation).toBe(1);
    expect(harness.store.repositories.bot_action_attempts.updateIfRevision)
      .toHaveBeenCalledWith(
        { id: 'action-1' },
        expect.objectContaining({
          state: 'unknown',
          unknown_outcome: true,
          finished_at: expect.any(String),
        }),
        UPDATED_AT,
      );
    expect(harness.store.repositories.bot_runs.updateIfRevision)
      .toHaveBeenCalledWith(
        { id: RUN_ID },
        expect.objectContaining({ state: 'needs_reconciliation' }),
        UPDATED_AT,
      );
    expect(harness.dispatcher.resumeRun).not.toHaveBeenCalled();
  });

  it('allows an already-unknown safe read to resume instead of requiring reconciliation', async () => {
    const harness = createHarness({
      actions: [{
        id: 'action-1',
        state: 'unknown',
        action: 'read_page',
        target: { operationKind: 'read' },
        updated_at: UPDATED_AT,
      }],
    });

    const result = await harness.recovery.recover();

    expect(result.resumed).toBe(1);
    expect(result.needsReconciliation).toBe(0);
    expect(harness.store.repositories.bot_action_attempts.updateIfRevision).not.toHaveBeenCalled();
  });

  it('defers a run when another live runtime wins its durable lease', async () => {
    const harness = createHarness();
    harness.dispatcher.resumeRun.mockResolvedValueOnce({ resumed: false, claimed: false });

    const result = await harness.recovery.recover();

    expect(result.deferred).toBe(1);
    expect(result.interrupted).toBe(0);
    expect(harness.store.repositories.bot_runs.updateIfRevision).not.toHaveBeenCalled();
  });

  it('terminalizes an orphan transactionally when startup recovery cannot resume it', async () => {
    const harness = createHarness();
    harness.dispatcher.resumeRun.mockRejectedValueOnce(Object.assign(
      new Error('runtime unavailable'),
      { code: 'bot_opencode_request_failed' },
    ));

    const result = await harness.recovery.recover();

    expect(result.interrupted).toBe(1);
    expect(harness.store.settleRunTerminal).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      state: 'interrupted',
      interruptionKind: 'bot_opencode_request_failed',
      contextSnapshot: expect.objectContaining({
        failurePhase: 'recovery',
        failureStage: 'startup_recovery',
      }),
    }));
    expect(harness.store.repositories.bot_runs.updateIfRevision).not.toHaveBeenCalled();
  });

  it('leaves approval and reconciliation states durable across restart', async () => {
    const harness = createHarness({ runs: [run('waiting_approval'), run('needs_reconciliation')] });
    const result = await harness.recovery.recover();
    expect(result.waiting).toBe(2);
    expect(harness.dispatcher.resumeRun).not.toHaveBeenCalled();
  });

  it('resumes a durable browser-control wait with its persisted action identity', async () => {
    const harness = createHarness({
      runs: [run('waiting_control')],
      actions: [{
        id: 'action-1',
        state: 'waiting_control',
        action: 'click',
        target: { operationKind: 'write' },
        updated_at: UPDATED_AT,
      }],
    });
    const result = await harness.recovery.recover();
    expect(result.resumed).toBe(1);
    expect(result.needsReconciliation).toBe(0);
    expect(harness.dispatcher.resumeRun).toHaveBeenCalledWith(expect.objectContaining({
      id: RUN_ID,
      state: 'waiting_control',
    }));
  });
});

describe('Production Bot run sweep', () => {
  const NOW = Date.parse('2026-09-01T12:00:00.000Z');
  const sweepHarness = (runs) => {
    const store = {
      settleRunTerminal: vi.fn(async (input) => ({ ...runs[0], state: input.state })),
      repositories: {
        bot_runs: {
          list: vi.fn(async ({ filters }) => ({ items: runs.filter((item) => item.state === filters.state) })),
          updateIfRevision: vi.fn(async (_keys, changes) => ({ ...runs[0], ...changes })),
        },
        bot_action_attempts: {
          list: vi.fn(async () => ({ items: [] })),
          updateIfRevision: vi.fn(),
        },
      },
    };
    const dispatcher = { resumeRun: vi.fn(async () => ({ resumed: true })) };
    return {
      recovery: createBotRunRecovery({ store, dispatcher, now: () => new Date(NOW) }),
      store,
      dispatcher,
    };
  };

  it('reports queued scopes after restart recovery', async () => {
    const harness = sweepHarness([
      { id: 'q1', state: 'queued', computer_scope_key: 'bot:one', created_at: '2026-09-01T11:59:59.000Z' },
      { id: 'q2', state: 'queued', computer_scope_key: 'bot:two', created_at: '2026-09-01T11:00:00.000Z' },
      { id: 'q3', state: 'queued', computer_scope_key: 'bot:one', created_at: '2026-09-01T11:00:00.000Z' },
    ]);
    const result = await harness.recovery.recover();
    expect(result.queuedScopeKeys).toEqual(['bot:one', 'bot:two']);
    expect(harness.dispatcher.resumeRun).not.toHaveBeenCalled();
  });

  it('sweeps only aged queued runs and lease-expired runs nobody in this process owns', async () => {
    const runs = [
      { id: 'fresh', state: 'queued', computer_scope_key: 'bot:fresh', created_at: '2026-09-01T11:59:50.000Z' },
      { id: 'stale', state: 'queued', computer_scope_key: 'bot:stale', created_at: '2026-09-01T11:58:00.000Z' },
      { id: 'live', state: 'running', computer_scope_key: 'bot:live', lease_until: '2026-09-01T12:04:00.000Z', updated_at: 'u' },
      { id: 'orphan', state: 'running', computer_scope_key: 'bot:orphan', lease_until: '2026-09-01T11:50:00.000Z', updated_at: 'u' },
      { id: 'mine', state: 'starting', computer_scope_key: 'bot:mine', lease_until: '2026-09-01T11:50:00.000Z', updated_at: 'u' },
    ];
    const harness = sweepHarness(runs);
    const result = await harness.recovery.sweep({
      minQueuedAgeMs: 30_000,
      isExecuting: (runId) => runId === 'mine',
    });
    expect(result.queuedScopeKeys).toEqual(['bot:stale']);
    expect(harness.dispatcher.resumeRun).toHaveBeenCalledTimes(1);
    expect(harness.dispatcher.resumeRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'orphan' }));
    expect(result.resumed).toBe(1);
  });
});
