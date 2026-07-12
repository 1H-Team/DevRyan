import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createAgentCache } from './agent-cache.js';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

const createHarness = (options = {}) => {
  let currentTime = 0;
  const evictions = [];
  const cache = createAgentCache({
    maxEntries: options.maxEntries ?? 16,
    idleTtlMs: options.idleTtlMs ?? THIRTY_MINUTES_MS,
    now: () => currentTime,
    onEvict: (value, metadata) => {
      evictions.push({ value, metadata });
    },
  });
  return {
    cache,
    evictions,
    advance(ms) {
      currentTime += ms;
    },
  };
};

describe('createAgentCache', () => {
  test('caps idle entries at 16 and uses access-order LRU', () => {
    const { cache, evictions } = createHarness();
    for (let index = 0; index < 16; index += 1) {
      cache.set(`key-${index}`, `agent-${index}`, { sessionID: `session-${index}` });
    }

    assert.equal(cache.get('key-0'), 'agent-0');
    cache.set('key-16', 'agent-16', { sessionID: 'session-16' });

    assert.equal(cache.size, 16);
    assert.equal(cache.get('key-1'), undefined);
    assert.equal(cache.get('key-0'), 'agent-0');
    assert.deepEqual(evictions.map((entry) => entry.metadata), [{
      key: 'key-1',
      sessionID: 'session-1',
      reason: 'capacity',
    }]);
  });

  test('expires idle entries only after the 30-minute TTL', () => {
    const { cache, evictions, advance } = createHarness();
    cache.set('key-a', 'agent-a', { sessionID: 'session-a' });

    advance(THIRTY_MINUTES_MS);
    assert.equal(cache.prune(), 0);
    assert.equal(cache.size, 1);

    advance(1);
    assert.equal(cache.prune(), 1);
    assert.equal(cache.size, 0);
    assert.equal(evictions[0].metadata.reason, 'idle_ttl');
  });

  test('protects active entries and permits temporary overflow', () => {
    const { cache, evictions } = createHarness({ maxEntries: 2 });
    cache.set('key-a', 'agent-a', { sessionID: 'session-a', active: true });
    cache.set('key-b', 'agent-b', { sessionID: 'session-b', active: true });
    cache.set('key-c', 'agent-c', { sessionID: 'session-c', active: true });

    assert.equal(cache.size, 3);
    assert.equal(cache.prune(), 0);
    assert.equal(evictions.length, 0);

    cache.markInactive('key-a');
    assert.equal(cache.size, 2);
    assert.equal(cache.get('key-a'), undefined);
    assert.equal(evictions[0].metadata.reason, 'capacity');
  });

  test('does not expire an active entry and restarts its idle TTL on completion', () => {
    const { cache, advance } = createHarness();
    cache.set('key-a', 'agent-a', { sessionID: 'session-a', active: true });
    advance(THIRTY_MINUTES_MS + 1);

    assert.equal(cache.prune(), 0);
    assert.equal(cache.size, 1);

    cache.markInactive('key-a');
    assert.equal(cache.size, 1);
    advance(THIRTY_MINUTES_MS + 1);
    assert.equal(cache.prune(), 1);
  });

  test('keeps an active value when a concurrent creation finishes later', () => {
    const { cache, evictions } = createHarness();
    cache.set('key-a', 'agent-active', { sessionID: 'session-a', active: true });

    const stored = cache.set('key-a', 'agent-duplicate', {
      sessionID: 'session-a',
      active: true,
    });

    assert.equal(stored, 'agent-active');
    assert.equal(cache.get('key-a'), 'agent-active');
    assert.deepEqual(evictions, [{
      value: 'agent-duplicate',
      metadata: {
        key: 'key-a',
        sessionID: 'session-a',
        reason: 'duplicate',
      },
    }]);
    cache.markInactive('key-a');
    cache.markInactive('key-a');
    assert.equal(cache.size, 1);
  });

  test('releases idle session entries and defers active release until completion', () => {
    const { cache, evictions } = createHarness();
    cache.set('key-a-1', 'agent-a-1', { sessionID: 'session-a' });
    cache.set('key-a-2', 'agent-a-2', { sessionID: 'session-a', active: true });
    cache.set('key-b', 'agent-b', { sessionID: 'session-b' });

    assert.equal(cache.releaseSession('session-a'), 2);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('key-a-1'), undefined);
    assert.equal(cache.get('key-a-2'), undefined);
    assert.equal(cache.get('key-b'), 'agent-b');

    cache.markInactive('key-a-2');
    assert.equal(cache.size, 1);
    assert.deepEqual(evictions.map((entry) => entry.value), ['agent-a-1', 'agent-a-2']);
    assert.ok(evictions.every((entry) => entry.metadata.reason === 'session_release'));
  });

  test('calls onEvict once per value across repeated release and shutdown clear', () => {
    const { cache, evictions } = createHarness();
    cache.set('key-a', 'agent-a', { sessionID: 'session-a' });
    cache.set('key-b', 'agent-b', { sessionID: 'session-b' });

    cache.releaseSession('session-a');
    cache.releaseSession('session-a');
    assert.equal(cache.clear(), 1);
    assert.equal(cache.clear(), 0);

    assert.deepEqual(evictions.map((entry) => entry.value), ['agent-a', 'agent-b']);
    assert.deepEqual(evictions.map((entry) => entry.metadata.reason), ['session_release', 'shutdown']);
  });
});
