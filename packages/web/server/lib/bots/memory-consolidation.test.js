import { describe, expect, it, vi } from 'vitest';

import {
  createBotMemoryConsolidation,
  planBotMemoryConsolidation,
} from './memory-consolidation.js';

const memory = (id, overrides = {}) => ({
  id,
  scope: 'shared',
  subjectUserId: null,
  content: { text: 'Deployments use the reviewed European region.' },
  sensitivity: 'normal',
  confidence: 0.8,
  activeCreatorKind: 'classifier',
  updatedAt: '2026-08-23T00:00:00.000Z',
  tombstonedAt: null,
  ...overrides,
});

describe('Bot memory consolidation', () => {
  it('deduplicates only exact normalized facts and prefers a Manager version', () => {
    const plans = planBotMemoryConsolidation([
      memory('memory-a'),
      memory('memory-b', {
        content: { text: 'DEPLOYMENTS use the reviewed European region!' },
        activeCreatorKind: 'manager',
        updatedAt: '2026-08-22T00:00:00.000Z',
      }),
      memory('memory-conflict', { content: { text: 'Deployments use the US region.' } }),
    ]);
    expect(plans).toEqual([expect.objectContaining({
      targetId: 'memory-b',
      sourceIds: ['memory-a'],
      expectedUpdatedAt: '2026-08-22T00:00:00.000Z',
    })]);
  });

  it('does not merge identical text across user-private subjects', () => {
    expect(planBotMemoryConsolidation([
      memory('one', { scope: 'user_private', subjectUserId: 'user-one' }),
      memory('two', { scope: 'user_private', subjectUserId: 'user-two' }),
    ])).toEqual([]);
  });

  it('passes the captured revision and preserves a stale Manager edit as a conflict', async () => {
    const mergeMemories = vi.fn(async () => ({ activated: false }));
    const runtime = createBotMemoryConsolidation({
      loadMemories: async () => [memory('memory-a'), memory('memory-b')],
      mergeMemories,
      intervalMs: 60_000,
    });
    await expect(runtime.sweep()).resolves.toEqual({ planned: 1, merged: 0, conflicts: 1 });
    expect(mergeMemories).toHaveBeenCalledWith(expect.objectContaining({
      expectedUpdatedAt: '2026-08-23T00:00:00.000Z',
    }));
    await runtime.shutdown();
  });

  it('coalesces concurrent sweeps into one bounded load', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const loadMemories = vi.fn(async () => {
      await gate;
      return [];
    });
    const runtime = createBotMemoryConsolidation({
      loadMemories,
      mergeMemories: vi.fn(),
      intervalMs: 60_000,
    });
    const first = runtime.sweep();
    const second = runtime.sweep();
    release();
    await Promise.all([first, second]);
    expect(loadMemories).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });
});
