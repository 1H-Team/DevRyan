import { SupabaseRequestError } from './supabase-client.js';
import { AGENT_TEST_ACCOUNT_KIND } from './user-profile-visibility.js';

export const SETTINGS_PERMISSION_MATRIX_MIGRATION = '20260803150000';
export const USER_PROFILE_GITHUB_ACCOUNT_MIGRATION = '20260804100000';
export const GITHUB_ACCOUNT_REASSIGNMENT_MIGRATION = '20260804120000';
export const AUTH_ERROR_CODES = Object.freeze({
  identityUnavailable: 'identity_unavailable',
  schemaMigrationRequired: 'schema_migration_required',
});

const CANONICAL_USER_POLICY_SELECT =
  'user_id,settings_pages,settings_permission_overrides,capabilities,settings_overrides,updated_at';
const LEGACY_USER_POLICY_SELECT =
  'user_id,settings_pages,capabilities,settings_overrides,updated_at';
const AGENT_TEST_ROLES = Object.freeze(['developer', 'admin']);
const AGENT_TEST_LABELS = Object.freeze({
  developer: 'Test Developer',
  admin: 'Test Administrator',
});

const normalizedErrorMessage = (error) => String(error?.message || '').trim().toLowerCase();

export const isMissingSettingsPermissionOverridesError = (error) => {
  if (!(error instanceof SupabaseRequestError) || error.status !== 400) return false;
  const message = normalizedErrorMessage(error);
  return message.includes('user_policies')
    && message.includes('settings_permission_overrides')
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

  return async (userId) => {
    const baseQuery = {
      user_id: `eq.${String(userId || '').replace(/[(),]/g, '')}`,
      limit: 1,
    };
    try {
      return await supabase.rest('user_policies', {
        query: { ...baseQuery, select: CANONICAL_USER_POLICY_SELECT },
        maybeSingle: true,
      });
    } catch (error) {
      if (!isMissingSettingsPermissionOverridesError(error)) throw error;
      if (!warnedAboutLegacySchema) {
        warnedAboutLegacySchema = true;
        logger.warn?.(
          `[MultiUser] Supabase migration ${SETTINGS_PERMISSION_MATRIX_MIGRATION} is pending; using legacy read-only settings policy compatibility.`,
        );
      }
      return supabase.rest('user_policies', {
        query: { ...baseQuery, select: LEGACY_USER_POLICY_SELECT },
        maybeSingle: true,
      });
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
