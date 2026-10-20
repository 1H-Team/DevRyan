import { describe, expect, mock, test } from 'bun:test';

mock.module('@opencode-ai/plugin', () => ({ tool: () => ({}) }));
const { isPlanModeUserRecord } = await import('./devryan-managed-orchestration.mjs');

const user = metadata => ({ info: { role: 'user', metadata }, parts: [] });

describe('bundled managed orchestration Plan Mode identity', () => {
  test('accepts canonical and saved legacy metadata without enabling ordinary messages', () => {
    expect(isPlanModeUserRecord(user({ devryanPlanMode: true }))).toBe(true);
    expect(isPlanModeUserRecord(user({ openchamberPlanMode: true }))).toBe(true);
    expect(isPlanModeUserRecord(user({ devryanPlanMode: false, openchamberPlanMode: true }))).toBe(false);
    expect(isPlanModeUserRecord(user({ devryanPlanMode: false }))).toBe(false);
    expect(isPlanModeUserRecord({ info: { role: 'assistant', metadata: { devryanPlanMode: true } }, parts: [] })).toBe(false);
  });
});
