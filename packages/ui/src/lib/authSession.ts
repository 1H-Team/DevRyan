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
  branchName: string;
  publicDirectory: string;
  githubAccountId: string | null;
  isDefault: boolean;
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
    files: boolean;
    terminal: boolean;
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
    files: true, terminal: true, manageProjects: true,
    manageUsers: true, manageGlobalSettings: true, manageGit: true, push: true, github: true,
  },
  assignments: [],
};

let currentPrincipal: AuthPrincipal = LOCAL_ADMIN;
const listeners = new Set<() => void>();

export const setAuthPrincipal = (principal: AuthPrincipal | null | undefined): void => {
  currentPrincipal = principal ?? LOCAL_ADMIN;
  for (const listener of listeners) listener();
};

export const getAuthPrincipal = (): AuthPrincipal => currentPrincipal;

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

export const hasAuthCapability = (
  principal: AuthPrincipal,
  capability: Exclude<AuthCapability, 'settingsPages' | 'settingsPermissions'>,
): boolean => principal.scope === 'local-admin' || principal.policy[capability] === true;
