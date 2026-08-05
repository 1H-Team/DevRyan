import * as React from 'react';

import { toast } from '@/components/ui';
import {
  requestJson,
  type ActivityRow,
  type AuditStatus,
  type GitHubAccountRow,
  type InviteRow,
  type ProjectRow,
  type RolePolicyRow,
  type UserRow,
} from './types';

export interface AdminUsersData {
  loading: boolean;
  users: UserRow[];
  projects: ProjectRow[];
  roles: RolePolicyRow[];
  activity: ActivityRow[];
  invites: InviteRow[];
  githubAccounts: GitHubAccountRow[];
  auditStatus: AuditStatus | null;
  reloadUsers: () => Promise<void>;
  reloadInvites: () => Promise<void>;
  reloadActivity: () => Promise<void>;
  reloadProjects: () => Promise<void>;
  reloadRoles: () => Promise<void>;
  reloadGithubAccounts: () => Promise<void>;
  reloadAll: () => Promise<void>;
}

export const useAdminUsersData = (
  canEditUserManagement: boolean,
  canManageGitHubAccounts: boolean = canEditUserManagement,
): AdminUsersData => {
  const [loading, setLoading] = React.useState(true);
  const [users, setUsers] = React.useState<UserRow[]>([]);
  const [projects, setProjects] = React.useState<ProjectRow[]>([]);
  const [roles, setRoles] = React.useState<RolePolicyRow[]>([]);
  const [activity, setActivity] = React.useState<ActivityRow[]>([]);
  const [invites, setInvites] = React.useState<InviteRow[]>([]);
  const [githubAccounts, setGithubAccounts] = React.useState<GitHubAccountRow[]>([]);
  const [auditStatus, setAuditStatus] = React.useState<AuditStatus | null>(null);

  const reloadUsers = React.useCallback(async () => {
    const payload = await requestJson<{ users: UserRow[] }>('/api/admin/users');
    setUsers(payload.users || []);
  }, []);

  const reloadInvites = React.useCallback(async () => {
    const payload = await requestJson<{ invites: InviteRow[] }>('/api/admin/invites');
    setInvites(payload.invites || []);
  }, []);

  const reloadActivity = React.useCallback(async () => {
    const [activityPayload, statusPayload] = await Promise.all([
      requestJson<{ activity: ActivityRow[] }>('/api/admin/activity?limit=50'),
      canEditUserManagement ? requestJson<AuditStatus>('/api/admin/activity/status') : Promise.resolve(null),
    ]);
    setActivity(activityPayload.activity || []);
    setAuditStatus(statusPayload);
  }, [canEditUserManagement]);

  const reloadProjects = React.useCallback(async () => {
    const payload = await requestJson<{ projects: ProjectRow[] }>('/api/admin/projects');
    setProjects(payload.projects || []);
  }, []);

  const reloadRoles = React.useCallback(async () => {
    if (!canEditUserManagement) return;
    const payload = await requestJson<{ roles: RolePolicyRow[] }>('/api/admin/roles');
    setRoles(payload.roles || []);
  }, [canEditUserManagement]);

  const reloadGithubAccounts = React.useCallback(async () => {
    if (!canManageGitHubAccounts) return;
    const payload = await requestJson<{ accounts?: GitHubAccountRow[] }>('/api/admin/github-accounts');
    setGithubAccounts(payload.accounts || []);
  }, [canManageGitHubAccounts]);

  const reloadAll = React.useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([
      reloadUsers(),
      reloadInvites(),
      reloadActivity(),
      reloadProjects(),
      reloadRoles(),
      reloadGithubAccounts(),
    ]);
    const error = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
    if (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load user management');
    }
    setLoading(false);
  }, [reloadUsers, reloadInvites, reloadActivity, reloadProjects, reloadRoles, reloadGithubAccounts]);

  React.useEffect(() => { void reloadAll(); }, [reloadAll]);

  return {
    loading,
    users,
    projects,
    roles,
    activity,
    invites,
    githubAccounts,
    auditStatus,
    reloadUsers,
    reloadInvites,
    reloadActivity,
    reloadProjects,
    reloadRoles,
    reloadGithubAccounts,
    reloadAll,
  };
};
