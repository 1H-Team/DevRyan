import { SupabaseRequestError } from './supabase-client.js';

export const ANALYTICS_RETENTION_MIGRATION = '20260807100000';
export const USER_ANALYTICS_PURGE_MIGRATION = '20260830123704';

const RETENTION_RPC_NAMES = new Set([
  'devryan_lock_user_analytics_retention',
  'devryan_purge_unprotected_activity_logs',
  'devryan_purge_user_activity_logs',
]);

const normalizedErrorMessage = (error) => String(error?.message || '').trim().toLowerCase();

export const isMissingAnalyticsRetentionFunctionError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 404) return false;
  const code = String(error.payload?.code || '').trim().toUpperCase();
  const message = normalizedErrorMessage(error);
  return code === 'PGRST202' && [...RETENTION_RPC_NAMES].some((name) => message.includes(name));
};

const migrationRequiredError = () => Object.assign(
  new Error('Database migration required'),
  {
    statusCode: 503,
    code: 'schema_migration_required',
    requiredMigration: ANALYTICS_RETENTION_MIGRATION,
  },
);

const userPurgeMigrationRequiredError = () => Object.assign(
  new Error('Database migration required'),
  {
    statusCode: 503,
    code: 'schema_migration_required',
    requiredMigration: USER_ANALYTICS_PURGE_MIGRATION,
  },
);

const normalizeCount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
};

export const createAnalyticsRetentionService = ({ supabase } = {}) => ({
  async lockUser(userId) {
    try {
      const result = await supabase.rpc('devryan_lock_user_analytics_retention', {
        p_user_id: userId,
      });
      if (result?.locked !== true) {
        throw Object.assign(new Error('Developer analytics retention could not be locked'), { statusCode: 409 });
      }
      return {
        locked: true,
        protectedAt: typeof result.protectedAt === 'string' ? result.protectedAt : null,
      };
    } catch (error) {
      if (isMissingAnalyticsRetentionFunctionError(error)) throw migrationRequiredError();
      throw error;
    }
  },

  async purgeUnprotected({ preserveEventId }) {
    try {
      const result = await supabase.rpc('devryan_purge_unprotected_activity_logs', {
        p_preserve_event_id: preserveEventId,
      });
      return {
        deletedCount: normalizeCount(result?.deletedCount),
        protectedCount: normalizeCount(result?.protectedCount),
      };
    } catch (error) {
      if (isMissingAnalyticsRetentionFunctionError(error)) throw migrationRequiredError();
      throw error;
    }
  },

  async purgeUser({ userId, preserveEventId }) {
    try {
      const result = await supabase.rpc('devryan_purge_user_activity_logs', {
        p_user_id: userId,
        p_preserve_event_id: preserveEventId,
      });
      if (result?.complete !== true || !Object.hasOwn(result || {}, 'remainingCount')) {
        throw userPurgeMigrationRequiredError();
      }
      const remainingCount = normalizeCount(result.remainingCount);
      if (remainingCount !== 0) {
        throw Object.assign(new Error('Analytics clear did not remove the complete user snapshot'), {
          statusCode: 409,
          code: 'analytics_purge_incomplete',
        });
      }
      return {
        deletedCount: normalizeCount(result?.deletedCount),
        remainingCount,
      };
    } catch (error) {
      if (isMissingAnalyticsRetentionFunctionError(error)) throw userPurgeMigrationRequiredError();
      throw error;
    }
  },
});
