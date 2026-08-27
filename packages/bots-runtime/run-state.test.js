import { describe, expect, test } from 'bun:test';

import {
  assertBotActionStateTransition,
  assertBotRunStateTransition,
  decideBotRunAdmission,
  isBotActionTerminalState,
  isBotActionUnknownWriteState,
  isBotRunTerminalState,
  resolveInterruptedBotAction,
} from './run-state.js';

const admissionInput = (overrides = {}) => ({
  runId: 'run-2',
  computerScopeKey: 'bot:bot-1',
  currentLease: null,
  now: 1_000,
  ...overrides,
});

describe('Bot run state and leasing', () => {
  test('enforces the explicit run graph and immutable terminal states', () => {
    expect(assertBotRunStateTransition({ from: 'queued', to: 'starting' })).toBe('starting');
    expect(assertBotRunStateTransition({ from: 'running', to: 'waiting_approval' }))
      .toBe('waiting_approval');
    expect(assertBotRunStateTransition({ from: 'running', to: 'needs_reconciliation' }))
      .toBe('needs_reconciliation');
    expect(assertBotRunStateTransition({ from: 'needs_reconciliation', to: 'completed' }))
      .toBe('completed');
    expect(() => assertBotRunStateTransition({ from: 'completed', to: 'running' }))
      .toThrow('terminal Bot run state completed is immutable');
    expect(() => assertBotRunStateTransition({ from: 'queued', to: 'completed' }))
      .toThrow('invalid Bot run transition: queued -> completed');
    expect(() => assertBotRunStateTransition({ from: 'queued', to: 'starting', force: true }))
      .toThrow('run transition input contains unknown field force');
  });

  test('classifies only settled run states as terminal', () => {
    for (const state of ['completed', 'failed', 'cancelled', 'interrupted']) {
      expect(isBotRunTerminalState(state)).toBe(true);
    }
    expect(isBotRunTerminalState('needs_reconciliation')).toBe(false);
    expect(isBotRunTerminalState('waiting_approval')).toBe(false);
  });

  test('admits at most one run per live computer lease', () => {
    expect(decideBotRunAdmission(admissionInput())).toEqual({
      admitted: true,
      reason: 'available',
      leaseGeneration: 1,
    });

    const liveLease = {
      runId: 'run-1',
      computerScopeKey: 'bot:bot-1',
      leaseGeneration: 4,
      leaseUntil: 2_000,
    };
    expect(decideBotRunAdmission(admissionInput({ currentLease: liveLease }))).toEqual({
      admitted: false,
      reason: 'scope_leased',
      leaseGeneration: 4,
    });
    expect(decideBotRunAdmission(admissionInput({
      runId: 'run-1',
      currentLease: liveLease,
    }))).toEqual({
      admitted: true,
      reason: 'already_owned',
      leaseGeneration: 4,
    });
    expect(decideBotRunAdmission(admissionInput({
      now: 2_000,
      currentLease: liveLease,
    }))).toEqual({
      admitted: true,
      reason: 'expired',
      leaseGeneration: 5,
    });
  });

  test('rejects malformed lease and admission fields', () => {
    expect(() => decideBotRunAdmission(admissionInput({ queue: [] })))
      .toThrow('run admission input contains unknown field queue');
    expect(() => decideBotRunAdmission(admissionInput({
      currentLease: {
        runId: 'run-1',
        computerScopeKey: 'bot:other',
        leaseGeneration: 1,
        leaseUntil: 2_000,
      },
    }))).toThrow('currentLease computerScopeKey must match the requested scope');
  });
});

describe('Bot action interruption state', () => {
  test('makes terminal actions immutable and unknown writes reconcilable only', () => {
    expect(assertBotActionStateTransition({ from: 'proposed', to: 'pending_approval' }))
      .toBe('pending_approval');
    expect(assertBotActionStateTransition({ from: 'executing', to: 'unknown' })).toBe('unknown');
    expect(assertBotActionStateTransition({ from: 'unknown', to: 'reconciled' })).toBe('reconciled');
    expect(() => assertBotActionStateTransition({ from: 'unknown', to: 'executing' }))
      .toThrow('unknown Bot action must be reconciled before more execution');
    expect(() => assertBotActionStateTransition({ from: 'succeeded', to: 'executing' }))
      .toThrow('terminal Bot action state succeeded is immutable');

    expect(isBotActionTerminalState('succeeded')).toBe(true);
    expect(isBotActionTerminalState('reconciled')).toBe(true);
    expect(assertBotActionStateTransition({ from: 'pending_approval', to: 'cancelled' }))
      .toBe('cancelled');
    expect(isBotActionTerminalState('cancelled')).toBe(true);
    expect(isBotActionTerminalState('unknown')).toBe(false);
    expect(isBotActionUnknownWriteState('unknown')).toBe(true);
  });

  test('never converts an interrupted browser write into a retryable failure', () => {
    expect(resolveInterruptedBotAction({
      currentState: 'executing',
      operationKind: 'write',
    })).toBe('unknown');
    expect(resolveInterruptedBotAction({
      currentState: 'executing',
      operationKind: 'read',
    })).toBe('failed');
    expect(resolveInterruptedBotAction({
      currentState: 'approved',
      operationKind: 'write',
    })).toBe('failed');
    expect(() => resolveInterruptedBotAction({
      currentState: 'executing',
      operationKind: 'write',
      retry: true,
    })).toThrow('interrupted action input contains unknown field retry');
  });
});
