import { describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_RETENTION_MIGRATION,
  USER_ANALYTICS_PURGE_MIGRATION,
  createAnalyticsRetentionService,
  isMissingAnalyticsRetentionFunctionError,
} from './analytics-retention.js';
import { SupabaseRequestError } from './supabase-client.js';

describe('analytics retention service', () => {
  it('locks developer retention and normalizes purge counts', async () => {
    const rpc = vi.fn(async (name) => {
      if (name === 'devryan_lock_user_analytics_retention') {
        return { locked: true, protectedAt: '2026-08-07T10:00:00.000Z' };
      }
      if (name === 'devryan_purge_user_activity_logs') {
        return { complete: true, deletedCount: '17', remainingCount: 0 };
      }
      return { deletedCount: '17', protectedCount: 23 };
    });
    const service = createAnalyticsRetentionService({ supabase: { rpc } });

    await expect(service.lockUser('user-1')).resolves.toEqual({
      locked: true,
      protectedAt: '2026-08-07T10:00:00.000Z',
    });
    await expect(service.purgeUnprotected({ preserveEventId: 'event-1' })).resolves.toEqual({
      deletedCount: 17,
      protectedCount: 23,
    });
    await expect(service.purgeUser({ userId: 'user-1', preserveEventId: 'event-2' })).resolves.toEqual({
      deletedCount: 17,
      remainingCount: 0,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'devryan_lock_user_analytics_retention', { p_user_id: 'user-1' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'devryan_purge_unprotected_activity_logs', {
      p_preserve_event_id: 'event-1',
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'devryan_purge_user_activity_logs', {
      p_user_id: 'user-1',
      p_preserve_event_id: 'event-2',
    });
  });

  it('turns missing retention RPCs into a structured migration requirement', async () => {
    const missing = new SupabaseRequestError(
      'Could not find the function public.devryan_lock_user_analytics_retention in the schema cache',
      { status: 404, payload: { code: 'PGRST202' } },
    );
    expect(isMissingAnalyticsRetentionFunctionError(missing)).toBe(true);
    const service = createAnalyticsRetentionService({ supabase: { rpc: vi.fn().mockRejectedValue(missing) } });

    await expect(service.lockUser('user-1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'schema_migration_required',
      requiredMigration: ANALYTICS_RETENTION_MIGRATION,
    });
  });

  it('rejects a non-lockable profile instead of deleting session content unprotected', async () => {
    const service = createAnalyticsRetentionService({
      supabase: { rpc: vi.fn().mockResolvedValue({ locked: false, protectedAt: null }) },
    });
    await expect(service.lockUser('admin-user')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reports the scoped purge migration when the per-user RPC is unavailable', async () => {
    const missing = new SupabaseRequestError(
      'Could not find the function public.devryan_purge_user_activity_logs in the schema cache',
      { status: 404, payload: { code: 'PGRST202' } },
    );
    const service = createAnalyticsRetentionService({ supabase: { rpc: vi.fn().mockRejectedValue(missing) } });
    await expect(service.purgeUser({ userId: 'user-1', preserveEventId: 'event-1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'schema_migration_required',
      requiredMigration: USER_ANALYTICS_PURGE_MIGRATION,
    });
  });

  it('rejects the legacy partial-purge result as a migration requirement', async () => {
    const service = createAnalyticsRetentionService({
      supabase: {
        rpc: vi.fn().mockResolvedValue({ deletedCount: 7, protectedCount: 2 }),
      },
    });
    await expect(service.purgeUser({ userId: 'user-1', preserveEventId: 'event-1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'schema_migration_required',
      requiredMigration: USER_ANALYTICS_PURGE_MIGRATION,
    });
  });

  it('fails closed when the database reports remaining target analytics', async () => {
    const service = createAnalyticsRetentionService({
      supabase: {
        rpc: vi.fn().mockResolvedValue({ complete: true, deletedCount: 7, remainingCount: 1 }),
      },
    });
    await expect(service.purgeUser({ userId: 'user-1', preserveEventId: 'event-1' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'analytics_purge_incomplete',
    });
  });
});
