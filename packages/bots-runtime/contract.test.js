import { describe, expect, test } from 'bun:test';

import {
  BOT_ACTION_STATES,
  BOT_ERROR_CODES,
  BOT_LIFECYCLES,
  BOT_MEMBER_ROLES,
  BOT_RUN_STATES,
  BOT_TENANCIES,
  canonicalizeBotJson,
  hashCanonicalBotJson,
  resolveComputerScopeKey,
  resolveReasoningScopeKey,
} from './contract.js';

describe('Bots runtime contract', () => {
  test('publishes the stable product enums and error codes', () => {
    expect(BOT_LIFECYCLES).toEqual(['draft', 'active', 'paused', 'retired']);
    expect(BOT_TENANCIES).toEqual(['team', 'personalized']);
    expect(BOT_MEMBER_ROLES).toEqual(['member', 'operator', 'manager']);
    expect(BOT_RUN_STATES).toEqual([
      'queued',
      'starting',
      'running',
      'waiting_approval',
      'needs_reconciliation',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ]);
    expect(BOT_ACTION_STATES).toEqual([
      'proposed',
      'pending_approval',
      'approved',
      'executing',
      'succeeded',
      'failed',
      'unknown',
      'reconciled',
      'denied',
      'cancelled',
    ]);
    expect(BOT_ERROR_CODES.dockerUnavailable).toBe('bot_runtime_docker_unavailable');
    expect(BOT_ERROR_CODES.actionNeedsReconciliation).toBe('bot_action_needs_reconciliation');
    expect(Object.isFrozen(BOT_LIFECYCLES)).toBe(true);
    expect(Object.isFrozen(BOT_ERROR_CODES)).toBe(true);
  });

  test('derives isolated reasoning scopes and one shared computer per Bot', () => {
    expect(resolveComputerScopeKey({
      botId: 'bot-01',
      tenancy: 'team',
      ownerUserId: 'user-01',
    })).toBe('bot:bot-01');
    // Legacy records still carry 'personalized'; they resolve to the same
    // shared computer rather than reviving a per-owner scope.
    expect(resolveComputerScopeKey({
      botId: 'bot-01',
      tenancy: 'personalized',
      ownerUserId: 'user-01',
    })).toBe('bot:bot-01');
    expect(resolveComputerScopeKey({
      botId: 'bot-01',
      tenancy: 'team',
      ownerUserId: 'user-02',
    })).toBe('bot:bot-01');
    expect(resolveReasoningScopeKey({ channelId: 'channel-01' })).toBe('channel:channel-01');
  });

  test('rejects missing, malformed, and unknown scope fields', () => {
    expect(() => resolveComputerScopeKey({
      botId: 'bot-01',
      tenancy: 'shared',
      ownerUserId: 'user-01',
    })).toThrow('tenancy must be one of team, personalized');
    expect(() => resolveComputerScopeKey({
      botId: 'bot-01',
      tenancy: 'team',
      ownerUserId: 'user-01',
      directory: '/private',
    })).toThrow('computer scope input contains unknown field directory');
    expect(() => resolveReasoningScopeKey({ channelId: '' }))
      .toThrow('channelId must be a non-empty string');
  });

  test('canonicalizes JSON recursively and produces a fixed SHA-256 vector', () => {
    const value = {
      z: -0,
      list: [{ z: 1, x: 2 }],
      a: { b: 2, a: 1 },
    };
    const canonical = '{"a":{"a":1,"b":2},"list":[{"x":2,"z":1}],"z":0}';

    expect(canonicalizeBotJson(value)).toBe(canonical);
    expect(hashCanonicalBotJson(value)).toBe(
      '87e2bd64a52a97d5b4279a2b00228ea642ebc362b4388b29005677f9d95bafc5',
    );
    expect(hashCanonicalBotJson({ a: { a: 1, b: 2 }, list: [{ x: 2, z: 1 }], z: 0 }))
      .toBe(hashCanonicalBotJson(value));
  });

  test('rejects every non-JSON value instead of silently dropping it', () => {
    expect(() => canonicalizeBotJson({ value: undefined }))
      .toThrow('value.value must be JSON-compatible');
    expect(() => canonicalizeBotJson({ value: Number.NaN }))
      .toThrow('value.value must be a finite JSON number');
    expect(() => canonicalizeBotJson(new Date(0)))
      .toThrow('value must be a plain JSON object');

    const accessorArray = [1];
    Object.defineProperty(accessorArray, '0', { get: () => 1 });
    expect(() => canonicalizeBotJson(accessorArray))
      .toThrow('value[0] must be a JSON data property');

    const widenedArray = [1];
    widenedArray.extra = true;
    expect(() => canonicalizeBotJson(widenedArray))
      .toThrow('value contains a non-JSON array property');
  });
});
