import { SupabaseRequestError } from './supabase-client.js';
import { AGENT_TEST_ACCOUNT_KIND } from './user-profile-visibility.js';

export const SETTINGS_PERMISSION_MATRIX_MIGRATION = '20260803150000';
export const USER_POLICY_FEATURE_OVERRIDES_MIGRATION = '20260805120000';
export const BROWSER_POLICY_CAPABILITY_MIGRATION = '20260806133832';
export const USER_PROFILE_GITHUB_ACCOUNT_MIGRATION = '20260804100000';
export const GITHUB_ACCOUNT_REASSIGNMENT_MIGRATION = '20260804120000';
export const PRODUCTION_BOTS_MIGRATION = '20260901160000';
export const PRODUCTION_BOTS_MIGRATION_ERROR_CODE = 'bot_schema_migration_required';
export const AUTH_ERROR_CODES = Object.freeze({
  identityUnavailable: 'identity_unavailable',
  schemaMigrationRequired: 'schema_migration_required',
});

const CANONICAL_USER_POLICY_SELECT =
  'user_id,settings_pages,settings_permission_overrides,capabilities,settings_overrides,feature_overrides,updated_at';
const PRE_FEATURE_OVERRIDES_USER_POLICY_SELECT =
  'user_id,settings_pages,settings_permission_overrides,capabilities,settings_overrides,updated_at';
const LEGACY_USER_POLICY_SELECT =
  'user_id,settings_pages,capabilities,settings_overrides,updated_at';
const AGENT_TEST_ROLES = Object.freeze(['developer', 'admin']);
const AGENT_TEST_LABELS = Object.freeze({
  developer: 'Test Developer',
  admin: 'Test Administrator',
});
const PRODUCTION_BOTS_RELATIONS = Object.freeze([
  'bots',
  'bot_revisions',
  'bot_memberships',
  'bot_channels',
  'bot_channel_acl',
  'bot_messages',
  'bot_objects',
  'bot_runs',
  'bot_action_attempts',
  'bot_approvals',
  'bot_credentials',
  'bot_environment_secrets',
  'bot_routines',
  'bot_routine_occurrences',
  'bot_memories',
  'bot_memory_versions',
  'bot_memory_sources',
  'bot_library_sources',
  'bot_library_versions',
  'bot_skill_packages',
  'bot_mcp_bindings',
  'bot_audit_events',
  'bot_eval_cases',
  'bot_eval_runs',
]);
const PRODUCTION_BOTS_FUNCTIONS = Object.freeze([
  'devryan_bot_schema_version',
  'devryan_allocate_bot_message_sequence',
  'devryan_enqueue_bot_message_run',
  'devryan_claim_bot_run',
  'devryan_claim_bot_routine_occurrence',
  'devryan_create_bot',
  'devryan_activate_bot_revision',
  'devryan_publish_bot_revision',
  'devryan_commit_bot_memory_version',
  'devryan_delete_bot_channel',
  'devryan_prune_bot_audit',
  'devryan_purge_bot_resource',
  'devryan_purge_bot',
]);
const PRODUCTION_BOTS_SCHEMA_ERROR_CODES = new Set([
  '42P01',
  '42703',
  '42883',
  'PGRST202',
  'PGRST204',
  'PGRST205',
]);

const normalizedErrorMessage = (error) => String(error?.message || '').trim().toLowerCase();

export const isMissingSettingsPermissionOverridesError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 400) return false;
  const message = normalizedErrorMessage(error);
  return message.includes('user_policies')
    && message.includes('settings_permission_overrides')
    && (message.includes('does not exist') || message.includes('schema cache'));
};

export const isMissingFeatureOverridesError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 400) return false;
  const message = normalizedErrorMessage(error);
  return message.includes('user_policies')
    && message.includes('feature_overrides')
    && (message.includes('does not exist') || message.includes('schema cache'));
};

export const isMissingBrowserPolicyCapabilityError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 400) return false;
  const message = normalizedErrorMessage(error);
  return message.includes('role_policies')
    && message.includes('can_use_browser')
    && (message.includes('does not exist') || message.includes('schema cache'));
};

export const isMissingUserProfileGithubAccountError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 400) return false;
  const message = normalizedErrorMessage(error);
  return message.includes('user_profiles')
    && message.includes('github_account_id')
    && (message.includes('does not exist') || message.includes('schema cache'));
};

export const isMissingGithubAccountReassignmentFunctionError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 404) return false;
  const code = String(error.payload?.code || '').trim().toUpperCase();
  const message = normalizedErrorMessage(error);
  return code === 'PGRST202'
    && message.includes('devryan_reassign_github_account');
};

export const isMissingProductionBotsSchemaError = (error) => {
  if (!(error instanceof SupabaseRequestError) || ![400, 404].includes(error.status)) return false;
  const code = String(error.payload?.code || '').trim().toUpperCase();
  const message = normalizedErrorMessage(error);
  const referencesBotSchema = [...PRODUCTION_BOTS_RELATIONS, ...PRODUCTION_BOTS_FUNCTIONS]
    .some((name) => message.includes(name));
  if (!referencesBotSchema) return false;

  const hasMissingSchemaWording = message.includes('does not exist')
    || message.includes('schema cache')
    || message.includes('could not find the table')
    || message.includes('could not find the function')
    || message.includes('could not find the column');
  return PRODUCTION_BOTS_SCHEMA_ERROR_CODES.has(code) || hasMissingSchemaWording;
};

export const productionBotsMigrationFailurePayload = (error) => {
  if (error?.code !== PRODUCTION_BOTS_MIGRATION_ERROR_CODE
    && !isMissingProductionBotsSchemaError(error)) return null;
  return {
    status: 503,
    error: 'Database migration required',
    code: PRODUCTION_BOTS_MIGRATION_ERROR_CODE,
    requiredMigration: typeof error?.requiredMigration === 'string'
      ? error.requiredMigration
      : PRODUCTION_BOTS_MIGRATION,
  };
};

export const isSettingsPermissionSchemaError = (error) => {
  if (isMissingSettingsPermissionOverridesError(error)) return true;
  if (!(error instanceof SupabaseRequestError) || error.status !== 400) return false;
  const message = normalizedErrorMessage(error);
  return message.includes('role_policies')
    && message.includes('settings_permissions')
    && (message.includes('does not exist') || message.includes('schema cache'));
};

export const authFailurePayload = (error) => {
  if (error?.code === AUTH_ERROR_CODES.schemaMigrationRequired
    || isSettingsPermissionSchemaError(error)) {
    return {
      status: 503,
      error: 'Database migration required',
      code: AUTH_ERROR_CODES.schemaMigrationRequired,
      requiredMigration: SETTINGS_PERMISSION_MATRIX_MIGRATION,
    };
  }
  return {
    status: 503,
    error: 'Identity service unavailable',
    code: AUTH_ERROR_CODES.identityUnavailable,
  };
};

export const isDefinitiveRefreshRejection = (error) => error instanceof SupabaseRequestError
  && [400, 401, 403].includes(error.status);

export const createUserPolicyReader = ({ supabase, logger = console } = {}) => {
  let warnedAboutLegacySchema = false;
  let warnedAboutFeatureOverridesSchema = false;

  return async (userId) => {
    const baseQuery = {
      user_id: `eq.${String(userId || '').replace(/[(),]/g, '')}`,
      limit: 1,
    };
    const select = async (columns) => supabase.rest('user_policies', {
      query: { ...baseQuery, select: columns },
      maybeSingle: true,
    });
    try {
      return await select(CANONICAL_USER_POLICY_SELECT);
    } catch (error) {
      if (isMissingFeatureOverridesError(error)) {
        if (!warnedAboutFeatureOverridesSchema) {
          warnedAboutFeatureOverridesSchema = true;
          logger.warn?.(
            `[MultiUser] Supabase migration ${USER_POLICY_FEATURE_OVERRIDES_MIGRATION} is pending; per-user agent/MCP feature overrides are inactive.`,
          );
        }
        return select(PRE_FEATURE_OVERRIDES_USER_POLICY_SELECT);
      }
      if (!isMissingSettingsPermissionOverridesError(error)) throw error;
      if (!warnedAboutLegacySchema) {
        warnedAboutLegacySchema = true;
        logger.warn?.(
          `[MultiUser] Supabase migration ${SETTINGS_PERMISSION_MATRIX_MIGRATION} is pending; using legacy read-only settings policy compatibility.`,
        );
      }
      return select(LEGACY_USER_POLICY_SELECT);
    }
  };
};

const isActiveAgentTestProfile = (profile) => profile?.account_kind === AGENT_TEST_ACCOUNT_KIND
  && profile?.status === 'active';

export const buildAgentTestIdentities = (profiles) => AGENT_TEST_ROLES.flatMap((role) => {
  const matches = (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => isActiveAgentTestProfile(profile) && profile.role === role);
  return matches.length === 1 ? [{ role, label: AGENT_TEST_LABELS[role] }] : [];
});

const requestError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export const selectAgentTestProfile = (profiles, { role, email } = {}) => {
  const rawRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (rawRole && !AGENT_TEST_ROLES.includes(rawRole)) {
    throw requestError('Agent-test role must be developer or admin', 400);
  }
  if (!rawRole && !normalizedEmail) {
    throw requestError('Agent-test role or email is required', 400);
  }

  const activeProfiles = (Array.isArray(profiles) ? profiles : []).filter(isActiveAgentTestProfile);
  const emailMatches = normalizedEmail
    ? activeProfiles.filter((profile) => String(profile.email || '').trim().toLowerCase() === normalizedEmail)
    : activeProfiles;
  if (rawRole && normalizedEmail && emailMatches.some((profile) => profile.role !== rawRole)) {
    throw requestError('Agent-test role and email do not match', 400);
  }
  const matches = rawRole ? emailMatches.filter((profile) => profile.role === rawRole) : emailMatches;
  if (matches.length === 0) {
    throw requestError('Only active agent-test accounts may use this endpoint', 403);
  }
  if (matches.length > 1) {
    throw requestError('Agent-test identity is ambiguous', 409);
  }
  return matches[0];
};
