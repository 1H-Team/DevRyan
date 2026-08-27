import { describe, expect, test } from 'bun:test';

import {
  BOT_ROUTINE_MISSED_POLICIES,
  resolveDefaultBotRoutineMissedPolicy,
  resolveMissedBotRoutineOccurrences,
} from './routines.js';

const recoveryInput = (overrides = {}) => ({
  missedPolicy: 'skip',
  missedRunCap: 3,
  scheduledFor: [1_000, 2_000, 3_000, 4_000],
  performsExternalWrites: false,
  ...overrides,
});

describe('Bot routine missed-run policy', () => {
  test('publishes the structured policy enum and conservative defaults', () => {
    expect(BOT_ROUTINE_MISSED_POLICIES).toEqual(['skip', 'run_once', 'replay_capped']);
    expect(resolveDefaultBotRoutineMissedPolicy({ performsExternalWrites: false })).toBe('skip');
    expect(resolveDefaultBotRoutineMissedPolicy({ performsExternalWrites: true })).toBe('run_once');
  });

  test('skips, runs the latest once, or replays the latest bounded window in order', () => {
    expect(resolveMissedBotRoutineOccurrences(recoveryInput())).toEqual({
      disposition: 'skip',
      occurrences: [],
      approvalRequired: false,
    });
    expect(resolveMissedBotRoutineOccurrences(recoveryInput({ missedPolicy: 'run_once' }))).toEqual({
      disposition: 'run_once',
      occurrences: [4_000],
      approvalRequired: false,
    });
    expect(resolveMissedBotRoutineOccurrences(recoveryInput({
      missedPolicy: 'replay_capped',
      missedRunCap: 2,
      scheduledFor: [4_000, 2_000, 3_000, 1_000, 4_000],
    }))).toEqual({
      disposition: 'replay_capped',
      occurrences: [3_000, 4_000],
      approvalRequired: false,
    });
  });

  test('requires fresh approval for recovered external writes', () => {
    expect(resolveMissedBotRoutineOccurrences(recoveryInput({
      missedPolicy: 'run_once',
      performsExternalWrites: true,
    }))).toEqual({
      disposition: 'run_once',
      occurrences: [4_000],
      approvalRequired: true,
    });
  });

  test('caps replay at three and rejects unknown fields', () => {
    expect(() => resolveMissedBotRoutineOccurrences(recoveryInput({
      missedPolicy: 'replay_capped',
      missedRunCap: 4,
    }))).toThrow('missedRunCap must be an integer between 1 and 3');
    expect(() => resolveMissedBotRoutineOccurrences(recoveryInput({ timezone: 'UTC' })))
      .toThrow('routine recovery input contains unknown field timezone');
    expect(() => resolveDefaultBotRoutineMissedPolicy({
      performsExternalWrites: true,
      background: true,
    })).toThrow('routine default input contains unknown field background');
  });
});
