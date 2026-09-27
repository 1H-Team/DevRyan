import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRestartReconciler } from './runtime-restart-reconcile.js';

const RESTART = 10_000;

const setup = (overrides = {}) => {
  const settled = [];
  const diagnostics = [];
  const reconciler = createRuntimeRestartReconciler({
    listActiveSessions: () => [
      { sessionId: 'ses_dead', status: 'busy', lastUpdateAt: RESTART - 5_000 },
      { sessionId: 'ses_retrying', status: 'retry', lastUpdateAt: RESTART - 1 },
      { sessionId: 'ses_still_live', status: 'busy', lastUpdateAt: RESTART - 1 },
      { sessionId: 'ses_new_runtime', status: 'busy', lastUpdateAt: RESTART + 1 },
      { sessionId: 'ses_cursor', status: 'busy', lastUpdateAt: RESTART - 1 },
      { sessionId: 'ses_other_dir', status: 'busy', lastUpdateAt: RESTART - 1 },
      { sessionId: 'ses_unknown', status: 'busy', lastUpdateAt: RESTART - 1 },
    ],
    resolveSessionDirectory: async (sessionId) => ({
      ses_dead: '/repo', ses_retrying: '/repo', ses_still_live: '/repo', ses_new_runtime: '/repo',
      ses_cursor: '/repo', ses_other_dir: '/worktree',
    })[sessionId] ?? null,
    readRuntimeStatuses: async (directory) => (directory === '/repo' ? { ses_still_live: { type: 'busy' } } : {}),
    isSessionLiveElsewhere: (sessionId) => sessionId === 'ses_cursor',
    settleSession: (input) => settled.push(input),
    recordDiagnostic: (summary) => diagnostics.push(summary),
    logger: { warn: vi.fn() },
    ...overrides,
  });
  return { reconciler, settled, diagnostics };
};

describe('OpenCode restart reconciliation', () => {
  it('settles only stale sessions the restarted runtime reports idle', async () => {
    const { reconciler, settled, diagnostics } = setup();
    const summary = await reconciler.reconcile({ restartStartedAt: RESTART });
    expect(settled.map(({ sessionId, directory }) => `${sessionId}@${directory}`).sort()).toEqual([
      'ses_dead@/repo', 'ses_other_dir@/worktree', 'ses_retrying@/repo',
    ]);
    expect(summary).toEqual({ candidates: 5, settled: 3, live: 1, unresolved: 1, failedDirectories: 0 });
    expect(diagnostics).toEqual([summary]);
  });

  it('leaves a directory untouched when its status cannot be read', async () => {
    const { reconciler, settled } = setup({
      readRuntimeStatuses: async (directory) => {
        if (directory === '/repo') throw new Error('OpenCode session status responded with 503');
        return {};
      },
    });
    const summary = await reconciler.reconcile({ restartStartedAt: RESTART });
    expect(settled.map(({ sessionId }) => sessionId)).toEqual(['ses_other_dir']);
    expect(summary.failedDirectories).toBe(1);
  });

  it('does nothing without stale busy sessions', async () => {
    const readRuntimeStatuses = vi.fn();
    const { reconciler, diagnostics } = setup({ listActiveSessions: () => [], readRuntimeStatuses });
    await expect(reconciler.reconcile({ restartStartedAt: RESTART })).resolves.toMatchObject({ candidates: 0, settled: 0 });
    expect(readRuntimeStatuses).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });
});
