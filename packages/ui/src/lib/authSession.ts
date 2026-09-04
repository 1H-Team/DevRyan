import * as React from 'react';
import {
  canonicalSettingsPermissionSlug,
  fullSettingsPermissions,
  permissionsFromLegacyPages,
  type SettingsPermissions,
} from '@/lib/settings/permissions';

export type DevRyanRole = 'admin' | 'senior_developer' | 'developer';

export interface AuthAssignment {
  projectId: string;
  label: string;
  icon?: string | null;
  color?: string | null;
  iconBackground?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  branchName: string;
  publicDirectory: string;
  githubAccountId: string | null;
  isDefault: boolean;
}

export interface AuthFeatureOverrides {
  agents?: { hidePermissionsUi?: boolean; hideGlobalBehaviorUi?: boolean };
  source?: { hideUpdateTab?: boolean };
  mcp?: Record<string, 'on' | 'off'>;
}

export interface AuthPrincipal {
  id: string;
  email: string | null;
  displayName: string;
  role: DevRyanRole;
  scope: 'local-admin' | 'managed';
  policy: {
    settingsPages: string[];
    settingsPermissions?: SettingsPermissions;
    featureOverrides?: AuthFeatureOverrides;
    bots: boolean;
    files: boolean;
    terminal: boolean;
    browser: boolean;
    createWorktrees: boolean;
    createBranches: boolean;
    manageProjects: boolean;
    manageUsers: boolean;
    manageGlobalSettings: boolean;
    manageGit: boolean;
    push: boolean;
    github: boolean;
  };
  assignments: AuthAssignment[];
}

export type AuthCapability = keyof AuthPrincipal['policy'];

const LOCAL_ADMIN: AuthPrincipal = {
  id: 'local-admin',
  email: null,
  displayName: 'Local Administrator',
  role: 'admin',
  scope: 'local-admin',
  policy: {
    settingsPages: ['*'], settingsPermissions: fullSettingsPermissions(),
    bots: true, files: true, terminal: true, browser: true, createWorktrees: true, createBranches: true, manageProjects: true,
    manageUsers: true, manageGlobalSettings: true, manageGit: true, push: true, github: true,
  },
  assignments: [],
};

let currentPrincipal: AuthPrincipal = LOCAL_ADMIN;
let currentOfflineGrace = false;
let retrySessionHandler: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

export const setAuthPrincipal = (principal: AuthPrincipal | null | undefined): void => {
  currentPrincipal = principal ?? LOCAL_ADMIN;
  for (const listener of listeners) listener();
};

export const setAuthOfflineGrace = (offlineGrace: boolean): void => {
  if (currentOfflineGrace === offlineGrace) return;
  currentOfflineGrace = offlineGrace;
  for (const listener of listeners) listener();
};

export const getAuthOfflineGrace = (): boolean => currentOfflineGrace;

export const useAuthOfflineGrace = (): boolean => React.useSyncExternalStore(
  (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getAuthOfflineGrace,
  () => false,
);

export const registerAuthSessionRetry = (handler: () => Promise<void>): (() => void) => {
  retrySessionHandler = handler;
  return () => {
    if (retrySessionHandler === handler) retrySessionHandler = null;
  };
};

export const retryAuthSession = async (): Promise<void> => {
  await retrySessionHandler?.();
};

export const getAuthPrincipal = (): AuthPrincipal => currentPrincipal;

export const subscribeAuthPrincipal = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useAuthPrincipal = (): AuthPrincipal => React.useSyncExternalStore(
  (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getAuthPrincipal,
  () => LOCAL_ADMIN,
);

export const canReadSettingsPage = (principal: AuthPrincipal, slug: string): boolean => {
  if (slug === 'home' || principal.scope === 'local-admin' || principal.role === 'admin') return true;
  const canonical = canonicalSettingsPermissionSlug(slug);
  if (!canonical) return false;
  const permission = principal.policy.settingsPermissions?.[canonical];
  return permission?.read
    ?? (principal.policy.settingsPages.includes('*') || principal.policy.settingsPages.includes(canonical));
};

export const canEditSettingsPage = (principal: AuthPrincipal, slug: string): boolean => {
  if (slug === 'home' || principal.scope === 'local-admin' || principal.role === 'admin') return true;
  const canonical = canonicalSettingsPermissionSlug(slug);
  if (!canonical) return false;
  const permission = principal.policy.settingsPermissions?.[canonical];
  if (permission) return permission.read === true && permission.edit === true;
  return permissionsFromLegacyPages(principal.policy.settingsPages)[canonical].edit;
};

export const canAccessSettingsPage = canReadSettingsPage;

export const canPersistHostProjectSettings = (principal: AuthPrincipal): boolean => (
  principal.scope !== 'managed' || principal.role === 'admin'
);

export const isAgentPermissionsUiHidden = (principal: AuthPrincipal): boolean => (
  principal.scope === 'managed'
  && principal.role !== 'admin'
  && principal.policy.featureOverrides?.agents?.hidePermissionsUi === true
);

export const isGlobalAgentBehaviorUiHidden = (principal: AuthPrincipal): boolean => (
  principal.scope === 'managed'
  && principal.role !== 'admin'
  && principal.policy.featureOverrides?.agents?.hideGlobalBehaviorUi === true
);

export const isSourceUpdateTabHidden = (principal: AuthPrincipal): boolean => (
  principal.scope === 'managed'
  && principal.role !== 'admin'
  && principal.policy.featureOverrides?.source?.hideUpdateTab === true
);

export const canEditPersonalAgentModels = (principal: AuthPrincipal): boolean => (
  principal.scope === 'managed'
  && principal.role === 'developer'
  && principal.policy.manageGlobalSettings === true
  && canEditSettingsPage(principal, 'agents')
);

export const hasAuthCapability = (
  principal: AuthPrincipal,
  capability: Exclude<AuthCapability, 'settingsPages' | 'settingsPermissions' | 'featureOverrides'>,
): boolean => principal.scope === 'local-admin' || principal.policy[capability] === true;

export const assertCanCreateBranches = (): void => {
  if (!hasAuthCapability(getAuthPrincipal(), 'createBranches')) {
    throw new Error('Branch creation is disabled by policy');
  }
};

export const assertCanCreateWorktrees = (): void => {
  if (!hasAuthCapability(getAuthPrincipal(), 'createWorktrees')) {
    throw new Error('Worktree creation is disabled by policy');
  }
};
