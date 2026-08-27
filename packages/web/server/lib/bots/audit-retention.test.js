import { describe, expect, it, vi } from 'vitest';

import {
  BOT_AUDIT_DEFAULT_RETENTION_DAYS,
  createBotAuditRetention,
  resolveBotAuditRetentionDays,
  validateBotAuditMetadata,
} from './audit-retention.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';

describe('Production Bots audit retention', () => {
  it('defaults to one year and enforces the database retention floor', () => {
    expect(resolveBotAuditRetentionDays(undefined)).toBe(BOT_AUDIT_DEFAULT_RETENTION_DAYS);
    expect(resolveBotAuditRetentionDays('90')).toBe(90);
    expect(() => resolveBotAuditRetentionDays(45, 90)).toThrow(/at least 90 days/);
    expect(() => resolveBotAuditRetentionDays(10, 1)).toThrow(/at least 30 days/);
    expect(() => resolveBotAuditRetentionDays(29)).toThrow(expect.objectContaining({
      code: 'bot_audit_retention_invalid',
      statusCode: 500,
    }));
  });

  it('accepts identifiers and outcomes but rejects content-bearing audit payloads', () => {
    expect(validateBotAuditMetadata({
      channelId: 'channel-a',
      messageId: 'message-a',
      statusCode: 403,
      result: 'denied',
    })).toEqual({
      channelId: 'channel-a',
      messageId: 'message-a',
      statusCode: 403,
      result: 'denied',
    });
    for (const metadata of [
      { prompt: 'secret prompt' },
      { responseBody: 'secret response' },
      { nested: { accessToken: 'secret token' } },
      { output: ['tool output'] },
    ]) {
      expect(() => validateBotAuditMetadata(metadata)).toThrow(/content-bearing/);
    }
  });

  it('writes only validated Bot audit fields and mirrors a content-free platform event', async () => {
    const store = {
      available: true,
      insert: vi.fn(async (_table, row) => row),
      pruneAudit: vi.fn(async () => 0),
    };
    const platformAudit = vi.fn(async () => {});
    const service = createBotAuditRetention({ store, platformAudit });
    const principal = { id: USER_ID, role: 'developer', scope: 'managed' };

    await service.record({
      principal,
      botId: BOT_ID,
      targetType: 'bot_channel',
      targetId: 'channel-reference',
      action: 'bot.channel.read',
      result: 'success',
      metadata: { channelId: 'channel-reference', statusCode: 200 },
    });

    expect(store.insert).toHaveBeenCalledWith('bot_audit_events', {
      event_id: expect.any(String),
      bot_id: BOT_ID,
      actor_user_id: USER_ID,
      target_type: 'bot_channel',
      target_id: 'channel-reference',
      action: 'bot.channel.read',
      result: 'success',
      metadata: { channelId: 'channel-reference', statusCode: 200 },
    });
    expect(platformAudit).toHaveBeenCalledWith(principal, 'bot.channel.read', expect.objectContaining({
      success: true,
      metadata: { botId: BOT_ID, result: 'success', channelId: 'channel-reference', statusCode: 200 },
    }));
  });

  it('prunes at the configured cutoff and stops its daily timer', async () => {
    const calls = [];
    const store = {
      available: true,
      insert: vi.fn(),
      pruneAudit: vi.fn(async () => {
        calls.push('prune');
        return 7;
      }),
    };
    const timer = { unref: vi.fn() };
    const setIntervalImpl = vi.fn(() => timer);
    const clearIntervalImpl = vi.fn();
    const service = createBotAuditRetention({
      store,
      retentionDays: 365,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      setIntervalImpl,
      clearIntervalImpl,
      withAuditDeliveryBarrier: async (operation) => {
        calls.push('barrier:start');
        const result = await operation();
        calls.push('barrier:end');
        return result;
      },
    });

    await service.start();
    expect(calls).toEqual(['barrier:start', 'prune', 'barrier:end']);
    expect(store.pruneAudit).toHaveBeenCalledWith('2025-08-22T12:00:00.000Z');
    expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 86_400_000);
    expect(timer.unref).toHaveBeenCalled();
    service.shutdown();
    expect(clearIntervalImpl).toHaveBeenCalledWith(timer);
  });
});
