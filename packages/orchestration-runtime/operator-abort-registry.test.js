import { describe, expect, test } from 'bun:test';

import { createManagedOperatorAbortRegistry } from './operator-abort-registry.js';

describe('managed operator abort registry', () => {
  test('reads only requests at or after the attempt baseline', () => {
    const registry = createManagedOperatorAbortRegistry({ now: () => 2_000 });
    expect(registry.record({ sessionId: ' ses_child ' })).toEqual({ sessionId: 'ses_child', requestedAt: 2_000 });
    expect(registry.read({ sessionId: 'ses_child', after: 1_500 })).toEqual({ sessionId: 'ses_child', requestedAt: 2_000 });
    expect(registry.read({ sessionId: 'ses_child', after: 2_001 })).toBeNull();
    expect(registry.read({ sessionId: 'ses_other' })).toBeNull();
    expect(registry.record({ sessionId: '' })).toBeNull();
  });

  test('a rejected abort withdraws only its own request', () => {
    const registry = createManagedOperatorAbortRegistry();
    registry.record({ sessionId: 's', requestedAt: 1_000 });
    registry.record({ sessionId: 's', requestedAt: 2_000 });
    expect(registry.withdraw({ sessionId: 's', requestedAt: 1_000 })).toBe(false);
    expect(registry.read({ sessionId: 's' })?.requestedAt).toBe(2_000);
    expect(registry.withdraw({ sessionId: 's', requestedAt: 2_000 })).toBe(true);
    expect(registry.read({ sessionId: 's' })).toBeNull();
  });

  test('forgets deleted sessions and stays bounded', () => {
    const registry = createManagedOperatorAbortRegistry({ maximumSessions: 2 });
    for (const sessionId of ['a', 'b', 'c']) registry.record({ sessionId, requestedAt: 1 });
    expect(registry.size).toBe(2);
    expect(registry.read({ sessionId: 'a' })).toBeNull();
    expect(registry.observe({ type: 'session.deleted', properties: { info: { id: 'b' } } })).toBe(true);
    expect(registry.read({ sessionId: 'b' })).toBeNull();
    expect(registry.observe({ type: 'session.idle', properties: { sessionID: 'c' } })).toBe(false);
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
