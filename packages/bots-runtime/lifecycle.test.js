import { describe, expect, test } from 'bun:test';

import {
  assertBotLifecycleTransition,
  assertBotRevisionUpdate,
  canTransitionBotLifecycle,
  validateBotRevisionRecord,
} from './lifecycle.js';

const revision = (overrides = {}) => ({
  revisionId: 'revision-01',
  botId: 'bot-01',
  revisionNumber: 1,
  contract: {
    model: { providerId: 'openai', modelId: 'gpt-5' },
    standingRole: 'Operations coordinator',
  },
  compiledHash: 'a'.repeat(64),
  createdBy: 'user-manager',
  createdAt: 1_000,
  activatedAt: null,
  retiredAt: null,
  ...overrides,
});

describe('Bot lifecycle policy', () => {
  test('allows only Draft to Active, Active/Paused toggles, and retirement', () => {
    expect(canTransitionBotLifecycle('draft', 'active')).toBe(true);
    expect(canTransitionBotLifecycle('active', 'paused')).toBe(true);
    expect(canTransitionBotLifecycle('paused', 'active')).toBe(true);
    expect(canTransitionBotLifecycle('active', 'retired')).toBe(true);
    expect(canTransitionBotLifecycle('paused', 'retired')).toBe(true);
    expect(canTransitionBotLifecycle('active', 'active')).toBe(true);

    expect(canTransitionBotLifecycle('draft', 'paused')).toBe(false);
    expect(canTransitionBotLifecycle('draft', 'retired')).toBe(false);
    expect(canTransitionBotLifecycle('retired', 'active')).toBe(false);
    expect(canTransitionBotLifecycle('paused', 'draft')).toBe(false);
  });

  test('validates transition boundary shape exactly', () => {
    expect(assertBotLifecycleTransition({ from: 'active', to: 'paused' })).toBe('paused');
    expect(() => assertBotLifecycleTransition({ from: 'draft', to: 'paused' }))
      .toThrow('invalid Bot lifecycle transition: draft -> paused');
    expect(() => assertBotLifecycleTransition({ from: 'active', to: 'paused', purge: true }))
      .toThrow('lifecycle transition input contains unknown field purge');
  });
});

describe('Bot revision immutability', () => {
  test('accepts exact JSON-only revision records', () => {
    const record = revision();
    expect(validateBotRevisionRecord(record)).toBe(record);
    expect(() => validateBotRevisionRecord({ ...record, mutable: true }))
      .toThrow('revision contains unknown field mutable');
    expect(() => validateBotRevisionRecord({ ...record, contract: { value: undefined } }))
      .toThrow('revision.contract.value must be JSON-compatible');
  });

  test('permits a Draft revision to change without changing its identity', () => {
    const previous = revision();
    const next = revision({
      contract: { ...previous.contract, standingRole: 'Updated coordinator' },
      compiledHash: 'b'.repeat(64),
    });

    expect(assertBotRevisionUpdate(previous, next)).toBe(next);
    expect(() => assertBotRevisionUpdate(previous, { ...next, revisionNumber: 2 }))
      .toThrow('revisionNumber is immutable');
    expect(() => assertBotRevisionUpdate(previous, revision({
      activatedAt: 2_000,
      retiredAt: 3_000,
    }))).toThrow('Draft revision cannot be retired');
  });

  test('makes activated revision content immutable while allowing one retirement stamp', () => {
    const active = revision({ activatedAt: 2_000 });
    const retired = revision({ activatedAt: 2_000, retiredAt: 3_000 });

    expect(() => assertBotRevisionUpdate(active, {
      ...active,
      contract: { ...active.contract, standingRole: 'Mutated after activation' },
    })).toThrow('activated revision content is immutable');
    expect(assertBotRevisionUpdate(active, retired)).toBe(retired);
    expect(() => assertBotRevisionUpdate(retired, { ...retired, retiredAt: 4_000 }))
      .toThrow('revision retirement metadata is immutable once set');
  });
});
