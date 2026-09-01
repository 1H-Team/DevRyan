import { normalizeNotificationTemplates } from '../opencode/notification-settings.js';

export const ROLE_NAMES = Object.freeze(['admin', 'senior_developer', 'developer']);

export const SETTINGS_PERMISSION_SLUGS = Object.freeze([
  'appearance', 'notifications', 'shortcuts', 'voice', 'about',
  'chat', 'sessions', 'bots', 'agents', 'skills.installed', 'skills.catalog', 'plugins', 'magic-prompts',
  'providers', 'usage', 'mcp', 'remote-instances', 'tunnel',
  'users', 'bug-reports', 'git', 'projects', 'commands',
]);

const SETTINGS_PERMISSION_SLUG_SET = new Set(SETTINGS_PERMISSION_SLUGS);
const USER_EDITABLE_SETTINGS_PAGES = new Set([
  'appearance', 'notifications', 'shortcuts', 'voice', 'chat', 'sessions', 'usage', 'bug-reports',
]);

const normalizeSettingsPermissionSlug = (value) => {
  const slug = String(value || '').trim().toLowerCase();
  if (slug === 'behavior') return 'agents';
  if (slug === 'home') return null;
  return SETTINGS_PERMISSION_SLUG_SET.has(slug) ? slug : null;
};

const legacyReadPages = (pages) => {
  const source = Array.isArray(pages) ? pages : [];
  if (source.includes('*')) return new Set(SETTINGS_PERMISSION_SLUGS);
  return new Set(source.map(normalizeSettingsPermissionSlug).filter(Boolean));
};

const createRoleSettingsPermissions = ({ readPages = [], editPages = [] } = {}) => {
  const readable = legacyReadPages(readPages);
  const editable = legacyReadPages(editPages);
  return Object.freeze(Object.fromEntries(SETTINGS_PERMISSION_SLUGS.map((slug) => {
    const read = readable.has(slug);
    return [slug, Object.freeze({ read, edit: read && editable.has(slug) })];
  })));
};

export function settingsPermissionsFromLegacyPages(pages, { allReadablePagesEditable = false } = {}) {
  const readable = legacyReadPages(pages);
  return Object.fromEntries(SETTINGS_PERMISSION_SLUGS.map((slug) => {
    const read = readable.has(slug);
    return [slug, {
      read,
      edit: read && (allReadablePagesEditable || USER_EDITABLE_SETTINGS_PAGES.has(slug)),
    }];
  }));
}

export function buildUserPolicyResetRow(userId) {
  return {
    user_id: userId,
    settings_pages: null,
    settings_permission_overrides: {},
    capabilities: {},
    settings_overrides: {},
    feature_overrides: {},
  };
}

export const MCP_FEATURE_OVERRIDE_STATES = Object.freeze(['on', 'off']);

export function normalizeFeatureOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  const agents = value.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    const normalizedAgents = {};
    if (agents.hidePermissionsUi === true) normalizedAgents.hidePermissionsUi = true;
    if (typeof agents.hideGlobalBehaviorUi === 'boolean') {
      normalizedAgents.hideGlobalBehaviorUi = agents.hideGlobalBehaviorUi;
    }
    if (Object.keys(normalizedAgents).length > 0) normalized.agents = normalizedAgents;
  }
  const source = value.source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const normalizedSource = {};
    if (typeof source.hideUpdateTab === 'boolean') {
      normalizedSource.hideUpdateTab = source.hideUpdateTab;
    }
    if (Object.keys(normalizedSource).length > 0) normalized.source = normalizedSource;
  }
  const mcp = value.mcp;
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    const servers = {};
    for (const [rawName, state] of Object.entries(mcp)) {
      const name = String(rawName || '').trim();
      if (!name || !MCP_FEATURE_OVERRIDE_STATES.includes(state)) continue;
      servers[name] = state;
    }
    if (Object.keys(servers).length > 0) normalized.mcp = servers;
  }
  return normalized;
}

export function validateFeatureOverridesPayload(value) {
  if (value === undefined || value === null) return { valid: true, featureOverrides: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: 'Feature overrides must be an object' };
  }
  for (const key of Object.keys(value)) {
    if (!['agents', 'source', 'mcp'].includes(key)) {
      return { valid: false, error: `Unknown feature override section: ${key}` };
    }
  }
  const agents = value.agents;
  if (agents !== undefined) {
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
      return { valid: false, error: 'Agent feature overrides must be an object' };
    }
    for (const key of Object.keys(agents)) {
      if (!['hidePermissionsUi', 'hideGlobalBehaviorUi'].includes(key) || typeof agents[key] !== 'boolean') {
        return { valid: false, error: `Invalid agent feature override: ${key}` };
      }
    }
  }
  const source = value.source;
  if (source !== undefined) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return { valid: false, error: 'Source feature overrides must be an object' };
    }
    for (const key of Object.keys(source)) {
      if (key !== 'hideUpdateTab' || typeof source[key] !== 'boolean') {
        return { valid: false, error: `Invalid Source feature override: ${key}` };
      }
    }
  }
  const mcp = value.mcp;
  if (mcp !== undefined) {
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) {
      return { valid: false, error: 'MCP feature overrides must be an object' };
    }
    for (const [name, state] of Object.entries(mcp)) {
      if (!String(name || '').trim()) return { valid: false, error: 'MCP server name is required' };
      if (state !== 'inherit' && !MCP_FEATURE_OVERRIDE_STATES.includes(state)) {
        return { valid: false, error: `Invalid MCP override for ${name}: expected inherit, on, or off` };
      }
    }
  }
  return { valid: true, featureOverrides: normalizeFeatureOverrides(value) };
}

const ADMIN_SETTINGS_PERMISSIONS = createRoleSettingsPermissions({ readPages: ['*'], editPages: ['*'] });
const SENIOR_SETTINGS_PAGES = ['appearance', 'chat', 'sessions', 'shortcuts', 'notifications', 'users', 'bug-reports'];
const DEVELOPER_SETTINGS_PAGES = ['appearance', 'chat', 'sessions', 'shortcuts', 'notifications', 'bug-reports'];

export const ROLE_POLICY_DEFAULTS = Object.freeze({
  admin: Object.freeze({
    settingsPages: ['*'], settingsPermissions: ADMIN_SETTINGS_PERMISSIONS,
    featureOverrides: Object.freeze({}),
    bots: true, files: true, terminal: true, browser: true, createWorktrees: true, createBranches: true, manageProjects: true,
    manageUsers: true, manageGlobalSettings: true, manageGit: true, push: true, github: true,
  }),
  senior_developer: Object.freeze({
    settingsPages: ['home', ...SENIOR_SETTINGS_PAGES],
    settingsPermissions: createRoleSettingsPermissions({
      readPages: SENIOR_SETTINGS_PAGES,
      editPages: [...USER_EDITABLE_SETTINGS_PAGES],
    }),
    featureOverrides: Object.freeze({}),
    bots: true, files: false, terminal: true, browser: true, createWorktrees: true, createBranches: true, manageProjects: false, manageUsers: false,
    manageGlobalSettings: false, manageGit: true, push: true, github: true,
  }),
  developer: Object.freeze({
    settingsPages: ['home', ...DEVELOPER_SETTINGS_PAGES],
    settingsPermissions: createRoleSettingsPermissions({
      readPages: DEVELOPER_SETTINGS_PAGES,
      editPages: DEVELOPER_SETTINGS_PAGES,
    }),
    featureOverrides: Object.freeze({
      agents: Object.freeze({ hideGlobalBehaviorUi: true }),
    }),
    bots: true, files: false, terminal: false, browser: true, createWorktrees: false, createBranches: false, manageProjects: false, manageUsers: false,
    manageGlobalSettings: false, manageGit: true, push: true, github: true,
  }),
});

const SETTINGS_FIELDS_BY_PAGE = Object.freeze({
  appearance: [
    'themeId', 'themeCatalogVersion', 'useSystemTheme', 'themeVariant', 'lightThemeId', 'darkThemeId',
    'splashBgLight', 'splashFgLight', 'splashBgDark', 'splashFgDark', 'fontSize', 'chatWidth',
    'terminalFontSize', 'uiFont', 'monoFont', 'padding', 'cornerRadius', 'inputBarOffset',
    'pwaAppName', 'pwaOrientation', 'mobileKeyboardMode', 'typographySizes',
    'timeFormatPreference', 'weekStartPreference',
  ],
  chat: [
    'showReasoningTraces', 'showDeletionDialog', 'queueModeEnabled', 'inputSpellcheckEnabled',
    'showToolFileIcons', 'showExpandedBashTools', 'showExpandedEditTools', 'chatRenderMode',
    'activityRenderMode', 'mermaidRenderingMode', 'showSplitAssistantMessageActions',
    'diffLayoutPreference', 'diffViewMode', 'userMessageRenderingMode', 'collapsibleUserMessages',
    'stickyUserHeader', 'defaultFileViewerPreview',
  ],
  sessions: [
    'autoDeleteEnabled', 'autoDeleteAfterDays', 'sessionRetentionAction', 'defaultModel',
    'defaultVariant', 'defaultAgent', 'defaultPlanMode', 'autoCreateWorktree', 'zenModel',
    'messageStreamTransport', 'messageLimit', 'favoriteModels', 'favoriteModelsUpdatedAt',
    'hiddenModels', 'hiddenModelsUpdatedAt', 'agentModelSelections',
  ],
  shortcuts: ['keyboardShortcuts', 'appShortcuts'],
  notifications: [
    'nativeNotificationsEnabled', 'notificationMode', 'notifyOnSubtasks', 'notifyOnCompletion',
    'notifyOnPlanReady', 'notifyOnError', 'notifyOnQuestion', 'notifyOnPermission', 'notificationTemplates',
    'summarizeLastMessage', 'summaryThreshold', 'summaryLength', 'maxLastMessageLength',
  ],
  agents: [
    'globalBehaviorPrompt', 'responseStyleEnabled', 'responseStylePreset',
    'responseStyleCustomInstructions', 'responseStyleLevel',
  ],
  'skills.installed': ['hiddenSkills'],
  'skills.catalog': ['skillCatalogs'],
  mcp: ['mcpServerEnabledOverrides'],
  git: ['gitmojiEnabled', 'gitChangesViewMode', 'gitProviderId', 'gitModelId', 'defaultGitIdentityId', 'openInAppId'],
  projects: ['pinnedDirectories'],
  usage: [
    'usageAutoRefresh', 'usageRefreshIntervalMs', 'usageDisplayMode', 'usageShowPredValues',
    'usageDropdownProviders', 'usageSelectedModels', 'usageCollapsedFamilies',
    'usageExpandedFamilies', 'usageModelGroups',
  ],
  voice: [
    'sttProvider', 'sttServerUrl', 'sttModel', 'wasmSttModel', 'sttLanguage',
    'sttSilenceThresholdDb', 'sttSilenceHoldMs',
  ],
  tunnel: [
    'tunnelProvider', 'tunnelMode', 'tunnelBootstrapTtlMs', 'tunnelSessionTtlMs',
    'managedLocalTunnelConfigPath', 'managedRemoteTunnelHostname', 'managedRemoteTunnelToken',
    'managedRemoteTunnelPresets', 'managedRemoteTunnelSelectedPresetId', 'managedRemoteTunnelPresetTokens',
  ],
  about: [
    'reportUsage', 'opencodeBinary', 'desktopLanAccessEnabled', 'desktopKeepAwakeEnabled',
    'agentBrowserControlEnabled',
  ],
  home: [],
});

const CAPABILITY_KEYS = Object.freeze([
  'bots', 'files', 'terminal', 'browser', 'createWorktrees', 'createBranches', 'manageProjects', 'manageUsers', 'manageGlobalSettings',
  'manageGit', 'push', 'github',
]);

const normalizeStoredRolePermissions = (role, row) => {
  const base = ROLE_POLICY_DEFAULTS[role] || ROLE_POLICY_DEFAULTS.developer;
  if (role === 'admin') return ADMIN_SETTINGS_PERMISSIONS;
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'settings_permissions')) {
    return base.settingsPermissions;
  }
  const stored = row.settings_permissions && typeof row.settings_permissions === 'object'
    ? row.settings_permissions
    : {};
  return Object.fromEntries(SETTINGS_PERMISSION_SLUGS.map((slug) => {
    const fallback = base.settingsPermissions[slug];
    if (!Object.prototype.hasOwnProperty.call(stored, slug)) return [slug, { ...fallback }];
    const value = stored[slug];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [slug, { read: false, edit: false }];
    }
    const read = value.read === true;
    const edit = value.edit === true;
    return [slug, { read, edit: read && edit }];
  }));
};

const legacyUserPermissionOverrides = (pages) => {
  if (!Array.isArray(pages)) return {};
  const readable = legacyReadPages(pages);
  return Object.fromEntries(SETTINGS_PERMISSION_SLUGS.map((slug) => [slug, {
    read: readable.has(slug),
    edit: readable.has(slug) && USER_EDITABLE_SETTINGS_PAGES.has(slug),
  }]));
};

export function normalizeSettingsPermissionOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawSlug, rawPermission] of Object.entries(value)) {
    const slug = normalizeSettingsPermissionSlug(rawSlug);
    if (!slug || !rawPermission || typeof rawPermission !== 'object' || Array.isArray(rawPermission)) continue;
    const permission = {};
    if (typeof rawPermission.read === 'boolean') permission.read = rawPermission.read;
    if (typeof rawPermission.edit === 'boolean') permission.edit = rawPermission.edit;
    if (Object.keys(permission).length > 0) normalized[slug] = permission;
  }
  return normalized;
}

export function validateSettingsPermissionsPayload(value, { sparse = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: 'Settings permissions must be an object' };
  }
  const normalized = {};
  for (const [rawSlug, rawPermission] of Object.entries(value)) {
    const slug = normalizeSettingsPermissionSlug(rawSlug);
    if (!slug) return { valid: false, error: `Unknown settings page: ${rawSlug}` };
    if (!rawPermission || typeof rawPermission !== 'object' || Array.isArray(rawPermission)) {
      return { valid: false, error: `Invalid settings permission for ${slug}` };
    }
    const permission = {};
    for (const key of Object.keys(rawPermission)) {
      if (!['read', 'edit'].includes(key) || typeof rawPermission[key] !== 'boolean') {
        return { valid: false, error: `Invalid ${key} permission for ${slug}` };
      }
      permission[key] = rawPermission[key];
    }
    if (!sparse && (typeof permission.read !== 'boolean' || typeof permission.edit !== 'boolean')) {
      return { valid: false, error: `Read and edit permissions are required for ${slug}` };
    }
    if (permission.edit === true && permission.read === false) {
      return { valid: false, error: `Edit permission requires read permission for ${slug}` };
    }
    if (Object.keys(permission).length > 0) normalized[slug] = permission;
  }
  if (!sparse) {
    for (const slug of SETTINGS_PERMISSION_SLUGS) {
      if (!normalized[slug]) return { valid: false, error: `Missing settings permission for ${slug}` };
    }
  }
  return { valid: true, permissions: normalized };
}

export function normalizeRolePolicy(role, row = null, userPolicy = null) {
  const base = ROLE_POLICY_DEFAULTS[role] || ROLE_POLICY_DEFAULTS.developer;
  const roleSettingsPermissions = normalizeStoredRolePermissions(role, row);
  if (role === 'admin') {
    return {
      ...base,
      settingsPages: ['*'],
      settingsPermissions: ADMIN_SETTINGS_PERMISSIONS,
      featureOverrides: {},
    };
  }
  const fromRow = row ? {
    settingsPermissions: roleSettingsPermissions,
    bots: base.bots,
    files: row.can_use_files,
    terminal: row.can_use_terminal,
    browser: typeof row.can_use_browser === 'boolean' ? row.can_use_browser : base.browser,
    createWorktrees: base.createWorktrees,
    createBranches: base.createBranches,
    manageProjects: row.can_manage_projects,
    manageUsers: row.can_manage_users,
    manageGlobalSettings: row.can_manage_global_settings,
    manageGit: row.can_manage_git,
    push: row.can_push,
    github: row.can_use_github,
  } : { ...base, settingsPermissions: roleSettingsPermissions };
  const overrides = userPolicy?.capabilities && typeof userPolicy.capabilities === 'object'
    ? userPolicy.capabilities
    : {};
  const settingsPermissionOverrides = userPolicy && Object.prototype.hasOwnProperty.call(userPolicy, 'settings_permission_overrides')
    ? normalizeSettingsPermissionOverrides(userPolicy.settings_permission_overrides)
    : legacyUserPermissionOverrides(userPolicy?.settings_pages);
  const next = { ...fromRow };
  next.settingsPermissions = Object.fromEntries(SETTINGS_PERMISSION_SLUGS.map((slug) => {
    const inherited = roleSettingsPermissions[slug];
    const override = settingsPermissionOverrides[slug] || {};
    const read = typeof override.read === 'boolean' ? override.read : inherited.read;
    const requestedEdit = typeof override.edit === 'boolean' ? override.edit : inherited.edit;
    return [slug, { read, edit: read && requestedEdit }];
  }));
  next.settingsPages = ['home', ...SETTINGS_PERMISSION_SLUGS.filter((slug) => next.settingsPermissions[slug].read)];
  for (const key of CAPABILITY_KEYS) {
    if (typeof overrides[key] === 'boolean') next[key] = overrides[key];
  }
  const inheritedFeatureOverrides = normalizeFeatureOverrides(base.featureOverrides);
  const userFeatureOverrides = normalizeFeatureOverrides(userPolicy?.feature_overrides);
  const mergedAgents = {
    ...(inheritedFeatureOverrides.agents || {}),
    ...(userFeatureOverrides.agents || {}),
  };
  next.featureOverrides = {
    ...(Object.keys(mergedAgents).length > 0 ? { agents: mergedAgents } : {}),
    ...(userFeatureOverrides.source ? { source: userFeatureOverrides.source } : {}),
    ...(userFeatureOverrides.mcp ? { mcp: userFeatureOverrides.mcp } : {}),
  };
  return next;
}

export function canReadSettingsPage(principal, rawSlug) {
  if (rawSlug === 'home') return true;
  if (principal?.scope === 'local-admin' || principal?.role === 'admin') return true;
  const slug = normalizeSettingsPermissionSlug(rawSlug);
  if (!slug) return false;
  const permission = principal?.policy?.settingsPermissions?.[slug];
  if (permission && typeof permission.read === 'boolean') return permission.read;
  const pages = principal?.policy?.settingsPages || [];
  return pages.includes('*') || pages.includes(slug);
}

export function canEditSettingsPage(principal, rawSlug) {
  if (principal?.scope === 'local-admin' || principal?.role === 'admin') return true;
  const slug = normalizeSettingsPermissionSlug(rawSlug);
  if (!slug) return false;
  const permission = principal?.policy?.settingsPermissions?.[slug];
  return permission?.read === true && permission?.edit === true;
}

export const canOpenSettingsPage = canReadSettingsPage;

export function canUseBrowser(principal) {
  return principal?.scope === 'local-admin'
    || principal?.role === 'admin'
    || principal?.policy?.browser === true;
}

const settingsFieldsForPermission = (principal, permission) => {
  if (principal?.scope === 'local-admin') return null;
  if (principal?.role === 'admin') return null;
  const fields = new Set();
  for (const slug of SETTINGS_PERMISSION_SLUGS) {
    const allowed = permission === 'edit'
      ? canEditSettingsPage(principal, slug)
      : canReadSettingsPage(principal, slug);
    if (!allowed) continue;
    for (const field of SETTINGS_FIELDS_BY_PAGE[slug] || []) fields.add(field);
  }
  return fields;
};

export function settingsPageForRequest(requestPath, method = 'GET') {
  const path = String(requestPath || '');
  if (/^\/config\/settings\/agent-defaults(?:\/|$)/.test(path)) return 'agents';
  if (/^\/config\/settings\/overrides(?:\/|$)/.test(path)) return 'sessions';
  // Exact settings reads and writes span multiple independently authorized
  // pages. The managed settings route validates every field against its real
  // owner instead of applying one coarse page gate here.
  if (path === '/config/settings') return null;
  if (/^\/(?:bug-reports|error-logs)(?:\/|$)/.test(path)) return 'bug-reports';
  if (/^\/admin(?:\/|$)/.test(path)) return 'users';
  // Chat composition needs effective agent-model metadata even when the
  // Agents settings page itself is hidden. Mutations and nested config routes
  // remain settings-gated.
  if (path === '/config/agents' && method === 'GET') return null;
  if (/^\/behavior(?:\/|$)/.test(path) || /^\/config\/(?:agents|agent-overrides)(?:\/|$)/.test(path)) return 'agents';
  if (/^\/config\/commands(?:\/|$)/.test(path)) return 'commands';
  if (/^\/(?:config\/mcp|mcp)(?:\/|$)/.test(path)) return 'mcp';
  if (/^\/config\/skills\/(?:catalog|install|scan)(?:\/|$)/.test(path)) return 'skills.catalog';
  if (/^\/config\/skills(?:\/|$)/.test(path)) return 'skills.installed';
  if (/^\/config\/(?:plugins|slim)(?:\/|$)/.test(path)) return 'plugins';
  // Reading the effective host prompt catalog is a chat/action runtime
  // dependency. Keep the editor and every mutation permission-gated without
  // requiring managed users to see the Magic Prompts settings page.
  if (/^\/magic-prompts(?:\/|$)/.test(path)) {
    return method === 'GET' ? null : 'magic-prompts';
  }
  // The chat bootstrap needs the read-only provider/model catalog even when
  // the Providers settings page is hidden. Mutations remain page-gated.
  if (path === '/config/providers' && method === 'GET') return null;
  if (path === '/config/providers'
    || /^\/auth(?:\/|$)/.test(path)
    || path === '/provider'
    || path === '/provider/auth'
    || /^\/provider\/[^/]+\/(?:auth|source|oauth|usage-auth|runtime-status)(?:\/|$)/.test(path)
    || /^\/provider\/(?:anthropic\/(?:check-oauth|claude-cli|prompt-mode)|cursor-acp\/configure|xai\/oauth)(?:\/|$)/.test(path)) return 'providers';
  if (/^\/quota\/credentials(?:\/|$)/.test(path)) return 'providers';
  if (/^\/openchamber\/tunnel(?:\/|$)/.test(path)) return 'tunnel';
  if (/^\/diagnostics(?:\/(?:status|export|sanitize))?$/.test(path)
    || /^\/(?:opencode\/update-check|openchamber\/update-(?:check|install))(?:\/|$)/.test(path)) return 'about';
  const projectRuntimeRoute = /^\/projects\/[^/]+\/(?:branch-target|scheduled-tasks(?:\/[^/]+)?(?:\/run)?)$/.test(path);
  if (/^\/projects(?:\/|$)/.test(path)
    && !projectRuntimeRoute
    && !(method === 'GET' && /^\/projects\/[^/]+\/icon$/.test(path))) return 'projects';
  if (/^\/github\/auth(?:\/(?:start|complete|activate|gh-cli))?$/.test(path)) return 'users';
  if (/^\/git\/(?:identities|global-identity|discover-credentials|set-identity|commit-template)(?:\/|$)/.test(path)) return 'git';
  if (path === '/config/themes') return 'appearance';
  if (path === '/config/opencode-resolution') return 'about';
  return null;
}

export function allowedSettingsFields(principal) {
  return settingsFieldsForPermission(principal, 'edit');
}

export function readableSettingsFields(principal) {
  return settingsFieldsForPermission(principal, 'read');
}

export function buildEffectiveSettings({ principal, hostSettings, userOverrides = {} }) {
  if (principal?.scope === 'local-admin') return { ...hostSettings };
  const allowed = readableSettingsFields(principal);
  const effective = allowed === null ? { ...hostSettings, ...userOverrides } : {};
  for (const key of allowed || []) {
    if (Object.prototype.hasOwnProperty.call(userOverrides, key)) effective[key] = userOverrides[key];
    else if (Object.prototype.hasOwnProperty.call(hostSettings, key)) effective[key] = hostSettings[key];
  }
  if (allowed === null || allowed.has('notificationTemplates')) {
    const hostTemplates = normalizeNotificationTemplates(hostSettings.notificationTemplates).templates;
    effective.notificationTemplates = normalizeNotificationTemplates(
      userOverrides.notificationTemplates,
      hostTemplates,
    ).templates;
  }
  // Branch grants are visibility metadata. Every managed role receives the
  // real repository path and one project entry per projectId.
  const byProject = new Map();
  for (const entry of principal?.assignments || []) {
    const grouped = byProject.get(entry.projectId) || { representative: entry, assignments: [] };
    grouped.assignments.push(entry);
    if (entry.isDefault && !grouped.representative.isDefault) grouped.representative = entry;
    byProject.set(entry.projectId, grouped);
  }
  effective.projects = [...byProject.values()].map(({ representative, assignments }) => ({
    id: representative.projectId,
    label: representative.label,
    path: representative.repositoryPath,
    icon: representative.icon ?? null,
    color: representative.color ?? null,
    iconBackground: representative.iconBackground ?? null,
    iconImage: representative.iconImage ?? null,
    branches: [...assignments]
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
      .map((assignment) => ({
        name: assignment.branchName,
        directory: assignment.repositoryPath,
        isDefault: assignment.isDefault === true,
      })),
  }));
  const active = (principal?.assignments || []).find((entry) => entry.isDefault) || principal?.assignments?.[0];
  effective.activeProjectId = active?.projectId || null;
  effective.lastDirectory = active?.repositoryPath || null;
  effective.multiUser = {
    enabled: true,
    role: principal?.role,
    settingsPages: principal?.policy?.settingsPages || [],
    settingsPermissions: principal?.policy?.settingsPermissions || {},
    capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, principal?.policy?.[key] === true])),
    features: {
      agents: {
        hidePermissionsUi: principal?.policy?.featureOverrides?.agents?.hidePermissionsUi === true,
        hideGlobalBehaviorUi: principal?.policy?.featureOverrides?.agents?.hideGlobalBehaviorUi === true,
      },
      source: {
        hideUpdateTab: principal?.policy?.featureOverrides?.source?.hideUpdateTab === true,
      },
      mcp: { ...(principal?.policy?.featureOverrides?.mcp || {}) },
    },
    settingsOverrideKeys: [...(allowed || Object.keys(userOverrides))]
      .filter((key) => Object.prototype.hasOwnProperty.call(userOverrides, key))
      .sort(),
  };
  return effective;
}

export function validateSettingsChanges({ principal, changes, currentEffective }) {
  const allowed = allowedSettingsFields(principal);
  if (allowed === null) return { accepted: { ...changes }, rejected: [] };
  const accepted = {};
  const rejected = [];
  const dedicatedAgentDefaultFields = new Set(['agentModelSelections', 'defaultModel', 'defaultVariant']);
  for (const [key, value] of Object.entries(changes || {})) {
    if (allowed.has(key) && !dedicatedAgentDefaultFields.has(key)) {
      accepted[key] = key === 'notificationTemplates'
        ? normalizeNotificationTemplates(value, normalizeNotificationTemplates(currentEffective?.notificationTemplates).templates).templates
        : value;
      continue;
    }
    if (JSON.stringify(value) !== JSON.stringify(currentEffective?.[key])) rejected.push(key);
  }
  return { accepted, rejected };
}

export function publicPrincipal(principal) {
  if (!principal) return null;
  return {
    id: principal.id,
    email: principal.email,
    displayName: principal.displayName,
    role: principal.role,
    scope: principal.scope,
    policy: principal.policy,
    assignments: (principal.assignments || []).map(({
      repositoryPath: _repositoryPath,
      worktreeContainerPath: _worktreeContainerPath,
      remoteUrl: _remoteUrl,
      ...entry
    }) => entry),
  };
}
