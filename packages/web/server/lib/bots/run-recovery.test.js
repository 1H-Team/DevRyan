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

  it('leaves approval and reconciliation states durable across restart', async () => {
    const harness = createHarness({ runs: [run('waiting_approval'), run('needs_reconciliation')] });
    const result = await harness.recovery.recover();
    expect(result.waiting).toBe(2);
    expect(harness.dispatcher.resumeRun).not.toHaveBeenCalled();
  });
});
