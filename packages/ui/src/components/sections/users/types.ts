import { setAuthOfflineGrace } from '@/lib/authSession';

export type Role = 'admin' | 'senior_developer' | 'developer';
export type UserStatus = 'active' | 'suspended' | 'archived';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: UserStatus;
  github_account_id: string | null;
}

export interface ProjectRow {
  id: string;
  label: string;
  repository_path: string;
  remote_url: string | null;
  default_branch: string;
  status: 'active' | 'archived';
}

export interface BranchOption {
  name: string;
  local: boolean;
  remoteRefs: string[];
  preferredRef: string;
}

export interface BranchInventoryResponse {
  branches: string[];
  branchOptions: BranchOption[];
  defaultBranch: string;
}

export const formatBranchOption = (option: BranchOption): string => {
  const remotes = option.remoteRefs.map((ref) => ref.replace(/^remotes\//, '').split('/')[0]).filter(Boolean);
  const provenance = [option.local ? 'local' : null, ...new Set(remotes)].filter(Boolean).join(' + ');
  return provenance ? `${option.name} (${provenance})` : option.name;
};

export interface RolePolicyRow {
  role: Role;
  settings_pages: string[];
  settings_permissions?: SettingsPermissions;
  can_use_files: boolean;
  can_use_terminal: boolean;
  can_use_browser: boolean;
  can_manage_projects: boolean;
  can_manage_users: boolean;
  can_manage_global_settings: boolean;
  can_manage_git: boolean;
  can_push: boolean;
  can_use_github: boolean;
}

export interface ActivityRow {
  id: number;
  action: string;
  actor_role: string | null;
  target_type: string | null;
  target_id: string | null;
  success: boolean;
  created_at: string;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export interface GitHubAccountRow {
  id: string;
  user: {
    login?: string | null;
    avatarUrl?: string | null;
    name?: string | null;
    email?: string | null;
  } | null;
  scope?: string;
  assignedUser: {
    id: string;
    email: string;
    displayName: string;
  } | null;
}

export interface AuditStatus {
  backlog: number;
  delivered: number;
  deliveryFailures: number;
}

export type CapabilityKey = 'files' | 'terminal' | 'browser' | 'createWorktrees' | 'createBranches' | 'manageProjects' | 'manageUsers' | 'manageGlobalSettings' | 'manageGit' | 'push' | 'github';
export type CapabilityOverride = 'inherit' | 'on' | 'off';
export type McpPolicyOverride = 'inherit' | 'on' | 'off';

export interface UserFeatureOverrides {
  agents?: { hidePermissionsUi?: boolean };
  mcp?: Record<string, 'on' | 'off'>;
}

export interface UserPolicyPayload {
  userId: string;
  role: Role;
  inherited: boolean;
  policy: {
    settings_pages: string[] | null;
    settings_permission_overrides?: SettingsPermissionOverrides;
    capabilities: Partial<Record<CapabilityKey, boolean>>;
    settings_overrides: Record<string, unknown>;
    feature_overrides?: UserFeatureOverrides;
  };
  effective: {
    settingsPermissions: SettingsPermissions;
  };
  inheritedPolicy: {
    settingsPermissions: SettingsPermissions;
  } & Record<CapabilityKey, boolean>;
}

export interface UserAnalyticsHour {
  start: string;
  end: string;
  label: string;
  offset: string;
  activeMinutes: number;
  promptCount: number;
}

export interface UserAnalyticsSession {
  id: string;
  start: string;
  end: string;
  estimatedMinutes: number;
  actionCount: number;
  counts: {
    prompts: number;
    filesOpened: number;
    copies: number;
    settingsChanges: number;
  };
}

export interface UserAnalyticsTotals {
  estimatedActiveMinutes: number;
  prompts: number;
  filesOpened: number;
  copies: number;
  settingsChanges: number;
}

export interface UserAnalyticsDaily {
  date: string;
  timeZone: string;
  dayStart: string;
  dayEnd: string;
  totals: UserAnalyticsTotals;
  hours: UserAnalyticsHour[];
  activitySessions: UserAnalyticsSession[];
}

export interface UserAnalyticsRangeDay extends UserAnalyticsTotals {
  date: string;
}

export interface UserAnalyticsRangeSession extends UserAnalyticsSession {
  date: string;
}

export interface UserAnalyticsRange {
  start: string;
  end: string;
  timeZone: string;
  days: number;
  rangeStart: string;
  rangeEnd: string;
  totals: UserAnalyticsTotals;
  series: UserAnalyticsRangeDay[];
  activitySessions: UserAnalyticsRangeSession[];
}

export interface UserAnalyticsEvent extends ActivityRow {
  actor_user_id: string | null;
  target_user_id: string | null;
  project_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
  actor: { id: string; displayName: string; role: Role } | null;
}

export interface UserAnalyticsEventsPage {
  events: UserAnalyticsEvent[];
  nextCursor: string | null;
}

export const capabilityLabels: Array<[CapabilityKey, string]> = [
  ['files', 'Files'], ['terminal', 'Terminal'], ['browser', 'Browser'], ['createWorktrees', 'Create worktrees'], ['createBranches', 'Create branches'], ['manageGit', 'Git'], ['push', 'Push'],
  ['github', 'GitHub'], ['manageProjects', 'Manage projects'], ['manageUsers', 'Manage users'],
  ['manageGlobalSettings', 'Host settings'],
];

export const roleLabel = (role: Role): string => role.replace('_', ' ');

export const describeInvite = (invite: InviteRow): { active: boolean; label: string } => {
  const active = !invite.consumed_at && !invite.revoked_at && new Date(invite.expires_at).getTime() > Date.now();
  const label = active
    ? `expires ${new Date(invite.expires_at).toLocaleString()}`
    : invite.consumed_at ? 'used' : invite.revoked_at ? 'revoked' : 'expired';
  return { active, label };
};

export const selectClassName = 'h-9 w-full rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 typography-ui-label text-foreground outline-none focus:ring-2 focus:ring-[var(--interactive-focus-ring)]';

export class UserManagementRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code?: string; retryable?: boolean }) {
    super(message);
    this.name = 'UserManagementRequestError';
    this.status = options.status;
    this.code = options.code || null;
    this.retryable = options.retryable === true;
  }
}

export const requestJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & {
    error?: string;
    code?: string;
    retryable?: boolean;
  };
  if (!response.ok) {
    if (payload.code === 'offline_grace_restricted') {
      setAuthOfflineGrace(true);
    }
    throw new UserManagementRequestError(payload.error || `Request failed (${response.status})`, {
      status: response.status,
      code: payload.code,
      retryable: payload.retryable,
    });
  }
  return payload;
};
import type {
  SettingsPermissionOverrides,
  SettingsPermissions,
} from '@/lib/settings/permissions';
