import { describe, expect, it } from 'vitest';

import { SETTINGS_PERMISSION_SLUGS as UI_SETTINGS_PERMISSION_SLUGS } from '../../../../ui/src/lib/settings/permissions.ts';

import {
  ROLE_POLICY_DEFAULTS,
  SETTINGS_PERMISSION_SLUGS,
  buildUserPolicyResetRow,
  buildEffectiveSettings,
  canEditSettingsPage,
  canReadSettingsPage,
  canUseBrowser,
  normalizeRolePolicy,
  publicPrincipal,
  settingsPageForRequest,
  validateFeatureOverridesPayload,
  validateSettingsChanges,
  validateSettingsPermissionsPayload,
} from './policy.js';

const developerPrincipal = {
  id: 'user-developer',
  email: 'developer@example.test',
  displayName: 'Developer',
  role: 'developer',
  scope: 'managed',
  policy: ROLE_POLICY_DEFAULTS.developer,
  assignments: [{
    projectId: 'project-opaque',
    label: '1Health',
    branchName: 'developer',
    publicDirectory: '/private/repositories/project-opaque',
    repositoryPath: '/private/repositories/project-opaque',
    worktreeContainerPath: '/private/opencode/worktree/project-opaque',
    remoteUrl: 'https://github.com/example/private.git',
    githubAccountId: 'github-account',
    icon: 'code',
    color: 'blue',
    iconBackground: '#ffffff',
    iconImage: { mime: 'image/png', updatedAt: 123, source: 'custom' },
    isDefault: true,
  }],
};

describe('multi-user policy', () => {
  it('keeps the server permission catalog in exact parity with the shared UI catalog', () => {
    expect(SETTINGS_PERMISSION_SLUGS).toEqual(UI_SETTINGS_PERMISSION_SLUGS);
  });

  it('keeps the developer template to the managed personal pages with Bug Reports enabled', () => {
    expect(ROLE_POLICY_DEFAULTS.developer.settingsPages).toEqual([
      'home', 'appearance', 'chat', 'sessions', 'shortcuts', 'notifications', 'bug-reports',
    ]);
    expect(ROLE_POLICY_DEFAULTS.developer.settingsPermissions['bug-reports']).toEqual({ read: true, edit: true });
    expect(ROLE_POLICY_DEFAULTS.senior_developer.settingsPermissions['bug-reports']).toEqual({ read: true, edit: true });
    expect(ROLE_POLICY_DEFAULTS.developer.settingsPermissions.bots).toEqual({ read: false, edit: false });
    expect(ROLE_POLICY_DEFAULTS.senior_developer.settingsPermissions.bots).toEqual({ read: false, edit: false });
    expect(ROLE_POLICY_DEFAULTS.admin.settingsPermissions.bots).toEqual({ read: true, edit: true });
    expect(ROLE_POLICY_DEFAULTS.developer.bots).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.senior_developer.bots).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.admin.bots).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.developer.files).toBe(false);
    expect(ROLE_POLICY_DEFAULTS.developer.terminal).toBe(false);
    expect(ROLE_POLICY_DEFAULTS.developer.browser).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.developer.createWorktrees).toBe(false);
    expect(ROLE_POLICY_DEFAULTS.developer.createBranches).toBe(false);
    expect(ROLE_POLICY_DEFAULTS.developer.featureOverrides.agents.hideGlobalBehaviorUi).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.senior_developer.featureOverrides).toEqual({});
    expect(ROLE_POLICY_DEFAULTS.senior_developer.browser).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.senior_developer.createWorktrees).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.senior_developer.createBranches).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.admin.createWorktrees).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.admin.createBranches).toBe(true);
  });

  it('allows user capability overrides without changing the role template', () => {
    const policy = normalizeRolePolicy('developer', null, {
      settings_pages: ['home', 'appearance'],
      capabilities: { bots: false, terminal: true, browser: false, createWorktrees: true, createBranches: true },
    });

    expect(policy.settingsPages).toEqual(['home', 'appearance']);
    expect(policy.bots).toBe(false);
    expect(policy.terminal).toBe(true);
    expect(policy.browser).toBe(false);
    expect(policy.createWorktrees).toBe(true);
    expect(policy.createBranches).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.developer.terminal).toBe(false);
    expect(ROLE_POLICY_DEFAULTS.developer.bots).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.developer.browser).toBe(true);
    expect(ROLE_POLICY_DEFAULTS.developer.createWorktrees).toBe(false);
    expect(ROLE_POLICY_DEFAULTS.developer.createBranches).toBe(false);
    expect(canUseBrowser({ role: 'developer', scope: 'managed', policy })).toBe(false);
    expect(canUseBrowser(developerPrincipal)).toBe(true);
  });

  it('publishes a sparse per-user terminal override as part of the effective principal', () => {
    const policy = normalizeRolePolicy('senior_developer', null, {
      capabilities: { terminal: false },
    });
    const published = publicPrincipal({
      ...developerPrincipal,
      role: 'senior_developer',
      policy,
    });

    expect(ROLE_POLICY_DEFAULTS.senior_developer.terminal).toBe(true);
    expect(policy.terminal).toBe(false);
    expect(published.policy.terminal).toBe(false);
  });

  it('merges sparse per-page overrides and keeps edit dependent on read', () => {
    const policy = normalizeRolePolicy('developer', null, {
      settings_permission_overrides: {
        appearance: { read: false, edit: true },
        providers: { read: true, edit: true },
      },
      capabilities: {},
    });
    const principal = { role: 'developer', scope: 'managed', policy };

    expect(policy.settingsPermissions.appearance).toEqual({ read: false, edit: false });
    expect(policy.settingsPermissions.providers).toEqual({ read: true, edit: true });
    expect(canReadSettingsPage(principal, 'providers')).toBe(true);
    expect(canEditSettingsPage(principal, 'providers')).toBe(true);
    expect(canReadSettingsPage(principal, 'behavior')).toBe(false);
  });

  it('validates complete role matrices and sparse user overrides', () => {
    const complete = Object.fromEntries(SETTINGS_PERMISSION_SLUGS.map((slug) => [slug, { read: true, edit: true }]));
    expect(validateSettingsPermissionsPayload(complete)).toMatchObject({ valid: true });
    expect(validateSettingsPermissionsPayload({ providers: { edit: true } }, { sparse: true })).toMatchObject({ valid: true });
    expect(validateSettingsPermissionsPayload({ providers: { read: false, edit: true } }, { sparse: true })).toMatchObject({ valid: false });
    expect(validateSettingsPermissionsPayload({ unknown: { read: true, edit: true } })).toMatchObject({ valid: false });
  });

  it('owns sensitive settings routes by their canonical page', () => {
    const ownedRoutes = [
      ['/admin/users', 'GET', 'users'],
      ['/bug-reports', 'POST', 'bug-reports'],
      ['/bug-reports/report-1', 'PATCH', 'bug-reports'],
      ['/error-logs', 'GET', 'bug-reports'],
      ['/error-logs/event-1', 'GET', 'bug-reports'],
      ['/behavior', 'GET', 'agents'],
      ['/config/agent-overrides', 'PUT', 'agents'],
      ['/config/commands/review', 'PATCH', 'commands'],
      ['/config/mcp/example', 'GET', 'mcp'],
      ['/mcp/example/connect', 'POST', 'mcp'],
      ['/config/skills/install', 'POST', 'skills.catalog'],
      ['/config/skills/catalog/source', 'GET', 'skills.catalog'],
      ['/config/skills/example', 'GET', 'skills.installed'],
      ['/config/plugins', 'GET', 'plugins'],
      ['/config/slim/install', 'POST', 'plugins'],
      ['/magic-prompts/default', 'PUT', 'magic-prompts'],
      ['/magic-prompts/default', 'DELETE', 'magic-prompts'],
      ['/magic-prompts', 'DELETE', 'magic-prompts'],
      ['/config/providers', 'PUT', 'providers'],
      ['/provider', 'GET', 'providers'],
      ['/provider/openai/oauth/authorize', 'POST', 'providers'],
      ['/provider/anthropic/claude-cli', 'GET', 'providers'],
      ['/provider/anthropic/prompt-mode', 'PUT', 'providers'],
      ['/quota/credentials/openai', 'PUT', 'providers'],
      ['/openchamber/tunnel/status', 'GET', 'tunnel'],
      ['/diagnostics/export', 'POST', 'about'],
      ['/opencode/update-check', 'GET', 'about'],
      ['/projects/project-1/icon', 'PUT', 'projects'],
      ['/git/identities', 'GET', 'git'],
      ['/github/auth/start', 'POST', 'users'],
      ['/config/themes', 'GET', 'appearance'],
      ['/config/settings/agent-defaults/Orchestrator', 'DELETE', 'agents'],
    ];
    for (const [path, method, page] of ownedRoutes) {
      expect(settingsPageForRequest(path, method)).toBe(page);
    }

    expect(settingsPageForRequest('/projects/project-1/icon', 'GET')).toBeNull();
    expect(settingsPageForRequest('/config/settings', 'PUT')).toBeNull();
    expect(settingsPageForRequest('/projects/project-1/branch-target', 'POST')).toBeNull();
    expect(settingsPageForRequest('/projects/project-1/scheduled-tasks', 'POST')).toBeNull();
    expect(settingsPageForRequest('/projects/project-1/scheduled-tasks/task-1/run', 'POST')).toBeNull();
    expect(settingsPageForRequest('/config/agents', 'GET')).toBeNull();
    expect(settingsPageForRequest('/config/agents', 'PUT')).toBe('agents');
    expect(settingsPageForRequest('/config/providers', 'GET')).toBeNull();
    expect(settingsPageForRequest('/magic-prompts', 'GET')).toBeNull();
    expect(settingsPageForRequest('/magic-prompts/default', 'GET')).toBeNull();
    expect(settingsPageForRequest('/provider/cursor-acp/session-prewarm', 'POST')).toBeNull();
    expect(settingsPageForRequest('/provider/cursor-acp/workspace', 'POST')).toBeNull();
    expect(settingsPageForRequest('/session/status')).toBeNull();
  });

  it('keeps every managed administrator permission and capability enabled', () => {
    const policy = normalizeRolePolicy('admin', {
      settings_permissions: {},
      can_use_files: false,
      can_use_terminal: false,
      can_use_browser: false,
      can_manage_projects: false,
      can_manage_users: false,
      can_manage_global_settings: false,
      can_manage_git: false,
      can_push: false,
      can_use_github: false,
    }, {
      settings_permission_overrides: { users: { read: false, edit: false } },
      capabilities: { terminal: false, browser: false },
    });

    expect(policy.settingsPages).toEqual(['*']);
    expect(Object.values(policy.settingsPermissions).every(({ read, edit }) => read && edit)).toBe(true);
    expect(policy.files).toBe(true);
    expect(policy.terminal).toBe(true);
    expect(policy.browser).toBe(true);
    expect(policy.manageUsers).toBe(true);
    expect(policy.manageGlobalSettings).toBe(true);
  });

  it('fills newly introduced settings permissions from role defaults for older stored policies', () => {
    const policy = normalizeRolePolicy('developer', {
      settings_pages: ['home', 'appearance'],
      settings_permissions: {
        appearance: { read: true, edit: true },
      },
    });

    expect(policy.settingsPermissions.appearance).toEqual({ read: true, edit: true });
    expect(policy.settingsPermissions['bug-reports']).toEqual({ read: true, edit: true });
    expect(policy.settingsPermissions.bots).toEqual({ read: false, edit: false });
    expect(Object.keys(policy.settingsPermissions)).toEqual(SETTINGS_PERMISSION_SLUGS);
  });

  it('normalizes malformed stored cells into a total edit-implies-read matrix', () => {
    const policy = normalizeRolePolicy('senior_developer', {
      settings_permissions: {
        appearance: { read: false, edit: true },
        bots: { read: true, edit: true },
        'bug-reports': 'invalid',
        unknown: { read: true, edit: true },
      },
    });

    expect(Object.keys(policy.settingsPermissions)).toEqual(SETTINGS_PERMISSION_SLUGS);
    expect(policy.settingsPermissions.appearance).toEqual({ read: false, edit: false });
    expect(policy.settingsPermissions.bots).toEqual({ read: true, edit: true });
    expect(policy.settingsPermissions['bug-reports']).toEqual({ read: false, edit: false });
    expect(policy.settingsPermissions).not.toHaveProperty('unknown');
  });

  it('returns values for a read-only page while rejecting mutations from it', () => {
    const policy = normalizeRolePolicy('developer', null, {
      settings_permission_overrides: { about: { read: true, edit: false } },
      capabilities: {},
    });
    const principal = { ...developerPrincipal, policy };
    const effective = buildEffectiveSettings({
      principal,
      hostSettings: { reportUsage: true },
      userOverrides: {},
    });
    const mutation = validateSettingsChanges({
      principal,
      changes: { reportUsage: false },
      currentEffective: effective,
    });

    expect(effective.reportUsage).toBe(true);
    expect(mutation.accepted).toEqual({});
    expect(mutation.rejected).toEqual(['reportUsage']);
  });

  it('resets only policy-owned columns and preserves session-folder state', () => {
    const reset = buildUserPolicyResetRow('user-1');

    expect(reset).toEqual({
      user_id: 'user-1',
      settings_pages: null,
      settings_permission_overrides: {},
      capabilities: {},
      settings_overrides: {},
      feature_overrides: {},
    });
    expect(reset).not.toHaveProperty('session_folders');
  });

  it('normalizes feature overrides onto the effective policy', () => {
    const policy = normalizeRolePolicy('developer', null, {
      feature_overrides: {
        agents: { hidePermissionsUi: true, unknownFlag: true },
        source: { hideUpdateTab: true, unknownFlag: true },
        mcp: { context7: 'on', playwright: 'off', broken: 'sometimes', '': 'on' },
      },
    });

    expect(policy.featureOverrides).toEqual({
      agents: { hidePermissionsUi: true, hideGlobalBehaviorUi: true },
      source: { hideUpdateTab: true },
      mcp: { context7: 'on', playwright: 'off' },
    });
    expect(normalizeRolePolicy('admin', null, {
      feature_overrides: { agents: { hidePermissionsUi: true } },
    }).featureOverrides).toEqual({});
  });

  it('validates feature override payloads', () => {
    expect(validateFeatureOverridesPayload(undefined)).toEqual({ valid: true, featureOverrides: {} });
    expect(validateFeatureOverridesPayload({
      agents: { hidePermissionsUi: true, hideGlobalBehaviorUi: false },
      source: { hideUpdateTab: true },
      mcp: { context7: 'inherit', playwright: 'off' },
    })).toEqual({
      valid: true,
      featureOverrides: {
        agents: { hidePermissionsUi: true, hideGlobalBehaviorUi: false },
        source: { hideUpdateTab: true },
        mcp: { playwright: 'off' },
      },
    });
    expect(validateFeatureOverridesPayload({ unknown: {} }).valid).toBe(false);
    expect(validateFeatureOverridesPayload({ agents: { other: true } }).valid).toBe(false);
    expect(validateFeatureOverridesPayload({ agents: { hideGlobalBehaviorUi: 'yes' } }).valid).toBe(false);
    expect(validateFeatureOverridesPayload({ source: { hideUpdateTab: 'yes' } }).valid).toBe(false);
    expect(validateFeatureOverridesPayload({ source: { other: true } }).valid).toBe(false);
    expect(validateFeatureOverridesPayload({ mcp: { context7: 'maybe' } }).valid).toBe(false);
  });

  it('stamps feature overrides into effective multi-user settings', () => {
    const principal = {
      ...developerPrincipal,
      policy: normalizeRolePolicy('developer', null, {
        feature_overrides: {
          agents: { hidePermissionsUi: true },
          source: { hideUpdateTab: true },
          mcp: { context7: 'off' },
        },
      }),
    };
    const settings = buildEffectiveSettings({ principal, hostSettings: {}, userOverrides: {} });

    expect(settings.multiUser.features).toEqual({
      agents: { hidePermissionsUi: true, hideGlobalBehaviorUi: true },
      source: { hideUpdateTab: true },
      mcp: { context7: 'off' },
    });
  });

  it('preserves explicit global behavior visibility overrides over role defaults', () => {
    expect(normalizeRolePolicy('developer', null, {
      feature_overrides: { agents: { hideGlobalBehaviorUi: false } },
    }).featureOverrides.agents.hideGlobalBehaviorUi).toBe(false);
    expect(normalizeRolePolicy('senior_developer', null, {
      feature_overrides: { agents: { hideGlobalBehaviorUi: true } },
    }).featureOverrides.agents.hideGlobalBehaviorUi).toBe(true);
  });

  it('authorizes notification fields independently from Sessions edit access', () => {
    const principal = {
      ...developerPrincipal,
      policy: normalizeRolePolicy('developer', null, {
        settings_permission_overrides: {
          notifications: { read: true, edit: true },
          sessions: { read: true, edit: false },
        },
      }),
    };
    const mutation = validateSettingsChanges({
      principal,
      changes: { nativeNotificationsEnabled: true },
      currentEffective: { nativeNotificationsEnabled: false },
    });

    expect(mutation).toEqual({ accepted: { nativeNotificationsEnabled: true }, rejected: [] });
  });

  it('accepts the per-user MCP enabled overlay as a sessions-independent mcp field', () => {
    const principal = {
      ...developerPrincipal,
      policy: normalizeRolePolicy('developer', null, {
        settings_permission_overrides: { mcp: { read: true, edit: true } },
      }),
    };
    const mutation = validateSettingsChanges({
      principal,
      changes: { mcpServerEnabledOverrides: { context7: false } },
      currentEffective: {},
    });

    expect(mutation.accepted).toEqual({ mcpServerEnabledOverrides: { context7: false } });
    expect(mutation.rejected).toEqual([]);
  });

  it('returns only granted settings and real project paths', () => {
    const settings = buildEffectiveSettings({
      principal: developerPrincipal,
      hostSettings: {
        themeId: 'host-theme',
        notificationMode: 'all',
        openaiApiKey: 'must-not-leak',
        tunnelToken: 'must-not-leak',
      },
      userOverrides: { themeId: 'developer-theme' },
    });

    expect(settings.themeId).toBe('developer-theme');
    expect(settings.notificationMode).toBe('all');
    expect(settings.multiUser.capabilities.browser).toBe(true);
    expect(settings.multiUser.capabilities.bots).toBe(true);
    expect(settings.multiUser.capabilities.createWorktrees).toBe(false);
    expect(settings.openaiApiKey).toBeUndefined();
    expect(settings.tunnelToken).toBeUndefined();
    expect(settings.homeDirectory).toBeUndefined();
    expect(settings.projects).toEqual([{
      id: 'project-opaque',
      label: '1Health',
      path: '/private/repositories/project-opaque',
      icon: 'code',
      color: 'blue',
      iconBackground: '#ffffff',
      iconImage: { mime: 'image/png', updatedAt: 123, source: 'custom' },
      branches: [{
        name: 'developer',
        directory: '/private/repositories/project-opaque',
        isDefault: true,
      }],
    }]);

    const published = publicPrincipal(developerPrincipal);
    expect(published.assignments[0]).not.toHaveProperty('repositoryPath');
    expect(published.assignments[0]).not.toHaveProperty('worktreeContainerPath');
    expect(published.assignments[0]).not.toHaveProperty('remoteUrl');
  });

  it('projects sparse personal notification templates as a total effective record', () => {
    const completion = { title: 'Personal completion', message: 'Done' };
    const hostError = { title: 'Host error', message: 'Failed' };
    const settings = buildEffectiveSettings({
      principal: developerPrincipal,
      hostSettings: {
        notificationTemplates: {
          completion: { title: 'Host completion', message: 'Host done' },
          error: hostError,
        },
      },
      userOverrides: { notificationTemplates: { completion } },
    });

    expect(settings.notificationTemplates.completion).toBe(completion);
    expect(settings.notificationTemplates.error).toBe(hostError);
    expect(settings.notificationTemplates.permission).toEqual({
      title: 'Permissions needed',
      message: 'Folder access is required: {last_message}',
    });
    expect(Object.keys(settings.notificationTemplates)).toHaveLength(6);
  });

  it('normalizes partial notification template updates against current effective values', () => {
    const current = buildEffectiveSettings({
      principal: developerPrincipal,
      hostSettings: {},
      userOverrides: {},
    });
    const completion = { title: 'Custom completion', message: 'Done' };
    const mutation = validateSettingsChanges({
      principal: developerPrincipal,
      changes: { notificationTemplates: { completion } },
      currentEffective: current,
    });

    expect(mutation.rejected).toEqual([]);
    expect(mutation.accepted.notificationTemplates.completion).toBe(completion);
    expect(mutation.accepted.notificationTemplates.permission)
      .toEqual(current.notificationTemplates.permission);
    expect(Object.keys(mutation.accepted.notificationTemplates)).toHaveLength(6);
  });

  it('rejects changes to fields outside granted settings pages', () => {
    const result = validateSettingsChanges({
      principal: developerPrincipal,
      changes: { themeId: 'new-theme', chatWidth: 1024, tunnelToken: 'forbidden' },
      currentEffective: { themeId: 'old-theme' },
    });

    expect(result.accepted).toEqual({ themeId: 'new-theme', chatWidth: 1024 });
    expect(result.rejected).toEqual(['tunnelToken']);
  });

  it('gives managed admins real host paths and keeps the host home directory', () => {
    const adminPrincipal = {
      id: 'user-admin',
      role: 'admin',
      scope: 'managed',
      policy: ROLE_POLICY_DEFAULTS.admin,
      assignments: [{
        projectId: 'project-1',
        label: 'DevRyan',
        branchName: 'main',
        publicDirectory: '/Users/example/Repositories/DevRyan',
        repositoryPath: '/Users/example/Repositories/DevRyan',
        worktreeContainerPath: '/Users/example/.local/share/opencode/worktree/project-1',
        isDefault: true,
      }],
    };

    const settings = buildEffectiveSettings({
      principal: adminPrincipal,
      hostSettings: { homeDirectory: '/Users/example' },
      userOverrides: {},
    });

    expect(settings.projects).toEqual([{
      id: 'project-1',
      label: 'DevRyan',
      path: '/Users/example/Repositories/DevRyan',
      icon: null,
      color: null,
      iconBackground: null,
      iconImage: null,
      branches: [{
        name: 'main',
        directory: '/Users/example/Repositories/DevRyan',
        isDefault: true,
      }],
    }]);
    expect(settings.lastDirectory).toBe('/Users/example/Repositories/DevRyan');
    expect(settings.homeDirectory).toBe('/Users/example');
  });

  it('emits one project entry per projectId for multi-branch grants, preferring the default', () => {
    const principal = {
      ...developerPrincipal,
      assignments: [
        {
          ...developerPrincipal.assignments[0],
          branchName: 'feature-x',
          isDefault: false,
        },
        developerPrincipal.assignments[0],
      ],
    };

    const settings = buildEffectiveSettings({
      principal,
      hostSettings: {},
      userOverrides: { projects: [{ id: 'leak', path: '/private/leak' }] },
    });

    expect(settings.projects).toEqual([{
      id: 'project-opaque',
      label: '1Health',
      path: '/private/repositories/project-opaque',
      icon: 'code',
      color: 'blue',
      iconBackground: '#ffffff',
      iconImage: { mime: 'image/png', updatedAt: 123, source: 'custom' },
      branches: [
        {
          name: 'developer',
          directory: '/private/repositories/project-opaque',
          isDefault: true,
        },
        {
          name: 'feature-x',
          directory: '/private/repositories/project-opaque',
          isDefault: false,
        },
      ],
    }]);
  });
});
