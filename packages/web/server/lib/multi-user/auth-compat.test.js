import { describe, expect, it, vi } from 'vitest';

import {
  AUTH_ERROR_CODES,
  PRODUCTION_BOTS_MIGRATION,
  authFailurePayload,
  buildAgentTestIdentities,
  createUserPolicyReader,
  isDefinitiveRefreshRejection,
  isMissingBrowserPolicyCapabilityError,
  isMissingGithubAccountReassignmentFunctionError,
  isMissingSettingsPermissionOverridesError,
  isMissingUserProfileGithubAccountError,
  isSettingsPermissionSchemaError,
  productionBotsMigrationFailurePayload,
  selectAgentTestProfile,
} from './auth-compat.js';
import { SupabaseRequestError } from './supabase-client.js';

const profile = (role, overrides = {}) => ({
  id: `${role}-id`,
  email: `${role}@example.test`,
  role,
  status: 'active',
  account_kind: 'agent_test',
  ...overrides,
});

describe('multi-user authentication compatibility', () => {
  it('uses the canonical policy projection when the schema is current', async () => {
    const policy = { user_id: 'user-id', settings_permission_overrides: {} };
    const supabase = { rest: vi.fn(async () => policy) };
    const readUserPolicy = createUserPolicyReader({ supabase });

    await expect(readUserPolicy('user-id')).resolves.toBe(policy);
    expect(supabase.rest).toHaveBeenCalledOnce();
    expect(supabase.rest.mock.calls[0][1].query.select).toContain('settings_permission_overrides');
  });

  it('retries only the missing permission column with legacy fields and warns once', async () => {
    const missingColumn = new SupabaseRequestError(
      "column user_policies.settings_permission_overrides does not exist",
      { status: 400 },
    );
    const supabase = {
      rest: vi.fn()
        .mockRejectedValueOnce(missingColumn)
        .mockResolvedValueOnce({ user_id: 'user-id', settings_pages: ['home'] })
        .mockRejectedValueOnce(missingColumn)
        .mockResolvedValueOnce({ user_id: 'other-id', settings_pages: ['home'] }),
    };
    const logger = { warn: vi.fn() };
    const readUserPolicy = createUserPolicyReader({ supabase, logger });

    await expect(readUserPolicy('user-id')).resolves.toMatchObject({ user_id: 'user-id' });
    await expect(readUserPolicy('other-id')).resolves.toMatchObject({ user_id: 'other-id' });
    expect(supabase.rest.mock.calls[1][1].query.select).not.toContain('settings_permission_overrides');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('propagates unrelated PostgREST errors without a legacy retry', async () => {
    const unrelated = new SupabaseRequestError('permission denied for table user_policies', { status: 400 });
    const supabase = { rest: vi.fn(async () => { throw unrelated; }) };
    const readUserPolicy = createUserPolicyReader({ supabase });

    await expect(readUserPolicy('user-id')).rejects.toBe(unrelated);
    expect(supabase.rest).toHaveBeenCalledOnce();
    expect(isMissingSettingsPermissionOverridesError(unrelated)).toBe(false);
  });

  it('maps both settings permission columns to a fail-closed migration response', () => {
    const userColumn = new SupabaseRequestError(
      "Could not find the 'settings_permission_overrides' column of 'user_policies' in the schema cache",
      { status: 400 },
    );
    const roleColumn = new SupabaseRequestError(
      "Could not find the 'settings_permissions' column of 'role_policies' in the schema cache",
      { status: 400 },
    );

    expect(isSettingsPermissionSchemaError(userColumn)).toBe(true);
    expect(isSettingsPermissionSchemaError(roleColumn)).toBe(true);
    expect(authFailurePayload(userColumn)).toMatchObject({
      status: 503,
      code: AUTH_ERROR_CODES.schemaMigrationRequired,
      requiredMigration: '20260803150000',
    });
  });

  it('keeps the Bot schema gate separate from identity compatibility', () => {
    const missingBots = new SupabaseRequestError(
      "Could not find the table 'public.bot_channels' in the schema cache",
      { status: 404, payload: { code: 'PGRST205' } },
    );

    expect(PRODUCTION_BOTS_MIGRATION).toBe('20260902120000');
    expect(authFailurePayload(missingBots)).toEqual({
      status: 503,
      error: 'Identity service unavailable',
      code: AUTH_ERROR_CODES.identityUnavailable,
    });
  });

  it('maps an explicit Bot schema marker mismatch to the durable migration response', () => {
    const mismatch = Object.assign(new Error('Production Bots database migration is required'), {
      code: 'bot_schema_migration_required',
      requiredMigration: '20260826140000',
    });

    expect(productionBotsMigrationFailurePayload(mismatch)).toEqual({
      status: 503,
      error: 'Database migration required',
      code: 'bot_schema_migration_required',
      requiredMigration: '20260826140000',
    });
  });

  it('recognizes only the missing user profile GitHub account column', () => {
    const missingColumn = new SupabaseRequestError(
      "Could not find the 'github_account_id' column of 'user_profiles' in the schema cache",
      { status: 400 },
    );

    expect(isMissingUserProfileGithubAccountError(missingColumn)).toBe(true);
    expect(isMissingUserProfileGithubAccountError(
      new SupabaseRequestError('permission denied for table user_profiles', { status: 400 }),
    )).toBe(false);
  });

  it('recognizes only the missing Browser role capability column', () => {
    const missingColumn = new SupabaseRequestError(
      "Could not find the 'can_use_browser' column of 'role_policies' in the schema cache",
      { status: 400 },
    );

    expect(isMissingBrowserPolicyCapabilityError(missingColumn)).toBe(true);
    expect(isMissingBrowserPolicyCapabilityError(
      new SupabaseRequestError('permission denied for table role_policies', { status: 400 }),
    )).toBe(false);
  });

  it('recognizes only the missing GitHub reassignment RPC signature', () => {
    const missingFunction = new SupabaseRequestError(
      'Could not find the function public.devryan_reassign_github_account in the schema cache',
      { status: 404, payload: { code: 'PGRST202' } },
    );

    expect(isMissingGithubAccountReassignmentFunctionError(missingFunction)).toBe(true);
    expect(isMissingGithubAccountReassignmentFunctionError(
      new SupabaseRequestError('permission denied', { status: 403, payload: { code: '42501' } }),
    )).toBe(false);
  });

  it('preserves sessions for transient refresh failures', () => {
    expect(isDefinitiveRefreshRejection(new SupabaseRequestError('expired', { status: 400 }))).toBe(true);
    expect(isDefinitiveRefreshRejection(new SupabaseRequestError('revoked', { status: 401 }))).toBe(true);
    expect(isDefinitiveRefreshRejection(new SupabaseRequestError('unavailable', { status: 503 }))).toBe(false);
    expect(isDefinitiveRefreshRejection(new TypeError('fetch failed'))).toBe(false);
  });

  it('discovers unique fixtures in least-privilege order', () => {
    expect(buildAgentTestIdentities([profile('admin'), profile('developer')])).toEqual([
      { role: 'developer', label: 'Test Developer' },
      { role: 'admin', label: 'Test Administrator' },
    ]);
    expect(buildAgentTestIdentities([
      profile('developer'),
      profile('developer', { id: 'duplicate-id', email: 'duplicate@example.test' }),
      profile('admin'),
    ])).toEqual([{ role: 'admin', label: 'Test Administrator' }]);
  });

  it('selects by role or legacy email and rejects human, conflicting, and ambiguous identities', () => {
    const developer = profile('developer');
    const admin = profile('admin');
    const human = profile('developer', { id: 'human-id', email: 'human@example.test', account_kind: 'human' });

    expect(selectAgentTestProfile([developer, admin], { role: 'developer' })).toBe(developer);
    expect(selectAgentTestProfile([developer, admin], { email: admin.email })).toBe(admin);
    expect(() => selectAgentTestProfile([developer, admin], {
      role: 'admin',
      email: developer.email,
    })).toThrow('do not match');
    expect(() => selectAgentTestProfile([human], { email: human.email })).toThrow('Only active agent-test');
    expect(() => selectAgentTestProfile([
      developer,
      profile('developer', { id: 'duplicate-id', email: 'duplicate@example.test' }),
    ], { role: 'developer' })).toThrow('ambiguous');
  });
});
